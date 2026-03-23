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

let mixer = null;
let loadedModel = null;
let unitScale = 1;     // maxAxis 기준 1배율일 때의 normalizedScale
let baseOffset = { x: 0, y: 0, z: 0 };  // 바닥 중앙 정렬 오프셋 (scale=1 기준)
markerRoot.visible = false;
let _isTrackingParent = false;
// 포지션은 고정 중앙 정렬로 유지하고, 회전만 UI로 조절
const TRACKING_Y_LIFT = 0.18; // 마커 표면 위로 캐릭터를 띄우는 기본 높이
const TRACKING_CENTER_SHIFT_X = 0.5; // NFT 원점(좌하단) -> 중앙 보정
const TRACKING_CENTER_SHIFT_Y = 0.5; // NFT 원점(좌하단) -> 중앙 보정
const TRACKING_CENTER_SHIFT_Z = 0.0;
const FIXED_TRACKING_SCALE = 1.8; // 과도한 스케일로 인한 깨짐 방지
const PREVIEW_SCALE = 1.0;
// 제거된 포지션 UI의 기본값을 코드 상수로 고정 적용
const DEFAULT_OFFSET_X = 150;
const DEFAULT_OFFSET_Y = 0;
const DEFAULT_OFFSET_Z = -150;
const DEFAULT_OFFSET_GAIN = 20.0;
const BASE_OFFSET_UNIT = 0.001;
const MAX_TRACKING_FIXED_OFFSET = 1.5;

// 슬라이더 연결
const rotXSlider = document.getElementById('rot-x-slider');
const rotYSlider = document.getElementById('rot-y-slider');
const rotZSlider = document.getElementById('rot-z-slider');
const rotXValueLabel = document.getElementById('rot-x-value');
const rotYValueLabel = document.getElementById('rot-y-value');
const rotZValueLabel = document.getElementById('rot-z-value');

function applyTransform() {
  if (!loadedModel) return;
  const rawScale = _isTrackingParent ? FIXED_TRACKING_SCALE : PREVIEW_SCALE;
  const s = unitScale * rawScale;
  const offsetUnit = BASE_OFFSET_UNIT * DEFAULT_OFFSET_GAIN;
  const fixedOffsetX = THREE.MathUtils.clamp(
    DEFAULT_OFFSET_X * offsetUnit,
    -MAX_TRACKING_FIXED_OFFSET,
    MAX_TRACKING_FIXED_OFFSET
  );
  const fixedOffsetY = THREE.MathUtils.clamp(
    DEFAULT_OFFSET_Y * offsetUnit,
    -MAX_TRACKING_FIXED_OFFSET,
    MAX_TRACKING_FIXED_OFFSET
  );
  const fixedOffsetZ = THREE.MathUtils.clamp(
    DEFAULT_OFFSET_Z * offsetUnit,
    -MAX_TRACKING_FIXED_OFFSET,
    MAX_TRACKING_FIXED_OFFSET
  );
  const safeX = _isTrackingParent ? TRACKING_CENTER_SHIFT_X + fixedOffsetX : fixedOffsetX;
  const safeY = _isTrackingParent ? TRACKING_CENTER_SHIFT_Y + fixedOffsetY : fixedOffsetY;
  const safeZ = _isTrackingParent ? TRACKING_CENTER_SHIFT_Z + fixedOffsetZ : fixedOffsetZ;
  const liftY = _isTrackingParent ? 0 : TRACKING_Y_LIFT;
  loadedModel.scale.setScalar(s);
  loadedModel.position.set(
    baseOffset.x * s + safeX,
    baseOffset.y * s + safeY + liftY,
    baseOffset.z * s + safeZ
  );
  loadedModel.rotation.set(
    THREE.MathUtils.degToRad(parseFloat(rotXSlider.value)),
    THREE.MathUtils.degToRad(parseFloat(rotYSlider.value)),
    THREE.MathUtils.degToRad(parseFloat(rotZSlider.value))
  );
}

function setModelParent(useTrackingParent) {
  if (!loadedModel) return;
  if (useTrackingParent) smoothedRoot.add(loadedModel);
  _isTrackingParent = useTrackingParent;
  applyTransform();
}

// 초기 라벨 동기화(기본값 표시 보장)
rotXValueLabel.textContent = String(parseInt(rotXSlider.value, 10));
rotYValueLabel.textContent = String(parseInt(rotYSlider.value, 10));
rotZValueLabel.textContent = String(parseInt(rotZSlider.value, 10));

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
  'assets/Character.glb',
  (gltf) => {
    const model = gltf.scene;
    // GLB에 포함된 vertex color(COLOR_0/COLOR_1)로 인한 얼룩 패턴 방지
    model.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.frustumCulled = false;
      if (obj.geometry) {
        obj.geometry.deleteAttribute('color');
        if (!obj.geometry.attributes.normal) {
          obj.geometry.computeVertexNormals();
        }
      }
      if (obj.isSkinnedMesh && typeof obj.normalizeSkinWeights === 'function') {
        obj.normalizeSkinWeights();
      }
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      materials.forEach((mat) => {
        if (!mat) return;
        mat.vertexColors = false;
        mat.side = THREE.FrontSide;
        mat.depthWrite = true;
        mat.depthTest = true;
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
    // 시작 시에는 숨김 상태. 마커 인식 시 AR 루트에 붙여서 표시.
    model.visible = false;
    _isTrackingParent = false;

    // 슬라이더 초기값 반영
    applyTransform();

    if (gltf.animations && gltf.animations.length > 0) {
      console.table(gltf.animations.map((clip, index) => ({
        index,
        name: clip.name,
        durationSec: Number(clip.duration.toFixed(2)),
      })));
      mixer = new THREE.AnimationMixer(model);
      const clipByName = new Map(gltf.animations.map((clip) => [clip.name, clip]));
      const defaultClip =
        clipByName.get('Armature|Idle') ||
        clipByName.get('Idle') ||
        clipByName.get('Armature|Run.001') ||
        clipByName.get('Armature|Run.002') ||
        clipByName.get('Run') ||
        clipByName.get('Run.001') ||
        gltf.animations.find((clip) => {
          const tail = (clip.name || '').split('|').pop() || '';
          return tail.toLowerCase().startsWith('idle');
        }) ||
        gltf.animations.find((clip) => {
          const tail = (clip.name || '').split('|').pop() || '';
          return tail.toLowerCase().startsWith('run');
        }) ||
        gltf.animations[0];
      mixer.stopAllAction();
      const action = mixer.clipAction(defaultClip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.enabled = true;
      action.setEffectiveTimeScale(1);
      action.setEffectiveWeight(1);
      action.time = 0;
      action.reset();
      action.play();
      console.log(`기본 재생 클립(Idle 우선): ${defaultClip.name}`);
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
  if (loadedModel) loadedModel.visible = true;
});
markerControls.addEventListener('markerLost',  () => {
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

    smoothedRoot.visible = true;
    if (!hasSmoothedPose) {
      smoothedRoot.position.copy(_tmpPos);
      smoothedRoot.quaternion.copy(_tmpQuat);
      // NFT scale 변동은 스키닝 메쉬 왜곡을 유발할 수 있어 고정 스케일 유지
      smoothedRoot.scale.set(1, 1, 1);
      hasSmoothedPose = true;
    } else {
      smoothedRoot.position.lerp(_tmpPos, SMOOTHING_ALPHA);
      smoothedRoot.quaternion.slerp(_tmpQuat, SMOOTHING_ALPHA);
      // marker scale은 적용하지 않고 고정값 유지
      smoothedRoot.scale.set(1, 1, 1);
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
