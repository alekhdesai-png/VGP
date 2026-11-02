'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SCORING, scoreGuess } = require('./scoring');
const { parseMoney, cleanText, cleanName, cleanPopulation, parseBulk } = require('./validate');

const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');
const MAX_PLAYERS = 50;

class GameError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const SAMPLE_ITEMS = [
  { name: 'Charizard Holo #4 (sample)', set: '1999 Pokémon Base Set', population: '4,200', grade: 'PSA 8', price: 1250 },
  { name: 'Mickey Mantle #253 (sample)', set: '1955 Bowman', population: '310', grade: 'PSA 5', price: 1800 },
  { name: 'Michael Jordan #57 (sample)', set: '1986-87 Fleer', population: '22,000', grade: 'PSA 7', price: 1450 },
];

const fmtMoney = (n) =>
  '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

function questionText(item) {
  const bits = [item.grade, item.set].filter(Boolean).join(' · ');
  return `What is this ${item.name}${bits ? ` (${bits})` : ''} worth?`;
}

class Game {
  constructor({ dataDir, pin, seed = true, log = console.log }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'game.json');
    this.uploadsDir = path.join(dataDir, 'uploads');
    this.log = log;
    fs.mkdirSync(this.uploadsDir, { recursive: true });

    this.online = new Map(); // playerId -> open connection count (memory only)
    this.lanUrl = '';
    this.tunnelUrl = '';
    this.listeners = new Set();

