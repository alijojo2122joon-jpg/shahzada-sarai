/*
 * Shahzada Sarai — Node.js server (zero external dependencies).
 * - Serves the RTL web app from /public
 * - JSON API under /api, backed by SQLite (node:sqlite, built into Node 22+)
 * - Server-Sent Events at /api/stream for real-time updates
 * Run:  node server.js     (PORT, DB_PATH, SEED=0 optional)
 */
'use strict';
process.removeAllListeners('warning');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const Engine = require('./shared/engine.js');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sarai.db');
const SESSION_DAYS = 30;
// Unlisted address of the admin panel. Change it with the ADMIN_PATH environment variable.
const ADMIN_PATH = '/' + String(process.env.ADMIN_PATH || 'sh-panel-7319').replace(/^\/+|\/+$/g, '');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/* ---------- storage ---------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS event_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor_id INTEGER, type TEXT NOT NULL, ref TEXT, detail TEXT, hash TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS event_log_no_update BEFORE UPDATE ON event_log BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS event_log_no_delete BEFORE DELETE ON event_log BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;
`);

const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
};
const verifyPassword = (pw, stored) => {
  const [alg, salt, hex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const a = crypto.scryptSync(pw, salt, 32), b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

let state;
let lastLoggedAudit = (db.prepare('SELECT MAX(id) AS m FROM event_log').get().m) || 0;
const row =db.prepare('SELECT json FROM app_state WHERE id = 1').get();
if (row) state = JSON.parse(row.json);
else {
  state = Engine.emptyState();
  if (process.env.SEED !== '0') Engine.seed(state, { now: Date.now(), hashPassword });
  persist();
}

function persist() {
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO app_state (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(JSON.stringify(state), Date.now());
    const ins = db.prepare('INSERT INTO event_log (id, at, actor_id, type, ref, detail, hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const e of state.audit) {
      if (e.id > (lastLoggedAudit || 0)) { ins.run(e.id, e.at, e.actorId, e.type, e.ref, e.detail, e.hash); lastLoggedAudit = e.id; }
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

/* Every mutation runs on a snapshot; only a successful action is committed. Node's single thread
   plus synchronous SQLite means two approvals can never interleave (no over-allocation). */
function mutate(fn) {
  const snapshot = JSON.stringify(state);
  try {
    const result = fn(state);
    persist();
    broadcast();
    return result;
  } catch (err) {
    state = JSON.parse(snapshot);
    throw err;
  }
}

/* ---------- sessions ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(sha(token), userId, now, now + SESSION_DAYS * 864e5);
  return token;
}
function sessionUser(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  const token = m ? m[1] : (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const s = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha(token));
  if (!s || s.expires_at < Date.now()) return null;
  const u = state.users.find((x) => x.id === s.user_id);
  return u && u.status !== 'blocked' ? u.id : null;
}
const cookie = (token, maxAge) => `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.SECURE_COOKIE === '1' ? '; Secure' : ''}`;

/* ---------- simple rate limit for auth ---------- */
const hits = new Map();
function limited(key, max = 10, windowMs = 10 * 60e3) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}

/* ---------- real-time (SSE) ---------- */
const clients = new Set();
function broadcast() {
  const msg = `event: changed\ndata: ${state.version}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25e3).unref();
setInterval(() => { // expire orders even when nobody is acting
  const before = state.version;
  if (Engine.sweep(state, Date.now())) { state.version = before + 1; persist(); broadcast(); }
}, 60e3).unref();

/* ---------- http ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Engine.EngineError('JSON نامعتبر')); } });
  });
}
const STATUS = { bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409 };

async function api(req, res, url) {
  const ip = req.socket.remoteAddress;
  const uid = sessionUser(req);
  const now = Date.now();
  const p = url.pathname;

  if (p === '/api/health') return send(res, 200, { ok: true, mode: 'server', version: state.version });
  if (p === '/api/state' && req.method === 'GET') return send(res, 200, Engine.buildView(state, uid, { now }));
  if (p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: changed\ndata: ${state.version}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  // CSRF guard: same-origin JSON only.
  if (!String(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'JSON required' });
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-origin request blocked' });

  const body = await readBody(req);
  if (p === '/api/register') {
    if (limited('reg:' + ip, 5)) return send(res, 429, { error: 'تعداد درخواست زیاد است؛ بعداً تلاش کنید' });
    const user = mutate((s) => Engine.register(s, body, { now, hashPassword }));
    const token = createSession(user.id);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(token, SESSION_DAYS * 86400) });
  }
  if (p === '/api/login') {
    if (limited('login:' + ip, 10)) return send(res, 429, { error: 'تلاش‌های زیاد؛ ۱۰ دقیقه بعد دوباره امتحان کنید' });
    const user = Engine.login(state, body, { verifyPassword });
    const token = createSession(user.id);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(token, SESSION_DAYS * 86400) });
  }
  if (p === '/api/logout') {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
    if (m) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(m[1]));
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }
  if (p === '/api/password') {
    const me = state.users.find((u) => u.id === uid);
    if (!me) return send(res, 401, { error: 'ابتدا وارد شوید' });
    if (!verifyPassword(String(body.current || ''), me.passHash)) return send(res, 400, { error: 'رمز فعلی اشتباه است' });
    if (String(body.next || '').length < 6) return send(res, 400, { error: 'رمز جدید باید حداقل ۶ حرف باشد' });
    mutate(() => { me.passHash = hashPassword(String(body.next)); });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/action') {
    const result = mutate((s) => Engine.dispatch(s, uid, String(body.type || ''), body.payload, { now }));
    return send(res, 200, { ok: true, result });
  }
  return send(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === ADMIN_PATH + '/') { res.writeHead(301, { Location: ADMIN_PATH }); return res.end(); }
  if (rel === ADMIN_PATH) {
    return fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...SECURITY_HEADERS });
      res.end(html.replace('<html lang="fa" dir="rtl">', '<html lang="fa" dir="rtl" data-mode="admin">').replace('<link rel="manifest" href="manifest.webmanifest">', ''));
    });
  }
  if (rel === '/') rel = '/index.html';
  const baseDir = rel.startsWith('/shared/') ? __dirname : path.join(__dirname, 'public');
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof Engine.EngineError) return send(res, STATUS[err.code] || 400, { error: err.message });
    console.error(err);
    send(res, 500, { error: 'خطای داخلی سرور' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Shahzada Sarai running → http://localhost:${PORT}`));
}
module.exports = { server };
