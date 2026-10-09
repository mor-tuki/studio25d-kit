// engine.js — 2.5D / 360 studio renderer
//   座標系 unproject / focal / screenZ・部屋 Group・入力空間カメラ＋幾何クランプ・ライト/接地影・揺れ物安全・深度クランプ帯
//
// ■ 絵の外（マゼンタ）検査について
//   countMagenta() は「背景メッシュだけを白・背景色マゼンタ」で 1920×1080 の RenderTarget に独立描画して数える。
//   キャラ・スライド板・暗転の幕はこのパスに一切入らないので、それらが穴を隠して合格になることは構造上あり得ない。
//   判定は G<254 の画素を全部数える（白以外＝露出。混ざりも NG）。
// ■ カメラは入力空間 {yaw,pitch,x,y,dolly,zoom} 以外から触らない（setSafeCamera 経由のみ）。
//   優先順：移動 A ＞ カメラムーブ（moves.json）＞ preset＋手動＋歩行追従（walkFollow）。どれも入力空間で合成してから
//   setSafeCamera(…, 'wide') に渡すので、ムーブ・歩行を足しても絵の外は出ない（幾何クランプが最後に必ず効く）。
// ■ 360 部屋（rooms.json type:"pano360"）：正距円筒を GroundedSkybox（下半分を床平面へ投影）に貼る。絵の外が無いので
//   幾何クランプは通さない（setSafeCamera はそのまま applyPanoPose）。入力空間の意味だけ部屋の種類で変わる：
//   yaw＝キャラの周りを回る方位（°・360 で一周）／pitch＝見上げ・見下ろし（°）／x＝横の平行移動／y＝高さ／dolly＝寄る／zoom＝画角を狭める。
//   注視点はキャラの胸（a からの移動に follow.target の割合で追従＝歩行もカメラが付いてくる）。マゼンタ検査はそのまま回る（0 が正）。
// ■ キャラ姿勢は applyCharPose(t) 1 か所（idle → walk の順）。歩行の時間は engine.elapsed（物理と同じ 1/30 頭打ち）。
//   例外は検収撮影用の debugCloseCamera()（?shot=1&cam=close の顔計測のみ・配信経路からは呼ばれない）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { ROOMS, ROOM_MAP, resolveRoom } from './rooms.js';
import { tuneMaterials, tuneSprings } from './material_tune.js';
import { createIdleMotion } from './idle_motion.js';
import { createSpringSafety } from './spring_safety.js';
import { createWalk } from './walk.js';
import { adaptVrm1 } from './vrm1_adapt.js';   // VRM 1.0 用の向き・符号合わせ。VRM 0.x では何もしない
import { loadMoves, findMove, moveEnabled, moveDuration, evalMove, lerpInput, easeInOut } from './moves.js';

const clamp = THREE.MathUtils.clamp;
const rad = THREE.MathUtils.degToRad;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export const isPano = id => (ROOM_MAP[id] || {}).type === 'pano360';
export const isOrbital = id => isPano(id);                           // 軌道カメラ系（applyPanoPose を通る部屋）
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180;
export const ZERO = Object.freeze({ yaw: 0, pitch: 0, x: 0, y: 0, dolly: 0, zoom: 0 });
export const CAMERA_KEYS = Object.keys(ZERO);
const BG_COLOR = 0x070a13;
const textureLoader = new THREE.TextureLoader();
const log = m => fetch('/log', { method: 'POST', body: String(m) }).catch(() => {});

function pointInside(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (((a.y > y) !== (b.y > y)) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Liang–Barsky: true if an exterior edge intrudes into the viewport rectangle.
function hitsRectangle(a, b, extent) {
  let low = 0, high = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy], q = [a.x + extent, extent - a.x, a.y + extent, extent - a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return false; }
    else { const t = q[i] / p[i]; if (p[i] < 0) low = Math.max(low, t); else high = Math.min(high, t); if (low > high) return false; }
  }
  return true;
}

