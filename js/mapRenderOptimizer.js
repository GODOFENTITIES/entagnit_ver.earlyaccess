import * as THREE from "three";

const DEFAULT_CELL_SIZE = 24;
const MIN_TRIANGLES_TO_SPLIT = 50_000;
const TRIANGLE_WORK_CHUNK = 24_000;
const RENDER_CHUNK_TAG = "potsparkMapRenderChunk";

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else if (typeof setImmediate === "function") {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function isSplittableMesh(mesh, minTriangles) {
  if (
    !mesh?.isMesh
    || mesh.isSkinnedMesh
    || mesh.isInstancedMesh
    || !mesh.visible
    || !mesh.parent
    || !mesh.geometry?.index
    || !mesh.geometry?.attributes?.position
  ) return false;

  const material = Array.isArray(mesh.material)
    ? (mesh.material.length === 1 ? mesh.material[0] : null)
    : mesh.material;
  if (!material || material.transparent) return false;

  const geometry = mesh.geometry;
  const hasMorphTargets = Object.values(geometry.morphAttributes || {})
    .some((attributes) => attributes?.length > 0);
  if (hasMorphTargets || geometry.groups.length > 0) return false;

  const drawCount = geometry.drawRange.count;
  if (
    geometry.drawRange.start !== 0
    || (Number.isFinite(drawCount) && drawCount < geometry.index.count)
  ) return false;

  return geometry.index.count / 3 >= minTriangles;
}

function cellForTriangle(
  position,
  index,
  triangleOffset,
  worldMatrix,
  worldBounds,
  cellsX,
  cellsZ,
  cellSize,
) {
  const a = index.getX(triangleOffset);
  const b = index.getX(triangleOffset + 1);
  const c = index.getX(triangleOffset + 2);
  const localX = (
    position.getX(a)
    + position.getX(b)
    + position.getX(c)
  ) / 3;
  const localY = (
    position.getY(a)
    + position.getY(b)
    + position.getY(c)
  ) / 3;
  const localZ = (
    position.getZ(a)
    + position.getZ(b)
    + position.getZ(c)
  ) / 3;
  const elements = worldMatrix.elements;
  const centreX = (
    elements[0] * localX
    + elements[4] * localY
    + elements[8] * localZ
    + elements[12]
  );
  const centreZ = (
    elements[2] * localX
    + elements[6] * localY
    + elements[10] * localZ
    + elements[14]
  );
  const cellX = THREE.MathUtils.clamp(
    Math.floor((centreX - worldBounds.min.x) / cellSize),
    0,
    cellsX - 1,
  );
  const cellZ = THREE.MathUtils.clamp(
    Math.floor((centreZ - worldBounds.min.z) / cellSize),
    0,
    cellsZ - 1,
  );
  return cellZ * cellsX + cellX;
}

function copyMeshTransformAndRenderState(source, target) {
  target.position.copy(source.position);
  target.quaternion.copy(source.quaternion);
  target.scale.copy(source.scale);
  target.matrix.copy(source.matrix);
  target.matrixWorld.copy(source.matrixWorld);
  target.matrixAutoUpdate = source.matrixAutoUpdate;
  target.matrixWorldAutoUpdate = source.matrixWorldAutoUpdate;
  target.layers.mask = source.layers.mask;
  target.castShadow = source.castShadow;
  target.receiveShadow = source.receiveShadow;
  target.renderOrder = source.renderOrder;
  target.frustumCulled = true;
}

async function splitMeshForFrustumCulling(mesh, cellSize, onProgress) {
  const geometry = mesh.geometry;
  const position = geometry.attributes.position;
  const index = geometry.index;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds || bounds.isEmpty()) return null;

  mesh.updateWorldMatrix(true, false);
  const worldBounds = bounds.clone().applyMatrix4(mesh.matrixWorld);

  const cellsX = Math.max(1, Math.ceil((worldBounds.max.x - worldBounds.min.x) / cellSize));
  const cellsZ = Math.max(1, Math.ceil((worldBounds.max.z - worldBounds.min.z) / cellSize));
  const cellCount = cellsX * cellsZ;
  if (cellCount < 2 || cellCount > 0xffff) return null;

  const triangleCount = Math.floor(index.count / 3);
  const triangleCells = new Uint16Array(triangleCount);
  const triangleCounts = new Uint32Array(cellCount);

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 3;
    const cell = cellForTriangle(
      position,
      index,
      offset,
      mesh.matrixWorld,
      worldBounds,
      cellsX,
      cellsZ,
      cellSize,
    );
    triangleCells[triangle] = cell;
    triangleCounts[cell] += 1;

    if (triangle > 0 && triangle % TRIANGLE_WORK_CHUNK === 0) {
      onProgress?.(99, "Partitioning arena render mesh");
      await yieldToBrowser();
    }
  }

  const IndexArray = position.count > 0xffff ? Uint32Array : Uint16Array;
  const cells = new Array(cellCount);
  let occupiedCells = 0;
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (triangleCounts[cell] === 0) continue;
    cells[cell] = {
      box: new THREE.Box3(),
      indices: new IndexArray(triangleCounts[cell] * 3),
      writeOffset: 0,
    };
    occupiedCells += 1;
  }
  if (occupiedCells < 2) return null;

  const point = new THREE.Vector3();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const sourceOffset = triangle * 3;
    const cell = cells[triangleCells[triangle]];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertexIndex = index.getX(sourceOffset + corner);
      cell.indices[cell.writeOffset] = vertexIndex;
      cell.writeOffset += 1;
      point.fromBufferAttribute(position, vertexIndex);
      cell.box.expandByPoint(point);
    }

    if (triangle > 0 && triangle % TRIANGLE_WORK_CHUNK === 0) {
      await yieldToBrowser();
    }
  }

  const chunks = [];
  let chunkNumber = 0;
  for (const cell of cells) {
    if (!cell) continue;

    const chunkGeometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      // Attribute objects are intentionally shared. Their values, including
      // UVs and vertex colours, remain byte-for-byte identical to the GLB.
      chunkGeometry.setAttribute(name, attribute);
    }
    chunkGeometry.setIndex(new THREE.BufferAttribute(cell.indices, 1));
    chunkGeometry.boundingBox = cell.box;
    chunkGeometry.boundingSphere = cell.box.getBoundingSphere(new THREE.Sphere());
    chunkGeometry.name = `${geometry.name || mesh.name}_render_chunk_${chunkNumber}`;
    chunkGeometry.userData[RENDER_CHUNK_TAG] = true;

    const chunk = new THREE.Mesh(chunkGeometry, mesh.material);
    chunk.name = `${mesh.name}_render_chunk_${chunkNumber}`;
    chunk.userData[RENDER_CHUNK_TAG] = true;
    chunk.userData.renderSourceUuid = mesh.uuid;
    copyMeshTransformAndRenderState(mesh, chunk);
    chunks.push(chunk);
    chunkNumber += 1;
  }

  for (const chunk of chunks) mesh.parent.add(chunk);
  mesh.visible = false;

  return {
    chunks,
    sourceMesh: mesh,
    sourceTriangles: triangleCount,
  };
}

