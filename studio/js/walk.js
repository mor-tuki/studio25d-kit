// walk.js — 手続き的な歩行（VRM の正規化ボーンを直接動かす）
//   ・立ち位置 spots（a=いつもの位置 ほか）は rooms.json actor.spots の絵座標 → engine の unproject で渡す
//   ・歩行は脚・膝・腕・腰の手続き揺れ。位相は移動距離に比例（足滑り防止）。脚長は VRM から実測する
//   ・動作は moves.json の kind:"walk" の steps（データ駆動）から組む：
//       ["walk","b"] スポットへ歩く／["face","slide"|"moon",上限rad] 対象へ向く／["gest","point"|"lookup",秒]
//       ["turn","front"|"<spot>"] 向き直る／["hold",秒]
//   ・時間は engine が持つ（evalAt(act,t) は決定的）。engine.applyCharPose(t) からだけ呼ぶ
import * as THREE from 'three';

const TURN_RATE = 2.4;      // rad/s（ゆるい転身）
const WALK_V = 0.42;        // m/s（0.5 だと歩き出しでスカートの付け根が水平より上へ跳ねた・実測）
const STRIDE = 0.52;        // m / 歩行周期（2歩）
const KNEE = 0.55;          // 膝の最大屈曲（swing中）
const ARM_SWING = 0.16;     // 腕の振り
const BOB = 0.022;          // （未使用・旧の上下動。いまは接地脚の角度から幾何で出す＝apply 内）
// 脚の振りの向き。この VRM（rotateVRM0 後・rotation.y=π＋yaw）では rotation.x の＋が前振り。元の walk.js の符号のままだと
// 接地脚が前へ動いて床を滑る（実測：接地足の移動 ÷ 体の移動 ≈ 1.9）。−1 で接地中に後ろへ送る＝滑らない
const LEG_DIR = 1;          // ＋＝前振り（この VRM で実測）
const RAMP_M = 0.12;          // 膝・腕・揺れだけを歩き出し/止まりでなじませる距離
// 太腿の角度（＋＝前）。u＝周期内の位置 0..1。前半＝接地：+A→−A を直線で（足首の床上速度＝体の速度で一定＝滑らない）。
// 後半＝振り出し：−A→+A を cos で滑らかに、膝を sin で曲げて足を上げる。
const thigh = (u, A) => u < 0.5 ? A * (1 - 4 * u) : -A * Math.cos(Math.PI * (u - 0.5) * 2);
const kneeOf = u => u < 0.5 ? 0 : Math.sin(Math.PI * (u - 0.5) * 2);
export const EASE = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const shortest = d => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const yawToward = d => Math.atan2(-d.x, -d.z);   // モデル正面 = (-sinθ,0,-cosθ)（実測）
const LEG_BONES = ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'];