async function texture(url, anisotropy = 8) {
  const t = await textureLoader.loadAsync(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

async function depthData(url) {
  const image = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
  const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
  const context = c.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
  const rgba = context.getImageData(0, 0, c.width, c.height).data;
  const data = new Float32Array(c.width * c.height);
  for (let i = 0; i < data.length; i++) data[i] = (rgba[i * 4] * 256 + rgba[i * 4 + 1]) / 65535; // rg16
  return { data, width: c.width, height: c.height };
}

const isVideoUrl = url => /\.(mp4|webm)(\?|#|$)/i.test(url);

// 動画スライド：muted・playsInline・loop の <video> を作り、最初のフレームが出たら VideoTexture にする
function videoTexture(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.src = url; v.crossOrigin = 'anonymous'; v.loop = true; v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    const fail = () => reject(new Error('video load failed: ' + url));
    v.addEventListener('error', fail, { once: true });
    v.addEventListener('loadeddata', () => {
      const t = new THREE.VideoTexture(v);
      t.colorSpace = THREE.SRGBColorSpace; t.userData.video = v;
      resolve(t);
    }, { once: true });
    v.load();
  });
}

function disposeSlide(t) {
  if (!t) return;
  const v = t.userData && t.userData.video;
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  t.dispose();
}

function blobTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  const rg = g.createRadialGradient(128, 128, 8, 128, 128, 124);
  rg.addColorStop(0, 'rgba(0,0,0,0.9)'); rg.addColorStop(0.4, 'rgba(0,0,0,0.55)');
  rg.addColorStop(0.75, 'rgba(0,0,0,0.15)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(cv);
}

export class StudioEngine {
  constructor(canvas, { onStatus = () => {}, config = {} } = {}) {
    this.canvas = canvas; this.onStatus = onStatus; this.config = config || {}; this.rooms = ROOMS; this.roomId = ROOMS[0].id;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(BG_COLOR);
    this.camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.05, 60);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.roomObjects = new Map(); this.slideTextures = []; this.slideSignature = ''; this.page = 0;
    this.cameraInput = { ...ZERO }; this.preset = 'wide'; this.debug = false; this.transitionOpacity = 0;
    this.transition = null; this.vrm = null; this.elapsed = 0; this.ready = false; this.safeFactor = 1;
    this.transitionSeconds = 2.0; this.avatarOn = true; this.screenOn = true; this.frozen = false;
    this.lastTransitionId = null; this.fade = 'dark';
    this.idle = null;
    this.walkers = new Map(); this.walk = null; this.walkState = null; this.walkQueue = [];
    this.move = null; this.returnBlend = null; this.swayOn = true; this.swayW = 1; this.lastInput = null; this.lastMoveId = null; this.lastWalkId = null;
    this.springs = createSpringSafety(() => this.vrm, t => this.applyCharPose(t), log);
    this._auditMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide });
    document.addEventListener('visibilitychange', () => this.springs.reset()); // 非表示→再表示で暴れさせない
    this.resize(canvas.clientWidth || 1920, canvas.clientHeight || 1080);
  }

  async init() {
    this.onStatus('背景と奥行きを読み込み中');
    await Promise.all(ROOMS.map(async config => this.roomObjects.set(config.id, await this.buildRoom(config))));
    await loadMoves();
    this.setRoom(this.roomId, { force: true });
    // キャラ（任意）：studio.config.json の character.vrm が空なら背景だけで動く（歩行・接地影も無効）
    const ch = this.config.character || {};
    if (ch.vrm) {
      this.onStatus('キャラ（VRM）を読み込み中');
      const loader = new GLTFLoader(); loader.register(parser => new VRMLoaderPlugin(parser));
      try {
        const gltf = await loader.loadAsync(ch.vrm); this.vrm = gltf.userData.vrm;
        if (!this.vrm) throw new Error('VRM humanoid is missing');
        VRMUtils.rotateVRM0(this.vrm);
        adaptVrm1(this.vrm);   // VRM 1.0 を VRM 0.x と同じ向き・姿勢の意味にそろえる（VRM 0.x では何もしない）
        const box = new THREE.Box3().setFromObject(this.vrm.scene);
        this.avatarRawHeight = box.max.y - box.min.y; this.avatarRawMinY = box.min.y;
        this.vrm.scene.traverse(o => { if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.frustumCulled = false; } });
        tuneMaterials(this.vrm, ch.materialRules || []);
        if (ch.tuneSprings !== false) tuneSprings(this.vrm);
        this.idle = createIdleMotion(this.vrm, this.camera, { lookAtCamera: ch.lookAtCamera !== false });
        this.scene.add(this.vrm.scene);
        const armZ = ch.armsDownZ ?? 1.15;   // T ポーズ → 腕を下ろす角度（rad）。VRM 1.0 の符号は vrm1_adapt が合わせる
        for (const [name, z] of [['leftUpperArm', armZ], ['rightUpperArm', -armZ]]) {
          const node = this.vrm.humanoid.getNormalizedBoneNode(name); if (node) node.rotation.z = z;
        }
        this.idle.update(0);
        this.placeAvatar();
        for (const [id, room] of this.roomObjects) this.walkers.set(id, this.makeWalker(room));
        this.placeAvatar();
      } catch (error) { this.vrm = null; this.avatarError = error.message; this.onStatus('VRMを読み込めません: ' + error.message); log('vrm load error ' + error.message); }
    }
    this.ready = true; this.setSafeCamera(this.cameraInput);
    this.onStatus(this.avatarError ? '背景の準備完了・VRM読込失敗' : this.vrm ? '準備完了' : '準備完了（キャラなし）');
    if (this.pendingState) { const state = this.pendingState; this.pendingState = null; this.applyState(state); }
    return this;
  }

  async buildRoom(config) {
    if (config.type === 'pano360') return this.buildPanoRoom(config);
    const group = new THREE.Group(); group.name = config.id; group.visible = false;
    const bgTexture = await texture(config.background);
    const W = config.width, H = config.height;               // 座標系（画像の実ピクセル数とは独立）
    const focal = H / 2 / Math.tan(rad(config.referenceFov / 2));
    const [tl, tr, br, bl] = config.screen;
    const screenZ = config.screenWidth * focal / (tr[0] - tl[0]);
    let dep = null;
    if (config.depth) try { dep = await depthData(config.depth); } catch { this.onStatus(config.name + '：奥行きを手動校正値で補完'); }
    const sample = (px, py) => {
      if (!dep) return null;
      const x = clamp(px / W * (dep.width - 1), 0, dep.width - 1), y = clamp(py / H * (dep.height - 1), 0, dep.height - 1);
      const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, dep.width - 1), y1 = Math.min(y0 + 1, dep.height - 1), tx = x - x0, ty = y - y0;
      return (dep.data[y0 * dep.width + x0] * (1 - tx) + dep.data[y0 * dep.width + x1] * tx) * (1 - ty) + (dep.data[y1 * dep.width + x0] * (1 - tx) + dep.data[y1 * dep.width + x1] * tx) * ty;
    };
    const center = config.screen.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    const dCenter = sample(...center) ?? 0.25;
    const cl = config.screenClamp || null;
    // 奥行きの写像。depthRange {zmin,zmax}＝「z ∝ zmin＋(1−d)(zmax−zmin)」をスクリーン面（中央値）で
    // screenZ に合わせて再スケール（立体感が強い）。無ければ線形圧縮 screenZ＋(dCenter−d)·depthAmplitude。
    const R = config.depthRange || null;
    let dsMed = dCenter;
    if (R && dep) {
      const med = [];
      for (let y = tl[1]; y < bl[1]; y += 6) for (let x = tl[0]; x < tr[0]; x += 6) med.push(sample(x, y));
      med.sort((a, b) => a - b); dsMed = med[med.length >> 1];
    }
    const rangeZ = d => screenZ * (R.zmin + (1 - d) * (R.zmax - R.zmin)) / (R.zmin + (1 - dsMed) * (R.zmax - R.zmin));
    const depthAt = (x, y) => {
      const d = sample(x, y);
      // Compress inferred relief to avoid long spikes at window/foreground depth discontinuities.
      let z = d === null ? screenZ - (Math.max(0, y / H - 0.58) / 0.42) * (config.depthAmplitude ?? 0.5) :
        R ? rangeZ(d) : screenZ + (dCenter - d) * config.depthAmplitude;
      // CL 帯：スクリーン周辺（下は広め）を screenZ 以遠に丸める（スライド前の「黒い山」対策）
      if (cl && x >= tl[0] - cl.left && x <= tr[0] + cl.right && y >= tl[1] - cl.top && y <= bl[1] + cl.bottom) z = Math.max(z, screenZ);
      // A flat inset keeps the independent slide in front of its original screen.
      if (x >= tl[0] - 10 && x <= tr[0] + 10 && y >= tl[1] - 10 && y <= bl[1] + 10) z = screenZ;
      return z;
    };
    const unproject = (x, y, z = depthAt(x, y)) => new THREE.Vector3((x - W / 2) / focal * z, (H / 2 - y) / focal * z, -z);
    // 格子は 256×144。パディング禁止：UV 0〜1 の外に頂点を作らない（MG=240 は縞の原因）。
    const nx = 256, ny = 144, positions = [], uv = [], indices = [], perimeter = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const px = i / nx * W, py = j / ny * H, v = unproject(px, py);
      positions.push(v.x, v.y, v.z); uv.push(i / nx, 1 - j / ny);
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1; indices.push(a, c, b, b, c, d); }
    const addEdge = (i, j) => { const k = (j * (nx + 1) + i) * 3; perimeter.push(new THREE.Vector3(positions[k], positions[k + 1], positions[k + 2])); };
    for (let i = 0; i <= nx; i++) addEdge(i, 0);
    for (let j = 1; j <= ny; j++) addEdge(nx, j);
    for (let i = nx - 1; i >= 0; i--) addEdge(i, ny);
    for (let j = ny - 1; j > 0; j--) addEdge(0, j);
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geometry.setIndex(indices);
    const bg = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: bgTexture, toneMapped: false, side: THREE.DoubleSide })); bg.name = 'Background:' + config.id; group.add(bg);
    const corners = config.screen.map(([x, y]) => unproject(x, y, screenZ - 0.025));
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap(p => p.toArray()), 3)); sg.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2)); sg.setIndex([0, 2, 1, 0, 3, 2]);
    const screen = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0x062d36, toneMapped: false, side: THREE.DoubleSide })); screen.name = 'Screen'; group.add(screen);
    const actor = config.actor || { foot: config.foot, height: 1.55, yawDeg: -10 };
    const foot = unproject(...actor.foot), screenCenter = unproject(...center, screenZ);
    const shadows = this.addGrounding(group, foot);
    this.addLights(group, config, foot, unproject);
    this.scene.add(group);
    return { config, actor, group, bg, screen, shadows, foot, screenCenter, perimeter, unproject, depthAt, screenZ, focal,
      depthSource: dep ? 'supplied-rg16' : 'calibrated-smooth' };
  }

  // 360 部屋：GroundedSkybox（height＝撮影時の目の高さ・radius＝床が壁へ立ち上がる距離）＋床の高さ 0 に足を置く
  async buildPanoRoom(config) {
    const group = new THREE.Group(); group.name = config.id; group.visible = false;
    const P = config.pano || {};
    const big = this.renderer.capabilities.maxTextureSize >= 8192, aniso = this.renderer.capabilities.getMaxAnisotropy();
    // 8192 幅が載らない GPU は 4096 版。読めなければ次の候補へ（全部だめでも他の部屋は壊さない）
    let map = null, used = null;
    for (const url of [big ? config.background : null, config.backgroundSmall, config.thumb].filter(Boolean)) {
      try { map = await texture(url, aniso); used = url; break; } catch { log('pano texture missing ' + url); }
    }
    if (!map) { map = new THREE.DataTexture(new Uint8Array([7, 10, 19, 255]), 1, 1); map.needsUpdate = true; used = 'none'; }
    map.wrapS = THREE.RepeatWrapping; map.generateMipmaps = true; map.minFilter = THREE.LinearMipmapLinearFilter;
    const h = P.height ?? 1.7, R = P.radius ?? 6.5, cu = P.centerU ?? 0.5;
    const spin = 2 * Math.PI * (cu - 0.25);                     // 絵の中央（centerU）を −Z（初期カメラの奥）へ
    const sky = new GroundedSkybox(map, h, R, P.resolution ?? 160);
    sky.material.toneMapped = false;
    sky.position.y = h; sky.rotation.y = spin; sky.renderOrder = -1;
    sky.name = 'Background:' + config.id; group.add(sky);
    const W = config.width, H = config.height;
    // 絵座標 → 方向 → 撮影点 (0,h,0) から dist 先の点（光源・月などの目印用）
    const unproject = (px, py, dist = R * 0.92) => {
      const lon = (px / W - cu) * 2 * Math.PI, lat = (0.5 - py / H) * Math.PI;
      return new THREE.Vector3(Math.sin(lon) * Math.cos(lat), Math.sin(lat), -Math.cos(lon) * Math.cos(lat)).multiplyScalar(dist).add(new THREE.Vector3(0, h, 0));
    };
    // スライド板：絵のスクリーン矩形と同じ球面の切れ端（床へ投影する変形も GroundedSkybox と同じ式で掛ける）
    const [tl, , br] = config.screen;
    const sg = new THREE.SphereGeometry(R * 0.995, 48, 24, 2 * Math.PI * tl[0] / W, 2 * Math.PI * (br[0] - tl[0]) / W, Math.PI * tl[1] / H, Math.PI * (br[1] - tl[1]) / H);
    sg.scale(1, 1, -1);
    const pos = sg.getAttribute('position'), v = new THREE.Vector3(), y1 = -h * 1.5;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (v.y < 0) { v.multiplyScalar(v.y < y1 ? -h / v.y : 1 - v.y * v.y / (3 * y1 * y1)); v.toArray(pos.array, 3 * i); }
    }
    // 切れ端の uv を 0〜1 に張り直す（スライドを板いっぱいに）
    const uv = sg.getAttribute('uv');
    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (let i = 0; i < uv.count; i++) { u0 = Math.min(u0, uv.getX(i)); u1 = Math.max(u1, uv.getX(i)); w0 = Math.min(w0, uv.getY(i)); w1 = Math.max(w1, uv.getY(i)); }
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - u0) / (u1 - u0), (uv.getY(i) - w0) / (w1 - w0));
    const screen = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0x062d36, toneMapped: false }));
    screen.name = 'Screen'; screen.position.y = h; screen.rotation.y = spin; group.add(screen);
    const actor = config.actor;
    const spot = k => { const s = (actor.spots || {})[k] || [0, 0]; return new THREE.Vector3(s[0], 0, s[1]); };
    const foot = spot('a');
    const center = [(tl[0] + br[0]) / 2, (tl[1] + br[1]) / 2];
    const screenCenter = unproject(center[0], center[1], R * 0.97);
    const shadows = this.addGrounding(group, foot);
    this.addLights(group, config, foot, (x, y) => unproject(x, y, config.lighting?.anchorDistance ?? 4.5));
    this.scene.add(group);
    return { config, actor, group, bg: sky, screen, shadows, foot, screenCenter, perimeter: [], unproject, spotOf: spot,
      pano: { height: h, radius: R, centerU: cu, texture: used, textureSize: [map.image.width, map.image.height] },
      depthAt: () => R, screenZ: R, focal: 1, depthSource: 'pano360' };
  }

  // 360 部屋の注視点：a の胸 → 今のキャラの胸へ follow.target の割合（ジェスチャ中は資料/月へ少し寄せる）
  panoFocus(roomId = this.roomId, pos = this.vrm ? this.vrm.scene.position : null, st = this.walkState) {
    const room = this.roomObjects.get(roomId), cam = ROOM_MAP[roomId].camera, o = cam.orbit || {};
    const g = (cam.follow && cam.follow.target) ?? 0.75;
    const f = room.foot.clone();
    if (pos) f.lerp(new THREE.Vector3(pos.x, 0, pos.z), g);
    f.y = o.focusHeight ?? 1.05;
    const walker = this.walkers.get(roomId);
    const target = st && st.gw > 0 && walker && walker.targets[st.target];
    if (target) {
      const t = f.clone().lerp(target, 0.18); t.y = clamp(t.y, f.y - 0.3, f.y + 0.6);
      // 割合で寄せる量には絶対値の上限を付ける（目印が数十 m 先の部屋では 18% でも注視点が飛ぶ）→ 水平は 0.6m まで
      const dx = t.x - f.x, dz = t.z - f.z, hd = Math.hypot(dx, dz);
      if (hd > 0.6) { t.x = f.x + dx / hd * 0.6; t.z = f.z + dz / hd * 0.6; }
      f.lerp(t, st.gw);
    }
    return f;
  }

  // 360 部屋のカメラ：注視点の周りを方位 yaw で回る。pitch は見上げ（＋）/見下ろし（−）。球（壁）の内側に必ず収める
  applyPanoPose(input) {
    const room = this.room, cam = ROOM_MAP[this.roomId].camera, o = cam.orbit || {};
    const F = this.panoFocus();
    const az = rad(input.yaw + (o.yawDeg || 0));
    const back = new THREE.Vector3(Math.sin(az), 0, Math.cos(az)), right = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));
    const target = F.clone().addScaledVector(right, (o.aside || 0) + input.x);
    const d = Math.max(0.5, (o.distance ?? 3.4) - input.dolly);
    const p = target.clone().addScaledVector(back, d);
    p.y = (o.height ?? 1.3) + input.y;
    const maxR = room.pano.radius * (o.maxRadiusRatio ?? 0.72), hr = Math.hypot(p.x, p.z);
    if (hr > maxR) { p.x *= maxR / hr; p.z *= maxR / hr; }
    p.y = clamp(p.y, 0.25, room.pano.height + room.pano.radius * 0.5);
    this.camera.position.copy(p);
    const dir = target.clone().sub(p);
    const basePitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
    this.camera.rotation.set(basePitch + rad(input.pitch), Math.atan2(-dir.x, -dir.z), 0, 'YXZ');
    this.camera.fov = cam.fov - input.zoom;
    this.camera.far = Math.max(60, room.pano.radius * 2.2);   // 大きな球でも far で削れないよう
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld(true);
  }

  // addLights： rooms.json の lighting から組む（部屋ごとに色だけ変える）
  addLights(group, config, foot, unproject) {
    const L = config.lighting || {};
    const chest = foot.clone().add(new THREE.Vector3(0, 1.3, 0));
    const off = (o, fallback) => new THREE.Vector3(...(Array.isArray(o) ? o : fallback));
    const k = L.key || {};
    const key = new THREE.DirectionalLight(k.color || '#FFE4C2', k.intensity ?? 0.9);
    key.position.copy(foot).add(off(k.offset, [-1.6, 2.4, 2.0]));
    key.target.position.copy(chest);
    if (k.shadow !== false) {
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.near = 0.5; key.shadow.camera.far = 10;
      key.shadow.camera.left = -3; key.shadow.camera.right = 3;
      key.shadow.camera.top = 4; key.shadow.camera.bottom = -2;
      key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;
    }
    group.add(key, key.target);
    const f = L.fill || {};
    const fill = new THREE.PointLight(f.color || '#E6C9A6', f.intensity ?? 1.8, f.distance ?? 7, f.decay ?? 2);
    fill.position.copy(foot).add(off(f.offset, [1.6, 1.3, 2.0]));
    group.add(fill);
    const r = L.rim || {};
    const rim = new THREE.SpotLight(r.color || '#BFD4FF', r.intensity ?? 22, 0, rad(r.angleDeg ?? 26), r.penumbra ?? 0.55, 2);
    const anchor = r.anchor && config.anchors && config.anchors[r.anchor];
    if (Array.isArray(r.offset)) rim.position.copy(foot).add(off(r.offset));   // foot 基準 m（窓が遠い部屋向け）
    else if (anchor) rim.position.copy(unproject(anchor[0], anchor[1]));
    else rim.position.copy(foot).add(new THREE.Vector3(0.4, 3.2, -1.2));   // 既定：foot の上方やや奥
    rim.target.position.copy(chest);
    group.add(rim, rim.target);
    const h = L.hemi || {};
    group.add(new THREE.HemisphereLight(h.sky || '#4A4C8A', h.ground || '#161022', h.intensity ?? 0.22));
  }

  // addGrounding：見えない床（ShadowMaterial 板）＋ blob。foot に追従（部屋 Group 内に置く）
  addGrounding(group, foot) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.ShadowMaterial({ opacity: 0.4 }));
    plane.name = 'GroundShadow'; plane.rotation.x = -Math.PI / 2;
    plane.position.set(foot.x, foot.y + 0.008, foot.z); plane.receiveShadow = true;
    this._blobTex = this._blobTex || blobTexture();
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.5),
      new THREE.MeshBasicMaterial({ map: this._blobTex, transparent: true, depthWrite: false }));
    blob.name = 'BlobShadow'; blob.rotation.x = -Math.PI / 2;
    blob.position.set(foot.x, foot.y + 0.012, foot.z + 0.12); blob.renderOrder = 1;
    group.add(plane, blob);
    return [plane, blob];
  }

  get room() { return this.roomObjects.get(this.roomId); }

  setRoom(id, { force = false } = {}) {
    const next = resolveRoom(id);
    if (!force && this.activeRoomId === next) return false;
    this.roomId = next; this.activeRoomId = next;
    this.renderer.toneMappingExposure = ROOM_MAP[next].exposure ?? 1.0;   // 部屋ごとの露出（rooms.json exposure・既定 1.0）
    for (const [roomId, room] of this.roomObjects) room.group.visible = roomId === this.roomId;
    this.placeAvatar(); this.showSlide(); this.applyVisibility();
    return true;
  }

  // foot へ移動 → reset → settle(60)。部屋切替（暗転の底）でだけ呼ばれる
  placeAvatar() {
    const room = this.room; if (!this.vrm || !room) return;
    const scale = room.actor.height / this.avatarRawHeight;
    this.vrm.scene.scale.setScalar(scale);
    this.vrm.scene.position.copy(room.foot); this.vrm.scene.position.y -= this.avatarRawMinY * scale;
    this.vrm.scene.rotation.y = Math.PI + rad(room.actor.yawDeg ?? -10);
    this.walk = null; this.walkState = null; this.walkQueue = [];
    const walker = this.walkers.get(this.roomId);
    if (walker) walker.teleport('a');                // 接地影も a へ（歩行の途中で部屋を変えても戻る）
    this.vrm.scene.updateMatrixWorld(true);
    this.springs.reset();
    if (!this.frozen) this.springs.settle(60, this.elapsed);   // 検査中（frozen）は姿勢を使わないので省く
  }

  // 部屋ごとの歩行：rooms.json actor.spots・anchors.lookup・screen 中心から組む
  makeWalker(room) {
    const scale = room.actor.height / this.avatarRawHeight;
    const lift = new THREE.Vector3(0, -this.avatarRawMinY * scale, 0);
    const front = Math.PI + rad(room.actor.yawDeg ?? -10);
    const px = { ...(room.actor.spots || {}) };
    if (!room.spotOf) px.a = room.actor.foot;        // a ＝ foot（接地影の基準）
    const spots = {};
    if (room.spotOf) for (const k of Object.keys(px)) spots[k] = { pos: room.spotOf(k).add(lift), yaw: front };   // 360 部屋は床の m 座標
    else for (const [k, [x, y]] of Object.entries(px)) spots[k] = { pos: room.unproject(x, y).add(lift), yaw: front };
    const A = room.config.anchors || {}, moon = A.lookup || A.moon;   // 見上げる目印（lookup。旧名 moon も読む）
    return createWalk(this.vrm, { spots, frontYaw: front, slidePos: room.screenCenter.clone(),
      moonPos: moon ? room.unproject(moon[0], moon[1]) : null, gaze: this.idle ? this.idle.gaze : null, shadows: room.shadows });
  }

  get walker() { return this.walkers.get(this.roomId) || null; }

  nearestSpot() {
    const walker = this.walker; if (!walker || !this.vrm) return 'a';
    let best = 'a', bd = Infinity;
    for (const [k, s] of Object.entries(walker.spots)) { const d = this.vrm.scene.position.distanceTo(s.pos); if (d < bd) { bd = d; best = k; } }
    return best;
  }

  // 歩行開始。from は server の walkFrom（遅れて開いたページも同じ道を組める）。seek 秒ぶん進めた所から始める
  startWalk(name, from = null, seek = 0) {
    const def = findMove(name), walker = this.walker;
    if (!def || def.kind !== 'walk' || !walker || !this.vrm) return false;
    if (this.walk && seek <= 0) { this.walkQueue.push({ name, from }); return true; }   // 前の歩行が終わってから（瞬間移動させない）
    let key = from && walker.spots[from] ? from : this.nearestSpot();
    if (seek <= 0 && this.vrm.scene.position.distanceTo(walker.spots[key].pos) > 0.05) key = this.nearestSpot();
    const act = walker.build(name, def.steps, key);
    this.walk = { name, act, t0: this.elapsed - Math.max(0, seek) };
    if (seek > 0) { this.applyCharPose(this.elapsed); this.springs.reset(); }   // 途中参加は瞬間移動になるので揺れ物を戻す
    return true;
  }

  applyCharPose(t) {   // idle → walk の順。settle/撮影/ループ共通の唯一の入口
    this.idle && this.idle.update(t);
    const walker = this.walker;
    if (this.walk && walker) {
      const st = walker.evalAt(this.walk.act, t - this.walk.t0);
      walker.apply(st); this.walkState = st;
      if (st.done) {
        this.walk = null; this.walkState = null;
        const next = this.walkQueue.shift();
        if (next) this.startWalk(next.name, next.from);
      }
    }
  }

  // 歩行中のカメラ追従（入力空間のオフセット）：キャラの胸（ジェスチャ中は資料/月との中間）へ、a からの角度差の一定割合だけ向ける
  walkFollow(pos = this.vrm ? this.vrm.scene.position : null, st = this.walkState, roomId = this.roomId) {
    const walker = this.walkers.get(roomId);
    const out = { ...ZERO };
    if (!walker || !pos) return out;
    if (isPano(roomId)) return out;   // 360 部屋は注視点そのものがキャラに付いてくる（panoFocus）
    const gain = ROOM_MAP[roomId].camera.follow || { yaw: 0.35, pitch: 0.35, x: 0.1 };
    const a = walker.spots.a.pos;
    const chestA = a.clone().setY(a.y + 1.25), focus = pos.clone().setY(pos.y + 1.25);
    const target = st && st.gw > 0 && walker.targets[st.target];
    if (target) focus.lerp(focus.clone().lerp(target, 0.5), st.gw);
    const yawOf = v => THREE.MathUtils.radToDeg(Math.atan2(v.x, -v.z));
    const pitchOf = v => THREE.MathUtils.radToDeg(Math.atan2(v.y, Math.hypot(v.x, v.z)));
    out.yaw = (gain.yaw ?? 0) * (yawOf(focus) - yawOf(chestA));
    out.pitch = (gain.pitch ?? 0) * (pitchOf(focus) - pitchOf(chestA));
    out.x = (gain.x ?? 0) * (pos.x - a.x);
    out.zoom = (gain.zoomPerDeg ?? 0) * (Math.abs(out.yaw) + Math.abs(out.pitch));   // 振った分だけ少し寄る＝端に余裕を作る
    return out;
  }

  // preset＋手動＋歩行追従 → 絶対値の入力（可動域でクランプ済み）
  effectiveInput(camera = this.cameraInput, preset = this.preset, follow = this.walkFollow()) {
    const sum = {};
    for (const key of CAMERA_KEYS) sum[key] = Number(camera[key] || 0) + Number(follow[key] || 0);
    return this.desiredInput(sum, preset);
  }

  // 待機ゆらぎ（入力空間で）：x・y の平行移動だけ（向きは変えない＝視差だけが見える）。
  // rooms.json camera.sway {x,y,periodX,periodY,phaseY,scale{preset}}。振幅ぶん可動域の内側へ寄せてから足す（端で潰れない）。
  // w は 0〜1（入/切を 1.5 秒でなじませる）
  withSway(input, t = this.elapsed, preset = this.preset, w = this.swayW, roomId = this.roomId) {
    const cfg = ROOM_MAP[roomId].camera.sway;
    if (!cfg || !(w > 0)) return input;
    const lim = ROOM_MAP[roomId].camera, k = w * ((cfg.scale || {})[preset] ?? 1), out = { ...input };
    for (const [axis, amp, period, phase] of [['x', cfg.x || 0, cfg.periodX || 19, 0], ['y', cfg.y || 0, cfg.periodY || 27, cfg.phaseY ?? 1.1]]) {
      const A = amp * k;
      if (!A || !lim[axis]) continue;
      out[axis] = clamp(out[axis], lim[axis][0] + A, lim[axis][1] - A) + A * Math.sin(t * Math.PI * 2 / period + phase);
    }
    return out;
  }

  startMove(name, seek = 0) {
    const def = findMove(name);
    if (!def || (def.kind || 'move') !== 'move' || !moveEnabled(def, this.roomId)) return false;
    const base = this.effectiveInput();
    let from = this.lastInput || base;
    if (isOrbital(this.roomId)) {   // 軌道カメラ系の yaw は周期的：一周した後でも近い側から継ぐ（逆回りで巻き戻さない）
      const y0 = evalMove(def, this.roomId, 0, base).yaw;
      from = { ...from, yaw: y0 + wrap180(from.yaw - y0) };
    }
    this.move = { name, def, t: Math.max(0, seek), base, from, blend: seek > 0 ? 0 : (def.blend ?? 1.0),
      dur: moveDuration(def, this.roomId) };
    this.returnBlend = null;
    return true;
  }

  stopMove(blend = 1.0) {
    if (!this.move) return;
    this.move = null;
    const from = this.lastInput ? { ...this.lastInput } : null;
    if (from && isOrbital(this.roomId)) { const b = this.effectiveInput(); from.yaw = b.yaw + wrap180(from.yaw - b.yaw); }
    this.returnBlend = blend > 0 && from ? { from, t: 0, dur: blend } : null;
  }

  // ムーブの t 秒時点の入力（開始 blend 秒は直前のカメラから滑らかに継ぐ）
  moveInputAt(m, t, roomId = this.roomId) {
    // 波（呼吸型）は時間をそのまま渡す（周期が 12 秒で揃わないので、折り返すと 1 コマで飛ぶ）
    const local = m.def.wave ? t : m.def.loop ? t % m.dur : Math.min(t, m.dur);
    let p = evalMove(m.def, roomId, local, m.base);
    if (m.blend > 0 && t < m.blend) p = lerpInput(m.from, p, easeInOut(t / m.blend));
    return p;
  }

  applyVisibility() {
    const room = this.room;
    const charVisible = !!this.vrm && this.avatarOn && this.transitionOpacity < 0.75;
    if (this.vrm) this.vrm.scene.visible = charVisible;
    for (const r of this.roomObjects.values()) {
      for (const s of r.shadows) s.visible = charVisible;
      r.screen.visible = this.screenOn;
    }
    return room;
  }

  applyState(state) {
    if (!this.ready) { this.pendingState = state; return; }
    if (Number.isFinite(+state.transitionSeconds) && +state.transitionSeconds > 0) this.transitionSeconds = +state.transitionSeconds;
    const target = resolveRoom(state.room ?? this.roomId);
    const firstState = this.lastTransitionId === null;
    if (firstState) {
      // 遅れて開いた OBS は移動演出なしで今の部屋に入る
      if (target !== this.roomId) this.setRoom(target);
    } else if (target !== this.roomId && (!this.transition || this.transition.to !== target)) {
      this.transition = { from: this.roomId, to: target, time: 0, duration: this.transitionSeconds, mode: 'A' };
    }
    this.lastTransitionId = state.transitionId ?? 0;
    const presetChanged = state.preset && state.preset !== this.preset;
    this.preset = state.preset ?? this.preset;
    if (state.camera) this.setCameraInput(state.camera);
    if (presetChanged && !this.transition) this.springs.reset();    // プリセットの瞬間カット
    this.setDebug(Boolean(state.debug)); this.fade = state.fade ?? 'dark';
    this.avatarOn = state.avatar !== false; this.screenOn = state.screen !== false; this.swayOn = state.sway !== false;
    this.page = Number.isFinite(+state.page) ? Math.max(0, +state.page) : this.page;
    this.videoPlaying = state.videoPlaying !== false; this.videoMuted = state.videoMuted !== false;
    this.videoRestartId = state.videoRestartId ?? 0;
    if (Array.isArray(state.slides)) this.loadSlides(state.slides);
    this.showSlide(); this.applyVisibility();
    // ムーブ・歩行（ワンショット命令：moveId / walkId の変化で再生。遅れて開いたページは経過秒まで進めて合わせる）
    const since = at => Math.max(0, ((+state.serverTime || 0) - (+at || 0)) / 1000);
    const moveId = state.moveId ?? 0, walkId = state.walkId ?? 0;
    if (this.transition) { this.move = null; this.returnBlend = null; }
    if (this.lastMoveId === null) { if (state.move && !this.transition) this.startMove(state.move, since(state.moveStartedAt)); }
    else if (moveId !== this.lastMoveId) { if (state.move) this.startMove(state.move); else this.stopMove(); }
    else if (!state.move && this.move) this.stopMove();
    this.lastMoveId = moveId;
    if (this.lastWalkId === null) { if (state.walk && !this.transition) this.startWalk(state.walk, state.walkFrom, since(state.walkStartedAt)); }
    else if (walkId !== this.lastWalkId && state.walk) this.startWalk(state.walk, state.walkFrom);
    this.lastWalkId = walkId;
  }

  // スライド＝画像（png/jpg/webp/svg）か動画（mp4/webm）。動画は <video> → VideoTexture でスクリーン面に貼る。
  //   再生・一時停止・音・巻き戻しはサーバーの状態（videoPlaying / videoMuted / videoRestartId）に合わせる。
  async loadSlides(slides) {
    const urls = slides.map(s => typeof s === 'string' ? s : s.url ?? s.src).filter(Boolean);
    const signature = JSON.stringify(urls); if (signature === this.slideSignature) return;
    this.slideSignature = signature;
    const loaded = await Promise.all(urls.map(url => (isVideoUrl(url) ? videoTexture(url) : texture(url)).catch(() => null)));
    if (this.slideSignature !== signature) { for (const t of loaded) disposeSlide(t); return; }
    for (const t of this.slideTextures) disposeSlide(t); this.slideTextures = loaded; this.lastRestartId = null; this.showSlide();
  }

  get currentSlide() {
    const n = Math.max(1, this.slideTextures.length);
    return this.slideTextures[((this.page % n) + n) % n] ?? null;
  }

  showSlide() {
    const selected = this.currentSlide;
    for (const room of this.roomObjects.values()) {
      if (room.screen.material.map === selected) continue;
      room.screen.material.map = selected; room.screen.material.color.set(selected ? 0xffffff : 0x062d36); room.screen.material.needsUpdate = true;
    }
    this.syncVideo();
  }

  // 今のスライドが動画なら状態どおりに再生/停止、それ以外の動画は止める
  syncVideo() {
    const selected = this.currentSlide;
    for (const t of this.slideTextures) {
      const v = t && t.userData.video;
      if (!v) continue;
      if (t !== selected) { if (!v.paused) v.pause(); continue; }
      v.muted = this.videoMuted !== false;
      if (this.lastRestartId !== this.videoRestartId) { this.lastRestartId = this.videoRestartId; try { v.currentTime = 0; } catch { /* not seekable yet */ } }
      if (this.videoPlaying !== false) { if (v.paused) v.play().catch(e => { if (!v.muted) { v.muted = true; v.play().catch(() => {}); } log('video play ' + e.message); }); }
      else if (!v.paused) v.pause();
    }
  }

  setDebug(value) { this.debug = Boolean(value); this.scene.background.set(this.debug ? 0xff00ff : BG_COLOR); }
  setCameraInput(input) { this.cameraInput = { ...ZERO, ...input }; }

  resize(width, height) {
    this.renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    this.camera.aspect = Math.max(1, width) / Math.max(1, height); this.camera.updateProjectionMatrix();
    if (this.ready) this.setSafeCamera(this.cameraInput);
  }

  presetOffset(preset = this.preset, roomId = this.roomId) {
    return (ROOM_MAP[roomId].camera.presets || {})[preset] || {};
  }

  desiredInput(input = {}, preset = this.preset) {
    const limits = ROOM_MAP[this.roomId].camera;
    const offset = this.presetOffset(preset);
    const requested = { ...ZERO };
    for (const key of CAMERA_KEYS) {
      const n = Number(input[key] ?? 0) + Number(offset[key] ?? 0);
      requested[key] = clamp(Number.isFinite(n) ? n : 0, ...(limits[key] || [0, 0]));
    }
    return requested;
  }

  applyPose(input, factor = 1) {
    if (isOrbital(this.roomId)) return this.applyPanoPose(input);
    const config = ROOM_MAP[this.roomId];
    this.camera.position.set(input.x * factor, input.y * factor, -input.dolly * factor);
    this.camera.rotation.set(rad(input.pitch * factor), -rad(input.yaw * factor), 0, 'YXZ');
    // An unusually wide browser source gets a narrower vertical FOV to preserve the full image boundary.
    const aspectSafe = 2 * Math.atan(Math.tan(rad(config.camera.fov / 2)) * Math.min(1, (config.width / config.height) / this.camera.aspect));
    this.camera.fov = THREE.MathUtils.radToDeg(aspectSafe) - input.zoom * factor;
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld(true);
  }

  coverageSafe(margin = 0.012) {
    const room = this.room; if (!room) return false;
    if (room.pano) return true;
    const projected = room.perimeter.map(v => v.clone().project(this.camera));
    if (projected.some(v => !Number.isFinite(v.x) || !Number.isFinite(v.y) || v.z <= -1 || v.z >= 1)) return false;
    const extent = 1 + margin;
    if (![[-extent, -extent], [-extent, extent], [extent, extent], [extent, -extent]].every(([x, y]) => pointInside(x, y, projected))) return false;
    for (let i = 0; i < projected.length; i++) if (hitsRectangle(projected[i], projected[(i + 1) % projected.length], extent)) return false;
    return true;
  }

  setSafeCamera(input = {}, preset = this.preset) {
    if (!this.roomObjects.has(this.roomId)) return;
    const requested = this.desiredInput(input, preset);
    this.applyPose(requested, 1);
    if (isOrbital(this.roomId)) { this.safeFactor = 1; return; }   // 全周に絵/世界がある：クランプ不要
    if (this.coverageSafe()) { this.safeFactor = 1; return; }
    // The neutral camera is deliberately inset. Find the nearest safe point on the path from it.
    this.applyPose(requested, 0);
    if (!this.coverageSafe()) { // Conservative fallback for extreme aspect ratios / future room definitions.
      this.camera.fov *= .9; this.camera.updateProjectionMatrix(); this.safeFactor = 0; return;
    }
    let low = 0, high = 1;
    for (let i = 0; i < 11; i++) { const middle = (low + high) / 2; this.applyPose(requested, middle); if (this.coverageSafe()) low = middle; else high = middle; }
    this.safeFactor = low; this.applyPose(requested, Math.max(0, low - .002));
  }

  // 移動 A：寄り（from の approach）→ 暗転の底で部屋切替 → 引き（to の emerge）。全フレーム setSafeCamera 経由
  applyTransition(from, to, t) {
    const first = t < .5, phase = first ? t * 2 : (t - .5) * 2;
    this.setRoom(first ? from : to);
    const amount = first ? smooth(phase) : 1 - smooth(phase);
    this.transitionOpacity = first ? smooth((phase - .3) / .7) : 1 - smooth(phase / .7);
    const tr = ROOM_MAP[first ? from : to].transition || {};
    const shape = (first ? tr.approach : tr.emerge) || (first ? { x: .2, yaw: 2, dolly: .8, zoom: 1.5 } : { x: -.18, yaw: -1.8, dolly: .8, zoom: 1.5 });
    const input = { ...ZERO };
    for (const key of CAMERA_KEYS) input[key] = (shape[key] || 0) * amount;
    this.setSafeCamera(input, 'wide');
    this.applyVisibility();
  }

  update(dtRaw) {
    if (!this.ready || this.frozen) return;
    const dt = this.springs.step(dtRaw);         // >0.5s の空白は reset・物理は 1/30 で頭打ち
    this.elapsed += dt;
    if (this.transition) {
      this.transition.time += Math.min(Math.max(dtRaw, 0), .1);
      const t = Math.min(1, this.transition.time / this.transition.duration);
      this.applyTransition(this.transition.from, this.transition.to, t);
      if (t >= 1) { this.transition = null; this.transitionOpacity = 0; this.applyVisibility(); }
    } else {
      this.transitionOpacity = 0;
      this.swayW = clamp(this.swayW + Math.sign((this.swayOn ? 1 : 0) - this.swayW) * dt / 1.5, 0, 1);
      const base = this.withSway(this.effectiveInput());
      let input = base;
      if (this.move) {
        this.move.t += dt;
        input = this.moveInputAt(this.move, this.move.t);   // 非ループは終端ポーズで保持（preset/camera/stop で解除）
      } else if (this.returnBlend) {
        const rb = this.returnBlend; rb.t += dt;
        input = lerpInput(rb.from, base, easeInOut(Math.min(1, rb.t / rb.dur)));
        if (rb.t >= rb.dur) this.returnBlend = null;
      }
      this.lastInput = input;
      this.setSafeCamera(input, 'wide');
      this.applyVisibility();
    }
    if (this.vrm) {
      this.applyCharPose(this.elapsed);
      this.vrm.update(dt);
    }
  }

  render() {
    const room = this.roomObjects && this.roomObjects.get(this.roomId);
    this.renderer.render(this.scene, this.camera);
  }

  getAuditFrame({ room = this.roomId, camera = ZERO, preset = 'wide', target, progress, input, width = 1920, height = 1080 } = {}) {
    this.transition = null; this.setRoom(room);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    if (target !== undefined && progress !== undefined) this.applyTransition(resolveRoom(room), resolveRoom(target), clamp(progress, 0, 1));
    else if (input) { this.transitionOpacity = 0; this.setSafeCamera(input, 'wide'); }
    else { this.transitionOpacity = 0; this.setSafeCamera(camera, preset); }
    return this.countMagenta(width, height);
  }

  // Render only real background triangles (white) over magenta. Slides, character and the fade veil
  // are not part of this pass, so they can never hide a hole. Every pixel with G<254 counts as exposed.
  countMagenta(width = 1920, height = 1080) {
    const room = this.room; if (!room) throw new Error('Engine is not initialized');
    const target = new THREE.WebGLRenderTarget(width, height, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false });
    const previousTarget = this.renderer.getRenderTarget();
    const testScene = new THREE.Scene(); testScene.background = new THREE.Color(0xff00ff);
    const mesh = new THREE.Mesh(room.bg.geometry, this._auditMaterial); testScene.add(mesh);
    room.bg.updateWorldMatrix(true, false); mesh.matrixAutoUpdate = false; mesh.matrix.copy(room.bg.matrixWorld);   // 360 部屋の空は持ち上げ・回転つき
    const pixels = new Uint8Array(width * height * 4);
    try {
      this.renderer.setRenderTarget(target); this.renderer.render(testScene, this.camera);
      this.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    } finally {
      this.renderer.setRenderTarget(previousTarget); target.dispose();
    }
    let count = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] < 254) count++;
    return { magentaPixels: count, width, height, room: this.roomId, safeFactor: +this.safeFactor.toFixed(4), coverageSafe: this.coverageSafe() };
  }

  // VRM のワールド bbox（スキニング後の頂点）。揺れ物の露出チェック用
  avatarBox() {
    if (!this.vrm) return null;
    this.vrm.scene.updateMatrixWorld(true);
    // precise=true → SkinnedMesh.getVertexPosition（boneMatrices＝直前の描画時点の姿勢）
    const box = new THREE.Box3().setFromObject(this.vrm.scene, true);
    const size = box.getSize(new THREE.Vector3());
    const base = this.vrm.scene.position;
    // 画面上の外接矩形（1920×1080 px）：露出チェックの切り出し用
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const v = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(this.camera);
      const px = (v.x + 1) / 2 * 1920, py = (1 - v.y) / 2 * 1080;
      sx0 = Math.min(sx0, px); sx1 = Math.max(sx1, px); sy0 = Math.min(sy0, py); sy1 = Math.max(sy1, py);
    }
    return { width: +Math.max(size.x, size.z).toFixed(4), sizeX: +size.x.toFixed(4), sizeZ: +size.z.toFixed(4),
      height: +size.y.toFixed(4), top: +(box.max.y - base.y).toFixed(4),
      screen: [sx0, sy0, sx1, sy1].map(v => Math.round(v)) };
  }

  // 検収撮影専用（?shot=1&cam=close）：顔の色計測のための寄り。配信経路からは呼ばれない。
  debugCloseCamera() {
    if (!this.vrm) return;
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    const p = new THREE.Vector3(); head.getWorldPosition(p);
    this.camera.position.set(p.x, p.y + 0.02, p.z + 1.0);
    this.camera.fov = 34; this.camera.updateProjectionMatrix();
    this.camera.lookAt(p.x, p.y - 0.02, p.z); this.camera.updateMatrixWorld(true);
  }

  // ?mask=lit：背景/スライド/接地影を隠し黒背景でキャラだけ（Q8b の litchar 計測用）
  setMask(mode) {
    const show = !mode;
    for (const r of this.roomObjects.values()) { r.bg.visible = show; r.screen.visible = show && this.screenOn; for (const s of r.shadows) s.visible = show && !!this.vrm && this.avatarOn; }
    this.scene.background.set(mode ? 0x000000 : (this.debug ? 0xff00ff : BG_COLOR));
  }
}
