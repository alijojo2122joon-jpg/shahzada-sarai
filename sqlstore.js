/*
 * SQLite implementation of the engine's store interface.
 * One table per entity (id + JSON document) with expression indexes on every field the
 * engine filters or sorts by, so queries stay fast as data grows.
 * The schema maps 1:1 to PostgreSQL (jsonb + expression indexes) for a later move.
 */
'use strict';

const KINDS = {
  users: [['phone'], ['status', 'createdAt'], ['role', 'status'], ['createdAt']],
  assets: [['code']],
  orders: [['status', 'side'], ['status', 'createdAt'], ['userId', 'createdAt'], ['userId', 'status'], ['status', 'expiresAt'], ['assetId', 'status'], ['createdAt']],
  deals: [['status', 'completedAt'], ['orderId', 'status'], ['ownerId', 'updatedAt'], ['requesterId', 'updatedAt'], ['status'], ['updatedAt'], ['createdAt']],
  messages: [['dealId']],
  notifications: [['userId', 'read'], ['userId']],
  rates: [['key'], ['assetId']],
  rateHistory: [['key', 'at'], ['at']],
  tgMessages: [['sourceId', 'msgId'], ['status'], ['channel']],
  sources: [['channel'], ['enabled']],
  alerts: [['key', 'active'], ['userId', 'active'], ['userId']],
  fixings: [['date', 'key'], ['key', 'date'], ['date']],
  reports: [['status'], ['reporterId', 'createdAt']],
  audit: [],
};

function SqlStore(db) {
  const ex = (f) => (f === 'id' ? 'id' : `json_extract(data, '$.${f.replace(/[^A-Za-z0-9_]/g, '')}')`);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  for (const [kind, idx] of Object.entries(KINDS)) {
    db.exec(`CREATE TABLE IF NOT EXISTS t_${kind} (id INTEGER PRIMARY KEY, data TEXT NOT NULL);`);
    for (const cols of idx) db.exec(`CREATE INDEX IF NOT EXISTS ix_${kind}_${cols.join('_')} ON t_${kind}(${cols.map(ex).join(', ')});`);
  }
  // The audit trail is append-only at the database level.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON t_audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON t_audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS fixings_no_update BEFORE UPDATE ON t_fixings BEGIN SELECT RAISE(ABORT, 'fixings are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS fixings_no_delete BEFORE DELETE ON t_fixings BEGIN SELECT RAISE(ABORT, 'fixings are immutable'); END;`);

  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const val = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const table = (k) => { if (!KINDS[k]) throw new Error('unknown kind ' + k); return `t_${k}`; };

  function compile(where, params) {
    const parts = [];
    for (const [f, c] of Object.entries(where || {})) {
      if (f === '$or') { parts.push('(' + c.map((w) => '(' + (compile(w, params) || '1') + ')').join(' OR ') + ')'); continue; }
      const col = ex(f);
      if (c === null) { parts.push(`${col} IS NULL`); continue; }
      if (typeof c !== 'object') { parts.push(`${col} = ?`); params.push(val(c)); continue; }
      if ('in' in c) { if (!c.in.length) { parts.push('0'); } else { parts.push(`${col} IN (${c.in.map(() => '?').join(',')})`); params.push(...c.in.map(val)); } }
      if ('ne' in c) { parts.push(`(${col} IS NULL OR ${col} != ?)`); params.push(val(c.ne)); }
      for (const [op, sym] of [['lt', '<'], ['lte', '<='], ['gt', '>'], ['gte', '>=']]) if (op in c) { parts.push(`${col} ${sym} ?`); params.push(val(c[op])); }
      if ('like' in c) { parts.push(`${col} LIKE ?`); params.push('%' + String(c.like).replace(/[%_]/g, '') + '%'); }
    }
    return parts.join(' AND ');
  }
  const parse = (r) => (r ? JSON.parse(r.data) : null);

  const store = {
    kind: 'sqlite',
    get: (k, id) => parse(stmt(`SELECT data FROM ${table(k)} WHERE id = ?`).get(Number(id))),
    put(k, o) {
      if (o.id == null) o.id = store.nextId(k);
      stmt(`INSERT INTO ${table(k)} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(o.id, JSON.stringify(o));
      return o;
    },
    find(k, where, { order, limit, offset } = {}) {
      const params = [];
      const w = compile(where, params);
      let sql = `SELECT data FROM ${table(k)}${w ? ' WHERE ' + w : ''}`;
      if (order) { const desc = order.startsWith('-'); const f = desc ? order.slice(1) : order; sql += ` ORDER BY ${ex(f)} ${desc ? 'DESC' : 'ASC'}, id ${desc ? 'DESC' : 'ASC'}`; }
      else sql += ' ORDER BY id';
      if (limit != null) { sql += ' LIMIT ? OFFSET ?'; params.push(Number(limit), Number(offset || 0)); }
      return stmt(sql).all(...params).map(parse);
    },
    count(k, where) {
      const params = [];
      const w = compile(where, params);
      return stmt(`SELECT COUNT(*) AS n FROM ${table(k)}${w ? ' WHERE ' + w : ''}`).get(...params).n;
    },
    one(k, where) { return store.find(k, where, { limit: 1 })[0] || null; },
    nextId(k) {
      const key = 'seq:' + k;
      const cur = stmt('SELECT v FROM meta WHERE k = ?').get(key);
      let n = cur ? Number(cur.v) : stmt(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table(k)}`).get().m;
      n += 1;
      stmt('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, String(n));
      return n;
    },
    meta(key, value) {
      if (value === undefined) { const r = stmt('SELECT v FROM meta WHERE k = ?').get(key); return r ? JSON.parse(r.v) : undefined; }
      stmt('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, JSON.stringify(value));
      return value;
    },
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    isEmpty: () => stmt('SELECT COUNT(*) AS n FROM t_users').get().n === 0,
  };
  return store;
}

module.exports = { SqlStore, KINDS };