export function createWalk(vrm, opts) {
  const bone = n => { try { return vrm.humanoid.getNormalizedBoneNode(n); } catch (e) { return null; } };
  const BN = {};
  for (const n of ['hips', 'spine', 'chest', 'neck', 'head', ...LEG_BONES,
    'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'])
    BN[n] = bone(n);
  const rest = {};
  for (const n in BN) if (BN[n]) rest[n] = { e: BN[n].rotation.clone(), py: BN[n].position.y };

  // 脚長（股関節→足首）を実測（スケール済みワールド m）。振り幅＝接地脚の後退速度が移動速度に一致する量
  vrm.scene.updateMatrixWorld(true);
  const raw = n => vrm.humanoid.getRawBoneNode(n);
  const pa = new THREE.Vector3(), pb = new THREE.Vector3();
  let legL = 0.78;
  if (raw('leftUpperLeg') && raw('leftFoot')) {
    raw('leftUpperLeg').getWorldPosition(pa); raw('leftFoot').getWorldPosition(pb);
    const d = pa.distanceTo(pb); if (d > 0.3 && d < 1.2) legL = d;
  }
  const SWING = STRIDE / (4 * legL);

  const spots = opts.spots;                 // {a:{pos:V3,yaw}, b:..., c:...}
  const FRONT = opts.frontYaw;              // 正面（カメラ向き）の rotation.y
  const TARGETS = { slide: opts.slidePos, moon: opts.moonPos, lookup: opts.moonPos };   // lookup = moon（見上げる目印）
  const gaze = opts.gaze || null;           // idleMotion の gaze Object3D（null可）
  const shadows = opts.shadows || [];       // GroundShadow / BlobShadow
  const shadowOfs = shadows.map(s => s.position.clone().sub(spots.a.pos));

  // ---- タイムライン構築（steps はデータ） ----
  function build(name, steps, fromKey = 'a') {
    const segs = []; let tt = 0;
    const from = spots[fromKey] ? fromKey : 'a';
    let pos = spots[from].pos.clone(), yaw = spots[from].yaw, at = from;
    const seg = s => { s.t0 = tt; tt += s.dur; s.t1 = tt; segs.push(s); };
    const turn = targetYaw => {
      const d = shortest(targetYaw - yaw);
      seg({ k: 'turn', dur: Math.max(0.45, Math.abs(d) / TURN_RATE), y0: yaw, y1: yaw + d, pos: pos.clone() });
      yaw += d;
    };
    const walkTo = key => {
      const dst = spots[key] && spots[key].pos; if (!dst) return;
      const dir = dst.clone().sub(pos); dir.y = 0;
      const dist = dir.length(); if (dist < 0.05) { at = key; return; }
      dir.normalize();
      turn(yawToward(dir));
      // 半歩の整数倍で歩き切るよう歩幅を合わせる（始まり/終わりで両脚の太腿が 0＝静止姿勢と同じになる）
      const halves = Math.max(1, Math.round(2 * dist / STRIDE)), stride = 2 * dist / halves;
      seg({ k: 'walk', dur: dist / WALK_V, from: pos.clone(), to: dst.clone(), dist, stride });
      pos.copy(dst); at = key;
    };
    const face = (target, maxTurn) => {
      if (!target) return;
      const d = target.clone().sub(pos); d.y = 0; d.normalize();
      let ty = yawToward(d), dd = shortest(ty - yaw);
      if (maxTurn && Math.abs(dd) > maxTurn) ty = yaw + Math.sign(dd) * maxTurn;
      turn(ty);
    };
    for (const [op, arg, arg2] of steps || []) {
      if (op === 'walk') walkTo(arg);
      else if (op === 'face') face(TARGETS[arg], arg2);
      else if (op === 'gest') seg({ k: 'gest', g: arg, dur: +arg2 || 3, pos: pos.clone(), yaw, target: arg === 'point' ? 'slide' : 'moon' });
      else if (op === 'turn') turn(arg === 'front' ? FRONT : (spots[arg] ? spots[arg].yaw : FRONT));
      else if (op === 'hold') seg({ k: 'hold', dur: +arg || 0.6, pos: pos.clone(), yaw });
    }
    return { name, segs, dur: tt, from, end: at, endPos: pos.clone(), endYaw: yaw };
  }

  // ---- タイムライン評価（決定的） ----
  const _dir = new THREE.Vector3();
  function evalAt(act, t) {
    const s = act.segs;
    if (!s.length) return { k: 'hold', pos: act.endPos.clone(), yaw: act.endYaw, gait: 0, phase: 0, g: null, gw: 0, done: true };
    if (t <= 0) t = 0;
    let cur = s[s.length - 1];
    for (const sg of s) if (t < sg.t1) { cur = sg; break; }
    const done = t >= act.dur;
    const u = Math.min(1, Math.max(0, (t - cur.t0) / cur.dur));
    if (cur.k === 'walk') {
      const k = EASE(u);
      const p = cur.from.clone().lerp(cur.to, k);
      const dirv = _dir.copy(cur.to).sub(cur.from).setY(0).normalize();
      const dist = cur.dist * k, edge = Math.min(1, dist / RAMP_M, (cur.dist - dist) / RAMP_M);
      const ramp = edge * edge * (3 - 2 * edge);          // 膝・腕の振り幅を 0↔1（静止姿勢から跳ねない）
      // 位相は距離に比例し、左脚の接地のまん中（u=0.25・太腿 0）から始める
      return { k: 'walk', pos: p, yaw: yawToward(dirv), gait: done ? 0 : 1, ramp: done ? 0 : ramp, phase: 2 * Math.PI * (0.25 + dist / cur.stride), swing: cur.stride / (4 * legL), g: null, gw: 0, seg: cur, u, done };
    }
    if (cur.k === 'turn') return { k: 'turn', pos: cur.pos.clone(), yaw: cur.y0 + (cur.y1 - cur.y0) * EASE(u), gait: 0, phase: 0, g: null, gw: 0, seg: cur, u, done };
    if (cur.k === 'gest') {
      const w = Math.min(1, u / 0.22, (1 - u) / 0.18);   // フェードイン/アウト
      return { k: 'gest', pos: cur.pos.clone(), yaw: cur.yaw, gait: 0, phase: 0, g: cur.g, gw: done ? 0 : EASE(Math.max(0, w)), target: cur.target, seg: cur, u, done };
    }
    return { k: 'hold', pos: cur.pos.clone(), yaw: cur.yaw, gait: 0, phase: 0, g: null, gw: 0, seg: cur, u, done };
  }

  // ---- 骨への適用 ----
  const set = (n, dx, dy, dz, w) => {
    const b = BN[n]; if (!b || !rest[n]) return;
    b.rotation.set(rest[n].e.x + dx * w, rest[n].e.y + dy * w, rest[n].e.z + dz * w);
  };
  // idle が毎フレーム書く骨（head・spine）は idle の値に足す（rest 基準で上書きすると歩き出し/ジェスチャ終わりに首がはねる）
  const add = (n, dx, dy, dz, w) => {
    const b = BN[n]; if (!b) return;
    b.rotation.x += dx * w; b.rotation.y += dy * w; b.rotation.z += dz * w;
  };
  function place(pos, yaw) {
    vrm.scene.position.set(pos.x, pos.y, pos.z);
    vrm.scene.rotation.y = yaw;
    shadows.forEach((sh, i) => sh.position.copy(pos).add(shadowOfs[i]));   // 接地影はキャラに付いてくる（床の高さも）
  }
  function apply(st) {
    place(st.pos, st.yaw);
    let bobY = 0;
    if (st.gait > 0) {                                   // 歩行サイクル
      const p = st.phase, sL = Math.sin(p), w = st.ramp ?? 1;
      const uL = ((p / (2 * Math.PI)) % 1 + 1) % 1, uR = (uL + 0.5) % 1;
      const A = st.swing || SWING;
      const thL = thigh(uL, A), thR = thigh(uR, A);   // 太腿は位相だけで決まる（ramp を掛けると接地足が前へ滑る）
      set('leftUpperLeg', LEG_DIR * thL, 0, 0, 1);
      set('rightUpperLeg', LEG_DIR * thR, 0, 0, 1);
      set('leftLowerLeg', -KNEE * kneeOf(uL) * w, 0, 0, 1);
      set('rightLowerLeg', -KNEE * kneeOf(uR) * w, 0, 0, 1);
      const hipL = BN.leftUpperLeg ? BN.leftUpperLeg.rotation.x - rest.leftUpperLeg.e.x : 0;
      const hipR = BN.rightUpperLeg ? BN.rightUpperLeg.rotation.x - rest.rightUpperLeg.e.x : 0;
      const knL = BN.leftLowerLeg ? BN.leftLowerLeg.rotation.x - rest.leftLowerLeg.e.x : 0;
      const knR = BN.rightLowerLeg ? BN.rightLowerLeg.rotation.x - rest.rightLowerLeg.e.x : 0;
      set('leftFoot', -(hipL + knL) * 0.75, 0, 0, 1);     // 足はほぼ水平に保つ（脛の合成角を相殺）
      set('rightFoot', -(hipR + knR) * 0.75, 0, 0, 1);
      set('leftUpperArm', -ARM_SWING * (thR / A) * w, 0, 0, 1);   // 腕は反対の脚と同じ向きへ（逆位相）
      set('rightUpperArm', -ARM_SWING * (thL / A) * w, 0, 0, 1);
      add('spine', 0, 0.045 * sL * w, 0, 1);
      set('hips', 0, 0.03 * sL * w, 0.02 * sL * w, 1);
      // 上下動は接地脚の角度から幾何で出す：腰は legL·(1−cosθ) だけ下がる＝接地足が床の高さに留まる。
      // （旧：−BOB·(0.5−0.5cos2p) は位相 u=0.25＝脚がまっすぐの瞬間に最も沈み、接地足が床へ 2.6cm めり込んだ・実測）
      const thS = uL < 0.5 ? thL : thR;
      bobY = -legL * (1 - Math.cos(thS)) / (vrm.scene.scale.y || 1);
    }
    if (BN.hips) BN.hips.position.y += bobY;             // idle が毎フレーム restY＋呼吸を書くので加算でよい
    if (st.gait <= 0) restoreLegs();
    if (st.gait <= 0 && !(st.gw > 0)) restoreUpper();
    if (st.gw > 0) applyGesture(st.g, st.gw, st.target);
  }
  function restoreLegs() {
    for (const n of LEG_BONES) { const b = BN[n]; if (b && rest[n]) b.rotation.copy(rest[n].e); }
    if (BN.hips && rest.hips) BN.hips.rotation.copy(rest.hips.e);
  }
  function applyGesture(g, w, target) {
    if (g === 'point') {                                 // 右腕で資料を示す（伸ばしきらない）
      set('rightUpperArm', 1.05, -0.35, -0.25, w);
      set('rightLowerArm', 0, 0.35, 0, w);
      set('leftUpperArm', 0.12, 0, 0, w);
      add('spine', 0, 0.10, 0, w);
      add('head', 0.05, 0.18, 0, w);
      if (gaze && TARGETS.slide) gaze.position.copy(TARGETS.slide).add(new THREE.Vector3(0, 0.1, 0));
    } else if (g === 'lookup') {                         // 月を見上げる（首＋目線・少し胸）
      add('head', 0.55, 0.45, 0, w);
      set('neck', 0.28, 0.15, 0, w);
      set('chest', 0.10, 0, 0, w);
      set('rightUpperArm', -0.15, 0, 0, w);
      set('leftUpperArm', -0.15, 0, 0, w);
      if (gaze && TARGETS.moon) gaze.position.copy(TARGETS.moon);
    }
  }
  // 腕・首などジェスチャで触った骨を rest に戻す（idle は head/spine を毎フレーム上書きするので腕だけでよい）
  function restoreUpper() {
    for (const n of ['leftUpperArm', 'rightUpperArm', 'rightLowerArm', 'leftLowerArm', 'neck', 'chest']) {
      const b = BN[n]; if (b && rest[n]) b.rotation.copy(rest[n].e);
    }
  }
  function teleport(key) {                               // 部屋に入った時・検査の後：指定スポットへ
    const s = spots[key] || spots.a; place(s.pos, s.yaw); restoreLegs(); restoreUpper();
  }
  return { build, evalAt, apply, place, teleport, restoreLegs, restoreUpper, spots, targets: TARGETS, legLength: legL, swing: SWING };
}
