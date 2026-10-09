// audit_pano.js — 360 部屋（rooms.json type:"pano360"）の検査（tools/studio_pano_audit.py から呼ぶ）
//   panoView():  検査用の直接カメラ（撮影点・向き・画角を指定）で 1 枚撮る。継ぎ目・天頂・天底の確認用。配信経路からは呼ばれない
//   panoShot():  配信と同じ経路（入力空間 → setSafeCamera）で 1 枚撮る。確認用の静止画・調整用
//   feetRun():   歩行を 1/60 で決定的に回し、毎コマ VRM の最下点（スキニング後の頂点）の高さ＝床（y=0）からの浮き/めり込みを数える
import * as THREE from 'three';
import { ROOMS } from './rooms.js';
import { ZERO } from './engine.js';
import { findMove } from './moves.js';

const rad = THREE.MathUtils.degToRad;
const panoRooms = () => ROOMS.filter(r => r.type === 'pano360').map(r => r.id);

async function save(engine, name) {
  const blob = await new Promise(res => engine.canvas.toBlob(res, 'image/png'));
  const r = await fetch('/save?name=' + encodeURIComponent(name), { method: 'POST', body: blob });
  return r.json();
}

function begin(engine, room, width, height) {
  engine.frozen = true;
  engine.renderer.setSize(width, height, false);
  engine.camera.aspect = width / height; engine.camera.updateProjectionMatrix();
  engine.transition = null; engine.transitionOpacity = 0; engine.move = null; engine.returnBlend = null;
  engine.setRoom(room, { force: true });
}
function end(engine, saved) {
  engine.walk = null;
  engine.setRoom(saved, { force: true });
  engine.resize(engine.canvas.clientWidth || 1920, engine.canvas.clientHeight || 1080);
  engine.frozen = false;
}

// pos: 'center'＝撮影点 (0,h,0) / [x,y,z]。yaw 0＝絵の中央（−Z）・＋で右。pitch ＋で上
export async function panoView(engine, { room, pos = 'center', yaw = 0, pitch = 0, fov = 60, name, hideChar = true, width = 1920, height = 1080 } = {}) {
  const saved = engine.roomId;
  try {
    begin(engine, room, width, height);
    const r = engine.room;
    const p = pos === 'center' ? new THREE.Vector3(0, r.pano.height, 0) : new THREE.Vector3(...pos);
    engine.camera.position.copy(p);
    engine.camera.rotation.set(rad(pitch), -rad(yaw), 0, 'YXZ');
    engine.camera.fov = fov; engine.camera.updateProjectionMatrix(); engine.camera.updateMatrixWorld(true);
    if (engine.vrm) engine.vrm.scene.visible = !hideChar;
    for (const s of r.shadows) s.visible = !hideChar;
    engine.render();
    return { ...(await save(engine, name)), pano: r.pano };
  } finally { end(engine, saved); }
}

// 配信経路の 1 枚：input（入力空間・絶対値）＋ preset。walk:[name, 秒] でその時点の歩行姿勢
export async function panoShot(engine, { room, input = {}, preset = 'wide', name, walk = null, width = 1920, height = 1080, settle = 150 } = {}) {
  const saved = engine.roomId;
  try {
    begin(engine, room, width, height);
    engine.preset = preset;
    const walker = engine.walkers.get(room);
    let t = 0;
    if (walk && walker) {
      const def = findMove(walk[0]);
      engine.walk = { name: walk[0], act: walker.build(walk[0], def.steps, 'a'), t0: 0 };
      t = walk[1];
    }
    engine.springs.settle(settle, Math.max(0, t - settle / 60));
    if (engine.vrm) { engine.applyCharPose(t); engine.vrm.update(0); }
    engine.setSafeCamera(engine.desiredInput({ ...ZERO, ...input }, preset), 'wide');
    if (engine.vrm) engine.applyCharPose(t);                   // カメラ目線（idle）を最終カメラで
    engine.applyVisibility(); engine.render();
    const cam = { pos: engine.camera.position.toArray().map(v => +v.toFixed(3)), fov: +engine.camera.fov.toFixed(2) };
    return { ...(await save(engine, name)), cam };
  } finally { end(engine, saved); }
}

