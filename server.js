// MyTurn server: serves the PWA and relays room state over WebSockets.
// All state is in memory; rooms disappear after sitting empty for a while.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_IDLE_MS = 60 * 60 * 1000; // drop rooms nobody has touched for an hour

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

// Build id = hash of everything in public/. It changes on every deploy that changes
// the app, so phones still running an older page know to reload themselves.
function hashDir(dir, h = crypto.createHash('sha1')) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) hashDir(full, h);
    else h.update(name).update(fs.readFileSync(full));
  }
  return h;
}
const BUILD = hashDir(PUBLIC_DIR).digest('hex').slice(0, 10);
const VERSION = require('./package.json').version;

// ---------- static file server ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = decodeURIComponent(url.pathname);
  if (file === '/' || !path.extname(file)) file = '/index.html'; // SPA fallback (/ABCD links)
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    if (full.endsWith('index.html')) data = data.toString().replace('__BUILD__', BUILD).replace('__VERSION__', VERSION);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- rooms ----------
/** code -> { code, adminId, players:[{id,name}], started, current, buttons:[{id,label}], touched } */
const rooms = new Map();
/** clientId -> Set<ws> (a phone may briefly have two sockets while reconnecting) */
const sockets = new Map();

const REACTIONS = ['up', 'down', 'laugh', 'wow', 'hurry'];
const REACT_COOLDOWN_MS = 600;
const CODE_RE = /^[A-Z0-9]{3,8}$/; // what a room code may look like (custom or generated)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const clean = (s, max = 24) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const isOnline = (id) => (sockets.get(id)?.size || 0) > 0;

function publicState(room) {
  return {
    code: room.code,
    adminId: room.adminId,
    started: room.started,
    direction: room.direction,
    current: room.current,
    buttons: room.buttons,
    lastSummary: room.lastSummary || null,
    players: room.players.map((p) => ({ id: p.id, name: p.name, online: isOnline(p.id) })),
  };
}

// ---------- per-game turn stats ----------
// stats: id -> { name, turns, skips }. log: what each advance did, so "Previous" can undo it.
function stat(room, id) {
  const p = room.players.find((x) => x.id === id);
  if (!room.stats[id]) room.stats[id] = { name: p ? p.name : 'Player', turns: 0, skips: 0 };
  if (p) room.stats[id].name = p.name;
  return room.stats[id];
}
function record(room, id, kind) { // kind: 'turns' | 'skips'
  stat(room, id)[kind]++;
  room.log.push({ id, kind });
  if (room.log.length > 200) room.log.shift();
}
function buildSummary(room) {
  const seated = room.players.map((p) => p.id);
  const gone = Object.keys(room.stats).filter((id) => !seated.includes(id));
  const players = [...seated, ...gone].map((id) => {
    const s = stat(room, id);
    return { name: s.name, turns: s.turns, skips: s.skips, left: gone.includes(id) };
  });
  return {
    id: Date.now().toString(36),
    endedAt: Date.now(),
    durationMs: Date.now() - room.startedAt,
    totalTurns: players.reduce((n, p) => n + p.turns, 0),
    players,
  };
}

function sendTo(clientId, msg) {
  const data = JSON.stringify(msg);
  for (const ws of sockets.get(clientId) || []) if (ws.readyState === 1) ws.send(data);
}

function broadcast(room, msg) {
  for (const p of room.players) sendTo(p.id, msg);
}

function sync(room) {
  room.touched = Date.now();
  broadcast(room, { type: 'state', room: publicState(room) });
}

// step is +1 for "next in play order", -1 for "previous"; direction flips both.
function advance(room, step = 1) {
  step *= room.direction;
  const n = room.players.length;
  if (!n) { room.current = 0; return; }
  room.current = (((room.current + step) % n) + n) % n;
}

function removePlayer(room, playerId) {
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return;
  room.players.splice(idx, 1);
  if (idx < room.current) room.current--;
  if (room.current >= room.players.length) room.current = 0;
  if (room.adminId === playerId && room.players.length) room.adminId = room.players[0].id;
  if (!room.players.length) rooms.delete(room.code);
}

