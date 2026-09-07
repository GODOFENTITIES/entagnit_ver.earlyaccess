import fs from "node:fs/promises";

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { CharacterPhysics } from "../js/physics.js";

// GLTFLoader's collision-only parse does not need actual texture pixels, but
// its browser-oriented code expects these globals to exist.
globalThis.self ??= globalThis;
globalThis.ProgressEvent ??= class ProgressEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
};
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });

export async function loadAuthoritativeCollision(mapPath, onProgress) {
  const bytes = await fs.readFile(mapPath);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, "", resolve, reject);
  });

  const root = gltf.scene;
  if (!root) throw new Error("Authoritative map GLB has no scene root");

  root.updateWorldMatrix(true, true);
  const rawBox = new THREE.Box3();
  const meshBox = new THREE.Box3();
  let hasBounds = false;

  root.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
    node.updateWorldMatrix(true, false);
    meshBox.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld);
    if (!hasBounds) {
      rawBox.copy(meshBox);
      hasBounds = true;
    } else {
      rawBox.union(meshBox);
    }
  });

  if (!hasBounds) throw new Error("Authoritative map contains no collision geometry");

  // Must match mapLoader.js exactly: centre XZ but preserve the GLB's Y origin.
  const centre = rawBox.getCenter(new THREE.Vector3());
  root.position.set(-centre.x, 0, -centre.z);
  root.updateWorldMatrix(true, true);

  const colliderSource = new CharacterPhysics();
  await colliderSource.setColliders(root, onProgress);
  if (colliderSource.colliderCount === 0) {
    throw new Error("Authoritative collision layer is empty");
  }

  return { root, colliderSource };
}
