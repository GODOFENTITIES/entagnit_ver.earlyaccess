import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { before } from "node:test";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  isMapRenderChunk,
  optimizeStaticMapRendering,
} from "../js/mapRenderOptimizer.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const MAP_PATH = path.join(PROJECT_ROOT, "assets/models/map_1.glb");
const PHYSICS_PATH = path.join(PROJECT_ROOT, "js/physics.js");
const SPAWN = new THREE.Vector3(-101.03, -16.60, -30.00);

// GLTFLoader only needs image dimensions for this collision-only test.
globalThis.self = globalThis;
globalThis.ProgressEvent ??= class ProgressEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
};
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
globalThis.requestAnimationFrame ??= (callback) => setImmediate(() => callback(performance.now()));

const stockMeshRaycast = THREE.Mesh.prototype.raycast;

let CharacterPhysics;
let mapRoot;
let physics;
let visualSnapshot;

function toDataModule(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function importBrowserPhysics() {
  const threeUrl = pathToFileURL(
    path.join(PROJECT_ROOT, "node_modules/three/build/three.module.js"),
  ).href;
  const bvhUrl = pathToFileURL(
    path.join(PROJECT_ROOT, "node_modules/three-mesh-bvh/build/index.module.js"),
  ).href;

  const browserSource = fs.readFileSync(PHYSICS_PATH, "utf8")
    .replace('from "three";', `from ${JSON.stringify(threeUrl)};`)
    .replace('from "three-mesh-bvh";', `from ${JSON.stringify(bvhUrl)};`);

  return import(toDataModule(browserSource));
}

async function loadMap() {
  const bytes = fs.readFileSync(MAP_PATH);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, "", resolve, reject);
  });

  const root = gltf.scene;
  root.updateWorldMatrix(true, true);

  // Match mapLoader.js: find raw bounds, then centre XZ without shifting Y.
  const rawBox = new THREE.Box3();
  const meshBox = new THREE.Box3();
  root.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
    meshBox.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld);
    rawBox.union(meshBox);
  });

  const centre = rawBox.getCenter(new THREE.Vector3());
  root.position.set(-centre.x, 0, -centre.z);
  root.updateWorldMatrix(true, true);
  return root;
}

function settlePlayer(characterPhysics, rig, frames = 600) {
  for (let i = 0; i < frames; i += 1) {
    characterPhysics.update(1 / 60, {}, rig, 7.5, 0);
  }
}

function snapshotVisualState(root) {
  const records = [];
  root.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const index = node.geometry.index;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    records.push({
      node,
      geometry: node.geometry,
      material: node.material,
      indexBytes: index
        ? Buffer.from(index.array.buffer, index.array.byteOffset, index.array.byteLength).slice()
        : null,
      materials: materials.map((material) => ({
        material,
        color: material.color?.getHex() ?? null,
        map: material.map || null,
        mapColorSpace: material.map?.colorSpace || null,
        emissiveMap: material.emissiveMap || null,
        emissiveMapColorSpace: material.emissiveMap?.colorSpace || null,
      })),
    });
  });
  return records;
}

before(async () => {
  ({ CharacterPhysics } = await importBrowserPhysics());
  mapRoot = await loadMap();
  visualSnapshot = snapshotVisualState(mapRoot);
  physics = new CharacterPhysics();
  await physics.setColliders(mapRoot);
});

test("builds exact BVH colliders for every static map mesh", () => {
  assert.equal(physics.colliderCount, 21);
  assert.equal(physics.raycastColliders.length, 21);

  const mainCollider = physics.raycastColliders.reduce((largest, mesh) => {
    const count = mesh.geometry.attributes.position.count;
    return !largest || count > largest.geometry.attributes.position.count ? mesh : largest;
  }, null);

  assert.equal(mainCollider.geometry.attributes.position.count, 740_011);
  assert.ok(mainCollider.geometry.boundsTree, "large environment geometry must have a BVH");
  assert.equal(
    mainCollider.geometry.boundsTree.indirect,
    true,
    "the BVH must not reorder visible map triangles",
  );
  assert.equal(mainCollider.material.side, THREE.DoubleSide);
});

test("collision indexing preserves the map's original materials, textures, and index buffers", () => {
  const colorTextures = new Set();

  for (const record of visualSnapshot) {
    assert.equal(record.node.geometry, record.geometry);
    assert.equal(record.node.material, record.material);

    const currentIndex = record.geometry.index;
    if (record.indexBytes) {
      assert.ok(currentIndex, `${record.node.name} unexpectedly lost its index buffer`);
      const currentBytes = Buffer.from(
        currentIndex.array.buffer,
        currentIndex.array.byteOffset,
        currentIndex.array.byteLength,
      );
      assert.equal(
        currentBytes.equals(record.indexBytes),
        true,
        `${record.node.name} index order changed while building collision`,
      );
    } else {
      assert.equal(currentIndex, null);
    }

    const materials = Array.isArray(record.node.material)
      ? record.node.material
      : [record.node.material];
    assert.equal(materials.length, record.materials.length);
    for (let index = 0; index < materials.length; index += 1) {
      const before = record.materials[index];
      const material = materials[index];
      assert.equal(material, before.material);
      assert.equal(material.color?.getHex() ?? null, before.color);
      assert.equal(material.map || null, before.map);
      assert.equal(material.map?.colorSpace || null, before.mapColorSpace);
      assert.equal(material.emissiveMap || null, before.emissiveMap);
      assert.equal(
        material.emissiveMap?.colorSpace || null,
        before.emissiveMapColorSpace,
      );
      if (material.map) {
        colorTextures.add(material.map);
        assert.equal(material.map.colorSpace, THREE.SRGBColorSpace);
      }
    }
  }

  assert.equal(colorTextures.size, 8, "all eight embedded map colour textures must survive");
});

