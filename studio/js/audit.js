// audit.js — 在ページ検査
//   auditAll():  絵の外（マゼンタ）0px 検査。対象は rooms.json から生成（データ駆動）
//                各部屋 × プリセット3 × カメラ6軸の上下限 2^6=64 通り＋中央1 ＝ 195/部屋
//                各 neighbours ペア両方向 × 移動 A の全フレーム t=i/(60·transitionSeconds)
//                → 結果を POST /api/audit（output/reports/coverage-*.json）
//   safetyRun(): 揺れ物の露出チェック。各ケース直後 0〜2.0 秒を 0.25 秒おき 9 コマ → /save_frame（PNG 1920×1080）
//                同時に VRM ワールド bbox（スキニング後）を記録 → POST /api/audit（safety-*.json）
//                ＋ moves.json 駆動：全カメラムーブ × 全部屋（ループ/@base はプリセット3）、全歩行 × 全部屋 × プリセット3 を
//                  1/30 秒刻みで同じ countMagenta にかける（期待件数は定義から別に数えて照合）
//   （ムーブ・歩行の揺れ物チェック・足の滑り・リール録画は audit_motion.js）
//   takeShot():  静止画（?shot=1&name=&room=&preset=&mask=lit&cam=close）
import * as THREE from 'three';
import { ROOMS, ROOM_MAP } from './rooms.js';
import { ZERO, CAMERA_KEYS } from './engine.js';
import { cameraMoves, walkDefs, moveEnabled, moveDuration, findMove } from './moves.js';

