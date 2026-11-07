/*
 * Shahzada Sarai — Node.js server (no external dependencies; Node 22+).
 *  - Web app from /public, admin panel at an unlisted path (ADMIN_PATH)
 *  - JSON API under /api backed by indexed SQLite tables (sqlstore.js)
 *  - Separate user and admin sessions; admin sessions need TOTP (when enabled), expire when idle
 *  - Re-entry of the admin password for sensitive actions (official rates, roles, assets, broadcasts)
 *  - Per-account lockout, per-IP and per-user rate limits, strict security headers
 *  - Targeted real-time updates over Server-Sent Events
 *
 * Environment: PORT, DB_PATH, ADMIN_PATH, ADMIN_PASSWORD, SEED (0 = no demo data), SECURE_COOKIE (1 behind HTTPS)
 */
'use strict';
process.removeAllListeners('warning');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const Engine = require('./shared/engine.js');
const { SqlStore } = require('./sqlstore.js');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sarai.db');
const ADMIN_PATH = '/' + String(process.env.ADMIN_PATH || 'sh-panel-7319').replace(/^\/+|\/+$/g, '');
const SECURE = process.env.SECURE_COOKIE === '1';
const USER_SESSION_MS = 30 * 864e5;
const ADMIN_IDLE_MS = 30 * 60e3;
const ADMIN_MAX_MS = 12 * 3600e3;
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/* ---------- database ---------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -64000;
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, scope TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT);
  CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
`);
const S = SqlStore(db);

const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32, { N: 16384 }).toString('hex')}`;
};
const verifyPassword = (pw, stored) => {
  const [alg, salt, hex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hex) return false;
  const a = crypto.scryptSync(String(pw), salt, 32, { N: 16384 }), b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Bootstrap. With SEED=0 the database starts empty and the only admin is the one defined by
// ADMIN_PHONE / ADMIN_PASSWORD. Registrations never become admin automatically.
if (S.isEmpty()) {
  if (process.env.SEED === '0') {
    if (process.env.ADMIN_PHONE && process.env.ADMIN_PASSWORD) {
      S.tx(() => Engine.createAdmin(S, { phone: process.env.ADMIN_PHONE, password: process.env.ADMIN_PASSWORD, now: Date.now() }, { hashPassword }));
    } else console.warn('SEED=0 without ADMIN_PHONE/ADMIN_PASSWORD: no admin account exists.');
    S.tx(() => { // default tradable assets, no rates
      for (const [code, name, unit, priceCurrency, kind] of [['USD', 'دالر امریکایی', 'USD', 'AFN', 'currency'], ['EUR', 'یورو', 'EUR', 'AFN', 'currency'], ['GBP', 'پوند انگلیس', 'GBP', 'AFN', 'currency'], ['PKR', 'کلدار پاکستانی', 'PKR', 'AFN', 'currency'], ['IRR', 'تومان ایران', 'IRT', 'AFN', 'currency'], ['AED', 'درهم امارات', 'AED', 'AFN', 'currency'], ['XAU', 'طلا', 'OZ', 'USD', 'metal'], ['XAG', 'نقره', 'KG', 'USD', 'metal']]) S.put('assets', { code, name, unit, priceCurrency, kind, active: true });
    });
  } else {
    S.tx(() => Engine.seed(S, { now: Date.now(), hashPassword, adminPassword: process.env.ADMIN_PASSWORD || 'admin123' }));
  }
}

/* ---------- TOTP (RFC 6238) for admin second factor ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32encode = (buf) => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; };
const b32decode = (s) => { let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
function totpCheck(secret, code, lastStep) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const w of [0, -1, 1]) {
    const step = now + w;
    if (step <= (lastStep || 0)) continue; // no replay
    const a = Buffer.from(totpAt(secret, step)), b = Buffer.from(c);
    if (crypto.timingSafeEqual(a, b)) return step;
  }
  return null;
}

/* ---------- sessions ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const COOKIE = { user: 'sid', admin: 'asid' };
function createSession(userId, scope, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(sha(token), userId, scope, now, now, now + (scope === 'admin' ? ADMIN_MAX_MS : USER_SESSION_MS), ip || '');
  return token;
}
function readCookie(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function getSession(req) {
  const scope = req.headers['x-scope'] === 'admin' ? 'admin' : 'user';
  const token = readCookie(req, COOKIE[scope]);
  if (!token) return { scope, uid: null };
  const th = sha(token);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(th);
  const now = Date.now();
  if (!s || s.scope !== scope || s.expires_at < now || (scope === 'admin' && now - s.last_seen > ADMIN_IDLE_MS)) {
    if (s) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th);
    return { scope, uid: null, expired: !!s };
  }
  const u = S.get('users', s.user_id);
  if (!u || u.status === 'blocked' || (scope === 'admin' && u.role !== 'admin')) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th);
    return { scope, uid: null };
  }
  if (now - s.last_seen > 60e3) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, th);
  return { scope, uid: u.id, th };
}
const cookie = (name, token, maxAgeSec, strict) =>
  `${name}=${token}; HttpOnly; SameSite=${strict ? 'Strict' : 'Lax'}; Path=/; Max-Age=${maxAgeSec}${SECURE ? '; Secure' : ''}`;
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600e3).unref();

/* ---------- rate limiting (sliding window, in memory) ---------- */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3600e3) hits.delete(k); }, 600e3).unref();

