// MyTurn client
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem('myturn.' + k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem('myturn.' + k) : localStorage.setItem('myturn.' + k, v); } catch {} },
};

// ---------- identity (persists across visits) ----------
let clientId = store.get('id');
if (!clientId) {
  clientId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  store.set('id', clientId);
}
let myName = store.get('name') || '';
let roomCode = null; // room we are in (or trying to rejoin)
let room = null;     // latest state from server
let wasMyTurn = false;

// ---------- websocket with auto-reconnect ----------
let ws = null;
let queue = [];
let retry = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    retry = 0;
    $('conn').classList.add('hidden');
    ws.send(JSON.stringify({ type: 'hello', clientId, name: myName }));
    if (roomCode) ws.send(JSON.stringify({ type: 'join', code: roomCode }));
    queue.forEach((m) => ws.send(m));
    queue = [];
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (roomCode) $('conn').classList.remove('hidden');
    setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
  };
}

function send(msg) {
  const data = JSON.stringify(msg);
  if (ws && ws.readyState === 1) ws.send(data);
  else queue.push(data);
}

function handle(msg) {
  switch (msg.type) {
    case 'state':
      room = msg.room;
      roomCode = room.code;
      store.set('room', roomCode);
      history.replaceState(null, '', '/' + roomCode);
      render();
      break;
    case 'summary':
      showSummary(msg.summary);
      break;
    case 'welcome':
      checkBuild(msg.build);
      break;
    case 'notice':
      toast(msg.message);
      break;
    case 'react':
      showReaction(msg);
      break;
    case 'announce':
      showAnnounce(msg.name, msg.label);
      break;
    case 'kicked':
      exitRoom();
      toast('The host removed you from the room');
      break;
    case 'gone':
      exitRoom();
      break;
    case 'error':
      toast(msg.message);
      break;
  }
}

// ---------- screens ----------
function showHome() {
  $('home').classList.remove('hidden');
  $('room').classList.add('hidden');
  document.body.classList.remove('my-turn');
}

function exitRoom() {
  roomCode = null;
  room = null;
  wasMyTurn = false;
  store.set('room', null);
  history.replaceState(null, '', '/');
  $('conn').classList.add('hidden');
  showHome();
}

function requireName() {
  const name = $('nameInput').value.trim();
  if (!name) { $('nameInput').focus(); toast('Enter your name first'); return false; }
  setName(name);
  return true;
}

function setName(name) {
  myName = name.trim().slice(0, 24);
  store.set('name', myName);
  $('nameInput').value = myName;
  $('meName').textContent = myName;
  send({ type: 'hello', clientId, name: myName });
  if (roomCode) send({ type: 'rename', name: myName });
}

