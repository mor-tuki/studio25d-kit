// app.js — プレビュー / OBS 出力 / 操作パネル 共用
//   状態の正本はサーバー（/api/state を 120ms ポーリング・revision で適用）。
//   キー（入力欄フォーカス中は無効）：1-9 部屋 / E 隣の部屋 / ←→ スライド / Q wide・W presenter・R screen /
//                                   G マゼンタ / H HUD / F 暗転色切替 / P 動画の再生・一時停止 / K 動画の音
//   ムーブ・歩行（moves.json の "key" から組む）：Shift+1〜Shift+0 カメラムーブ10本 / B 手持ちの揺れ（入/切）/ X ムーブを止める /
//                                   T 資料へ歩いて案内 / M 目印を見上げる / A 立ち位置に戻る（キャラがいるときだけ）
//   360 部屋（rooms.json type:"pano360"）：O ぐるっと一周 / U 見上げて天井→キャラへ。向きのスライダー・ドラッグは 360° 回る
const $ = selector => document.querySelector(selector);
const Q = new URLSearchParams(location.search);
const output = Q.get('output') === '1';
if (output) document.body.classList.add('output-only');
const canvas = $('#stage');
let engine, state, roomDefs = [], pollBusy = false, toastTimer, cameraTimer, hudOn = Q.get('hud') === '1';
let loopPausedUntil = 0, hudMagenta = '-', hudMagentaAt = 0, fps = 0;
let moveDefs = [], keyMap = {};
const pad = n => String(n).padStart(2, '0');
const PRESET_LABEL = { wide: '全景', presenter: '話し手', screen: '資料' };
const log = m => fetch('/log', { method: 'POST', body: String(m) }).catch(() => {});
addEventListener('error', e => log('ERR ' + e.message + ' @' + (e.filename || '') + ':' + e.lineno));
addEventListener('unhandledrejection', e => log('REJ ' + (e.reason && e.reason.message || e.reason)));

function toast(message) {
  const el = $('#toast'); if (!el) return;
  el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}
function connected(yes) {
  const el = $('#connection');
  if (el) { el.textContent = yes ? 'ローカル接続済み' : '接続を確認中'; el.classList.toggle('offline', !yes); }
}
async function command(body) {
  try {
    const response = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '操作できませんでした');
    receive(value);
    return value;
  } catch (error) { toast(error.message); return null; }
}
function receive(next) {
  if (state && next.revision < state.revision) return;
  const changed = !state || state.revision !== next.revision;
  const busyChanged = !state || state.transitionActive !== next.transitionActive;
  state = next; connected(true);
  if (changed) engine?.applyState(state);
  if (changed || busyChanged) paint();
}
const roomLabel = room => room.title || room.name || room.id;
const roomTypeOf = id => (roomDefs.find(r => r.id === id) || {}).type || '2.5d';
const moveFits = (m, id) => !(Array.isArray(m.roomTypes) && !m.roomTypes.includes(roomTypeOf(id))) && !(m.rooms && m.rooms[id] === false);