/* ---------- account lockout ---------- */
function checkLock(u) {
  if (u && u.lockUntil && u.lockUntil > Date.now()) {
    const mins = Math.ceil((u.lockUntil - Date.now()) / 60e3);
    throw new Engine.EngineError(`به دلیل تلاش‌های ناموفق، ورود تا ${mins} دقیقه دیگر ممکن نیست.`, 'locked');
  }
}
function recordFailure(u) {
  if (!u) return;
  S.tx(() => {
    const x = S.get('users', u.id);
    x.failedLogins = (x.failedLogins || 0) + 1;
    if (x.failedLogins >= 5) x.lockUntil = Date.now() + Math.min(60, 15 * 2 ** (x.failedLogins - 5)) * 60e3;
    S.put('users', x);
  });
}
function recordSuccess(u, extra = {}) {
  S.tx(() => { const x = S.get('users', u.id); x.failedLogins = 0; x.lockUntil = null; x.lastLoginAt = Date.now(); Object.assign(x, extra); S.put('users', x); });
}

/* ---------- real-time (SSE) ---------- */
const clients = new Map(); // res -> uid
let marketPending = false;
function publish(ctx) {
  if (ctx.touched) for (const [res, uid] of clients) if (ctx.touched.has(uid)) res.write('event: me\ndata: 1\n\n');
  if (ctx.market && !marketPending) {
    marketPending = true;
    setTimeout(() => { marketPending = false; for (const res of clients.keys()) res.write('event: market\ndata: 1\n\n'); }, 1500);
  }
}
setInterval(() => { for (const res of clients.keys()) res.write(': ping\n\n'); }, 25e3).unref();
setInterval(() => { // expire orders even when nobody acts
  const ctx = { now: Date.now() };
  try { if (S.tx(() => Engine.sweep(S, ctx))) publish(ctx); } catch (e) { console.error('sweep', e.message); }
}, 60e3).unref();

