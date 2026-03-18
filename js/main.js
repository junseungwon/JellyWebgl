// ─────────────────────────────────────────────
// Phase 3: Three.js 씬 / AR.js 소스·컨텍스트 초기화
// ─────────────────────────────────────────────

const clock = new THREE.Clock();

// ── Renderer ──────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.style.position = 'absolute';
renderer.domElement.style.top = '0px';
renderer.domElement.style.left = '0px';
document.getElementById('ar-container').appendChild(renderer.domElement);

// ── Scene / Camera ────────────────────────────
const scene = new THREE.Scene();
const camera = new THREE.Camera();
scene.add(camera);

// ── AR 카메라 소스 (기기 카메라) ──────────────
const arToolkitSource = new THREEx.ArToolkitSource({ sourceType: 'webcam' });

arToolkitSource.init(() => {
  arToolkitSource.domElement.addEventListener('canplay', () => {
    onResize();
  });
});

// ── AR 컨텍스트 ───────────────────────────────
const arToolkitContext = new THREEx.ArToolkitContext({
  cameraParametersUrl: THREEx.ArToolkitContext.baseURL + 'data/data/camera_para.dat',
  detectionMode: 'mono',
});

arToolkitContext.init(() => {
  camera.projectionMatrix.copy(arToolkitContext.getProjectionMatrix());
});

// ── NFT 마커 컨트롤러 ─────────────────────────
// Phase 2 완료 후 assets/ 에 .fset/.fset3/.iset 파일을 넣고
// 아래 descriptorsUrl 경로를 해당 파일명(확장자 제외)으로 수정하세요.
const markerRoot = new THREE.Group();
scene.add(markerRoot);

const markerControls = new THREEx.ArMarkerControls(arToolkitContext, markerRoot, {
  type: 'nft',
  descriptorsUrl: 'assets/target-image',  // ← Phase 2 디스크립터 경로
});

// ─────────────────────────────────────────────
// Phase 4: 3D 모델 로드 및 이벤트 연결
// ─────────────────────────────────────────────

let mixer = null;
markerRoot.visible = false;

const gltfLoader = new THREE.GLTFLoader();
gltfLoader.load(
  'assets/model.glb',                      // ← 실제 .glb 파일로 교체
  (gltf) => {
    const model = gltf.scene;
    model.scale.set(1, 1, 1);              // 필요에 따라 스케일 조정
    markerRoot.add(model);

    if (gltf.animations && gltf.animations.length > 0) {
      mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(gltf.animations[0]).play();
    }
  },
  (xhr) => console.log(`모델 로딩: ${((xhr.loaded / xhr.total) * 100).toFixed(1)}%`),
  (err) => console.error('모델 로드 실패:', err)
);

// 마커 감지 / 소실 이벤트
markerControls.addEventListener('markerFound',  () => { markerRoot.visible = true;  });
markerControls.addEventListener('markerLost',   () => { markerRoot.visible = false; });

// ─────────────────────────────────────────────
// Phase 5: 라이팅
// ─────────────────────────────────────────────

const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
directionalLight.position.set(5, 10, 5);
scene.add(directionalLight);

// ─────────────────────────────────────────────
// 유틸리티
// ─────────────────────────────────────────────

function onResize() {
  arToolkitSource.onResizeElement();
  arToolkitSource.copyElementSizeTo(renderer.domElement);
  if (arToolkitContext.arController !== null) {
    arToolkitSource.copyElementSizeTo(arToolkitContext.arController.canvas);
  }
}
window.addEventListener('resize', onResize);

// ─────────────────────────────────────────────
// 애니메이션 루프
// ─────────────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  if (arToolkitSource.ready) {
    arToolkitContext.update(arToolkitSource.domElement);
  }

  if (mixer) mixer.update(delta);

  renderer.render(scene, camera);
}

animate();
