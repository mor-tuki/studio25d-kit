// moves.js — moves.json の評価
//   moves.json は配列。kind:"move"（既定）＝カメラムーブ、kind:"walk"＝歩行。
//   カメラムーブのキーフレームは入力空間 {yaw,pitch,x,y,dolly,zoom}（絶対値・preset 'wide' 基準）。
//     "cam": {...}            その値（書いていない軸は 0）
//     "cam": "@presenter"     その部屋の rooms.json camera.presets の値（部屋ごとに意味を保つ）
//     "cam": "@base"          ムーブ開始時のカメラ（その時の preset＋手動調整）
//   "rooms": {"<id>": false}  その部屋では無効 ／ {"<id>": {"keys":[...]}} 部屋ごとの差し替え
//   "wave": 呼吸型（ループ）。{axis: [[振幅, 周期秒, 位相rad], ...]} を開始時のカメラに足す（可動域の内側へ寄せてから）
//   キー間は easeInOut（3 次）。"ease":"sine" で穏やかな正弦（一周ムーブ用）。評価結果は必ず engine.setSafeCamera を通る（ここでは丸めない）。
import { ROOM_MAP } from './rooms.js';

export const AXES = ['yaw', 'pitch', 'x', 'y', 'dolly', 'zoom'];
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
let MOVES = [];

export async function loadMoves(url = 'moves.json') {
  try { const m = await fetch(url, { cache: 'no-store' }).then(r => r.json()); MOVES = Array.isArray(m) ? m : []; }
  catch { MOVES = []; }
  return MOVES;
}
export const allMoves = () => MOVES;
export const cameraMoves = () => MOVES.filter(m => (m.kind || 'move') === 'move');
export const walkDefs = () => MOVES.filter(m => m.kind === 'walk');
export const findMove = name => MOVES.find(m => m.name === name) || null;

//   "roomTypes": ["pano360"]  その種類の部屋だけで有効（rooms.json の type。書いていない部屋は "2.5d"）
export const roomType = roomId => (ROOM_MAP[roomId] || {}).type || '2.5d';
export function moveEnabled(def, roomId) {
  if (!def) return false;
  if (Array.isArray(def.roomTypes) && !def.roomTypes.includes(roomType(roomId))) return false;
  const o = def.rooms && def.rooms[roomId];
  return o !== false;
}

function keysFor(def, roomId) {
  const o = def.rooms && def.rooms[roomId];
  return (o && Array.isArray(o.keys)) ? o.keys : (def.keys || []);
}

export function moveDuration(def, roomId) {
  if (def.wave) return def.dur || 12;
  const ks = keysFor(def, roomId);
  return ks.length ? Math.max(def.dur || 0, ks[ks.length - 1].t) : (def.dur || 0);
}

function resolveCam(cam, roomId, base) {
  const out = {};
  let src = cam;
  if (typeof cam === 'string') {
    if (cam === '@base') src = base || {};
    else if (cam.startsWith('@')) src = ((ROOM_MAP[roomId] || {}).camera?.presets || {})[cam.slice(1)] || {};
    else src = {};
  }
  for (const a of AXES) out[a] = Number((src || {})[a] ?? 0) || 0;
  return out;
}

// 呼吸型：開始時カメラを「振幅ぶん可動域の内側」へ寄せてから波を足す（端で波が潰れて折れ線にならない）
function waveBase(def, roomId, base) {
  const lim = (ROOM_MAP[roomId] || {}).camera || {};
  const b = resolveCam(base || {}, roomId);
  for (const a of AXES) {
    const amp = (def.wave[a] || []).reduce((s, [A]) => s + Math.abs(A), 0);
    const off = def.waveOffset?.[a] || 0;
    if (!lim[a]) continue;
    const lo = lim[a][0] + amp - off, hi = lim[a][1] - amp - off;
    b[a] = lo <= hi ? Math.min(hi, Math.max(lo, b[a])) : (lim[a][0] + lim[a][1]) / 2 - off;
  }
  return b;
}

// t 秒時点の入力（絶対値）。base＝開始時のカメラ（preset 込みの絶対値）
export function evalMove(def, roomId, t, base) {
  if (def.wave) {
    const b = waveBase(def, roomId, base), out = { ...b };
    for (const a of AXES) {
      out[a] += def.waveOffset?.[a] || 0;
      for (const [A, P, ph] of def.wave[a] || []) out[a] += A * Math.sin(t * 2 * Math.PI / P + (ph || 0));
    }
    return out;
  }
  const ks = keysFor(def, roomId);
  if (!ks.length) return resolveCam(base || {}, roomId);
  if (t <= ks[0].t) return resolveCam(ks[0].cam, roomId, base);
  const last = ks[ks.length - 1];
  if (t >= last.t) return resolveCam(last.cam, roomId, base);
  let i = 0;
  while (i < ks.length - 2 && ks[i + 1].t <= t) i++;
  const a = resolveCam(ks[i].cam, roomId, base), b = resolveCam(ks[i + 1].cam, roomId, base);
  const u = Math.min(1, (t - ks[i].t) / (ks[i + 1].t - ks[i].t));
  const k = def.ease === 'sine' ? 0.5 - 0.5 * Math.cos(Math.PI * u) : easeInOut(u);   // sine＝最大速度が平均の 1.57 倍（cubic は 3 倍）
  const out = {};
  for (const ax of AXES) out[ax] = a[ax] + (b[ax] - a[ax]) * k;
  return out;
}

// 方向転換の時刻（揺れ物チェック用）：内側のキー時刻（ループは開始のみ）
export function turnTimes(def, roomId) {
  if (def.wave) return [];
  const ks = keysFor(def, roomId);
  return ks.slice(1, -1).map(k => k.t);
}

export function lerpInput(a, b, k) {
  const out = {};
  for (const ax of AXES) out[ax] = (a[ax] || 0) + ((b[ax] || 0) - (a[ax] || 0)) * k;
  return out;
}
export { easeInOut };
