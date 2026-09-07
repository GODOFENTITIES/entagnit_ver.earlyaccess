/**
 * mapLoader.js
 * Loads the game map GLB and adds it to the Three.js scene.
 *
 * Resolves with { root, spawnPoint, box } where:
 *   root       – the THREE.Group added to the scene
 *   spawnPoint – a THREE.Vector3 at the map's XZ centre, 1.8 m above the floor
 *   box        – the post-positioning world bounding box (for camera far-plane tuning)
 *
 * @param {THREE.Scene} scene        – target scene
 * @param {string}      url          – path to the .glb file
 * @param {Function}    onProgress   – called with (percent 0-100) during download
 */

import * as THREE from "three";
import { GLTFLoader } from "./vendor/loaders/GLTFLoader.js";

/** Tag applied to every mesh in the loaded map so we can find it later. */
const MAP_TAG = "mapGeometry";

const MAP_WORK_CHUNK = 48;
const SPAWN_POINT = new THREE.Vector3(-101.03, -16.60, -30.00);

function yieldToBrowser() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function setProgress(onProgress, pct, status) {
  if (onProgress) onProgress(Math.round(pct), status);
}

function preserveDisplayColor(material) {
  if (!material) return;

  // glTF base-colour and emissive textures are authored in sRGB. Keep that
  // colour-space explicit so renderer/security/collider changes cannot leave
  // the arena looking grey or washed out. Data textures (normal/roughness/etc.)
  // intentionally remain linear.
  if (material.map?.isTexture) material.map.colorSpace = THREE.SRGBColorSpace;
  if (material.emissiveMap?.isTexture) {
    material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
  }
  material.needsUpdate = true;
}

async function processMeshesInChunks(meshes, onProgress, startPct, endPct) {
  for (let i = 0; i < meshes.length; i += MAP_WORK_CHUNK) {
    const end = Math.min(meshes.length, i + MAP_WORK_CHUNK);
    for (let j = i; j < end; j += 1) {
      const node = meshes[j];
      node.userData[MAP_TAG] = true;
      node.castShadow = false;
      node.receiveShadow = true;
      node.frustumCulled = true;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(preserveDisplayColor);
    }

    const t = meshes.length > 0 ? end / meshes.length : 1;
    setProgress(onProgress, startPct + (endPct - startPct) * t, "Preparing arena geometry");
    await yieldToBrowser();
  }
}

async function computeSceneBoxFromMeshes(root, meshes, onProgress, startPct, endPct) {
  root.updateWorldMatrix(true, true);

  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  let hasBounds = false;

  for (let i = 0; i < meshes.length; i += MAP_WORK_CHUNK) {
    const end = Math.min(meshes.length, i + MAP_WORK_CHUNK);
    for (let j = i; j < end; j += 1) {
      const mesh = meshes[j];
      const geo = mesh.geometry;
      if (!geo?.attributes?.position) continue;
      if (!geo.boundingBox) geo.computeBoundingBox();
      mesh.updateWorldMatrix(true, false);
      meshBox.copy(geo.boundingBox).applyMatrix4(mesh.matrixWorld);
      if (!hasBounds) {
        box.copy(meshBox);
        hasBounds = true;
      } else {
        box.union(meshBox);
      }
    }

    const t = meshes.length > 0 ? end / meshes.length : 1;
    setProgress(onProgress, startPct + (endPct - startPct) * t, "Measuring arena bounds");
    await yieldToBrowser();
  }

  return hasBounds ? box : new THREE.Box3().setFromObject(root);
}

/**
 * Loads a GLB map, centres it, adds it to `scene`, and resolves with spawn info.
 */
