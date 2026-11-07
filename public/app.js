/* Shahzada Sarai — web client (vanilla JS, RTL). Works against the Node API, or fully in-browser in demo mode. */
(function () {
  'use strict';
  const E = window.SaraiEngine;
  const $app = document.getElementById('app');

  /* =========================================================
     Backends
     ========================================================= */
  async function http(path, body) {
    const res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'خطا در ارتباط با سرور');
    return data;
  }
  const ServerBackend = {
    mode: 'server',
    getView: () => http('/api/state'),
    action: (type, payload) => http('/api/action', { type, payload }).then((r) => r.result),
    register: (d) => http('/api/register', d),
    login: (d) => http('/api/login', d),
    logout: () => http('/api/logout', {}),
    changePassword: (current, next) => http('/api/password', { current, next }),
    subscribe(cb) {
      if (!window.EventSource) return;
      const es = new EventSource('/api/stream');
      es.addEventListener('changed', (e) => cb(Number(e.data)));
    },
  };

  const KEY = 'sarai-demo-v1', UKEY = 'sarai-demo-uid';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable: keep in memory */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  // Demo-only password hashing (the real server uses scrypt).
  const demoHash = (pw) => { let h = 5381; for (const c of 'sarai:' + pw) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return 'demo$' + h.toString(36); };
  const LocalBackend = {
    mode: 'local', state: null, uid: null,
    init() {
      const raw = store.get(KEY);
      try { this.state = raw ? JSON.parse(raw) : null; } catch { this.state = null; }
      if (!this.state) this.reset(true);
      const u = Number(store.get(UKEY));
      this.uid = u || null;
    },
    save() { store.set(KEY, JSON.stringify(this.state)); },
    reset(silent) {
      this.state = E.emptyState();
      E.seed(this.state, { now: Date.now(), hashPassword: demoHash });
      this.save();
      if (!silent) { this.uid = null; store.del(UKEY); }
    },
    setUid(id) { this.uid = id || null; id ? store.set(UKEY, String(id)) : store.del(UKEY); },
    run(fn) {
      const snap = JSON.stringify(this.state);
      try { const r = fn(this.state); this.save(); return r; } catch (e) { this.state = JSON.parse(snap); throw e; }
    },
    async getView() { return E.buildView(this.state, this.uid, { now: Date.now() }); },
    async action(type, payload) { return this.run((s) => E.dispatch(s, this.uid, type, payload, { now: Date.now() })); },
    async register(d) { const u = this.run((s) => E.register(s, d, { now: Date.now(), hashPassword: demoHash })); this.setUid(u.id); },
    async login(d) { const u = E.login(this.state, d, { verifyPassword: (pw, h) => demoHash(pw) === h }); this.setUid(u.id); },
    async logout() { this.setUid(null); },
    async changePassword(cur, next) {
      const me = this.state.users.find((u) => u.id === this.uid);
      if (!me || demoHash(cur) !== me.passHash) throw new Error('رمز فعلی اشتباه است');
      if (String(next).length < 6) throw new Error('رمز جدید باید حداقل ۶ حرف باشد');
      this.run(() => { me.passHash = demoHash(next); });
    },
    subscribe(cb) {
      window.addEventListener('storage', (e) => {
        if (e.key === KEY && e.newValue) { try { this.state = JSON.parse(e.newValue); cb(this.state.version); } catch { /* ignore */ } }
        if (e.key === UKEY) { this.uid = Number(e.newValue) || null; cb(-1); }
      });
    },
  };

  /* =========================================================
     State + helpers
     ========================================================= */
  let backend = null, view = null, pendingRender = false;
  const ui = {
    filters: { asset: '', side: '', min: '', max: '', minAmount: '', q: '', sort: 'new' },
    notifOpen: false, menuOpen: false, rateAsset: null, side: 'sell', orderTab: 'all', adminUserFilter: 'all',
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 6) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
  const N = (n, d) => `<span class="num">${fmt(n, d)}</span>`;
  const dateFmt = new Intl.DateTimeFormat('fa-AF', { dateStyle: 'medium', timeStyle: 'short' });
  const dayFmt = new Intl.DateTimeFormat('fa-AF', { month: 'short', day: 'numeric' });
  const fmtDate = (t) => (t ? dateFmt.format(new Date(t)) : '—');
  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'همین حالا';
    if (s < 3600) return `${Math.floor(s / 60)} دقیقه پیش`;
    if (s < 86400) return `${Math.floor(s / 3600)} ساعت پیش`;
    return `${Math.floor(s / 86400)} روز پیش`;
  }
  function left(t) {
    if (!t) return 'بدون محدودیت';
    const s = Math.round((t - Date.now()) / 1000);
    if (s <= 0) return 'منقضی';
    if (s < 3600) return `${Math.ceil(s / 60)} دقیقه مانده`;
    if (s < 86400) return `${Math.floor(s / 3600)} ساعت مانده`;
    return `${Math.floor(s / 86400)} روز مانده`;
  }
  const asset = (id) => view.assets.find((a) => a.id === id) || { code: '?', name: '?', unit: '' };
  const user = (id) => (view.users || []).find((u) => u.id === id) || (view.admin && view.admin.users.find((u) => u.id === id));
  const orderOf = (id) => view.orders.find((o) => o.id === id);
  const me = () => view.me;
  const approved = () => !!(view.me && view.me.status === 'approved');
  const isAdmin = () => !!(view.me && view.me.role === 'admin' && view.me.status === 'approved');

  const ICON = {
    check: '<svg class="verified" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-label="تأییدشده"><path d="M12 1l2.6 2.2 3.4-.4.9 3.3 3 1.7-1.2 3.2 1.2 3.2-3 1.7-.9 3.3-3.4-.4L12 23l-2.6-2.2-3.4.4-.9-3.3-3-1.7L3.3 13 2.1 9.8l3-1.7.9-3.3 3.4.4z"/><path d="M10.5 15.6l-3.2-3.2 1.4-1.4 1.8 1.8 4.8-4.8 1.4 1.4z" fill="#fff"/></svg>',
    bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/></svg>',
    menu: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
    box: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/></svg>',
    sun: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>',
    nHome: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/></svg>',
    nMarket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3"/></svg>',
    nRates: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18M5 16l4-5 4 3 6-8"/></svg>',
    nNew: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    nDash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg>',
    nAdmin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    logo: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M3 21h18M5 21V10l7-6 7 6v11M9 21v-6h6v6M9 11h.01M15 11h.01"/></svg>',
    wa: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm5.3 14.2c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.8s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.7 1.2 1.6 1.9 1.1.9 2 1.2 2.3 1.4.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.6-.1l2 .9c.3.1.5.2.5.3.1.2.1.7-.1 1.2z"/></svg>',
  };

  const sideBadge = (side) => side === 'sell' ? '<span class="badge sell">فروش</span>' : '<span class="badge buy">خرید</span>';
  const ORDER_CLS = { active: 'ok', filled: 'blue', closed: '', cancelled: 'bad', expired: 'warn' };
  const DEAL_CLS = { pending: 'warn', accepted: 'blue', completed: 'ok', rejected: 'bad', cancelled: 'bad' };
  const orderBadge = (s) => `<span class="badge ${ORDER_CLS[s] || ''}">${E.ORDER_STATUS[s] || s}</span>`;
  const dealBadge = (s) => `<span class="badge ${DEAL_CLS[s] || ''}">${E.DEAL_STATUS[s] || s}</span>`;
  const userBadge = (s) => `<span class="badge ${s === 'approved' ? 'ok' : s === 'blocked' ? 'bad' : 'warn'}">${E.USER_STATUS[s]}</span>`;
  const assetChip = (a, sub) => `<span class="asset-chip"><span class="asset-ico ${a.kind === 'metal' ? 'metal-' + a.code : ''}">${esc(a.code)}</span><span>${esc(a.name)}${sub ? `<div class="muted small" style="font-weight:400">${sub}</div>` : ''}</span></span>`;
  function nameLink(id) {
    const u = user(id);
    if (!u) return '<span class="muted">🔒 فقط برای اعضا</span>';
    return `<a href="#user-${u.id}">${esc(u.company || u.name)}</a> ${u.status === 'approved' ? ICON.check : ''}`;
  }
  const emptyBox = (text) => `<div class="empty">${ICON.box}${esc(text)}</div>`;
  const total = (o, amt) => (amt == null ? o.amount : amt) * o.price;
  const qty = (o, amt) => `${N(amt == null ? o.amount : amt)} <span class="muted small">${esc(o.unit)}</span>`;

  /* =========================================================
     Toasts, modals
     ========================================================= */
  function toast(msg, err) {
    let w = document.querySelector('.toast-wrap');
    if (!w) { w = document.createElement('div'); w.className = 'toast-wrap'; document.body.appendChild(w); }
    const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
    w.appendChild(t); setTimeout(() => t.remove(), err ? 4500 : 3000);
  }
  function modal(title, body) {
    closeModal();
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal card" role="dialog" aria-modal="true"><div class="modal-head"><h3>${title}</h3><button class="x" data-act="close-modal" aria-label="بستن">×</button></div><div class="card-pad">${body}</div></div>`;
    bg.addEventListener('click', (e) => { if (e.target === bg) closeModal(); });
    document.body.appendChild(bg);
    const first = bg.querySelector('input, textarea, select'); if (first) first.focus();
  }
  function closeModal() { document.querySelectorAll('.modal-bg').forEach((m) => m.remove()); }

  /* =========================================================
     Data flow
     ========================================================= */
  async function refresh() { view = await backend.getView(); }
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
    await refresh();
    if (busy()) { pendingRender = true; return; }
    render();
  }
  setInterval(() => { if (pendingRender && !busy()) { pendingRender = false; render(); } }, 1500);
  setInterval(() => { if (view && !busy()) render(); }, 60e3); // keep relative times fresh

  /* =========================================================
     Layout
     ========================================================= */
  const route = () => (location.hash || '#home').slice(1) || 'home';
  function header() {
    const r = route();
    const m = me();
    const unread = m ? view.notifications.filter((n) => !n.read).length : 0;
    const link = (href, label) => `<a href="#${href}" class="${r === href || r.startsWith(href + '-') ? 'active' : ''}">${label}</a>`;
    const tickerItems = view.rates.map((rt) => {
      const a = asset(rt.assetId); const mid = (rt.buy + rt.sell) / 2;
      const ch = rt.prevMid ? ((mid - rt.prevMid) / rt.prevMid) * 100 : 0;
      return `<span><b>${esc(a.name)}</b> <span class="num">${fmt(rt.buy)} / ${fmt(rt.sell)}</span> <span class="num ${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch).toFixed(2)}%</span></span>`;
    }).join('');
    return `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#home"><span class="brand-mark">${ICON.logo}</span><span><b>سرای شهزاده</b><small>بازار دیجیتال معاملات کابل</small></span></a>
        <nav class="nav ${ui.menuOpen ? 'open' : ''}">
          ${link('home', 'صفحه اصلی')}${link('market', 'بازار معاملات')}${link('rates', 'نرخ ارزها')}${link('new', 'ثبت سفارش')}
          ${m ? link('dashboard', 'داشبورد') : ''}${isAdmin() ? link('admin', 'مدیریت') : ''}${m ? `<a href="#profile" class="mobile-only">پروفایل (${esc(m.company || m.name)})</a>` : ''}
        </nav>
        <div class="top-actions">
          ${m ? `<button class="bell" data-act="toggle-notifs" aria-label="اعلان‌ها">${ICON.bell}${unread ? `<span class="dot">${unread}</span>` : ''}</button>
                 <a class="btn btn-light btn-sm me-btn" href="#profile">${esc(m.company || m.name)}</a>
                 <button class="btn btn-light btn-sm" data-act="logout"><span class="btn-text">خروج</span><span aria-hidden="true">⎋</span></button>`
              : `<a class="btn btn-light btn-sm" href="#login">ورود</a><a class="btn btn-primary btn-sm" href="#register">ثبت‌نام</a>`}
          <button class="bell" data-act="theme" aria-label="تغییر تم">${document.documentElement.dataset.theme === 'light' ? ICON.moon : ICON.sun}</button>
        </div>
      </div>
      ${view.rates.length ? `<div class="ticker"><div class="ticker-track">${tickerItems}${tickerItems}</div></div>` : ''}
    </header>
    ${backend.mode === 'local' ? demoBar() : ''}
    ${ui.notifOpen && m ? notifDrawer() : ''}`;
  }
  function demoBar() {
    const users = LocalBackend.state.users;
    return `<div class="demo-bar">نسخه نمایشی — اطلاعات فقط در همین مرورگر ذخیره می‌شود. ورود سریع به‌عنوان:
      <select data-change="demo-switch"><option value="">— مهمان —</option>${users.map((u) => `<option value="${u.id}" ${view.me && view.me.id === u.id ? 'selected' : ''}>${esc(u.company)}${u.role === 'admin' ? ' (مدیر)' : u.status !== 'approved' ? ' (تأییدنشده)' : ''}</option>`).join('')}</select>
      <button data-act="demo-reset">بازنشانی اطلاعات نمونه</button></div>`;
  }
  function notifDrawer() {
    const list = view.notifications;
    return `<div class="drawer card">
      <div class="row card-pad" style="padding:12px 16px;border-bottom:1px solid var(--line)"><b>اعلان‌ها</b><span class="spacer"></span>
      ${list.some((n) => !n.read) ? '<button class="btn btn-ghost btn-sm" data-act="read-all">همه خوانده شد</button>' : ''}</div>
      ${list.length ? list.slice(0, 30).map((n) => `<div class="notif ${n.read ? '' : 'unread'}" data-act="open-notif" data-id="${n.id}" data-link="${esc(n.link)}">${esc(n.text)}<time>${ago(n.at)}</time></div>`).join('') : emptyBox('اعلانی ندارید')}
    </div>`;
  }

  function render() {
    if (!view) return;
    const r = route();
    let page;
    try { page = pageFor(r); } catch (e) { console.error(e); page = `<div class="card card-pad">${esc(e.message)}</div>`; }
    const scrollY = window.scrollY;
    const entering = render.lastRoute !== r;
    $app.innerHTML = `${header()}<main class="${entering ? 'enter' : ''}">${page}</main>${bottomNav(r)}
      <footer class="footer">سرای شهزاده کابل — بستر معرفی پیشنهاد و ارتباط خریدار و فروشنده. انتقال پول و تسویه در این سایت انجام نمی‌شود.</footer>`;
    if (render.lastRoute === r) window.scrollTo(0, scrollY); else window.scrollTo(0, 0);
    render.lastRoute = r;
    if (entering) countUp();
    const chat = document.querySelector('.chat'); if (chat) chat.scrollTop = chat.scrollHeight;
    afterRender();
  }

  function bottomNav(r) {
    const items = [['home', 'خانه', ICON.nHome], ['market', 'بازار', ICON.nMarket], ['new', 'ثبت', ICON.nNew], ['rates', 'نرخ‌ها', ICON.nRates],
      me() ? (isAdmin() && r.startsWith('admin') ? ['admin', 'مدیریت', ICON.nAdmin] : ['dashboard', 'داشبورد', ICON.nDash]) : ['login', 'ورود', ICON.nDash]];
    return `<nav class="bottom-nav">${items.map(([h, l, ic]) => `<a href="#${h}" class="${r === h || r.startsWith(h + '-') ? 'active' : ''}">${ic}<span>${l}</span></a>`).join('')}</nav>`;
  }
  // Animated number counters for elements with data-count
  function countUp() {
    document.querySelectorAll('[data-count]').forEach((el) => {
      const target = Number(el.dataset.count); if (!isFinite(target) || target === 0) return;
      const t0 = performance.now(), dur = 1100;
      const step = (t) => { const k = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - k, 4); el.textContent = Math.round(target * e).toLocaleString('en-US'); if (k < 1) requestAnimationFrame(step); };
      el.textContent = '0'; requestAnimationFrame(step);
    });
  }
  // Circular gradient ring (SVG)
  let ringSeq = 0;
  function ringSvg(frac, size, stroke, c1, c2) {
    const id = 'rg' + (++ringSeq), r = (size - stroke) / 2, len = 2 * Math.PI * r;
    const off = len * (1 - Math.max(0.02, Math.min(1, frac)));
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(127,127,127,.12)" stroke-width="${stroke}"/>
      <circle class="arc" style="--len:${len.toFixed(1)}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${len.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>`;
  }
  function pageFor(r) {
    let m;
    if (r === 'home') return pageHome();
    if (r === 'market') return pageMarket();
    if (r === 'rates') return pageRates();
    if (r === 'new') return pageNew();
    if (r === 'login') return pageLogin();
    if (r === 'register') return pageRegister();
    if (r === 'profile') return needUser() || pageProfile();
    if ((m = /^dashboard(?:-(\w+))?$/.exec(r))) return needUser() || pageDashboard(m[1] || 'overview');
    if ((m = /^order-(\d+)$/.exec(r))) return needApproved() || pageOrder(Number(m[1]));
    if ((m = /^deal-(\d+)$/.exec(r))) return needUser() || pageDeal(Number(m[1]));
    if ((m = /^user-(\d+)$/.exec(r))) return needApproved() || pageUser(Number(m[1]));
    if ((m = /^admin(?:-(\w+))?$/.exec(r))) return (isAdmin() ? pageAdmin(m[1] || 'overview') : gate('این بخش فقط برای مدیر سیستم است.'));
    return gate('صفحه پیدا نشد.');
  }
  const gate = (msg, extra = '') => `<div class="auth-wrap card card-pad" style="text-align:center"><p>${msg}</p>${extra}</div>`;
  const needUser = () => (me() ? null : gate('برای دیدن این صفحه وارد حساب خود شوید.', '<div class="row" style="justify-content:center"><a class="btn btn-primary" href="#login">ورود</a><a class="btn" href="#register">ثبت‌نام</a></div>'));
  const needApproved = () => needUser() || (approved() ? null : gate('حساب شما هنوز توسط مدیر تأیید نشده است. پس از تأیید، به تمام بخش‌های بازار دسترسی خواهید داشت.', '<a class="btn" href="#profile">مشاهده پروفایل</a>'));

  /* =========================================================
     Orders table (shared)
     ========================================================= */
  function actionCell(o) {
    const m = me();
    if (!m) return `<a class="btn btn-sm" href="#login">ورود برای معامله</a>`;
    if (o.userId === m.id) return `<a class="btn btn-sm" href="#order-${o.id}">مدیریت</a>`;
    if (o.status !== 'active') return orderBadge(o.status);
    if (!approved()) return `<button class="btn btn-sm" disabled title="حساب شما هنوز تأیید نشده">منتظر تأیید</button>`;
    return o.side === 'sell'
      ? `<button class="btn btn-buy btn-sm" data-act="request" data-id="${o.id}">خرید</button>`
      : `<button class="btn btn-sell btn-sm" data-act="request" data-id="${o.id}">فروش به این خریدار</button>`;
  }
  function ordersTable(orders, opts = {}) {
    if (!orders.length) return emptyBox(opts.empty || 'سفارشی پیدا نشد');
    return `<div class="table-wrap"><table class="data responsive"><thead><tr>
      <th>دارایی</th><th>نوع</th><th>مقدار باقی‌مانده</th><th>نرخ</th><th>ارزش کل</th>${opts.noOwner ? '' : '<th>فروشنده / خریدار</th>'}<th>وضعیت</th><th></th></tr></thead><tbody>
      ${orders.map((o) => {
        const a = asset(o.assetId);
        const pct = o.amount ? Math.round(((o.amount - o.remaining) / o.amount) * 100) : 0;
        return `<tr class="${approved() ? 'clickable' : ''}" data-href="${approved() ? '#order-' + o.id : ''}">
          <td class="cell-main" data-l="دارایی">${assetChip(a, `#${o.id} · ${ago(o.createdAt)}`)}</td>
          <td data-l="نوع">${sideBadge(o.side)}</td>
          <td data-l="مقدار باقی‌مانده">${qty(o, o.remaining)}${o.remaining !== o.amount ? `<div class="muted small">از <span class="num">${fmt(o.amount)}</span> · ${pct}% واگذار</div>` : ''}</td>
          <td data-l="نرخ"><span class="price num">${fmt(o.price)}</span> <span class="muted small">${esc(o.priceCurrency)}</span></td>
          <td data-l="ارزش کل">${N(total(o, o.remaining), 2)} <span class="muted small">${esc(o.priceCurrency)}</span></td>
          ${opts.noOwner ? '' : `<td data-l="فروشنده / خریدار">${o.userId ? nameLink(o.userId) : '<span class="muted">🔒 فقط برای اعضا</span>'}</td>`}
          <td data-l="وضعیت">${orderBadge(o.status)}</td>
          <td class="cell-act" data-l="">${actionCell(o)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function bookSummary(orders) {
    const out = [];
    for (const a of view.assets.filter((x) => x.active)) {
      const os = orders.filter((o) => o.assetId === a.id && o.status === 'active');
      if (!os.length) continue;
      const sells = os.filter((o) => o.side === 'sell'), buys = os.filter((o) => o.side === 'buy');
      const ask = sells.length ? Math.min(...sells.map((o) => o.price)) : null;
      const bid = buys.length ? Math.max(...buys.map((o) => o.price)) : null;
      out.push({ a, ask, bid, n: os.length, sells: sells.length, buys: buys.length });
    }
    return out;
  }

  /* =========================================================
     Pages
     ========================================================= */
  function pageHome() {
    const active = view.orders.filter((o) => o.status === 'active').sort((a, b) => b.createdAt - a.createdAt);
    const book = bookSummary(view.orders);
    return `
    <section class="hero">
      <div>
        <span class="live"><i></i><b>زنده</b> بازار دیجیتال صرافان، زرگران و تاجران</span>
        <h1>معاملات سرای شهزاده،<br><span class="accent">بدون کانال تلگرام و واتس‌اپ</span></h1>
        <p>پیشنهاد خرید یا فروش خود را ثبت کنید، پیشنهادهای دیگران را ببینید و با یک کلیک درخواست معامله بفرستید. طرف مقابل تأیید می‌کند و ارتباط مستقیم برقرار می‌شود.</p>
        <div class="row">
          <a class="btn btn-primary btn-lg" href="#market">ورود به بازار</a>
          <a class="btn btn-lg" href="${approved() ? '#new' : me() ? '#profile' : '#register'}">${me() ? 'ثبت سفارش جدید' : 'عضویت رایگان'}</a>
        </div>
        <div class="book-mini">
          <table><thead><tr><th>دارایی</th><th>بهترین خرید</th><th>بهترین فروش</th></tr></thead><tbody>
          ${book.length ? book.slice(0, 5).map((b) => `<tr><td>${esc(b.a.name)}</td><td class="b num">${b.bid != null ? fmt(b.bid) : '—'}</td><td class="s num">${b.ask != null ? fmt(b.ask) : '—'}</td></tr>`).join('') : '<tr><td colspan="3" class="muted" style="text-align:center">هنوز پیشنهادی ثبت نشده</td></tr>'}
          </tbody></table>
        </div>
      </div>
      ${(() => {
        const st = view.stats, n = st.activeOrders || 0;
        const sellFrac = n ? st.sellOrders / n : 0;
        const mx = Math.max(st.members, st.activeDeals, st.completedDeals, 1);
        const mini = (v, c1, c2, label, sub, color) => `<div class="ring-item"><span class="node" style="color:${color}"></span><div class="mini">${ringSvg(0.15 + 0.8 * (v / mx), 84, 5, c1, c2)}<b class="num" data-count="${v}">${v}</b></div><div class="lbl" style="color:${color}">${label}<small>${sub}</small></div></div>`;
        return `<div class="rings">
          <div class="ring-big glow"><span class="halo"></span>${ringSvg(sellFrac || 0.02, 250, 14, '#22d3ee', '#3b82f6')}
            <div class="center"><b class="num" data-count="${n}">${n}</b><span>پیشنهاد فعال در بازار</span><em>${st.sellOrders} فروش · ${st.buyOrders} خرید</em></div></div>
          <div class="ring-list">
            ${mini(st.members, '#3ee09a', '#12a868', 'عضو تأییدشده', 'صراف، زرگر، تاجر', 'var(--buy)')}
            ${mini(st.activeDeals, '#8b7cf6', '#3b82f6', 'در حال انجام', 'معاملات تأییدشده', '#8b9cff')}
            ${mini(st.completedDeals, '#ffb34d', '#ff6b7a', 'تکمیل‌شده', 'تأیید دوطرفه', 'var(--sell)')}
          </div></div>`;
      })()}
    </section>

    <div class="page-head" style="margin-top:28px"><div><h1>آخرین پیشنهادهای بازار</h1><p>پیشنهادهای فعال اعضای تأییدشده</p></div><a class="btn" href="#market">مشاهده همه ←</a></div>
    <div class="card">${ordersTable(active.slice(0, 6), { empty: 'هنوز سفارشی ثبت نشده است' })}</div>

    <div class="grid g3" style="margin-top:24px">
      ${[['۱', 'عضویت و تأیید', 'با نام، شماره تماس و نام صرافی ثبت‌نام کنید. مدیر سیستم حساب شما را تأیید می‌کند.'],
         ['۲', 'ثبت سفارش', 'مقدار و نرخ پیشنهادی خود را برای خرید یا فروش هر ارز، طلا یا نقره ثبت کنید.'],
         ['۳', 'درخواست و تأیید', 'دیگران درخواست می‌فرستند؛ شما کامل یا جزئی تأیید می‌کنید و ارتباط مستقیم برقرار می‌شود.']]
        .map(([n, t, d]) => `<div class="card card-pad"><span class="asset-ico" style="margin-bottom:10px">${n}</span><h3>${t}</h3><p class="muted" style="margin:0">${d}</p></div>`).join('')}
    </div>`;
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
    const book = bookSummary(view.orders);
    return `
    <div class="page-head"><div><h1>بازار معاملات</h1><p>تمام پیشنهادهای فعال خرید و فروش — برای مقایسه نرخ‌ها، فیلتر کنید.</p></div>
      ${approved() ? '<a class="btn btn-primary" href="#new">+ ثبت سفارش</a>' : ''}</div>
    ${!me() ? '<div class="notice" style="margin-bottom:16px">نام معامله‌گران و امکان ارسال درخواست فقط برای اعضای تأییدشده نمایش داده می‌شود. <a href="#register">عضو شوید</a> یا <a href="#login">وارد شوید</a>.</div>' : ''}
    ${me() && !approved() ? '<div class="notice warn" style="margin-bottom:16px">حساب شما منتظر تأیید مدیر است. پس از تأیید می‌توانید درخواست خرید و فروش بفرستید.</div>' : ''}
    ${book.length ? `<div class="grid g4" style="margin-bottom:18px">${book.map((b) => `
      <div class="card tile sheen" style="cursor:pointer" data-act="filter-asset" data-id="${b.a.id}">
        <div class="row">${assetChip(b.a)}<span class="spacer"></span><span class="badge">${b.n} پیشنهاد</span></div>
        <div class="grid g2" style="gap:8px;margin-top:10px">
          <div><span class="small muted">بهترین خرید</span><div class="num" style="color:var(--buy);font-weight:800">${b.bid != null ? fmt(b.bid) : '—'}</div></div>
          <div><span class="small muted">بهترین فروش</span><div class="num" style="color:var(--sell);font-weight:800">${b.ask != null ? fmt(b.ask) : '—'}</div></div>
        </div></div>`).join('')}</div>` : ''}
    <div class="card">
      <div class="filters">
        <select class="input" data-filter="asset"><option value="">همه دارایی‌ها</option>${view.assets.filter((a) => a.active).map((a) => `<option value="${a.id}" ${String(a.id) === f.asset ? 'selected' : ''}>${esc(a.name)} (${esc(a.code)})</option>`).join('')}</select>
        <select class="input" data-filter="side"><option value="">خرید و فروش</option><option value="sell" ${f.side === 'sell' ? 'selected' : ''}>فقط فروش</option><option value="buy" ${f.side === 'buy' ? 'selected' : ''}>فقط خرید</option></select>
        <input class="input num" data-filter="min" placeholder="کمترین نرخ" inputmode="decimal" value="${esc(f.min)}">
        <input class="input num" data-filter="max" placeholder="بیشترین نرخ" inputmode="decimal" value="${esc(f.max)}">
        <input class="input num" data-filter="minAmount" placeholder="حداقل مقدار" inputmode="decimal" value="${esc(f.minAmount)}">
        <input class="input" data-filter="q" placeholder="نام صرافی…" value="${esc(f.q)}" ${approved() ? '' : 'disabled'}>
      </div>
      <div class="row" style="padding:10px 14px;border-bottom:1px solid var(--line)">
        <span class="muted small" id="market-count"></span><span class="spacer"></span>
        <span class="small muted">مرتب‌سازی:</span>
        <select class="input" style="width:auto;padding:5px 10px" data-filter="sort">
          ${[['new', 'جدیدترین'], ['pa', 'نرخ: کم به زیاد'], ['pd', 'نرخ: زیاد به کم'], ['amt', 'بیشترین مقدار']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        ${Object.entries(f).some(([k, v]) => k !== 'sort' && v) ? '<button class="btn btn-ghost btn-sm" data-act="clear-filters">پاک‌کردن فیلترها</button>' : ''}
      </div>
      <div id="market-table"></div>
    </div>`;
  }
  function renderMarketTable() {
    const el = document.getElementById('market-table'); if (!el) return;
    const os = filteredOrders();
    el.innerHTML = ordersTable(os, { empty: 'با این فیلترها پیشنهادی پیدا نشد' });
    const c = document.getElementById('market-count'); if (c) c.textContent = `${os.length} پیشنهاد فعال`;
  }

  /* ---------- request modal ---------- */
  function openRequest(orderId) {
    const o = orderOf(orderId); if (!o) return;
    const a = asset(o.assetId); const owner = user(o.userId);
    const verb = o.side === 'sell' ? 'خرید' : 'فروش';
    modal(`درخواست ${verb} — ${esc(a.name)}`, `
      <form data-form="request" data-id="${o.id}" class="stack">
        <dl class="kv"><dt>${o.side === 'sell' ? 'فروشنده' : 'خریدار'}</dt><dd>${esc(owner ? owner.company : '')}</dd>
          <dt>نرخ</dt><dd class="num">${fmt(o.price)} ${esc(o.priceCurrency)}</dd>
          <dt>مقدار باقی‌مانده</dt><dd><span class="num">${fmt(o.remaining)}</span> ${esc(o.unit)}</dd>
          ${o.minAmount ? `<dt>حداقل مقدار</dt><dd class="num">${fmt(o.minAmount)}</dd>` : ''}
          ${o.note ? `<dt>توضیحات</dt><dd>${esc(o.note)}</dd>` : ''}</dl>
        <label class="field"><span>مقدار موردنظر شما (${esc(o.unit)})</span>
          <input class="input num" name="amount" inputmode="decimal" value="${o.remaining}" data-calc="${o.price}" required></label>
        <div class="row small">${[0.25, 0.5, 1].map((p) => `<button type="button" class="btn btn-sm" data-act="fill-amt" data-v="${+(o.remaining * p).toFixed(6)}">${p === 1 ? 'تمام مقدار' : p * 100 + '٪'}</button>`).join('')}</div>
        <div class="total-box"><span>ارزش تقریبی</span><b class="num" data-total>${fmt(total(o, o.remaining), 2)} ${esc(o.priceCurrency)}</b></div>
        <label class="field"><span>پیام برای ${o.side === 'sell' ? 'فروشنده' : 'خریدار'} (اختیاری)</span><textarea class="input" name="note" placeholder="مثلاً زمان و محل تحویل"></textarea></label>
        <button class="btn ${o.side === 'sell' ? 'btn-buy' : 'btn-sell'} btn-block btn-lg">ارسال درخواست ${verb}</button>
        <p class="muted small" style="margin:0">پس از تأیید ${o.side === 'sell' ? 'فروشنده' : 'خریدار'}، اطلاعات تماس دو طرف نمایش داده می‌شود.</p>
      </form>`);
  }

  /* ---------- new order ---------- */
  function pageNew() {
    const gateMsg = needApproved(); if (gateMsg) return gateMsg;
    const assets = view.assets.filter((a) => a.active);
    const a0 = assets[0];
    return `
    <div class="page-head"><div><h1>ثبت سفارش جدید</h1><p>پیشنهاد خرید یا فروش خود را برای اعضای بازار منتشر کنید.</p></div></div>
    <div class="split">
      <form class="card card-pad stack" data-form="order">
        <div class="side-toggle">
          <button type="button" class="sell ${ui.side === 'sell' ? 'on' : ''}" data-act="side" data-v="sell">فروش (Sell)</button>
          <button type="button" class="buy ${ui.side === 'buy' ? 'on' : ''}" data-act="side" data-v="buy">خرید (Buy)</button>
        </div>
        <label class="field"><span>نوع دارایی</span>
          <select class="input" name="assetId" data-change="asset-pick">${assets.map((a) => `<option value="${a.id}" data-unit="${esc(a.unit)}" data-cur="${esc(a.priceCurrency)}">${esc(a.name)} (${esc(a.code)})</option>`).join('')}</select></label>
        <div class="grid g2">
          <label class="field"><span>مقدار</span><input class="input num" name="amount" inputmode="decimal" placeholder="40,000" required></label>
          <label class="field"><span>واحد مقدار</span><input class="input" name="unit" value="${esc(a0 ? a0.unit : '')}" required></label>
        </div>
        <div class="grid g2">
          <label class="field"><span>نرخ پیشنهادی (قیمت هر واحد)</span><input class="input num" name="price" inputmode="decimal" placeholder="65.30" required></label>
          <label class="field"><span>واحد قیمت</span><input class="input" name="priceCurrency" value="${esc(a0 ? a0.priceCurrency : '')}" required></label>
        </div>
        <div class="total-box"><span>مجموع ارزش معامله</span><b class="num" data-order-total>—</b></div>
        <div class="grid g2">
          <label class="field"><span>حداقل مقدار هر درخواست (اختیاری)</span><input class="input num" name="minAmount" inputmode="decimal" placeholder="مثلاً 5,000"></label>
          <label class="field"><span>مدت اعتبار سفارش</span>
            <select class="input" name="validHours"><option value="2">۲ ساعت</option><option value="6">۶ ساعت</option><option value="24" selected>۱ روز</option><option value="72">۳ روز</option><option value="168">۱ هفته</option><option value="0">تا زمان بستن دستی</option></select></label>
        </div>
        <label class="field"><span>توضیحات (اختیاری)</span><textarea class="input" name="note" placeholder="مثلاً: تحویل نقد در سرای شهزاده، دفتر شماره ۱۲"></textarea></label>
        <button class="btn btn-primary btn-lg btn-block">ثبت و انتشار سفارش</button>
      </form>
      <aside class="stack">
        <div class="card card-pad"><h3>نرخ عمومی بازار</h3><div id="ref-rate" class="muted small">یک دارایی انتخاب کنید</div></div>
        <div class="card card-pad"><h3>پیشنهادهای رقیب</h3><div id="ref-book" class="small"></div></div>
        <div class="notice small">این سایت فقط بستر معرفی پیشنهاد و ارتباط خریدار و فروشنده است؛ انتقال پول و تحویل دارایی بیرون از سایت انجام می‌شود.</div>
      </aside>
    </div>`;
  }
  function updateOrderAside() {
    const form = document.querySelector('[data-form="order"]'); if (!form) return;
    const aid = Number(form.assetId.value);
    const rt = view.rates.find((r) => r.assetId === aid);
    const rr = document.getElementById('ref-rate');
    if (rr) rr.innerHTML = rt ? `<div class="grid g2" style="gap:8px"><div>خرید<div class="num price" style="color:var(--buy)">${fmt(rt.buy)}</div></div><div>فروش<div class="num price" style="color:var(--sell)">${fmt(rt.sell)}</div></div></div><div class="muted small" style="margin-top:6px">به‌روزرسانی: ${ago(rt.updatedAt)}</div>` : 'نرخ عمومی ثبت نشده';
    const os = view.orders.filter((o) => o.status === 'active' && o.assetId === aid);
    const sells = os.filter((o) => o.side === 'sell').sort((a, b) => a.price - b.price).slice(0, 4);
    const buys = os.filter((o) => o.side === 'buy').sort((a, b) => b.price - a.price).slice(0, 4);
    const line = (o) => `<div class="row" style="justify-content:space-between;padding:4px 0;border-bottom:1px dashed var(--line)"><span>${sideBadge(o.side)} <span class="num">${fmt(o.remaining)}</span></span><b class="num">${fmt(o.price)}</b></div>`;
    const rb = document.getElementById('ref-book');
    if (rb) rb.innerHTML = os.length ? sells.map(line).join('') + buys.map(line).join('') : '<span class="muted">برای این دارایی پیشنهاد فعالی نیست</span>';
    const amt = Number(String(form.amount.value).replace(/,/g, '')), pr = Number(String(form.price.value).replace(/,/g, ''));
    const t = document.querySelector('[data-order-total]');
    if (t) t.textContent = amt > 0 && pr > 0 ? `${fmt(amt * pr, 2)} ${form.priceCurrency.value}` : '—';
  }

  /* ---------- order detail ---------- */
  function pageOrder(id) {
    const o = orderOf(id);
    if (!o) return gate('این سفارش پیدا نشد یا دیگر در دسترس نیست.', '<a class="btn" href="#market">بازگشت به بازار</a>');
    const a = asset(o.assetId);
    const mine = o.userId === me().id;
    const deals = view.deals.filter((d) => d.orderId === o.id);
    const accepted = deals.filter((d) => ['accepted', 'completed'].includes(d.status)).reduce((s, d) => s + d.acceptedAmount, 0);
    const pct = o.amount ? Math.round(((o.amount - o.remaining) / o.amount) * 100) : 0;
    const order = { pending: 0, accepted: 1, completed: 2, rejected: 3, cancelled: 4 };
    const sorted = deals.slice().sort((x, y) => order[x.status] - order[y.status] || y.createdAt - x.createdAt);
    const competitors = view.orders.filter((x) => x.status === 'active' && x.assetId === o.assetId && x.id !== o.id)
      .sort((x, y) => (x.side === y.side ? (x.side === 'sell' ? x.price - y.price : y.price - x.price) : x.side === o.side ? -1 : 1)).slice(0, 8);
    return `
    <div class="page-head"><div><h1>${o.side === 'sell' ? 'فروش' : 'خرید'} ${esc(a.name)} <span class="muted num" style="font-weight:400">#${o.id}</span></h1>
      <p>${orderBadge(o.status)} · ثبت ${ago(o.createdAt)} · ${left(o.expiresAt)}</p></div>
      <div class="row">${mine && ['active', 'filled'].includes(o.status) ? `<button class="btn" data-act="close-order" data-id="${o.id}">بستن سفارش</button>` : ''}
      ${!mine && o.status === 'active' ? actionCell(o).replace('btn-sm', 'btn-lg') : ''}</div></div>
    <div class="split">
      <div class="stack">
        <div class="card card-pad">
          <div class="grid g4">
            <div><span class="muted small">مقدار کل</span><div class="price">${qty(o)}</div></div>
            <div><span class="muted small">باقی‌مانده</span><div class="price" style="color:var(--blue)">${qty(o, o.remaining)}</div></div>
            <div><span class="muted small">نرخ</span><div class="price"><span class="num">${fmt(o.price)}</span> <span class="small muted">${esc(o.priceCurrency)}</span></div></div>
            <div><span class="muted small">ارزش کل</span><div class="price"><span class="num">${fmt(total(o), 2)}</span> <span class="small muted">${esc(o.priceCurrency)}</span></div></div>
          </div>
          <div style="margin-top:16px"><div class="row small muted" style="justify-content:space-between"><span>واگذارشده: <span class="num">${fmt(o.amount - o.remaining)}</span> ${esc(o.unit)}</span><span class="num">${pct}%</span></div><div class="progress"><i style="width:${pct}%"></i></div></div>
          <dl class="kv" style="margin-top:16px">
            <dt>${o.side === 'sell' ? 'فروشنده' : 'خریدار'}</dt><dd>${nameLink(o.userId)}</dd>
            ${o.minAmount ? `<dt>حداقل مقدار هر درخواست</dt><dd class="num">${fmt(o.minAmount)} ${esc(o.unit)}</dd>` : ''}
            <dt>زمان ثبت</dt><dd>${fmtDate(o.createdAt)}</dd>
            <dt>اعتبار</dt><dd>${o.expiresAt ? fmtDate(o.expiresAt) : 'تا زمان بستن دستی'}</dd>
            ${o.note ? `<dt>توضیحات</dt><dd>${esc(o.note)}</dd>` : ''}
          </dl>
        </div>
        <div class="card card-pad">
          <div class="row" style="margin-bottom:12px"><h2 style="margin:0">${mine ? 'درخواست‌های دریافتی' : 'درخواست‌های شما برای این سفارش'}</h2><span class="spacer"></span>
            ${mine ? `<span class="badge">${deals.filter((d) => d.status === 'pending').length} در انتظار</span><span class="badge blue">تأییدشده: <span class="num">${fmt(accepted)}</span></span>` : ''}</div>
          ${sorted.length ? sorted.map((d) => dealCard(d, o, mine)).join('') : emptyBox(mine ? 'هنوز درخواستی دریافت نکرده‌اید' : 'هنوز درخواستی نفرستاده‌اید')}
        </div>
      </div>
      <aside class="card card-pad">
        <h3>پیشنهادهای رقابتی ${esc(a.name)}</h3>
        <p class="muted small" style="margin-top:-6px">مقایسه با سایر پیشنهادهای فعال همین دارایی</p>
        ${competitors.length ? `<table class="data"><thead><tr><th>نوع</th><th>مقدار</th><th>نرخ</th></tr></thead><tbody>${competitors.map((x) => `<tr class="clickable" data-href="#order-${x.id}"><td>${sideBadge(x.side)}</td><td class="num">${fmt(x.remaining)}</td><td class="num"><b>${fmt(x.price)}</b> ${x.side === o.side ? (x.price === o.price ? '' : (o.side === 'sell' ? (x.price < o.price ? '<span class="chg down small">ارزان‌تر</span>' : '') : (x.price > o.price ? '<span class="chg up small">بالاتر</span>' : ''))) : ''}</td></tr>`).join('')}</tbody></table>` : emptyBox('پیشنهاد دیگری نیست')}
      </aside>
    </div>`;
  }
  function dealCard(d, o, mine) {
    const other = user(mine ? d.requesterId : d.ownerId);
    const maxAccept = Math.min(d.amount, o.remaining);
    return `<div class="req ${d.status}">
      <div class="row"><b>${mine ? nameLink(d.requesterId) : 'درخواست شما'}</b>${dealBadge(d.status)}<span class="spacer"></span><span class="muted small">${ago(d.createdAt)}</span></div>
      <div class="row small" style="margin-top:6px"><span>مقدار درخواستی: <b class="num">${fmt(d.amount)}</b> ${esc(o.unit)}</span>
        ${d.acceptedAmount ? `<span>· تأییدشده: <b class="num" style="color:var(--blue)">${fmt(d.acceptedAmount)}</b></span>` : ''}
        <span>· ارزش: <span class="num">${fmt((d.acceptedAmount || d.amount) * d.price, 2)}</span> ${esc(o.priceCurrency)}</span></div>
      ${d.note ? `<div class="small muted" style="margin-top:4px">💬 ${esc(d.note)}</div>` : ''}
      ${d.reason ? `<div class="small muted">دلیل: ${esc(d.reason)}</div>` : ''}
      ${mine && d.status === 'pending' && other && other.phone ? `<div class="small" style="margin-top:4px">تماس: <span class="num">${esc(other.phone)}</span></div>` : ''}
      <div class="row" style="margin-top:10px">
        ${mine && d.status === 'pending' ? (maxAccept > 0
          ? `<input class="input num" style="width:130px;padding:6px 10px" data-accept-amt="${d.id}" value="${maxAccept}" inputmode="decimal" aria-label="مقدار تأیید">
             <button class="btn btn-primary btn-sm" data-act="accept" data-id="${d.id}">${maxAccept < d.amount ? 'تأیید جزئی' : 'تأیید'}</button>`
          : '<span class="muted small">مقدار باقی‌مانده کافی نیست</span>') + `<button class="btn btn-sm" data-act="reject" data-id="${d.id}">رد</button>` : ''}
        ${!mine && d.status === 'pending' ? `<button class="btn btn-sm" data-act="withdraw" data-id="${d.id}">پس‌گرفتن درخواست</button>` : ''}
        ${['accepted', 'completed'].includes(d.status) ? `<a class="btn btn-sm" href="#deal-${d.id}">مشاهده معامله و گفتگو ←</a>` : ''}
      </div></div>`;
  }

  /* ---------- deal detail ---------- */
  function pageDeal(id) {
    const d = view.deals.find((x) => x.id === id);
    if (!d) return gate('این معامله پیدا نشد.', '<a class="btn" href="#dashboard">داشبورد</a>');
    const o = orderOf(d.orderId) || { unit: '', priceCurrency: '', side: 'sell', assetId: 0 };
    const a = asset(o.assetId);
    const m = me();
    const iAmOwner = d.ownerId === m.id, iAmReq = d.requesterId === m.id, party = iAmOwner || iAmReq;
    const sellerId = o.side === 'sell' ? d.ownerId : d.requesterId, buyerId = o.side === 'sell' ? d.requesterId : d.ownerId;
    const amt = d.acceptedAmount || d.amount;
    const myDone = iAmOwner ? d.ownerDone : d.requesterDone;
    const msgs = view.messages.filter((x) => x.dealId === d.id);
    const partyCard = (uid, role) => {
      const u = user(uid);
      if (!u) return '';
      return `<div class="card card-pad"><span class="muted small">${role}</span>
        <div style="font-weight:800;font-size:16px"><a href="#user-${u.id}">${esc(u.company)}</a> ${u.status === 'approved' ? ICON.check : ''}</div>
        <div class="muted small">${esc(u.name)} · ${E.ACTIVITIES[u.activity] || ''}</div>
        ${u.phone ? `<div class="row small" style="margin-top:8px"><span>📞 <span class="num">${esc(u.phone)}</span></span>
          ${u.whatsapp ? `<a class="badge ok" href="https://wa.me/${esc(u.whatsapp.replace(/^0/, '93').replace(/\D/g, ''))}" target="_blank" rel="noopener">${ICON.wa} واتس‌اپ <span class="num">${esc(u.whatsapp)}</span></a>` : ''}</div>`
          : `<div class="muted small" style="margin-top:8px">${d.status === 'pending' ? 'اطلاعات تماس پس از تأیید درخواست نمایش داده می‌شود' : 'این عضو اطلاعات تماس را مخفی کرده است'}</div>`}
      </div>`;
    };
    const steps = [
      ['ارسال درخواست', true, d.createdAt],
      ['تأیید صاحب سفارش', ['accepted', 'completed'].includes(d.status) || (d.status === 'cancelled' && d.acceptedAt), d.acceptedAt],
      ['اعلام تکمیل توسط فروشنده', (o.side === 'sell' ? d.ownerDone : d.requesterDone)],
      ['اعلام تکمیل توسط خریدار', (o.side === 'sell' ? d.requesterDone : d.ownerDone)],
      ['معامله نهایی شد', d.status === 'completed', d.completedAt],
    ];
    return `
    <div class="page-head"><div><h1>معامله #${d.id} — ${esc(a.name)}</h1><p>${dealBadge(d.status)} · سفارش <a href="#order-${d.orderId}">#${d.orderId}</a> · ${party ? (m.id === buyerId ? 'شما خریدار هستید' : 'شما فروشنده هستید') : 'نمای مدیر'}</p></div>
      <div class="row">
        ${party && d.status === 'pending' && iAmOwner ? `<button class="btn btn-primary" data-act="accept" data-id="${d.id}">تأیید</button><button class="btn" data-act="reject" data-id="${d.id}">رد</button>` : ''}
        ${party && d.status === 'pending' && iAmReq ? `<button class="btn" data-act="withdraw" data-id="${d.id}">پس‌گرفتن درخواست</button>` : ''}
        ${party && d.status === 'accepted' && !myDone ? `<button class="btn btn-buy" data-act="complete" data-id="${d.id}">✓ معامله انجام شد</button>` : ''}
        ${d.status === 'accepted' && (party || isAdmin()) ? `<button class="btn" data-act="cancel-deal" data-id="${d.id}">لغو معامله</button>` : ''}
      </div></div>
    ${party && d.status === 'accepted' && myDone ? '<div class="notice" style="margin-bottom:16px">شما تکمیل معامله را اعلام کرده‌اید. منتظر تأیید طرف مقابل هستیم.</div>' : ''}
    <div class="split">
      <div class="stack">
        <div class="card card-pad"><div class="grid g4">
          <div><span class="muted small">دارایی</span><div>${assetChip(a)}</div></div>
          <div><span class="muted small">مقدار ${d.acceptedAmount ? 'تأییدشده' : 'درخواستی'}</span><div class="price"><span class="num">${fmt(amt)}</span> <span class="small muted">${esc(o.unit)}</span></div>${d.acceptedAmount && d.acceptedAmount !== d.amount ? `<div class="muted small">از درخواست <span class="num">${fmt(d.amount)}</span></div>` : ''}</div>
          <div><span class="muted small">نرخ</span><div class="price"><span class="num">${fmt(d.price)}</span> <span class="small muted">${esc(o.priceCurrency)}</span></div></div>
          <div><span class="muted small">ارزش معامله</span><div class="price"><span class="num">${fmt(amt * d.price, 2)}</span> <span class="small muted">${esc(o.priceCurrency)}</span></div></div>
        </div>${d.note ? `<p class="small muted" style="margin:12px 0 0">💬 پیام درخواست: ${esc(d.note)}</p>` : ''}${d.reason ? `<p class="small muted" style="margin:6px 0 0">دلیل: ${esc(d.reason)}</p>` : ''}</div>
        <div class="grid g2">${partyCard(sellerId, 'فروشنده')}${partyCard(buyerId, 'خریدار')}</div>
        <div class="card card-pad">
          <h3>گفتگو</h3>
          <div class="chat">${msgs.length ? msgs.map((x) => `<div class="bubble ${x.userId === m.id ? 'mine' : ''}">${x.userId !== m.id ? `<b class="small">${esc((user(x.userId) || {}).company || '')}</b><br>` : ''}${esc(x.text)}<time>${ago(x.at)}</time></div>`).join('') : '<p class="muted small" style="text-align:center">هنوز پیامی رد و بدل نشده است.</p>'}</div>
          ${party && ['pending', 'accepted', 'completed'].includes(d.status) ? `<form class="row" data-form="message" data-id="${d.id}" style="margin-top:10px"><input class="input" name="text" placeholder="پیام خود را بنویسید…" style="flex:1" autocomplete="off" required><button class="btn btn-primary">ارسال</button></form>` : ''}
        </div>
      </div>
      <aside class="stack">
        <div class="card card-pad"><h3>مراحل معامله</h3><ul class="timeline">${steps.map(([t, done, at]) => `<li class="${done ? 'done' : ''}">${t}${done && at ? `<div class="muted small">${fmtDate(at)}</div>` : ''}</li>`).join('')}</ul>
          ${['rejected', 'cancelled'].includes(d.status) ? `<div class="notice warn small">این معامله ${E.DEAL_STATUS[d.status]} است.</div>` : ''}</div>
        ${party ? `<div class="card card-pad"><h3>مشکل دارید؟</h3><p class="muted small" style="margin-top:0">اگر طرف مقابل تخلف کرده است، به مدیر گزارش دهید.</p><button class="btn btn-sm" data-act="report" data-uid="${iAmOwner ? d.requesterId : d.ownerId}" data-deal="${d.id}">گزارش تخلف</button></div>` : ''}
        <div class="notice small">انتقال پول و تحویل دارایی بیرون از سایت و مستقیماً بین دو طرف انجام می‌شود. قبل از تحویل، هویت طرف مقابل را بررسی کنید.</div>
      </aside>
    </div>`;
  }

  /* ---------- dashboard ---------- */
  function pageDashboard(tab) {
    const m = me();
    const myOrders = view.orders.filter((o) => o.userId === m.id);
    const received = view.deals.filter((d) => d.ownerId === m.id);
    const sent = view.deals.filter((d) => d.requesterId === m.id);
    const mineDeals = view.deals.filter((d) => d.ownerId === m.id || d.requesterId === m.id);
    const activeDeals = mineDeals.filter((d) => d.status === 'accepted');
    const doneDeals = mineDeals.filter((d) => d.status === 'completed');
    const pendingIn = received.filter((d) => d.status === 'pending');
    const unread = view.notifications.filter((n) => !n.read).length;
    const tabs = [
      ['overview', 'نمای کلی'], ['orders', 'سفارش‌های من', myOrders.filter((o) => o.status === 'active').length],
      ['received', 'درخواست‌های دریافتی', pendingIn.length, true], ['sent', 'درخواست‌های ارسالی', sent.filter((d) => d.status === 'pending').length],
      ['active', 'در حال انجام', activeDeals.length], ['done', 'تکمیل‌شده', doneDeals.length],
      ['cancelled', 'لغوشده'], ['history', 'تاریخچه'], ['notifs', 'اعلان‌ها', unread, true],
    ];
    const tabBar = `<div class="tabs">${tabs.map(([k, l, c, hot]) => `<a href="#dashboard${k === 'overview' ? '' : '-' + k}" class="${tab === k ? 'on' : ''}">${l}${c ? `<span class="count ${hot ? 'hot' : ''}">${c}</span>` : ''}</a>`).join('')}</div>`;
    let body = '';
    const dealsList = (ds, emptyText) => ds.length ? dealsTable(ds) : emptyBox(emptyText);

    if (tab === 'overview') {
      const remaining = {};
      for (const o of myOrders.filter((x) => x.status === 'active')) {
        const k = `${o.assetId}|${o.side}`;
        remaining[k] = remaining[k] || { a: asset(o.assetId), side: o.side, unit: o.unit, amt: 0, total: 0 };
        remaining[k].amt += o.remaining; remaining[k].total += o.amount;
      }
      body = `
      <div class="grid g4" style="margin-bottom:18px">
        <div class="card tile sheen"><span>سفارش‌های فعال</span><b class="num" data-count="${myOrders.filter((o) => o.status === 'active').length}">${myOrders.filter((o) => o.status === 'active').length}</b></div>
        <div class="card tile sheen"><span>درخواست‌های منتظر پاسخ</span><b class="num" style="color:${pendingIn.length ? 'var(--sell)' : 'inherit'}" data-count="${pendingIn.length}">${pendingIn.length}</b></div>
        <div class="card tile sheen"><span>معاملات در حال انجام</span><b class="num" style="color:var(--blue)" data-count="${activeDeals.length}">${activeDeals.length}</b></div>
        <div class="card tile sheen"><span>معاملات تکمیل‌شده</span><b class="num" style="color:var(--buy)" data-count="${doneDeals.length}">${doneDeals.length}</b></div>
      </div>
      <div class="split">
        <div class="stack">
          <div class="card"><div class="row card-pad" style="padding-bottom:0"><h2 style="margin:0">درخواست‌های منتظر پاسخ شما</h2><span class="spacer"></span><a href="#dashboard-received" class="small">همه ←</a></div><div style="padding:12px">${pendingIn.length ? dealsTable(pendingIn.slice(0, 5)) : emptyBox('درخواست جدیدی ندارید')}</div></div>
          <div class="card"><div class="row card-pad" style="padding-bottom:0"><h2 style="margin:0">معاملات در حال انجام</h2></div><div style="padding:12px">${activeDeals.length ? dealsTable(activeDeals) : emptyBox('معامله در حال انجامی ندارید')}</div></div>
        </div>
        <aside class="stack">
          <div class="card card-pad"><h3>مقدار دارایی باقی‌مانده در سفارش‌ها</h3>
            ${Object.values(remaining).length ? Object.values(remaining).map((r) => `<div style="margin-bottom:12px"><div class="row small" style="justify-content:space-between"><span>${sideBadge(r.side)} ${esc(r.a.name)}</span><span><b class="num">${fmt(r.amt)}</b> / <span class="num">${fmt(r.total)}</span> ${esc(r.unit)}</span></div><div class="progress"><i style="width:${r.total ? Math.round((r.amt / r.total) * 100) : 0}%"></i></div></div>`).join('') : '<p class="muted small">سفارش فعالی ندارید.</p>'}
            ${approved() ? '<a class="btn btn-primary btn-block" href="#new">+ ثبت سفارش جدید</a>' : '<div class="notice warn small">برای ثبت سفارش، حساب شما باید توسط مدیر تأیید شود.</div>'}
          </div>
          <div class="card card-pad"><h3>آخرین اعلان‌ها</h3>${view.notifications.slice(0, 5).map((n) => `<div class="small" style="padding:6px 0;border-bottom:1px solid var(--line)">${esc(n.text)}<div class="muted" style="font-size:11px">${ago(n.at)}</div></div>`).join('') || '<p class="muted small">اعلانی نیست</p>'}</div>
        </aside>
      </div>`;
    } else if (tab === 'orders') {
      const live = (o) => ['active', 'filled'].includes(o.status);
      const sells = myOrders.filter((o) => o.side === 'sell' && live(o)).sort((a, b) => b.createdAt - a.createdAt);
      const buys = myOrders.filter((o) => o.side === 'buy' && live(o)).sort((a, b) => b.createdAt - a.createdAt);
      body = `<div class="stack">
        <div class="card"><div class="card-pad" style="padding-bottom:4px"><h2>سفارش‌های فروش من</h2></div>${ordersTable(sells, { noOwner: true, empty: 'سفارش فروش فعالی ندارید' })}</div>
        <div class="card"><div class="card-pad" style="padding-bottom:4px"><h2>سفارش‌های خرید من</h2></div>${ordersTable(buys, { noOwner: true, empty: 'سفارش خرید فعالی ندارید' })}</div></div>`;
    } else if (tab === 'received') body = `<div class="card" style="padding:12px">${dealsList(sortDeals(received), 'هنوز درخواستی دریافت نکرده‌اید')}</div>`;
    else if (tab === 'sent') body = `<div class="card" style="padding:12px">${dealsList(sortDeals(sent), 'هنوز درخواستی نفرستاده‌اید')}</div>`;
    else if (tab === 'active') body = `<div class="card" style="padding:12px">${dealsList(activeDeals, 'معامله در حال انجامی ندارید')}</div>`;
    else if (tab === 'done') body = `<div class="card" style="padding:12px">${dealsList(doneDeals, 'هنوز معامله‌ای تکمیل نشده است')}</div>`;
    else if (tab === 'cancelled') {
      const os = myOrders.filter((o) => ['cancelled', 'closed', 'expired'].includes(o.status));
      const ds = mineDeals.filter((d) => ['cancelled', 'rejected'].includes(d.status));
      body = `<div class="stack"><div class="card"><div class="card-pad" style="padding-bottom:4px"><h2>سفارش‌های لغوشده، بسته یا منقضی</h2></div>${ordersTable(os, { noOwner: true, empty: 'موردی نیست' })}</div>
        <div class="card" style="padding:12px"><h2 style="padding:8px">درخواست‌های ردشده یا لغوشده</h2>${dealsList(ds, 'موردی نیست')}</div></div>`;
    } else if (tab === 'history') {
      const rows = [...myOrders.map((o) => ({ at: o.createdAt, t: `ثبت سفارش ${o.side === 'sell' ? 'فروش' : 'خرید'} ${fmt(o.amount)} ${o.unit} ${asset(o.assetId).name} با نرخ ${fmt(o.price)}`, href: `#order-${o.id}`, b: orderBadge(o.status) })),
        ...mineDeals.map((d) => ({ at: d.updatedAt, t: `${d.ownerId === m.id ? 'درخواست دریافتی' : 'درخواست ارسالی'} — ${fmt(d.acceptedAmount || d.amount)} ${asset((orderOf(d.orderId) || {}).assetId).name} (سفارش #${d.orderId})`, href: `#deal-${d.id}`, b: dealBadge(d.status) }))]
        .sort((a, b) => b.at - a.at);
      body = `<div class="card">${rows.length ? `<table class="data responsive"><thead><tr><th>زمان</th><th>رویداد</th><th>وضعیت</th></tr></thead><tbody>${rows.map((r) => `<tr class="clickable" data-href="${r.href}"><td data-l="زمان" class="small">${fmtDate(r.at)}</td><td class="cell-main" data-l="">${esc(r.t)}</td><td data-l="وضعیت">${r.b}</td></tr>`).join('')}</tbody></table>` : emptyBox('تاریخچه‌ای نیست')}</div>`;
    } else if (tab === 'notifs') {
      body = `<div class="card">${view.notifications.some((n) => !n.read) ? '<div class="row card-pad" style="padding:10px 16px"><span class="spacer"></span><button class="btn btn-sm" data-act="read-all">علامت‌گذاری همه به‌عنوان خوانده‌شده</button></div>' : ''}
        ${view.notifications.length ? view.notifications.map((n) => `<div class="notif ${n.read ? '' : 'unread'}" data-act="open-notif" data-id="${n.id}" data-link="${esc(n.link)}">${esc(n.text)}<time>${fmtDate(n.at)}</time></div>`).join('') : emptyBox('اعلانی ندارید')}</div>`;
    }
    return `<div class="page-head"><div><h1>داشبورد ${esc(m.company)}</h1><p>${userBadge(m.status)} · ${E.ACTIVITIES[m.activity] || ''}</p></div>${approved() ? '<a class="btn btn-primary" href="#new">+ سفارش جدید</a>' : ''}</div>
      ${m.status !== 'approved' ? '<div class="notice warn" style="margin-bottom:16px">حساب شما منتظر تأیید مدیر سیستم است. تا آن زمان امکان ثبت سفارش و ارسال درخواست وجود ندارد.</div>' : ''}
      ${tabBar}${body}`;
  }
  const sortDeals = (ds) => ds.slice().sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.updatedAt - a.updatedAt);
  function dealsTable(ds) {
    const m = me();
    return `<div class="table-wrap"><table class="data responsive"><thead><tr><th>معامله</th><th>طرف مقابل</th><th>نقش شما</th><th>مقدار</th><th>نرخ</th><th>وضعیت</th><th></th></tr></thead><tbody>
    ${ds.map((d) => {
      const o = orderOf(d.orderId) || { unit: '', side: 'sell', priceCurrency: '' };
      const a = asset(o.assetId);
      const iOwn = d.ownerId === m.id;
      const iBuy = (o.side === 'sell') !== iOwn;
      const otherId = iOwn ? d.requesterId : d.ownerId;
      const roleTxt = !iOwn && d.requesterId !== m.id ? '—' : iBuy ? '<span class="badge buy">خریدار</span>' : '<span class="badge sell">فروشنده</span>';
      return `<tr class="clickable" data-href="#deal-${d.id}">
        <td class="cell-main" data-l="">${assetChip(a, `معامله #${d.id} · ${ago(d.createdAt)}`)}</td>
        <td data-l="طرف مقابل">${nameLink(otherId)}</td>
        <td data-l="نقش شما">${roleTxt}</td>
        <td data-l="مقدار"><span class="num">${fmt(d.acceptedAmount || d.amount)}</span> <span class="muted small">${esc(o.unit)}</span>${d.acceptedAmount && d.acceptedAmount !== d.amount ? `<div class="muted small">از <span class="num">${fmt(d.amount)}</span></div>` : ''}</td>
        <td data-l="نرخ" class="num">${fmt(d.price)}</td>
        <td data-l="وضعیت">${dealBadge(d.status)}</td>
        <td class="cell-act">${iOwn && d.status === 'pending' ? `<a class="btn btn-primary btn-sm" href="#order-${d.orderId}">بررسی</a>` : `<a class="btn btn-sm" href="#deal-${d.id}">جزئیات</a>`}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }

  /* ---------- profile ---------- */
  function pageProfile() {
    const m = me();
    return `<div class="page-head"><div><h1>پروفایل من</h1><p>${userBadge(m.status)} ${m.role === 'admin' ? '<span class="badge blue">مدیر سیستم</span>' : ''} · عضو از ${fmtDate(m.createdAt)}</p></div></div>
    <div class="split">
      <form class="card card-pad stack" data-form="profile">
        <h2>مشخصات</h2>
        <div class="grid g2">
          <label class="field"><span>نام و نام خانوادگی</span><input class="input" name="name" value="${esc(m.name)}" required></label>
          <label class="field"><span>نام صرافی یا شرکت</span><input class="input" name="company" value="${esc(m.company)}" required></label>
          <label class="field"><span>شماره تماس (قابل تغییر نیست)</span><input class="input num" value="${esc(m.phone)}" disabled></label>
          <label class="field"><span>شماره واتس‌اپ</span><input class="input num" name="whatsapp" value="${esc(m.whatsapp)}"></label>
        </div>
        <label class="field"><span>نوع فعالیت</span><select class="input" name="activity">${Object.entries(E.ACTIVITIES).map(([k, v]) => `<option value="${k}" ${m.activity === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>معرفی کوتاه (آدرس دفتر، ساعات کاری…)</span><textarea class="input" name="bio">${esc(m.bio)}</textarea></label>
        <label class="row small"><input type="checkbox" class="switch" name="showContact" ${m.showContact ? 'checked' : ''}> نمایش شماره تماس و واتس‌اپ به طرف معامله پس از تأیید درخواست</label>
        <button class="btn btn-primary">ذخیره تغییرات</button>
      </form>
      <aside class="stack">
        <div class="card card-pad"><h3>وضعیت حساب</h3>
          ${m.status === 'approved' ? `<p style="margin:0">${ICON.check} حساب شما تأیید شده است و نشان تأیید کنار نام شما نمایش داده می‌شود.</p>` : '<p class="muted" style="margin:0">حساب شما منتظر بررسی و تأیید مدیر است.</p>'}</div>
        <form class="card card-pad stack" data-form="password"><h3>تغییر رمز عبور</h3>
          <input class="input" type="password" name="current" placeholder="رمز فعلی" required autocomplete="current-password">
          <input class="input" type="password" name="next" placeholder="رمز جدید (حداقل ۶ حرف)" required autocomplete="new-password">
          <button class="btn">تغییر رمز</button></form>
      </aside>
    </div>`;
  }

  function pageUser(id) {
    const u = user(id);
    if (!u) return gate('این عضو پیدا نشد.');
    const os = view.orders.filter((o) => o.userId === u.id && o.status === 'active');
    const isMe = u.id === me().id;
    return `<div class="page-head"><div><h1>${esc(u.company)} ${u.status === 'approved' ? ICON.check : ''}</h1><p>${esc(u.name)} · ${E.ACTIVITIES[u.activity] || ''} · ${userBadge(u.status)} · عضو از ${fmtDate(u.createdAt)}</p></div>
      ${!isMe ? `<button class="btn btn-sm" data-act="report" data-uid="${u.id}">گزارش تخلف</button>` : ''}</div>
      ${u.bio ? `<div class="card card-pad" style="margin-bottom:16px">${esc(u.bio)}</div>` : ''}
      ${u.phone ? `<div class="notice" style="margin-bottom:16px">📞 <span class="num">${esc(u.phone)}</span> · واتس‌اپ <span class="num">${esc(u.whatsapp || '')}</span></div>` : ''}
      <div class="card"><div class="card-pad" style="padding-bottom:4px"><h2>سفارش‌های فعال</h2></div>${ordersTable(os, { noOwner: true, empty: 'سفارش فعالی ندارد' })}</div>`;
  }

  /* ---------- rates ---------- */
  function lineChart(points, { w = 640, h = 220, small = false } = {}) {
    if (points.length < 2) return '<p class="muted small">داده کافی برای نمودار نیست</p>';
    const vals = points.flatMap((p) => [p.buy, p.sell]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (lo === hi) { lo *= 0.99; hi *= 1.01; }
    const pad = small ? 2 : 28, padL = small ? 2 : 8;
    const t0 = points[0].at, t1 = points[points.length - 1].at;
    const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (w - padL - (small ? 2 : 60));
    const Y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (h - pad * 2);
    const path = (k) => points.map((p, i) => `${i ? 'L' : 'M'}${X(p.at).toFixed(1)},${Y(p[k]).toFixed(1)}`).join('');
    if (small) return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:${h}px;overflow:visible"><path d="${path('sell')}" fill="none" stroke="#3b82f6" stroke-width="2" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 4px rgba(59,130,246,.7))"/></svg>`;
    const ticks = [lo, (lo + hi) / 2, hi];
    const area = `${path('sell')}L${X(t1)},${h - pad}L${X(t0)},${h - pad}Z`;
    const xl = [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]];
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="نمودار تغییرات نرخ" style="direction:ltr">
      <defs><linearGradient id="ga" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#3b82f6" stop-opacity=".28"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map((v) => `<line x1="${padL}" x2="${w - 60}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(127,127,127,.18)" stroke-dasharray="3 4"/><text x="${w - 54}" y="${Y(v) + 4}" font-size="11" fill="#7a879c">${fmt(v, 4)}</text>`).join('')}
      <path d="${area}" fill="url(#ga)"/>
      <path d="${path('buy')}" fill="none" stroke="#2fd389" stroke-width="2" style="filter:drop-shadow(0 0 4px rgba(47,211,137,.6))"/>
      <path d="${path('sell')}" fill="none" stroke="#3b82f6" stroke-width="2.4" style="filter:drop-shadow(0 0 5px rgba(59,130,246,.7))"/>
      ${xl.map((p) => `<text x="${X(p.at)}" y="${h - 6}" font-size="11" fill="#7a879c" text-anchor="middle">${dayFmt.format(new Date(p.at))}</text>`).join('')}
    </svg>`;
  }
  function pageRates() {
    const rated = view.rates.map((r) => ({ r, a: asset(r.assetId) })).filter((x) => x.a.active !== false);
    if (!ui.rateAsset && rated.length) ui.rateAsset = rated[0].a.id;
    const sel = rated.find((x) => x.a.id === ui.rateAsset) || rated[0];
    const hist = sel ? view.rateHistory.filter((h) => h.assetId === sel.a.id) : [];
    const book = bookSummary(view.orders);
    return `<div class="page-head"><div><h1>نرخ‌های بازار</h1><p>نرخ عمومی بازار که توسط مدیر ثبت می‌شود — جدا از نرخ‌های پیشنهادی اعضا.</p></div>${isAdmin() ? '<a class="btn" href="#admin-rates">ثبت نرخ جدید</a>' : ''}</div>
    <div class="grid g4" style="margin-bottom:18px">
      ${rated.map(({ r, a }) => {
        const mid = (r.buy + r.sell) / 2, ch = r.prevMid ? ((mid - r.prevMid) / r.prevMid) * 100 : 0;
        const b = book.find((x) => x.a.id === a.id);
        return `<div class="card rate-card sheen ${sel && sel.a.id === a.id ? 'on' : ''}" data-act="rate-pick" data-id="${a.id}">
          <div class="row">${assetChip(a)}<span class="spacer"></span><span class="chg num small ${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch).toFixed(2)}%</span></div>
          <div class="rates"><div><span>خرید</span><b class="num">${fmt(r.buy)}</b></div><div><span>فروش</span><b class="num">${fmt(r.sell)}</b></div></div>
          <div class="chart">${lineChart(view.rateHistory.filter((h) => h.assetId === a.id).slice(-20), { w: 200, h: 34, small: true })}</div>
          <div class="row small muted" style="justify-content:space-between"><span>${esc(r.currency)} · ${ago(r.updatedAt)}</span>${b ? `<span>${b.n} پیشنهاد عضو</span>` : ''}</div>
        </div>`;
      }).join('')}
    </div>
    ${sel ? `<div class="split"><div class="card card-pad"><div class="row"><h2 style="margin:0">نمودار تغییرات ${esc(sel.a.name)}</h2><span class="spacer"></span><span class="small"><span style="color:var(--buy)">━ خرید</span> &nbsp; <span style="color:var(--blue-2)">━ فروش</span></span></div><div class="chart" style="margin-top:10px">${lineChart(hist.slice(-60))}</div></div>
      <aside class="card card-pad"><h3>جزئیات</h3><dl class="kv"><dt>نرخ خرید</dt><dd class="num">${fmt(sel.r.buy)} ${esc(sel.r.currency)}</dd><dt>نرخ فروش</dt><dd class="num">${fmt(sel.r.sell)} ${esc(sel.r.currency)}</dd><dt>آخرین به‌روزرسانی</dt><dd>${fmtDate(sel.r.updatedAt)}</dd>
        ${(() => { const b = book.find((x) => x.a.id === sel.a.id); return b ? `<dt>بهترین پیشنهاد خرید اعضا</dt><dd class="num" style="color:var(--buy)">${b.bid != null ? fmt(b.bid) : '—'}</dd><dt>بهترین پیشنهاد فروش اعضا</dt><dd class="num" style="color:var(--sell)">${b.ask != null ? fmt(b.ask) : '—'}</dd>` : ''; })()}</dl>
        <button class="btn btn-block" style="margin-top:14px" data-act="filter-asset" data-id="${sel.a.id}">مشاهده پیشنهادهای ${esc(sel.a.name)} در بازار</button></aside></div>` : emptyBox('نرخی ثبت نشده است')}`;
  }

  /* ---------- auth ---------- */
  function pageLogin() {
    if (me()) return gate(`شما با حساب «${esc(me().company)}» وارد شده‌اید.`, '<a class="btn btn-primary" href="#dashboard">رفتن به داشبورد</a>');
    return `<div class="auth-wrap"><form class="card card-pad stack" data-form="login">
      <h1 style="margin:0;font-size:22px">ورود به حساب</h1><p class="muted" style="margin:0">با شماره تماس و رمز عبور وارد شوید.</p>
      <label class="field"><span>شماره تماس</span><input class="input num" name="phone" inputmode="tel" placeholder="07xxxxxxxx" required autocomplete="username"></label>
      <label class="field"><span>رمز عبور</span><input class="input" type="password" name="password" required autocomplete="current-password"></label>
      <div class="form-error hidden"></div>
      <button class="btn btn-primary btn-lg">ورود</button>
      <p class="small muted" style="margin:0;text-align:center">حساب ندارید؟ <a href="#register">ثبت‌نام کنید</a></p>
      <div class="notice small">حساب‌های نمونه: مدیر <span class="num">0700000000</span> رمز <span class="num">admin123</span> — صراف <span class="num">0700000001</span> رمز <span class="num">123456</span> (اعضای دیگر: <span class="num">0700000002</span> تا <span class="num">0700000005</span>)</div>
    </form></div>`;
  }
  function pageRegister() {
    if (me()) return gate('شما وارد حساب خود شده‌اید.', '<a class="btn btn-primary" href="#dashboard">داشبورد</a>');
    return `<div class="auth-wrap" style="max-width:560px"><form class="card card-pad stack" data-form="register">
      <h1 style="margin:0;font-size:22px">عضویت در بازار سرای شهزاده</h1><p class="muted" style="margin:0">پس از ثبت‌نام، حساب شما توسط مدیر بررسی و تأیید می‌شود.</p>
      <div class="grid g2">
        <label class="field"><span>نام و نام خانوادگی</span><input class="input" name="name" required></label>
        <label class="field"><span>نام صرافی یا شرکت</span><input class="input" name="company" required></label>
        <label class="field"><span>شماره تماس</span><input class="input num" name="phone" inputmode="tel" placeholder="07xxxxxxxx" required></label>
        <label class="field"><span>شماره واتس‌اپ</span><input class="input num" name="whatsapp" inputmode="tel" placeholder="در صورت تفاوت"></label>
      </div>
      <label class="field"><span>نوع فعالیت</span><select class="input" name="activity" required><option value="">انتخاب کنید</option>${Object.entries(E.ACTIVITIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label class="field"><span>رمز عبور</span><input class="input" type="password" name="password" minlength="6" required autocomplete="new-password"></label>
      <div class="form-error hidden"></div>
      <button class="btn btn-primary btn-lg">ثبت‌نام</button>
      <p class="small muted" style="margin:0;text-align:center">قبلاً عضو شده‌اید؟ <a href="#login">وارد شوید</a></p>
    </form></div>`;
  }

  /* ---------- admin ---------- */
  function pageAdmin(tab) {
    const A = view.admin;
    const pendingUsers = A.users.filter((u) => u.status === 'pending').length;
    const openReports = A.reports.filter((r) => r.status === 'open').length;
    const tabs = [['overview', 'گزارش‌ها'], ['users', 'کاربران', pendingUsers], ['orders', 'سفارش‌ها'], ['deals', 'معاملات'], ['assets', 'دارایی‌ها'], ['rates', 'نرخ‌های عمومی'], ['reports', 'تخلفات', openReports], ['notify', 'اعلان عمومی'], ['audit', 'فعالیت‌ها']];
    const tabBar = `<div class="tabs">${tabs.map(([k, l, c]) => `<a href="#admin${k === 'overview' ? '' : '-' + k}" class="${tab === k ? 'on' : ''}">${l}${c ? `<span class="count hot">${c}</span>` : ''}</a>`).join('')}</div>`;
    let body = '';
    if (tab === 'overview') {
      const now = Date.now();
      const periods = [['امروز', 864e5], ['۷ روز اخیر', 7 * 864e5], ['۳۰ روز اخیر', 30 * 864e5]];
      const row = ([label, ms]) => {
        const os = view.orders.filter((o) => now - o.createdAt <= ms);
        const ds = view.deals.filter((d) => now - d.createdAt <= ms);
        const done = view.deals.filter((d) => d.status === 'completed' && now - (d.completedAt || d.updatedAt) <= ms);
        return `<tr><td class="cell-main" data-l=""><b>${label}</b></td><td data-l="سفارش جدید" class="num">${os.length}</td><td data-l="درخواست" class="num">${ds.length}</td><td data-l="تأییدشده" class="num">${ds.filter((d) => ['accepted', 'completed'].includes(d.status)).length}</td><td data-l="تکمیل‌شده" class="num">${done.length}</td></tr>`;
      };
      const vol = {};
      for (const d of view.deals.filter((x) => ['accepted', 'completed'].includes(x.status))) {
        const o = orderOf(d.orderId); if (!o) continue;
        const k = o.assetId; vol[k] = vol[k] || { a: asset(k), unit: o.unit, amt: 0, value: 0, cur: o.priceCurrency, n: 0 };
        vol[k].amt += d.acceptedAmount; vol[k].value += d.acceptedAmount * d.price; vol[k].n++;
      }
      body = `<div class="grid g4" style="margin-bottom:18px">
        <div class="card tile sheen"><span>کل کاربران</span><b class="num" data-count="${A.users.length}">${A.users.length}</b></div>
        <div class="card tile sheen"><span>منتظر تأیید</span><b class="num" style="color:var(--warn)" data-count="${pendingUsers}">${pendingUsers}</b></div>
        <div class="card tile sheen"><span>سفارش‌های فعال</span><b class="num" data-count="${view.stats.activeOrders}">${view.stats.activeOrders}</b></div>
        <div class="card tile sheen"><span>معاملات تکمیل‌شده</span><b class="num" style="color:var(--buy)" data-count="${view.stats.completedDeals}">${view.stats.completedDeals}</b></div></div>
        <div class="grid g2">
          <div class="card"><div class="card-pad" style="padding-bottom:4px"><h2>گزارش دوره‌ای</h2></div><table class="data responsive"><thead><tr><th>دوره</th><th>سفارش جدید</th><th>درخواست</th><th>تأییدشده</th><th>تکمیل‌شده</th></tr></thead><tbody>${periods.map(row).join('')}</tbody></table></div>
          <div class="card"><div class="card-pad" style="padding-bottom:4px"><h2>حجم معاملات تأییدشده به تفکیک دارایی</h2></div>${Object.values(vol).length ? `<table class="data responsive"><thead><tr><th>دارایی</th><th>تعداد</th><th>مقدار</th><th>ارزش</th></tr></thead><tbody>${Object.values(vol).map((v) => `<tr><td class="cell-main">${assetChip(v.a)}</td><td data-l="تعداد" class="num">${v.n}</td><td data-l="مقدار"><span class="num">${fmt(v.amt)}</span> ${esc(v.unit)}</td><td data-l="ارزش"><span class="num">${fmt(v.value, 0)}</span> ${esc(v.cur)}</td></tr>`).join('')}</tbody></table>` : emptyBox('هنوز معامله‌ای تأیید نشده')}</div>
        </div>`;
    } else if (tab === 'users') {
      const f = ui.adminUserFilter;
      const us = A.users.filter((u) => f === 'all' || u.status === f).sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || b.createdAt - a.createdAt);
      body = `<div class="card"><div class="row" style="padding:12px 14px;border-bottom:1px solid var(--line)"><div class="seg">${[['all', 'همه'], ['pending', 'منتظر تأیید'], ['approved', 'تأییدشده'], ['blocked', 'مسدود']].map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-act="user-filter" data-v="${k}">${l}</button>`).join('')}</div></div>
        <div class="table-wrap"><table class="data responsive"><thead><tr><th>عضو</th><th>تماس</th><th>فعالیت</th><th>وضعیت</th><th>نقش</th><th>عضویت</th><th>عملیات</th></tr></thead><tbody>
        ${us.map((u) => `<tr><td class="cell-main"><b>${esc(u.company)}</b><div class="muted small">${esc(u.name)}</div></td>
          <td data-l="تماس" class="num small">${esc(u.phone)}${u.whatsapp && u.whatsapp !== u.phone ? `<br>${esc(u.whatsapp)}` : ''}</td>
          <td data-l="فعالیت">${E.ACTIVITIES[u.activity] || ''}</td><td data-l="وضعیت">${userBadge(u.status)}</td>
          <td data-l="نقش">${u.role === 'admin' ? '<span class="badge blue">مدیر</span>' : 'عضو'}</td><td data-l="عضویت" class="small">${fmtDate(u.createdAt)}</td>
          <td class="cell-act"><div class="row">
            ${u.status !== 'approved' ? `<button class="btn btn-buy btn-sm" data-act="user-status" data-id="${u.id}" data-v="approved">تأیید</button>` : ''}
            ${u.status !== 'blocked' && u.id !== me().id ? `<button class="btn btn-sell btn-sm" data-act="user-status" data-id="${u.id}" data-v="blocked">مسدود</button>` : ''}
            ${u.id !== me().id ? `<button class="btn btn-sm" data-act="user-role" data-id="${u.id}" data-v="${u.role === 'admin' ? 'member' : 'admin'}">${u.role === 'admin' ? 'حذف مدیریت' : 'مدیر کن'}</button>` : ''}
          </div></td></tr>`).join('')}</tbody></table></div></div>`;
    } else if (tab === 'orders') {
      const os = view.orders.slice().sort((a, b) => b.createdAt - a.createdAt);
      body = `<div class="card"><div class="table-wrap"><table class="data responsive"><thead><tr><th>سفارش</th><th>عضو</th><th>نوع</th><th>مقدار / باقی</th><th>نرخ</th><th>وضعیت</th><th></th></tr></thead><tbody>
        ${os.map((o) => `<tr><td class="cell-main">${assetChip(asset(o.assetId), `#${o.id} · ${fmtDate(o.createdAt)}`)}</td><td data-l="عضو">${nameLink(o.userId)}</td><td data-l="نوع">${sideBadge(o.side)}</td>
          <td data-l="مقدار / باقی"><span class="num">${fmt(o.amount)}</span> / <span class="num">${fmt(o.remaining)}</span> ${esc(o.unit)}</td><td data-l="نرخ" class="num">${fmt(o.price)}</td><td data-l="وضعیت">${orderBadge(o.status)}</td>
          <td class="cell-act"><div class="row"><a class="btn btn-sm" href="#order-${o.id}">جزئیات</a>${['active', 'filled'].includes(o.status) ? `<button class="btn btn-sm" data-act="close-order" data-id="${o.id}">بستن</button>` : ''}</div></td></tr>`).join('')}
        </tbody></table></div></div>`;
    } else if (tab === 'deals') {
      const ds = view.deals.slice().sort((a, b) => b.updatedAt - a.updatedAt);
      body = `<div class="card">${ds.length ? `<div class="table-wrap"><table class="data responsive"><thead><tr><th>معامله</th><th>صاحب سفارش</th><th>درخواست‌دهنده</th><th>مقدار</th><th>نرخ</th><th>وضعیت</th><th></th></tr></thead><tbody>
        ${ds.map((d) => { const o = orderOf(d.orderId) || {}; return `<tr class="clickable" data-href="#deal-${d.id}"><td class="cell-main">${assetChip(asset(o.assetId), `#${d.id} · ${fmtDate(d.createdAt)}`)}</td><td data-l="صاحب سفارش">${nameLink(d.ownerId)}</td><td data-l="درخواست‌دهنده">${nameLink(d.requesterId)}</td>
          <td data-l="مقدار" class="num">${fmt(d.acceptedAmount || d.amount)}</td><td data-l="نرخ" class="num">${fmt(d.price)}</td><td data-l="وضعیت">${dealBadge(d.status)}</td><td class="cell-act"><a class="btn btn-sm" href="#deal-${d.id}">جزئیات</a></td></tr>`; }).join('')}
        </tbody></table></div>` : emptyBox('معامله‌ای نیست')}</div>`;
    } else if (tab === 'assets') {
      body = `<div class="split"><div class="card"><table class="data responsive"><thead><tr><th>دارایی</th><th>واحد مقدار</th><th>واحد قیمت</th><th>وضعیت</th><th></th></tr></thead><tbody>
        ${view.assets.map((a) => `<tr><td class="cell-main">${assetChip(a)}</td><td data-l="واحد مقدار">${esc(a.unit)}</td><td data-l="واحد قیمت">${esc(a.priceCurrency)}</td><td data-l="وضعیت">${a.active ? '<span class="badge ok">فعال</span>' : '<span class="badge">غیرفعال</span>'}</td>
          <td class="cell-act"><div class="row"><button class="btn btn-sm" data-act="asset-edit" data-id="${a.id}">ویرایش</button><button class="btn btn-sm" data-act="asset-toggle" data-id="${a.id}">${a.active ? 'غیرفعال' : 'فعال'}</button></div></td></tr>`).join('')}</tbody></table></div>
        <form class="card card-pad stack" data-form="asset"><h3>افزودن دارایی جدید</h3><input type="hidden" name="id">
          <div class="grid g2"><label class="field"><span>کد (مثلاً SAR)</span><input class="input ltr" name="code" required></label><label class="field"><span>نام</span><input class="input" name="name" placeholder="ریال سعودی" required></label>
          <label class="field"><span>واحد مقدار</span><input class="input" name="unit" placeholder="SAR / KG / OZ" required></label><label class="field"><span>واحد قیمت</span><input class="input" name="priceCurrency" value="AFN" required></label></div>
          <label class="field"><span>نوع</span><select class="input" name="kind"><option value="currency">ارز</option><option value="metal">فلز / کالا</option></select></label>
          <button class="btn btn-primary">ذخیره دارایی</button></form></div>`;
    } else if (tab === 'rates') {
      body = `<div class="card"><table class="data responsive"><thead><tr><th>دارایی</th><th>نرخ فعلی (خرید / فروش)</th><th>به‌روزرسانی</th><th>نرخ جدید</th></tr></thead><tbody>
        ${view.assets.filter((a) => a.active).map((a) => { const r = view.rates.find((x) => x.assetId === a.id); return `<tr><td class="cell-main">${assetChip(a)}</td><td data-l="نرخ فعلی" class="num">${r ? `${fmt(r.buy)} / ${fmt(r.sell)}` : '—'}</td><td data-l="به‌روزرسانی" class="small">${r ? ago(r.updatedAt) : '—'}</td>
          <td class="cell-act"><form class="row" data-form="rate" data-id="${a.id}"><input class="input num" name="buy" placeholder="خرید" value="${r ? r.buy : ''}" style="width:110px;padding:6px 10px" inputmode="decimal" required><input class="input num" name="sell" placeholder="فروش" value="${r ? r.sell : ''}" style="width:110px;padding:6px 10px" inputmode="decimal" required><button class="btn btn-primary btn-sm">ثبت</button></form></td></tr>`; }).join('')}
        </tbody></table></div>`;
    } else if (tab === 'reports') {
      body = `<div class="card">${A.reports.length ? A.reports.slice().reverse().map((r) => `<div class="req ${r.status === 'open' ? 'pending' : 'completed'}" style="margin:12px">
        <div class="row"><b>گزارش درباره ${nameLink(r.userId)}</b>${r.status === 'open' ? '<span class="badge warn">باز</span>' : '<span class="badge ok">رسیدگی‌شده</span>'}<span class="spacer"></span><span class="muted small">${fmtDate(r.createdAt)}</span></div>
        <div class="small muted">گزارش‌دهنده: ${nameLink(r.reporterId)} ${r.dealId ? `· <a href="#deal-${r.dealId}">معامله #${r.dealId}</a>` : ''}</div>
        <p style="margin:6px 0">${esc(r.reason)}</p>${r.note ? `<div class="small muted">یادداشت مدیر: ${esc(r.note)}</div>` : ''}
        ${r.status === 'open' ? `<div class="row"><button class="btn btn-sm" data-act="resolve-report" data-id="${r.id}">رسیدگی شد</button><button class="btn btn-sell btn-sm" data-act="user-status" data-id="${r.userId}" data-v="blocked">مسدودکردن کاربر</button></div>` : ''}</div>`).join('') : emptyBox('گزارشی ثبت نشده است')}</div>`;
    } else if (tab === 'notify') {
      body = `<form class="card card-pad stack" data-form="broadcast" style="max-width:640px"><h3>ارسال اعلان به همه اعضای تأییدشده</h3>
        <textarea class="input" name="text" placeholder="مثلاً: بازار روز جمعه تعطیل است." required></textarea><button class="btn btn-primary">ارسال اعلان</button></form>`;
    } else if (tab === 'audit') {
      body = `<div class="notice ${A.auditIntact ? '' : 'warn'}" style="margin-bottom:12px">${A.auditIntact ? '✓ زنجیره تاریخچه رویدادها سالم است؛ هیچ رویدادی تغییر نکرده یا حذف نشده است.' : '⚠ هشدار: زنجیره تاریخچه رویدادها ناسازگار است.'}</div>
        <div class="card"><table class="data responsive"><thead><tr><th>زمان</th><th>کاربر</th><th>رویداد</th><th>جزئیات</th><th>هش</th></tr></thead><tbody>
        ${A.audit.map((e) => `<tr><td data-l="زمان" class="small">${fmtDate(e.at)}</td><td data-l="کاربر">${e.actorId ? esc((user(e.actorId) || {}).company || '#' + e.actorId) : '<span class="muted">سیستم</span>'}</td><td class="cell-main ltr small" data-l="">${esc(e.type)} ${e.ref ? `<span class="muted">${esc(e.ref)}</span>` : ''}</td><td data-l="جزئیات" class="small">${esc(e.detail)}</td><td data-l="هش" class="ltr muted small">${esc(e.hash.slice(0, 10))}</td></tr>`).join('')}
        </tbody></table></div>`;
    }
    return `<div class="page-head"><div><h1>پنل مدیریت</h1><p>کنترل کاربران، سفارش‌ها، دارایی‌ها و نرخ‌ها</p></div></div>${tabBar}${body}`;
  }

  /* =========================================================
     Events
     ========================================================= */
  function afterRender() {
    if (route() === 'market') renderMarketTable();
    if (route() === 'new') updateOrderAside();
  }
  const formData = (form) => Object.fromEntries(new FormData(form).entries());

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
    switch (a) {
      case 'close-modal': closeModal(); break;
      case 'toggle-menu': ui.menuOpen = !ui.menuOpen; render(); break;
      case 'theme': {
        const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        document.documentElement.dataset.theme = next; store.set('sarai-theme', next); render(); break;
      }
      case 'toggle-notifs': ui.notifOpen = !ui.notifOpen; render(); break;
      case 'read-all': await act('notifications.read', {}); break;
      case 'open-notif': ui.notifOpen = false; await backend.action('notifications.read', { id: nid }).catch(() => {}); await refresh(); if (t.dataset.link) location.hash = t.dataset.link; render(); break;
      case 'logout': await backend.logout(); await refresh(); location.hash = '#home'; render(); toast('از حساب خارج شدید'); break;
      case 'demo-reset': LocalBackend.reset(); await refresh(); location.hash = '#home'; render(); toast('اطلاعات نمونه بازنشانی شد'); break;
      case 'request': openRequest(nid); break;
      case 'fill-amt': { const f = t.closest('form'); f.amount.value = t.dataset.v; f.amount.dispatchEvent(new Event('input', { bubbles: true })); break; }
      case 'side': ui.side = t.dataset.v; document.querySelectorAll('.side-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.v === ui.side)); break;
      case 'filter-asset': ui.filters = { ...ui.filters, asset: String(nid) }; location.hash = '#market'; render(); break;
      case 'clear-filters': ui.filters = { asset: '', side: '', min: '', max: '', minAmount: '', q: '', sort: ui.filters.sort }; render(); break;
      case 'rate-pick': ui.rateAsset = nid; render(); break;
      case 'accept': {
        const inp = document.querySelector(`[data-accept-amt="${nid}"]`);
        await act('deal.accept', { dealId: nid, amount: inp ? inp.value : undefined }, 'درخواست تأیید شد؛ ارتباط با طرف مقابل برقرار است').catch(() => {});
        break;
      }
      case 'reject':
        modal('رد درخواست', `<form data-form="reject" data-id="${nid}" class="stack"><label class="field"><span>دلیل (اختیاری)</span><input class="input" name="reason" placeholder="مثلاً: مقدار کافی نیست"></label><button class="btn btn-sell btn-block">رد درخواست</button></form>`);
        break;
      case 'withdraw': await act('deal.withdraw', { dealId: nid }, 'درخواست پس گرفته شد').catch(() => {}); break;
      case 'complete': await act('deal.complete', { dealId: nid }, 'تکمیل معامله از طرف شما ثبت شد').catch(() => {}); break;
      case 'cancel-deal':
        modal('لغو معامله', `<form data-form="cancel-deal" data-id="${nid}" class="stack"><p class="muted" style="margin:0">با لغو معامله، مقدار تأییدشده به سفارش برمی‌گردد.</p><label class="field"><span>دلیل لغو</span><input class="input" name="reason" required></label><button class="btn btn-sell btn-block">لغو معامله</button></form>`);
        break;
      case 'close-order':
        modal('بستن سفارش', `<form data-form="close-order" data-id="${nid}" class="stack"><p style="margin:0">سفارش #${nid} بسته می‌شود و درخواست‌های در انتظار آن رد خواهند شد. معاملات در حال انجام ادامه پیدا می‌کنند.</p><button class="btn btn-sell btn-block">بستن سفارش</button></form>`);
        break;
      case 'report':
        modal('گزارش تخلف', `<form data-form="report" data-uid="${t.dataset.uid}" data-deal="${t.dataset.deal || ''}" class="stack"><label class="field"><span>شرح مشکل</span><textarea class="input" name="reason" required placeholder="چه اتفاقی افتاد؟"></textarea></label><button class="btn btn-sell btn-block">ارسال گزارش به مدیر</button></form>`);
        break;
      case 'user-filter': ui.adminUserFilter = t.dataset.v; render(); break;
      case 'user-status': await act('admin.user.setStatus', { userId: nid, status: t.dataset.v }, 'وضعیت کاربر به‌روز شد').catch(() => {}); break;
      case 'user-role': await act('admin.user.setRole', { userId: nid, role: t.dataset.v }, 'نقش کاربر تغییر کرد').catch(() => {}); break;
      case 'asset-toggle': await act('admin.asset.toggle', { assetId: nid }).catch(() => {}); break;
      case 'asset-edit': {
        const as = asset(nid); const f = document.querySelector('[data-form="asset"]');
        ['id', 'code', 'name', 'unit', 'priceCurrency', 'kind'].forEach((k) => { f[k].value = as[k]; });
        f.querySelector('h3').textContent = `ویرایش ${as.name}`; f.code.focus(); break;
      }
      case 'resolve-report': await act('admin.report.resolve', { reportId: nid }, 'گزارش بسته شد').catch(() => {}); break;
      default: break;
    }
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-form]'); if (!f) return;
    e.preventDefault();
    const d = formData(f), id = Number(f.dataset.id);
    const btn = f.querySelector('button:not([type="button"])'); if (btn) btn.disabled = true;
    const showErr = (msg) => { const el = f.querySelector('.form-error'); if (el) { el.textContent = msg; el.classList.remove('hidden'); } else toast(msg, true); };
    try {
      switch (f.dataset.form) {
        case 'login': await backend.login(d); await refresh(); location.hash = '#dashboard'; render(); toast(`خوش آمدید، ${view.me.company}`); break;
        case 'register': await backend.register(d); await refresh(); location.hash = view.me.status === 'approved' ? '#dashboard' : '#profile'; render(); toast('ثبت‌نام انجام شد'); break;
        case 'order': {
          const r = await backend.action('order.create', { ...d, side: ui.side });
          await refresh(); location.hash = `#order-${r.orderId}`; render(); toast('سفارش شما در بازار منتشر شد'); break;
        }
        case 'request': {
          const r = await backend.action('deal.request', { orderId: id, amount: d.amount, note: d.note });
          await refresh(); closeModal(); location.hash = `#deal-${r.dealId}`; render(); toast('درخواست ارسال شد؛ منتظر تأیید طرف مقابل باشید'); break;
        }
        case 'reject': await act('deal.reject', { dealId: id, reason: d.reason }, 'درخواست رد شد'); break;
        case 'cancel-deal': await act('deal.cancel', { dealId: id, reason: d.reason }, 'معامله لغو شد'); break;
        case 'close-order': await act('order.cancel', { orderId: id }, 'سفارش بسته شد'); break;
        case 'message': await act('message.send', { dealId: id, text: d.text }); document.querySelector('[data-form="message"] input')?.focus(); break;
        case 'report': await act('report.create', { userId: Number(f.dataset.uid), dealId: f.dataset.deal || null, reason: d.reason }, 'گزارش برای مدیر ارسال شد'); break;
        case 'profile': await act('profile.update', { ...d, showContact: !!f.showContact.checked }, 'پروفایل ذخیره شد'); break;
        case 'password': await backend.changePassword(d.current, d.next); f.reset(); toast('رمز عبور تغییر کرد'); break;
        case 'asset': await act('admin.asset.save', { ...d, id: d.id ? Number(d.id) : undefined }, 'دارایی ذخیره شد'); break;
        case 'rate': await act('admin.rate.set', { assetId: id, buy: d.buy, sell: d.sell }, 'نرخ ثبت شد'); break;
        case 'broadcast': await act('admin.broadcast', d, 'اعلان برای همه اعضا ارسال شد'); break;
        default: break;
      }
    } catch (err) { showErr(err.message); } finally { if (btn && btn.isConnected) btn.disabled = false; }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.filter) {
      ui.filters[t.dataset.filter] = t.value;
      if (t.dataset.filter === 'sort' || t.tagName === 'SELECT') render(); else renderMarketTable();
      return;
    }
    if (t.dataset.calc) {
      const el = t.closest('form').querySelector('[data-total]');
      const v = Number(String(t.value).replace(/,/g, '')) * Number(t.dataset.calc);
      const o = orderOf(Number(t.closest('form').dataset.id));
      if (el) el.textContent = v > 0 ? `${fmt(v, 2)} ${o ? o.priceCurrency : ''}` : '—';
    }
    if (t.closest('[data-form="order"]')) updateOrderAside();
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.change === 'asset-pick') {
      const opt = t.selectedOptions[0]; const f = t.form;
      f.unit.value = opt.dataset.unit; f.priceCurrency.value = opt.dataset.cur; updateOrderAside();
    }
    if (t.dataset.change === 'demo-switch') {
      LocalBackend.setUid(Number(t.value) || null); await refresh(); render();
      if (view.me) toast(`اکنون به‌عنوان «${view.me.company}» وارد شده‌اید`);
    }
  });
  window.addEventListener('hashchange', () => { ui.menuOpen = false; ui.notifOpen = false; closeModal(); render(); });
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
    await refresh();
    backend.subscribe((v) => { if (v !== view.version) onRemoteChange(); });
    render();
  })().catch((e) => { $app.innerHTML = `<div style="padding:40px;text-align:center">خطا در بارگذاری: ${esc(e.message)}</div>`; });
})();
