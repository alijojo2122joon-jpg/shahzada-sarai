/* Shahzada Sarai — web client (vanilla JS, RTL).
   Runs against the Node API, or fully in the browser (demo) with the same engine. */
(function () {
  'use strict';
  const E = window.SaraiEngine;
  const $app = document.getElementById('app');

  /* =========================================================
     Small utilities
     ========================================================= */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  class ApiError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status; } }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 6) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
  const N = (n, d) => `<span class="num">${fmt(n, d)}</span>`;
  const dateFmt = new Intl.DateTimeFormat('fa-AF', { dateStyle: 'medium', timeStyle: 'short' });
  const longDate = new Intl.DateTimeFormat('fa-AF', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('fa-AF', { hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('fa-AF', { month: 'short', day: 'numeric' });
  const fmtDate = (t) => (t ? dateFmt.format(new Date(t)) : '—');
  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'لحظاتی پیش';
    if (s < 3600) return `${Math.floor(s / 60)} دقیقه پیش`;
    if (s < 86400) return `${Math.floor(s / 3600)} ساعت پیش`;
    return `${Math.floor(s / 86400)} روز پیش`;
  }
  function left(t) {
    if (!t) return 'تا بستن دستی';
    const s = Math.round((t - Date.now()) / 1000);
    if (s <= 0) return 'منقضی';
    if (s < 3600) return `${Math.ceil(s / 60)} دقیقه`;
    if (s < 86400) return `${Math.floor(s / 3600)} ساعت`;
    return `${Math.floor(s / 86400)} روز`;
  }
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  /* =========================================================
     Backends
     ========================================================= */
  const ServerBackend = {
    mode: 'server', scope: 'user',
    async req(path, body) {
      const headers = this.scope === 'admin' ? { 'X-Scope': 'admin' } : {};
      const res = await fetch(path, body === undefined ? { credentials: 'same-origin', headers } : {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(data.error || 'خطا در ارتباط با سرور.', data.code, res.status);
      return data;
    },
    getView() { return this.req('/api/state'); },
    action(type, payload, password) { return this.req('/api/action', { type, payload, password }).then((r) => r.result); },
    register(d) { return this.req('/api/register', d); },
    login(d) { return this.req(this.scope === 'admin' ? '/api/admin/login' : '/api/login', d); },
    logout() { return this.req('/api/logout', {}); },
    changePassword(current, next) { return this.req('/api/password', { current, next }); },
    adminUsers(params) { return this.req('/api/admin/users?' + qs(params)); },
    totpSetup() { return this.req('/api/admin/2fa/setup', {}); },
    totpEnable(code, password) { return this.req('/api/admin/2fa/enable', { code, password }); },
    totpDisable(code, password) { return this.req('/api/admin/2fa/disable', { code, password }); },
    rateHistory(key, period) { return this.req('/api/rates/history?' + qs({ key, period })); },
    sparks() { return this.req('/api/rates/sparks'); },
    adminMessages(params) { return this.req('/api/admin/messages?' + qs(params)); },
    sourceFetch(sourceId) { return this.req('/api/admin/source/fetch', { sourceId }); },
    subscribe(onMe, onMarket) {
      if (!window.EventSource) return;
      const es = new EventSource('/api/stream');
      es.addEventListener('me', onMe);
      es.addEventListener('market', onMarket);
    },
  };

  // Demo backend: same engine over an in-browser store. Data stays in this browser only.
  const KEY = 'sarai-demo-v3';
  const demoHash = (pw) => { let h = 5381; for (const c of 'sarai:' + pw) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return 'demo$' + h.toString(36); };
  const LocalBackend = {
    mode: 'local', scope: 'user', S: null,
    init() {
      let data = null;
      try { data = JSON.parse(store.get(KEY) || 'null'); } catch { data = null; }
      this.S = E.MemoryStore(data || undefined);
      if (!data) { E.seed(this.S, { now: Date.now(), hashPassword: demoHash, sampleMessages: true }); this.save(); }
    },
    uidKey() { return this.scope === 'admin' ? 'sarai-demo-admin' : 'sarai-demo-uid'; },
    get uid() { return Number(store.get(this.uidKey())) || null; },
    setUid(id) { id ? store.set(this.uidKey(), String(id)) : store.del(this.uidKey()); },
    save() { store.set(KEY, JSON.stringify(this.S.dump())); },
    reset() { store.del(KEY); store.del('sarai-demo-uid'); store.del('sarai-demo-admin'); this.init(); },
    run(fn) { const r = this.S.tx(fn); this.save(); return r; },
    wrap(fn) { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(new ApiError(e.message, e.code)); } },
    getView() { return this.wrap(() => E.buildView(this.S, this.uid, { now: Date.now(), scope: this.scope })); },
    action(type, payload, password) {
      return this.wrap(() => {
        if (E.SENSITIVE.has(type)) { const u = this.S.get('users', this.uid); if (!u || demoHash(password || '') !== u.passHash) throw new ApiError('برای این عملیات رمز عبور خود را درست وارد کنید.', 'unauthorized'); }
        return this.run(() => E.dispatch(this.S, this.uid, type, payload, { now: Date.now(), scope: this.scope }));
      });
    },
    register(d) { return this.wrap(() => { const u = this.run(() => E.register(this.S, d, { now: Date.now() }, { hashPassword: demoHash })); this.setUid(u.id); return { ok: true }; }); },
    login(d) {
      return this.wrap(() => {
        const u = E.findByPhone(this.S, d.phone);
        if (!u || demoHash(String(d.password || '')) !== u.passHash) throw new ApiError('شماره یا رمز عبور نادرست است.', 'unauthorized');
        if (u.status === 'blocked') throw new ApiError('حساب شما مسدود است.', 'forbidden');
        if (this.scope === 'admin' && u.role !== 'admin') throw new ApiError('این حساب دسترسی مدیریت ندارد.', 'forbidden');
        this.setUid(u.id); return { ok: true };
      });
    },
    logout() { this.setUid(null); return Promise.resolve(); },
    changePassword(cur, next) {
      return this.wrap(() => {
        const u = this.S.get('users', this.uid);
        if (!u || demoHash(cur) !== u.passHash) throw new ApiError('رمز فعلی نادرست است.');
        if (String(next).length < 8) throw new ApiError('رمز جدید باید حداقل ۸ حرف باشد.');
        this.run(() => { u.passHash = demoHash(next); this.S.put('users', u); });
      });
    },
    adminUsers(params) { return this.wrap(() => E.adminUsers(this.S, this.uid, params)); },
    totpSetup() { return Promise.reject(new ApiError('تأیید دومرحله‌ای فقط در نسخه اصلی سایت فعال است.')); },
    totpEnable() { return this.totpSetup(); },
    totpDisable() { return this.totpSetup(); },
    rateHistory(key, period) {
      return this.wrap(() => {
        const now = Date.now(), day = 864e5, off = 270 * 60e3, sod = Math.floor((now + off) / day) * day - off;
        const P = { today: [sod, now], yesterday: [sod - day, sod], '7d': [now - 7 * day, now], '30d': [now - 30 * day, now], '90d': [now - 90 * day, now] };
        const [from, to] = P[period] || P['7d'];
        return { key, from, to, points: E.rateHistory(this.S, key, { from, to }), stats: E.rateStats(this.S, key, now) };
      });
    },
    adminMessages(params) { return this.wrap(() => E.adminMessages(this.S, this.uid, params)); },
    sparks() { return this.wrap(() => E.sparks(this.S, Date.now())); },
    sourceFetch() { return Promise.reject(new ApiError('در نسخه آزمایشی دسترسی به تلگرام ممکن نیست. از «ورود دستی پیام» استفاده کنید.')); },
    subscribe(onMe) {
      window.addEventListener('storage', (e) => {
        if (e.key === KEY && e.newValue) { try { this.S = E.MemoryStore(JSON.parse(e.newValue)); onMe(); } catch { /* ignore */ } }
        if (e.key === this.uidKey()) onMe();
      });
    },
  };

  /* =========================================================
     State
     ========================================================= */
  let backend = null, view = null, pendingRender = false, ADMIN_MODE = false;
  const ui = {
    filters: { asset: '', side: '', min: '', max: '', minAmount: '', q: '', sort: 'new' },
    notifOpen: false, rateAsset: null, side: 'sell', dealFilter: 'active',
    members: { status: 'pending', q: '', list: null, total: 0, loading: false, offset: 0 },
    adminLogin: { need2fa: false, phone: '', password: '' },
    totp: null,
    ratesView: { market: 'کابل', q: '', sort: 'popular', key: null, period: '7d', hist: null, histFor: null, loading: null, chart: 'line', cside: 'sell', stats: null },
    conv: { amount: '1000', from: 'USD', to: 'AFN' }, sparks: {}, sparksAt: 0,
    adminRates: { msgs: null, status: null, filter: '', loading: false, total: 0 },
  };
  const asset = (id) => view.assets.find((a) => a.id === id) || { code: '?', name: '?', unit: '' };
  const user = (id) => view.users.find((u) => u.id === id) || (ui.members.list || []).find((u) => u.id === id) || ((view.admin && view.admin.pending) || []).find((u) => u.id === id);
  const orderOf = (id) => view.orders.find((o) => o.id === id);
  const me = () => view.me;
  const approved = () => !!(view.me && view.me.status === 'approved');
  const isAdmin = () => !!(view.scope === 'admin' && view.me && view.me.role === 'admin');

  /* =========================================================
     Icons & small components
     ========================================================= */
  const svg = (d, w = 20) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    check: '<svg class="verified" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-label="تأیید شده"><path d="M12 1l2.6 2.2 3.4-.4.9 3.3 3 1.7-1.2 3.2 1.2 3.2-3 1.7-.9 3.3-3.4-.4L12 23l-2.6-2.2-3.4.4-.9-3.3-3-1.7L3.3 13 2.1 9.8l3-1.7.9-3.3 3.4.4z"/><path d="M10.5 15.6l-3.2-3.2 1.4-1.4 1.8 1.8 4.8-4.8 1.4 1.4z" fill="#fff"/></svg>',
    bell: svg('<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/>'),
    box: svg('<path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/>', 40),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    moon: svg('<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>'),
    logo: svg('<path d="M3 21h18M5 21V10l7-6 7 6v11M9 21v-6h6v6M9 11h.01M15 11h.01"/>', 22),
    shield: svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>', 22),
    users: svg('<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8"/>', 24),
    rate: svg('<path d="M3 20h18M5 16l4-5 4 3 6-8"/>', 24),
    list: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', 24),
    deal: svg('<path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3"/>', 24),
    flag: svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>', 24),
    megaphone: svg('<path d="M3 11v2a1 1 0 001 1h3l5 4V6L7 10H4a1 1 0 00-1 1zM16 8a5 5 0 010 8"/>', 24),
    coins: svg('<circle cx="8" cy="8" r="6"/><path d="M18.1 10.4A6 6 0 1110.4 18M7 6h1v4M16.7 13.9l.7.7-2.8 2.8"/>', 24),
    chart: svg('<path d="M18 20V10M12 20V4M6 20v-6"/>', 24),
    lock: svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>', 24),
    history: svg('<path d="M3 3v5h5M3.05 13A9 9 0 106 5.3L3 8M12 7v5l4 2"/>', 24),
    seal: svg('<circle cx="12" cy="9" r="6"/><path d="M9 14.5L7 22l5-3 5 3-2-7.5M9.5 9l1.8 1.8L15 7"/>', 22),
    nHome: svg('<path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/>'),
    nMarket: svg('<path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3"/>'),
    nRates: svg('<path d="M3 20h18M5 16l4-5 4 3 6-8"/>'),
    nNew: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
    nDash: svg('<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>'),
    wa: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm5.3 14.2c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.8s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.7 1.2 1.6 1.9 1.1.9 2 1.2 2.3 1.4.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.6-.1l2 .9c.3.1.5.2.5.3.1.2.1.7-.1 1.2z"/></svg>',
  };
  const sideBadge = (side) => (side === 'sell' ? '<span class="badge sell">فروش</span>' : '<span class="badge buy">خرید</span>');
  const ORDER_CLS = { active: 'ok', filled: 'blue', closed: '', cancelled: 'bad', expired: 'warn' };
  const DEAL_CLS = { pending: 'warn', accepted: 'blue', completed: 'ok', rejected: 'bad', cancelled: 'bad' };
  const orderBadge = (s) => `<span class="badge ${ORDER_CLS[s] || ''}">${E.ORDER_STATUS[s] || s}</span>`;
  const dealBadge = (s) => `<span class="badge ${DEAL_CLS[s] || ''}">${E.DEAL_STATUS[s] || s}</span>`;
  const userBadge = (s) => `<span class="badge ${s === 'approved' ? 'ok' : s === 'blocked' || s === 'rejected' ? 'bad' : 'warn'}">${E.USER_STATUS[s] || s}</span>`;
  const assetChip = (a, sub) => `<span class="asset-chip"><span class="asset-ico ${a.kind === 'metal' ? 'metal-' + a.code : ''}">${esc(a.code)}</span><span>${esc(a.name)}${sub ? `<div class="muted small" style="font-weight:400">${sub}</div>` : ''}</span></span>`;
  function nameLink(id) {
    const u = user(id);
    if (!u) return '<span class="muted">مخصوص اعضا</span>';
    return `<a href="#${ADMIN_MODE ? 'admin-review-' : 'user-'}${u.id}">${esc(u.company || u.name)}</a> ${u.status === 'approved' ? ICON.check : ''}`;
  }
  const emptyBox = (text) => `<div class="empty">${ICON.box}${esc(text)}</div>`;
  const total = (o, amt) => (amt == null ? o.amount : amt) * o.price;
  const qty = (o, amt) => `${N(amt == null ? o.amount : amt)} <span class="muted small">${esc(o.unit)}</span>`;
  const waHref = (ph) => `https://wa.me/${esc(String(ph).replace(/^0/, '93').replace(/\D/g, ''))}`;
  const pageHead = (title, sub, actions = '') => `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${actions ? `<div class="row">${actions}</div>` : ''}</div>`;

  const SEARCH = svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', 22);
  const orb = (icon) => `<span class="glass-orb">${icon}</span>`;
  const knobBtn = (href, label, icon, tone = '') => `<a class="btn-knob ${tone}" href="${href}">${orb(icon)}<span>${label}</span></a>`;
  // Progress bar with a percentage bubble above the fill.
  const tipBar = (pct) => `<div class="tipbar"><div class="tipbar-track"><i style="width:${pct}%"></i></div><span class="tipbar-tip num" style="right:calc(${pct}% - 22px)">${pct}%</span></div>`;
  // Large number that fills with colour up to the given percentage.
  const fillNum = (pct, label) => `<div class="fill-wrap"><span class="fill-num num" style="--p:${pct}%">${pct}<small>%</small></span>${label ? `<span class="muted small">${label}</span>` : ''}</div>`;
  let ringSeq = 0;
  function ringSvg(frac, size, stroke, c1, c2) {
    const id = 'rg' + (++ringSeq), r = (size - stroke) / 2, len = 2 * Math.PI * r;
    const off = len * (1 - Math.max(0.02, Math.min(1, frac)));
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(127,127,127,.12)" stroke-width="${stroke}"/>
      <circle class="arc" style="--len:${len.toFixed(1)}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${len.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>`;
  }

  // Step tracker used on order and deal pages so every party sees where a transaction stands.
  function stepper(steps, current, note) {
    return `<div class="card card-pad stepper-card">
      <ol class="stepper">${steps.map((s, i) => `<li class="${i < current ? 'done' : i === current ? 'now' : ''}"><span class="dot">${i < current ? '✓' : i + 1}</span><span class="lbl">${s}</span></li>`).join('')}</ol>
      ${note ? `<div class="step-note">${note}</div>` : ''}</div>`;
  }

  /* =========================================================
     Toasts, modals, password confirmation
     ========================================================= */
  function toast(msg, err) {
    let w = document.querySelector('.toast-wrap');
    if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; document.body.appendChild(w); }
    const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
    w.appendChild(t); setTimeout(() => t.remove(), err ? 5000 : 3200);
  }
  function modal(title, body) {
    closeModal();
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal card" role="dialog" aria-modal="true"><div class="modal-head"><h3>${title}</h3><button class="x" data-act="close-modal" aria-label="بستن">×</button></div><div class="card-pad">${body}</div></div>`;
    bg.addEventListener('click', (e) => { if (e.target === bg) closeModal(); });
    document.body.appendChild(bg);
    const first = bg.querySelector('input:not([type=hidden]), textarea, select'); if (first) first.focus();
  }
  function closeModal() { document.querySelectorAll('.modal-bg').forEach((m) => m.remove()); }

  // Sensitive admin actions: ask for the password, handle the large-change confirmation.
  let pendingSensitive = null;
  function sensitive(type, payload, okMsg, summary) {
    pendingSensitive = { type, payload, okMsg };
    modal('تأیید با رمز عبور', `<form data-form="sensitive" class="stack">
      ${summary ? `<div class="notice">${summary}</div>` : ''}
      <label class="field"><span>رمز عبور مدیر</span><input class="input" type="password" name="password" required autocomplete="current-password"></label>
      <div class="form-error hidden"></div>
      <button class="btn btn-primary btn-block">تأیید و ثبت</button></form>`);
  }
  async function runSensitive(password, extra = {}) {
    const p = pendingSensitive; if (!p) return;
    try {
      await backend.action(p.type, { ...p.payload, ...extra }, password);
      pendingSensitive = null; await refresh(); closeModal(); render(); if (p.okMsg) toast(p.okMsg);
    } catch (e) {
      if (e.code === 'confirm') {
        modal('تأیید تغییر بزرگ نرخ', `<form data-form="confirm-large" class="stack"><div class="notice warn">${esc(e.message)}</div>
          <input type="hidden" name="password" value="${esc(password)}">
          <button class="btn btn-sell btn-block">ارقام درست است؛ ثبت شود</button><button type="button" class="btn btn-block" data-act="close-modal">انصراف</button></form>`);
        return;
      }
      throw e;
    }
  }

  /* =========================================================
     Data flow
     ========================================================= */
  async function refresh() {
    view = await backend.getView();
    if (view.sessionExpired && ADMIN_MODE) toast('نشست مدیریت به دلیل عدم فعالیت پایان یافت.', true);
    systemNotify();
  }
  async function act(type, payload, okMsg) {
    try {
      const r = await backend.action(type, payload);
      await refresh(); closeModal(); render();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) { toast(e.message, true); throw e; }
  }
  const busy = () => document.querySelector('.modal-bg') || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.value);
  async function onRemoteChange() {
    try { await refresh(); } catch { return; }
    if (busy()) { pendingRender = true; return; }
    render();
  }
  let marketTimer = null;
  const onMarket = () => { clearTimeout(marketTimer); marketTimer = setTimeout(onRemoteChange, 300 + Math.random() * 2500); };
  setInterval(() => { if (pendingRender && !busy()) { pendingRender = false; render(); } }, 1500);
  setInterval(() => { if (view && !busy()) render(); }, 60e3);

  // Phone notifications (while the site or installed app is open).
  let lastNotifId = null;
  function systemNotify() {
    if (!view || !view.me) { lastNotifId = null; return; }
    const top = view.notifications.length ? view.notifications[0].id : 0;
    if (lastNotifId === null) { lastNotifId = top; return; }
    const fresh = view.notifications.filter((n) => n.id > lastNotifId && !n.read);
    lastNotifId = Math.max(lastNotifId, top);
    if (!fresh.length || !('Notification' in window) || Notification.permission !== 'granted') return;
    for (const n of fresh.slice(0, 3)) {
      const opts = { body: n.text, icon: 'icon-192.png', badge: 'icon-192.png', tag: 'sarai-' + n.id, lang: 'fa', dir: 'rtl' };
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then((r) => r.showNotification('سرای شهزاده', opts)).catch(() => {});
      else { try { new Notification('سرای شهزاده', opts); } catch { /* ignore */ } }
    }
  }
  const notifPermissionButton = () => (backend.mode === 'server' && 'Notification' in window && Notification.permission === 'default'
    ? '<button class="btn btn-sm" data-act="enable-push">فعال‌سازی اعلان روی گوشی</button>' : '');

  /* =========================================================
     Layout
     ========================================================= */
  const route = () => {
    const r = (location.hash || '').slice(1);
    if (ADMIN_MODE) return !r || r === 'home' || r === 'sarai-panel' ? 'admin' : r;
    return r || 'home';
  };
  function themeBtn() { return `<button class="bell" data-act="theme" aria-label="تغییر حالت نمایش">${document.documentElement.dataset.theme === 'light' ? ICON.moon : ICON.sun}</button>`; }
  function bellBtn() {
    const n = view.unread || 0;
    return `<button class="bell" data-act="toggle-notifs" aria-label="اعلان‌ها">${ICON.bell}${n ? `<span class="dot">${n > 99 ? '99+' : n}</span>` : ''}</button>`;
  }
  function header() {
    if (ADMIN_MODE) {
      return `<header class="topbar"><div class="topbar-inner">
        <a class="brand" href="#admin"><span class="brand-mark">${ICON.shield}</span><span><b>پنل مدیریت</b><small>سرای شهزاده کابل</small></span></a>
        <div class="top-actions">${isAdmin() ? bellBtn() : ''}${themeBtn()}${me() ? '<button class="btn btn-light btn-sm" data-act="logout">خروج</button>' : ''}</div>
      </div></header>${ui.notifOpen && isAdmin() ? notifDrawer() : ''}`;
    }
    const r = route(), m = me();
    const link = (href, label) => `<a href="#${href}" class="${r === href || r.startsWith(href + '-') ? 'active' : ''}">${label}</a>`;
    const tick = liveRates().filter((rt) => rt.market === 'کابل' && rt.quote === 'AFN' && rt.settlement === 'cash').map((rt) => {
      const a = assetByCode(rt.code); const dl = delta(rt.sell ?? rt.buy, rt.sell != null ? rt.prevSell : rt.prevBuy);
      const ch = dl ? dl.p : 0;
      return `<span><b>${esc(a.name)}</b> <span class="num">${rt.buy != null ? fmt(rt.buy) : '—'} / ${rt.sell != null ? fmt(rt.sell) : '—'}</span> <span class="num ${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}">${ch > 0 ? '▲' : ch < 0 ? '▼' : '■'} ${Math.abs(ch).toFixed(2)}%</span></span>`;
    }).join('');
    return `<header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#home"><span class="brand-mark">${ICON.logo}</span><span><b>سرای شهزاده</b><small>بازار معاملات ارز و فلزات قیمتی — کابل</small></span></a>
        <nav class="nav">${link('home', 'صفحه اصلی')}${link('rates', 'نرخ رسمی')}${link('market', 'بازار')}${link('new', 'ثبت سفارش')}${m ? link('dashboard', 'داشبورد') : ''}</nav>
        <div class="top-actions">
          ${m ? `${bellBtn()}<a class="btn btn-light btn-sm me-btn" href="#profile">${esc(m.company || m.name)}</a><button class="btn btn-sm" data-act="logout">خروج</button>`
              : '<a class="btn btn-sm" href="#login">ورود</a><a class="btn btn-primary btn-sm" href="#register">عضویت</a>'}
          ${themeBtn()}
        </div>
      </div>
      ${tick ? `<div class="ticker"><div class="ticker-track">${tick}${tick}</div></div>` : ''}
    </header>
    ${backend.mode === 'local' ? demoBar() : ''}
    ${ui.notifOpen && m ? notifDrawer() : ''}`;
  }
  function demoBar() {
    const users = LocalBackend.S.find('users', { role: 'member' });
    return `<div class="demo-bar">نسخه آزمایشی — داده‌ها فقط در همین مرورگر ذخیره می‌شود. ورود به‌عنوان:
      <select data-change="demo-switch"><option value="">مهمان</option>${users.map((u) => `<option value="${u.id}" ${view.me && view.me.id === u.id ? 'selected' : ''}>${esc(u.company)}${u.status !== 'approved' ? ' (در انتظار)' : ''}</option>`).join('')}</select>
      <button data-act="demo-reset">بازنشانی</button></div>`;
  }
  function notifDrawer() {
    const list = view.notifications;
    return `<div class="drawer card">
      <div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><b>اعلان‌ها</b><span class="spacer"></span>
      ${view.unread ? '<button class="btn btn-ghost btn-sm" data-act="read-all">علامت‌گذاری همه</button>' : ''}</div>
      ${notifPermissionButton() ? `<div style="padding:10px 16px;border-bottom:1px solid var(--line)">${notifPermissionButton()}</div>` : ''}
      ${list.length ? list.slice(0, 30).map((n) => `<div class="notif ${n.read ? '' : 'unread'}" data-act="open-notif" data-id="${n.id}" data-link="${esc(n.link)}">${esc(n.text)}<time>${ago(n.at)}</time></div>`).join('') : emptyBox('اعلانی وجود ندارد.')}
    </div>`;
  }
  function bottomNav(r) {
    const items = [['home', 'خانه', ICON.nHome], ['rates', 'نرخ رسمی', ICON.nRates], ['new', 'ثبت', ICON.nNew], ['market', 'بازار', ICON.nMarket],
      me() ? ['dashboard', 'داشبورد', ICON.nDash] : ['login', 'ورود', ICON.nDash]];
    return `<nav class="bottom-nav">${items.map(([h, l, ic]) => h === 'new'
      ? `<a href="#new" class="plus ${r === 'new' ? 'active' : ''}" aria-label="ثبت سفارش"><span class="plus-orb">${svg('<path d="M12 5v14M5 12h14"/>', 26)}</span></a>`
      : `<a href="#${h}" class="${r === h || r.startsWith(h + '-') ? 'active' : ''}">${ic}<span>${l}</span></a>`).join('')}</nav>`;
  }
  function footer() {
    if (ADMIN_MODE) return '<footer class="footer">دسترسی به این بخش محدود به مدیران مجاز است. همه عملیات ثبت و نگهداری می‌شود.</footer>';
    return `<footer class="footer">
      <div class="foot-links"><a href="#about">درباره سامانه</a><a href="#rules">قوانین و مقررات</a><a href="#rates">نرخ رسمی</a><a href="#market">بازار</a></div>
      سرای شهزاده کابل — سامانه ثبت پیشنهاد و ارتباط معامله‌گران. پرداخت و تحویل خارج از سامانه و مستقیماً میان طرفین انجام می‌شود.</footer>`;
  }

  function render() {
    if (!view) return;
    const r = route();
    let page;
    try { page = pageFor(r); } catch (e) { console.error(e); page = `<div class="card card-pad">${esc(e.message)}</div>`; }
    const scrollY = window.scrollY;
    const entering = render.lastRoute !== r;
    $app.innerHTML = `${header()}<main class="${entering ? 'enter' : ''}">${page}</main>${ADMIN_MODE ? '' : bottomNav(r)}${footer()}`;
    window.scrollTo(0, entering ? 0 : scrollY);
    render.lastRoute = r;
    if (entering) countUp();
    const chat = document.querySelector('.chat'); if (chat) chat.scrollTop = chat.scrollHeight;
    afterRender(r);
    attachCrosshair();
    rememberTicks();
  }
  function countUp() {
    document.querySelectorAll('[data-count]').forEach((el) => {
      const target = Number(el.dataset.count); if (!isFinite(target) || target === 0) return;
      const t0 = performance.now(), dur = 1000;
      const step = (t) => { const k = Math.min(1, (t - t0) / dur); el.textContent = Math.round(target * (1 - Math.pow(1 - k, 4))).toLocaleString('en-US'); if (k < 1) requestAnimationFrame(step); };
      el.textContent = '0'; requestAnimationFrame(step);
    });
  }

  function pageFor(r) {
    let m;
    if (ADMIN_MODE) {
      if (!isAdmin()) return pageAdminLogin();
      if ((m = /^admin-review-(\d+)$/.exec(r))) return pageReview(Number(m[1]));
      if ((m = /^admin-rates-(\w+)$/.exec(r))) return adminRates(m[1]);
      if ((m = /^admin(?:-(\w+))?$/.exec(r))) return pageAdmin(m[1] || 'home');
      if ((m = /^order-(\d+)$/.exec(r))) return adminBack() + pageOrder(Number(m[1]));
      if ((m = /^deal-(\d+)$/.exec(r))) return adminBack() + pageDeal(Number(m[1]));
      return pageAdmin('home');
    }
    if (r === 'home') return pageHome();
    if (r === 'market') return pageMarket();
    if (r === 'rates') return pageRates();
    if (r === 'new') return pageNew();
    if (r === 'login') return pageLogin();
    if (r === 'register') return pageRegister();
    if (r === 'about') return pageAbout();
    if (r === 'rules') return pageRules();
    if (r === 'profile') return needUser() || pageProfile();
    if ((m = /^dashboard(?:-(\w+))?$/.exec(r))) return needUser() || pageDashboard(m[1] || 'overview');
    if ((m = /^order-(\d+)$/.exec(r))) return needApproved() || pageOrder(Number(m[1]));
    if ((m = /^deal-(\d+)$/.exec(r))) return needUser() || pageDeal(Number(m[1]));
    if ((m = /^user-(\d+)$/.exec(r))) return needApproved() || pageUser(Number(m[1]));
    return gate('صفحه مورد نظر یافت نشد.', '<a class="btn" href="#home">صفحه اصلی</a>');
  }
  const gate = (msg, extra = '') => `<div class="auth-wrap card card-pad" style="text-align:center"><p>${msg}</p><div class="row" style="justify-content:center">${extra}</div></div>`;
  const needUser = () => (me() ? null : gate('برای مشاهده این صفحه وارد حساب خود شوید.', '<a class="btn btn-primary" href="#login">ورود</a><a class="btn" href="#register">عضویت</a>'));
  const needApproved = () => needUser() || (approved() ? null : gate(me().status === 'rejected' ? 'درخواست عضویت شما رد شده است.' : 'حساب شما در انتظار تأیید مدیریت است.', '<a class="btn btn-primary" href="#profile">وضعیت حساب</a>'));

  /* =========================================================
     Orders table (shared)
     ========================================================= */
  function actionCell(o) {
    const m = me();
    if (!m) return '<a class="btn btn-sm" href="#login">ورود</a>';
    if (o.userId === m.id) return `<a class="btn btn-sm" href="#order-${o.id}">مدیریت</a>`;
    if (o.status !== 'active') return orderBadge(o.status);
    if (!approved()) return '<button class="btn btn-sm" disabled>در انتظار تأیید</button>';
    return o.side === 'sell'
      ? `<button class="btn btn-buy btn-sm" data-act="request" data-id="${o.id}">خرید</button>`
      : `<button class="btn btn-sell btn-sm" data-act="request" data-id="${o.id}">فروش</button>`;
  }
  function ordersTable(orders, opts = {}) {
    if (!orders.length) return emptyBox(opts.empty || 'سفارشی وجود ندارد.');
    const click = approved() || ADMIN_MODE;
    return `<div class="table-wrap"><table class="data responsive"><thead><tr>
      <th>دارایی</th><th>نوع</th><th>مقدار</th><th>نرخ</th><th>ارزش</th>${opts.noOwner ? '' : '<th>ثبت‌کننده</th>'}<th>وضعیت</th><th></th></tr></thead><tbody>
      ${orders.map((o) => {
        const a = asset(o.assetId);
        const pct = o.amount ? Math.round(((o.amount - o.remaining) / o.amount) * 100) : 0;
        return `<tr class="${click ? 'clickable' : ''}" data-href="${click ? '#order-' + o.id : ''}">
          <td class="cell-main" data-l="دارایی">${assetChip(a, `سفارش #${o.id} · ${ago(o.createdAt)}`)}</td>
          <td data-l="نوع">${sideBadge(o.side)}</td>
          <td data-l="مقدار">${qty(o, o.remaining)}${o.remaining !== o.amount ? `<div class="muted small">از <span class="num">${fmt(o.amount)}</span> · ${pct}٪ واگذار شده</div>` : ''}</td>
          <td data-l="نرخ"><span class="price num">${fmt(o.price)}</span> <span class="muted small">${esc(o.priceCurrency)}</span></td>
          <td data-l="ارزش">${N(total(o, o.remaining), 2)} <span class="muted small">${esc(o.priceCurrency)}</span></td>
          ${opts.noOwner ? '' : `<td data-l="ثبت‌کننده">${o.userId ? nameLink(o.userId) : '<span class="muted">مخصوص اعضا</span>'}</td>`}
          <td data-l="وضعیت">${orderBadge(o.status)}</td>
          <td class="cell-act">${ADMIN_MODE ? '' : actionCell(o)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }
  function bookSummary() {
    const out = [];
    for (const a of view.assets.filter((x) => x.active)) {
      const os = view.orders.filter((o) => o.assetId === a.id && o.status === 'active');
      if (!os.length) continue;
      const sells = os.filter((o) => o.side === 'sell'), buys = os.filter((o) => o.side === 'buy');
      out.push({ a, ask: sells.length ? Math.min(...sells.map((o) => o.price)) : null, bid: buys.length ? Math.max(...buys.map((o) => o.price)) : null, n: os.length });
    }
    return out;
  }

  /* =========================================================
     Public pages
     ========================================================= */
  function pageHome() {
    const active = view.orders.filter((o) => o.status === 'active').sort((a, b) => b.createdAt - a.createdAt);
    const st = view.stats, n = st.activeOrders || 0;
    const mx = Math.max(st.members, st.activeDeals, st.completedDeals, 1);
    const mini = (v, c1, c2, label, color) => `<div class="ring-item"><span class="node" style="color:${color}"></span><div class="mini">${ringSvg(0.15 + 0.8 * (v / mx), 84, 5, c1, c2)}<b class="num" data-count="${v}">${v}</b></div><div class="lbl" style="color:${color}">${label}</div></div>`;
    return `
    ${me() && !approved() ? statusHero(me()) : ''}
    ${officialBoard({ compact: true })}
    <section class="hero" style="margin-top:26px">
      <div>
        <h1 style="font-size:24px">وضعیت بازار</h1>
        <p>پیشنهادهای خرید و فروش اعضای تأییدشده سرای شهزاده. برای ارسال درخواست معامله، عضویت و تأیید مدیریت لازم است.</p>
        <div class="row">
          ${knobBtn('#market', 'مشاهده بازار', ICON.nMarket)}
          ${knobBtn(approved() ? '#new' : me() ? '#profile' : '#register', approved() ? 'ثبت سفارش' : me() ? 'وضعیت حساب' : 'درخواست عضویت', approved() ? ICON.nNew : ICON.users, 'violet')}
        </div>
        ${allocationChips()}
      </div>
      <div class="rings">
        <div class="ring-big glow aura-round"><span class="halo"></span>${ringSvg(n ? st.sellOrders / n : 0.02, 250, 14, '#22d3ee', '#3b82f6')}
          <div class="center"><b class="num" data-count="${n}">${n}</b><span>پیشنهاد فعال</span><em>${st.sellOrders} فروش · ${st.buyOrders} خرید</em></div></div>
        <div class="ring-list">
          ${mini(st.members, '#3ee09a', '#12a868', 'عضو تأییدشده', 'var(--buy)')}
          ${mini(st.activeDeals, '#8b7cf6', '#3b82f6', 'معامله در حال اجرا', '#8b9cff')}
          ${mini(st.completedDeals, '#ffb34d', '#ff6b7a', 'معامله تکمیل‌شده', 'var(--sell)')}
        </div>
      </div>
    </section>
    ${pageHead('آخرین پیشنهادها', '', '<a class="btn" href="#market">همه پیشنهادها</a>').replace('class="page-head"', 'class="page-head" style="margin-top:30px"')}
    <div class="card">${ordersTable(active.slice(0, 6), { empty: 'پیشنهاد فعالی ثبت نشده است.' })}</div>
    <section class="card card-pad" style="margin-top:24px">
      <h2>روند معامله در سامانه</h2>
      ${stepper(['عضویت و تأیید مدیریت', 'ثبت سفارش خرید یا فروش', 'ارسال درخواست و تأیید صاحب سفارش', 'تماس مستقیم، تحویل و تسویه', 'تأیید تکمیل توسط هر دو طرف'], -1).replace('card card-pad stepper-card', 'stepper-plain')}
    </section>`;
  }

  // Share of active offers per asset, shown as soft chips with a mini ring.
  function allocationChips() {
    const act = view.orders.filter((o) => o.status === 'active');
    if (!act.length) return '';
    const by = {};
    for (const o of act) by[o.assetId] = (by[o.assetId] || 0) + 1;
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return `<div class="chips">${top.map(([aid, n]) => { const a = asset(Number(aid)), p = Math.round((n / act.length) * 100);
      return `<a class="chip-ring" href="#market" data-act="filter-asset" data-id="${aid}"><span class="chip-ring-ico">${ringSvg(p / 100, 40, 3.5, '#22d3ee', '#8b7cf6')}<b>${esc(a.code)}</b></span><span><b>${esc(a.name)}</b><small class="num">${p}٪ پیشنهادها</small></span></a>`; }).join('')}</div>`;
  }
  function filteredOrders() {
    const f = ui.filters;
    let os = view.orders.filter((o) => o.status === 'active');
    if (f.asset) os = os.filter((o) => o.assetId === Number(f.asset));
    if (f.side) os = os.filter((o) => o.side === f.side);
    if (f.min) os = os.filter((o) => o.price >= Number(f.min));
    if (f.max) os = os.filter((o) => o.price <= Number(f.max));
    if (f.minAmount) os = os.filter((o) => o.remaining >= Number(f.minAmount));
    if (f.q) { const q = f.q.trim(); os = os.filter((o) => { const u = user(o.userId); return u && ((u.company || '') + ' ' + (u.name || '')).includes(q); }); }
    const sorters = { new: (a, b) => b.createdAt - a.createdAt, pa: (a, b) => a.price - b.price, pd: (a, b) => b.price - a.price, amt: (a, b) => b.remaining - a.remaining };
    return os.sort(sorters[f.sort] || sorters.new);
  }
  function pageMarket() {
    const f = ui.filters;
    const book = bookSummary();
    return `${pageHead('بازار', 'پیشنهادهای فعال خرید و فروش اعضا', approved() ? '<a class="btn btn-primary" href="#new">ثبت سفارش</a>' : '')}
    ${!me() ? '<div class="notice" style="margin-bottom:18px">نام ثبت‌کننده و ارسال درخواست فقط برای اعضای تأییدشده فعال است.</div>' : ''}
    ${me() && !approved() ? '<div class="notice warn" style="margin-bottom:18px">حساب شما در انتظار تأیید مدیریت است.</div>' : ''}
    ${book.length ? `<div class="grid g4" style="margin-bottom:22px">${book.map((b) => `
      <div class="card tile sheen" style="cursor:pointer" data-act="filter-asset" data-id="${b.a.id}">
        <div class="row">${assetChip(b.a)}<span class="spacer"></span><span class="badge">${b.n}</span></div>
        <div class="grid g2" style="gap:8px;margin-top:10px">
          <div><span class="small muted">بالاترین خرید</span><div class="num" style="color:var(--buy);font-weight:800">${b.bid != null ? fmt(b.bid) : '—'}</div></div>
          <div><span class="small muted">پایین‌ترین فروش</span><div class="num" style="color:var(--sell);font-weight:800">${b.ask != null ? fmt(b.ask) : '—'}</div></div>
        </div></div>`).join('')}</div>` : ''}
    ${f.asset ? depthPanel(Number(f.asset)) : ''}
    <div class="card">
      <div class="filters">
        <select class="input" data-filter="asset"><option value="">همه دارایی‌ها</option>${view.assets.filter((a) => a.active).map((a) => `<option value="${a.id}" ${String(a.id) === f.asset ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
        <select class="input" data-filter="side"><option value="">خرید و فروش</option><option value="sell" ${f.side === 'sell' ? 'selected' : ''}>فروش</option><option value="buy" ${f.side === 'buy' ? 'selected' : ''}>خرید</option></select>
        <input class="input num" data-filter="min" placeholder="حداقل نرخ" inputmode="decimal" value="${esc(f.min)}">
        <input class="input num" data-filter="max" placeholder="حداکثر نرخ" inputmode="decimal" value="${esc(f.max)}">
        <input class="input num" data-filter="minAmount" placeholder="حداقل مقدار" inputmode="decimal" value="${esc(f.minAmount)}">
      </div>
      ${approved() ? `<div style="padding:0 18px 12px"><label class="search-pill">${orb(SEARCH)}<input data-filter="q" placeholder="جستجوی نام صرافی" value="${esc(f.q)}"></label></div>` : ''}
      <div class="row" style="padding:4px 18px 8px">
        <span class="muted small" id="market-count"></span><span class="spacer"></span>
        <select class="input" style="width:auto;padding:6px 34px 6px 14px" data-filter="sort">
          ${[['new', 'جدیدترین'], ['pa', 'کمترین نرخ'], ['pd', 'بیشترین نرخ'], ['amt', 'بیشترین مقدار']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        ${Object.entries(f).some(([k, v]) => k !== 'sort' && v) ? '<button class="btn btn-ghost btn-sm" data-act="clear-filters">حذف فیلتر</button>' : ''}
      </div>
      <div id="market-table"></div>
    </div>`;
  }
  function renderMarketTable() {
    const el = document.getElementById('market-table'); if (!el) return;
    const os = filteredOrders();
    el.innerHTML = ordersTable(os, { empty: 'پیشنهادی مطابق فیلتر یافت نشد.' });
    const c = document.getElementById('market-count'); if (c) c.textContent = `${os.length} پیشنهاد`;
  }

  function openRequest(orderId) {
    const o = orderOf(orderId); if (!o) return;
    const a = asset(o.assetId); const owner = user(o.userId);
    const verb = o.side === 'sell' ? 'خرید' : 'فروش';
    modal(`درخواست ${verb} ${esc(a.name)}`, `
      <form data-form="request" data-id="${o.id}" class="stack">
        <dl class="kv"><dt>${o.side === 'sell' ? 'فروشنده' : 'خریدار'}</dt><dd>${esc(owner ? owner.company : '')}</dd>
          <dt>نرخ</dt><dd class="num">${fmt(o.price)} ${esc(o.priceCurrency)}</dd>
          <dt>مقدار موجود</dt><dd><span class="num">${fmt(o.remaining)}</span> ${esc(o.unit)}</dd>
          ${o.minAmount ? `<dt>حداقل مقدار</dt><dd class="num">${fmt(o.minAmount)}</dd>` : ''}
          ${o.note ? `<dt>توضیحات</dt><dd>${esc(o.note)}</dd>` : ''}</dl>
        <label class="field"><span>مقدار درخواستی (${esc(o.unit)})</span>
          <input class="input num" name="amount" inputmode="decimal" value="${o.remaining}" data-calc="${o.price}" required></label>
        <div class="row small">${[0.25, 0.5, 1].map((p) => `<button type="button" class="btn btn-sm" data-act="fill-amt" data-v="${+(o.remaining * p).toFixed(6)}">${p === 1 ? 'کل مقدار' : p * 100 + '٪'}</button>`).join('')}</div>
        <div class="total-box"><span>ارزش معامله</span><b class="num" data-total>${fmt(total(o, o.remaining), 2)} ${esc(o.priceCurrency)}</b></div>
        <label class="field"><span>پیام (اختیاری)</span><textarea class="input" name="note" placeholder="زمان و محل تحویل"></textarea></label>
        <button class="btn ${o.side === 'sell' ? 'btn-buy' : 'btn-sell'} btn-block btn-lg">ارسال درخواست</button>
        <p class="muted small" style="margin:0">پس از تأیید صاحب سفارش، اطلاعات تماس دو طرف در صفحه معامله نمایش داده می‌شود.</p>
      </form>`);
  }

  function pageNew() {
    const g = needApproved(); if (g) return g;
    const assets = view.assets.filter((a) => a.active);
    const a0 = assets[0];
    return `${pageHead('ثبت سفارش', 'سفارش ثبت‌شده برای همه اعضای تأییدشده نمایش داده می‌شود.')}
    <div class="split">
      <form class="card card-pad stack aura" data-form="order">
        <div class="side-toggle">
          <button type="button" class="sell ${ui.side === 'sell' ? 'on' : ''}" data-act="side" data-v="sell">فروش</button>
          <button type="button" class="buy ${ui.side === 'buy' ? 'on' : ''}" data-act="side" data-v="buy">خرید</button>
        </div>
        <label class="field"><span>دارایی</span>
          <select class="input" name="assetId" data-change="asset-pick">${assets.map((a) => `<option value="${a.id}" data-unit="${esc(a.unit)}" data-cur="${esc(a.priceCurrency)}">${esc(a.name)} (${esc(a.code)})</option>`).join('')}</select></label>
        <div class="grid g2">
          <label class="field"><span>مقدار</span><input class="input num" name="amount" inputmode="decimal" required></label>
          <label class="field"><span>واحد مقدار</span><input class="input" name="unit" value="${esc(a0 ? a0.unit : '')}" required></label>
        </div>
        <div class="grid g2">
          <label class="field"><span>نرخ هر واحد</span><input class="input num" name="price" inputmode="decimal" required></label>
          <label class="field"><span>واحد قیمت</span><input class="input" name="priceCurrency" value="${esc(a0 ? a0.priceCurrency : '')}" required></label>
        </div>
        <div class="total-box"><span>ارزش کل</span><b class="num" data-order-total>—</b></div>
        <div id="rate-warn"></div>
        <div class="grid g2">
          <label class="field"><span>حداقل مقدار هر درخواست</span><input class="input num" name="minAmount" inputmode="decimal" placeholder="اختیاری"></label>
          <label class="field"><span>مدت اعتبار</span>
            <select class="input" name="validHours"><option value="2">۲ ساعت</option><option value="6">۶ ساعت</option><option value="24" selected>۲۴ ساعت</option><option value="72">۳ روز</option><option value="168">۷ روز</option><option value="0">تا بستن دستی</option></select></label>
        </div>
        <label class="field"><span>توضیحات</span><textarea class="input" name="note" placeholder="محل و شرایط تحویل (اختیاری)"></textarea></label>
        <button class="btn btn-primary btn-lg btn-block">ثبت سفارش</button>
      </form>
      <aside class="stack">
        <div class="card card-pad"><h3>نرخ رسمی</h3><div id="ref-rate" class="muted small"></div></div>
        <div class="card card-pad"><h3>پیشنهادهای فعال همین دارایی</h3><div id="ref-book" class="small"></div></div>
      </aside>
    </div>`;
  }
  function updateOrderAside() {
    const form = document.querySelector('[data-form="order"]'); if (!form) return;
    const aid = Number(form.assetId.value);
    const rt = primaryRate(aid);
    const rr = document.getElementById('ref-rate');
    if (rr) rr.innerHTML = rt ? `<div class="grid g2" style="gap:8px"><div>خرید<div class="num price" style="color:var(--buy)">${rt.buy != null ? fmt(rt.buy) : '—'}</div></div><div>فروش<div class="num price" style="color:var(--sell)">${rt.sell != null ? fmt(rt.sell) : '—'}</div></div></div><div class="muted small" style="margin-top:6px">${ago(rt.updatedAt)}</div>` : 'نرخ رسمی ثبت نشده است.';
    const os = view.orders.filter((o) => o.status === 'active' && o.assetId === aid);
    const sells = os.filter((o) => o.side === 'sell').sort((a, b) => a.price - b.price).slice(0, 4);
    const buys = os.filter((o) => o.side === 'buy').sort((a, b) => b.price - a.price).slice(0, 4);
    const line = (o) => `<div class="row" style="justify-content:space-between;padding:5px 0;border-bottom:1px dashed var(--line)"><span>${sideBadge(o.side)} <span class="num">${fmt(o.remaining)}</span></span><b class="num">${fmt(o.price)}</b></div>`;
    const rb = document.getElementById('ref-book');
    if (rb) rb.innerHTML = os.length ? sells.map(line).join('') + buys.map(line).join('') : '<span class="muted">پیشنهاد فعالی وجود ندارد.</span>';
    const amt = Number(String(form.amount.value).replace(/,/g, '')), pr = Number(String(form.price.value).replace(/,/g, ''));
    const t = document.querySelector('[data-order-total]');
    if (t) t.textContent = amt > 0 && pr > 0 ? `${fmt(amt * pr, 2)} ${form.priceCurrency.value}` : '—';
    const w = document.getElementById('rate-warn');
    if (w) {
      const mid = rt ? ((rt.buy ?? rt.sell) + (rt.sell ?? rt.buy)) / 2 : 0;
      w.innerHTML = rt && pr > 0 && Math.abs(pr - mid) / mid > 0.05 ? `<div class="notice warn small">نرخ واردشده ${Math.round((Math.abs(pr - mid) / mid) * 100)}٪ با نرخ رسمی فاصله دارد. ارقام را بررسی کنید.</div>` : '';
    }
  }

  /* ---------- order page ---------- */
  function pageOrder(id) {
    const o = orderOf(id);
    if (!o) return gate('این سفارش یافت نشد یا در دسترس نیست.', '<a class="btn" href="#market">بازار</a>');
    const a = asset(o.assetId);
    const mine = me() && o.userId === me().id;
    const deals = view.deals.filter((d) => d.orderId === o.id);
    const pct = o.amount ? Math.round(((o.amount - o.remaining) / o.amount) * 100) : 0;
    const rank = { pending: 0, accepted: 1, completed: 2, rejected: 3, cancelled: 4 };
    const sorted = deals.slice().sort((x, y) => rank[x.status] - rank[y.status] || y.createdAt - x.createdAt);
    const pendingN = deals.filter((d) => d.status === 'pending').length;
    const others = view.orders.filter((x) => x.status === 'active' && x.assetId === o.assetId && x.id !== o.id)
      .sort((x, y) => (x.side === y.side ? (x.side === 'sell' ? x.price - y.price : y.price - x.price) : x.side === o.side ? -1 : 1)).slice(0, 8);
    const myReq = !mine && me() ? deals.find((d) => d.requesterId === me().id && d.status === 'pending') : null;
    const guide = mine
      ? (pendingN ? `<b>اقدام شما:</b> ${pendingN} درخواست در انتظار پاسخ است. هر درخواست را تأیید (کامل یا جزئی) یا رد کنید.` : o.status === 'active' ? 'سفارش شما فعال است. درخواست‌های جدید در همین صفحه و در اعلان‌ها نمایش داده می‌شود.' : `این سفارش ${E.ORDER_STATUS[o.status]} است.`)
      : myReq ? 'درخواست شما ارسال شده و در انتظار پاسخ صاحب سفارش است.' : o.status === 'active' ? `برای ${o.side === 'sell' ? 'خرید' : 'فروش'}، دکمه درخواست را بزنید و مقدار را وارد کنید.` : '';
    return `${pageHead(`${o.side === 'sell' ? 'فروش' : 'خرید'} ${esc(a.name)} <span class="muted num" style="font-weight:400">#${o.id}</span>`, `${orderBadge(o.status)} · ثبت ${ago(o.createdAt)} · اعتبار: ${left(o.expiresAt)}`,
      `${(mine || ADMIN_MODE) && ['active', 'filled'].includes(o.status) ? `<button class="btn" data-act="close-order" data-id="${o.id}">بستن سفارش</button>` : ''}${!mine && !ADMIN_MODE && o.status === 'active' && !myReq ? actionCell(o).replace('btn-sm', 'btn-lg') : ''}`)}
    ${guide ? `<div class="notice" style="margin-bottom:18px">${guide}</div>` : ''}
    <div class="split">
      <div class="stack">
        <div class="card card-pad">
          <div class="grid g4">
            <div><span class="muted small">مقدار کل</span><div class="price">${qty(o)}</div></div>
            <div><span class="muted small">باقی‌مانده</span><div class="price" style="color:var(--blue-2)">${qty(o, o.remaining)}</div></div>
            <div><span class="muted small">نرخ</span><div class="price"><span class="num">${fmt(o.price)}</span> <span class="small muted">${esc(o.priceCurrency)}</span></div></div>
            <div><span class="muted small">ارزش کل</span><div class="price"><span class="num">${fmt(total(o), 2)}</span> <span class="small muted">${esc(o.priceCurrency)}</span></div></div>
          </div>
          <div class="fill-row">${fillNum(pct, 'واگذار شده')}<div style="flex:1"><div class="small muted" style="margin-bottom:4px">واگذار شده: <span class="num">${fmt(o.amount - o.remaining)}</span> از <span class="num">${fmt(o.amount)}</span> ${esc(o.unit)}</div>${tipBar(pct)}</div></div>
          <dl class="kv" style="margin-top:16px">
            <dt>${o.side === 'sell' ? 'فروشنده' : 'خریدار'}</dt><dd>${nameLink(o.userId)}</dd>
            ${o.minAmount ? `<dt>حداقل مقدار درخواست</dt><dd class="num">${fmt(o.minAmount)} ${esc(o.unit)}</dd>` : ''}
            <dt>زمان ثبت</dt><dd>${fmtDate(o.createdAt)}</dd>
            <dt>پایان اعتبار</dt><dd>${o.expiresAt ? fmtDate(o.expiresAt) : 'تا بستن دستی'}</dd>
            ${o.note ? `<dt>توضیحات</dt><dd>${esc(o.note)}</dd>` : ''}
          </dl>
        </div>
        <div class="card card-pad">
          <div class="row" style="margin-bottom:12px"><h2 style="margin:0">${mine || ADMIN_MODE ? 'درخواست‌های دریافتی' : 'درخواست‌های شما'}</h2><span class="spacer"></span>${pendingN && (mine || ADMIN_MODE) ? `<span class="badge warn">${pendingN} در انتظار</span>` : ''}</div>
          ${sorted.length ? sorted.map((d) => dealCard(d, o, mine)).join('') : emptyBox(mine ? 'درخواستی دریافت نشده است.' : 'درخواستی ارسال نکرده‌اید.')}
        </div>
      </div>
      <aside class="card card-pad">
        <h3>مقایسه با پیشنهادهای دیگر</h3>
        ${others.length ? `<table class="data"><thead><tr><th>نوع</th><th>مقدار</th><th>نرخ</th></tr></thead><tbody>${others.map((x) => `<tr class="clickable" data-href="#order-${x.id}"><td>${sideBadge(x.side)}</td><td class="num">${fmt(x.remaining)}</td><td class="num"><b>${fmt(x.price)}</b></td></tr>`).join('')}</tbody></table>` : emptyBox('پیشنهاد دیگری وجود ندارد.')}
      </aside>
    </div>`;
  }
  function dealCard(d, o, mine) {
    const other = user(mine ? d.requesterId : d.ownerId);
    const maxAccept = Math.min(d.amount, o.remaining);
    return `<div class="req ${d.status}">
      <div class="row"><b>${mine || ADMIN_MODE ? nameLink(d.requesterId) : 'درخواست شما'}</b>${dealBadge(d.status)}<span class="spacer"></span><span class="muted small">${ago(d.createdAt)}</span></div>
      <div class="row small" style="margin-top:6px"><span>درخواست: <b class="num">${fmt(d.amount)}</b> ${esc(o.unit)}</span>
        ${d.acceptedAmount ? `<span>· تأیید شده: <b class="num" style="color:var(--blue-2)">${fmt(d.acceptedAmount)}</b></span>` : ''}
        <span>· ارزش: <span class="num">${fmt((d.acceptedAmount || d.amount) * d.price, 2)}</span> ${esc(o.priceCurrency)}</span></div>
      ${d.note ? `<div class="small muted" style="margin-top:4px">پیام: ${esc(d.note)}</div>` : ''}
      ${d.reason ? `<div class="small muted">دلیل: ${esc(d.reason)}</div>` : ''}
      ${mine && d.status === 'pending' && other && other.phone ? `<div class="small" style="margin-top:4px">تماس: <span class="num">${esc(other.phone)}</span></div>` : ''}
      <div class="row" style="margin-top:10px">
        ${mine && d.status === 'pending' ? (maxAccept > 0
          ? `<input class="input num" style="width:130px;padding:7px 12px" data-accept-amt="${d.id}" value="${maxAccept}" inputmode="decimal" aria-label="مقدار تأیید">
             <button class="btn btn-primary btn-sm" data-act="accept" data-id="${d.id}">${maxAccept < d.amount ? 'تأیید جزئی' : 'تأیید'}</button>`
          : '<span class="muted small">مقدار باقی‌مانده کافی نیست.</span>') + `<button class="btn btn-sm" data-act="reject" data-id="${d.id}">رد</button>` : ''}
        ${!mine && !ADMIN_MODE && d.status === 'pending' ? `<button class="btn btn-sm" data-act="withdraw" data-id="${d.id}">لغو درخواست</button>` : ''}
        ${['accepted', 'completed'].includes(d.status) ? `<a class="btn btn-sm" href="#deal-${d.id}">صفحه معامله</a>` : ''}
      </div></div>`;
  }

  /* ---------- deal page ---------- */
  function pageDeal(id) {
    const d = view.deals.find((x) => x.id === id);
    if (!d) return gate('این معامله یافت نشد.', `<a class="btn" href="#${ADMIN_MODE ? 'admin-deals' : 'dashboard'}">بازگشت</a>`);
    const o = orderOf(d.orderId) || { unit: '', priceCurrency: '', side: 'sell', assetId: 0 };
    const a = asset(o.assetId);
    const m = me();
    const iAmOwner = d.ownerId === m.id, iAmReq = d.requesterId === m.id, party = !ADMIN_MODE && (iAmOwner || iAmReq);
    const sellerId = o.side === 'sell' ? d.ownerId : d.requesterId, buyerId = o.side === 'sell' ? d.requesterId : d.ownerId;
    const amt = d.acceptedAmount || d.amount;
    const myDone = iAmOwner ? d.ownerDone : d.requesterDone, otherDone = iAmOwner ? d.requesterDone : d.ownerDone;
    const msgs = view.messages.filter((x) => x.dealId === d.id);
    const partyCard = (uid, role) => {
      const u = user(uid); if (!u) return '';
      return `<div class="card card-pad"><span class="muted small">${role}</span>
        <div style="font-weight:800;font-size:16px">${nameLink(u.id)}</div>
        <div class="muted small">${esc(u.name)} · ${E.ACTIVITIES[u.activity] || ''}${u.province ? ' · ' + esc(u.province) : ''}</div>
        ${u.phone ? `<div class="row small" style="margin-top:8px"><span>تماس: <span class="num">${esc(u.phone)}</span></span>${u.whatsapp ? `<a class="badge ok" href="${waHref(u.whatsapp)}" target="_blank" rel="noopener">${ICON.wa} واتس‌اپ</a>` : ''}</div>`
          : `<div class="muted small" style="margin-top:8px">${d.status === 'pending' ? 'پس از تأیید درخواست نمایش داده می‌شود.' : 'اطلاعات تماس مخفی است.'}</div>`}
      </div>`;
    };
    let cur = 0, note = '';
    if (d.status === 'pending') { cur = 1; note = iAmOwner ? '<b>اقدام شما:</b> درخواست را تأیید یا رد کنید.' : 'در انتظار پاسخ صاحب سفارش.'; }
    else if (d.status === 'accepted') {
      cur = myDone || otherDone ? 3 : 2;
      note = !party ? 'معامله در حال اجراست.' : myDone ? 'تکمیل را اعلام کرده‌اید. در انتظار تأیید طرف مقابل.' : otherDone ? '<b>اقدام شما:</b> طرف مقابل تکمیل را اعلام کرده است. پس از اطمینان از تحویل، تکمیل را تأیید کنید.' : '<b>اقدام شما:</b> با طرف مقابل تماس بگیرید، تحویل و تسویه را انجام دهید و سپس «تأیید تکمیل» را بزنید.';
    } else if (d.status === 'completed') { cur = 5; note = 'معامله توسط هر دو طرف تکمیل شده است.'; }
    else { cur = 1; note = `این درخواست ${E.DEAL_STATUS[d.status]}.${d.reason ? ' دلیل: ' + esc(d.reason) : ''}`; }
    return `${pageHead(`معامله #${d.id} — ${esc(a.name)}`, `${dealBadge(d.status)} · سفارش <a href="#order-${d.orderId}">#${d.orderId}</a>${party ? ` · نقش شما: ${m.id === buyerId ? 'خریدار' : 'فروشنده'}` : ''}`,
      `${party && d.status === 'pending' && iAmOwner ? `<button class="btn btn-primary" data-act="accept" data-id="${d.id}">تأیید</button><button class="btn" data-act="reject" data-id="${d.id}">رد</button>` : ''}
       ${party && d.status === 'pending' && iAmReq ? `<button class="btn" data-act="withdraw" data-id="${d.id}">لغو درخواست</button>` : ''}
       ${party && d.status === 'accepted' && !myDone ? `<button class="btn btn-buy" data-act="complete" data-id="${d.id}">تأیید تکمیل</button>` : ''}
       ${d.status === 'accepted' && (party || ADMIN_MODE) ? `<button class="btn" data-act="cancel-deal" data-id="${d.id}">لغو معامله</button>` : ''}`)}
    ${stepper(['ارسال درخواست', 'تأیید صاحب سفارش', 'تحویل و تسویه', 'تأیید تکمیل دو طرف'], ['rejected', 'cancelled'].includes(d.status) ? 1 : Math.min(cur, 4), note)}
    <div class="split" style="margin-top:22px">
      <div class="stack">
        <div class="card card-pad"><div class="grid g4">
          <div><span class="muted small">دارایی</span><div>${assetChip(a)}</div></div>
          <div><span class="muted small">مقدار ${d.acceptedAmount ? 'تأییدشده' : 'درخواستی'}</span><div class="price"><span class="num">${fmt(amt)}</span> <span class="small muted">${esc(o.unit)}</span></div></div>
          <div><span class="muted small">نرخ</span><div class="price"><span class="num">${fmt(d.price)}</span> <span class="small muted">${esc(o.priceCurrency)}</span></div></div>
          <div><span class="muted small">ارزش معامله</span><div class="price"><span class="num">${fmt(amt * d.price, 2)}</span> <span class="small muted">${esc(o.priceCurrency)}</span></div></div>
        </div>${d.note ? `<p class="small muted" style="margin:12px 0 0">پیام درخواست: ${esc(d.note)}</p>` : ''}</div>
        <div class="grid g2">${partyCard(sellerId, 'فروشنده')}${partyCard(buyerId, 'خریدار')}</div>
        <div class="card card-pad">
          <h3>پیام‌ها</h3>
          <div class="chat">${msgs.length ? msgs.map((x) => `<div class="bubble ${x.userId === m.id ? 'mine' : ''}">${x.userId !== m.id ? `<b class="small">${esc((user(x.userId) || {}).company || '')}</b><br>` : ''}${esc(x.text)}<time>${ago(x.at)}</time></div>`).join('') : '<p class="muted small" style="text-align:center">پیامی ثبت نشده است.</p>'}</div>
          ${party && ['pending', 'accepted', 'completed'].includes(d.status) ? `<form class="row" data-form="message" data-id="${d.id}" style="margin-top:12px"><input class="input" name="text" placeholder="متن پیام" style="flex:1" autocomplete="off" required><button class="btn btn-primary">ارسال</button></form>` : ''}
        </div>
      </div>
      <aside class="stack">
        <div class="card card-pad"><h3>سابقه</h3><dl class="kv">
          <dt>ارسال درخواست</dt><dd>${fmtDate(d.createdAt)}</dd>
          ${d.acceptedAt ? `<dt>تأیید</dt><dd>${fmtDate(d.acceptedAt)}</dd>` : ''}
          <dt>اعلام تکمیل فروشنده</dt><dd>${(o.side === 'sell' ? d.ownerDone : d.requesterDone) ? 'بله' : '—'}</dd>
          <dt>اعلام تکمیل خریدار</dt><dd>${(o.side === 'sell' ? d.requesterDone : d.ownerDone) ? 'بله' : '—'}</dd>
          ${d.completedAt ? `<dt>تکمیل</dt><dd>${fmtDate(d.completedAt)}</dd>` : ''}</dl></div>
        ${party ? `<div class="card card-pad"><h3>گزارش تخلف</h3><p class="muted small" style="margin-top:0">در صورت تخلف طرف مقابل، به مدیریت گزارش دهید.</p><button class="btn btn-sm" data-act="report" data-uid="${iAmOwner ? d.requesterId : d.ownerId}" data-deal="${d.id}">ثبت گزارش</button></div>` : ''}
        <div class="notice small">پرداخت و تحویل خارج از سامانه انجام می‌شود. پیش از تحویل، هویت طرف مقابل را بررسی کنید.</div>
      </aside>
    </div>`;
  }

  /* ---------- dashboard ---------- */
  function pageDashboard(tab) {
    const m = me();
    const myOrders = view.orders.filter((o) => o.userId === m.id);
    const received = view.deals.filter((d) => d.ownerId === m.id);
    const sent = view.deals.filter((d) => d.requesterId === m.id);
    const mine = view.deals.filter((d) => d.ownerId === m.id || d.requesterId === m.id);
    const pendingIn = received.filter((d) => d.status === 'pending');
    const tabs = [['overview', 'نمای کلی'], ['orders', 'سفارش‌های من', myOrders.filter((o) => o.status === 'active').length],
      ['received', 'درخواست‌های دریافتی', pendingIn.length, true], ['sent', 'درخواست‌های ارسالی', sent.filter((d) => d.status === 'pending').length],
      ['deals', 'معاملات', mine.filter((d) => d.status === 'accepted').length], ['notifs', 'اعلان‌ها', view.unread, true]];
    const tabBar = `<div class="tabs">${tabs.map(([k, l, c, hot]) => `<a href="#dashboard${k === 'overview' ? '' : '-' + k}" class="${tab === k ? 'on' : ''}">${l}${c ? `<span class="count ${hot ? 'hot' : ''}">${c}</span>` : ''}</a>`).join('')}</div>`;
    let body = '';
    if (tab === 'overview') {
      // Action inbox: everything that needs this member's decision, in plain sentences.
      const todo = [];
      for (const d of pendingIn) { const o = orderOf(d.orderId) || {}; const u = user(d.requesterId); todo.push({ t: d.createdAt, html: `<b>${esc(u ? u.company : '')}</b> درخواست ${o.side === 'sell' ? 'خرید' : 'فروش'} <b class="num">${fmt(d.amount)}</b> ${esc(o.unit || '')} ${esc(asset(o.assetId).name)} از سفارش #${d.orderId} را فرستاده است.`, btn: `<a class="btn btn-primary btn-sm" href="#order-${d.orderId}">بررسی</a>` }); }
      for (const d of mine.filter((x) => x.status === 'accepted')) {
        const myDone = d.ownerId === m.id ? d.ownerDone : d.requesterDone, otherDone = d.ownerId === m.id ? d.requesterDone : d.ownerDone;
        if (!myDone) todo.push({ t: d.updatedAt, html: otherDone ? `طرف مقابل تکمیل معامله #${d.id} را اعلام کرده است. پس از اطمینان از تحویل، تأیید کنید.` : `معامله #${d.id} تأیید شده است. پس از تحویل و تسویه، تکمیل را اعلام کنید.`, btn: `<a class="btn btn-buy btn-sm" href="#deal-${d.id}">مشاهده</a>` });
      }
      todo.sort((a, b) => b.t - a.t);
      const waiting = [
        ...sent.filter((d) => d.status === 'pending').map((d) => ({ html: `درخواست شما برای سفارش #${d.orderId} در انتظار پاسخ است.`, href: `#order-${d.orderId}` })),
        ...mine.filter((d) => d.status === 'accepted' && (d.ownerId === m.id ? d.ownerDone : d.requesterDone)).map((d) => ({ html: `در انتظار تأیید تکمیل معامله #${d.id} توسط طرف مقابل.`, href: `#deal-${d.id}` })),
      ];
      body = `
      <div class="grid g4" style="margin-bottom:22px">
        <div class="card tile sheen"><span>سفارش فعال</span><b class="num" data-count="${myOrders.filter((o) => o.status === 'active').length}">${myOrders.filter((o) => o.status === 'active').length}</b></div>
        <div class="card tile sheen"><span>درخواست در انتظار پاسخ شما</span><b class="num" style="color:${pendingIn.length ? 'var(--sell)' : 'inherit'}" data-count="${pendingIn.length}">${pendingIn.length}</b></div>
        <div class="card tile sheen"><span>معامله در حال اجرا</span><b class="num" style="color:var(--blue-2)" data-count="${mine.filter((d) => d.status === 'accepted').length}">${mine.filter((d) => d.status === 'accepted').length}</b></div>
        <div class="card tile sheen"><span>معامله تکمیل‌شده</span><b class="num" style="color:var(--buy)" data-count="${mine.filter((d) => d.status === 'completed').length}">${mine.filter((d) => d.status === 'completed').length}</b></div>
      </div>
      <div class="split">
        <div class="stack">
          <div class="card card-pad ${todo.length ? 'glow g-warm aura warm' : ''}"><h2>اقدامات لازم</h2>
            ${todo.length ? todo.map((x) => `<div class="todo"><span class="todo-dot"></span><div style="flex:1">${x.html}</div>${x.btn}</div>`).join('') : '<p class="muted" style="margin:0">موردی برای اقدام وجود ندارد.</p>'}</div>
          <div class="card card-pad"><h2>در انتظار طرف مقابل</h2>
            ${waiting.length ? waiting.map((x) => `<a class="todo" href="${x.href}" style="color:inherit"><span class="todo-dot muted-dot"></span><div style="flex:1">${x.html}</div><span class="muted">‹</span></a>`).join('') : '<p class="muted" style="margin:0">موردی وجود ندارد.</p>'}</div>
        </div>
        <aside class="stack">
          <div class="card card-pad"><h3>موجودی سفارش‌های فعال</h3>
            ${remainingBlock(myOrders)}
            ${approved() ? '<a class="btn btn-primary btn-block" href="#new">ثبت سفارش</a>' : ''}
          </div>
          <div class="card card-pad"><h3>آخرین اعلان‌ها</h3>${view.notifications.slice(0, 5).map((n) => `<div class="small" style="padding:7px 0;border-bottom:1px solid var(--line)">${esc(n.text)}<div class="muted" style="font-size:11px">${ago(n.at)}</div></div>`).join('') || '<p class="muted small">اعلانی وجود ندارد.</p>'}
            <div style="margin-top:10px">${notifPermissionButton()}</div></div>
        </aside>
      </div>`;
    } else if (tab === 'orders') {
      const live = (o) => ['active', 'filled'].includes(o.status);
      const by = (side) => myOrders.filter((o) => o.side === side && live(o)).sort((a, b) => b.createdAt - a.createdAt);
      const past = myOrders.filter((o) => !live(o)).sort((a, b) => b.updatedAt - a.updatedAt);
      body = `<div class="stack">
        <div class="card"><div class="card-pad" style="padding-bottom:0"><h2>سفارش‌های فروش</h2></div>${ordersTable(by('sell'), { noOwner: true, empty: 'سفارش فروش فعالی ندارید.' })}</div>
        <div class="card"><div class="card-pad" style="padding-bottom:0"><h2>سفارش‌های خرید</h2></div>${ordersTable(by('buy'), { noOwner: true, empty: 'سفارش خرید فعالی ندارید.' })}</div>
        ${past.length ? `<div class="card"><div class="card-pad" style="padding-bottom:0"><h2>سفارش‌های بسته و منقضی</h2></div>${ordersTable(past.slice(0, 30), { noOwner: true })}</div>` : ''}</div>`;
    } else if (tab === 'received') body = `<div class="card">${received.length ? dealsTable(sortDeals(received)) : emptyBox('درخواستی دریافت نکرده‌اید.')}</div>`;
    else if (tab === 'sent') body = `<div class="card">${sent.length ? dealsTable(sortDeals(sent)) : emptyBox('درخواستی ارسال نکرده‌اید.')}</div>`;
    else if (tab === 'deals') {
      const f = ui.dealFilter;
      const groups = { active: ['accepted'], done: ['completed'], closed: ['rejected', 'cancelled'] };
      const list = mine.filter((d) => groups[f].includes(d.status)).sort((a, b) => b.updatedAt - a.updatedAt);
      body = `<div class="seg" style="margin-bottom:16px">${[['active', 'در حال اجرا'], ['done', 'تکمیل‌شده'], ['closed', 'رد یا لغو شده']].map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-act="deal-filter" data-v="${k}">${l}</button>`).join('')}</div>
        <div class="card">${list.length ? dealsTable(list) : emptyBox('موردی وجود ندارد.')}</div>`;
    } else if (tab === 'notifs') {
      body = `<div class="card">${view.unread ? '<div class="row" style="padding:12px 16px"><span class="spacer"></span><button class="btn btn-sm" data-act="read-all">علامت‌گذاری همه</button></div>' : ''}
        ${view.notifications.length ? view.notifications.map((n) => `<div class="notif ${n.read ? '' : 'unread'}" data-act="open-notif" data-id="${n.id}" data-link="${esc(n.link)}">${esc(n.text)}<time>${fmtDate(n.at)}</time></div>`).join('') : emptyBox('اعلانی وجود ندارد.')}</div>`;
    }
    return `${statusHero(m)}${pageHead(esc(m.company), `${userBadge(m.status)} · ${E.ACTIVITIES[m.activity] || ''}`, approved() ? '<a class="btn btn-primary" href="#new">ثبت سفارش</a>' : '')}${tabBar}${body}`;
  }
  function remainingBlock(myOrders) {
    const rem = {};
    for (const o of myOrders.filter((x) => x.status === 'active')) {
      const k = `${o.assetId}|${o.side}`;
      rem[k] = rem[k] || { a: asset(o.assetId), side: o.side, unit: o.unit, amt: 0, total: 0 };
      rem[k].amt += o.remaining; rem[k].total += o.amount;
    }
    const v = Object.values(rem);
    return v.length ? v.map((r) => `<div style="margin-bottom:12px"><div class="row small" style="justify-content:space-between"><span>${sideBadge(r.side)} ${esc(r.a.name)}</span><span><b class="num">${fmt(r.amt)}</b> / <span class="num">${fmt(r.total)}</span> ${esc(r.unit)}</span></div>${tipBar(r.total ? Math.round((r.amt / r.total) * 100) : 0)}</div>`).join('') : '<p class="muted small">سفارش فعالی ندارید.</p>';
  }
  const sortDeals = (ds) => ds.slice().sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.updatedAt - a.updatedAt);
  function dealsTable(ds) {
    const m = me();
    return `<div class="table-wrap"><table class="data responsive"><thead><tr><th>معامله</th><th>${ADMIN_MODE ? 'صاحب سفارش' : 'طرف مقابل'}</th><th>${ADMIN_MODE ? 'درخواست‌دهنده' : 'نقش شما'}</th><th>مقدار</th><th>نرخ</th><th>وضعیت</th><th></th></tr></thead><tbody>
    ${ds.map((d) => {
      const o = orderOf(d.orderId) || { unit: '', side: 'sell', priceCurrency: '' };
      const iOwn = d.ownerId === m.id;
      const iBuy = (o.side === 'sell') !== iOwn;
      return `<tr class="clickable" data-href="#deal-${d.id}">
        <td class="cell-main">${assetChip(asset(o.assetId), `معامله #${d.id} · ${ago(d.createdAt)}`)}</td>
        <td data-l="${ADMIN_MODE ? 'صاحب سفارش' : 'طرف مقابل'}">${nameLink(ADMIN_MODE ? d.ownerId : iOwn ? d.requesterId : d.ownerId)}</td>
        <td data-l="${ADMIN_MODE ? 'درخواست‌دهنده' : 'نقش شما'}">${ADMIN_MODE ? nameLink(d.requesterId) : iBuy ? '<span class="badge buy">خریدار</span>' : '<span class="badge sell">فروشنده</span>'}</td>
        <td data-l="مقدار"><span class="num">${fmt(d.acceptedAmount || d.amount)}</span> <span class="muted small">${esc(o.unit)}</span></td>
        <td data-l="نرخ" class="num">${fmt(d.price)}</td>
        <td data-l="وضعیت">${dealBadge(d.status)}</td>
        <td class="cell-act">${!ADMIN_MODE && iOwn && d.status === 'pending' ? `<a class="btn btn-primary btn-sm" href="#order-${d.orderId}">بررسی</a>` : `<a class="btn btn-sm" href="#deal-${d.id}">جزئیات</a>`}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }

  /* ---------- profile, registration status ---------- */
  const provinceOptions = (sel) => `<option value="">انتخاب ولایت</option>${E.PROVINCES.map((p) => `<option ${p === sel ? 'selected' : ''}>${p}</option>`).join('')}`;
  function kycInputs(u = {}) {
    return `<div class="grid g2">
        <label class="field"><span>ولایت</span><select class="input" name="province" required>${provinceOptions(u.province)}</select></label>
        <label class="field"><span>شهر / ولسوالی</span><input class="input" name="city" value="${esc(u.city || '')}"></label>
      </div>
      <label class="field"><span>آدرس دفتر یا دکان</span><input class="input" name="address" value="${esc(u.address || '')}" placeholder="مثال: سرای شهزاده، منزل دوم، دکان ۱۲" required></label>
      <div class="grid g2">
        <label class="field"><span>شماره جواز (در صورت وجود)</span><input class="input num" name="licenseNo" value="${esc(u.licenseNo || '')}"></label>
        <label class="field"><span>سابقه کار</span><input class="input" name="experience" value="${esc(u.experience || '')}" placeholder="مثال: ۸ سال"></label>
      </div>
      <div class="grid g2">
        <label class="field"><span>نام ضامن یا معرف</span><input class="input" name="guarantorName" value="${esc(u.guarantorName || '')}"></label>
        <label class="field"><span>شماره تماس ضامن</span><input class="input num" name="guarantorPhone" inputmode="tel" value="${esc(u.guarantorPhone || '')}"></label>
      </div>
      <label class="field"><span>توضیحات</span><textarea class="input" name="about" placeholder="ارزها یا کالاهای مورد معامله (اختیاری)">${esc(u.about || '')}</textarea></label>`;
  }
  function statusHero(m) {
    if (m.status === 'pending') return `<div class="card card-pad glow g-warm" style="text-align:center;margin-bottom:24px">
      <div class="ring-big" style="width:120px;height:120px;margin:6px auto 14px"><span class="halo"></span>${ringSvg(0.7, 120, 8, '#ffb34d', '#ff6b7a')}<div class="center"><b style="font-size:16px;text-shadow:none">در حال بررسی</b></div></div>
      <h2 style="margin:0 0 6px">درخواست عضویت شما در حال بررسی است</h2>
      <p class="muted" style="margin:0 0 12px">نتیجه بررسی از طریق اعلان به شما اطلاع داده می‌شود.</p>${notifPermissionButton()}</div>`;
    if (m.status === 'rejected') return `<div class="card card-pad glow g-sell" style="margin-bottom:24px">
      <h2 style="margin:0 0 6px;color:var(--sell)">درخواست عضویت شما رد شد</h2>
      ${m.statusReason ? `<p style="margin:0 0 14px">دلیل: <b>${esc(m.statusReason)}</b></p>` : ''}
      <form class="stack" data-form="resubmit"><p class="muted small" style="margin:0">مشخصات را اصلاح و مجدداً ارسال کنید.</p>
        <div class="grid g2"><label class="field"><span>نام و تخلص</span><input class="input" name="name" value="${esc(m.name)}" required></label>
        <label class="field"><span>نام صرافی / شرکت</span><input class="input" name="company" value="${esc(m.company)}" required></label></div>
        ${kycInputs(m)}
        <button class="btn btn-primary btn-lg">ارسال مجدد</button></form></div>`;
    if (m.status === 'blocked') return `<div class="card card-pad glow g-sell" style="margin-bottom:24px"><h2 style="margin:0;color:var(--sell)">حساب شما مسدود است</h2>${m.statusReason ? `<p style="margin:8px 0 0">دلیل: ${esc(m.statusReason)}</p>` : ''}</div>`;
    return '';
  }
  function pageProfile() {
    const m = me();
    return `${statusHero(m)}${pageHead('پروفایل', `${userBadge(m.status)} · عضویت از ${fmtDate(m.createdAt)}`)}
    <div class="split">
      <form class="card card-pad stack" data-form="profile">
        <h2>مشخصات</h2>
        <div class="grid g2">
          <label class="field"><span>نام و تخلص</span><input class="input" name="name" value="${esc(m.name)}" required></label>
          <label class="field"><span>نام صرافی / شرکت</span><input class="input" name="company" value="${esc(m.company)}" required></label>
          <label class="field"><span>شماره تماس</span><input class="input num" value="${esc(m.phone)}" disabled></label>
          <label class="field"><span>شماره واتس‌اپ</span><input class="input num" name="whatsapp" value="${esc(m.whatsapp)}"></label>
        </div>
        <label class="field"><span>نوع فعالیت</span><select class="input" name="activity">${Object.entries(E.ACTIVITIES).map(([k, v]) => `<option value="${k}" ${m.activity === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>معرفی (آدرس، ساعات کاری)</span><textarea class="input" name="bio">${esc(m.bio)}</textarea></label>
        <label class="row small"><input type="checkbox" class="switch" name="showContact" ${m.showContact ? 'checked' : ''}> نمایش شماره تماس به طرف معامله پس از تأیید درخواست</label>
        <button class="btn btn-primary">ذخیره</button>
      </form>
      <aside class="stack">
        <div class="card card-pad"><h3>مشخصات ثبت‌شده نزد مدیریت</h3><dl class="kv">
          <dt>ولایت</dt><dd>${esc(m.province || '—')}</dd><dt>آدرس</dt><dd>${esc(m.address || '—')}</dd><dt>ضامن</dt><dd>${esc(m.guarantorName || '—')}</dd></dl></div>
        <form class="card card-pad stack" data-form="password"><h3>تغییر رمز عبور</h3>
          <input class="input" type="password" name="current" placeholder="رمز فعلی" required autocomplete="current-password">
          <input class="input" type="password" name="next" placeholder="رمز جدید (حداقل ۸ حرف)" required autocomplete="new-password">
          <button class="btn">تغییر رمز</button></form>
      </aside>
    </div>`;
  }
  function pageUser(id) {
    const u = user(id);
    if (!u) return gate('این عضو یافت نشد.');
    const os = view.orders.filter((o) => o.userId === u.id && o.status === 'active');
    return `${pageHead(`${esc(u.company)} ${u.status === 'approved' ? ICON.check : ''}`, `${esc(u.name)} · ${E.ACTIVITIES[u.activity] || ''}${u.province ? ' · ' + esc(u.province) : ''} · عضویت از ${fmtDate(u.createdAt)}`,
      u.id !== me().id ? `<button class="btn btn-sm" data-act="report" data-uid="${u.id}">ثبت گزارش</button>` : '')}
      ${u.bio ? `<div class="card card-pad" style="margin-bottom:16px">${esc(u.bio)}</div>` : ''}
      ${u.phone ? `<div class="notice" style="margin-bottom:16px">تماس: <span class="num">${esc(u.phone)}</span></div>` : ''}
      <div class="card"><div class="card-pad" style="padding-bottom:0"><h2>سفارش‌های فعال</h2></div>${ordersTable(os, { noOwner: true, empty: 'سفارش فعالی ندارد.' })}</div>`;
  }

  /* ---------- rates page ---------- */
  /* =========================================================
     Market rates (public table, history) — data from the official sources
     ========================================================= */
  const KIND_LABEL = { auto: 'تلگرام', reviewed: 'تلگرام · بررسی‌شده', manual: 'دستی' };
  const rateKeyOf = (code, quote = 'AFN', market = 'کابل', settlement = 'cash') => `${code}|${quote}|${market}|${settlement}`;
  const assetByCode = (code) => view.assets.find((a) => a.code === code) || { code, name: code, unit: '' };
  const primaryRate = (assetId) => { const a = view.assets.find((x) => x.id === assetId); return a ? view.rates.find((r) => r.key === rateKeyOf(a.code) && !r.hidden) : null; };
  const liveRates = () => view.rates.filter((r) => !r.hidden && r.key && !r.key.startsWith('legacy|') && (r.buy != null || r.sell != null));
  function delta(cur, prev) {
    if (cur == null || prev == null || prev === 0) return null;
    return { d: cur - prev, p: ((cur - prev) / prev) * 100 };
  }
  function deltaCell(label, dl) {
    if (!dl) return `<span class="muted small">${label} —</span>`;
    const cls = dl.d > 0 ? 'up' : dl.d < 0 ? 'down' : 'flat';
    const sign = dl.d > 0 ? '▲' : dl.d < 0 ? '▼' : '■';
    return `<span class="chg ${cls} small num">${label} ${sign} ${fmt(Math.abs(dl.d), 6)} <span class="muted">(${Math.abs(dl.p).toFixed(2)}%)</span></span>`;
  }
  const quoteLabel = (q) => (E.QUOTES && E.QUOTES[q]) || q;
  const rateTime = (r) => (r && r.updatedAt ? `<span class="num">${timeFmt.format(new Date(r.updatedAt))}</span><div class="muted small">${dayFmt.format(new Date(r.updatedAt))}</div>` : '—');
  const sourceBadge = (r) => (r ? `<span class="badge ${r.kind === 'manual' ? 'warn' : 'blue'}">${KIND_LABEL[r.kind] || '—'}</span>` : '');

  // Rows for one city: every published rate there, plus listed currencies without a valid rate (Kabul only).
  function rateRows(marketName) {
    const rows = liveRates().filter((r) => r.market === marketName).map((r) => ({ r, a: assetByCode(r.code) }));
    if (marketName === 'کابل') {
      for (const a of view.assets.filter((x) => x.active && !x.deleted && x.kind === 'currency')) {
        if (!rows.some((x) => x.a.code === a.code)) rows.push({ r: null, a });
      }
    }
    return rows;
  }
  function sortRows(rows, sort) {
    const ch = (x) => { const r = x.r; if (!r) return -Infinity; const d = delta(r.sell ?? r.buy, r.sell != null ? r.prevSell : r.prevBuy); return d ? d.p : 0; };
    const by = {
      popular: (x, y) => (y.a.popular ? 1 : 0) - (x.a.popular ? 1 : 0) || (x.r ? 0 : 1) - (y.r ? 0 : 1) || (x.a.sortOrder || 99) - (y.a.sortOrder || 99),
      name: (x, y) => x.a.name.localeCompare(y.a.name, 'fa'),
      up: (x, y) => ch(y) - ch(x),
      down: (x, y) => ch(x) - ch(y),
    };
    return rows.slice().sort(by[sort] || by.popular);
  }
  function officialBoard({ compact = false } = {}) {
    const rv = ui.ratesView;
    const markets = [...new Set(['کابل', ...liveRates().map((r) => r.market)])];
    const mk = compact ? 'کابل' : rv.market;
    let rows = rateRows(mk);
    if (compact) rows = rows.filter((x) => x.r && x.r.quote === 'AFN');
    if (!compact && rv.q) {
      const q = rv.q.trim().toLowerCase();
      rows = rows.filter((x) => [x.a.name, x.a.code, ...(x.a.aliases || [])].some((v) => String(v).toLowerCase().includes(q)));
    }
    rows = sortRows(rows, compact ? 'popular' : rv.sort);
    const wl = watch.get();
    rows = [...rows.filter((x) => x.r && wl.includes(x.r.key)), ...rows.filter((x) => !(x.r && wl.includes(x.r.key)))];
    loadSparks();
    const last = liveRates().filter((r) => r.market === mk).reduce((m, r) => Math.max(m, r.updatedAt || 0), 0);
    return `<section class="card official glow aura">
      <div class="official-head">
        <div><span class="seal">${ICON.seal}</span></div>
        <div style="flex:1"><h2>نرخ ارز — بازار ${esc(mk)}</h2><div class="muted small">${longDate.format(new Date())}</div></div>
        <div class="official-meta"><span class="badge ok">منبع: کانال رسمی نرخ و ثبت مدیریت</span><div class="muted small">آخرین به‌روزرسانی: ${last ? `${timeFmt.format(new Date(last))} · ${ago(last)}` : '—'}</div></div>
      </div>
      ${compact ? '' : `<div class="rates-tools">
        <div class="seg">${markets.map((m) => `<button class="${m === mk ? 'on' : ''}" data-act="rates-market" data-v="${esc(m)}">${esc(m)}</button>`).join('')}</div>
        <label class="search-pill" style="flex:1;min-width:220px">${orb(SEARCH)}<input data-rates="q" placeholder="جستجوی نام یا نماد ارز" value="${esc(rv.q)}"></label>
        <select class="input" data-rates="sort" style="width:auto">${[['popular', 'پرمعامله‌ها'], ['name', 'نام ارز'], ['up', 'بیشترین افزایش'], ['down', 'بیشترین کاهش']].map(([v, l]) => `<option value="${v}" ${rv.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>`}
      <div class="table-wrap"><table class="data responsive official-table"><thead><tr><th>ارز</th><th>نماد</th><th>قیمت خرید</th><th>قیمت فروش</th><th>تغییرات</th><th>روند ۷ روز</th><th>آخرین به‌روزرسانی</th></tr></thead><tbody>
        ${rows.map(({ r, a }) => `<tr class="clickable ${r && rv.key === r.key && !compact ? 'sel' : ''}" ${r ? `data-act="rate-open" data-key="${esc(r.key)}"` : ''}>
          <td class="cell-main">${r ? `<button class="star ${wl.includes(r.key) ? 'on' : ''}" data-act="watch" data-key="${esc(r.key)}" aria-label="فهرست منتخب">★</button>` : ''}${assetChip(a)}</td>
          <td data-l="نماد"><b class="ltr">${esc(a.code)}</b><div class="muted small">به ${esc(quoteLabel(r ? r.quote : 'AFN'))}${r && r.settlement === 'forward' ? ' · <span class="badge warn">فردایی</span>' : ''}</div></td>
          <td data-l="قیمت خرید" class="${flashCls(r, 'buy')}">${r && r.buy != null ? `<b class="num price" style="color:var(--buy)">${fmt(r.buy)}</b>` : '<span class="muted small">بدون نرخ معتبر</span>'}</td>
          <td data-l="قیمت فروش" class="${flashCls(r, 'sell')}">${r && r.sell != null ? `<b class="num price" style="color:var(--sell)">${fmt(r.sell)}</b>` : '<span class="muted small">بدون نرخ معتبر</span>'}</td>
          <td data-l="تغییرات"><div class="delta-stack">${r ? deltaCell('خرید', delta(r.buy, r.prevBuy)) + deltaCell('فروش', delta(r.sell, r.prevSell)) : '<span class="muted small">—</span>'}</div></td>
          <td data-l="روند ۷ روز">${r ? sparkSvg((ui.sparks || {})[r.key]) : ''}</td>
          <td data-l="آخرین به‌روزرسانی">${r ? `${rateTime(r)}<div style="margin-top:3px">${sourceBadge(r)}${isStale(r) ? ' <span class="badge">قدیمی</span>' : ''}</div>` : '<span class="muted small">منتشر نشده</span>'}</td></tr>`).join('') || `<tr><td colspan="7">${emptyBox('نرخی مطابق جستجو یافت نشد.')}</td></tr>`}
      </tbody></table></div>
      <p class="muted small" style="margin:6px 22px 18px">${compact ? '<a href="#rates">جدول کامل نرخ‌ها، شهرها و تاریخچه</a> · ' : ''}نرخ پیشنهادهای اعضا در بخش «بازار» جداگانه نمایش داده می‌شود. نرخی که منتشر نشده باشد نمایش داده نمی‌شود.</p>
    </section>`;
  }

  // Chart with independent buy / sell lines (a side may be missing at some points).
  function lineChart(points, { w = 640, h = 230 } = {}) {
    const pts = points.filter((p) => p.buy != null || p.sell != null);
    if (pts.length < 2) return '<p class="muted small">برای این بازه داده کافی برای نمودار وجود ندارد.</p>';
    const vals = pts.flatMap((p) => [p.buy, p.sell]).filter((v) => v != null);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (lo === hi) { lo *= 0.999; hi *= 1.001; }
    const pad = 28, padL = 8;
    const t0 = pts[0].at, t1 = pts[pts.length - 1].at;
    const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (w - padL - 70);
    const Y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2);
    const path = (k) => { let d = '', last = null; for (const p of pts) { const v = p[k] != null ? p[k] : last; if (v == null) continue; d += `${d ? 'L' : 'M'}${X(p.at).toFixed(1)},${Y(v).toFixed(1)}`; last = v; } return d; };
    const fmtT = (t) => (t1 - t0 < 2 * 864e5 ? timeFmt : dayFmt).format(new Date(t));
    const xl = [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]];
    const sellP = path('sell'), buyP = path('buy');
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="نمودار قیمت خرید و فروش" style="direction:ltr">
      <defs><linearGradient id="ga" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#3b82f6" stop-opacity=".25"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>
      ${[lo, (lo + hi) / 2, hi].map((v) => `<line x1="${padL}" x2="${w - 70}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(127,127,127,.18)" stroke-dasharray="3 4"/><text x="${w - 64}" y="${Y(v) + 4}" font-size="11" fill="#7a879c">${fmt(v, 4)}</text>`).join('')}
      ${sellP ? `<path d="${sellP}L${X(t1)},${h - pad}L${X(t0)},${h - pad}Z" fill="url(#ga)"/>` : ''}
      ${buyP ? `<path class="draw" d="${buyP}" fill="none" stroke="#2fd389" stroke-width="2.2"/>` : ''}
      ${sellP ? `<path class="draw" d="${sellP}" fill="none" stroke="#3b82f6" stroke-width="2.4"/>` : ''}
      ${xl.map((p) => `<text x="${X(p.at)}" y="${h - 6}" font-size="11" fill="#7a879c" text-anchor="middle">${fmtT(p.at)}</text>`).join('')}
    </svg>`;
  }
  const PERIODS = [['today', 'امروز'], ['yesterday', 'دیروز'], ['7d', '۷ روز'], ['30d', '۱ ماه'], ['90d', '۳ ماه']];
  async function loadHistory() {
    const rv = ui.ratesView; if (!rv.key) return;
    const want = rv.key + '|' + rv.period;
    rv.loading = want;
    try { const r = await backend.rateHistory(rv.key, rv.period); if (rv.loading === want) { rv.hist = r.points; rv.stats = r.stats || null; rv.histFor = want; } }
    catch (e) { toast(e.message, true); rv.hist = []; rv.histFor = want; }
    rv.loading = null; render();
  }
  function historyPanel() {
    const rv = ui.ratesView;
    const r = view.rates.find((x) => x.key === rv.key);
    if (!r) return '';
    if (rv.histFor !== rv.key + '|' + rv.period && rv.loading !== rv.key + '|' + rv.period) loadHistory();
    const a = assetByCode(r.code);
    const pts = rv.histFor === rv.key + '|' + rv.period ? rv.hist || [] : null;
    const rowsDesc = pts ? pts.slice().reverse().slice(0, 60) : [];
    return `<section class="split" style="margin-top:24px" id="rate-history">
      <div class="card card-pad">
        <div class="row"><h2 style="margin:0">تاریخچه ${esc(a.name)} <span class="muted small">(${esc(r.market)} · به ${esc(quoteLabel(r.quote))}${r.settlement === 'forward' ? ' · فردایی' : ''})</span></h2><span class="spacer"></span>
          <span class="small"><span style="color:var(--buy)">━ خرید</span> &nbsp; <span style="color:var(--blue-2)">━ فروش</span></span></div>
        ${pts ? statsStrip(rv.stats, r) : ''}
        <div class="row" style="margin:16px 0 8px;gap:10px">
          <div class="seg">${PERIODS.map(([k, l]) => `<button class="${rv.period === k ? 'on' : ''}" data-act="rates-period" data-v="${k}">${l}</button>`).join('')}</div>
          <div class="seg"><button class="${rv.chart === 'line' ? 'on' : ''}" data-act="chart-mode" data-v="line">خطی</button><button class="${rv.chart === 'candle' ? 'on' : ''}" data-act="chart-mode" data-v="candle">شمعی</button></div>
          ${rv.chart === 'candle' ? `<div class="seg"><button class="${rv.cside === 'sell' ? 'on' : ''}" data-act="chart-side" data-v="sell">فروش</button><button class="${rv.cside === 'buy' ? 'on' : ''}" data-act="chart-side" data-v="buy">خرید</button></div>` : ''}
          <span class="spacer"></span>${backend.mode === 'server' ? `<a class="btn btn-sm" href="/api/rates/history?${qs({ key: rv.key, period: rv.period, format: 'csv' })}">دریافت CSV</a>` : ''}
        </div>
        <div class="chart">${pts ? (rv.chart === 'candle' ? candleChart(pts, { today: 3600e3, yesterday: 3600e3, '7d': 4 * 3600e3, '30d': 864e5, '90d': 864e5 }[rv.period], rv.cside) : lineChartX(pts)) : '<div class="empty">در حال دریافت…</div>'}</div>
      </div>
      <aside class="stack">${alertsBox(r)}<div class="card card-pad"><h3>نرخ‌های ثبت‌شده</h3>
        ${pts ? (rowsDesc.length ? `<div class="hist-list" style="max-height:300px">${rowsDesc.map((p) => `<div class="hist-row"><span class="small muted">${fmtDate(p.at)}</span><span class="num" style="color:var(--buy)">${p.buy != null ? fmt(p.buy) : '—'}</span><span class="num" style="color:var(--sell)">${p.sell != null ? fmt(p.sell) : '—'}</span><span class="badge ${p.kind === 'manual' ? 'warn' : ''}">${KIND_LABEL[p.kind] || ''}</span></div>`).join('')}</div>` : '<p class="muted small">در این بازه نرخی ثبت نشده است.</p>') : ''}
      </div></aside>
    </section>`;
  }
  function pageRates() {
    const rv = ui.ratesView;
    if (!rv.key) { const first = sortRows(rateRows(rv.market), 'popular').find((x) => x.r); if (first) rv.key = first.r.key; }
    return `${marketBar()}${officialBoard()}${rv.key ? historyPanel() : ''}<div class="grid g2" style="margin-top:24px">${converter()}${crossMatrix()}</div>${heatmap()}`;
  }

  /* ---------- admin: rates, review queue, messages, sources ---------- */
  const STATUS_LABEL = { applied: ['ثبت شد', 'ok'], review: ['نیاز به بررسی', 'warn'], ignored: ['نادیده گرفته شد', ''], nodata: ['بدون نرخ', ''], stale: ['قدیمی‌تر از نرخ فعلی', ''], held: ['نرخ دستی فعال است', 'blue'] };
  const ITEM_STATE = { applied: 'ثبت شد', review: 'بررسی', stale: 'قدیمی', held: 'نرخ دستی', reviewed: 'ثبت با بررسی' };
  async function loadMessages() {
    const R = ui.adminRates; R.loading = true;
    try { const r = await backend.adminMessages({ status: R.status }); R.msgs = r.messages; R.total = r.total; }
    catch (e) { toast(e.message, true); R.msgs = []; }
    R.loading = false; render();
  }
  const opt = (pairs, sel) => pairs.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const currencyOptions = (sel) => `<option value="">انتخاب ارز</option>${opt(view.assets.filter((a) => !a.deleted).map((a) => [a.code, `${a.name} (${a.code})`]), sel)}`;
  const quoteOptions = (sel) => opt(Object.entries(E.QUOTES).map(([k, v]) => [k, v]), sel || 'AFN');
  const marketOptions = (sel) => opt(E.MARKETS.map((m) => [m, m]), sel || 'کابل');
  const settleOptions = (sel) => opt(Object.entries(E.SETTLEMENT), sel || 'cash');
  function rateFields(it = {}, prefix = '') {
    return `<div class="grid g2">
      <label class="field"><span>ارز</span><select class="input" name="${prefix}code" required>${currencyOptions(it.code)}</select></label>
      <label class="field"><span>به</span><select class="input" name="${prefix}quote">${quoteOptions(it.quote)}</select></label>
      <label class="field"><span>شهر / بازار</span><select class="input" name="${prefix}market">${marketOptions(it.market)}</select></label>
      <label class="field"><span>نوع تسویه</span><select class="input" name="${prefix}settlement">${settleOptions(it.settlement)}</select></label>
      <label class="field"><span>قیمت خرید</span><input class="input num" name="${prefix}buy" inputmode="decimal" value="${it.buy ?? ''}"></label>
      <label class="field"><span>قیمت فروش</span><input class="input num" name="${prefix}sell" inputmode="decimal" value="${it.sell ?? ''}"></label>
    </div>`;
  }
  function adminRates(sub) {
    const A = view.admin, R = ui.adminRates;
    const tabs = [['list', 'نرخ‌ها'], ['review', 'صف بررسی', A.reviewCount], ['messages', 'پیام‌های تلگرام'], ['sources', 'منابع'], ['paste', 'ورود دستی پیام']];
    const bar = `<div class="tabs">${tabs.map(([k, l, c]) => `<a href="#admin-rates${k === 'list' ? '' : '-' + k}" class="${sub === k ? 'on' : ''}">${l}${c ? `<span class="count hot">${c}</span>` : ''}</a>`).join('')}</div>`;
    let body = '';
    if (sub === 'list') {
      const rows = view.rates.filter((r) => r.key && !r.key.startsWith('legacy|')).sort((x, y) => x.market.localeCompare(y.market, 'fa') || (assetByCode(x.code).sortOrder || 99) - (assetByCode(y.code).sortOrder || 99));
      body = `<div class="row" style="margin-bottom:16px"><div class="notice small" style="flex:1">نرخ‌ها به‌طور خودکار از منابع تلگرام دریافت می‌شوند. ویرایش دستی، نرخ را «دستی» علامت‌گذاری می‌کند و تا بازگشت به حالت خودکار، پیام‌های جدید آن را تغییر نمی‌دهند.</div><button class="btn btn-primary" data-act="rate-new">ثبت نرخ دستی</button></div>
        <div class="card"><div class="table-wrap"><table class="data responsive"><thead><tr><th>ارز</th><th>بازار</th><th>خرید</th><th>فروش</th><th>منبع</th><th>زمان</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="${r.hidden ? 'dim' : ''}"><td class="cell-main">${assetChip(assetByCode(r.code), `به ${esc(quoteLabel(r.quote))}`)}</td>
          <td data-l="بازار">${esc(r.market)}${r.settlement === 'forward' ? ' <span class="badge warn">فردایی</span>' : ''}${r.hidden ? ' <span class="badge">مخفی</span>' : ''}</td>
          <td data-l="خرید" class="num"><b>${r.buy != null ? fmt(r.buy) : '—'}</b></td><td data-l="فروش" class="num"><b>${r.sell != null ? fmt(r.sell) : '—'}</b></td>
          <td data-l="منبع">${sourceBadge(r)}</td><td data-l="زمان" class="small">${fmtDate(r.updatedAt)}</td>
          <td class="cell-act"><div class="row">
            <button class="btn btn-sm" data-act="rate-edit" data-key="${esc(r.key)}">ویرایش</button>
            ${r.manual ? `<button class="btn btn-sm" data-act="rate-auto" data-key="${esc(r.key)}">بازگشت به خودکار</button>` : ''}
            <button class="btn btn-sm" data-act="rate-hist" data-key="${esc(r.key)}">تاریخچه</button>
            <button class="btn btn-sm" data-act="rate-hide" data-key="${esc(r.key)}">${r.hidden ? 'نمایش' : 'مخفی'}</button>
          </div></td></tr>`).join('') || `<tr><td colspan="7">${emptyBox('هنوز نرخی ثبت نشده است.')}</td></tr>`}
        </tbody></table></div></div>`;
    } else if (sub === 'review' || sub === 'messages') {
      const want = sub === 'review' ? 'review' : R.filter;
      if (R.status !== want) { R.status = want; R.msgs = null; }
      if (R.msgs === null && !R.loading) loadMessages();
      const filters = sub === 'messages' ? `<div class="seg" style="margin-bottom:16px;overflow-x:auto;max-width:100%">${[['', 'همه'], ['applied', 'ثبت‌شده'], ['review', 'نیاز به بررسی'], ['held', 'دستی'], ['stale', 'قدیمی'], ['ignored', 'نادیده'], ['nodata', 'بدون نرخ']].map(([k, l]) => `<button class="${R.filter === k ? 'on' : ''}" data-act="msg-filter" data-v="${k}">${l}</button>`).join('')}</div>` : '';
      const list = R.msgs || [];
      body = `${filters}${sub === 'review' ? '<div class="notice small" style="margin-bottom:16px">این پیام‌ها به دلیل ابهام یا تغییر غیرعادی به‌طور خودکار ثبت نشده‌اند. مقادیر را بررسی و در صورت نیاز اصلاح کنید.</div>' : ''}
        ${R.loading && !R.msgs ? '<div class="empty">در حال دریافت…</div>' : list.length ? list.map((m) => messageCard(m, sub === 'review')).join('') : emptyBox(sub === 'review' ? 'پیامی در صف بررسی نیست.' : 'پیامی وجود ندارد.')}`;
    } else if (sub === 'sources') {
      body = `<div class="split"><div class="stack">${A.sources.map((s) => `<div class="card card-pad">
          <div class="row"><b>${esc(s.label)}</b><span class="badge ${s.enabled ? 'ok' : ''}">${s.enabled ? 'فعال' : 'غیرفعال'}</span><span class="badge ${s.autoApply ? 'blue' : 'warn'}">${s.autoApply ? 'ثبت خودکار' : 'فقط با بررسی'}</span><span class="spacer"></span>
            <a class="small ltr" href="https://t.me/${esc(s.channel)}" target="_blank" rel="noopener">t.me/${esc(s.channel)}</a></div>
          <dl class="kv" style="margin-top:10px"><dt>بازار پیش‌فرض</dt><dd>${esc(s.defaultMarket)}</dd>
            <dt>آخرین دریافت</dt><dd>${s.lastFetchAt ? `${fmtDate(s.lastFetchAt)} (${ago(s.lastFetchAt)})` : '—'}</dd>
            <dt>آخرین پیام</dt><dd class="num">${esc(s.lastMsgId || '—')}</dd>
            ${s.lastError ? `<dt>خطا</dt><dd style="color:var(--sell)">${esc(s.lastError)}</dd>` : ''}</dl>
          <div class="row" style="margin-top:12px">
            <button class="btn btn-primary btn-sm" data-act="source-fetch" data-id="${s.id}">دریافت فوری</button>
            <button class="btn btn-sm" data-act="source-toggle" data-id="${s.id}" data-v="enabled">${s.enabled ? 'توقف دریافت' : 'فعال‌سازی دریافت'}</button>
            <button class="btn btn-sm" data-act="source-toggle" data-id="${s.id}" data-v="autoApply">${s.autoApply ? 'غیرفعال‌سازی ثبت خودکار' : 'فعال‌سازی ثبت خودکار'}</button>
          </div></div>`).join('') || emptyBox('منبعی تعریف نشده است.')}</div>
        <form class="card card-pad stack" data-form="source"><h3>افزودن کانال تلگرام</h3>
          <label class="field"><span>آدرس یا نام کانال</span><input class="input ltr" name="channel" placeholder="https://t.me/channel_name" required></label>
          <label class="field"><span>عنوان</span><input class="input" name="label"></label>
          <label class="field"><span>بازار پیش‌فرض (اگر در پیام ذکر نشود)</span><select class="input" name="defaultMarket">${marketOptions('کابل')}</select></label>
          <p class="muted small" style="margin:0">کانال باید عمومی باشد. پیام‌ها هر ۶۰ ثانیه بررسی می‌شوند.</p>
          <button class="btn btn-primary">ذخیره منبع</button></form></div>`;
    } else if (sub === 'paste') {
      body = `<form class="card card-pad stack" data-form="paste" style="max-width:720px">
        <p class="muted small" style="margin:0">در صورت قطع دسترسی به کانال، متن پیام را اینجا وارد کنید. پیام پس از تحلیل در صف بررسی قرار می‌گیرد.</p>
        <label class="field"><span>منبع</span><select class="input" name="sourceId">${opt(A.sources.map((s) => [s.id, s.label]), '')}</select></label>
        <label class="field"><span>متن پیام</span><textarea class="input" name="text" rows="6" required placeholder="دالر به افغانی کابل&#10;خرید 64.92 فروش 64.94"></textarea></label>
        <button class="btn btn-primary">تحلیل پیام</button></form>`;
    }
    return `${moduleHead('rates')}${bar}${body}`;
  }
  function messageCard(m, editable) {
    const [lbl, cls] = STATUS_LABEL[m.status] || [m.status, ''];
    const items = m.items || [];
    return `<div class="card card-pad msg-card" style="margin-bottom:16px">
      <div class="row"><b>${esc(m.channel)}</b><span class="muted small num">#${esc(m.msgId)}</span><span class="badge ${cls}">${lbl}</span><span class="spacer"></span><span class="muted small">${fmtDate(m.postedAt)}</span></div>
      ${m.note ? `<div class="notice warn small" style="margin-top:8px">${esc(m.note)}</div>` : ''}
      <pre class="msg-text">${esc(m.text)}</pre>
      ${editable ? `<form data-form="msg-apply" data-id="${m.id}" class="stack">
          ${items.map((it, i) => `<div class="msg-item ${it.state === 'applied' ? 'done' : ''}">
            <label class="row small"><input type="checkbox" class="switch" name="use${i}" ${it.state !== 'applied' && it.state !== 'stale' ? 'checked' : ''}> مورد ${i + 1} ${it.state === 'applied' ? '— قبلاً ثبت شده' : ''}</label>
            ${it.issues && it.issues.length ? `<div class="issues">${it.issues.map((x) => `<span class="badge warn">${esc(x)}</span>`).join('')}</div>` : ''}
            ${it.unlabeled != null ? `<div class="small muted">عدد بدون برچسب در پیام: <b class="num">${fmt(it.unlabeled)}</b> — نوع نرخ را مشخص کنید.</div>` : ''}
            ${rateFields(it, `i${i}_`)}
          </div>`).join('') || '<p class="muted small">نرخی در این پیام شناسایی نشد.</p>'}
          <div class="row">${items.length ? '<button class="btn btn-buy">ثبت موارد انتخاب‌شده</button>' : ''}<button type="button" class="btn" data-act="msg-ignore" data-id="${m.id}">نادیده گرفتن پیام</button></div>
        </form>`
      : items.length ? `<div class="msg-items">${items.map((it) => `<span class="badge ${it.state === 'applied' || it.state === 'reviewed' ? 'ok' : it.state === 'review' ? 'warn' : ''}">${esc(it.code || '؟')} · ${esc(it.market)}${it.settlement === 'forward' ? ' · فردایی' : ''} · خرید ${it.buy != null ? fmt(it.buy) : '—'} · فروش ${it.sell != null ? fmt(it.sell) : '—'} · ${ITEM_STATE[it.state] || ''}</span>`).join('')}</div>` : ''}
    </div>`;
  }

  /* =========================================================
     Professional market tools (rates page)
     ========================================================= */
  const watch = { get() { try { return JSON.parse(store.get('sarai-watch') || '[]'); } catch { return []; } }, toggle(k) { const w = watch.get(); const i = w.indexOf(k); i >= 0 ? w.splice(i, 1) : w.push(k); store.set('sarai-watch', JSON.stringify(w)); } };
  const STALE_MS = 6 * 3600e3;
  const isStale = (r) => r && r.updatedAt && Date.now() - r.updatedAt > STALE_MS;
  const lastSeen = new Map(); // key -> {buy, sell} for tick flashes
  function flashCls(r, side) {
    if (!r) return '';
    const prev = lastSeen.get(r.key);
    if (!prev || prev[side] == null || r[side] == null || prev[side] === r[side]) return '';
    return r[side] > prev[side] ? 'flash-up' : 'flash-down';
  }
  function rememberTicks() { for (const r of liveRates()) lastSeen.set(r.key, { buy: r.buy, sell: r.sell }); }
  function sparkSvg(arr) {
    if (!arr || arr.length < 2) return '<span class="muted small">—</span>';
    const w = 96, h = 30, lo = Math.min(...arr), hi = Math.max(...arr), rg = hi - lo || 1;
    const d = arr.map((v, i) => `${i ? 'L' : 'M'}${((i / (arr.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - lo) / rg) * (h - 6)).toFixed(1)}`).join('');
    const up = arr[arr.length - 1] >= arr[0], c = up ? '#2fd389' : '#ff6b7a';
    return `<svg class="spark-mini" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="direction:ltr"><path d="${d}" fill="none" stroke="${c}" stroke-width="1.8" style="filter:drop-shadow(0 0 3px ${c}88)"/></svg>`;
  }
  async function loadSparks() {
    if (ui.sparksAt && Date.now() - ui.sparksAt < 60e3) return;
    ui.sparksAt = Date.now();
    try { ui.sparks = await backend.sparks(); if (route() === 'rates' || route() === 'home') render(); } catch { /* optional */ }
  }

  // World market clocks (updated every second without re-rendering the page).
  const CLOCKS = [['کابل', 'Asia/Kabul'], ['تهران', 'Asia/Tehran'], ['دبی', 'Asia/Dubai'], ['استانبول', 'Europe/Istanbul'], ['لندن', 'Europe/London'], ['نیویورک', 'America/New_York']];
  const clockFmt = {};
  const clockText = (tz) => { clockFmt[tz] = clockFmt[tz] || new Intl.DateTimeFormat('fa-AF', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz }); return clockFmt[tz].format(new Date()); };
  function marketBar() {
    const lr = liveRates(); const last = lr.reduce((m, r) => Math.max(m, r.updatedAt || 0), 0);
    const fresh = last && Date.now() - last < STALE_MS;
    return `<div class="market-bar card">
      <div class="mb-status"><span class="pulse-dot ${fresh ? '' : 'off'}"></span><div><b>${fresh ? 'دریافت نرخ فعال' : 'نرخ تازه‌ای دریافت نشده'}</b><div class="muted small">آخرین نرخ: ${last ? ago(last) : '—'} · ${lr.length} نرخ فعال</div></div></div>
      <div class="clocks">${CLOCKS.map(([n, tz]) => `<div class="clock"><span class="muted small">${n}</span><b class="num" data-clock="${tz}">${clockText(tz)}</b></div>`).join('')}</div>
    </div>`;
  }
  setInterval(() => document.querySelectorAll('[data-clock]').forEach((el) => { el.textContent = clockText(el.dataset.clock); }), 1000);

  // Heatmap of today's change for Kabul rates in afghani.
  function heatmap() {
    const rows = liveRates().filter((r) => r.market === 'کابل' && r.quote === 'AFN' && r.settlement === 'cash');
    if (!rows.length) return '';
    return `<section class="card card-pad" style="margin-top:22px"><div class="row"><h2 style="margin:0">نقشه حرارتی تغییرات</h2><span class="muted small">بازار کابل · نسبت به نرخ قبلی</span></div>
      <div class="heat">${rows.map((r) => {
        const dl = delta(r.sell ?? r.buy, r.sell != null ? r.prevSell : r.prevBuy); const p = dl ? dl.p : 0;
        const a = Math.min(1, Math.abs(p) / 1.5), bg = p > 0 ? `rgba(47,211,137,${0.15 + a * 0.55})` : p < 0 ? `rgba(255,107,122,${0.15 + a * 0.55})` : 'rgba(127,127,127,.15)';
        return `<button class="heat-tile" style="background:${bg}" data-act="rate-open" data-key="${esc(r.key)}"><b class="ltr">${esc(r.code)}</b><span class="small">${esc(assetByCode(r.code).name)}</span><span class="num">${p > 0 ? '+' : ''}${p.toFixed(2)}%</span></button>`;
      }).join('')}</div></section>`;
  }

  // Currency converter using the Kabul afghani rates (direction-aware: buy vs sell).
  function converter() {
    const lr = liveRates().filter((r) => r.market === 'کابل' && r.quote === 'AFN' && r.settlement === 'cash');
    if (!lr.length) return '';
    const C = ui.conv;
    const codes = ['AFN', ...lr.map((r) => r.code)];
    if (!codes.includes(C.from)) C.from = lr[0].code;
    if (!codes.includes(C.to)) C.to = 'AFN';
    const name = (c) => (c === 'AFN' ? 'افغانی' : assetByCode(c).name);
    const rate = (c) => lr.find((r) => r.code === c);
    const amt = Number(String(C.amount).replace(/,/g, '')) || 0;
    let out = null, how = '', missing = false;
    if (C.from === C.to) { out = amt; how = '—'; }
    else {
      // Selling foreign currency to the exchanger uses its BUY price; buying from it uses its SELL price.
      let afn = amt;
      if (C.from !== 'AFN') { const r = rate(C.from); if (!r || r.buy == null) missing = true; else { afn = amt * r.buy; how += `${name(C.from)} × خرید ${fmt(r.buy)}`; } }
      if (!missing && C.to !== 'AFN') { const r = rate(C.to); if (!r || r.sell == null) missing = true; else { out = afn / r.sell; how += `${how ? ' ← ' : ''}÷ فروش ${name(C.to)} ${fmt(r.sell)}`; } }
      else if (!missing) out = afn;
    }
    const sel = (field, v) => `<select class="input" data-conv="${field}">${codes.map((c) => `<option value="${c}" ${c === v ? 'selected' : ''}>${esc(name(c))} (${c})</option>`).join('')}</select>`;
    return `<section class="card card-pad aura conv"><h2>مبدل ارز</h2>
      <div class="conv-grid">
        <label class="field"><span>مبلغ</span><input class="input num conv-amt" data-conv="amount" inputmode="decimal" value="${esc(C.amount)}"></label>
        <label class="field"><span>از</span>${sel('from', C.from)}</label>
        <button class="glass-orb conv-swap" data-act="conv-swap" aria-label="جابه‌جایی">${svg('<path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3"/>', 22)}</button>
        <label class="field"><span>به</span>${sel('to', C.to)}</label>
      </div>
      <div class="conv-out">${missing ? '<span class="muted">نرخ معتبر برای این تبدیل موجود نیست.</span>' : `<b class="num">${fmt(out, out > 100 ? 2 : 6)}</b> <span>${esc(name(C.to))}</span>`}</div>
      <p class="muted small" style="margin:6px 0 0">${missing ? '' : esc(how) + ' · '}بر اساس نرخ نقدی بازار کابل. فروش ارز به صراف با نرخ خرید و خرید ارز از صراف با نرخ فروش محاسبه می‌شود.</p>
    </section>`;
  }

  // Cross rates between currencies (mid prices via afghani).
  function crossMatrix() {
    const lr = liveRates().filter((r) => r.market === 'کابل' && r.quote === 'AFN' && r.settlement === 'cash' && r.buy != null && r.sell != null);
    if (lr.length < 2) return '';
    const list = lr.slice(0, 7), mid = (r) => (r.buy + r.sell) / 2;
    return `<section class="card card-pad"><h2>نرخ‌های متقاطع</h2><p class="muted small" style="margin-top:-6px">ارزش یک واحد ارز ستون راست بر حسب ارز ستون بالا (میانگین خرید و فروش)</p>
      <div class="table-wrap"><table class="cross"><thead><tr><th></th><th class="ltr">AFN</th>${list.map((c) => `<th class="ltr">${esc(c.code)}</th>`).join('')}</tr></thead><tbody>
      ${list.map((r) => `<tr><th class="ltr">${esc(r.code)}</th><td class="num">${fmt(mid(r), 4)}</td>${list.map((c) => `<td class="num ${c.code === r.code ? 'muted' : ''}">${c.code === r.code ? '1' : fmt(mid(r) / mid(c), mid(r) / mid(c) > 10 ? 2 : 5)}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div></section>`;
  }

  // Candles from history points: open/high/low/close per time bucket for one side.
  function toCandles(points, tf, side) {
    const out = []; let cur = null, last = null;
    for (const p of points) {
      const v = p[side] != null ? p[side] : null;
      if (v == null) continue;
      const b = Math.floor(p.at / tf) * tf;
      if (!cur || cur.t !== b) { cur = { t: b, o: last ?? v, h: Math.max(last ?? v, v), l: Math.min(last ?? v, v), c: v }; out.push(cur); }
      else { cur.h = Math.max(cur.h, v); cur.l = Math.min(cur.l, v); cur.c = v; }
      last = v;
    }
    return out;
  }
  let chartModel = null; // for the crosshair
  function candleChart(points, tf, side, { w = 640, h = 240 } = {}) {
    const cs = toCandles(points, tf, side);
    if (cs.length < 2) return '<p class="muted small">برای نمودار شمعی در این بازه داده کافی وجود ندارد.</p>';
    let lo = Math.min(...cs.map((c) => c.l)), hi = Math.max(...cs.map((c) => c.h));
    if (lo === hi) { lo *= 0.999; hi *= 1.001; }
    const pad = 24, padL = 8, iw = w - padL - 70;
    const X = (i) => padL + ((i + 0.5) / cs.length) * iw, bw = Math.max(2, Math.min(16, (iw / cs.length) * 0.6));
    const Y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2);
    chartModel = { kind: 'candle', w, padL, iw, n: cs.length, items: cs.map((c, i) => ({ x: X(i), at: c.t, o: c.o, h: c.h, l: c.l, c: c.c })) };
    const fmtT = (t) => (tf < 864e5 ? timeFmt : dayFmt).format(new Date(t));
    return `<svg viewBox="0 0 ${w} ${h}" class="xchart" style="direction:ltr">
      ${[lo, (lo + hi) / 2, hi].map((v) => `<line x1="${padL}" x2="${w - 70}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(127,127,127,.18)" stroke-dasharray="3 4"/><text x="${w - 64}" y="${Y(v) + 4}" font-size="11" fill="#7a879c">${fmt(v, 4)}</text>`).join('')}
      ${cs.map((c, i) => { const up = c.c >= c.o, col = up ? '#2fd389' : '#ff6b7a', y1 = Y(Math.max(c.o, c.c)), y2 = Y(Math.min(c.o, c.c));
        return `<g class="candle" style="animation-delay:${Math.min(i * 18, 600)}ms"><line x1="${X(i)}" x2="${X(i)}" y1="${Y(c.h)}" y2="${Y(c.l)}" stroke="${col}" stroke-width="1.3"/><rect x="${X(i) - bw / 2}" y="${y1}" width="${bw}" height="${Math.max(1.5, y2 - y1)}" rx="1.5" fill="${col}" fill-opacity="${up ? 0.85 : 0.9}"/></g>`; }).join('')}
      ${[0, Math.floor(cs.length / 2), cs.length - 1].map((i) => `<text x="${X(i)}" y="${h - 4}" font-size="11" fill="#7a879c" text-anchor="middle">${fmtT(cs[i].t)}</text>`).join('')}
      <line class="xh" x1="0" x2="0" y1="${pad}" y2="${h - pad}" stroke="rgba(127,127,127,.5)" stroke-dasharray="3 3" style="display:none"/>
    </svg><div class="xtip" style="display:none"></div>`;
  }
  function lineChartX(points) {
    const html = lineChart(points);
    const pts = points.filter((p) => p.buy != null || p.sell != null);
    if (pts.length >= 2) {
      const t0 = pts[0].at, t1 = pts[pts.length - 1].at, w = 640, padL = 8, iw = w - padL - 70;
      let lb = null, ls = null;
      chartModel = { kind: 'line', w, padL, iw, items: pts.map((p) => { if (p.buy != null) lb = p.buy; if (p.sell != null) ls = p.sell; return { x: padL + ((p.at - t0) / (t1 - t0 || 1)) * iw, at: p.at, buy: lb, sell: ls }; }) };
      return html.replace('<svg ', '<svg class="xchart" ') + '<div class="xtip" style="display:none"></div>';
    }
    return html;
  }
  function attachCrosshair() {
    const svgEl = document.querySelector('.chart svg.xchart'); const tip = document.querySelector('.chart .xtip');
    if (!svgEl || !tip || !chartModel) return;
    const line = svgEl.querySelector('.xh') || (() => { const l = document.createElementNS('http://www.w3.org/2000/svg', 'line'); l.setAttribute('class', 'xh'); l.setAttribute('y1', '20'); l.setAttribute('y2', '200'); l.setAttribute('stroke', 'rgba(127,127,127,.5)'); l.setAttribute('stroke-dasharray', '3 3'); svgEl.appendChild(l); return l; })();
    const move = (ev) => {
      const rect = svgEl.getBoundingClientRect(); const cx = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left) / rect.width * chartModel.w;
      let best = chartModel.items[0]; for (const it of chartModel.items) if (Math.abs(it.x - cx) < Math.abs(best.x - cx)) best = it;
      line.setAttribute('x1', best.x); line.setAttribute('x2', best.x); line.style.display = '';
      tip.style.display = ''; tip.style.left = `${(best.x / chartModel.w) * 100}%`;
      tip.innerHTML = `<div class="muted">${fmtDate(best.at)}</div>` + (chartModel.kind === 'candle'
        ? `<div class="num">باز ${fmt(best.o)} · بالا ${fmt(best.h)}</div><div class="num">پایین ${fmt(best.l)} · بسته ${fmt(best.c)}</div>`
        : `<div class="num" style="color:var(--buy)">خرید ${best.buy != null ? fmt(best.buy) : '—'}</div><div class="num" style="color:var(--sell)">فروش ${best.sell != null ? fmt(best.sell) : '—'}</div>`);
    };
    const leave = () => { line.style.display = 'none'; tip.style.display = 'none'; };
    svgEl.addEventListener('mousemove', move); svgEl.addEventListener('touchmove', move, { passive: true });
    svgEl.addEventListener('mouseleave', leave); svgEl.addEventListener('touchend', leave);
  }

  // Session stats and range bars for the selected rate.
  function rangeBar(label, lo, hi, cur) {
    if (lo == null || hi == null || cur == null) return '';
    const p = hi > lo ? ((cur - lo) / (hi - lo)) * 100 : 50;
    return `<div class="range"><div class="row small" style="justify-content:space-between"><span class="muted">${label}</span></div>
      <div class="range-track"><i style="left:calc(${p.toFixed(1)}% - 7px)"></i></div>
      <div class="row small num" style="justify-content:space-between"><span>${fmt(lo)}</span><span>${fmt(hi)}</span></div></div>`;
  }
  function statsStrip(st, r) {
    if (!st) return '';
    const side = r.sell != null ? 'sell' : 'buy', s = st[side], lbl = side === 'sell' ? 'فروش' : 'خرید';
    const ch = s.last != null && s.prevClose != null ? delta(s.last, s.prevClose) : null;
    const spread = r.buy != null && r.sell != null ? { a: r.sell - r.buy, p: ((r.sell - r.buy) / r.buy) * 100 } : null;
    const cell = (k, v, cls = '') => `<div class="stat"><span class="muted small">${k}</span><b class="num ${cls}">${v}</b></div>`;
    return `<div class="stats-strip">
      ${cell('باز (' + lbl + ')', s.open != null ? fmt(s.open) : '—')}
      ${cell('بالاترین امروز', s.high != null ? fmt(s.high) : '—', 'up')}
      ${cell('پایین‌ترین امروز', s.low != null ? fmt(s.low) : '—', 'down')}
      ${cell('بسته دیروز', s.prevClose != null ? fmt(s.prevClose) : '—')}
      ${cell('تغییر روزانه', ch ? `${ch.d > 0 ? '+' : ''}${fmt(ch.d)} (${ch.p.toFixed(2)}%)` : '—', ch ? (ch.d > 0 ? 'up' : ch.d < 0 ? 'down' : '') : '')}
      ${cell('اختلاف خرید و فروش', spread ? `${fmt(spread.a)} (${spread.p.toFixed(2)}%)` : '—')}
      ${cell('تعداد به‌روزرسانی امروز', st.updatesToday)}
    </div>
    <div class="grid g2" style="gap:16px;margin-top:14px">${rangeBar('دامنه امروز (' + lbl + ')', s.low, s.high, r[side])}${rangeBar('دامنه ۳۰ روز (' + lbl + ')', s.low30, s.high30, r[side])}</div>`;
  }
  function alertsBox(r) {
    if (!me()) return `<div class="card card-pad"><h3>هشدار قیمت</h3><p class="muted small" style="margin:0">برای تعریف هشدار قیمت <a href="#login">وارد شوید</a>.</p></div>`;
    const mine = (view.alerts || []).filter((a) => a.key === r.key);
    return `<div class="card card-pad"><h3>هشدار قیمت</h3>
      <form data-form="alert" data-key="${esc(r.key)}" class="stack">
        <div class="grid g2"><select class="input" name="side"><option value="sell">قیمت فروش</option><option value="buy">قیمت خرید</option></select>
        <select class="input" name="op"><option value="gte">بیشتر یا مساوی</option><option value="lte">کمتر یا مساوی</option></select></div>
        <div class="row"><input class="input num" name="value" inputmode="decimal" placeholder="${r.sell != null ? fmt(r.sell) : ''}" required style="flex:1"><button class="btn btn-primary btn-sm">ثبت هشدار</button></div>
      </form>
      ${mine.length ? `<div style="margin-top:10px">${mine.map((a) => `<div class="hist-row" style="grid-template-columns:1fr auto auto"><span class="small">${a.side === 'buy' ? 'خرید' : 'فروش'} ${a.op === 'gte' ? '≥' : '≤'} <b class="num">${fmt(a.value)}</b></span>${a.active ? '<span class="badge blue">فعال</span>' : `<span class="badge ok">اجرا شد ${a.firedAt ? ago(a.firedAt) : ''}</span>`}<button class="btn btn-ghost btn-sm" data-act="alert-del" data-id="${a.id}">حذف</button></div>`).join('')}</div>` : ''}
      <p class="muted small" style="margin:8px 0 0">هنگام رسیدن قیمت به شرط، اعلان دریافت می‌کنید.</p></div>`;
  }

  // Order-book depth for one asset from members' active offers.
  function depthPanel(assetId) {
    const os = view.orders.filter((o) => o.status === 'active' && o.assetId === assetId);
    if (!os.length) return '';
    const a = asset(assetId);
    const lvl = (side, dir) => { const m = new Map(); for (const o of os.filter((x) => x.side === side)) m.set(o.price, (m.get(o.price) || 0) + o.remaining); return [...m.entries()].sort((x, y) => dir * (x[0] - y[0])).slice(0, 8); };
    const bids = lvl('buy', -1), asks = lvl('sell', 1);
    let cb = 0, ca = 0; const cumB = bids.map(([p, q]) => [p, q, (cb += q)]), cumA = asks.map(([p, q]) => [p, q, (ca += q)]);
    const max = Math.max(cb, ca, 1);
    const spread = bids.length && asks.length ? asks[0][0] - bids[0][0] : null;
    const row = (cls, [p, q, c]) => `<div class="depth-row ${cls}"><i style="width:${((c / max) * 100).toFixed(1)}%"></i><span class="num">${fmt(p)}</span><span class="num">${fmt(q)}</span><span class="num muted">${fmt(c)}</span></div>`;
    return `<section class="card card-pad" style="margin-bottom:22px"><div class="row"><h2 style="margin:0">عمق بازار ${esc(a.name)}</h2><span class="spacer"></span>${spread != null ? `<span class="badge">اختلاف: <span class="num">${fmt(spread)}</span></span>` : ''}</div>
      <div class="grid g2" style="margin-top:12px;gap:16px">
        <div><div class="depth-head"><span>خرید (تقاضا)</span><span>مقدار</span><span>تجمعی</span></div>${cumB.map((x) => row('bid', x)).join('') || '<p class="muted small">پیشنهاد خریدی نیست.</p>'}</div>
        <div><div class="depth-head"><span>فروش (عرضه)</span><span>مقدار</span><span>تجمعی</span></div>${cumA.map((x) => row('ask', x)).join('') || '<p class="muted small">پیشنهاد فروشی نیست.</p>'}</div>
      </div></section>`;
  }

  /* ---------- static pages ---------- */
  function pageAbout() {
    return `${pageHead('درباره سامانه', '')}<div class="card card-pad stack">
      <p>سامانه معاملات سرای شهزاده کابل بستر رسمی ثبت پیشنهادهای خرید و فروش ارز، طلا و نقره میان صرافان، زرگران و تاجران تأییدشده است.</p>
      <dl class="kv"><dt>نرخ رسمی</dt><dd>توسط مدیریت سرای شهزاده تعیین و منتشر می‌شود.</dd>
        <dt>پیشنهادهای اعضا</dt><dd>هر عضو تأییدشده نرخ پیشنهادی خود را ثبت می‌کند.</dd>
        <dt>عضویت</dt><dd>پس از بررسی مشخصات و تأیید مدیریت فعال می‌شود.</dd>
        <dt>تسویه</dt><dd>پرداخت و تحویل خارج از سامانه و مستقیماً میان طرفین انجام می‌شود.</dd></dl></div>`;
  }
  function pageRules() {
    const rules = ['عضویت فقط با مشخصات واقعی و قابل تأیید مجاز است.', 'ثبت سفارش غیرواقعی یا با هدف اثرگذاری بر نرخ بازار ممنوع است و موجب مسدودی حساب می‌شود.',
      'صاحب سفارش موظف است به درخواست‌ها پاسخ دهد و پس از تأیید، معامله را مطابق شرایط ثبت‌شده انجام دهد.', 'طرفین معامله پس از تحویل و تسویه، تکمیل معامله را در سامانه تأیید می‌کنند.',
      'مسئولیت پرداخت، تحویل و بررسی هویت طرف مقابل بر عهده طرفین معامله است.', 'گزارش تخلف از طریق صفحه معامله یا پروفایل عضو ثبت و توسط مدیریت بررسی می‌شود.',
      'همه عملیات در سامانه ثبت و نگهداری می‌شود و قابل حذف یا تغییر نیست.'];
    return `${pageHead('قوانین و مقررات', '')}<div class="card card-pad"><ol class="rules">${rules.map((r) => `<li>${r}</li>`).join('')}</ol></div>`;
  }

  /* ---------- auth ---------- */
  function pageLogin() {
    if (me()) return gate(`با حساب «${esc(me().company)}» وارد شده‌اید.`, '<a class="btn btn-primary" href="#dashboard">داشبورد</a>');
    return `<div class="auth-wrap"><form class="card card-pad stack aura" data-form="login">
      <h1 style="margin:0;font-size:22px">ورود</h1>
      <label class="field"><span>شماره تماس</span><input class="input num" name="phone" inputmode="tel" placeholder="07xxxxxxxx" required autocomplete="username"></label>
      <label class="field"><span>رمز عبور</span><input class="input" type="password" name="password" required autocomplete="current-password"></label>
      <div class="form-error hidden"></div>
      <button class="btn btn-primary btn-lg">ورود</button>
      <p class="small muted" style="margin:0;text-align:center">حساب ندارید؟ <a href="#register">درخواست عضویت</a></p>
      ${backend.mode === 'local' ? '<div class="notice small">حساب‌های آزمایشی: <span class="num">0700000001</span> تا <span class="num">0700000005</span> — رمز <span class="num">123456</span></div>' : ''}
    </form></div>`;
  }
  function pageRegister() {
    if (me()) return gate('وارد حساب خود شده‌اید.', '<a class="btn btn-primary" href="#dashboard">داشبورد</a>');
    return `<div class="auth-wrap" style="max-width:600px"><form class="card card-pad stack aura" data-form="register">
      <h1 style="margin:0;font-size:22px">درخواست عضویت</h1>
      <p class="muted" style="margin:0">حساب پس از بررسی مشخصات توسط مدیریت فعال می‌شود.</p>
      <div class="grid g2">
        <label class="field"><span>نام و تخلص</span><input class="input" name="name" required></label>
        <label class="field"><span>نام صرافی / شرکت</span><input class="input" name="company" required></label>
        <label class="field"><span>شماره تماس</span><input class="input num" name="phone" inputmode="tel" placeholder="07xxxxxxxx" required></label>
        <label class="field"><span>شماره واتس‌اپ</span><input class="input num" name="whatsapp" inputmode="tel" placeholder="در صورت تفاوت"></label>
      </div>
      <label class="field"><span>نوع فعالیت</span><select class="input" name="activity" required><option value="">انتخاب کنید</option>${Object.entries(E.ACTIVITIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      ${kycInputs()}
      <label class="field"><span>رمز عبور (حداقل ۸ حرف)</span><input class="input" type="password" name="password" minlength="8" required autocomplete="new-password"></label>
      <label class="row small"><input type="checkbox" class="switch" name="agree" required> <span><a href="#rules" target="_blank">قوانین و مقررات</a> را می‌پذیرم.</span></label>
      <div class="form-error hidden"></div>
      <button class="btn btn-primary btn-lg">ارسال درخواست</button>
      <p class="small muted" style="margin:0;text-align:center">عضو هستید؟ <a href="#login">ورود</a></p>
    </form></div>`;
  }

  /* =========================================================
     Admin panel
     ========================================================= */
  const adminBack = () => '<a class="btn btn-sm" href="#admin" style="margin-bottom:16px">→ صفحه اصلی پنل</a>';
  function pageAdminLogin() {
    const L = ui.adminLogin, m = me();
    return `<div class="auth-wrap"><form class="card card-pad stack glow aura" data-form="admin-login">
      <div style="display:flex;justify-content:center"><span class="asset-ico" style="width:64px;height:64px">${ICON.shield}</span></div>
      <h1 style="margin:0;font-size:21px;text-align:center">ورود مدیر</h1>
      ${m && !isAdmin() ? '<div class="notice warn small">این حساب دسترسی مدیریت ندارد.</div>' : ''}
      ${L.need2fa ? `<p class="muted small" style="margin:0;text-align:center">کد ۶ رقمی برنامه Google Authenticator را وارد کنید.</p>
        <label class="field"><span>کد تأیید</span><input class="input num" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required style="text-align:center;font-size:22px;letter-spacing:6px"></label>`
      : `<label class="field"><span>شماره تماس</span><input class="input num" name="phone" inputmode="tel" required autocomplete="username"></label>
        <label class="field"><span>رمز عبور</span><input class="input" type="password" name="password" required autocomplete="current-password"></label>`}
      <div class="form-error hidden"></div>
      <button class="btn btn-primary btn-lg">${L.need2fa ? 'تأیید' : 'ورود'}</button>
      ${L.need2fa ? '<button type="button" class="btn btn-ghost btn-sm" data-act="admin-login-reset">بازگشت</button>' : ''}
    </form></div>`;
  }

  const MODULES = [
    ['members', 'اعضا و ثبت‌نام‌ها', 'بررسی و تأیید درخواست‌های عضویت، جستجوی اعضا، مسدودسازی', ICON.users],
    ['rates', 'نرخ ارزها و منابع', 'دریافت خودکار از تلگرام، صف بررسی، اصلاح دستی و تاریخچه نرخ‌ها', ICON.rate],
    ['orders', 'سفارش‌ها', 'مشاهده و بستن سفارش‌های ثبت‌شده در بازار', ICON.list],
    ['deals', 'معاملات', 'پیگیری معاملات میان اعضا و لغو در صورت تخلف', ICON.deal],
    ['reports', 'گزارش‌های تخلف', 'بررسی شکایت‌های ثبت‌شده توسط اعضا', ICON.flag],
    ['notify', 'اطلاعیه رسمی', 'ارسال اطلاعیه به همه اعضای تأییدشده', ICON.megaphone],
    ['assets', 'ارزها و دارایی‌ها', 'افزودن، ویرایش، حذف و ترتیب نمایش ارزها', ICON.coins],
    ['stats', 'آمار', 'آمار عضویت، سفارش و معامله به تفکیک دوره', ICON.chart],
    ['security', 'امنیت حساب مدیر', 'تأیید دومرحله‌ای و تغییر رمز عبور', ICON.lock],
    ['audit', 'سابقه عملیات', 'ثبت غیرقابل‌تغییر همه عملیات سامانه', ICON.history],
  ];
  function moduleHead(key, extra = '') {
    const m = MODULES.find((x) => x[0] === key);
    return `${adminBack()}${pageHead(m[1], m[2], extra)}`;
  }

  function pageAdmin(tab) {
    const A = view.admin;
    if (tab === 'home') {
      const lastRate = liveRates().reduce((x, r) => Math.max(x, r.updatedAt || 0), 0);
      const tasks = [];
      if (A.counts.pending) tasks.push(`<a class="todo" href="#admin-members" style="color:inherit"><span class="todo-dot"></span><div style="flex:1"><b class="num">${A.counts.pending}</b> درخواست عضویت در انتظار بررسی</div><span class="btn btn-primary btn-sm">بررسی</span></a>`);
      if (A.reviewCount) tasks.push(`<a class="todo" href="#admin-rates-review" style="color:inherit"><span class="todo-dot"></span><div style="flex:1"><b class="num">${A.reviewCount}</b> پیام نرخ از تلگرام نیاز به بررسی دارد</div><span class="btn btn-primary btn-sm">بررسی</span></a>`);
      for (const src of A.sources.filter((x) => x.enabled && x.lastError)) tasks.push(`<a class="todo" href="#admin-rates-sources" style="color:inherit"><span class="todo-dot"></span><div style="flex:1">خطا در دریافت از کانال ${esc(src.channel)}: ${esc(src.lastError)}</div><span class="btn btn-sm">مشاهده</span></a>`);
      if (A.openReports) tasks.push(`<a class="todo" href="#admin-reports" style="color:inherit"><span class="todo-dot"></span><div style="flex:1"><b class="num">${A.openReports}</b> گزارش تخلف باز</div><span class="btn btn-sm">بررسی</span></a>`);
      if (!lastRate || Date.now() - lastRate > 12 * 3600e3) tasks.push(`<a class="todo" href="#admin-rates" style="color:inherit"><span class="todo-dot"></span><div style="flex:1">نرخ در ۱۲ ساعت گذشته به‌روزرسانی نشده است.</div><span class="btn btn-sm">ثبت نرخ</span></a>`);
      if (!me().totpEnabled) tasks.push(`<a class="todo" href="#admin-security" style="color:inherit"><span class="todo-dot"></span><div style="flex:1">تأیید دومرحله‌ای حساب مدیر فعال نیست.</div><span class="btn btn-sell btn-sm">فعال‌سازی</span></a>`);
      const badge = { members: A.counts.pending, reports: A.openReports, rates: A.reviewCount };
      return `${pageHead('پنل مدیریت', `${longDate.format(new Date())} · ${esc(me().name)}`)}
        <div class="grid g4" style="margin-bottom:22px">
          <div class="card tile sheen"><span>اعضای تأییدشده</span><b class="num" data-count="${A.counts.approved}">${A.counts.approved}</b></div>
          <div class="card tile sheen"><span>در انتظار بررسی</span><b class="num" style="color:var(--warn)" data-count="${A.counts.pending}">${A.counts.pending}</b></div>
          <div class="card tile sheen"><span>سفارش فعال</span><b class="num" data-count="${view.stats.activeOrders}">${view.stats.activeOrders}</b></div>
          <div class="card tile sheen"><span>معامله در حال اجرا</span><b class="num" style="color:var(--blue-2)" data-count="${view.stats.activeDeals}">${view.stats.activeDeals}</b></div>
        </div>
        <div class="card card-pad ${tasks.length ? 'glow g-warm aura warm' : ''}" style="margin-bottom:24px"><h2>کارهای امروز</h2>${tasks.length ? tasks.join('') : '<p class="muted" style="margin:0">مورد معوقی وجود ندارد.</p>'}</div>
        <div class="modules">${MODULES.map(([k, t, d, ic]) => `<a class="card module sheen" href="#admin-${k}"><span class="module-ico">${ic}</span><span class="module-txt"><b>${t}</b><small>${d}</small></span>${badge[k] ? `<span class="count-badge">${badge[k]}</span>` : ''}</a>`).join('')}</div>`;
    }
    if (tab === 'members') return adminMembers();
    if (tab === 'rates') return adminRates('list');
    if (tab === 'orders') {
      const os = view.orders.slice().sort((a, b) => b.createdAt - a.createdAt);
      return `${moduleHead('orders')}<div class="card">${ordersTable(os, { empty: 'سفارشی وجود ندارد.' })}</div><p class="muted small">آخرین ${os.length} سفارش نمایش داده شده است.</p>`;
    }
    if (tab === 'deals') {
      const ds = view.deals.slice().sort((a, b) => b.updatedAt - a.updatedAt);
      return `${moduleHead('deals')}<div class="card">${ds.length ? dealsTable(ds) : emptyBox('معامله‌ای وجود ندارد.')}</div>`;
    }
    if (tab === 'reports') {
      return `${moduleHead('reports')}<div class="card card-pad">${A.reports.length ? A.reports.map((r) => `<div class="req ${r.status === 'open' ? 'pending' : 'completed'}">
        <div class="row"><b>علیه: ${nameLink(r.userId)}</b>${r.status === 'open' ? '<span class="badge warn">باز</span>' : '<span class="badge ok">رسیدگی شده</span>'}<span class="spacer"></span><span class="muted small">${fmtDate(r.createdAt)}</span></div>
        <div class="small muted">گزارش‌دهنده: ${nameLink(r.reporterId)} ${r.dealId ? `· <a href="#deal-${r.dealId}">معامله #${r.dealId}</a>` : ''}</div>
        <p style="margin:6px 0">${esc(r.reason)}</p>${r.note ? `<div class="small muted">یادداشت مدیریت: ${esc(r.note)}</div>` : ''}
        ${r.status === 'open' ? `<div class="row"><button class="btn btn-sm" data-act="resolve-report" data-id="${r.id}">ثبت رسیدگی</button><a class="btn btn-sm" href="#admin-review-${r.userId}">پرونده عضو</a></div>` : ''}</div>`).join('') : emptyBox('گزارشی ثبت نشده است.')}</div>`;
    }
    if (tab === 'notify') {
      return `${moduleHead('notify')}<form class="card card-pad stack" data-form="broadcast" style="max-width:680px">
        <label class="field"><span>متن اطلاعیه</span><textarea class="input" name="text" maxlength="300" required></textarea></label>
        <p class="muted small" style="margin:0">اطلاعیه برای ${N(A.counts.approved)} عضو تأییدشده ارسال می‌شود و قابل بازگشت نیست.</p>
        <button class="btn btn-primary">ارسال اطلاعیه</button></form>`;
    }
    if (tab === 'assets') {
      return `${moduleHead('assets')}<div class="split"><div class="card"><div class="table-wrap"><table class="data responsive"><thead><tr><th>ارز / دارایی</th><th>نام‌های شناسایی در پیام</th><th>ترتیب</th><th>وضعیت</th><th></th></tr></thead><tbody>
        ${view.assets.map((a) => `<tr class="${a.deleted ? 'dim' : ''}"><td class="cell-main">${assetChip(a, `${esc(a.unit)} · ${esc(a.priceCurrency)}`)}</td><td data-l="نام‌های شناسایی" class="small">${esc((a.aliases || []).join('، '))}</td><td data-l="ترتیب" class="num">${a.sortOrder || '—'}${a.popular ? ' <span class="badge blue">پرمعامله</span>' : ''}</td>
          <td data-l="وضعیت">${a.deleted ? '<span class="badge bad">حذف‌شده</span>' : a.active ? '<span class="badge ok">نمایش</span>' : '<span class="badge">مخفی</span>'}</td>
          <td class="cell-act">${a.deleted ? '' : `<div class="row"><button class="btn btn-sm" data-act="asset-edit" data-id="${a.id}">ویرایش</button><button class="btn btn-sm" data-act="asset-toggle" data-id="${a.id}">${a.active ? 'مخفی' : 'نمایش'}</button><button class="btn btn-sm" data-act="asset-delete" data-id="${a.id}">حذف</button></div>`}</td></tr>`).join('')}</tbody></table></div></div>
        <form class="card card-pad stack" data-form="asset"><h3>افزودن ارز</h3><input type="hidden" name="id">
          <div class="grid g2"><label class="field"><span>نماد (لاتین)</span><input class="input ltr" name="code" required></label><label class="field"><span>نام</span><input class="input" name="name" required></label>
          <label class="field"><span>واحد مقدار</span><input class="input" name="unit" required></label><label class="field"><span>واحد قیمت</span><input class="input" name="priceCurrency" value="AFN" required></label></div>
          <label class="field"><span>نام‌های شناسایی در پیام تلگرام (با کاما جدا کنید)</span><input class="input" name="aliases" placeholder="مثال: ریال سعودی، ریال عربستان"></label>
          <div class="grid g2"><label class="field"><span>ترتیب نمایش</span><input class="input num" name="sortOrder" inputmode="numeric" value="50"></label>
          <label class="field"><span>نوع</span><select class="input" name="kind"><option value="currency">ارز</option><option value="metal">فلز / کالا</option></select></label></div>
          <label class="row small"><input type="checkbox" class="switch" name="popular"> نمایش در ابتدای جدول (پرمعامله)</label>
          <button class="btn btn-primary">ذخیره</button></form></div>`;
    }
    if (tab === 'stats') {
      const vol = {};
      for (const d of view.deals.filter((x) => ['accepted', 'completed'].includes(x.status))) {
        const o = orderOf(d.orderId); if (!o) continue;
        const k = o.assetId; vol[k] = vol[k] || { a: asset(k), unit: o.unit, amt: 0, value: 0, cur: o.priceCurrency, n: 0 };
        vol[k].amt += d.acceptedAmount; vol[k].value += d.acceptedAmount * d.price; vol[k].n++;
      }
      return `${moduleHead('stats')}<div class="grid g2">
        <div class="card"><div class="card-pad" style="padding-bottom:0"><h2>آمار دوره‌ای</h2></div><div class="table-wrap"><table class="data responsive"><thead><tr><th>دوره</th><th>عضویت</th><th>سفارش</th><th>درخواست</th><th>تکمیل</th></tr></thead><tbody>
          ${A.period.map((p) => `<tr><td class="cell-main"><b>${p.label}</b></td><td data-l="عضویت" class="num">${p.users}</td><td data-l="سفارش" class="num">${p.orders}</td><td data-l="درخواست" class="num">${p.deals}</td><td data-l="تکمیل" class="num">${p.completed}</td></tr>`).join('')}</tbody></table></div></div>
        <div class="card"><div class="card-pad" style="padding-bottom:0"><h2>حجم معاملات تأییدشده</h2><p class="muted small">بر اساس آخرین معاملات</p></div>${Object.values(vol).length ? `<div class="table-wrap"><table class="data responsive"><thead><tr><th>دارایی</th><th>تعداد</th><th>مقدار</th><th>ارزش</th></tr></thead><tbody>${Object.values(vol).map((v) => `<tr><td class="cell-main">${assetChip(v.a)}</td><td data-l="تعداد" class="num">${v.n}</td><td data-l="مقدار"><span class="num">${fmt(v.amt)}</span> ${esc(v.unit)}</td><td data-l="ارزش"><span class="num">${fmt(v.value, 0)}</span> ${esc(v.cur)}</td></tr>`).join('')}</tbody></table></div>` : emptyBox('معامله‌ای وجود ندارد.')}</div></div>`;
    }
    if (tab === 'security') {
      const m = me(), T = ui.totp;
      return `${moduleHead('security')}<div class="split"><div class="stack">
        <div class="card card-pad stack"><h2>تأیید دومرحله‌ای</h2>
          ${backend.mode === 'local' ? '<div class="notice warn">در نسخه آزمایشی فعال نیست.</div>' : m.totpEnabled
            ? `<div class="notice">فعال است. ورود به پنل نیازمند کد برنامه Google Authenticator است.</div>
               <form class="stack" data-form="totp-disable"><div class="grid g2"><input class="input" type="password" name="password" placeholder="رمز عبور" required><input class="input num" name="code" placeholder="کد فعلی" inputmode="numeric" required></div><button class="btn btn-sell btn-sm">غیرفعال‌سازی</button></form>`
            : T ? `<ol class="rules"><li>برنامه <b>Google Authenticator</b> را روی گوشی نصب کنید.</li><li>روی دکمه زیر بزنید یا کلید را در برنامه وارد کنید.</li><li>کد ۶ رقمی نمایش‌داده‌شده را همراه رمز عبور وارد کنید.</li></ol>
                 <a class="btn btn-primary" href="${esc(T.uri)}">افزودن به Google Authenticator</a>
                 <div class="secret num">${esc(T.secret.replace(/(.{4})/g, '$1 ').trim())}</div>
                 <form class="stack" data-form="totp-enable"><div class="grid g2"><input class="input num" name="code" placeholder="کد ۶ رقمی" inputmode="numeric" maxlength="6" required><input class="input" type="password" name="password" placeholder="رمز عبور" required></div><button class="btn btn-buy">فعال‌سازی</button></form>`
            : `<div class="notice warn">فعال نیست. برای جلوگیری از دسترسی غیرمجاز، فعال‌سازی ضروری است.</div><button class="btn btn-primary" data-act="totp-setup">شروع فعال‌سازی</button>`}
        </div></div>
        <form class="card card-pad stack" data-form="password"><h2>تغییر رمز عبور</h2>
          <input class="input" type="password" name="current" placeholder="رمز فعلی" required autocomplete="current-password">
          <input class="input" type="password" name="next" placeholder="رمز جدید (حداقل ۱۰ حرف، شامل حرف و عدد)" required autocomplete="new-password">
          <p class="muted small" style="margin:0">پس از تغییر، نشست‌های دیگر این حساب بسته می‌شود.</p>
          <button class="btn">تغییر رمز</button></form></div>`;
    }
    if (tab === 'audit') {
      return `${moduleHead('audit')}<div class="notice ${A.auditIntact ? '' : 'warn'}" style="margin-bottom:14px">${A.auditIntact ? 'زنجیره سابقه عملیات سالم است؛ هیچ رکوردی تغییر نکرده یا حذف نشده است.' : 'هشدار: ناسازگاری در زنجیره سابقه عملیات.'}</div>
        <div class="card"><div class="table-wrap"><table class="data responsive"><thead><tr><th>زمان</th><th>کاربر</th><th>عملیات</th><th>جزئیات</th></tr></thead><tbody>
        ${A.audit.map((e) => `<tr><td data-l="زمان" class="small">${fmtDate(e.at)}</td><td data-l="کاربر">${e.actorId ? esc((user(e.actorId) || {}).company || '#' + e.actorId) : '<span class="muted">سیستم</span>'}</td><td class="cell-main ltr small">${esc(e.type)} <span class="muted">${esc(e.ref || '')}</span></td><td data-l="جزئیات" class="small">${esc(e.detail)}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    }
    return pageAdmin('home');
  }

  function adminMembers() {
    const M = ui.members, A = view.admin;
    const list = M.status === 'pending' && !M.q ? A.pending : M.list;
    if (list === null && !M.loading) loadMembers();
    const rows = list || [];
    return `${moduleHead('members')}
      <div class="card"><div class="row" style="padding:16px 18px;gap:12px">
        <div class="seg" style="overflow-x:auto;max-width:100%">${[['pending', `در انتظار (${A.counts.pending})`], ['approved', 'تأییدشده'], ['rejected', 'ردشده'], ['blocked', 'مسدود'], ['', 'همه']].map(([k, l]) => `<button class="${M.status === k ? 'on' : ''}" data-act="member-filter" data-v="${k}">${l}</button>`).join('')}</div>
        <form data-form="member-search" style="flex:1;min-width:240px"><label class="search-pill violet"><button class="glass-orb" aria-label="جستجو">${SEARCH}</button><input name="q" value="${esc(M.q)}" placeholder="نام، صرافی، ولایت یا شماره"></label></form>
      </div>
      ${M.loading && !list ? '<div class="empty">در حال دریافت…</div>' : rows.length ? `<div class="table-wrap"><table class="data responsive"><thead><tr><th>عضو</th><th>تماس</th><th>ولایت</th><th>فعالیت</th><th>وضعیت</th><th>ثبت‌نام</th><th></th></tr></thead><tbody>
        ${rows.map((u) => `<tr class="clickable" data-href="#admin-review-${u.id}"><td class="cell-main"><b>${esc(u.company)}</b> ${u.role === 'admin' ? '<span class="badge blue">مدیر</span>' : ''}<div class="muted small">${esc(u.name)}</div></td>
          <td data-l="تماس" class="num small">${esc(u.phone || '')}</td><td data-l="ولایت">${esc(u.province || '—')}</td><td data-l="فعالیت">${E.ACTIVITIES[u.activity] || ''}</td>
          <td data-l="وضعیت">${userBadge(u.status)}</td><td data-l="ثبت‌نام" class="small">${ago(u.createdAt)}</td>
          <td class="cell-act"><a class="btn ${u.status === 'pending' ? 'btn-primary' : ''} btn-sm" href="#admin-review-${u.id}">${u.status === 'pending' ? 'بررسی' : 'پرونده'}</a></td></tr>`).join('')}</tbody></table></div>
        ${M.list && M.total > M.offset + M.list.length ? `<div style="padding:0 18px 18px"><button class="btn btn-block" data-act="member-more">نمایش بیشتر (${M.total - M.offset - M.list.length})</button></div>` : ''}` : emptyBox('موردی یافت نشد.')}
      </div>`;
  }
  async function loadMembers(more) {
    const M = ui.members; M.loading = true;
    try {
      const offset = more ? M.offset + (M.list || []).length : 0;
      const r = await backend.adminUsers({ status: M.status, q: M.q, offset });
      M.list = more ? [...(M.list || []), ...r.users] : r.users; M.total = r.total; if (!more) M.offset = 0;
    } catch (e) { toast(e.message, true); M.list = []; }
    M.loading = false; render();
  }

  function pageReview(id) {
    let u = user(id);
    if (!u || !('address' in u)) {
      if (!ui.reviewLoading) { ui.reviewLoading = true; backend.adminUsers({ id }).then((r) => { ui.members.list = [...(ui.members.list || []).filter((x) => x.id !== id), ...r.users]; ui.reviewLoading = false; render(); }).catch((e) => { ui.reviewLoading = false; toast(e.message, true); }); }
      return '<div class="empty">در حال دریافت پرونده…</div>';
    }
    const isSelf = u.id === me().id;
    const row = (k, v) => `<dt>${k}</dt><dd>${v || '<span class="muted">—</span>'}</dd>`;
    return `<a class="btn btn-sm" href="#admin-members" style="margin-bottom:16px">→ اعضا و ثبت‌نام‌ها</a>
    ${pageHead(esc(u.company), `${userBadge(u.status)} · درخواست ${fmtDate(u.createdAt)}${u.resubmittedAt ? ` · ارسال مجدد ${ago(u.resubmittedAt)}` : ''}`)}
    <div class="split">
      <div class="stack">
        <div class="card card-pad"><h3>هویت و تماس</h3><dl class="kv">
          ${row('نام و تخلص', esc(u.name))}${row('نام صرافی / شرکت', esc(u.company))}${row('نوع فعالیت', E.ACTIVITIES[u.activity])}
          ${row('شماره تماس', `<span class="num">${esc(u.phone)}</span>`)}${row('واتس‌اپ', u.whatsapp ? `<a class="badge ok" href="${waHref(u.whatsapp)}" target="_blank" rel="noopener">${ICON.wa} <span class="num">${esc(u.whatsapp)}</span></a>` : '')}
        </dl></div>
        <div class="card card-pad"><h3>محل و سابقه</h3><dl class="kv">
          ${row('ولایت', esc(u.province))}${row('شهر / ولسوالی', esc(u.city))}${row('آدرس دفتر', esc(u.address))}${row('شماره جواز', esc(u.licenseNo))}${row('سابقه کار', esc(u.experience))}
          ${row('ضامن / معرف', esc(u.guarantorName))}${row('تماس ضامن', u.guarantorPhone ? `<span class="num">${esc(u.guarantorPhone)}</span>` : '')}
        </dl>${u.about ? `<p class="small" style="margin:14px 0 0">توضیحات: ${esc(u.about)}</p>` : ''}</div>
        ${u.statusReason ? `<div class="notice warn">آخرین دلیل ثبت‌شده: ${esc(u.statusReason)}</div>` : ''}
      </div>
      <aside class="stack">
        <div class="card card-pad glow aura ${u.status === 'pending' ? 'g-warm warm' : ''}"><h3>تصمیم مدیریت</h3>
          ${isSelf ? '<p class="muted small">حساب خود شما.</p>' : `<div class="stack">
            ${u.status !== 'approved' ? `<button class="btn btn-buy btn-block btn-lg" data-act="user-status" data-id="${u.id}" data-v="approved">تأیید عضویت</button>` : ''}
            ${u.status === 'pending' ? `<button class="btn btn-sell btn-block" data-act="reject-user" data-id="${u.id}">رد درخواست</button>` : ''}
            ${u.status !== 'blocked' ? `<button class="btn btn-block" data-act="block-user" data-id="${u.id}">مسدودسازی</button>` : ''}
            ${u.status === 'approved' ? `<button class="btn btn-block btn-sm" data-act="user-role" data-id="${u.id}" data-v="${u.role === 'admin' ? 'member' : 'admin'}">${u.role === 'admin' ? 'لغو دسترسی مدیریت' : 'اعطای دسترسی مدیریت'}</button>` : ''}
          </div><p class="muted small" style="margin:12px 0 0">نتیجه تصمیم بلافاصله به عضو اعلام می‌شود.</p>`}
        </div>
      </aside>
    </div>`;
  }

  /* =========================================================
     Events
     ========================================================= */
  function afterRender(r) {
    if (r === 'market') renderMarketTable();
    if (r === 'new') updateOrderAside();
  }
  const formData = (form) => Object.fromEntries(new FormData(form).entries());
  async function logout() {
    await backend.logout().catch(() => {});
    ui.adminLogin = { need2fa: false }; ui.members.list = null; ui.totp = null;
    await refresh(); location.hash = ADMIN_MODE ? '#admin' : '#home'; render(); toast('از حساب خارج شدید.');
  }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) {
      const row = e.target.closest('tr[data-href]');
      if (row && row.dataset.href && !e.target.closest('a,button,input,select,form')) location.hash = row.dataset.href;
      if (ui.notifOpen && !e.target.closest('.drawer')) { ui.notifOpen = false; render(); }
      return;
    }
    const { act: a, id } = t.dataset;
    const nid = Number(id);
    try {
      switch (a) {
        case 'close-modal': closeModal(); pendingSensitive = null; break;
        case 'toggle-notifs': ui.notifOpen = !ui.notifOpen; render(); break;
        case 'read-all': await act('notifications.read', {}); break;
        case 'open-notif':
          ui.notifOpen = false; await backend.action('notifications.read', { id: nid }).catch(() => {}); await refresh();
          if (t.dataset.link && (ADMIN_MODE === t.dataset.link.startsWith('#admin') || /^#(order|deal)-/.test(t.dataset.link))) location.hash = t.dataset.link;
          render(); break;
        case 'theme': {
          const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
          document.documentElement.dataset.theme = next; store.set('sarai-theme', next); render(); break;
        }
        case 'logout': await logout(); break;
        case 'demo-reset': LocalBackend.reset(); await refresh(); location.hash = '#home'; render(); toast('داده‌های آزمایشی بازنشانی شد.'); break;
        case 'enable-push': {
          const r = await Notification.requestPermission().catch(() => 'denied');
          toast(r === 'granted' ? 'اعلان روی گوشی فعال شد.' : 'اجازه اعلان داده نشد.', r !== 'granted'); render(); break;
        }
        case 'request': openRequest(nid); break;
        case 'fill-amt': { const f = t.closest('form'); f.amount.value = t.dataset.v; f.amount.dispatchEvent(new Event('input', { bubbles: true })); break; }
        case 'side': ui.side = t.dataset.v; document.querySelectorAll('.side-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.v === ui.side)); break;
        case 'filter-asset': ui.filters = { ...ui.filters, asset: String(nid) }; location.hash = '#market'; render(); break;
        case 'clear-filters': ui.filters = { asset: '', side: '', min: '', max: '', minAmount: '', q: '', sort: ui.filters.sort }; render(); break;
        case 'rate-open': {
          ui.ratesView.key = t.dataset.key;
          if (route() !== 'rates') { const r = view.rates.find((x) => x.key === t.dataset.key); if (r) ui.ratesView.market = r.market; location.hash = '#rates'; }
          else { render(); const h = document.getElementById('rate-history'); if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          break;
        }
        case 'deal-filter': ui.dealFilter = t.dataset.v; render(); break;
        case 'accept': {
          const inp = document.querySelector(`[data-accept-amt="${nid}"]`);
          await act('deal.accept', { dealId: nid, amount: inp ? inp.value : undefined }, 'درخواست تأیید شد.'); break;
        }
        case 'reject':
          modal('رد درخواست', `<form data-form="reject" data-id="${nid}" class="stack"><label class="field"><span>دلیل (اختیاری)</span><input class="input" name="reason"></label><button class="btn btn-sell btn-block">رد درخواست</button></form>`); break;
        case 'withdraw': await act('deal.withdraw', { dealId: nid }, 'درخواست لغو شد.'); break;
        case 'complete':
          modal('تأیید تکمیل معامله', `<form data-form="complete" data-id="${nid}" class="stack"><p style="margin:0">تأیید می‌کنم که تحویل و تسویه این معامله انجام شده است.</p><button class="btn btn-buy btn-block">تأیید تکمیل</button></form>`); break;
        case 'cancel-deal':
          modal('لغو معامله', `<form data-form="cancel-deal" data-id="${nid}" class="stack"><p class="muted" style="margin:0">مقدار تأییدشده به سفارش بازگردانده می‌شود.</p><label class="field"><span>دلیل لغو</span><input class="input" name="reason" required></label><button class="btn btn-sell btn-block">لغو معامله</button></form>`); break;
        case 'close-order':
          modal('بستن سفارش', `<form data-form="close-order" data-id="${nid}" class="stack"><p style="margin:0">سفارش #${nid} بسته می‌شود و درخواست‌های در انتظار آن رد خواهند شد. معاملات در حال اجرا ادامه می‌یابند.</p><button class="btn btn-sell btn-block">بستن سفارش</button></form>`); break;
        case 'report':
          modal('ثبت گزارش تخلف', `<form data-form="report" data-uid="${t.dataset.uid}" data-deal="${t.dataset.deal || ''}" class="stack"><label class="field"><span>شرح</span><textarea class="input" name="reason" required></textarea></label><button class="btn btn-sell btn-block">ارسال به مدیریت</button></form>`); break;
        /* admin */
        case 'admin-login-reset': ui.adminLogin = { need2fa: false }; render(); break;
        case 'member-filter': ui.members = { ...ui.members, status: t.dataset.v, list: null, offset: 0 }; render(); break;
        case 'member-more': loadMembers(true); break;
        case 'user-status': await act('admin.user.setStatus', { userId: nid, status: t.dataset.v }, t.dataset.v === 'approved' ? 'عضویت تأیید و به عضو اعلام شد.' : 'وضعیت به‌روز شد.'); ui.members.list = null; break;
        case 'reject-user':
          modal('رد درخواست عضویت', `<form data-form="reject-user" data-id="${nid}" class="stack"><label class="field"><span>دلیل رد (به متقاضی اعلام می‌شود)</span><textarea class="input" name="reason" required></textarea></label><button class="btn btn-sell btn-block">رد درخواست</button></form>`); break;
        case 'block-user':
          modal('مسدودسازی حساب', `<form data-form="block-user" data-id="${nid}" class="stack"><label class="field"><span>دلیل</span><input class="input" name="reason" required></label><button class="btn btn-sell btn-block">مسدودسازی</button></form>`); break;
        case 'user-role': sensitive('admin.user.setRole', { userId: nid, role: t.dataset.v }, 'نقش کاربر تغییر کرد.', t.dataset.v === 'admin' ? 'اعطای دسترسی کامل مدیریت به این عضو.' : 'لغو دسترسی مدیریت این عضو.'); break;
        case 'rate-new': case 'rate-edit': {
          const r = t.dataset.key ? view.rates.find((x) => x.key === t.dataset.key) : null;
          modal(r ? 'اصلاح نرخ' : 'ثبت نرخ دستی', `<form data-form="rate" class="stack">
            ${r ? `<div class="notice small">نرخ فعلی: خرید <b class="num">${r.buy != null ? fmt(r.buy) : '—'}</b> · فروش <b class="num">${r.sell != null ? fmt(r.sell) : '—'}</b> · ${KIND_LABEL[r.kind] || ''}</div>` : ''}
            ${rateFields(r || {})}
            <p class="muted small" style="margin:0">فقط قیمتی را وارد کنید که معتبر است؛ فیلد خالی تغییر نمی‌کند. نرخ ثبت‌شده «دستی» علامت‌گذاری می‌شود.</p>
            <label class="field"><span>رمز عبور مدیر</span><input class="input" type="password" name="password" required autocomplete="current-password"></label>
            <div class="form-error hidden"></div>
            <button class="btn btn-primary btn-block">ثبت و انتشار</button></form>`);
          break;
        }
        case 'rate-auto': sensitive('admin.rate.auto', { key: t.dataset.key }, 'نرخ به حالت دریافت خودکار بازگشت.'); break;
        case 'rate-hide': sensitive('admin.rate.remove', { key: t.dataset.key }, 'وضعیت نمایش نرخ تغییر کرد.'); break;
        case 'rate-hist': {
          const r = await backend.rateHistory(t.dataset.key, '90d');
          modal('تاریخچه نرخ (۳ ماه)', `<div class="chart">${lineChart(r.points)}</div><div class="hist-list" style="margin-top:12px">${r.points.slice().reverse().slice(0, 80).map((p) => `<div class="hist-row"><span class="small muted">${fmtDate(p.at)}</span><span class="num" style="color:var(--buy)">${p.buy != null ? fmt(p.buy) : '—'}</span><span class="num" style="color:var(--sell)">${p.sell != null ? fmt(p.sell) : '—'}</span><span class="badge">${KIND_LABEL[p.kind] || ''}</span></div>`).join('') || '<p class="muted">موردی ثبت نشده است.</p>'}</div>`);
          break;
        }
        case 'msg-filter': ui.adminRates.filter = t.dataset.v; ui.adminRates.msgs = null; render(); break;
        case 'msg-ignore': await act('admin.message.ignore', { id: nid }, 'پیام نادیده گرفته شد.'); ui.adminRates.msgs = null; render(); break;
        case 'source-fetch': { t.disabled = true; t.textContent = 'در حال دریافت…'; const r = await backend.sourceFetch(nid); await refresh(); ui.adminRates.msgs = null; render(); toast(r.error ? 'خطا: ' + r.error : `دریافت شد: ${r.fetched} پیام، ${r.new} جدید، ${r.applied} نرخ ثبت، ${r.review} برای بررسی.`, !!r.error); break; }
        case 'source-toggle': sensitive('admin.source.toggle', { sourceId: nid, field: t.dataset.v }, 'تنظیم منبع تغییر کرد.'); break;
        case 'asset-delete': sensitive('admin.asset.delete', { assetId: nid }, 'ارز حذف شد. تاریخچه آن حفظ می‌شود.', 'حذف ارز از فهرست. نرخ‌های ثبت‌شده و تاریخچه حذف نمی‌شوند.'); break;
        case 'rates-market': ui.ratesView = { ...ui.ratesView, market: t.dataset.v, key: null }; render(); break;
        case 'rates-period': ui.ratesView.period = t.dataset.v; render(); break;
        case 'chart-mode': ui.ratesView.chart = t.dataset.v; render(); break;
        case 'chart-side': ui.ratesView.cside = t.dataset.v; render(); break;
        case 'watch': e.stopPropagation(); watch.toggle(t.dataset.key); render(); break;
        case 'conv-swap': { const c = ui.conv; [c.from, c.to] = [c.to, c.from]; render(); break; }
        case 'alert-del': await act('alert.delete', { id: nid }, 'هشدار حذف شد.'); break;
        case 'asset-toggle': sensitive('admin.asset.toggle', { assetId: nid }, 'وضعیت دارایی تغییر کرد.'); break;
        case 'asset-edit': {
          const as = view.assets.find((x) => x.id === nid); const f = document.querySelector('[data-form="asset"]');
          ['id', 'code', 'name', 'unit', 'priceCurrency', 'kind', 'sortOrder'].forEach((k) => { f[k].value = as[k] ?? ''; });
          f.aliases.value = (as.aliases || []).join('، '); f.popular.checked = !!as.popular;
          f.querySelector('h3').textContent = `ویرایش ${as.name}`; f.code.focus(); break;
        }
        case 'resolve-report':
          modal('ثبت رسیدگی', `<form data-form="resolve" data-id="${nid}" class="stack"><label class="field"><span>یادداشت مدیریت</span><input class="input" name="note"></label><button class="btn btn-primary btn-block">ثبت</button></form>`); break;
        case 'totp-setup': ui.totp = await backend.totpSetup(); render(); break;
        default: break;
      }
    } catch (err) { if (err && err.message) toast(err.message, true); }
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-form]'); if (!f) return;
    e.preventDefault();
    const d = formData(f), id = Number(f.dataset.id);
    const btn = f.querySelector('button:not([type="button"])'); if (btn) btn.disabled = true;
    const showErr = (msg) => { const el = f.querySelector('.form-error'); if (el) { el.textContent = msg; el.classList.remove('hidden'); } else toast(msg, true); };
    try {
      switch (f.dataset.form) {
        case 'login': await backend.login(d); await refresh(); location.hash = approved() ? '#dashboard' : '#profile'; render(); toast('ورود موفق.'); break;
        case 'register': await backend.register(d); await refresh(); location.hash = '#profile'; render(); toast('درخواست عضویت ثبت شد.'); break;
        case 'admin-login': {
          const L = ui.adminLogin;
          const body = L.need2fa ? { phone: L.phone, password: L.password, code: d.code } : { phone: d.phone, password: d.password };
          const r = await backend.login(body);
          if (r && r.need2fa) { ui.adminLogin = { need2fa: true, phone: d.phone, password: d.password }; render(); break; }
          ui.adminLogin = { need2fa: false };
          await refresh(); location.hash = '#admin'; render(); break;
        }
        case 'order': {
          const r = await backend.action('order.create', { ...d, side: ui.side });
          await refresh(); location.hash = `#order-${r.orderId}`; render(); toast('سفارش ثبت و منتشر شد.'); break;
        }
        case 'request': {
          const r = await backend.action('deal.request', { orderId: id, amount: d.amount, note: d.note });
          await refresh(); closeModal(); location.hash = `#deal-${r.dealId}`; render(); toast('درخواست ارسال شد.'); break;
        }
        case 'reject': await act('deal.reject', { dealId: id, reason: d.reason }, 'درخواست رد شد.'); break;
        case 'alert': await act('alert.create', { key: f.dataset.key, side: d.side, op: d.op, value: d.value }, 'هشدار قیمت ثبت شد.'); break;
        case 'complete': await act('deal.complete', { dealId: id }, 'تکمیل معامله از طرف شما ثبت شد.'); break;
        case 'cancel-deal': await act('deal.cancel', { dealId: id, reason: d.reason }, 'معامله لغو شد.'); break;
        case 'close-order': await act('order.cancel', { orderId: id }, 'سفارش بسته شد.'); break;
        case 'message': await act('message.send', { dealId: id, text: d.text }); { const i = document.querySelector('[data-form="message"] input'); if (i) i.focus(); } break;
        case 'report': await act('report.create', { userId: Number(f.dataset.uid), dealId: f.dataset.deal || null, reason: d.reason }, 'گزارش به مدیریت ارسال شد.'); break;
        case 'profile': await act('profile.update', { ...d, showContact: !!f.showContact.checked }, 'مشخصات ذخیره شد.'); break;
        case 'resubmit': await act('account.resubmit', d, 'مشخصات مجدداً برای بررسی ارسال شد.'); break;
        case 'password': await backend.changePassword(d.current, d.next); f.reset(); toast('رمز عبور تغییر کرد.'); break;
        /* admin */
        case 'reject-user': await act('admin.user.setStatus', { userId: id, status: 'rejected', reason: d.reason }, 'درخواست رد و به متقاضی اعلام شد.'); ui.members.list = null; break;
        case 'block-user': await act('admin.user.setStatus', { userId: id, status: 'blocked', reason: d.reason }, 'حساب مسدود شد.'); ui.members.list = null; break;
        case 'member-search': ui.members = { ...ui.members, q: d.q.trim(), status: d.q.trim() ? '' : ui.members.status, list: null, offset: 0 }; render(); break;
        case 'resolve': await act('admin.report.resolve', { reportId: id, note: d.note }, 'رسیدگی ثبت شد.'); break;
        case 'sensitive': await runSensitive(d.password); break;
        case 'confirm-large': await runSensitive(d.password, { confirmLarge: true }); break;
        case 'rate':
          pendingSensitive = { type: 'admin.rate.set', payload: { code: d.code, quote: d.quote, market: d.market, settlement: d.settlement, buy: d.buy, sell: d.sell }, okMsg: 'نرخ ثبت و منتشر شد.' };
          await runSensitive(d.password); break;
        case 'asset': sensitive('admin.asset.save', { ...d, popular: !!f.popular.checked, id: d.id ? Number(d.id) : undefined }, 'ارز ذخیره شد.', `ذخیره ارز ${esc(d.code)}`); break;
        case 'source': sensitive('admin.source.save', { ...d }, 'منبع ذخیره شد.', `افزودن کانال ${esc(d.channel)}`); break;
        case 'paste': { const r = await backend.action('admin.message.paste', { sourceId: Number(d.sourceId) || undefined, text: d.text }); f.reset(); ui.adminRates.msgs = null; toast(r.status === 'nodata' ? 'نرخی در متن شناسایی نشد.' : 'پیام تحلیل و به صف بررسی اضافه شد.'); location.hash = '#admin-rates-review'; await refresh(); render(); break; }
        case 'msg-apply': {
          const m = (ui.adminRates.msgs || []).find((x) => x.id === id); if (!m) break;
          const items = (m.items || []).map((_, i) => i).filter((i) => f['use' + i] && f['use' + i].checked).map((i) => ({ code: d[`i${i}_code`], quote: d[`i${i}_quote`], market: d[`i${i}_market`], settlement: d[`i${i}_settlement`], buy: d[`i${i}_buy`], sell: d[`i${i}_sell`] }));
          if (!items.length) throw new Error('هیچ موردی انتخاب نشده است.');
          pendingSensitive = { type: 'admin.message.apply', payload: { id, items }, okMsg: 'نرخ‌ها ثبت و منتشر شد.' };
          ui.adminRates.msgs = null;
          modal('تأیید با رمز عبور', `<form data-form="sensitive" class="stack"><div class="notice">ثبت ${items.length} نرخ از پیام #${esc(m.msgId)}</div><label class="field"><span>رمز عبور مدیر</span><input class="input" type="password" name="password" required autocomplete="current-password"></label><div class="form-error hidden"></div><button class="btn btn-primary btn-block">تأیید و ثبت</button></form>`);
          break;
        }
        case 'broadcast': sensitive('admin.broadcast', d, 'اطلاعیه ارسال شد.', `ارسال اطلاعیه به همه اعضا: «${esc(d.text)}»`); break;
        case 'totp-enable': await backend.totpEnable(d.code, d.password); ui.totp = null; await refresh(); render(); toast('تأیید دومرحله‌ای فعال شد.'); break;
        case 'totp-disable': await backend.totpDisable(d.code, d.password); await refresh(); render(); toast('تأیید دومرحله‌ای غیرفعال شد.', true); break;
        default: break;
      }
    } catch (err) { showErr(err.message); } finally { if (btn && btn.isConnected) btn.disabled = false; }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.rates === 'q') {
      ui.ratesView.q = t.value; const pos = t.selectionStart; render();
      const ni = document.querySelector('[data-rates="q"]'); if (ni) { ni.focus(); try { ni.setSelectionRange(pos, pos); } catch { /* ignore */ } }
      return;
    }
    if (t.dataset.rates === 'sort') { ui.ratesView.sort = t.value; render(); return; }
    if (t.dataset.conv) {
      ui.conv[t.dataset.conv] = t.value;
      if (t.dataset.conv === 'amount') { const pos = t.selectionStart; render(); const ni = document.querySelector('[data-conv="amount"]'); if (ni) { ni.focus(); try { ni.setSelectionRange(pos, pos); } catch { /* ignore */ } } }
      else render();
      return;
    }
    if (t.dataset.filter) {
      ui.filters[t.dataset.filter] = t.value;
      if (t.tagName === 'SELECT') render(); else renderMarketTable();
      return;
    }
    if (t.dataset.calc) {
      const el = t.closest('form').querySelector('[data-total]');
      const v = Number(String(t.value).replace(/,/g, '')) * Number(t.dataset.calc);
      const o = orderOf(Number(t.closest('form').dataset.id));
      if (el) el.textContent = v > 0 ? `${fmt(v, 2)} ${o ? o.priceCurrency : ''}` : '—';
    }
    if (t.closest('[data-form="order"]')) updateOrderAside();
    const rf = t.closest('[data-form="rate"]');
    if (rf && rf.code) {
      const r = view.rates.find((x) => x.key === rateKeyOf(rf.code.value, rf.quote.value, rf.market.value, rf.settlement.value));
      const buy = Number(rf.buy.value), sell = Number(rf.sell.value), el = document.getElementById('rate-delta');
      if (el && r && buy > 0 && sell > 0) {
        const ch = (((buy + sell) / 2 - (r.buy + r.sell) / 2) / ((r.buy + r.sell) / 2)) * 100;
        el.innerHTML = `تغییر نسبت به نرخ فعلی: <b class="num chg ${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</b>${Math.abs(ch) > 15 ? ' — <b style="color:var(--sell)">تغییر بزرگ</b>' : ''}`;
      }
    }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.change === 'asset-pick') {
      const opt = t.selectedOptions[0]; const f = t.form;
      f.unit.value = opt.dataset.unit; f.priceCurrency.value = opt.dataset.cur; updateOrderAside();
    }
    if (t.dataset.change === 'demo-switch') {
      LocalBackend.setUid(Number(t.value) || null); await refresh(); render();
    }
  });
  window.addEventListener('hashchange', () => { ui.notifOpen = false; closeModal(); render(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  /* =========================================================
     Boot
     ========================================================= */
  async function detect() {
    if (location.protocol === 'file:') return LocalBackend;
    try {
      const ctl = new AbortController(); setTimeout(() => ctl.abort(), 2500);
      const r = await fetch('api/health', { signal: ctl.signal, credentials: 'same-origin' });
      const j = await r.json();
      if (j && j.mode === 'server') return ServerBackend;
    } catch { /* no server: demo mode */ }
    return LocalBackend;
  }
  document.documentElement.dataset.theme = store.get('sarai-theme') === 'light' ? 'light' : 'dark';
  (async function boot() {
    backend = await detect();
    if (backend === LocalBackend) LocalBackend.init();
    if (backend === ServerBackend) ADMIN_MODE = document.documentElement.dataset.mode === 'admin';
    else {
      try { if (location.hash === '#sarai-panel') sessionStorage.setItem('sarai-admin', '1'); ADMIN_MODE = sessionStorage.getItem('sarai-admin') === '1'; }
      catch { ADMIN_MODE = location.hash === '#sarai-panel'; }
    }
    backend.scope = ADMIN_MODE ? 'admin' : 'user';
    if (ADMIN_MODE) document.title = 'پنل مدیریت — سرای شهزاده';
    if (backend === ServerBackend && !ADMIN_MODE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    await refresh();
    backend.subscribe(onRemoteChange, onMarket);
    if (ADMIN_MODE) setInterval(() => { if (!busy()) onRemoteChange(); }, 120e3); // keeps idle-timeout state accurate
    render();
  })().catch((e) => { $app.innerHTML = `<div style="padding:40px;text-align:center">خطا در بارگذاری: ${esc(e.message)}</div>`; });
})();