function paint() {
  if (!state) return;
  const room = roomDefs.find(r => r.id === state.room);
  if ($('#room-title')) $('#room-title').textContent = room ? roomLabel(room) : state.room;
  const pages = state.slides?.length || 1;
  for (const id of ['#page-label', '#slide-indicator']) if ($(id)) $(id).textContent = `${pad(state.page + 1)} / ${pad(pages)}`;
  if ($('#page-count')) $('#page-count').textContent = `${pages} PAGES`;
  const current = state.slides?.[state.page] || '';
  const isVideo = /\.(mp4|webm)$/i.test(current);
  if ($('#slide-thumb')) { $('#slide-thumb').hidden = isVideo || !current; if (!isVideo && current) $('#slide-thumb').src = current; }
  if ($('#slide-video-note')) $('#slide-video-note').hidden = !isVideo;
  if ($('#video-controls')) $('#video-controls').classList.toggle('inactive', !isVideo);
  if ($('#video-toggle')) $('#video-toggle').textContent = state.videoPlaying === false ? '▶ 再生 (P)' : '❚❚ 一時停止 (P)';
  if ($('#mute-toggle')) $('#mute-toggle').textContent = state.videoMuted === false ? '音あり (K)' : '消音中 (K)';
  const busy = !!state.transitionActive;
  document.querySelectorAll('[data-room]').forEach(el => {
    const active = el.dataset.room === state.room;
    el.classList.toggle('active', active); el.setAttribute('aria-pressed', String(active));
    el.disabled = busy;                                    // 移動中は room ボタンを止める
    el.querySelector('.room-state').textContent = busy ? '移動中…' : active ? '滞在中 ●' : '移動する ↗';
  });
  if ($('#next-room')) $('#next-room').disabled = busy;
  document.querySelectorAll('[data-preset]').forEach(el => el.classList.toggle('active', el.dataset.preset === state.preset));
  document.querySelectorAll('[data-fade]').forEach(el => el.classList.toggle('active', el.dataset.fade === state.fade));
  for (const key of ['yaw', 'pitch', 'dolly', 'zoom']) {
    const el = $(`#${key}`); if (!el) continue;
    const lim = room?.camera?.[key];                       // 部屋ごとの可動域（360 部屋は向き ±360°）
    if (Array.isArray(lim)) { el.min = lim[0]; el.max = lim[1]; el.step = (lim[1] - lim[0]) > 50 ? 1 : key === 'dolly' ? 0.05 : 0.1; }
    const val = state.camera?.[key] || 0;
    if (document.activeElement !== el) el.value = val;
    const o = $(`#${key}-value`); if (o) o.textContent = key === 'dolly' ? `${Number(val).toFixed(1)} m` : `${Number(val).toFixed(1)}°`;
  }
  if ($('#debug')) $('#debug').checked = state.debug;
  if ($('#avatar-toggle')) $('#avatar-toggle').checked = state.avatar !== false;
  if ($('#screen-toggle')) $('#screen-toggle').checked = state.screen !== false;
  if ($('#sway-toggle')) $('#sway-toggle').checked = state.sway !== false;
  if ($('#deck') && state.deck && document.activeElement !== $('#deck')) $('#deck').value = state.deck;
  document.querySelectorAll('[data-move]').forEach(el => {
    el.classList.toggle('active', el.dataset.move === state.move);
    const m = moveDefs.find(d => d.name === el.dataset.move);
    el.disabled = busy || (m && !moveFits(m, state.room));   // この部屋の種類に無いムーブは押せない
    el.title = m && !moveFits(m, state.room) ? `${m.name}（この部屋では使えません）` : el.dataset.move;
  });
  document.querySelectorAll('[data-walk]').forEach(el => {
    el.classList.toggle('active', !!state.walkActive && el.dataset.walk === state.walk);
    el.disabled = busy || !!state.walkActive || (engine && engine.ready && !engine.vrm);   // キャラがいないと歩けない
  });
  if ($('#view-tag')) $('#view-tag').innerHTML = `CAM ${pad(roomDefs.findIndex(r => r.id === state.room) + 1)} <span>${state.preset.toUpperCase()}</span>`;
}

function neighboursOf(id) {
  const room = roomDefs.find(r => r.id === id); if (!room) return [];
  const ids = new Set(roomDefs.map(r => r.id));
  return [...new Set([...(room.neighbours || []), ...roomDefs.filter(o => (o.neighbours || []).includes(id)).map(o => o.id)])].filter(n => n !== id && ids.has(n));
}

function buildRooms() {
  if (!$('#rooms')) return;
  roomDefs.forEach((room, i) => {
    const el = document.createElement('button'); el.className = 'room-card'; el.dataset.room = room.id;
    const img = document.createElement('img'); img.src = room.thumb || room.background; img.alt = '';
    const index = document.createElement('span'); index.className = 'room-index'; index.textContent = pad(i + 1);
    const body = document.createElement('div'); body.className = 'card-body';
    const title = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = roomLabel(room);
    const sub = document.createElement('small'); sub.textContent = (room.subtitle || room.id).toUpperCase();
    title.append(strong, sub);
    const status = document.createElement('span'); status.className = 'room-state'; status.textContent = '移動する ↗';
    body.append(title, status); el.append(img, index, body);
    el.onclick = () => command({ type: 'room', value: room.id });
    $('#rooms').append(el);
  });
}