// ---------- websocket protocol ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.clientId = null;
  ws.roomCode = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const err = (message) => ws.send(JSON.stringify({ type: 'error', message }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Every phone first identifies itself with a persistent id + name.
    if (msg.type === 'hello') {
      const id = clean(msg.clientId, 64);
      if (!id) return;
      ws.clientId = id;
      ws.name = clean(msg.name) || 'Player';
      if (!sockets.has(id)) sockets.set(id, new Set());
      sockets.get(id).add(ws);
      ws.send(JSON.stringify({ type: 'welcome', build: BUILD }));
      return;
    }
    if (!ws.clientId) return;
    const me = ws.clientId;

    if (msg.type === 'create') {
      let code = newCode();
      if (msg.code) { // host picked their own code
        const wanted = String(msg.code).toUpperCase();
        if (!CODE_RE.test(wanted)) return err('Codes are 3–8 letters or numbers');
        if (rooms.has(wanted)) return err(`Room ${wanted} is already in use. Pick another code`);
        code = wanted;
      }
      const room = { code, adminId: me, players: [{ id: me, name: ws.name }], started: false, current: 0, direction: 1, buttons: [], touched: Date.now() };
      rooms.set(code, room);
      ws.roomCode = code;
      return sync(room);
    }

    if (msg.type === 'join') {
      const code = clean(msg.code, 8).toUpperCase();
      const room = rooms.get(code);
      if (!room) { sendTo(me, { type: 'gone' }); return err(`Room ${code || '?'} not found`); }
      ws.roomCode = code;
      const existing = room.players.find((p) => p.id === me);
      if (existing) existing.name = ws.name;
      else room.players.push({ id: me, name: ws.name }); // late joiners sit at the end
      return sync(room);
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const isAdmin = room.adminId === me;
    const currentId = room.players[room.current]?.id;

    switch (msg.type) {
      case 'rename': {
        ws.name = clean(msg.name) || 'Player';
        const p = room.players.find((x) => x.id === me);
        if (p) p.name = ws.name;
        return sync(room);
      }
      case 'leave': {
        removePlayer(room, me);
        ws.roomCode = null;
        if (rooms.has(room.code)) sync(room);
        return;
      }
      case 'done': // the current player ends their turn
        if (!room.started || me !== currentId) return;
        if (msg.turnOf && msg.turnOf !== me) return;
        record(room, me, 'turns');
        advance(room, 1);
        return sync(room);
      case 'press': { // a custom button like "I win"
        const b = room.buttons.find((x) => x.id === msg.buttonId);
        const p = room.players.find((x) => x.id === me);
        if (!b || !p) return;
        return broadcast(room, { type: 'announce', name: p.name, label: b.label });
      }
      case 'react': { // quick emoji popover on everyone's screen
        const p = room.players.find((x) => x.id === me);
        if (!p || !REACTIONS.includes(msg.key)) return;
        const now = Date.now();
        if (now - (ws.lastReact || 0) < REACT_COOLDOWN_MS) return;
        ws.lastReact = now;
        const target = msg.key === 'hurry' && room.started ? room.players[room.current] : null;
        if (msg.key === 'hurry' && (!target || target.id === me)) return;
        return broadcast(room, { type: 'react', key: msg.key, name: p.name, fromId: me, targetId: target?.id, targetName: target?.name });
      }
    }

    if (!isAdmin) return err('Only the host can do that');

    switch (msg.type) {
      case 'move': { // reorder seating
        const i = room.players.findIndex((p) => p.id === msg.playerId);
        const j = i + (msg.dir < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= room.players.length) return;
        const cur = currentId;
        [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
        room.current = Math.max(0, room.players.findIndex((p) => p.id === cur));
        return sync(room);
      }
      case 'shuffle': {
        const cur = currentId;
        for (let i = room.players.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
        }
        room.current = room.started ? Math.max(0, room.players.findIndex((p) => p.id === cur)) : 0;
        return sync(room);
      }
      case 'kick':
        if (msg.playerId === me) return;
        sendTo(msg.playerId, { type: 'kicked' });
        for (const s of sockets.get(msg.playerId) || []) if (s.roomCode === room.code) s.roomCode = null;
        removePlayer(room, msg.playerId);
        return sync(room);
      case 'start': {
        room.started = true;
        room.startedAt = Date.now();
        room.stats = {};
        room.log = [];
        for (const p of room.players) stat(room, p.id);
        const first = room.players.findIndex((p) => p.id === msg.firstId);
        room.current = first >= 0 ? first : 0;
        return sync(room);
      }
      case 'reverse': {
        room.direction = -room.direction;
        sync(room);
        return broadcast(room, { type: 'notice', message: 'Turn order reversed ⇄' });
      }
      case 'stop': {
        if (!room.started) return;
        room.lastSummary = buildSummary(room);
        room.started = false;
        room.current = 0;
        sync(room);
        return broadcast(room, { type: 'summary', summary: room.lastSummary });
      }
      case 'skip':
        if (!room.started) return;
        record(room, currentId, 'skips');
        advance(room, 1);
        return sync(room);
      case 'back': { // undo: the player we return to gets that turn/skip taken back
        if (!room.started) return;
        advance(room, -1);
        const last = room.log[room.log.length - 1];
        const backTo = room.players[room.current]?.id;
        if (last && last.id === backTo) {
          room.log.pop();
          stat(room, backTo)[last.kind] = Math.max(0, stat(room, backTo)[last.kind] - 1);
        }
        return sync(room);
      }
      case 'setTurn': {
        const i = room.players.findIndex((p) => p.id === msg.playerId);
        if (!room.started || i < 0) return;
        room.current = i;
        room.log = []; // jumping around: nothing sensible to undo
        return sync(room);
      }
      case 'addButton': {
        const label = clean(msg.label, 20);
        if (!label || room.buttons.length >= 6) return;
        room.buttons.push({ id: Math.random().toString(36).slice(2, 9), label });
        return sync(room);
      }
      case 'removeButton':
        room.buttons = room.buttons.filter((b) => b.id !== msg.buttonId);
        return sync(room);
    }
  });

  ws.on('close', () => {
    const set = sockets.get(ws.clientId);
    if (set) { set.delete(ws); if (!set.size) sockets.delete(ws.clientId); }
    const room = rooms.get(ws.roomCode);
    if (room) sync(room); // update online dots
  });
});

// Heartbeat: drop dead sockets (phones that went offline without closing).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS && !room.players.some((p) => isOnline(p.id))) rooms.delete(code);
  }
}, 30000);

server.listen(PORT, () => console.log(`MyTurn v${VERSION} (build ${BUILD}) running on http://localhost:${PORT}`));