function freezeStaticMapTransforms(root) {
  let frozenObjects = 0;
  root.traverse((node) => {
    if (node.matrixAutoUpdate) node.updateMatrix();
    node.matrixAutoUpdate = false;
    frozenObjects += 1;
  });
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    node.matrixWorldAutoUpdate = false;
    node.matrixWorldNeedsUpdate = false;
  });
  return frozenObjects;
}

/**
 * Splits only very large, opaque, static render meshes into spatial chunks.
 * Collision remains attached to the original geometry prepared beforehand;
 * this function changes rendering only and never edits the GLB's attributes,
 * materials, textures, triangle indices, transforms, or spawn coordinates.
 */
export async function optimizeStaticMapRendering(root, options = {}) {
  if (!root?.traverse) {
    throw new TypeError("optimizeStaticMapRendering requires a map Object3D");
  }

  const cellSize = Number.isFinite(options.cellSize) && options.cellSize > 0
    ? options.cellSize
    : DEFAULT_CELL_SIZE;
  const minTriangles = Number.isFinite(options.minTriangles) && options.minTriangles > 0
    ? options.minTriangles
    : MIN_TRIANGLES_TO_SPLIT;
  const onProgress = typeof options.onProgress === "function"
    ? options.onProgress
    : null;

  root.updateMatrixWorld(true);
  const candidates = [];
  root.traverse((node) => {
    if (isSplittableMesh(node, minTriangles)) candidates.push(node);
  });

  const optimized = [];
  for (const mesh of candidates) {
    const result = await splitMeshForFrustumCulling(mesh, cellSize, onProgress);
    if (result) optimized.push(result);
  }

  const frozenObjects = freezeStaticMapTransforms(root);
  const chunkCount = optimized.reduce((total, item) => total + item.chunks.length, 0);
  const sourceTriangles = optimized.reduce((total, item) => total + item.sourceTriangles, 0);
  onProgress?.(99, "Arena render culling ready");

  console.info(
    `[MapRender] ${sourceTriangles.toLocaleString()} triangles partitioned into `
    + `${chunkCount} frustum-cullable chunks; ${frozenObjects} static transforms frozen.`,
  );

  return {
    optimizedMeshCount: optimized.length,
    chunkCount,
    sourceTriangles,
    frozenObjects,
    optimized,
  };
}

export function isMapRenderChunk(object) {
  return !!object?.userData?.[RENDER_CHUNK_TAG];
}
