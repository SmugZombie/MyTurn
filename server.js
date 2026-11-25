// MyTurn server: serves the PWA and relays room state over WebSockets.
// All state is in memory; rooms disappear after sitting empty for a while.
const http = require('http');
const fs = require('fs');
const path = require('path');
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

// ---------- static file server ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = decodeURIComponent(url.pathname);
  if (file === '/' || !path.extname(file)) file = '/index.html'; // SPA fallback (/ABCD links)
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
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
    current: room.current,
    buttons: room.buttons,
    players: room.players.map((p) => ({ id: p.id, name: p.name, online: isOnline(p.id) })),
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

function advance(room, step = 1) {
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
      return;
    }
    if (!ws.clientId) return;
    const me = ws.clientId;

    if (msg.type === 'create') {
      const code = newCode();
      const room = { code, adminId: me, players: [{ id: me, name: ws.name }], started: false, current: 0, buttons: [], touched: Date.now() };
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
        advance(room, 1);
        return sync(room);
      case 'press': { // a custom button like "I win"
        const b = room.buttons.find((x) => x.id === msg.buttonId);
        const p = room.players.find((x) => x.id === me);
        if (!b || !p) return;
        return broadcast(room, { type: 'announce', name: p.name, label: b.label });
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
        const first = room.players.findIndex((p) => p.id === msg.firstId);
        room.current = first >= 0 ? first : 0;
        return sync(room);
      }
      case 'stop':
        room.started = false;
        room.current = 0;
        return sync(room);
      case 'skip':
        if (!room.started) return;
        advance(room, 1);
        return sync(room);
      case 'back':
        if (!room.started) return;
        advance(room, -1);
        return sync(room);
      case 'setTurn': {
        const i = room.players.findIndex((p) => p.id === msg.playerId);
        if (!room.started || i < 0) return;
        room.current = i;
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

server.listen(PORT, () => console.log(`MyTurn running on http://localhost:${PORT}`));
