import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { WEAPON_RULES } from "../js/protocol.js";
import { WEAPON_DEFS, WeaponSystem } from "../js/weaponSystem.js";

const previousWindow = globalThis.window;
const previousCustomEvent = globalThis.CustomEvent;
const previousSelf = globalThis.self;
const previousProgressEvent = globalThis.ProgressEvent;
const previousCreateImageBitmap = globalThis.createImageBitmap;
const browserEvents = [];
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

before(() => {
  globalThis.CustomEvent ??= class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  globalThis.window = {
    dispatchEvent(event) {
      browserEvents.push(event);
      return true;
    },
  };
  globalThis.self = globalThis;
  globalThis.ProgressEvent ??= class ProgressEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
});

after(() => {
  globalThis.window = previousWindow;
  globalThis.CustomEvent = previousCustomEvent;
  if (previousSelf === undefined) delete globalThis.self;
  else globalThis.self = previousSelf;
  if (previousProgressEvent === undefined) delete globalThis.ProgressEvent;
  else globalThis.ProgressEvent = previousProgressEvent;
  if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
  else globalThis.createImageBitmap = previousCreateImageBitmap;
});

test("all shipped weapon GLBs parse with usable mesh materials", async () => {
  for (const [weaponId, def] of Object.entries(WEAPON_DEFS)) {
    if (!def.file) continue;
    const modelPath = path.join(PROJECT_ROOT, def.file.replace(/^\.\//, ""));
    const bytes = fs.readFileSync(modelPath);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().parse(arrayBuffer, "", resolve, reject);
    });

    let meshCount = 0;
    let materialCount = 0;
    gltf.scene.traverse((node) => {
      if (!node.isMesh) return;
      meshCount += 1;
      materialCount += Array.isArray(node.material) ? node.material.length : Number(!!node.material);
    });
    assert.ok(meshCount > 0, `${weaponId} model contains no renderable mesh`);
    assert.ok(materialCount > 0, `${weaponId} model contains no usable material`);
  }
});

test("all weapon viewmodels keep immediate feedback and accept only matching server ammo", async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  scene.add(camera);
  const weapon = new WeaponSystem(camera, scene);
  const shots = [];
  let reloadRequests = 0;
  weapon._loader.load = (_url, onLoad) => {
    const root = new THREE.Group();
    root.name = "Test_GLTF_Viewmodel";
    root.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.2, 0.8),
      new THREE.MeshStandardMaterial({ color: 0x44aaff }),
    ));
    onLoad({ scene: root });
  };
  weapon.setColliders([]);
  weapon.setNetworkShotReporter((request) => shots.push(request));
  weapon.setNetworkReloadReporter(() => { reloadRequests += 1; });

  let shotSeq = 1;
  for (const [weaponId, rules] of Object.entries(WEAPON_RULES)) {
    const shotsBefore = shots.length;
    const reloadsBefore = reloadRequests;
    await weapon.equip(weaponId);

    assert.equal(weapon.def.serverAuthoritative, true);
    assert.equal(weapon.def.netId, rules.weaponNetId);
    assert.equal(weapon.def.rpm, rules.rpm);
    assert.equal(weapon.def.damage, rules.damage);
    assert.equal(weapon.def.spread, rules.spread);
    assert.equal(weapon.def.range, rules.range);
    assert.equal(weapon.def.auto, rules.automatic);
    assert.equal(weapon.ammo, rules.magSize);
    assert.equal(weapon.reserveAmmo, rules.reserveAmmo);

    const shot = {
      shotSeq: shotSeq++,
      inputSeq: 9,
      rewindTick: 120,
      yaw: 0,
      pitch: 0,
    };
    const recoil = weapon.tryFire(shot);
    assert.ok(recoil > 0, `${weaponId} should predict recoil immediately`);
    assert.equal(weapon.ammo, rules.magSize - 1);
    assert.deepEqual(shots.slice(shotsBefore), [shot]);
    assert.equal(
      weapon.tryFire({ ...shot, shotSeq: shotSeq++ }),
      0,
      `${weaponId} local cadence prediction should stay intact`,
    );

    assert.equal(weapon.reload(), true);
    assert.equal(reloadRequests, reloadsBefore + 1);
    assert.equal(weapon.isReloading, true);

    const otherRules = Object.values(WEAPON_RULES)
      .find((candidate) => candidate.weaponNetId !== rules.weaponNetId);
    assert.equal(weapon.applyAuthoritativeCombatState({
      weaponNetId: otherRules.weaponNetId,
      ammo: 0,
      reserveAmmo: 0,
      reloadRemainingTicks: 0,
      reloading: false,
    }), false);
    assert.equal(weapon.ammo, rules.magSize - 1);

    assert.equal(weapon.applyAuthoritativeCombatState({
      weaponNetId: rules.weaponNetId,
      ammo: rules.magSize - 1,
      reserveAmmo: rules.reserveAmmo,
      reloadRemainingTicks: 0,
      reloading: false,
    }), true);
    assert.equal(weapon.ammo, rules.magSize - 1);
    assert.equal(weapon.reserveAmmo, rules.reserveAmmo);
    assert.equal(weapon.isReloading, false);
  }

  assert.equal(Object.keys(WEAPON_DEFS).length, 4);
  assert.equal(camera.children.filter((child) => child !== undefined).length >= 1, true);
  assert.ok(browserEvents.some((event) => event.type === "potspark:ammo"));
});
