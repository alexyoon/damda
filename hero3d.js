/* hero3d.js — 히어로 사진을 깊이맵 기반 3D 시점 이동 효과로 바꿔 줍니다.
 * 사용: <script type="module" src="hero3d.js"></script>
 * 동작: AI(Depth Anything)가 브라우저에서 사진의 깊이를 추정 → Three.js로 입체 메시 생성
 *       → 마우스/터치/기울기에 따라 시점이 좌우·상하로 움직임. 실패 시 원본 사진 그대로 유지.
 */
const SELECTOR = '#top .hero-media img'; // 3D로 바꿀 사진
const MAX_DEG  = 18;    // 최대 시점 이동 각도 (크게 하면 가장자리가 늘어남)
const DEPTH    = 0.22;  // 입체 깊이 강도 (사진 높이 대비)
const ZOOM     = 1.18;  // 가장자리 노출 방지용 확대

const img = document.querySelector(SELECTOR);
if (img) init().catch(e => console.warn('[hero3d] 3D 변환 실패, 원본 사진 유지:', e));

async function init() {
  if (!img.complete) await img.decode();

  const [THREE, { pipeline }] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js'),
    import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3'),
  ]);

  // 1) 깊이 추정 (밝을수록 가까움)
  const estimator = await pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small');
  const { depth } = await estimator(img.currentSrc || img.src);

  // 2) 깊이맵 → 부드럽게 블러 처리한 캔버스 (경계 찢어짐 방지)
  const dw = depth.width, dh = depth.height, raw = depth.data, ch = depth.channels || 1;
  const src = document.createElement('canvas');
  src.width = dw; src.height = dh;
  const sctx = src.getContext('2d');
  const id = sctx.createImageData(dw, dh);
  for (let i = 0; i < dw * dh; i++) {
    const v = raw[i * ch];
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(id, 0, 0);
  const dmap = document.createElement('canvas');
  dmap.width = dw; dmap.height = dh;
  const dctx = dmap.getContext('2d');
  dctx.filter = 'blur(3px)';
  dctx.drawImage(src, 0, 0);

  // 3) Three.js 장면
  const host = img.parentElement;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const cv = renderer.domElement;
  Object.assign(cv.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%',
    opacity: '0', transition: 'opacity .8s', touchAction: 'pan-y'
  });
  host.appendChild(cv);

  const aspect = img.naturalWidth / img.naturalHeight;
  // 표시 크기가 아닌 원본 크기로 캔버스에 옮겨서 텍스처로 사용
  const pic = document.createElement('canvas');
  pic.width = img.naturalWidth; pic.height = img.naturalHeight;
  pic.getContext('2d').drawImage(img, 0, 0);
  const colorTex = new THREE.CanvasTexture(pic);
  colorTex.minFilter = THREE.LinearFilter; colorTex.generateMipmaps = false;
  const depthTex = new THREE.CanvasTexture(dmap);

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(aspect, 1, 320, Math.round(320 / aspect)),
    new THREE.ShaderMaterial({
      uniforms: { map: { value: colorTex }, dm: { value: depthTex }, amt: { value: DEPTH } },
      vertexShader: [
        'uniform sampler2D dm; uniform float amt; varying vec2 vUv;',
        'void main(){ vUv = uv;',
        '  float d = texture2D(dm, uv).r;',
        '  vec3 p = position; p.z += (d - 0.5) * amt;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D map; varying vec2 vUv;',
        'void main(){ gl_FragColor = texture2D(map, vUv); }'
      ].join('\n'),
    })
  );
  const scene = new THREE.Scene(); scene.add(mesh);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  const FOV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

  // object-fit: cover 처럼 화면을 가득 채우는 거리 계산
  let dist = 2;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    const needH = Math.min(1, aspect / camera.aspect) / ZOOM; // 보여야 할 세로 길이
    dist = needH / 2 / FOV;
  }
  new ResizeObserver(resize).observe(host); resize();

  // 4) 입력: 마우스 / 터치 / 기기 기울기
  const target = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
  let idle = true;
  const setPtr = (cx, cy) => {
    const r = host.getBoundingClientRect();
    target.x = ((cx - r.left) / r.width - 0.5) * 2;
    target.y = ((cy - r.top) / r.height - 0.5) * 2;
    idle = false;
  };
  window.addEventListener('pointermove', e => setPtr(e.clientX, e.clientY));
  window.addEventListener('deviceorientation', e => {
    if (e.gamma == null) return;
    target.x = THREE.MathUtils.clamp(e.gamma / 30, -1, 1);
    target.y = THREE.MathUtils.clamp((e.beta - 45) / 30, -1, 1);
    idle = false;
  });
  document.addEventListener('pointerleave', () => (idle = true));

  // 5) 렌더 루프 (화면에 보일 때만)
  let visible = true;
  new IntersectionObserver(([en]) => (visible = en.isIntersecting)).observe(host);
  const maxRad = THREE.MathUtils.degToRad(MAX_DEG);
  renderer.setAnimationLoop(t => {
    if (!visible) return;
    if (idle) { target.x = Math.sin(t / 2200) * 0.6; target.y = Math.cos(t / 3100) * 0.25; }
    cur.x += (target.x - cur.x) * 0.06;
    cur.y += (target.y - cur.y) * 0.06;
    const ax = cur.x * maxRad, ay = -cur.y * maxRad;
    camera.position.set(Math.sin(ax) * dist, Math.sin(ay) * dist, Math.cos(ax) * Math.cos(ay) * dist);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  });

  // 준비되면 부드럽게 교체
  requestAnimationFrame(() => { cv.style.opacity = '1'; });
  setTimeout(() => { img.style.visibility = 'hidden'; }, 850);
}