async function buildDecks() {
  const select = $('#deck'); if (!select) return;
  try {
    const { decks } = await fetch('/api/decks').then(r => r.json());
    select.replaceChildren(...decks.map(d => { const o = document.createElement('option'); o.value = d; o.textContent = d.split('/').pop(); return o; }));
    if (state?.deck) select.value = state.deck;
  } catch { /* deck list is optional */ }
  select.onchange = () => command({ type: 'deck', value: select.value });
}

// moves.json の "key"（"Shift+1" / "B" など）→ 定義。カメラムーブ・歩行・停止を同じ表から引く
function triggerMove(m) {
  if (!m) return;
  if (state && (m.kind || 'move') === 'move' && !moveFits(m, state.room)) { toast(`${m.label || m.name} はこの部屋では使えません`); return; }
  if (m.kind === 'walk') { if (state && (state.walkActive || state.transitionActive)) { toast('歩いている途中です'); return; } command({ type: 'walk', value: m.name }); }
  else if (m.loop && state && state.move === m.name) command({ type: 'move', value: 'stop' });   // ループは同じキーで切
  else command({ type: 'move', value: m.name });
}
const keyLabel = k => (k || '').replace('Shift+', '⇧');

async function buildMoves() {
  try { moveDefs = await fetch('moves.json', { cache: 'no-store' }).then(r => r.json()); } catch { moveDefs = []; }
  if (!Array.isArray(moveDefs)) moveDefs = [];
  keyMap = {};
  for (const m of moveDefs) if (m.key) keyMap[m.key.toLowerCase()] = m;
  const box = $('#moves'); if (!box) return;
  if (!moveDefs.length) { box.innerHTML = '<p class="helper">準備中（moves.json が空です）</p>'; return; }
  const button = m => {
    const b = document.createElement('button'); b.className = 'move-button';
    if (m.kind === 'walk') b.dataset.walk = m.name; else b.dataset.move = m.name;
    const k = document.createElement('kbd'); k.textContent = keyLabel(m.key);
    const t = document.createElement('span'); t.textContent = m.label || m.name;
    b.append(k, t); b.title = m.name; b.onclick = () => triggerMove(m); return b;
  };
  const group = (title, items) => {
    const g = document.createElement('div'); g.className = 'move-group';
    const h = document.createElement('small'); h.className = 'move-group-title'; h.textContent = title;
    g.append(h, ...items); return g;
  };
  const stop = document.createElement('button'); stop.className = 'move-button';
  stop.innerHTML = '<kbd>X</kbd><span>ムーブを止める</span>'; stop.onclick = () => command({ type: 'move', value: 'stop' });
  box.replaceChildren(
    group('カメラムーブ', [...moveDefs.filter(m => (m.kind || 'move') === 'move').map(button), stop]),
    group('歩く（部屋をまたがない）', moveDefs.filter(m => m.kind === 'walk').map(button)));
  paint();
}

function nextRoom() {
  if (!state || state.transitionActive) return;
  const n = neighboursOf(state.room);
  const target = n[0] || roomDefs[(roomDefs.findIndex(r => r.id === state.room) + 1) % roomDefs.length]?.id;
  if (target && target !== state.room) command({ type: 'room', value: target });
}