// ---------- rendering ----------
function render() {
  $('home').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('roomCode').textContent = room.code;
  $('meName').textContent = myName;

  const players = room.players;
  const n = players.length;
  const isHost = room.adminId === clientId;
  const meIdx = players.findIndex((p) => p.id === clientId);
  const cur = players[room.current];
  const dir = room.direction || 1;
  const nextIdx = n ? (((room.current + dir) % n) + n) % n : -1;
  const myTurn = room.started && cur && cur.id === clientId;

  // Status line
  if (!room.started) {
    $('status').textContent = isHost
      ? (n < 2 ? 'Share the room code so others can join' : `Arrange the seats, then start${dir < 0 ? ' (play goes ↑ up the list)' : ''}`)
      : 'Waiting for the host to start…';
  } else {
    $('status').textContent = n > 1 ? `Next up: ${players[nextIdx].name}${dir < 0 ? '  ·  ⇄ reversed' : ''}` : '';
  }

  $('inviteBtn').classList.toggle('hidden', room.started);
  $('resultsBtn').classList.toggle('hidden', room.started || !room.lastSummary);

  // Big button
  $('turnWrap').classList.toggle('hidden', !room.started);
  const btn = $('turnBtn');
  btn.disabled = !myTurn;
  if (room.started && cur) {
    if (myTurn) {
      $('turnLabel').textContent = 'Your turn!';
      $('turnSub').textContent = 'Tap when you’re done';
    } else {
      $('turnLabel').textContent = `${cur.name}’s turn`;
      const wait = meIdx < 0 ? -1 : (((meIdx - room.current) * dir) % n + n) % n;
      $('turnSub').textContent = wait === 1 ? 'You’re up next' : wait > 1 ? `${wait} turns until you` : '';
    }
  }
  document.body.classList.toggle('my-turn', !!myTurn);
  $('reactBar').querySelector('.hurry').classList.toggle('hidden', !!myTurn); // can't rush yourself
  if (myTurn && !wasMyTurn) buzz();
  wasMyTurn = !!myTurn;

  // Custom buttons for everyone
  $('customBtns').replaceChildren(...room.buttons.map((b) => {
    const el = document.createElement('button');
    el.className = 'btn';
    el.textContent = b.label;
    el.onclick = () => send({ type: 'press', buttonId: b.id });
    return el;
  }));

  // Seating list
  $('playerCount').textContent = `${n} player${n === 1 ? '' : 's'}`;
  $('players').replaceChildren(...players.map((p, i) => {
    const li = document.createElement('li');
    const isCur = room.started && i === room.current;
    const isNext = room.started && n > 1 && i === nextIdx;
    if (isCur) li.classList.add('current');
    if (isNext) li.classList.add('next');

    li.append(el('span', 'seat', i + 1), el('span', 'dot' + (p.online ? '' : ' off')));
    const name = el('span', 'pname', p.name);
    if (p.id === clientId) name.append(el('em', '', 'you'));
    if (p.id === room.adminId) name.append(el('em', '', 'host'));
    li.append(name);
    if (isCur) li.append(el('span', 'tag', 'NOW'));
    else if (isNext) li.append(el('span', 'tag next', 'NEXT'));

    if (isHost) {
      if (room.started && !isCur) li.append(mini('▶', 'Give turn', () => send({ type: 'setTurn', playerId: p.id })));
      li.append(
        mini('↑', 'Move up', () => send({ type: 'move', playerId: p.id, dir: -1 }), i === 0),
        mini('↓', 'Move down', () => send({ type: 'move', playerId: p.id, dir: 1 }), i === n - 1),
      );
      if (p.id !== clientId) {
        const x = mini('✕', 'Remove', () => { if (confirm(`Remove ${p.name}?`)) send({ type: 'kick', playerId: p.id }); });
        x.classList.add('x');
        li.append(x);
      }
    }
    return li;
  }));

  // Host panel
  $('hostPanel').classList.toggle('hidden', !isHost);
  if (isHost) {
    $('lobbyCtrls').classList.toggle('hidden', room.started);
    $('gameCtrls').classList.toggle('hidden', !room.started);
    $('startBtn').disabled = n < 1;
    for (const b of [$('reverseBtn'), $('reverseBtn2')]) b.classList.toggle('on', dir < 0);
    $('btnList').replaceChildren(...(room.buttons.length
      ? room.buttons.map((b) => {
        const c = el('button', 'chip', b.label);
        c.append(el('span', 'rm', '✕'));
        c.title = 'Remove button';
        c.onclick = () => send({ type: 'removeButton', buttonId: b.id });
        return c;
      })
      : [el('span', 'muted small', 'None yet. Add one below.')]));
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function mini(label, title, onclick, disabled) {
  const b = el('button', 'mini', label);
  b.title = title;
  b.setAttribute('aria-label', title);
  b.disabled = !!disabled;
  b.onclick = onclick;
  return b;
}

// ---------- dialogs (with a fallback for browsers without <dialog>, e.g. iOS < 15.4) ----------
const nativeDialog = typeof HTMLDialogElement === 'function' && 'showModal' in HTMLDialogElement.prototype;
function openDialog(d) {
  if (d.open || d.hasAttribute('open')) return;
  if (nativeDialog) d.showModal();
  else d.setAttribute('open', '');
}
function closeDialog(d, value = '') {
  if (nativeDialog) return d.close(value);
  d.returnValue = value;
  d.removeAttribute('open');
  d.dispatchEvent(new Event('close'));
}
if (!nativeDialog) {
  document.documentElement.classList.add('no-dialog');
  document.querySelectorAll('dialog form[method="dialog"]').forEach((f) => {
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      closeDialog(f.closest('dialog'), e.submitter ? e.submitter.value : '');
    });
  });
}

// ---------- feedback ----------
let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 2500);
}

