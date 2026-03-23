(function () {
  const stage = document.getElementById("stage");
  const hud = document.getElementById("hud");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );
  camera.position.set(0, 1.3, 3.2);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  stage.appendChild(renderer.domElement);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(4, 8, 4);
  scene.add(dir);

  const grid = new THREE.GridHelper(8, 16, 0x444444, 0x333333);
  scene.add(grid);

  let mixer = null;
  const clock = new THREE.Clock();

  function fitModel(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxAxis = Math.max(size.x, size.y, size.z) || 1;
    const scale = 1.8 / maxAxis;
    model.scale.setScalar(scale);
    model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  }

  const loader = new THREE.GLTFLoader();
  loader.load(
    "assets/newModel.glb",
    (gltf) => {
      const model = gltf.scene;
      fitModel(model);
      scene.add(model);

      const clips = gltf.animations || [];
      let defaultClip = null;
      if (clips.length > 0) {
        defaultClip =
          clips.find((clip) => clip.name.includes("Run")) || clips[0];
        mixer = new THREE.AnimationMixer(model);
        mixer.clipAction(defaultClip).play();
      }

      const clipList = clips.map((clip, index) => ({
        index,
        name: clip.name,
        durationSec: Number(clip.duration.toFixed(2)),
      }));
      console.table(clipList);
      console.log("GLB_ANIMATION_LIST:", JSON.stringify(clipList));

      hud.textContent =
        "GLB 로드 성공\n" +
        `클립 수: ${clips.length}\n` +
        `기본 재생: ${defaultClip ? defaultClip.name : "(없음)"}`;
    },
    (xhr) => {
      if (!xhr.total) return;
      const pct = ((xhr.loaded / xhr.total) * 100).toFixed(1);
      hud.textContent = `GLB 로딩 중... ${pct}%`;
    },
    (err) => {
      console.error("GLB 로드 실패:", err);
      hud.textContent = "GLB 로드 실패 (콘솔 확인)";
    }
  );

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    if (mixer) mixer.update(dt);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
})();