document.querySelectorAll('[data-preset]').forEach(el => el.onclick = () => command({ type: 'preset', value: el.dataset.preset }));
document.querySelectorAll('[data-fade]').forEach(el => el.onclick = () => command({ type: 'fade', value: el.dataset.fade }));
document.querySelectorAll('[data-slide]').forEach(el => el.onclick = () => command({ type: 'slide', delta: Number(el.dataset.slide) }));
document.querySelectorAll('[data-command]').forEach(el => el.onclick = () => command({ type: el.dataset.command }));
if ($('#next-room')) $('#next-room').onclick = nextRoom;
if ($('#video-toggle')) $('#video-toggle').onclick = () => command({ type: 'video', value: 'toggle' });
if ($('#video-restart')) $('#video-restart').onclick = () => command({ type: 'video', value: 'restart' });
if ($('#mute-toggle')) $('#mute-toggle').onclick = () => command({ type: 'muted', value: state?.videoMuted === false });
for (const key of ['yaw', 'pitch', 'dolly', 'zoom']) if ($(`#${key}`)) $(`#${key}`).addEventListener('input', () => {
  const value = Number($(`#${key}`).value);
  $(`#${key}-value`).textContent = key === 'dolly' ? `${value.toFixed(1)} m` : `${value.toFixed(1)}°`;
  clearTimeout(cameraTimer); cameraTimer = setTimeout(() => command({ type: 'camera', value: { [key]: value } }), 60);
});
if ($('#debug')) $('#debug').onchange = e => command({ type: 'debug', value: e.target.checked });
if ($('#avatar-toggle')) $('#avatar-toggle').onchange = e => command({ type: 'avatar', value: e.target.checked });
if ($('#screen-toggle')) $('#screen-toggle').onchange = e => command({ type: 'screen', value: e.target.checked });
if ($('#sway-toggle')) $('#sway-toggle').onchange = e => command({ type: 'sway', value: e.target.checked });
if ($('#fullscreen')) $('#fullscreen').onclick = () => {
  const p = $('#viewport');
  if (!document.fullscreenElement) p.requestFullscreen().catch(e => toast(e.message)); else document.exitFullscreen();
};
if ($('#obs-link')) $('#obs-link').href = `${location.origin}/?output=1`;

function setHud(on) { hudOn = on; const el = $('#hud'); if (el) el.style.display = on ? 'block' : 'none'; }

addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable) return;
  const key = event.key.toLowerCase();
  if (event.shiftKey && /^Digit[0-9]$/.test(event.code)) {             // Shift+数字＝カメラムーブ（数字単独＝部屋 とぶつけない）
    event.preventDefault(); triggerMove(keyMap['shift+' + event.code.slice(5)]); return;
  }
  if (key === 'x') { command({ type: 'move', value: 'stop' }); return; }
  if (key === 'p') { command({ type: 'video', value: 'toggle' }); return; }                  // 動画スライド 再生/一時停止
  if (key === 'k' && state) { command({ type: 'muted', value: state.videoMuted === false }); return; }   // 動画の音 入/切
  if (key === 'i' && state) { command({ type: 'sway', value: !state.sway }); return; }   // 待機ゆらぎ 入/切
  if (key.length === 1 && /[a-z]/.test(key) && keyMap[key] && !event.shiftKey) { event.preventDefault(); triggerMove(keyMap[key]); return; }
  if (key === 'arrowright' || key === 'arrowleft') { event.preventDefault(); command({ type: 'slide', delta: key === 'arrowright' ? 1 : -1 }); }
  else if (key === 'e') { event.preventDefault(); nextRoom(); }
  else if (key === 'q') command({ type: 'preset', value: 'wide' });
  else if (key === 'w') command({ type: 'preset', value: 'presenter' });
  else if (key === 'r') command({ type: 'preset', value: 'screen' });
  else if (key === 'g' && state) command({ type: 'debug', value: !state.debug });
  else if (key === 'h') setHud(!hudOn);
  else if (key === 'f' && state) command({ type: 'fade', value: state.fade === 'dark' ? 'light' : 'dark' });
  else if (/^[1-9]$/.test(key)) { const room = roomDefs[Number(key) - 1]; if (room && !state?.transitionActive) command({ type: 'room', value: room.id }); }
});

