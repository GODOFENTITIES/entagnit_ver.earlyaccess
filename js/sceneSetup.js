import * as THREE from "three";

export class SceneSetup {
  constructor({ canvas }) {
    if (!canvas) {
      throw new Error("SceneSetup requires a canvas element.");
    }

    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.scene.fog = new THREE.FogExp2(0x090a0f, 0.018);

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.4, 1200);
    this.camera.position.set(0, 2.2, 8);

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      canvas,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.0));
    // Shadows disabled: too expensive on a ~1180-unit map with thousands of meshes.
    // Re-enable with a tighter shadow camera if needed later.
    this.renderer.shadowMap.enabled = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.addLights();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  addLights() {
    const ambientLight = new THREE.HemisphereLight(0xded7c8, 0x171820, 1.4);
    this.scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
    keyLight.position.set(12, 18, 9);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 90;
    keyLight.shadow.camera.left = -45;
    keyLight.shadow.camera.right = 45;
    keyLight.shadow.camera.top = 45;
    keyLight.shadow.camera.bottom = -45;
    this.scene.add(keyLight);

    const redAccent = new THREE.PointLight(0xff4655, 28, 42, 2);
    redAccent.position.set(-8, 4.5, 3);
    this.scene.add(redAccent);
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

export function createSceneSetup(options) {
  return new SceneSetup(options);
}
