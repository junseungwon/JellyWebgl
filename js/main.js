// ─────────────────────────────────────────────
// Phase 3: Three.js 씬 / AR.js 소스·컨텍스트 초기화
// ─────────────────────────────────────────────

const clock = new THREE.Clock();

// ── Renderer ──────────────────────────────────
// 모바일에서 MSAA는 시각적 이득 없이 GPU 발열만 유발
const _isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const renderer = new THREE.WebGLRenderer({ antialias: !_isMobile, alpha: true });
// 3x Retina 기기에서 픽셀 처리량 과다 방지 (2 이상은 AR 앱에서 무의미)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
  cameraParametersUrl: 'data/data/camera_para.dat',
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

// ── 트래킹 떨림 보정(스무딩) ───────────────────
// markerRoot(원본 추적 포즈)를 smoothedRoot로 복사하면서 lerp/slerp로 완만하게 따라가게 함
const smoothedRoot = new THREE.Group();
scene.add(smoothedRoot);
smoothedRoot.visible = false;

const SMOOTHING_ALPHA = 0.18; // 0~1 (값이 작을수록 더 부드럽지만 지연이 커짐)
let hasSmoothedPose = false;
const _tmpPos = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpScale = new THREE.Vector3();

// ── 렌더/AR 프레임 제어 ────────────────────────
const RENDER_FPS = 30;               // GPU: 화면 그리기 상한
const AR_FPS    = 15;               // CPU: NFT 특징점 검출 상한
const RENDER_MS = 1000 / RENDER_FPS;
const AR_MS     = 1000 / AR_FPS;
let _lastRenderTime = 0;
let _lastARTime     = 0;
let _lastMarkerVisible = null;       // DOM 업데이트 중복 방지용

// ─────────────────────────────────────────────
// Phase 4: 3D 모델 로드 및 이벤트 연결
// ─────────────────────────────────────────────

let mixer = null;
let loadedModel = null;
let unitScale = 1;     // maxAxis 기준 1배율일 때의 normalizedScale
let baseOffset = { x: 0, y: 0, z: 0 };  // 바닥 중앙 정렬 오프셋 (scale=1 기준)
markerRoot.visible = false;

// 슬라이더 연결
const scaleSlider = document.getElementById('scale-slider');
const scaleValueLabel = document.getElementById('scale-value');
const xSlider = document.getElementById('x-slider');
const ySlider = document.getElementById('y-slider');
const zSlider = document.getElementById('z-slider');
const xValueLabel = document.getElementById('x-value');
const yValueLabel = document.getElementById('y-value');
const zValueLabel = document.getElementById('z-value');
const rxSlider = document.getElementById('rx-slider');
const rySlider = document.getElementById('ry-slider');
const rzSlider = document.getElementById('rz-slider');
const rxValueLabel = document.getElementById('rx-value');
const ryValueLabel = document.getElementById('ry-value');
const rzValueLabel = document.getElementById('rz-value');

function applyTransform() {
  if (!loadedModel) return;
  const s = unitScale * parseFloat(scaleSlider.value);
  loadedModel.scale.setScalar(s);
  loadedModel.position.set(
    baseOffset.x * s + parseFloat(xSlider.value),
    baseOffset.y * s + parseFloat(ySlider.value),
    baseOffset.z * s + parseFloat(zSlider.value)
  );
  loadedModel.rotation.set(
    THREE.MathUtils.degToRad(parseFloat(rxSlider.value)),
    THREE.MathUtils.degToRad(parseFloat(rySlider.value)),
    THREE.MathUtils.degToRad(parseFloat(rzSlider.value))
  );
}

// 초기 라벨 동기화(기본값 표시 보장)
scaleValueLabel.textContent = parseFloat(scaleSlider.value).toFixed(2);
xValueLabel.textContent = parseFloat(xSlider.value).toFixed(2);
yValueLabel.textContent = parseFloat(ySlider.value).toFixed(2);
zValueLabel.textContent = parseFloat(zSlider.value).toFixed(2);
rxValueLabel.textContent = String(parseInt(rxSlider.value, 10));
ryValueLabel.textContent = String(parseInt(rySlider.value, 10));
rzValueLabel.textContent = String(parseInt(rzSlider.value, 10));