if (canvas && !output) {
  let pointer;
  canvas.addEventListener('pointerdown', e => { pointer = { x: e.clientX, y: e.clientY, yaw: state?.camera.yaw || 0, pitch: state?.camera.pitch || 0 }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!pointer) return;
    const lim = roomDefs.find(r => r.id === state?.room)?.camera || { yaw: [-4, 4], pitch: [-2, 1] };
    const pano = roomTypeOf(state?.room) === 'pano360';     // 360 部屋はドラッグで大きく回る（1px＝0.25°）
    const wrapYaw = y => pano ? ((y + 180) % 360 + 360) % 360 - 180 : y;
    const value = { yaw: Math.max(lim.yaw[0], Math.min(lim.yaw[1], wrapYaw(pointer.yaw - (e.clientX - pointer.x) * (pano ? .25 : -.015)))),
      pitch: Math.max(lim.pitch[0], Math.min(lim.pitch[1], pointer.pitch - (e.clientY - pointer.y) * (pano ? .15 : .01))) };
    clearTimeout(cameraTimer); cameraTimer = setTimeout(() => command({ type: 'camera', value }), 35);
  });
  canvas.addEventListener('pointerup', () => pointer = null);
  canvas.addEventListener('pointercancel', () => pointer = null);
}

if ($('#slide-files')) $('#slide-files').onchange = async event => {
  const files = [...event.target.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) return;
  if (files.reduce((n, f) => n + f.size, 0) > 25 * 1024 * 1024) { toast('画像の合計を25MB以内にしてください'); return; }
  try {
    const slides = await Promise.all(files.map(file => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve({ name: file.name, data: String(r.result).split(',')[1] }); r.onerror = reject; r.readAsDataURL(file); })));
    const response = await fetch('/api/slides', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slides }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error);
    receive(value); toast(`${slides.length}枚のスライドを読み込みました`);
  } catch (error) { toast(`読み込めませんでした: ${error.message}`); }
  event.target.value = '';
};

async function poll() {
  if (pollBusy) return; pollBusy = true;
  try { const r = await fetch('/api/state', { cache: 'no-store' }); if (!r.ok) throw new Error('offline'); receive(await r.json()); }
  catch { connected(false); } finally { pollBusy = false; }
}

function hudLine() {
  if (!hudOn || !engine) return;
  const now = performance.now();
  if (now - hudMagentaAt > 2000 && engine.ready && !engine.frozen) {   // 2 秒ごとに背景だけの独立パスで数える
    hudMagentaAt = now;
    try { hudMagenta = engine.countMagenta(1920, 1080).magentaPixels; } catch (e) { hudMagenta = 'err'; }
  }
  const el = $('#hud-state'); if (!el) return;
  const c = engine.camera;
  el.textContent = `room:${engine.roomId}  preset:${engine.preset}  safe:${engine.safeFactor.toFixed(3)}  fps:${fps}  magenta(1920x1080):${hudMagenta}px\n` +
    `cam pos:${c.position.toArray().map(v => v.toFixed(2)).join(',')}  fov:${c.fov.toFixed(1)}  transition:${engine.transition ? (engine.transition.time / engine.transition.duration).toFixed(2) : '-'}\n` +
    `move:${engine.move ? engine.move.name + ' ' + engine.move.t.toFixed(1) + '/' + engine.move.dur.toFixed(1) + 's' : '-'}  walk:${engine.walk ? engine.walk.name + ' ' + (engine.elapsed - engine.walk.t0).toFixed(1) + '/' + engine.walk.act.dur.toFixed(1) + 's' : '-'}\n` +
    `keys 1-9 room · E next · ←→ slide · P video play/pause · K video sound · Q/W/R preset · G magenta · H hud · F fade\n` +
    `     ⇧1-⇧0 moves · B breathing · X stop move · T guide · M look up · A back to spot · I idle sway (${engine.swayOn ? 'on' : 'off'})` +
    (engine.room && engine.room.pano ? `\n     360: O orbit · U ceiling→char · drag = look around  pano h=${engine.room.pano.height} r=${engine.room.pano.radius} tex=${engine.room.pano.textureSize.join('x')}` : '');
}

