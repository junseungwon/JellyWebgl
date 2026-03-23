// ─────────────────────────────────────────────
// Phase 3: Three.js 씬 / AR.js 소스·컨텍스트 초기화
// ─────────────────────────────────────────────


// ── Renderer ──────────────────────────────────
// 모바일에서 MSAA는 시각적 이득 없이 GPU 발열만 유발
const _isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const renderer = new THREE.WebGLRenderer({
  antialias: !_isMobile,
  alpha: true,
  precision: 'highp',
  logarithmicDepthBuffer: true,
});
// 3x Retina 기기에서 픽셀 처리량 과다 방지 (2 이상은 AR 앱에서 무의미)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.style.position = 'absolute';
renderer.domElement.style.top = '0px';
renderer.domElement.style.left = '0px';
renderer.domElement.style.zIndex = '1';
renderer.domElement.style.pointerEvents = 'none';
document.getElementById('ar-container').appendChild(renderer.domElement);

// ── Scene / Camera ────────────────────────────
const scene = new THREE.Scene();
const camera = new THREE.Camera();
scene.add(camera);

// ── AR 카메라 소스 (기기 카메라) ──────────────
const arToolkitSource = new THREEx.ArToolkitSource({ sourceType: 'webcam' });

function attachCameraVideoLayer() {
  const container = document.getElementById('ar-container');
  const sourceEl = arToolkitSource.domElement;
  if (!container || !sourceEl) return;
  // 카메라 비디오는 항상 배경 레이어에 고정한다.
  sourceEl.style.position = 'absolute';
  sourceEl.style.top = '0px';
  sourceEl.style.left = '0px';
  sourceEl.style.width = '100%';
  sourceEl.style.height = '100%';
  sourceEl.style.objectFit = 'cover';
  sourceEl.style.zIndex = '0';
  sourceEl.style.pointerEvents = 'none';
  sourceEl.style.display = 'block';
  sourceEl.style.visibility = 'visible';
  sourceEl.setAttribute('playsinline', 'true');
  sourceEl.setAttribute('muted', 'true');
  if (sourceEl.parentElement !== container) {
    container.insertBefore(sourceEl, renderer.domElement);
  }
}

