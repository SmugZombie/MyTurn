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
  const nextIdx = n ? (room.current + 1) % n : -1;
  const myTurn = room.started && cur && cur.id === clientId;

  // Status line
  if (!room.started) {
    $('status').textContent = isHost
      ? (n < 2 ? 'Share the room code so others can join' : 'Arrange the seats, then start')
      : 'Waiting for the host to start…';
  } else {
    $('status').textContent = n > 1 ? `Next up: ${players[nextIdx].name}` : '';
  }

  $('inviteBtn').classList.toggle('hidden', room.started);

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
      const wait = meIdx < 0 ? -1 : (meIdx - room.current + n) % n;
      $('turnSub').textContent = wait === 1 ? 'You’re up next' : wait > 1 ? `${wait} turns until you` : '';
    }
  }
  document.body.classList.toggle('my-turn', !!myTurn);
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

// ---------- feedback ----------
let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 2500);
}

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

$('createBtn').onclick = () => {
  if (!requireName()) return;
  send({ type: 'create' });
};

function join() {
  const code = $('codeInput').value.trim().toUpperCase();
  if (!requireName()) return;
  if (code.length !== 4) { $('codeInput').focus(); return toast('Enter the 4-letter room code'); }
  roomCode = code;
  send({ type: 'join', code });
}
$('joinBtn').onclick = join;
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });

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
  $('inviteDialog').showModal();
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
$('inviteDialog').addEventListener('click', (e) => { if (e.target === $('inviteDialog')) $('inviteDialog').close(); });

$('meBtn').onclick = () => {
  $('dialogName').value = myName;
  $('nameDialog').showModal();
};
$('nameDialog').addEventListener('close', () => {
  const v = $('dialogName').value.trim();
  if ($('nameDialog').returnValue === 'ok' && v) { setName(v); if (room) render(); }
});

$('startBtn').onclick = () => send({ type: 'start' });
$('shuffleBtn').onclick = () => send({ type: 'shuffle' });
$('skipBtn').onclick = () => send({ type: 'skip' });
$('backBtn').onclick = () => send({ type: 'back' });
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
$('refreshBtn').onclick = async () => {
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
};

// ---------- boot ----------
$('nameInput').value = myName;
const urlCode = location.pathname.slice(1).toUpperCase();
if (/^[A-Z]{4}$/.test(urlCode)) $('codeInput').value = urlCode;
const resume = /^[A-Z]{4}$/.test(urlCode) ? urlCode : store.get('room');
if (myName && resume) roomCode = resume; // jump straight back into the room
else if (!myName) $('nameInput').focus();
connect();
keepAwake();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