// Quick reactions: a short, non-blocking popover in the middle of the screen.
const REACTION_EMOJI = { up: '👍', down: '👎', laugh: '😂', wow: '😮', hurry: '⏰' };
let reactionTimer;
function showReaction({ key, name, fromId, targetId, targetName }) {
  const box = $('reaction');
  const forMe = key === 'hurry' && targetId === clientId;
  $('reactionEmoji').textContent = REACTION_EMOJI[key] || '❔';
  $('reactionText').textContent = key === 'hurry' ? (forMe ? 'Hurry up!' : `Hurry up, ${targetName}!`) : '';
  $('reactionFrom').textContent = fromId === clientId ? 'you' : name;
  box.classList.toggle('urgent', forMe);
  box.classList.add('hidden');
  void box.offsetWidth; // restart the pop animation if one is already showing
  box.classList.remove('hidden');
  if (forMe && navigator.vibrate) navigator.vibrate([120, 60, 120, 60, 120]);
  clearTimeout(reactionTimer);
  reactionTimer = setTimeout(() => box.classList.add('hidden'), forMe ? 2200 : 1500);
}
document.querySelectorAll('[data-react]').forEach((b) => {
  b.onclick = () => send({ type: 'react', key: b.dataset.react });
});

let announceTimer;
function showAnnounce(name, label) {
  $('announceName').textContent = name;
  $('announceLabel').textContent = label;
  $('announce').classList.remove('hidden');
  if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => $('announce').classList.add('hidden'), 4000);
}
$('announce').onclick = () => $('announce').classList.add('hidden');

let audioCtx;
function buzz() {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  try { // short chime (works once the user has tapped something on the page)
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.4);
  } catch {}
}

// ---------- keep the screen awake ----------
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {} // denied (e.g. low battery) or not a secure context
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake();
    if (ws && ws.readyState > 1) connect(); // revive socket after the phone slept
  }
});
// Some browsers only grant the lock after a user gesture.
document.addEventListener('pointerdown', () => {
  keepAwake();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}, { passive: true });

// ---------- events ----------
$('nameInput').addEventListener('change', (e) => { if (e.target.value.trim()) setName(e.target.value); });

const CODE_RE = /^[A-Z0-9]{3,8}$/;
const cleanCode = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