test("accelerated map rays are materially faster than stock triangle scanning", () => {
  const mainCollider = physics.raycastColliders.reduce((largest, mesh) => {
    const count = mesh.geometry.attributes.position.count;
    return !largest || count > largest.geometry.attributes.position.count ? mesh : largest;
  }, null);

  const stockMesh = new THREE.Mesh(mainCollider.geometry, mainCollider.material);
  stockMesh.matrixAutoUpdate = false;
  stockMesh.matrixWorldAutoUpdate = false;
  stockMesh.matrixWorld.copy(mainCollider.matrixWorld);
  stockMesh.raycast = stockMeshRaycast;

  if (!mainCollider.geometry.boundingBox) mainCollider.geometry.computeBoundingBox();
  const worldBox = mainCollider.geometry.boundingBox.clone().applyMatrix4(mainCollider.matrixWorld);
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  raycaster.far = worldBox.max.y - worldBox.min.y + 20;
  const down = new THREE.Vector3(0, -1, 0);

  let seed = 0x5f3759df;
  const random = () => {
    seed = (Math.imul(1_664_525, seed) + 1_013_904_223) >>> 0;
    return seed / 2 ** 32;
  };
  const rays = Array.from({ length: 8 }, () => new THREE.Vector3(
    THREE.MathUtils.lerp(worldBox.min.x, worldBox.max.x, random()),
    worldBox.max.y + 10,
    THREE.MathUtils.lerp(worldBox.min.z, worldBox.max.z, random()),
  ));

  // Warm both code paths before timing.
  raycaster.set(rays[0], down);
  raycaster.intersectObject(stockMesh, false);
  raycaster.intersectObject(mainCollider, false);

  let startedAt = performance.now();
  for (const origin of rays) {
    raycaster.set(origin, down);
    raycaster.intersectObject(stockMesh, false);
  }
  const stockPerRay = (performance.now() - startedAt) / rays.length;

  const repeats = 50;
  startedAt = performance.now();
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const origin of rays) {
      raycaster.set(origin, down);
      raycaster.intersectObject(mainCollider, false);
    }
  }
  const bvhPerRay = (performance.now() - startedAt) / (rays.length * repeats);

  assert.ok(
    stockPerRay / bvhPerRay >= 20,
    `expected >=20x ray speedup; stock=${stockPerRay.toFixed(3)}ms bvh=${bvhPerRay.toFixed(3)}ms`,
  );
});

test("the player stops at a real map wall instead of passing through it", () => {
  const rig = new THREE.Object3D();
  physics.teleport(rig, SPAWN.x, SPAWN.y, SPAWN.z);
  settlePlayer(physics, rig);
  assert.equal(physics.isGrounded, true, "player should settle on map geometry");

  const feetY = rig.position.y - physics.eyeH;
  const cardinalDirections = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ];
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  raycaster.near = 0.05;
  raycaster.far = 50;

  const wall = cardinalDirections
    .map((direction) => {
      raycaster.set(new THREE.Vector3(rig.position.x, feetY + 0.9, rig.position.z), direction);
      const hit = raycaster.intersectObjects(physics.raycastColliders, false)[0];
      return hit ? { direction, distance: hit.distance } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance)[0];

  assert.ok(wall && wall.distance > 0.75, "spawn should have a testable nearby wall");

  const start = rig.position.clone();
  const yaw = Math.atan2(-wall.direction.x, -wall.direction.z);
  const walkFrames = Math.ceil(((wall.distance + 3) / 7.5) * 60) + 120;
  for (let i = 0; i < walkFrames; i += 1) {
    physics.update(1 / 60, { KeyW: true }, rig, 7.5, yaw);
  }

  const progress = (rig.position.x - start.x) * wall.direction.x
    + (rig.position.z - start.z) * wall.direction.z;

  assert.ok(
    progress <= wall.distance - 0.40,
    `player crossed the wall: moved ${progress.toFixed(3)}m toward a wall ${wall.distance.toFixed(3)}m away`,
  );
  assert.ok(
    progress >= wall.distance - 0.80,
    "player should stop at capsule radius, not at an oversized invisible box",
  );

  const stoppedAt = rig.position.clone();
  for (let i = 0; i < 240; i += 1) {
    physics.update(1 / 60, { KeyW: true }, rig, 7.5, yaw);
  }
  assert.ok(rig.position.distanceTo(stoppedAt) < 0.02, "holding forward must not tunnel through the wall");
});