function ensureHud() {
  if ($('#hud') || !$('#viewport')) return;
  const hud = document.createElement('div'); hud.id = 'hud'; hud.className = 'studio-hud';
  hud.innerHTML = '<strong>STUDIO 2.5D</strong><pre id="hud-state">loading…</pre>';
  $('#viewport').append(hud); setHud(hudOn);
}

async function init() {
  roomDefs = await fetch('rooms.json', { cache: 'no-store' }).then(r => r.json());
  buildRooms(); buildDecks(); buildMoves(); ensureHud();
  await poll();
  if (canvas) {
    const { StudioEngine } = await import('./engine.js');
    const config = await fetch('studio.config.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
    engine = new StudioEngine(canvas, { config, onStatus: msg => { if ($('#load-message')) $('#load-message').textContent = typeof msg === 'string' ? msg : JSON.stringify(msg); } });
    window.studio = engine;
    await engine.init();
    if (state) engine.applyState(state);
    $('#loading').classList.add('hidden');
    new ResizeObserver(() => { if (!engine.frozen) engine.resize(canvas.clientWidth, canvas.clientHeight); }).observe(canvas);
    let last = performance.now(), frames = 0, fpsT = 0;
    function loop(now) {
      if (now < loopPausedUntil) { requestAnimationFrame(loop); return; }   // 停止中は last を進めない（復帰時に大きな dt）
      const dtRaw = Math.max(0, (now - last) / 1000); last = now;            // 生の dt（>0.5s で揺れ物 reset・物理は 1/30 で頭打ち）
      frames++; fpsT += dtRaw; if (fpsT >= 1) { fps = frames; frames = 0; fpsT = 0; }
      if (!engine.frozen) { engine.update(dtRaw); engine.render(); }
      const veil = $('#transition-overlay');
      if (veil) { veil.style.opacity = engine.transitionOpacity || 0; veil.style.background = state?.fade === 'light' ? '#f4eee7' : '#070c14'; }
      hudLine();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    const audit = await import('./audit.js');
    const pano = await import('./audit_pano.js');
    const app = { pauseLoop: async ms => { loopPausedUntil = performance.now() + ms; await new Promise(r => setTimeout(r, ms + 40)); } };
    window.__studio = {
      engine, app, getState: () => state, command,
      auditAll: opts => audit.auditAll(engine, opts),
      safetyRun: opts => audit.safetyRun(engine, app, opts),
      takeShot: opts => audit.takeShot(engine, opts),
      expectedCounts: () => audit.expectedCounts(engine.transitionSeconds, 60, audit.motionPlan(engine)),
      panoView: opts => pano.panoView(engine, opts),
      panoShot: opts => pano.panoShot(engine, opts),
      feetRun: opts => pano.feetRun(engine, opts),
      ready: true,
    };
    if ($('#audit')) $('#audit').onclick = async () => {
      const b = $('#audit'); b.disabled = true; $('#audit-result').textContent = '検証中…';
      try { const report = await window.__studio.auditAll(); window.lastAudit = report; $('#audit-result').textContent = JSON.stringify(report.summary); toast(report.summary.passed ? 'すべての検証フレームで絵の外の露出なし' : '検証レポートを確認してください'); }
      catch (e) { $('#audit-result').textContent = e.message; } finally { b.disabled = false; }
    };
    window.studioReady = true;
    if (Q.get('shot') === '1') {
      await new Promise(r => setTimeout(r, 700));
      await window.__studio.takeShot({ name: Q.get('name') || 'shot.png', room: Q.get('room') || engine.roomId, preset: Q.get('preset') || 'wide',
        mask: Q.get('mask') || null, cam: Q.get('cam') || null, page: Q.get('page') !== null ? +Q.get('page') : null });
      document.title = 'SHOT_DONE';
    }
  }
  paint();
  setInterval(poll, 120);
}
init().catch(error => { console.error(error); toast(error.message); log('init ' + error.message); if ($('#load-message')) $('#load-message').textContent = `読み込みエラー: ${error.message}`; });
window.studioCommand = command;
