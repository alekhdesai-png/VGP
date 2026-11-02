'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { Game, GameError } = require('./lib/game');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const WANT_TUNNEL = process.argv.includes('--tunnel') || process.env.TUNNEL === '1';
const QUIET = process.env.QUIET === '1';
const log = (...a) => { if (!QUIET) console.log(...a); };

const game = new Game({ dataDir: DATA_DIR, pin: process.env.ADMIN_PIN, seed: process.env.NO_SEED !== '1', log });

// ---------- LAN address ----------
function lanIp() {
  const cands = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      let score = 0;
      if (/^192\.168\./.test(a.address)) score += 3;
      else if (/^10\./.test(a.address)) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 1;
      if (/^(en|eth|wl|wi-?fi|wlan)/i.test(name)) score += 2;          // real adapters first
      if (/(vmnet|vbox|docker|utun|tailscale|zt|br-|veth)/i.test(name)) score -= 5; // virtual last
      cands.push({ address: a.address, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return cands[0]?.address || 'localhost';
}
const LAN = lanIp();
game.lanUrl = `http://${LAN}:${PORT}/`;

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

const pub = path.join(__dirname, 'public');
const page = (f) => (req, res) => res.sendFile(path.join(pub, f));
app.get('/', page('player.html'));
app.get('/tv', page('tv.html'));
app.get('/admin', page('admin.html'));
app.use('/static', express.static(pub, { index: false }));
app.use('/uploads', express.static(game.uploadsDir, { index: false, maxAge: '1h' }));

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    if (e instanceof GameError) return res.status(e.status).json({ error: e.message, suggestion: e.suggestion });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};

// Player API
app.post('/api/join', wrap((req) => {
  const p = game.join(req.body?.name);
  return { token: p.token, id: p.id, name: p.name };
}));
app.post('/api/guess', wrap((req) => {
  const amount = game.submitGuess(req.body?.token, req.body?.itemId, req.body?.amount);
  return { ok: true, amount };
}));

app.get('/api/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(game.joinUrl, { type: 'svg', margin: 1, color: { dark: '#1a130c', light: '#f3e6c8' } });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});

// Admin auth with brute-force throttle (4-digit PIN = only 10,000 combos)
const fails = new Map();
app.post('/api/admin/login', wrap((req) => {
  const ip = req.ip;
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) throw new GameError('Too many wrong PINs. Wait a minute and try again.', 429);
  try {
    const token = game.login(req.body?.pin);
    fails.delete(ip);
    return { token };
  } catch (e) {
    f.n++;
    if (f.n >= 5) { f.until = Date.now() + 60_000; f.n = 0; }
    fails.set(ip, f);
    throw e;
  }
}));

const admin = express.Router();
admin.use((req, res, next) => {
  if (!game.isAdmin(req.get('x-admin-token'))) return res.status(401).json({ error: 'Admin login required' });
  next();
});
const withPhoto = (body) => {
  const data = { ...body };
  delete data.photoData;
  if (body.photoData) data.photo = game.savePhoto(body.photoData);
  if (body.removePhoto) data.photo = null;
  return data;
};
admin.get('/state', wrap(() => game.viewFor('admin')));
admin.post('/items', wrap((req) => game.addItem(withPhoto(req.body || {}))));
admin.put('/items/:id', wrap((req) => game.updateItem(req.params.id, withPhoto(req.body || {}))));
admin.delete('/items/:id', wrap((req) => game.deleteItem(req.params.id)));
admin.post('/items/:id/move', wrap((req) => game.moveItem(req.params.id, req.body?.dir)));
admin.post('/bulk', wrap((req) => game.bulkAdd(req.body?.text)));
admin.post('/start', wrap((req) => game.start(req.body?.itemId)));
admin.post('/close', wrap(() => game.close()));
admin.post('/reveal', wrap(() => game.reveal()));
admin.post('/next', wrap(() => game.next()));
admin.post('/reset', wrap((req) => game.reset(req.body?.mode)));
admin.delete('/players/:id', wrap((req) => game.removePlayer(req.params.id)));
admin.put('/players/:id', wrap((req) => game.renamePlayer(req.params.id, req.body?.name)));
admin.post('/settings', wrap((req) => game.setPublicUrl(req.body?.publicUrl)));
app.use('/api/admin', admin);

// ---------- WebSockets ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const role = q.get('role');
  const token = q.get('token');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (m) => { if (String(m) === 'ping') ws.send('pong'); });

  if (role === 'player') {
    const p = game.playerByToken(token);
    if (!p) { ws.send(JSON.stringify({ type: 'kicked' })); return ws.close(); }
    ws.role = 'player'; ws.playerId = p.id;
    game.setOnline(p.id, +1);
    ws.on('close', () => game.setOnline(p.id, -1));
  } else if (role === 'admin') {
    if (!game.isAdmin(token)) { ws.send(JSON.stringify({ type: 'unauthorized' })); return ws.close(); }
    ws.role = 'admin';
  } else {
    ws.role = 'tv';
  }
  sendState(ws);
});