function triangleFingerprint(indexAttributes) {
  const mask = (1n << 64n) - 1n;
  let xor = 0n;
  let sum = 0n;
  let triangles = 0;
  for (const index of indexAttributes) {
    for (let offset = 0; offset < index.count; offset += 3) {
      const a = BigInt(index.getX(offset));
      const b = BigInt(index.getX(offset + 1));
      const c = BigInt(index.getX(offset + 2));
      const hash = (
        a * 0x9e3779b185ebca87n
        ^ b * 0xc2b2ae3d27d4eb4fn
        ^ c * 0x165667b19e3779f9n
      ) & mask;
      xor ^= hash;
      sum = (sum + hash) & mask;
      triangles += 1;
    }
  }
  return { xor, sum, triangles };
}

test("render optimization preserves the exact map while culling off-camera city sections", async () => {
  const source = visualSnapshot.reduce((largest, record) => (
    !largest
    || record.geometry.attributes.position.count > largest.geometry.attributes.position.count
      ? record.node
      : largest
  ), null);
  assert.ok(source, "large render mesh is required");

  source.updateWorldMatrix(true, false);
  const sourceMatrix = source.matrixWorld.clone();
  const sourceMaterial = source.material;
  const sourceAttributes = { ...source.geometry.attributes };
  const sourceIndexBytes = Buffer.from(
    source.geometry.index.array.buffer,
    source.geometry.index.array.byteOffset,
    source.geometry.index.array.byteLength,
  ).slice();
  const beforeFingerprint = triangleFingerprint([source.geometry.index]);

  const result = await optimizeStaticMapRendering(mapRoot);
  assert.equal(result.optimizedMeshCount, 1);
  assert.ok(result.chunkCount >= 20 && result.chunkCount <= 50);
  assert.equal(result.sourceTriangles, 305_160);
  assert.equal(source.visible, false, "only the original render draw must be disabled");

  const chunks = [];
  mapRoot.traverse((node) => {
    if (isMapRenderChunk(node) && node.isMesh) chunks.push(node);
  });
  assert.equal(chunks.length, result.chunkCount);

  for (const chunk of chunks) {
    assert.equal(chunk.material, sourceMaterial, "chunk must share the original coloured material");
    assert.equal(chunk.matrixWorld.equals(sourceMatrix), true, "chunk transform must match the GLB mesh");
    assert.ok(chunk.geometry.boundingBox && chunk.geometry.boundingSphere);
    assert.equal(chunk.frustumCulled, true);
    for (const [name, attribute] of Object.entries(sourceAttributes)) {
      assert.equal(chunk.geometry.attributes[name], attribute, `${name} data must remain byte-identical`);
    }
  }

  const afterFingerprint = triangleFingerprint(chunks.map((chunk) => chunk.geometry.index));
  assert.deepEqual(afterFingerprint, beforeFingerprint, "no render triangle may be added, removed, or changed");
  const currentIndexBytes = Buffer.from(
    source.geometry.index.array.buffer,
    source.geometry.index.array.byteOffset,
    source.geometry.index.array.byteLength,
  );
  assert.equal(currentIndexBytes.equals(sourceIndexBytes), true, "collision/source indices must not mutate");

  const worldBox = source.geometry.boundingBox.clone().applyMatrix4(sourceMatrix);
  const centre = worldBox.getCenter(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.4, 600);
  camera.position.set(centre.x, worldBox.min.y + 2.2, centre.z);
  camera.lookAt(centre.x, camera.position.y, worldBox.min.z - 1);
  camera.updateMatrixWorld(true);
  const projection = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  const frustum = new THREE.Frustum().setFromProjectionMatrix(projection);
  let submittedTriangles = 0;
  const chunkWorldBox = new THREE.Box3();
  for (const chunk of chunks) {
    chunkWorldBox.copy(chunk.geometry.boundingBox).applyMatrix4(chunk.matrixWorld);
    if (frustum.intersectsBox(chunkWorldBox)) {
      submittedTriangles += chunk.geometry.index.count / 3;
    }
  }
  assert.ok(
    submittedTriangles < result.sourceTriangles * 0.75,
    `expected to cull at least 25% of the fused city; submitted ${submittedTriangles} triangles`,
  );

  mapRoot.traverse((node) => {
    assert.equal(node.matrixAutoUpdate, false, `${node.name || node.type} transform should be frozen`);
    assert.equal(node.matrixWorldAutoUpdate, false, `${node.name || node.type} world transform should be frozen`);
  });

  const rig = new THREE.Object3D();
  physics.teleport(rig, SPAWN.x, SPAWN.y, SPAWN.z);
  settlePlayer(physics, rig);
  assert.equal(physics.isGrounded, true, "render partitioning must not affect solid collision");
});