arToolkitSource.init(() => {
  attachCameraVideoLayer();
  arToolkitSource.domElement.addEventListener('canplay', () => {
    attachCameraVideoLayer();
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
// 모델은 별도 루트에 두고, 트래킹 포즈를 수동 복사해 스킨 왜곡 리스크를 줄임
const modelRoot = new THREE.Group();
scene.add(modelRoot);
modelRoot.visible = false;

const SMOOTHING_ALPHA = 0.10; // 0~1 (값이 작을수록 더 부드럽고 포즈 급변 노이즈가 줄어듦)
let hasSmoothedPose = false;
const _tmpPos = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpLabelPos = new THREE.Vector3();

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

let loadedModel = null;
let unitScale = 1;     // maxAxis 기준 1배율일 때의 normalizedScale
let baseOffset = { x: 0, y: 0, z: 0 };  // 바닥 중앙 정렬 오프셋 (scale=1 기준)
markerRoot.visible = false;
let _isTrackingParent = false;
const DEBUG_MESH = true;
// 안정 구간: 슬라이더 값은 유지하되 실제 좌표는 축소/클램프 적용
const TRACKING_Y_LIFT = 0.18; // 마커 표면 위로 캐릭터를 띄우는 기본 높이
const TRACKING_CENTER_SHIFT_X = 0.5; // NFT 원점(좌하단) -> 중앙 보정
const TRACKING_CENTER_SHIFT_Y = 0.5; // NFT 원점(좌하단) -> 중앙 보정
const TRACKING_CENTER_SHIFT_Z = 0.0;
const MIN_SAFE_SCALE = 0.1;
const MAX_SAFE_SCALE = 220.0;
const TRACKING_MAX_SAFE_SCALE = MAX_SAFE_SCALE; // 런타임 슬라이더 값을 트래킹 중에도 그대로 반영
const TRACKING_BOOTSTRAP_MS = 220;    // markerFound 직후 스케일 워밍업 시간
const TRACKING_RUNTIME_SCALE_CAP = 60.0; // 트래킹 중 급격한 대배율을 제한
let _trackingScaleUnlockAt = 0;
let _trackingScaleRestored = true;

// 슬라이더 연결
const scaleSlider = document.getElementById('scale-slider');
const gainSlider = document.getElementById('gain-slider');
const rotXSlider = document.getElementById('rot-x-slider');
const rotYSlider = document.getElementById('rot-y-slider');
const rotZSlider = document.getElementById('rot-z-slider');
const scaleValueLabel = document.getElementById('scale-value');
const gainValueLabel = document.getElementById('gain-value');
const rotXValueLabel = document.getElementById('rot-x-value');
const rotYValueLabel = document.getElementById('rot-y-value');
const rotZValueLabel = document.getElementById('rot-z-value');

function applyTransform() {
  if (!loadedModel) return;
  const rawScale = THREE.MathUtils.clamp(parseFloat(scaleSlider.value), MIN_SAFE_SCALE, MAX_SAFE_SCALE);
  const gain = THREE.MathUtils.clamp(parseFloat(gainSlider.value), 1.0, 60.0);
  const trackingSafeScale = Math.min(rawScale, TRACKING_MAX_SAFE_SCALE);
  const isBootstrapWindow = _isTrackingParent && performance.now() < _trackingScaleUnlockAt;
  const scaleForRender = isBootstrapWindow
    ? Math.min(trackingSafeScale, 6.0)
    : Math.min(trackingSafeScale, TRACKING_RUNTIME_SCALE_CAP);
  const s = unitScale * scaleForRender * gain;
  const safeX = 0;
  const safeY = 0;
  const safeZ = 0;
  const anchorX = _isTrackingParent ? TRACKING_CENTER_SHIFT_X : 0;
  const anchorY = _isTrackingParent ? TRACKING_CENTER_SHIFT_Y : 0;
  const anchorZ = _isTrackingParent ? TRACKING_CENTER_SHIFT_Z : 0;
  const liftY = _isTrackingParent ? 0 : TRACKING_Y_LIFT;
  loadedModel.scale.setScalar(s);
  loadedModel.position.set(
    baseOffset.x * s + anchorX + safeX,
    baseOffset.y * s + anchorY + safeY + liftY,
    baseOffset.z * s + anchorZ + safeZ
  );
  loadedModel.rotation.set(
    THREE.MathUtils.degToRad(parseFloat(rotXSlider.value)),
    THREE.MathUtils.degToRad(parseFloat(rotYSlider.value)),
    THREE.MathUtils.degToRad(parseFloat(rotZSlider.value))
  );
  if (DEBUG_MESH && _isTrackingParent && isBootstrapWindow) {
    console.debug('[mesh-fix] bootstrap scale lock', {
      rawScale,
      trackingSafeScale,
      scaleForRender,
      unitScale,
      finalScalar: s,
    });
  }
}

function setModelParent(useTrackingParent) {
  if (!loadedModel) return;
  _isTrackingParent = useTrackingParent;
  modelRoot.visible = useTrackingParent;
  applyTransform();
}

// 초기 라벨 동기화(기본값 표시 보장)
scaleValueLabel.textContent = parseFloat(scaleSlider.value).toFixed(2);
gainValueLabel.textContent = parseFloat(gainSlider.value).toFixed(1);
rotXValueLabel.textContent = String(parseInt(rotXSlider.value, 10));
rotYValueLabel.textContent = String(parseInt(rotYSlider.value, 10));
rotZValueLabel.textContent = String(parseInt(rotZSlider.value, 10));

scaleSlider.addEventListener('input', () => {
  scaleValueLabel.textContent = parseFloat(scaleSlider.value).toFixed(2);
  applyTransform();
});
gainSlider.addEventListener('input', () => {
  gainValueLabel.textContent = parseFloat(gainSlider.value).toFixed(1);
  applyTransform();
});
rotXSlider.addEventListener('input', () => {
  rotXValueLabel.textContent = String(parseInt(rotXSlider.value, 10));
  applyTransform();
});
rotYSlider.addEventListener('input', () => {
  rotYValueLabel.textContent = String(parseInt(rotYSlider.value, 10));
  applyTransform();
});
rotZSlider.addEventListener('input', () => {
  rotZValueLabel.textContent = String(parseInt(rotZSlider.value, 10));
  applyTransform();
});

const gltfLoader = new THREE.GLTFLoader();
gltfLoader.load(
  'assets/untitled.glb',
  (gltf) => {
    const model = gltf.scene;
    let skinnedCount = 0;
    let meshCount = 0;
    let transparentMatCount = 0;
    let alphaTestMatCount = 0;
    const materialSignals = [];
    // 모델 원본 머티리얼/버텍스 속성을 최대한 보존해 메쉬 아티팩트를 줄인다.
    model.traverse((obj) => {
      if (!obj.isMesh) return;
      meshCount += 1;
      obj.frustumCulled = false;
      // 일부 GLB는 COLOR_0, 투명도, 알파 테스트를 의도적으로 사용하므로 삭제/강제 덮어쓰기를 피한다.
      if (obj.isSkinnedMesh && typeof obj.normalizeSkinWeights === 'function') {
        skinnedCount += 1;
        obj.normalizeSkinWeights();
      }
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      materials.forEach((mat, matIndex) => {
        if (!mat) return;
        const hasAlphaMap = Boolean(mat.alphaMap);
        const usesAlphaTest = typeof mat.alphaTest === 'number' && mat.alphaTest > 0.0001;
        const isTransparent = mat.transparent === true;
        const isOpaqueByOpacity = typeof mat.opacity !== 'number' || mat.opacity >= 0.999;
        if (mat.transparent === true) transparentMatCount += 1;
        if (usesAlphaTest) alphaTestMatCount += 1;
        const isCutout = hasAlphaMap || usesAlphaTest;
        const matName = mat.name || `${obj.name || obj.uuid}-mat${matIndex}`;

        if (isCutout) {
          // 컷아웃(알파맵/알파테스트) 재질: 정렬 충돌을 피하기 위해 depth write를 끈다.
          mat.transparent = true;
          mat.depthWrite = false;
          if (!usesAlphaTest) mat.alphaTest = 0.5;
          mat.side = THREE.DoubleSide;
        } else {
          // 불투명 재질은 투명도를 끄고 depth write를 활성화해 배경 비침을 차단한다.
          mat.transparent = false;
          mat.opacity = 1.0;
          mat.alphaTest = 0.0;
          mat.depthWrite = true;
          mat.side = THREE.FrontSide;
        }
        materialSignals.push({
          mesh: obj.name || obj.uuid,
          material: matName,
          transparentBefore: isTransparent,
          transparentAfter: mat.transparent,
          hasAlphaMap,
          alphaTestBefore: usesAlphaTest ? mat.alphaTest : 0,
          alphaTestAfter: mat.alphaTest || 0,
          opacityBefore: typeof mat.opacity === 'number' ? mat.opacity : 1,
          isOpaqueByOpacity,
          depthWrite: mat.depthWrite,
          side: mat.side === THREE.DoubleSide ? 'DoubleSide' : 'FrontSide',
        });
        mat.needsUpdate = true;
      });
    });

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
      y: -center.y / maxAxis,
      z: -center.z / maxAxis,
    };

    loadedModel = model;
    modelRoot.add(model);
    // 시작 시에는 숨김 상태. 마커 인식 시 AR 루트에 붙여서 표시.
    model.visible = false;
    _isTrackingParent = false;

    // 슬라이더 초기값 반영
    applyTransform();
    if (DEBUG_MESH) {
      console.info('[mesh-fix] model stats', {
        meshCount,
        skinnedCount,
        unitScale,
        rawSize: { x: size.x, y: size.y, z: size.z },
        baseOffset,
        sliderScale: parseFloat(scaleSlider.value),
        gain: parseFloat(gainSlider.value),
        transparentMatCount,
        alphaTestMatCount,
        materialSignalCount: materialSignals.length,
      });
      console.table(materialSignals.slice(0, 20));
    }

  },
  (xhr) => {
    if (!xhr.total) return;
    console.log(`모델 로딩: ${((xhr.loaded / xhr.total) * 100).toFixed(1)}%`);
  },
  (err) => console.error('모델 로드 실패:', err)
);

// 마커 감지 / 소실 이벤트
const statusMsg = document.getElementById('status-msg');

markerControls.addEventListener('markerFound', () => { markerRoot.visible = true;  });
markerControls.addEventListener('markerLost',  () => { markerRoot.visible = false; });
markerControls.addEventListener('markerFound', () => {
  setModelParent(true);
  _trackingScaleUnlockAt = performance.now() + TRACKING_BOOTSTRAP_MS;
  _trackingScaleRestored = false;
  applyTransform();
  if (loadedModel) loadedModel.visible = true;
  if (DEBUG_MESH) {
    console.info('[mesh-fix] markerFound', {
      trackingScaleUnlockMs: TRACKING_BOOTSTRAP_MS,
      sliderScale: parseFloat(scaleSlider.value),
    });
  }
});
markerControls.addEventListener('markerLost',  () => {
  _trackingScaleUnlockAt = 0;
  _trackingScaleRestored = true;
  if (loadedModel) loadedModel.visible = false;
});

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

  // AR 특징점 검출을 15fps로 제한 — 렌더보다 CPU 비용이 훨씬 큼
  if (arToolkitSource.ready && timestamp - _lastARTime >= AR_MS) {
    arToolkitContext.update(arToolkitSource.domElement);
    _lastARTime = timestamp;
  }

  // 원본 포즈(markerRoot)를 스무딩 포즈(smoothedRoot)로 보정 복사
  if (markerRoot.visible) {
    markerRoot.getWorldPosition(_tmpPos);
    markerRoot.getWorldQuaternion(_tmpQuat);

    smoothedRoot.visible = true;
    if (!hasSmoothedPose) {
      smoothedRoot.position.copy(_tmpPos);
      smoothedRoot.quaternion.copy(_tmpQuat);
      // 마커 scale 변동은 스킨 메쉬 왜곡 원인이 되어 고정 스케일로 유지
      smoothedRoot.scale.set(1, 1, 1);
      hasSmoothedPose = true;
    } else {
      smoothedRoot.position.lerp(_tmpPos, SMOOTHING_ALPHA);
      smoothedRoot.quaternion.slerp(_tmpQuat, SMOOTHING_ALPHA);
      smoothedRoot.scale.set(1, 1, 1);
    }
    // 트래킹 포즈를 모델 루트에 수동 반영 (scale은 항상 1 유지)
    modelRoot.position.copy(smoothedRoot.position);
    modelRoot.quaternion.copy(smoothedRoot.quaternion);
    modelRoot.scale.set(1, 1, 1);
  } else {
    smoothedRoot.visible = false;
    modelRoot.visible = false;
    hasSmoothedPose = false;
  }

  if (_isTrackingParent && !_trackingScaleRestored && performance.now() >= _trackingScaleUnlockAt) {
    // 워밍업 창이 끝나면 사용자 스케일을 즉시 다시 반영
    _trackingScaleRestored = true;
    applyTransform();
  }

  // opacity는 값이 실제로 바뀔 때만 DOM에 접근 (매 프레임 스타일 재계산 방지)
  const isVisible = markerRoot.visible;
  if (isVisible !== _lastMarkerVisible) {
    statusMsg.style.opacity = isVisible ? '1' : '0';
    _lastMarkerVisible = isVisible;
  }
  if (isVisible) {
    // 마커 중심점을 화면 좌표로 투영해 상태 메시지를 마커 바로 위에 고정
    markerRoot.getWorldPosition(_tmpLabelPos);
    _tmpLabelPos.project(camera);
    const x = (_tmpLabelPos.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-_tmpLabelPos.y * 0.5 + 0.5) * window.innerHeight;
    statusMsg.style.left = `${x}px`;
    statusMsg.style.top = `${Math.max(16, y - 44)}px`;
    statusMsg.style.transform = 'translate(-50%, -100%)';
  }

  renderer.render(scene, camera);
}

// 탭 전환 후 복귀 시 루프 재개
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) requestAnimationFrame(animate);
});

requestAnimationFrame(animate);