const PRESETS = ['wide', 'presenter', 'screen'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

export function directedPairs() {
  const pairs = [];
  for (const room of ROOMS) for (const n of room.neighbours) pairs.push([room.id, n]);
  return pairs;
}

// ムーブ・歩行の検査対象（定義から組む）。frames は 1/30 秒刻みの枚数（端点込み）
export function motionPlan(engine, mfps = 30) {
  const jobs = [];
  for (const room of ROOMS) {
    for (const def of cameraMoves()) {
      if (!moveEnabled(def, room.id)) continue;
      const usesBase = !!def.wave || JSON.stringify(def.keys || []).includes('@base');
      for (const preset of usesBase ? PRESETS : ['wide']) {
        const dur = moveDuration(def, room.id);
        jobs.push({ kind: 'move', room: room.id, name: def.name, preset, dur, frames: Math.round(dur * mfps) + 1 });
      }
    }
    const walker = engine.walkers.get(room.id);
    if (!walker) continue;
    for (const def of walkDefs()) {
      for (const from of def.auditFrom || ['a']) {
        if (!walker.spots[from]) continue;
        const act = walker.build(def.name, def.steps, from);
        for (const preset of PRESETS)
          jobs.push({ kind: 'walk', room: room.id, name: def.name, from, preset, dur: act.dur, frames: Math.round(act.dur * mfps) + 1 });
      }
    }
    // 待機ゆらぎ（既定 ON）：y の周期 27 秒を 1 周
    if (room.camera.sway) for (const preset of PRESETS) {
      const dur = Math.max(room.camera.sway.periodX || 19, room.camera.sway.periodY || 27);
      jobs.push({ kind: 'sway', room: room.id, name: 'idle_sway', preset, dur, frames: Math.round(dur * mfps) + 1 });
    }
  }
  return jobs;
}

export function expectedCounts(transitionSeconds, fps = 60, plan = []) {
  const frames = Math.round(fps * transitionSeconds) + 1;
  const corner = ROOMS.length * PRESETS.length * 64, center = ROOMS.length * PRESETS.length;
  const transition = directedPairs().length * frames;
  const move = plan.filter(j => j.kind === 'move').reduce((n, j) => n + j.frames, 0);
  const walk = plan.filter(j => j.kind === 'walk').reduce((n, j) => n + j.frames, 0);
  const sway = plan.filter(j => j.kind === 'sway').reduce((n, j) => n + j.frames, 0);
  return { corner, center, transition, framesPerTransition: frames, move, walk, sway, motionJobs: plan.length,
    total: corner + center + transition + move + walk + sway };
}

// カメラの 1 コマあたりの変化（角度°・位置 m・画角°）：クランプで「カクッ」となっていないかを数で見る
function cameraStep(engine, prev) {
  const c = engine.camera;
  const cur = { p: c.position.clone(), q: c.quaternion.clone(), f: c.fov };
  if (!prev) return [cur, null];
  return [cur, { ang: THREE.MathUtils.radToDeg(prev.q.angleTo(cur.q)), pos: prev.p.distanceTo(cur.p), fov: Math.abs(prev.f - cur.f) }];
}

export async function auditAll(engine, { fps = 60, width = 1920, height = 1080, post = true } = {}) {
  const started = performance.now();
  const saved = { room: engine.roomId, preset: engine.preset, input: { ...engine.cameraInput } };
  const T = engine.transitionSeconds, mfps = 30;
  const plan = motionPlan(engine, mfps);
  const expected = expectedCounts(T, fps, plan);
  const motionStats = {};
  const samples = [];
  engine.frozen = true;
  try {
    let n = 0;
    const tick = async () => { if (++n % 24 === 0) await sleep(0); };
    for (const room of ROOMS) {
      const limits = room.camera;
      for (const preset of PRESETS) {
        for (let mask = 0; mask < 64; mask++) {
          const camera = {};
          CAMERA_KEYS.forEach((key, bit) => { camera[key] = limits[key][(mask >> bit) & 1]; });
          const r = engine.getAuditFrame({ room: room.id, preset, camera, width, height });
          samples.push({ kind: 'corner', room: room.id, preset, camera, magentaPixels: r.magentaPixels, safeFactor: r.safeFactor });
          await tick();
        }
        const camera = {};
        for (const key of CAMERA_KEYS) camera[key] = (limits[key][0] + limits[key][1]) / 2;
        const r = engine.getAuditFrame({ room: room.id, preset, camera, width, height });
        samples.push({ kind: 'center', room: room.id, preset, camera, magentaPixels: r.magentaPixels, safeFactor: r.safeFactor });
      }
    }
    for (const [from, to] of directedPairs()) {
      for (let i = 0; i < expected.framesPerTransition; i++) {
        const t = Math.min(1, i / (fps * T));
        const r = engine.getAuditFrame({ room: from, target: to, progress: t, width, height });
        samples.push({ kind: 'transition', room: from, target: to, fade: 'dark', frame: i, progress: +t.toFixed(5),
          renderedRoom: r.room, magentaPixels: r.magentaPixels, safeFactor: r.safeFactor });
        await tick();
      }
    }
    // ムーブ・歩行：1/30 秒刻み。カメラ入力はページの再生経路と同じ関数（moveInputAt / effectiveInput＋walkFollow）で作る
    for (const job of plan) {
      engine.setRoom(job.room);
      engine.preset = job.preset; engine.cameraInput = { ...ZERO };
      const walker = engine.walkers.get(job.room);
      walker && walker.teleport('a');
      const key = `${job.room}|${job.kind}:${job.name}${job.from && job.from !== 'a' ? '<' + job.from : ''}|${job.preset}`;
      const st = motionStats[key] = { count: 0, maxPx: 0, minSafe: 1, unsafeFrames: 0, maxStepDeg: 0, maxStepPos: 0, maxStepFov: 0, dur: +job.dur.toFixed(3) };
      let move = null, act = null, prev = null;
      if (job.kind === 'move') {
        const base = engine.effectiveInput(ZERO, job.preset, ZERO);
        move = { def: findMove(job.name), base, from: base, blend: 1.0, dur: job.dur };
      } else if (job.kind === 'walk') act = walker.build(job.name, findMove(job.name).steps, job.from);
      for (let i = 0; i < job.frames; i++) {
        const t = i / mfps;
        let input;
        if (move) input = engine.moveInputAt(move, t, job.room);
        else if (job.kind === 'sway') input = engine.withSway(engine.effectiveInput(ZERO, job.preset, ZERO), t, job.preset, 1, job.room);
        else {   // 歩行は配信と同じく待機ゆらぎ込み
          const ws = walker.evalAt(act, t); walker.apply(ws);
          input = engine.withSway(engine.effectiveInput(ZERO, job.preset, engine.walkFollow(engine.vrm.scene.position, ws, job.room)), t, job.preset, 1, job.room);
        }
        const r = engine.getAuditFrame({ room: job.room, input, width, height });
        let step; [prev, step] = cameraStep(engine, prev);
        samples.push({ kind: job.kind, room: job.room, name: job.name, from: job.from, preset: job.preset, frame: i, t: +t.toFixed(4),
          magentaPixels: r.magentaPixels, safeFactor: r.safeFactor });
        st.count++; st.maxPx = Math.max(st.maxPx, r.magentaPixels); st.minSafe = Math.min(st.minSafe, r.safeFactor);
        if (r.safeFactor < 1) st.unsafeFrames++;
        if (step) { st.maxStepDeg = Math.max(st.maxStepDeg, +step.ang.toFixed(4)); st.maxStepPos = Math.max(st.maxStepPos, +step.pos.toFixed(4)); st.maxStepFov = Math.max(st.maxStepFov, +step.fov.toFixed(4)); }
        await tick();
      }
      walker && walker.teleport('a');
    }
    // 陰性対照：クランプを通さず yaw を可動域の外（+12°）へ振った絵では必ず露出が数えられること＝検出器が生きている証明
    engine.setRoom(ROOMS[0].id);
    engine.camera.aspect = width / height;
    engine.applyPose({ ...ZERO, yaw: 12 }, 1);
    var negativeControl = engine.countMagenta(width, height).magentaPixels;
  } finally {
    engine.transition = null; engine.transitionOpacity = 0;
    engine.setRoom(saved.room, { force: true }); engine.preset = saved.preset; engine.cameraInput = saved.input;
    engine.resize(engine.canvas.clientWidth || width, engine.canvas.clientHeight || height);
    engine.frozen = false;
  }
  const by = kind => samples.filter(s => s.kind === kind).length;
  const failed = samples.filter(s => s.magentaPixels !== 0);
  const table = {};
  for (const s of samples) {
    const k = s.name ? `${s.room}|${s.kind}` : `${s.room}${s.target ? '->' + s.target : ''}|${s.kind}`;
    const e = table[k] || (table[k] = { count: 0, maxPx: 0, failed: 0, minSafeFactor: 1 });
    e.count++; e.maxPx = Math.max(e.maxPx, s.magentaPixels); if (s.magentaPixels) e.failed++;
    e.minSafeFactor = Math.min(e.minSafeFactor, s.safeFactor);
  }
  const counts = { corner: by('corner'), center: by('center'), transition: by('transition'), move: by('move'), walk: by('walk'), sway: by('sway') };
  const exhaustive = counts.corner === expected.corner && counts.center === expected.center &&
    counts.transition === expected.transition && counts.move === expected.move && counts.walk === expected.walk && counts.sway === expected.sway &&
    samples.length === expected.total;
  const report = {
    kind: 'coverage', createdAt: new Date().toISOString(), viewport: { width, height }, fps, transitionSeconds: T,
    rooms: ROOMS.map(r => r.id), pairs: directedPairs(), judge: 'G<254 = exposed (white-only background pass over magenta)',
    expected, counts, table, motion: motionStats, motionFps: mfps,
    negativeControl: { camera: 'yaw +12deg without clamp', magentaPixels: negativeControl, alive: negativeControl > 0 },
    summary: { count: samples.length, max: Math.max(0, ...samples.map(s => s.magentaPixels)), failed: failed.length,
      exhaustive, passed: exhaustive && failed.length === 0, elapsedMs: Math.round(performance.now() - started) },
    samples,
  };
  if (post) {
    try {
      const r = await fetch('/api/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
      report.path = (await r.json()).path;
    } catch (e) { report.postError = String(e); }
  }
  return { summary: report.summary, expected, counts, table, motion: motionStats, path: report.path, negativeControl: report.negativeControl, firstFailures: failed.slice(0, 10) };
}

async function postFrame(blob, dir, seq) {
  for (let r = 0; r < 4; r++) {
    try {
      const res = await fetch(`/save_frame?dir=${encodeURIComponent(dir)}&seq=${String(seq).padStart(4, '0')}`, { method: 'POST', body: blob });
      if (res.ok) return true;
    } catch { await sleep(300); }
  }
  return false;
}

async function command(body) {
  const r = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

// 揺れ物の露出チェック：部屋 N つ × 9 ケース（カット3＋移動1＋visibilitychange3＋停止→再開2）
export async function safetyRun(engine, app, { frames = 9, intervalMs = 250 } = {}) {
  const started = performance.now();
  const cases = [], baseline = {}, uploads = [];
  const waitIdle = async () => { while (engine.transition) await sleep(50); await sleep(150); };
  const capture = async (room, name) => {
    const dir = `safety_${room}_${name}`;
    const t0 = performance.now();
    const rows = [];
    for (let s = 0; s < frames; s++) {
      const due = t0 + s * intervalMs;
      while (performance.now() < due) await sleep(Math.min(20, due - performance.now()));
      await nextFrame();                                   // 直近の tick（reset/cut 適用後）を跨ぐ
      const box = engine.avatarBox();
      const at = Math.round(performance.now() - t0);
      const blobP = new Promise(res => engine.canvas.toBlob(res, 'image/png')); // スナップショットは同期で取られる
      rows.push({ seq: s, atMs: at, room: engine.roomId, visible: !!(engine.vrm && engine.vrm.scene.visible), box });
      uploads.push(blobP.then(b => b ? postFrame(b, dir, s) : false));
    }
    cases.push({ name: dir, room, frames: rows });
  };
  const measureBaseline = async room => {
    engine.springs.settle(150, engine.elapsed);
    await nextFrame(); await nextFrame();
    baseline[room] = engine.avatarBox();
  };
  // 開始：先頭の部屋・wide・カメラ 0
  await command({ type: 'reset' });
  await command({ type: 'preset', value: 'wide' });
  if (engine.roomId !== ROOMS[0].id) { await command({ type: 'room', value: ROOMS[0].id }); await sleep(300); await waitIdle(); }
  const order = ROOMS.map(r => r.id);
  for (let i = 0; i < order.length; i++) {
    const room = order[i];
    await measureBaseline(room);
    for (const preset of ['presenter', 'screen', 'wide']) {          // 瞬間カット 3
      await command({ type: 'preset', value: preset });
      while (engine.preset !== preset) await sleep(5);               // ポーリングで OBS 側に届いた瞬間から数える
      await capture(room, 'cut_' + preset);
    }
    for (let k = 1; k <= 3; k++) {                                   // visibilitychange 3
      document.dispatchEvent(new Event('visibilitychange'));
      await capture(room, 'vis' + k);
    }
    for (let k = 1; k <= 2; k++) {                                   // 2 秒停止→再開 2
      await app.pauseLoop(2000);
      await capture(room, 'frz' + k);
    }
    const next = ROOM_MAP[room].neighbours[0] || order[(i + 1) % order.length];   // 移動 A 1（往復で部屋数ぶん）
    if (next && next !== room) {
      await command({ type: 'room', value: next });
      while (!engine.transition) await sleep(5);
      await capture(room, 'move_to_' + next);
      await waitIdle();
      if (i === order.length - 1) await waitIdle();
    }
  }
  const okUploads = (await Promise.all(uploads)).filter(Boolean).length;
  // 数値判定：settle 時の bbox 幅の 1.15 倍超、または top が +0.05m 超 → NG
  let ng = 0;
  for (const c of cases) for (const f of c.frames) {
    const b = baseline[f.room];
    f.ng = !!(f.box && b && f.visible && (f.box.width > b.width * 1.15 || f.box.top > b.top + 0.05));
    f.widthRatio = f.box && b ? +(f.box.width / b.width).toFixed(3) : null;
    f.topDelta = f.box && b ? +(f.box.top - b.top).toFixed(4) : null;
    if (f.ng) ng++;
  }
  const report = { kind: 'safety', createdAt: new Date().toISOString(), baseline, cases,
    summary: { cases: cases.length, frames: cases.reduce((n, c) => n + c.frames.length, 0), uploaded: okUploads, ng,
      maxWidthRatio: Math.max(...cases.flatMap(c => c.frames.filter(f => f.visible).map(f => f.widthRatio || 0))),
      maxTopDelta: Math.max(...cases.flatMap(c => c.frames.filter(f => f.visible).map(f => f.topDelta ?? -9))),
      elapsedMs: Math.round(performance.now() - started) } };
  try {
    const r = await fetch('/api/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
    report.path = (await r.json()).path;
  } catch (e) { report.postError = String(e); }
  await command({ type: 'preset', value: 'wide' });
  return { summary: report.summary, path: report.path, baseline };
}

export async function takeShot(engine, { name = 'shot.png', room = engine.roomId, preset = 'wide', mask = null, cam = null, page = null } = {}) {
  const savedRoom = engine.roomId;
  engine.frozen = true;
  try {
    engine.renderer.setSize(1920, 1080, false);
    engine.camera.aspect = 16 / 9; engine.camera.updateProjectionMatrix();
    engine.transition = null; engine.transitionOpacity = 0;
    engine.setRoom(room);
    if (page !== null) { engine.page = page; engine.showSlide(); }
    engine.setSafeCamera(ZERO, preset);
    if (cam === 'close') engine.debugCloseCamera();
    engine.applyVisibility();
    engine.springs.settle(150, 0);                 // 撮影用の瞬間移動で暴れた揺れ物を小 delta で沈める
    if (engine.vrm) { engine.applyCharPose(0); engine.vrm.update(0); }
    engine.setMask(mask);
    engine.render();
    const blob = await new Promise(res => engine.canvas.toBlob(res, 'image/png'));
    engine.setMask(null);
    const r = blob ? await fetch('/save?name=' + encodeURIComponent(name), { method: 'POST', body: blob }) : null;
    return r ? (await r.json()) : { ok: false };
  } finally {
    engine.setMask(null);
    engine.setRoom(savedRoom);
    engine.resize(engine.canvas.clientWidth || 1920, engine.canvas.clientHeight || 1080);
    engine.frozen = false;
  }
}