// 足元の頂点（静止時に最下点から 12cm 以内＝靴）だけを一度選び、毎コマその頂点のスキニング後の最下点を出す（全頂点は遅い）
function footProbe(engine) {
  const v = new THREE.Vector3(), list = [];
  engine.vrm.scene.updateMatrixWorld(true);
  let lo = Infinity;
  const meshes = [];
  engine.vrm.scene.traverse(o => { if ((o.isSkinnedMesh || o.isMesh) && o.geometry && o.geometry.attributes.position) meshes.push(o); });
  for (const m of meshes) { const n = m.geometry.attributes.position.count; for (let i = 0; i < n; i++) { m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld); lo = Math.min(lo, v.y); } }
  for (const m of meshes) {
    const idx = [], n = m.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) { m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld); if (v.y < lo + 0.12) idx.push(i); }
    if (idx.length) list.push([m, idx]);
  }
  return {
    count: list.reduce((n, [, idx]) => n + idx.length, 0),
    lowest() {
      let y = Infinity;
      for (const [m, idx] of list) for (const i of idx) { m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld); if (v.y < y) y = v.y; }
      return y;
    },
  };
}

// 足と床：歩行 3 本 × 360 部屋。最下点 y（m）を毎コマ。合格＝歩いている間ずっと |y| ≤ 0.02
export async function feetRun(engine, { fps = 60, rooms = null, tol = 0.02 } = {}) {
  const saved = engine.roomId, results = [];
  let probe = null;
  engine.frozen = true;
  try {
    for (const room of rooms || panoRooms()) {
      engine.setRoom(room, { force: true });
      const walker = engine.walkers.get(room);
      if (!walker) continue;
      for (const [name, from] of [['guide_slide', 'a'], ['goto_a', 'b'], ['look_up', 'a']]) {
        const def = findMove(name); if (!def || !walker.spots[from]) continue;
        engine.walk = null; walker.teleport(from);
        engine.springs.settle(60, 0);
        engine.vrm.scene.updateMatrixWorld(true);
        engine.render();                                       // boneMatrices を今の姿勢に
        probe = probe || footProbe(engine);
        const rest = probe.lowest();
        const act = walker.build(name, def.steps, from);
        engine.walk = { name, act, t0: 0 };
        const per = { walk: [], other: [] };
        const n = Math.round(act.dur * fps) + 1;
        for (let i = 0; i < n; i++) {
          engine.applyCharPose(i / fps); engine.vrm.update(1 / fps); engine.vrm.scene.updateMatrixWorld(true);
          const k = engine.walkState ? engine.walkState.k : 'end';
          engine.vrm.scene.traverse(o => { if (o.isSkinnedMesh) o.skeleton.update(); });
          const y = probe.lowest();
          (k === 'walk' ? per.walk : per.other).push(y);
          if (!engine.walk) break;
        }
        engine.walk = null; walker.teleport('a');
        const st = a => a.length ? { frames: a.length, min: +Math.min(...a).toFixed(4), max: +Math.max(...a).toFixed(4),
          maxAbs: +Math.max(...a.map(Math.abs)).toFixed(4), over: a.filter(v => Math.abs(v) > tol).length } : null;
        results.push({ room, name, from, probeVerts: probe.count, restLowest: +rest.toFixed(4), walk: st(per.walk), other: st(per.other) });
      }
    }
  } finally { end(engine, saved); }
  const all = results.flatMap(r => [r.walk, r.other].filter(Boolean));
  return { tol, results, pass: all.every(s => s.over === 0) && results.every(r => Math.abs(r.restLowest) <= tol) };
}