    this.s = this._load(seed);
    if (pin) this.s.adminPin = String(pin);
    if (!/^\d{4,8}$/.test(this.s.adminPin || '')) this.s.adminPin = String(crypto.randomInt(1000, 10000));
    this._save();
  }

  static blank() {
    return {
      version: 1,
      adminPin: '',
      adminTokens: [],
      items: [],
      players: [],
      guesses: {}, // itemId -> playerId -> { amount, at }
      currentId: null,
      phase: 'lobby', // lobby | open | closed | revealed | finished
      publicUrl: '',
    };
  }

  _load(seed) {
    if (fs.existsSync(this.file)) {
      try {
        return Object.assign(Game.blank(), JSON.parse(fs.readFileSync(this.file, 'utf8')));
      } catch (e) {
        const bad = this.file.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
        fs.renameSync(this.file, bad);
        this.log(`!! game.json was unreadable; moved to ${bad} and started fresh`);
      }
    }
    const s = Game.blank();
    if (seed) s.items = SAMPLE_ITEMS.map((it) => this._makeItem(it));
    return s;
  }

  /** Atomic write: temp file + rename, so a crash mid-write can't corrupt state. */
  _save() {
    this.s.updatedAt = Date.now();
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.s, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _changed() {
    this._save();
    this._notify();
  }

  _notify() {
    for (const fn of this.listeners) fn();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- lookups ----------
  get pin() { return this.s.adminPin; }
  item(id) { return this.s.items.find((i) => i.id === id) || null; }
  get current() { return this.s.currentId ? this.item(this.s.currentId) : null; }
  playerByToken(token) {
    if (!token || typeof token !== 'string') return null;
    return this.s.players.find((p) => p.token === token) || null;
  }
  get joinUrl() { return this.s.publicUrl || this.tunnelUrl || this.lanUrl; }

  // ---------- players ----------
  join(rawName) {
    const name = cleanName(rawName);
    if (!name) throw new GameError('Please enter a name.');
    if (this.s.players.length >= MAX_PLAYERS) throw new GameError('The game is full.', 403);
    const taken = (n) => this.s.players.some((p) => p.name.toLowerCase() === n.toLowerCase());
    if (taken(name)) {
      let k = 2;
      while (taken(`${name.slice(0, 17)} ${k}`)) k++;
      const suggestion = `${name.slice(0, 17)} ${k}`;
      throw new GameError(`"${name}" is already playing. Try "${suggestion}" or add your last initial.`, 409, { suggestion });
    }
    const player = { id: newId(), name, token: newId(24), joinedAt: Date.now() };
    this.s.players.push(player);
    this._changed();
    return player;
  }

  removePlayer(id) {
    const before = this.s.players.length;
    this.s.players = this.s.players.filter((p) => p.id !== id);
    if (this.s.players.length === before) throw new GameError('Player not found', 404);
    for (const g of Object.values(this.s.guesses)) delete g[id];
    this._changed();
  }

  renamePlayer(id, rawName) {
    const p = this.s.players.find((x) => x.id === id);
    if (!p) throw new GameError('Player not found', 404);
    const name = cleanName(rawName);
    if (!name) throw new GameError('Name required');
    if (this.s.players.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase()))
      throw new GameError('That name is taken', 409);
    p.name = name;
    this._changed();
  }

  setOnline(playerId, delta) {
    const n = (this.online.get(playerId) || 0) + delta;
    if (n <= 0) this.online.delete(playerId); else this.online.set(playerId, n);
    this._notify(); // presence is not persisted
  }

  submitGuess(token, itemId, raw) {
    const p = this.playerByToken(token);
    if (!p) throw new GameError('You are not in this game. Please join again.', 401);
    const cur = this.current;
    if (!cur || this.s.phase !== 'open') throw new GameError('Guessing is closed for this item.', 409);
    if (itemId !== cur.id) throw new GameError('The host has moved on to a different item.', 409);
    const amount = parseMoney(raw);
    if (amount === null) throw new GameError('Enter a dollar amount greater than 0 (e.g. 250 or 1,200.50).');
    const g = (this.s.guesses[cur.id] ||= {});
    if (g[p.id]) throw new GameError(`You already locked in ${fmtMoney(g[p.id].amount)}.`, 409);
    g[p.id] = { amount, at: Date.now() };
    this._changed();
    return amount;
  }

  // ---------- admin auth ----------
  login(pin) {
    if (String(pin || '') !== this.s.adminPin) throw new GameError('Wrong PIN', 401);
    const token = newId(24);
    this.s.adminTokens = [...(this.s.adminTokens || []), token].slice(-20);
    this._save();
    return token;
  }
  isAdmin(token) { return !!token && (this.s.adminTokens || []).includes(token); }

  // ---------- items ----------
  _makeItem(data) {
    const name = cleanText(data.name);
    if (!name) throw new GameError('Card / item name is required.');
    const price = parseMoney(data.price);
    if (price === null) throw new GameError('True price must be a dollar amount greater than 0.');
    return {
      id: newId(),
      name,
      set: cleanText(data.set),
      population: cleanPopulation(data.population),
      grade: cleanText(data.grade, 40),
      price,
      photo: data.photo || null,
      revealed: false,
      createdAt: Date.now(),
    };
  }

  addItem(data) {
    const item = this._makeItem(data);
    this.s.items.push(item);
    this._changed();
    return item;
  }

  updateItem(id, data) {
    const item = this.item(id);
    if (!item) throw new GameError('Item not found', 404);
    if ('name' in data) {
      const name = cleanText(data.name);
      if (!name) throw new GameError('Card / item name is required.');
      item.name = name;
    }
    if ('set' in data) item.set = cleanText(data.set);
    if ('population' in data) item.population = cleanPopulation(data.population);
    if ('grade' in data) item.grade = cleanText(data.grade, 40);
    if ('price' in data) {
      const price = parseMoney(data.price);
      if (price === null) throw new GameError('True price must be a dollar amount greater than 0.');
      item.price = price;
    }
    if ('photo' in data) {
      if (item.photo && item.photo !== data.photo) this._deletePhoto(item.photo);
      item.photo = data.photo || null;
    }
    this._changed();
    return item;
  }

  deleteItem(id) {
    const item = this.item(id);
    if (!item) throw new GameError('Item not found', 404);
    this.s.items = this.s.items.filter((i) => i.id !== id);
    delete this.s.guesses[id];
    if (this.s.currentId === id) { this.s.currentId = null; this.s.phase = 'lobby'; }
    if (item.photo) this._deletePhoto(item.photo);
    this._changed();
  }

  moveItem(id, dir) {
    const i = this.s.items.findIndex((x) => x.id === id);
    if (i < 0) throw new GameError('Item not found', 404);
    const j = i + (dir === 'up' ? -1 : 1);
    if (j < 0 || j >= this.s.items.length) return;
    [this.s.items[i], this.s.items[j]] = [this.s.items[j], this.s.items[i]];
    this._changed();
  }

  bulkAdd(text) {
    const { items, errors } = parseBulk(text);
    for (const it of items) this.s.items.push(this._makeItem(it));
    if (items.length) this._changed();
    return { added: items.length, errors };
  }

  _deletePhoto(url) {
    const m = /^\/uploads\/([a-f0-9]+\.(?:jpg|png|webp|gif))$/.exec(url || '');
    if (m) fs.rm(path.join(this.uploadsDir, m[1]), { force: true }, () => {});
  }

  savePhoto(dataUrl) {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || '');
    if (!m) throw new GameError('Photo must be a JPG, PNG, WEBP or GIF image.');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 12 * 1024 * 1024) throw new GameError('Photo is too large (max 12 MB).');
    const file = `${newId(10)}.${ext}`;
    fs.writeFileSync(path.join(this.uploadsDir, file), buf);
    return `/uploads/${file}`;
  }

  // ---------- flow ----------
  start(itemId) {
    const item = this.item(itemId);
    if (!item) throw new GameError('Item not found', 404);
    this.s.currentId = item.id;
    item.revealed = false;
    this.s.phase = 'open';
    this._changed();
  }

  close() {
    if (this.s.phase !== 'open') throw new GameError('Guessing is not open.', 409);
    this.s.phase = 'closed';
    this._changed();
  }

  reveal() {
    const cur = this.current;
    if (!cur) throw new GameError('No item in play.', 409);
    if (!['open', 'closed'].includes(this.s.phase)) throw new GameError('Nothing to reveal.', 409);
    cur.revealed = true;
    this.s.phase = 'revealed';
    this._changed();
  }

  next() {
    const items = this.s.items;
    const idx = items.findIndex((i) => i.id === this.s.currentId);
    const after = items.slice(idx + 1).find((i) => !i.revealed);
    const any = items.find((i) => !i.revealed && i.id !== this.s.currentId);
    const nxt = after || any;
    if (nxt) return this.start(nxt.id);
    this.s.currentId = null;
    this.s.phase = 'finished';
    this._changed();
  }

  reset(mode) {
    this.s.guesses = {};
    this.s.currentId = null;
    this.s.phase = 'lobby';
    for (const i of this.s.items) i.revealed = false;
    if (mode === 'players' || mode === 'all') this.s.players = [];
    if (mode === 'all') {
      this.s.items = [];
      for (const f of fs.readdirSync(this.uploadsDir)) fs.rmSync(path.join(this.uploadsDir, f), { force: true });
    }
    this._changed();
  }

  setPublicUrl(url) {
    url = cleanText(url, 200).replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new GameError('URL must start with http:// or https://');
    this.s.publicUrl = url ? url + '/' : '';
    this._changed();
  }

  // ---------- scoring / views ----------
  _scoreFor(item, playerId) {
    const g = this.s.guesses[item.id]?.[playerId];
    if (!g) return null;
    return { guess: g.amount, at: g.at, ...scoreGuess(g.amount, item.price) };
  }

  results(item) {
    return this.s.players
      .map((p) => {
        const sc = this._scoreFor(item, p.id);
        return sc ? { playerId: p.id, name: p.name, ...sc, missed: false } : { playerId: p.id, name: p.name, missed: true, points: 0 };
      })
      .sort((a, b) => (a.missed - b.missed) || (b.points - a.points) || ((a.pctError ?? 9) - (b.pctError ?? 9)));
  }

  leaderboard() {
    const cap = SCORING.maxErrorPerItem;
    const revealed = this.s.items.filter((i) => i.revealed);
    const rows = this.s.players.map((p) => {
      let points = 0, errorSum = 0, guessed = 0;
      for (const it of revealed) {
        const sc = this._scoreFor(it, p.id);
        if (sc) { points += sc.points; errorSum += Math.min(sc.pctError, cap); guessed++; } else errorSum += cap;
      }
      return { id: p.id, name: p.name, points, errorSum, guessed, online: this.online.has(p.id) };
    });
    rows.sort((a, b) => (b.points - a.points) || (a.errorSum - b.errorSum) || a.name.localeCompare(b.name));
    rows.forEach((r, i) => {
      const prev = rows[i - 1];
      r.rank = prev && prev.points === r.points && Math.abs(prev.errorSum - r.errorSum) < 1e-9 ? prev.rank : i + 1;
    });
    return { rows, revealedCount: revealed.length };
  }

  _publicItem(item) {
    if (!item) return null;
    const out = {
      id: item.id, name: item.name, set: item.set, population: item.population,
      grade: item.grade, photo: item.photo, question: questionText(item),
    };
    if (item.revealed) out.price = item.price; // ONLY after host reveal
    return out;
  }

  _baseView() {
    const cur = this.current;
    const g = cur ? this.s.guesses[cur.id] || {} : {};
    const lb = this.leaderboard();
    return {
      phase: this.s.phase,
      item: this._publicItem(cur),
      itemNumber: cur ? this.s.items.indexOf(cur) + 1 : 0,
      itemCount: this.s.items.length,
      revealedCount: lb.revealedCount,
      guessCount: Object.keys(g).length,
      playerCount: this.s.players.length,
      players: this.s.players.map((p) => ({ id: p.id, name: p.name, online: this.online.has(p.id), hasGuessed: !!g[p.id] })),
      leaderboard: lb.rows.map(({ id, name, points, rank, online, guessed }) => ({ id, name, points, rank, online, guessed })),
      results: cur && cur.revealed ? this.results(cur) : null,
      joinUrl: this.joinUrl,
    };
  }

  viewFor(role, player) {
    const v = this._baseView();
    if (role === 'player') {
      const cur = this.current;
      const lbRow = v.leaderboard.find((r) => r.id === player.id);
      v.me = { id: player.id, name: player.name, points: lbRow?.points || 0, rank: lbRow?.rank || null, of: v.playerCount };
      const mine = cur && this.s.guesses[cur.id]?.[player.id];
      v.myGuess = mine ? mine.amount : null;
      v.myResult = cur && cur.revealed ? v.results.find((r) => r.playerId === player.id) || null : null;
    }
    if (role === 'admin') {
      const cur = this.current;
      v.items = this.s.items.map((i) => ({
        ...i, question: questionText(i), guessCount: Object.keys(this.s.guesses[i.id] || {}).length,
      }));
      v.liveGuesses = cur
        ? this.s.players.map((p) => {
            const sc = this._scoreFor(cur, p.id);
            return sc ? { playerId: p.id, name: p.name, ...sc } : { playerId: p.id, name: p.name, missed: true };
          }).sort((a, b) => (a.at || 9e15) - (b.at || 9e15))
        : [];
      v.currentPrice = cur ? cur.price : null;
      v.urls = { lan: this.lanUrl, tunnel: this.tunnelUrl, public: this.s.publicUrl, join: this.joinUrl };
      v.scoring = SCORING;
    }
    return v;
  }
}

module.exports = { Game, GameError, questionText, SAMPLE_ITEMS };