/* ---------- http helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ...(SECURE ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};
function send(req, res, status, body, headers = {}) {
  let out = Buffer.from(JSON.stringify(body));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers };
  if (out.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { out = zlib.gzipSync(out); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }
  res.writeHead(status, h);
  res.end(out);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64e3) { reject(new Engine.EngineError('درخواست بیش از حد بزرگ است.')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Engine.EngineError('داده نامعتبر است.')); } });
  });
}
const clientIp = (req) => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '');
const STATUS = { bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, confirm: 428, locked: 423, too_many: 429 };
const tooMany = () => new Engine.EngineError('تعداد درخواست‌ها زیاد است. کمی بعد تلاش کنید.', 'too_many');

let guestCache = { at: 0, body: null };

/* ---------- API ---------- */
async function api(req, res, url) {
  const ip = clientIp(req);
  const p = url.pathname;
  const now = Date.now();
  const sess = getSession(req);

  if (p === '/api/health') return send(req, res, 200, { ok: true, mode: 'server' });

  if (req.method === 'GET') {
    if (limited('get:' + ip, 600, 60e3)) throw tooMany();
    if (p === '/api/state') {
      if (!sess.uid && sess.scope === 'user') {
        if (now - guestCache.at > 3000) guestCache = { at: now, body: Engine.buildView(S, null, { now }) };
        return send(req, res, 200, guestCache.body);
      }
      return send(req, res, 200, { ...Engine.buildView(S, sess.uid, { now, scope: sess.scope }), sessionExpired: !!sess.expired });
    }
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 5000\n\n');
      clients.set(res, sess.uid); req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/admin/users') {
      if (sess.scope !== 'admin' || !sess.uid) throw new Engine.EngineError('دسترسی ندارید.', 'forbidden');
      return send(req, res, 200, Engine.adminUsers(S, sess.uid, Object.fromEntries(url.searchParams)));
    }
    return send(req, res, 404, { error: 'یافت نشد.' });
  }

  if (req.method !== 'POST') return send(req, res, 405, { error: 'Method not allowed' });
  if (!String(req.headers['content-type'] || '').includes('application/json')) return send(req, res, 415, { error: 'JSON required' });
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return send(req, res, 403, { error: 'درخواست از دامنه دیگر مجاز نیست.' }); } catch { return send(req, res, 403, { error: 'Origin نامعتبر.' }); } }
  if (limited('post:' + ip, 120, 60e3)) throw tooMany();
  const body = await readBody(req);

  if (p === '/api/register') {
    if (limited('reg:' + ip, 5, 3600e3)) throw tooMany();
    const user = S.tx(() => { const ctx = { now }; const u = Engine.register(S, body, ctx, { hashPassword }); publish(ctx); return u; });
    const token = createSession(user.id, 'user', ip);
    return send(req, res, 200, { ok: true }, { 'Set-Cookie': cookie(COOKIE.user, token, USER_SESSION_MS / 1000) });
  }

  if (p === '/api/login' || p === '/api/admin/login') {
    const admin = p === '/api/admin/login';
    if (limited((admin ? 'alog:' : 'login:') + ip, admin ? 8 : 15, 15 * 60e3)) throw tooMany();
    const u = Engine.findByPhone(S, body.phone);
    checkLock(u);
    if (!u || !verifyPassword(body.password, u.passHash)) { recordFailure(u); throw new Engine.EngineError('شماره یا رمز عبور نادرست است.', 'unauthorized'); }
    if (u.status === 'blocked') throw new Engine.EngineError('حساب شما مسدود است.', 'forbidden');
    if (admin) {
      if (u.role !== 'admin' || u.status !== 'approved') { recordFailure(u); throw new Engine.EngineError('این حساب دسترسی مدیریت ندارد.', 'forbidden'); }
      if (u.totpEnabled) {
        if (!body.code) return send(req, res, 200, { need2fa: true });
        const step = totpCheck(u.totpSecret, body.code, u.totpLastStep);
        if (step == null) { recordFailure(u); throw new Engine.EngineError('کد تأیید دومرحله‌ای نادرست است.', 'unauthorized'); }
        recordSuccess(u, { totpLastStep: step });
      } else recordSuccess(u);
      const token = createSession(u.id, 'admin', ip);
      return send(req, res, 200, { ok: true, totpEnabled: !!u.totpEnabled }, { 'Set-Cookie': cookie(COOKIE.admin, token, ADMIN_MAX_MS / 1000, true) });
    }
    recordSuccess(u);
    const token = createSession(u.id, 'user', ip);
    return send(req, res, 200, { ok: true }, { 'Set-Cookie': cookie(COOKIE.user, token, USER_SESSION_MS / 1000) });
  }

  if (p === '/api/logout') {
    if (sess.th) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sess.th);
    return send(req, res, 200, { ok: true }, { 'Set-Cookie': cookie(COOKIE[sess.scope], '', 0, sess.scope === 'admin') });
  }

  if (!sess.uid) throw new Engine.EngineError(sess.expired ? 'نشست شما به پایان رسید. دوباره وارد شوید.' : 'ابتدا وارد حساب شوید.', 'unauthorized');
  const me = S.get('users', sess.uid);

  if (p === '/api/password') {
    if (limited('pw:' + sess.uid, 5, 15 * 60e3)) throw tooMany();
    if (!verifyPassword(body.current, me.passHash)) throw new Engine.EngineError('رمز فعلی نادرست است.');
    const next = String(body.next || '');
    if (next.length < 8) throw new Engine.EngineError('رمز جدید باید حداقل ۸ حرف باشد.');
    if (me.role === 'admin' && !(/[A-Za-z]/.test(next) && /\d/.test(next) && next.length >= 10)) throw new Engine.EngineError('رمز مدیر باید حداقل ۱۰ حرف و شامل حرف و عدد باشد.');
    S.tx(() => { const x = S.get('users', me.id); x.passHash = hashPassword(next); x.passChangedAt = now; S.put('users', x); });
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(me.id, sess.th); // sign out other devices
    return send(req, res, 200, { ok: true });
  }

  if (p.startsWith('/api/admin/2fa/')) {
    if (sess.scope !== 'admin') throw new Engine.EngineError('دسترسی ندارید.', 'forbidden');
    if (p === '/api/admin/2fa/setup') {
      const secret = b32encode(crypto.randomBytes(20));
      S.tx(() => { const x = S.get('users', me.id); x.totpPending = secret; S.put('users', x); });
      const label = encodeURIComponent('Shahzada Sarai:' + me.phone);
      return send(req, res, 200, { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Shahzada Sarai')}&digits=6&period=30` });
    }
    if (p === '/api/admin/2fa/enable') {
      if (!verifyPassword(body.password, me.passHash)) throw new Engine.EngineError('رمز عبور نادرست است.');
      if (!me.totpPending) throw new Engine.EngineError('ابتدا کلید را دریافت کنید.');
      const step = totpCheck(me.totpPending, body.code, 0);
      if (step == null) throw new Engine.EngineError('کد نادرست است. ساعت گوشی را بررسی کنید.');
      S.tx(() => {
        const x = S.get('users', me.id); x.totpSecret = x.totpPending; delete x.totpPending; x.totpEnabled = true; x.totpLastStep = step; S.put('users', x);
      });
      return send(req, res, 200, { ok: true });
    }
    if (p === '/api/admin/2fa/disable') {
      if (!verifyPassword(body.password, me.passHash)) throw new Engine.EngineError('رمز عبور نادرست است.');
      if (me.totpEnabled && totpCheck(me.totpSecret, body.code, me.totpLastStep) == null) throw new Engine.EngineError('کد نادرست است.');
      S.tx(() => { const x = S.get('users', me.id); x.totpEnabled = false; delete x.totpSecret; S.put('users', x); });
      return send(req, res, 200, { ok: true });
    }
  }

  if (p === '/api/action') {
    const type = String(body.type || '');
    if (limited('act:' + sess.uid, 60, 60e3)) throw tooMany();
    if (type.startsWith('admin.') && sess.scope !== 'admin') throw new Engine.EngineError('این عملیات فقط از پنل مدیریت ممکن است.', 'forbidden');
    if (Engine.SENSITIVE.has(type)) {
      if (limited('sens:' + sess.uid, 20, 15 * 60e3)) throw tooMany();
      if (!verifyPassword(body.password, me.passHash)) throw new Engine.EngineError('برای این عملیات رمز عبور خود را درست وارد کنید.', 'unauthorized');
    }
    const ctx = { now, scope: sess.scope };
    const result = S.tx(() => Engine.dispatch(S, sess.uid, type, body.payload, ctx));
    publish(ctx);
    if (ctx.market) guestCache.at = 0;
    return send(req, res, 200, { ok: true, result });
  }
  return send(req, res, 404, { error: 'یافت نشد.' });
}

/* ---------- static files ---------- */
const fileCache = new Map();
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
  if (rel === '/robots.txt') { res.writeHead(200, { 'Content-Type': MIME['.txt'] }); return res.end('User-agent: *\nAllow: /\n'); }
  const baseDir = rel.startsWith('/shared/') ? __dirname : path.join(__dirname, 'public');
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir + path.sep)) { res.writeHead(403); return res.end(); }
  const ext = path.extname(file);
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /\.(html|js|css|svg|webmanifest)$/.test(ext);
  const key = file + (gz ? ':gz' : '');
  const send200 = (buf) => {
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=300', ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}), ...SECURITY_HEADERS });
    res.end(buf);
  };
  if (fileCache.has(key) && process.env.NODE_ENV === 'production') return send200(fileCache.get(key));
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
    const out = gz ? zlib.gzipSync(buf) : buf;
    fileCache.set(key, out);
    send200(out);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof Engine.EngineError) return send(req, res, STATUS[err.code] || 400, { error: err.message, code: err.code });
    console.error(err);
    send(req, res, 500, { error: 'خطای داخلی سرور.' });
  }
});
server.keepAliveTimeout = 65e3;
server.headersTimeout = 70e3;
server.requestTimeout = 30e3;

if (require.main === module) {
  server.listen(PORT, () => console.log(`Shahzada Sarai → http://localhost:${PORT}  (admin panel: ${ADMIN_PATH})`));
}
module.exports = { server, totpAt, b32encode };