$('createBtn').onclick = () => {
  if (!requireName()) return;
  const custom = $('customCodeField').classList.contains('hidden') ? '' : cleanCode($('customCodeInput').value);
  if (custom && !CODE_RE.test(custom)) { $('customCodeInput').focus(); return toast('Codes are 3–8 letters or numbers'); }
  send({ type: 'create', code: custom || undefined }); // server refuses codes already in use
};
$('customCodeToggle').onclick = () => {
  const show = $('customCodeField').classList.toggle('hidden') === false;
  $('customCodeToggle').textContent = show ? 'Use a random code instead' : 'Pick your own room code';
  if (show) $('customCodeInput').focus(); else $('customCodeInput').value = '';
};
$('customCodeInput').addEventListener('input', (e) => { e.target.value = cleanCode(e.target.value); });
$('customCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('createBtn').click(); });

function join() {
  const code = $('codeInput').value.trim().toUpperCase();
  if (!requireName()) return;
  if (!CODE_RE.test(code)) { $('codeInput').focus(); return toast('Enter the room code'); }
  roomCode = code;
  send({ type: 'join', code });
}
$('joinBtn').onclick = join;
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('codeInput').addEventListener('input', (e) => { e.target.value = cleanCode(e.target.value); });

$('turnBtn').onclick = () => {
  if ($('turnBtn').disabled) return;
  $('turnBtn').disabled = true; // prevent double taps until the server answers
  send({ type: 'done', turnOf: clientId });
};

$('leaveBtn').onclick = () => {
  if (!confirm('Leave this room?')) return;
  send({ type: 'leave' });
  exitRoom();
};

// ---------- end-of-game summary ----------
function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
function showSummary(s) {
  if (!s) return;
  const anySkips = s.players.some((p) => p.skips > 0);
  const top = Math.max(0, ...s.players.map((p) => p.turns));
  $('summaryMeta').textContent = `${s.totalTurns} turns · ${fmtDuration(s.durationMs)}`;
  $('skipsHead').classList.toggle('hidden', !anySkips);
  $('summaryRows').replaceChildren(...s.players.map((p) => {
    const tr = document.createElement('tr');
    const name = el('td', 'pname', p.name);
    if (p.left) name.append(el('em', '', 'left'));
    const turns = el('td', 'num' + (p.turns === top && top > 0 ? ' best' : ''), p.turns);
    tr.append(name, turns);
    if (anySkips) tr.append(el('td', 'num muted', p.skips || '–'));
    return tr;
  }));
  openDialog($('summaryDialog'));
}
$('resultsBtn').onclick = () => showSummary(room && room.lastSummary);

// ---------- invite (QR + link) ----------
const inviteUrl = () => `${location.origin}/${room.code}`;

function openInvite() {
  if (!room) return;
  const url = inviteUrl();
  $('inviteCode').textContent = room.code;
  $('inviteUrl').textContent = url.replace(/^https?:\/\//, '');
  try {
    const qr = qrcode(0, 'M'); // auto-size, medium error correction
    qr.addData(url);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  } catch { $('qr').textContent = 'Could not draw QR code'; }
  $('shareLinkBtn').classList.toggle('hidden', !navigator.share);
  openDialog($('inviteDialog'));
}
$('codeBtn').onclick = openInvite;
$('inviteBtn').onclick = openInvite;
$('copyLinkBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(inviteUrl()); toast('Link copied'); }
  catch { toast(inviteUrl()); }
};
$('shareLinkBtn').onclick = async () => {
  try { await navigator.share({ title: 'Join my MyTurn room', text: `Room code ${room.code}`, url: inviteUrl() }); } catch {}
};
// Tap outside the sheet to close it
$('inviteDialog').addEventListener('click', (e) => { if (e.target === $('inviteDialog')) closeDialog($('inviteDialog')); });

// ---------- your turn button style (per phone, saved like the name) ----------
const COLORS = {
  green: '#3ddc84', teal: '#2dd4bf', blue: '#4da3ff', purple: '#a77bff',
  pink: '#ff6fae', red: '#ff5c5c', orange: '#ff9f40', yellow: '#ffd23f',
};
const SHAPES = { circle: 'Circle', rounded: 'Rounded', wide: 'Wide' };
const SIZES = { s: 'Small', m: 'Medium', l: 'Large' };
// Button dimensions per shape+size, and a scaled-down version for the preview.
const DIMS = {
  circle: { s: ['min(56vw, 230px)', 'min(56vw, 230px)'], m: ['min(78vw, 320px)', 'min(78vw, 320px)'], l: ['min(92vw, 420px)', 'min(92vw, 420px)'] },
  rounded: { s: ['min(56vw, 230px)', 'min(56vw, 230px)'], m: ['min(78vw, 320px)', 'min(78vw, 320px)'], l: ['min(92vw, 420px)', 'min(92vw, 420px)'] },
  wide: { s: ['min(92vw, 440px)', '120px'], m: ['min(92vw, 440px)', '180px'], l: ['min(92vw, 440px)', '260px'] },
};
const PREVIEW = {
  circle: { s: [90, 90], m: [118, 118], l: [146, 146] },
  rounded: { s: [90, 90], m: [118, 118], l: [146, 146] },
  wide: { s: [220, 60], m: [220, 90], l: [220, 130] },
};
const RADIUS = { circle: '50%', rounded: '22%', wide: '28px' };
const DEFAULT_STYLE = { color: 'green', shape: 'circle', size: 'm' };

function loadStyle() {
  let s = {};
  try { s = JSON.parse(store.get('btn') || '{}') || {}; } catch {}
  return {
    color: COLORS[s.color] ? s.color : DEFAULT_STYLE.color,
    shape: SHAPES[s.shape] ? s.shape : DEFAULT_STYLE.shape,
    size: SIZES[s.size] ? s.size : DEFAULT_STYLE.size,
  };
}
let btnStyle = loadStyle();

function colorVars(name) {
  const hex = COLORS[name];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255; // dark text on light colors
  return { '--btn': hex, '--btn-rgb': `${r}, ${g}, ${b}`, '--btn-ink': lum > 0.55 ? '#111317' : '#ffffff' };
}
function applyButtonStyle(target, s, preview) {
  const vars = { ...colorVars(s.color), '--btn-radius': RADIUS[s.shape] };
  if (preview) {
    const [w, h] = PREVIEW[s.shape][s.size];
    Object.assign(vars, { '--pv-w': w + 'px', '--pv-h': h + 'px' });
  } else {
    const [w, h] = DIMS[s.shape][s.size];
    Object.assign(vars, { '--btn-w': w, '--btn-h': h });
  }
  for (const [k, v] of Object.entries(vars)) target.style.setProperty(k, v);
}
applyButtonStyle(document.documentElement, btnStyle);

let draftStyle = btnStyle;
function renderStyleOptions() {
  const pressed = (b, on) => b.setAttribute('aria-pressed', on ? 'true' : 'false');
  $('colorOpts').replaceChildren(...Object.entries(COLORS).map(([name, hex]) => {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.style.background = hex;
    b.setAttribute('aria-label', name);
    pressed(b, draftStyle.color === name);
    b.onclick = () => { draftStyle = { ...draftStyle, color: name }; renderStyleOptions(); };
    return b;
  }));
  const seg = (box, options, key) => box.replaceChildren(...Object.entries(options).map(([val, label]) => {
    const b = el('button', '', label);
    b.type = 'button';
    pressed(b, draftStyle[key] === val);
    b.onclick = () => { draftStyle = { ...draftStyle, [key]: val }; renderStyleOptions(); };
    return b;
  }));
  seg($('shapeOpts'), SHAPES, 'shape');
  seg($('sizeOpts'), SIZES, 'size');
  applyButtonStyle($('btnPreview'), draftStyle, true);
}

function openYouSheet() {
  $('dialogName').value = myName || $('nameInput').value.trim();
  draftStyle = { ...btnStyle };
  renderStyleOptions();
  openDialog($('nameDialog'));
}
$('meBtn').onclick = openYouSheet;
$('styleBtn').onclick = openYouSheet;
$('nameDialog').addEventListener('close', () => {
  if ($('nameDialog').returnValue !== 'ok') return;
  btnStyle = draftStyle;
  store.set('btn', JSON.stringify(btnStyle));
  applyButtonStyle(document.documentElement, btnStyle);
  const v = $('dialogName').value.trim();
  if (v && v !== myName) setName(v);
  if (room) render();
});

$('startBtn').onclick = () => send({ type: 'start' });
$('shuffleBtn').onclick = () => send({ type: 'shuffle' });
$('skipBtn').onclick = () => send({ type: 'skip' });
$('backBtn').onclick = () => send({ type: 'back' });
$('reverseBtn').onclick = () => send({ type: 'reverse' });
$('reverseBtn2').onclick = () => send({ type: 'reverse' });
$('stopBtn').onclick = () => { if (confirm('End the game for everyone?')) send({ type: 'stop' }); };

function addButton(label) {
  label = (label || '').trim();
  if (!label) return;
  send({ type: 'addButton', label });
  $('newBtnInput').value = '';
}
$('addBtnBtn').onclick = () => addButton($('newBtnInput').value);
$('newBtnInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addButton(e.target.value); });
document.querySelectorAll('[data-preset]').forEach((b) => { b.onclick = () => addButton(b.dataset.preset); });

// Hard refresh: drop the service worker + caches so the newest version loads.
async function hardRefresh() {
  $('refreshBtn').textContent = 'Refreshing…';
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {}
  location.replace(location.pathname + '?v=' + Date.now()); // bypass HTTP cache too
}
$('refreshBtn').onclick = hardRefresh;

// Auto-update: the server tells us its build on connect. If this page is older
// (the server was redeployed while the phone was open), reload onto the new version.
const PAGE_BUILD = document.querySelector('meta[name="app-build"]')?.content;
const PAGE_VERSION = document.querySelector('meta[name="app-version"]')?.content;
// Shown next to Refresh so players can compare with the host. Same build id = same code.
$('version').textContent = `v${PAGE_VERSION} · ${(PAGE_BUILD || '').slice(0, 7)}`;
function checkBuild(serverBuild) {
  if (!serverBuild || !PAGE_BUILD || serverBuild === PAGE_BUILD) return;
  let tried = null;
  try { tried = sessionStorage.getItem('myturn.updatedTo'); } catch {}
  if (tried === serverBuild) { // already tried once for this build; don't loop, just flag it
    $('version').textContent += ' · update available';
    $('version').classList.add('stale');
    return;
  }
  try { sessionStorage.setItem('myturn.updatedTo', serverBuild); } catch {}
  toast('Updating to the latest version…');
  setTimeout(hardRefresh, 600);
}

// ---------- boot ----------
$('nameInput').value = myName;
const urlCode = location.pathname.slice(1).toUpperCase();
const urlHasCode = /^[A-Z0-9]{3,8}$/.test(urlCode);
if (urlHasCode) $('codeInput').value = urlCode;
const resume = urlHasCode ? urlCode : store.get('room');
if (myName && resume) roomCode = resume; // jump straight back into the room
else if (!myName) $('nameInput').focus();
connect();
keepAwake();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