scaleSlider.addEventListener('input', () => {
  scaleValueLabel.textContent = parseFloat(scaleSlider.value).toFixed(2);
  applyTransform();
});
xSlider.addEventListener('input', () => {
  xValueLabel.textContent = parseFloat(xSlider.value).toFixed(2);
  applyTransform();
});
ySlider.addEventListener('input', () => {
  yValueLabel.textContent = parseFloat(ySlider.value).toFixed(2);
  applyTransform();
});
zSlider.addEventListener('input', () => {
  zValueLabel.textContent = parseFloat(zSlider.value).toFixed(2);
  applyTransform();
});
rxSlider.addEventListener('input', () => {
  rxValueLabel.textContent = String(parseInt(rxSlider.value, 10));
  applyTransform();
});
rySlider.addEventListener('input', () => {
  ryValueLabel.textContent = String(parseInt(rySlider.value, 10));
  applyTransform();
});
rzSlider.addEventListener('input', () => {
  rzValueLabel.textContent = String(parseInt(rzSlider.value, 10));
  applyTransform();
});

const gltfLoader = new THREE.GLTFLoader();
gltfLoader.load(
  'assets/model.glb',
  (gltf) => {
    const model = gltf.scene;

    // 바운딩박스로 모델 실제 크기 측정
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // 가장 긴 축을 1로 맞추는 단위 스케일 계산
    const maxAxis = Math.max(size.x, size.y, size.z);
    unitScale = 1 / maxAxis;

    // 바닥 중앙 정렬 오프셋 (scale=1 기준, applyScale에서 곱해서 사용)
    baseOffset = {
      x: -center.x / maxAxis,
      y: -box.min.y / maxAxis,
      z: -center.z / maxAxis,
    };

    loadedModel = model;
    smoothedRoot.add(model);

    // 슬라이더 초기값 반영
    applyTransform();

    if (gltf.animations && gltf.animations.length > 0) {
      mixer = new THREE.AnimationMixer(model);
      mixer.clipAction(gltf.animations[0]).play();
    }
  },
  (xhr) => console.log(`모델 로딩: ${((xhr.loaded / xhr.total) * 100).toFixed(1)}%`),
  (err) => console.error('모델 로드 실패:', err)
);

// 마커 감지 / 소실 이벤트
const statusMsg = document.getElementById('status-msg');

markerControls.addEventListener('markerFound', () => { markerRoot.visible = true;  });
markerControls.addEventListener('markerLost',  () => { markerRoot.visible = false; });

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

function animate(timestamp) {
  requestAnimationFrame(animate);

  // 탭이 숨겨진 상태면 모든 연산 스킵 (백그라운드 발열 방지)
  if (document.hidden) return;

  // 렌더링을 30fps로 제한 — 프레임 간격이 충분히 열리지 않으면 스킵
  if (timestamp - _lastRenderTime < RENDER_MS) return;
  _lastRenderTime = timestamp;

  const delta = clock.getDelta();

  // AR 특징점 검출을 15fps로 제한 — 렌더보다 CPU 비용이 훨씬 큼
  if (arToolkitSource.ready && timestamp - _lastARTime >= AR_MS) {
    arToolkitContext.update(arToolkitSource.domElement);
    _lastARTime = timestamp;
  }

  // 원본 포즈(markerRoot)를 스무딩 포즈(smoothedRoot)로 보정 복사
  if (markerRoot.visible) {
    markerRoot.getWorldPosition(_tmpPos);
    markerRoot.getWorldQuaternion(_tmpQuat);
    markerRoot.getWorldScale(_tmpScale);

    smoothedRoot.visible = true;
    if (!hasSmoothedPose) {
      smoothedRoot.position.copy(_tmpPos);
      smoothedRoot.quaternion.copy(_tmpQuat);
      smoothedRoot.scale.copy(_tmpScale);
      hasSmoothedPose = true;
    } else {
      smoothedRoot.position.lerp(_tmpPos, SMOOTHING_ALPHA);
      smoothedRoot.quaternion.slerp(_tmpQuat, SMOOTHING_ALPHA);
      // scale은 NFT 트래킹에서 급격히 튀지 않으므로 lerp 없이 즉시 복사
      smoothedRoot.scale.copy(_tmpScale);
    }
  } else {
    smoothedRoot.visible = false;
    hasSmoothedPose = false;
  }

  if (mixer) mixer.update(delta);

  // opacity는 값이 실제로 바뀔 때만 DOM에 접근 (매 프레임 스타일 재계산 방지)
  const isVisible = markerRoot.visible;
  if (isVisible !== _lastMarkerVisible) {
    statusMsg.style.opacity = isVisible ? '1' : '0';
    _lastMarkerVisible = isVisible;
  }

  renderer.render(scene, camera);
}

// 탭 전환 후 복귀 시 루프 재개
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) requestAnimationFrame(animate);
});

requestAnimationFrame(animate);
