/*
 * Shahzada Sarai — trading engine.
 * Shared by the Node server (SQLite store) and the browser demo (memory store).
 * All business rules live here. The engine talks to storage only through the store interface:
 *   get(kind, id) · put(kind, obj) · find(kind, where, { order, limit, offset }) · count(kind, where)
 *   one(kind, where) · nextId(kind) · meta(key[, value])
 * where: { field: value | null | { in, ne, lt, lte, gt, gte, like } , $or: [where, ...] }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SaraiEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ACTIVITIES = { saraf: 'صراف', zargar: 'زرگر', tajer: 'تاجر', other: 'سایر' };
  const ORDER_STATUS = { active: 'فعال', filled: 'تکمیل', closed: 'بسته', cancelled: 'لغو', expired: 'منقضی' };
  const DEAL_STATUS = { pending: 'در انتظار پاسخ', accepted: 'در حال اجرا', rejected: 'رد شده', cancelled: 'لغو شده', completed: 'تکمیل شده' };
  const USER_STATUS = { pending: 'در انتظار بررسی', approved: 'تأیید شده', rejected: 'رد شده', blocked: 'مسدود' };
  const PROVINCES = ['کابل', 'هرات', 'بلخ', 'قندهار', 'ننگرهار', 'کندز', 'غزنی', 'بامیان', 'بدخشان', 'تخار', 'بغلان', 'پروان', 'لوگر', 'میدان وردک', 'پکتیا', 'خوست', 'هلمند', 'فراه', 'نیمروز', 'جوزجان', 'فاریاب', 'سمنگان', 'سرپل', 'بادغیس', 'غور', 'دایکندی', 'ارزگان', 'زابل', 'پکتیکا', 'کنر', 'لغمان', 'نورستان', 'کاپیسا', 'پنجشیر'];
  const RATE_GUARD = 0.15; // official rate changes larger than 15% need explicit confirmation
  const LIMITS = { marketOrders: 400, myOrders: 200, deals: 300, notifications: 60, rateHistory: 600, adminUsers: 200 };

  class EngineError extends Error {
    constructor(message, code) { super(message); this.code = code || 'bad_request'; }
  }
  const fail = (msg, code) => { throw new EngineError(msg, code); };

  /* ---------- value helpers ---------- */
  const round = (n, d = 6) => Math.round(Number(n) * 10 ** d) / 10 ** d;
  const toLatinDigits = (s) => String(s == null ? '' : s)
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const num = (v, label, { max = 1e13 } = {}) => {
    const n = Number(toLatinDigits(v).replace(/[,٬\s]/g, ''));
    if (!isFinite(n) || n <= 0) fail(`${label} باید عدد مثبت باشد.`);
    if (n > max) fail(`${label} بیش از حد مجاز است.`);
    return round(n);
  };
  const str = (v, label, { required = true, max = 200 } = {}) => {
    const s = (v == null ? '' : String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (required && !s) fail(`${label} الزامی است.`);
    if (s.length > max) fail(`${label} بیش از حد طولانی است.`);
    return s;
  };
  const normPhone = (p) => toLatinDigits(p).replace(/[^\d+]/g, '').slice(0, 16);
  const displayName = (u) => (u ? (u.company || u.name) : '—');
  const fmtN = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });

  // Tamper-evidence hash for the audit chain (not used for secrets).
  function chainHash(input) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < input.length; i++) {
      const ch = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }

  /* =========================================================
     Memory store (browser demo and tests)
     ========================================================= */
  function matchWhere(o, where) {
    for (const k of Object.keys(where || {})) {
      const c = where[k];
      if (k === '$or') { if (!c.some((w) => matchWhere(o, w))) return false; continue; }
      const v = o[k] === undefined ? null : o[k];
      if (c === null) { if (v !== null) return false; continue; }
      if (typeof c !== 'object') { if (v !== c) return false; continue; }
      if ('in' in c && !c.in.includes(v)) return false;
      if ('ne' in c && v === c.ne) return false;
      if ('lt' in c && !(v !== null && v < c.lt)) return false;
      if ('lte' in c && !(v !== null && v <= c.lte)) return false;
      if ('gt' in c && !(v !== null && v > c.gt)) return false;
      if ('gte' in c && !(v !== null && v >= c.gte)) return false;
      if ('like' in c && !String(v == null ? '' : v).includes(c.like)) return false;
    }
    return true;
  }
  function sorter(order) {
    if (!order) return (a, b) => a.id - b.id;
    const desc = order.startsWith('-'), f = desc ? order.slice(1) : order;
    return (a, b) => {
      const x = a[f] == null ? -Infinity : a[f], y = b[f] == null ? -Infinity : b[f];
      return (x < y ? -1 : x > y ? 1 : a.id - b.id) * (desc ? -1 : 1);
    };
  }
  function MemoryStore(data) {
    const d = data || { seq: {}, meta: {}, t: {} };
    const tbl = (k) => (d.t[k] = d.t[k] || {});
    const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
    return {
      kind: 'memory',
      get: (k, id) => clone(tbl(k)[id]),
      put(k, o) { if (o.id == null) o.id = this.nextId(k); tbl(k)[o.id] = clone(o); return o; },
      find(k, where, { order, limit, offset = 0 } = {}) {
        const rows = Object.values(tbl(k)).filter((o) => matchWhere(o, where)).sort(sorter(order));
        return clone(rows.slice(offset, limit != null ? offset + limit : undefined));
      },
      count: (k, where) => Object.values(tbl(k)).filter((o) => matchWhere(o, where)).length,
      one(k, where) { return this.find(k, where, { limit: 1 })[0] || null; },
      nextId: (k) => (d.seq[k] = (d.seq[k] || 0) + 1),
      meta(key, value) { if (value === undefined) return d.meta[key]; d.meta[key] = value; return value; },
      tx(fn) { const snap = JSON.stringify(d); try { return fn(); } catch (e) { const r = JSON.parse(snap); Object.keys(d).forEach((x) => delete d[x]); Object.assign(d, r); throw e; } },
      dump: () => d,
    };
  }

  /* =========================================================
     Shared internals
     ========================================================= */
  function audit(S, ctx, actorId, type, ref, detail) {
    const prev = S.meta('auditHead') || 'genesis';
    const entry = { id: S.nextId('audit'), at: ctx.now, actorId: actorId || null, type, ref: ref || null, detail: String(detail || '').slice(0, 300), prev };
    entry.hash = chainHash(prev + JSON.stringify(entry));
    S.put('audit', entry);
    S.meta('auditHead', entry.hash);
  }
  function notify(S, ctx, userId, text, link) {
    S.put('notifications', { userId, text, link: link || '', read: false, at: ctx.now });
    (ctx.touched = ctx.touched || new Set()).add(userId);
  }
  function notifyAdmins(S, ctx, text, link) {
    S.find('users', { role: 'admin', status: 'approved' }).forEach((a) => notify(S, ctx, a.id, text, link));
  }
  const market = (ctx) => { ctx.market = true; };
  const assetOf = (S, id) => S.get('assets', Number(id));

  function sweep(S, ctx) {
    const due = S.find('orders', { status: 'active', expiresAt: { lte: ctx.now } }, { limit: 500 });
    for (const o of due) {
      o.status = 'expired'; o.updatedAt = ctx.now; S.put('orders', o);
      for (const d of S.find('deals', { orderId: o.id, status: 'pending' })) {
        d.status = 'rejected'; d.updatedAt = ctx.now; d.reason = 'اعتبار سفارش به پایان رسید.'; S.put('deals', d);
        notify(S, ctx, d.requesterId, `اعتبار سفارش #${o.id} به پایان رسید؛ درخواست شما بسته شد.`, '#dashboard-sent');
      }
      notify(S, ctx, o.userId, `اعتبار سفارش #${o.id} به پایان رسید.`, '#dashboard-orders');
      audit(S, ctx, null, 'order.expired', `order:${o.id}`, '');
      market(ctx);
    }
    return due.length > 0;
  }

  function kycFields(p, { requireAll = true } = {}) {
    const province = str(p.province, 'ولایت', { required: requireAll, max: 30 });
    if (province && !PROVINCES.includes(province)) fail('ولایت را از فهرست انتخاب کنید.');
    return {
      province,
      city: str(p.city, 'شهر / ولسوالی', { required: false, max: 40 }),
      address: str(p.address, 'آدرس دفتر', { required: requireAll, max: 200 }),
      experience: str(p.experience, 'سابقه کار', { required: false, max: 40 }),
      licenseNo: str(p.licenseNo, 'شماره جواز', { required: false, max: 40 }),
      guarantorName: str(p.guarantorName, 'نام ضامن', { required: false, max: 80 }),
      guarantorPhone: normPhone(p.guarantorPhone),
      about: str(p.about, 'توضیحات', { required: false, max: 500 }),
    };
  }

  /* ---------- auth (hashing is injected by the host) ---------- */
  function register(S, input, ctx, { hashPassword, minPassword = 8, firstIsAdmin = false }) {
    const name = str(input.name, 'نام و تخلص', { max: 80 });
    const phone = normPhone(input.phone);
    if (!/^\+?\d{9,15}$/.test(phone)) fail('شماره تماس معتبر نیست.');
    const whatsapp = normPhone(input.whatsapp) || phone;
    const company = str(input.company, 'نام صرافی / شرکت', { max: 80 });
    const activity = ACTIVITIES[input.activity] ? input.activity : fail('نوع فعالیت را انتخاب کنید.');
    const password = String(input.password || '');
    if (password.length < minPassword) fail(`رمز عبور باید حداقل ${minPassword} حرف باشد.`);
    if (S.one('users', { phone })) fail('این شماره قبلاً ثبت شده است.', 'conflict');
    const isFirst = firstIsAdmin && S.count('users', {}) === 0;
    const kyc = kycFields(input, { requireAll: !isFirst });
    const user = S.put('users', {
      name, phone, whatsapp, company, activity, role: isFirst ? 'admin' : 'member', status: isFirst ? 'approved' : 'pending',
      showContact: true, bio: '', createdAt: ctx.now, passHash: hashPassword(password), ...kyc,
    });
    audit(S, ctx, user.id, 'user.registered', `user:${user.id}`, company);
    if (!isFirst) notifyAdmins(S, ctx, `درخواست عضویت: ${company} (${kyc.province})`, `#admin-review-${user.id}`);
    return user;
  }
  function createAdmin(S, { name = 'مدیر سامانه', phone, password, now }, { hashPassword }) {
    const ph = normPhone(phone);
    if (!/^\+?\d{9,15}$/.test(ph)) fail('ADMIN_PHONE نامعتبر است.');
    if (String(password || '').length < 10) fail('ADMIN_PASSWORD باید حداقل ۱۰ حرف باشد.');
    const u = S.put('users', { name, phone: ph, whatsapp: ph, company: 'مدیریت سرای شهزاده', activity: 'other', role: 'admin', status: 'approved', showContact: false, bio: '', createdAt: now, passHash: hashPassword(password), province: 'کابل', address: 'سرای شهزاده' });
    audit(S, { now }, null, 'system.admin.created', `user:${u.id}`, '');
    return u;
  }
  function findByPhone(S, phone) { return S.one('users', { phone: normPhone(phone) }); }

  /* ---------- guards ---------- */
  function requireUser(S, id) {
    const u = id != null ? S.get('users', Number(id)) : null;
    if (!u) fail('ابتدا وارد حساب شوید.', 'unauthorized');
    if (u.status === 'blocked') fail('حساب شما مسدود است.', 'forbidden');
    return u;
  }
  function requireApproved(S, id) {
    const u = requireUser(S, id);
    if (u.status !== 'approved') fail('حساب شما هنوز تأیید نشده است.', 'forbidden');
    return u;
  }
  function requireAdmin(S, id) {
    const u = requireApproved(S, id);
    if (u.role !== 'admin') fail('دسترسی ندارید.', 'forbidden');
    return u;
  }
  const getOr = (S, kind, id, msg) => S.get(kind, Number(id)) || fail(msg, 'not_found');

  /* =========================================================
     Actions
     ========================================================= */
  const actions = {
    'profile.update'(S, me, p, ctx) {
      const u = requireUser(S, me);
      if (p.name !== undefined) u.name = str(p.name, 'نام', { max: 80 });
      if (p.company !== undefined) u.company = str(p.company, 'نام صرافی', { max: 80 });
      if (p.whatsapp !== undefined) u.whatsapp = normPhone(p.whatsapp) || u.phone;
      if (p.activity !== undefined) { if (!ACTIVITIES[p.activity]) fail('نوع فعالیت نامعتبر است.'); u.activity = p.activity; }
      if (p.bio !== undefined) u.bio = str(p.bio, 'معرفی', { required: false, max: 400 });
      if (p.showContact !== undefined) u.showContact = !!p.showContact;
      S.put('users', u);
      audit(S, ctx, me, 'user.profile', `user:${u.id}`, '');
      return { ok: true };
    },

    'account.resubmit'(S, me, p, ctx) {
      const u = requireUser(S, me);
      if (u.status !== 'rejected') fail('فقط درخواست ردشده قابل ارسال مجدد است.');
      if (p.name !== undefined) u.name = str(p.name, 'نام', { max: 80 });
      if (p.company !== undefined) u.company = str(p.company, 'نام صرافی', { max: 80 });
      Object.assign(u, kycFields(p));
      u.status = 'pending'; u.statusReason = ''; u.resubmittedAt = ctx.now;
      S.put('users', u);
      notifyAdmins(S, ctx, `ارسال مجدد مدارک: ${displayName(u)}`, `#admin-review-${u.id}`);
      notify(S, ctx, u.id, 'مدارک شما مجدداً برای بررسی ارسال شد.', '#profile');
      audit(S, ctx, me, 'user.resubmit', `user:${u.id}`, '');
      return { ok: true };
    },

    'order.create'(S, me, p, ctx) {
      requireApproved(S, me);
      const asset = assetOf(S, p.assetId);
      if (!asset || !asset.active) fail('دارایی انتخاب‌شده معتبر نیست.');
      const side = p.side === 'buy' ? 'buy' : p.side === 'sell' ? 'sell' : fail('نوع معامله را انتخاب کنید.');
      const amount = num(p.amount, 'مقدار');
      const price = num(p.price, 'نرخ');
      const unit = str(p.unit || asset.unit, 'واحد', { max: 20 });
      const priceCurrency = str(p.priceCurrency || asset.priceCurrency, 'واحد قیمت', { max: 20 });
      const minAmount = p.minAmount ? num(p.minAmount, 'حداقل مقدار') : 0;
      if (minAmount > amount) fail('حداقل مقدار نمی‌تواند از مقدار کل بیشتر باشد.');
      const hours = Math.min(Number(p.validHours || 0), 24 * 30);
      if (S.count('orders', { userId: me, status: 'active' }) >= 50) fail('حداکثر ۵۰ سفارش فعال مجاز است.');
      const dup = S.one('orders', { userId: me, status: 'active', assetId: asset.id, side, price, amount, createdAt: { gte: ctx.now - 10 * 60e3 } });
      if (dup) fail(`سفارش مشابه (#${dup.id}) اخیراً ثبت شده است.`, 'conflict');
      const order = S.put('orders', {
        userId: me, side, assetId: asset.id, amount, remaining: amount, minAmount, price, priceCurrency, unit,
        note: str(p.note, 'توضیحات', { required: false, max: 300 }), status: 'active',
        createdAt: ctx.now, expiresAt: hours > 0 ? ctx.now + hours * 3600e3 : null, updatedAt: ctx.now,
      });
      audit(S, ctx, me, 'order.created', `order:${order.id}`, `${side} ${amount} ${unit} ${asset.code} @ ${price} ${priceCurrency}`);
      market(ctx);
      return { orderId: order.id };
    },

    'order.cancel'(S, me, p, ctx) {
      const u = requireUser(S, me);
      const o = getOr(S, 'orders', p.orderId, 'سفارش پیدا نشد.');
      if (o.userId !== me && !(u.role === 'admin' && ctx.scope === 'admin')) fail('دسترسی ندارید.', 'forbidden');
      if (!['active', 'filled'].includes(o.status)) fail('این سفارش قابل بستن نیست.');
      const hasOpen = S.count('deals', { orderId: o.id, status: 'accepted' }) > 0;
      o.status = hasOpen || o.amount !== o.remaining ? 'closed' : 'cancelled';
      o.updatedAt = ctx.now; S.put('orders', o);
      for (const d of S.find('deals', { orderId: o.id, status: 'pending' })) {
        d.status = 'rejected'; d.updatedAt = ctx.now; d.reason = 'سفارش بسته شد.'; S.put('deals', d);
        notify(S, ctx, d.requesterId, `سفارش #${o.id} بسته شد؛ درخواست شما رد شد.`, '#dashboard-sent');
      }
      if (o.userId !== me) notify(S, ctx, o.userId, `سفارش #${o.id} توسط مدیریت بسته شد.`, '#dashboard-orders');
      audit(S, ctx, me, 'order.closed', `order:${o.id}`, `remaining ${o.remaining}`);
      market(ctx);
      return { ok: true };
    },

    'deal.request'(S, me, p, ctx) {
      const u = requireApproved(S, me);
      const o = getOr(S, 'orders', p.orderId, 'سفارش پیدا نشد.');
      if (o.status !== 'active') fail('این سفارش دیگر فعال نیست.');
      if (o.userId === me) fail('ارسال درخواست به سفارش خود ممکن نیست.');
      const amount = num(p.amount, 'مقدار درخواستی');
      if (amount > o.remaining) fail(`مقدار درخواستی از مقدار باقی‌مانده (${fmtN(o.remaining)}) بیشتر است.`);
      if (o.minAmount && amount < o.minAmount && amount !== o.remaining) fail(`حداقل مقدار برای این سفارش ${fmtN(o.minAmount)} است.`);
      if (S.one('deals', { orderId: o.id, requesterId: me, status: 'pending' })) fail('برای این سفارش یک درخواست در انتظار دارید.', 'conflict');
      const asset = assetOf(S, o.assetId);
      const deal = S.put('deals', {
        orderId: o.id, ownerId: o.userId, requesterId: me, amount, acceptedAmount: 0, price: o.price,
        note: str(p.note, 'پیام', { required: false, max: 300 }), status: 'pending',
        ownerDone: false, requesterDone: false, createdAt: ctx.now, updatedAt: ctx.now,
      });
      const verb = o.side === 'sell' ? 'خرید' : 'فروش';
      notify(S, ctx, o.userId, `درخواست ${verb}: ${displayName(u)} — ${fmtN(amount)} ${o.unit} ${asset.code} (سفارش #${o.id})`, `#order-${o.id}`);
      audit(S, ctx, me, 'deal.requested', `deal:${deal.id}`, `order ${o.id} amount ${amount}`);
      return { dealId: deal.id };
    },

    'deal.accept'(S, me, p, ctx) {
      requireApproved(S, me);
      const d = getOr(S, 'deals', p.dealId, 'درخواست پیدا نشد.');
      const o = S.get('orders', d.orderId);
      if (d.ownerId !== me) fail('فقط صاحب سفارش می‌تواند تأیید کند.', 'forbidden');
      if (d.status !== 'pending') fail('به این درخواست قبلاً پاسخ داده شده است.');
      if (o.status !== 'active') fail('سفارش فعال نیست.');
      const amount = p.amount ? num(p.amount, 'مقدار تأیید') : d.amount;
      if (amount > d.amount) fail('مقدار تأیید نمی‌تواند از مقدار درخواست بیشتر باشد.');
      // Core rule: total accepted can never exceed what is available.
      if (amount > o.remaining) fail(`فقط ${fmtN(o.remaining)} باقی مانده است.`, 'conflict');
      o.remaining = round(o.remaining - amount); o.updatedAt = ctx.now;
      d.acceptedAmount = amount; d.status = 'accepted'; d.updatedAt = ctx.now; d.acceptedAt = ctx.now;
      S.put('deals', d);
      const asset = assetOf(S, o.assetId);
      notify(S, ctx, d.requesterId, `درخواست شما تأیید شد: ${fmtN(amount)} ${o.unit} ${asset.code}${amount < d.amount ? ` (از ${fmtN(d.amount)})` : ''}. اطلاعات تماس طرف مقابل در صفحه معامله است.`, `#deal-${d.id}`);
      if (o.remaining <= 0) {
        o.status = 'filled';
        for (const x of S.find('deals', { orderId: o.id, status: 'pending' })) {
          x.status = 'rejected'; x.updatedAt = ctx.now; x.reason = 'ظرفیت سفارش تکمیل شد.'; S.put('deals', x);
          notify(S, ctx, x.requesterId, `ظرفیت سفارش #${o.id} تکمیل شد؛ درخواست شما بسته شد.`, '#dashboard-sent');
        }
      }
      S.put('orders', o);
      audit(S, ctx, me, 'deal.accepted', `deal:${d.id}`, `amount ${amount}, order ${o.id} remaining ${o.remaining}`);
      market(ctx);
      return { ok: true, remaining: o.remaining };
    },

    'deal.reject'(S, me, p, ctx) {
      requireUser(S, me);
      const d = getOr(S, 'deals', p.dealId, 'درخواست پیدا نشد.');
      if (d.ownerId !== me) fail('دسترسی ندارید.', 'forbidden');
      if (d.status !== 'pending') fail('به این درخواست قبلاً پاسخ داده شده است.');
      d.status = 'rejected'; d.updatedAt = ctx.now; d.reason = str(p.reason, 'دلیل', { required: false, max: 200 });
      S.put('deals', d);
      notify(S, ctx, d.requesterId, `درخواست شما برای سفارش #${d.orderId} رد شد.${d.reason ? ' دلیل: ' + d.reason : ''}`, `#deal-${d.id}`);
      audit(S, ctx, me, 'deal.rejected', `deal:${d.id}`, d.reason);
      return { ok: true };
    },

    'deal.withdraw'(S, me, p, ctx) {
      requireUser(S, me);
      const d = getOr(S, 'deals', p.dealId, 'درخواست پیدا نشد.');
      if (d.requesterId !== me) fail('دسترسی ندارید.', 'forbidden');
      if (d.status !== 'pending') fail('فقط درخواست در انتظار قابل لغو است.');
      d.status = 'cancelled'; d.updatedAt = ctx.now; S.put('deals', d);
      notify(S, ctx, d.ownerId, `یک درخواست برای سفارش #${d.orderId} لغو شد.`, `#order-${d.orderId}`);
      audit(S, ctx, me, 'deal.withdrawn', `deal:${d.id}`, '');
      return { ok: true };
    },

    'deal.cancel'(S, me, p, ctx) {
      const u = requireUser(S, me);
      const d = getOr(S, 'deals', p.dealId, 'معامله پیدا نشد.');
      if (![d.ownerId, d.requesterId].includes(me) && !(u.role === 'admin' && ctx.scope === 'admin')) fail('دسترسی ندارید.', 'forbidden');
      if (d.status !== 'accepted') fail('فقط معامله در حال اجرا قابل لغو است.');
      const o = S.get('orders', d.orderId);
      d.status = 'cancelled'; d.updatedAt = ctx.now; d.reason = str(p.reason, 'دلیل', { required: false, max: 200 });
      S.put('deals', d);
      o.remaining = round(o.remaining + d.acceptedAmount);
      if (o.status === 'filled') o.status = o.expiresAt && o.expiresAt <= ctx.now ? 'expired' : 'active';
      o.updatedAt = ctx.now; S.put('orders', o);
      for (const uid of [d.ownerId, d.requesterId]) if (uid !== me) notify(S, ctx, uid, `معامله #${d.id} لغو شد.${d.reason ? ' دلیل: ' + d.reason : ''}`, `#deal-${d.id}`);
      audit(S, ctx, me, 'deal.cancelled', `deal:${d.id}`, `returned ${d.acceptedAmount} to order ${o.id}`);
      market(ctx);
      return { ok: true };
    },

    'deal.complete'(S, me, p, ctx) {
      requireUser(S, me);
      const d = getOr(S, 'deals', p.dealId, 'معامله پیدا نشد.');
      if (![d.ownerId, d.requesterId].includes(me)) fail('دسترسی ندارید.', 'forbidden');
      if (d.status !== 'accepted') fail('این معامله در حال اجرا نیست.');
      if (me === d.ownerId) d.ownerDone = true; else d.requesterDone = true;
      d.updatedAt = ctx.now;
      const other = me === d.ownerId ? d.requesterId : d.ownerId;
      if (d.ownerDone && d.requesterDone) {
        d.status = 'completed'; d.completedAt = ctx.now;
        notify(S, ctx, other, `معامله #${d.id} توسط هر دو طرف تکمیل شد.`, `#deal-${d.id}`);
        notify(S, ctx, me, `معامله #${d.id} تکمیل شد.`, `#deal-${d.id}`);
        market(ctx);
      } else {
        notify(S, ctx, other, `طرف مقابل تکمیل معامله #${d.id} را اعلام کرد. لطفاً تأیید کنید.`, `#deal-${d.id}`);
      }
      S.put('deals', d);
      audit(S, ctx, me, 'deal.confirmed', `deal:${d.id}`, d.status);
      return { ok: true, status: d.status };
    },

    'message.send'(S, me, p, ctx) {
      requireApproved(S, me);
      const d = getOr(S, 'deals', p.dealId, 'معامله پیدا نشد.');
      if (![d.ownerId, d.requesterId].includes(me)) fail('دسترسی ندارید.', 'forbidden');
      if (!['accepted', 'completed', 'pending'].includes(d.status)) fail('گفتگوی این معامله بسته است.');
      S.put('messages', { dealId: d.id, userId: me, text: str(p.text, 'پیام', { max: 1000 }), at: ctx.now });
      notify(S, ctx, me === d.ownerId ? d.requesterId : d.ownerId, `پیام جدید در معامله #${d.id}`, `#deal-${d.id}`);
      return { ok: true };
    },

    'notifications.read'(S, me, p, ctx) {
      requireUser(S, me);
      const where = p.id ? { userId: me, id: Number(p.id) } : { userId: me, read: false };
      for (const n of S.find('notifications', where, { limit: 500 })) { n.read = true; S.put('notifications', n); }
      (ctx.touched = ctx.touched || new Set()).add(me);
      return { ok: true };
    },

    'report.create'(S, me, p, ctx) {
      requireApproved(S, me);
      const target = getOr(S, 'users', p.userId, 'کاربر پیدا نشد.');
      if (target.id === me) fail('گزارش علیه خود ممکن نیست.');
      if (S.count('reports', { reporterId: me, createdAt: { gte: ctx.now - 864e5 } }) >= 10) fail('حداکثر ۱۰ گزارش در روز مجاز است.');
      S.put('reports', { reporterId: me, userId: target.id, dealId: p.dealId ? Number(p.dealId) : null,
        reason: str(p.reason, 'شرح گزارش', { max: 500 }), status: 'open', createdAt: ctx.now });
      notifyAdmins(S, ctx, `گزارش تخلف: ${displayName(target)}`, '#admin-reports');
      audit(S, ctx, me, 'report.created', `user:${target.id}`, '');
      return { ok: true };
    },

    /* ----- administration ----- */
    'admin.user.setStatus'(S, me, p, ctx) {
      requireAdmin(S, me);
      const u = getOr(S, 'users', p.userId, 'کاربر پیدا نشد.');
      if (!USER_STATUS[p.status]) fail('وضعیت نامعتبر است.');
      if (u.id === me) fail('تغییر وضعیت حساب خود ممکن نیست.');
      const reason = str(p.reason, 'دلیل', { required: p.status === 'rejected', max: 300 });
      u.status = p.status; u.reviewedAt = ctx.now; u.reviewedBy = me;
      u.statusReason = p.status === 'approved' ? '' : reason;
      S.put('users', u);
      if (p.status === 'blocked' || p.status === 'rejected') {
        for (const o of S.find('orders', { userId: u.id, status: 'active' })) { o.status = 'closed'; o.updatedAt = ctx.now; S.put('orders', o); market(ctx); }
        for (const d of S.find('deals', { requesterId: u.id, status: 'pending' })) { d.status = 'cancelled'; d.updatedAt = ctx.now; S.put('deals', d); }
      }
      notify(S, ctx, u.id, {
        approved: 'حساب شما تأیید شد. اکنون می‌توانید سفارش ثبت کنید.',
        rejected: `درخواست عضویت شما رد شد. دلیل: ${reason}. می‌توانید مدارک را اصلاح و مجدداً ارسال کنید.`,
        blocked: `حساب شما مسدود شد.${reason ? ' دلیل: ' + reason : ''}`,
        pending: 'حساب شما در وضعیت «در انتظار بررسی» قرار گرفت.',
      }[p.status], '#profile');
      audit(S, ctx, me, 'admin.user.status', `user:${u.id}`, p.status + (reason ? ': ' + reason : ''));
      return { ok: true };
    },
    'admin.user.setRole'(S, me, p, ctx) {
      requireAdmin(S, me);
      const u = getOr(S, 'users', p.userId, 'کاربر پیدا نشد.');
      if (!['admin', 'member'].includes(p.role)) fail('نقش نامعتبر است.');
      if (u.id === me) fail('تغییر نقش حساب خود ممکن نیست.');
      if (p.role === 'admin' && u.status !== 'approved') fail('فقط حساب تأییدشده می‌تواند مدیر شود.');
      u.role = p.role; S.put('users', u);
      notify(S, ctx, u.id, p.role === 'admin' ? 'دسترسی مدیریت به حساب شما داده شد.' : 'دسترسی مدیریت از حساب شما برداشته شد.', '#profile');
      audit(S, ctx, me, 'admin.user.role', `user:${u.id}`, p.role);
      return { ok: true };
    },
    'admin.asset.save'(S, me, p, ctx) {
      requireAdmin(S, me);
      const code = str(p.code, 'کد دارایی', { max: 12 }).toUpperCase();
      if (!/^[A-Z0-9]{2,12}$/.test(code)) fail('کد دارایی فقط حروف انگلیسی و عدد است.');
      const data = { code, name: str(p.name, 'نام دارایی', { max: 40 }), unit: str(p.unit, 'واحد مقدار', { max: 12 }),
        priceCurrency: str(p.priceCurrency, 'واحد قیمت', { max: 12 }), kind: p.kind === 'metal' ? 'metal' : 'currency' };
      let a = p.id ? assetOf(S, p.id) : null;
      const clash = S.one('assets', { code });
      if (clash && (!a || clash.id !== a.id)) fail('این کد قبلاً ثبت شده است.', 'conflict');
      a = S.put('assets', a ? { ...a, ...data } : { ...data, active: true });
      audit(S, ctx, me, 'admin.asset.save', `asset:${a.id}`, code);
      market(ctx);
      return { assetId: a.id };
    },
    'admin.asset.toggle'(S, me, p, ctx) {
      requireAdmin(S, me);
      const a = getOr(S, 'assets', p.assetId, 'دارایی پیدا نشد.');
      a.active = !a.active; S.put('assets', a);
      audit(S, ctx, me, 'admin.asset.toggle', `asset:${a.id}`, String(a.active));
      market(ctx);
      return { ok: true };
    },
    'admin.rate.set'(S, me, p, ctx) {
      requireAdmin(S, me);
      const a = getOr(S, 'assets', p.assetId, 'دارایی پیدا نشد.');
      const buy = num(p.buy, 'نرخ خرید'), sell = num(p.sell, 'نرخ فروش');
      if (sell < buy) fail('نرخ فروش نمی‌تواند کمتر از نرخ خرید باشد.');
      if ((sell - buy) / buy > 0.1) fail('فاصله نرخ خرید و فروش بیش از ۱۰٪ است. ارقام را بررسی کنید.');
      const r = S.one('rates', { assetId: a.id });
      const prevMid = r ? (r.buy + r.sell) / 2 : null, mid = (buy + sell) / 2;
      if (prevMid && Math.abs(mid - prevMid) / prevMid > RATE_GUARD && !p.confirmLarge) {
        fail(`تغییر ${Math.round((Math.abs(mid - prevMid) / prevMid) * 100)}٪ نسبت به نرخ قبلی. برای ثبت، تغییر بزرگ را تأیید کنید.`, 'confirm');
      }
      S.put('rates', { ...(r || {}), assetId: a.id, buy, sell, prevMid, currency: a.priceCurrency, updatedAt: ctx.now });
      S.put('rateHistory', { assetId: a.id, at: ctx.now, buy, sell });
      audit(S, ctx, me, 'admin.rate.set', `asset:${a.id}`, `${a.code} ${buy}/${sell}${prevMid ? ` (prev mid ${round(prevMid)})` : ''}`);
      market(ctx);
      return { ok: true };
    },
    'admin.report.resolve'(S, me, p, ctx) {
      requireAdmin(S, me);
      const r = getOr(S, 'reports', p.reportId, 'گزارش پیدا نشد.');
      r.status = 'resolved'; r.resolvedAt = ctx.now; r.note = str(p.note, 'یادداشت', { required: false, max: 300 });
      S.put('reports', r);
      audit(S, ctx, me, 'admin.report.resolve', `report:${r.id}`, r.note);
      return { ok: true };
    },
    'admin.broadcast'(S, me, p, ctx) {
      requireAdmin(S, me);
      const text = str(p.text, 'متن اطلاعیه', { max: 300 });
      const n = S.count('users', { status: 'approved' });
      if (n > 50000) fail('ارسال به بیش از ۵۰٬۰۰۰ عضو باید از طریق صف ارسال انجام شود.');
      for (const u of S.find('users', { status: 'approved' })) notify(S, ctx, u.id, `اطلاعیه رسمی: ${text}`, '');
      audit(S, ctx, me, 'admin.broadcast', null, text);
      return { ok: true, sent: n };
    },
  };

  /* ----- actions that change official data or privileges (host must re-verify the password) ----- */
  const SENSITIVE = new Set(['admin.rate.set', 'admin.user.setRole', 'admin.asset.save', 'admin.asset.toggle', 'admin.broadcast']);

  function dispatch(S, actorId, type, payload, ctx) {
    const fn = actions[type];
    if (!fn) fail('عملیات نامعتبر است.');
    if (type.startsWith('admin.') && ctx.scope !== 'admin') fail('این عملیات فقط از پنل مدیریت ممکن است.', 'forbidden');
    sweep(S, ctx);
    return fn(S, actorId == null ? null : Number(actorId), payload || {}, ctx) || {};
  }

  /* =========================================================
     Views (bounded: every list is capped)
     ========================================================= */
  function publicUser(u, { contact = false, self = false, kyc = false } = {}) {
    if (!u) return null;
    const out = { id: u.id, name: u.name, company: u.company, activity: u.activity, status: u.status, role: u.role, createdAt: u.createdAt, bio: u.bio || '', province: u.province || '' };
    if (self || (contact && u.showContact) || kyc) { out.phone = u.phone; out.whatsapp = u.whatsapp; }
    if (self) { out.showContact = u.showContact; out.totpEnabled = !!u.totpEnabled; }
    if (self || kyc) {
      Object.assign(out, { city: u.city || '', address: u.address || '', experience: u.experience || '', licenseNo: u.licenseNo || '',
        guarantorName: u.guarantorName || '', guarantorPhone: u.guarantorPhone || '', about: u.about || '',
        statusReason: u.statusReason || '', reviewedAt: u.reviewedAt || null, resubmittedAt: u.resubmittedAt || null });
    }
    return out;
  }
  const uniq = (a) => [...new Set(a.filter((x) => x != null))];
  function byIds(S, kind, ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 500) out.push(...S.find(kind, { id: { in: ids.slice(i, i + 500) } }));
    return out;
  }

  // Aggregate counters are cached briefly so heavy traffic does not recount large tables on every request.
  const aggCache = new WeakMap();
  function cached(S, key, now, ttl, fn) {
    let m = aggCache.get(S); if (!m) { m = {}; aggCache.set(S, m); }
    const hit = m[key];
    if (hit && now != null && now - hit.at < ttl) return hit.v;
    const v = fn(); m[key] = { at: now || 0, v }; return v;
  }
  function stats(S, now) { return cached(S, 'stats', now, 5000, () => statsRaw(S)); }
  function statsRaw(S) {
    return {
      members: S.count('users', { status: 'approved' }),
      activeOrders: S.count('orders', { status: 'active' }),
      sellOrders: S.count('orders', { status: 'active', side: 'sell' }),
      buyOrders: S.count('orders', { status: 'active', side: 'buy' }),
      activeDeals: S.count('deals', { status: 'accepted' }),
      completedDeals: S.count('deals', { status: 'completed' }),
    };
  }

  function buildView(S, actorId, { now, scope = 'user' } = {}) {
    const me = actorId != null ? S.get('users', Number(actorId)) : null;
    const isAdmin = !!(me && me.role === 'admin' && me.status === 'approved' && scope === 'admin');
    const member = !!me && me.status === 'approved';

    const assets = S.find('assets', {});
    const rates = S.find('rates', {});
    const rateHistory = S.find('rateHistory', {}, { order: '-at', limit: LIMITS.rateHistory }).reverse();
    let orders = S.find('orders', { status: 'active' }, { order: '-createdAt', limit: LIMITS.marketOrders });

    let deals = [];
    if (isAdmin) deals = S.find('deals', {}, { order: '-updatedAt', limit: LIMITS.deals });
    else if (me) {
      const map = new Map();
      for (const d of S.find('deals', { ownerId: me.id }, { order: '-updatedAt', limit: LIMITS.deals })) map.set(d.id, d);
      for (const d of S.find('deals', { requesterId: me.id }, { order: '-updatedAt', limit: LIMITS.deals })) map.set(d.id, d);
      deals = [...map.values()];
    }
    if (me) {
      const extra = isAdmin ? S.find('orders', {}, { order: '-createdAt', limit: LIMITS.myOrders }) : S.find('orders', { userId: me.id }, { order: '-createdAt', limit: LIMITS.myOrders });
      const have = new Set(orders.map((o) => o.id));
      for (const o of extra) if (!have.has(o.id)) { orders.push(o); have.add(o.id); }
      const missing = uniq(deals.map((d) => d.orderId)).filter((id) => !have.has(id));
      orders.push(...byIds(S, 'orders', missing));
    }

    const partyDeals = me ? deals.filter((d) => d.ownerId === me.id || d.requesterId === me.id) : [];
    const messages = partyDeals.length ? S.find('messages', { dealId: { in: partyDeals.slice(0, 100).map((d) => d.id) } }, { order: 'id', limit: 2000 }) : [];

    const contactWith = new Set();
    for (const d of partyDeals) {
      const other = d.ownerId === me.id ? d.requesterId : d.ownerId;
      if (['accepted', 'completed'].includes(d.status) || (d.status === 'pending' && d.ownerId === me.id)) contactWith.add(other);
    }
    let users = [];
    if (member || isAdmin) {
      const ids = uniq([...orders.map((o) => o.userId), ...deals.flatMap((d) => [d.ownerId, d.requesterId]), ...messages.map((m) => m.userId), me.id]);
      users = byIds(S, 'users', ids).map((u) => publicUser(u, { contact: isAdmin || contactWith.has(u.id), self: u.id === me.id, kyc: isAdmin }));
    }
    if (!member) orders = orders.filter((o) => o.status === 'active').map((o) => ({ ...o, userId: me && o.userId === me.id ? o.userId : null, note: '' }));

    const view = {
      me: me ? publicUser(me, { self: true }) : null,
      scope: isAdmin ? 'admin' : 'user',
      assets, rates, rateHistory, orders, deals, messages, users, stats: stats(S, now),
      notifications: me ? S.find('notifications', { userId: me.id }, { order: '-id', limit: LIMITS.notifications }) : [],
      unread: me ? S.count('notifications', { userId: me.id, read: false }) : 0,
      serverTime: now,
    };
    if (isAdmin) {
      const counts = cached(S, 'ucounts', now, 5000, () => Object.fromEntries(Object.keys(USER_STATUS).map((k) => [k, S.count('users', { status: k })])));
      const pending = S.find('users', { status: 'pending' }, { order: 'createdAt', limit: LIMITS.adminUsers });
      view.admin = {
        counts, totalUsers: cached(S, 'utotal', now, 5000, () => S.count('users', {})),
        pending: pending.map((u) => publicUser(u, { kyc: true })),
        reports: S.find('reports', {}, { order: '-id', limit: 100 }),
        openReports: S.count('reports', { status: 'open' }),
        audit: S.find('audit', {}, { order: '-id', limit: 200 }),
        auditIntact: cached(S, 'audit', now, 30000, () => verifyAudit(S, 2000)),
        period: cached(S, 'period', now, 30000, () => periodStats(S, now)),
      };
      const ids = uniq([...view.admin.reports.flatMap((r) => [r.userId, r.reporterId]), ...view.admin.audit.map((e) => e.actorId)]);
      const have = new Set(users.map((u) => u.id));
      users.push(...byIds(S, 'users', ids.filter((i) => !have.has(i))).map((u) => publicUser(u, { kyc: true })));
      view.users = users;
    }
    return view;
  }

  function periodStats(S, now) {
    return [['امروز', 864e5], ['۷ روز', 7 * 864e5], ['۳۰ روز', 30 * 864e5]].map(([label, ms]) => ({
      label,
      users: S.count('users', { createdAt: { gte: now - ms } }),
      orders: S.count('orders', { createdAt: { gte: now - ms } }),
      deals: S.count('deals', { createdAt: { gte: now - ms } }),
      completed: S.count('deals', { status: 'completed', completedAt: { gte: now - ms } }),
    }));
  }

  // Admin user search (paged) — used by the admin "members" module.
  function adminUsers(S, actorId, { q = '', status = '', id = null, offset = 0 } = {}) {
    requireAdmin(S, actorId);
    const where = {};
    if (id) where.id = Number(id);
    if (status && USER_STATUS[status]) where.status = status;
    const term = toLatinDigits(String(q || '')).trim().slice(0, 40);
    if (/^\+?\d{3,}$/.test(term)) where.phone = { gte: term, lt: term + ':' }; // phone prefix: uses the phone index
    else if (term) where.$or = [{ company: { like: term } }, { name: { like: term } }, { province: { like: term } }];
    const list = S.find('users', where, { order: '-createdAt', limit: 50, offset: Math.max(0, Number(offset) || 0) });
    return { users: list.map((u) => publicUser(u, { kyc: true })), total: S.count('users', where) };
  }

  // Verify the last `limit` audit entries: each links to the previous hash and hashes correctly.
  function verifyAudit(S, limit = 2000) {
    const rows = S.find('audit', {}, { order: '-id', limit }).reverse();
    for (let i = 0; i < rows.length; i++) {
      const { hash, ...rest } = rows[i];
      if (chainHash(rest.prev + JSON.stringify(rest)) !== hash) return false;
      if (i > 0 && rest.prev !== rows[i - 1].hash) return false;
    }
    return !rows.length || rows[rows.length - 1].hash === S.meta('auditHead');
  }

  /* ---------- demo data ---------- */
  function seed(S, { now, hashPassword, adminPassword = 'admin123', memberPassword = '123456' }) {
    const ctx = { now };
    const H = 3600e3;
    const mk = (name, phone, company, activity, role = 'member', status = 'approved', province = 'کابل') => S.put('users', {
      name, phone, whatsapp: phone, company, activity, role, status, showContact: true, bio: '',
      createdAt: status === 'pending' ? now - 2 * H : now - 30 * 24 * H, province, city: province,
      address: 'سرای شهزاده، منزل دوم، دکان ' + (10 + S.count('users', {})), experience: '۱۰ سال', licenseNo: '',
      guarantorName: role === 'admin' ? '' : 'حاجی محمود', guarantorPhone: role === 'admin' ? '' : '0799000111', about: '',
      passHash: hashPassword(role === 'admin' ? adminPassword : memberPassword),
    });
    mk('مدیر سیستم', '0700000000', 'مدیریت سرای شهزاده', 'other', 'admin');
    const u1 = mk('حاجی احمد کریمی', '0700000001', 'صرافی کریمی', 'saraf');
    const u2 = mk('محمد نادر', '0700000002', 'صرافی نادر', 'saraf');
    const u3 = mk('عبدالرحیم رحیمی', '0700000003', 'زرگری رحیمی', 'zargar');
    const u4 = mk('فرید احمدی', '0700000004', 'تجارتی احمدی', 'tajer', 'member', 'approved', 'هرات');
    mk('سمیع‌الله', '0700000005', 'صرافی سمیع', 'saraf', 'member', 'pending', 'بلخ');
    const A = {};
    [['USD', 'دالر امریکایی', 'USD', 'AFN', 'currency'], ['EUR', 'یورو', 'EUR', 'AFN', 'currency'],
      ['GBP', 'پوند انگلیس', 'GBP', 'AFN', 'currency'], ['PKR', 'کلدار پاکستانی', 'PKR', 'AFN', 'currency'],
      ['IRR', 'تومان ایران', 'IRT', 'AFN', 'currency'], ['AED', 'درهم امارات', 'AED', 'AFN', 'currency'],
      ['XAU', 'طلا', 'OZ', 'USD', 'metal'], ['XAG', 'نقره', 'KG', 'USD', 'metal'],
    ].forEach(([code, name, unit, priceCurrency, kind]) => { A[code] = S.put('assets', { code, name, unit, priceCurrency, kind, active: true }); });
    const base = { USD: [65.2, 65.35], EUR: [70.6, 70.9], GBP: [82.4, 82.9], PKR: [0.232, 0.235], IRR: [0.00079, 0.00082], AED: [17.7, 17.85], XAU: [4490, 4510], XAG: [51.5, 52.3] };
    for (const [code, [b, sl]] of Object.entries(base)) {
      let last = null;
      for (let i = 14; i >= 1; i--) {
        const w = 1 + Math.sin(i * 1.7 + code.length) * 0.006 + (14 - i) * 0.0004;
        last = S.put('rateHistory', { assetId: A[code].id, at: now - i * 24 * H, buy: round(b * w), sell: round(sl * w) });
      }
      S.put('rates', { assetId: A[code].id, buy: b, sell: sl, currency: A[code].priceCurrency, updatedAt: now - 2 * H, prevMid: (last.buy + last.sell) / 2 });
      S.put('rateHistory', { assetId: A[code].id, at: now - 2 * H, buy: b, sell: sl });
    }
    const ord = (u, side, code, amount, price, note = '', ageH = 1) => S.put('orders', {
      userId: u.id, side, assetId: A[code].id, amount, remaining: amount, minAmount: 0, price, priceCurrency: A[code].priceCurrency,
      unit: A[code].unit, note, status: 'active', createdAt: now - ageH * H, expiresAt: now + 24 * H, updatedAt: now - ageH * H,
    });
    const o1 = ord(u1, 'sell', 'USD', 40000, 65.30, 'تحویل نقد در سرای شهزاده', 3);
    ord(u2, 'buy', 'USD', 20000, 65.20, '', 2);
    ord(u4, 'sell', 'XAG', 40, 52, 'عیار ۹۹۹', 5);
    ord(u3, 'sell', 'XAU', 10, 4500, 'شمش استاندارد', 4);
    ord(u2, 'sell', 'EUR', 15000, 70.85, '', 6);
    ord(u4, 'buy', 'PKR', 2000000, 0.233, '', 1);
    ord(u1, 'buy', 'AED', 50000, 17.75, '', 7);
    const deal = (requester, amount, status, ageH, note = '') => S.put('deals', {
      orderId: o1.id, ownerId: u1.id, requesterId: requester.id, amount, acceptedAmount: status === 'accepted' ? amount : 0, price: o1.price,
      note, status, ownerDone: false, requesterDone: false, createdAt: now - ageH * H, updatedAt: now - ageH * H, acceptedAt: status === 'accepted' ? now - H : undefined,
    });
    const d1 = deal(u2, 15000, 'accepted', 2, 'تحویل امروز');
    deal(u3, 10000, 'pending', 0.5);
    deal(u4, 20000, 'pending', 0.3);
    o1.remaining = 25000; S.put('orders', o1);
    S.put('messages', { dealId: d1.id, userId: u2.id, text: 'ساعت ۲ بعد از ظهر در دفتر شما حاضر می‌شوم.', at: now - 0.8 * H });
    S.put('messages', { dealId: d1.id, userId: u1.id, text: 'تأیید است.', at: now - 0.7 * H });
    notify(S, { now: now - 0.5 * H }, u1.id, 'درخواست خرید: زرگری رحیمی — 10,000 USD (سفارش #1)', `#order-${o1.id}`);
    notify(S, { now: now - 0.3 * H }, u1.id, 'درخواست خرید: تجارتی احمدی — 20,000 USD (سفارش #1)', `#order-${o1.id}`);
    notify(S, { now: now - H }, u2.id, 'درخواست شما تأیید شد: 15,000 USD.', `#deal-${d1.id}`);
    audit(S, ctx, null, 'system.seed', null, 'demo data');
  }

  return {
    ACTIVITIES, ORDER_STATUS, DEAL_STATUS, USER_STATUS, PROVINCES, SENSITIVE, RATE_GUARD, EngineError,
    MemoryStore, matchWhere, register, createAdmin, findByPhone, dispatch, buildView, adminUsers, seed, verifyAudit, sweep, chainHash,
    actions: Object.keys(actions),
  };
});