function sendState(ws, cache = {}) {
  if (ws.readyState !== 1) return;
  let data;
  if (ws.role === 'player') {
    const p = game.s.players.find((x) => x.id === ws.playerId);
    if (!p) { ws.send(JSON.stringify({ type: 'kicked' })); return ws.close(); }
    data = game.viewFor('player', p);
  } else {
    data = cache[ws.role] ||= game.viewFor(ws.role);
  }
  ws.send(JSON.stringify({ type: 'state', data }));
}

let pending = false;
function broadcast() {
  if (pending) return;
  pending = true;
  setImmediate(() => {
    pending = false;
    const cache = {};
    for (const ws of wss.clients) sendState(ws, cache);
  });
}
game.onChange(broadcast);

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

// ---------- Internet tunnel (optional) ----------
function startTunnel() {
  const args = ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`];
  const tryRun = (cmd, cmdArgs, fallback) => {
    const child = spawn(cmd, cmdArgs, { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let found = false, lastErr = '';
    const giveUp = setTimeout(() => {
      if (!found) log(`  !! No tunnel URL after 45s. Last cloudflared message:\n     ${lastErr || '(none)'}\n     Check your internet connection, or use the Wi-Fi URL.`);
    }, 45_000);
    const onData = (buf) => {
      const text = String(buf);
      const errLine = text.split('\n').find((l) => /\bERR\b|error|failed/i.test(l));
      if (errLine) lastErr = errLine.trim().slice(0, 300);
      // Quick-tunnel hostnames look like https://word-word-word.trycloudflare.com (never api.)
      const m = text.match(/https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
      if (m && !found) {
        found = true;
        clearTimeout(giveUp);
        game.tunnelUrl = m[0] + '/';
        game._notify();
        log(`\n  🌐 Internet URL (share this / it's on the TV QR now): ${game.tunnelUrl}\n`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => {
      clearTimeout(giveUp);
      if (fallback) fallback();
      else log('  !! Could not start cloudflared. See README → "Playing over the internet".');
    });
    child.on('exit', (code) => {
      if (!found && fallback && code !== 0) { clearTimeout(giveUp); return fallback(); }
      if (found) { game.tunnelUrl = ''; game._notify(); log('  !! Tunnel stopped; QR is back to the Wi-Fi address.'); }
    });
    process.on('exit', () => child.kill());
  };
  log('  Starting internet tunnel (cloudflared)… this takes ~5-15 seconds.');
  tryRun('cloudflared', args, () => {
    log('  cloudflared not installed; fetching it via npx (first time only)…');
    tryRun('npx', ['--yes', 'cloudflared', ...args], null);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  const local = `http://localhost:${PORT}`;
  log(`
  ╔════════════════════════════════════════════════════════════╗
  ║               GUESS THE PRICE — server running             ║
  ╚════════════════════════════════════════════════════════════╝
    Players (phones):  ${game.lanUrl}
    TV / big screen:   ${local}/tv
    Admin panel:       ${local}/admin
    Admin PIN:         ${game.pin}${process.env.ADMIN_PIN ? '  (from ADMIN_PIN)' : '  (set ADMIN_PIN=1234 to choose your own)'}
    Game data:         ${game.file}
  `);
  if (WANT_TUNNEL) startTunnel();
});

const shutdown = () => { server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, game };