export function loadMap(scene, url, onProgress) {
  return new Promise((resolve, reject) => {
    if (!scene || !url) {
      reject(new Error("loadMap: scene and url are required."));
      return;
    }

    const loader = new GLTFLoader();

    loader.load(
      url,

      // ─── onLoad ────────────────────────────────────────────────────
      async (gltf) => {
        try {
          const root = gltf.scene;
          if (!root) throw new Error("GLB has no scene node.");

          // ── 1. Tag meshes, set shadows ──────────────────────────────
          setProgress(onProgress, 72, "Parsing Redline Yard");
          await yieldToBrowser();

          const meshes = [];
          root.traverse((node) => { if (node.isMesh) meshes.push(node); });
          await processMeshesInChunks(meshes, onProgress, 74, 80);

          // ── 2. Measure the ORIGINAL bounding box (before repositioning) ─
          const rawBox    = await computeSceneBoxFromMeshes(root, meshes, onProgress, 80, 87);
          const rawCentre = new THREE.Vector3();
          rawBox.getCenter(rawCentre);

          const rawSize   = new THREE.Vector3();
          rawBox.getSize(rawSize);

          console.info(
            `[MapLoader] Raw bounds — size: (${rawSize.x.toFixed(1)}, ${rawSize.y.toFixed(1)}, ${rawSize.z.toFixed(1)})` +
            `  centre: (${rawCentre.x.toFixed(1)}, ${rawCentre.y.toFixed(1)}, ${rawCentre.z.toFixed(1)})`
          );

          // ── 3. Reposition: only centre on XZ. Leave Y untouched so the
          //    GLB's original Y=0 stays at world Y=0 (the intended floor).
          //    Underground geometry (foundations, cables, etc.) will sit
          //    below Y=0 but that is correct and harmless.
          root.position.set(
            -rawCentre.x,
            0,              // ← do NOT shift Y
            -rawCentre.z,
          );

          // ── 4. Measure world box after repositioning ─────────────────
          scene.add(root);
          await yieldToBrowser();
          const worldBox    = await computeSceneBoxFromMeshes(root, meshes, onProgress, 88, 94);
          const worldCentre = new THREE.Vector3();
          worldBox.getCenter(worldCentre);

          console.info(
            `[MapLoader] World bounds after positioning:`,
            `min=(${worldBox.min.x.toFixed(1)}, ${worldBox.min.y.toFixed(1)}, ${worldBox.min.z.toFixed(1)})`,
            `max=(${worldBox.max.x.toFixed(1)}, ${worldBox.max.y.toFixed(1)}, ${worldBox.max.z.toFixed(1)})`
          );

          // ── 5. Spawn point: user-specified eye-level world coordinates ──
          const spawnPoint = SPAWN_POINT.clone();

          console.info(
            `[MapLoader] Spawn point: (${spawnPoint.x.toFixed(2)}, ${spawnPoint.y.toFixed(2)}, ${spawnPoint.z.toFixed(2)})`
          );

          setProgress(onProgress, 95, "Arena geometry ready");
          resolve({ root, spawnPoint, box: worldBox });
        } catch (parseErr) {
          console.error("[MapLoader] Post-load processing error:", parseErr);
          reject(parseErr);
        }
      },

      // ─── onProgress ────────────────────────────────────────────────
      (xhr) => {
        if (xhr.lengthComputable && onProgress) {
          onProgress(Math.round((xhr.loaded / xhr.total) * 70), "Downloading arena package");
        }
      },

      // ─── onError ───────────────────────────────────────────────────
      (err) => {
        console.error("[MapLoader] Failed to load GLB:", err);
        reject(err);
      },
    );
  });
}

/**
 * Removes the previously loaded map from the scene and disposes GPU memory.
 */
export function unloadMap(scene) {
  const toRemove = [];

  scene.traverse((node) => {
    if (node.userData[MAP_TAG]) toRemove.push(node);
  });

  const roots = new Set();
  toRemove.forEach((node) => {
    let obj = node;
    while (obj.parent && obj.parent !== scene) obj = obj.parent;
    roots.add(obj);
  });

  roots.forEach((root) => {
    root.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          Object.values(m).forEach((v) => { if (v && v.isTexture) v.dispose(); });
          m.dispose();
        });
      }
    });
    scene.remove(root);
  });

  console.info("[MapLoader] Map unloaded and GPU memory freed.");
}
