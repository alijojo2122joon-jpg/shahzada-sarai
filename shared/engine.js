/*
 * Shahzada Sarai — core trading engine (shared by the Node server and the browser demo).
 * Pure, synchronous logic over a plain JSON state object.
 * Every mutation goes through dispatch(), which validates, applies, notifies and audits.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SaraiEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ACTIVITIES = { saraf: 'صراف', zargar: 'زرگر', tajer: 'تاجر', other: 'سایر معامله‌گران' };
  const ORDER_STATUS = { active: 'فعال', filled: 'تکمیل ظرفیت', closed: 'بسته‌شده', cancelled: 'لغوشده', expired: 'منقضی' };
  const DEAL_STATUS = { pending: 'در انتظار پاسخ', accepted: 'در حال انجام', rejected: 'ردشده', cancelled: 'لغوشده', completed: 'تکمیل‌شده' };
  const USER_STATUS = { pending: 'در انتظار بررسی', approved: 'تأییدشده', rejected: 'ردشده', blocked: 'مسدود' };
  const PROVINCES = ['کابل', 'هرات', 'بلخ', 'قندهار', 'ننگرهار', 'کندز', 'غزنی', 'بامیان', 'بدخشان', 'تخار', 'بغلان', 'پروان', 'لوگر', 'میدان وردک', 'پکتیا', 'خوست', 'هلمند', 'فراه', 'نیمروز', 'جوزجان', 'فاریاب', 'سمنگان', 'سرپل', 'بادغیس', 'غور', 'دایکندی', 'ارزگان', 'زابل', 'پکتیکا', 'کنر', 'لغمان', 'نورستان', 'کاپیسا', 'پنجشیر'];

  class EngineError extends Error {
    constructor(message, code) { super(message); this.code = code || 'bad_request'; }
  }
  const fail = (msg, code) => { throw new EngineError(msg, code); };

  /* ---------- helpers ---------- */
  function emptyState() {
    return {
      version: 0,
      seq: {},
      users: [], assets: [], orders: [], deals: [], messages: [],
      notifications: [], rates: [], rateHistory: [], reports: [], audit: [],
    };
  }
  function nextId(state, kind) {
    state.seq[kind] = (state.seq[kind] || 0) + 1;
    return state.seq[kind];
  }
  const round = (n, d = 6) => Math.round(Number(n) * 10 ** d) / 10 ** d;
  const num = (v, label) => {
    const n = Number(String(v).replace(/,/g, '').trim());
    if (!isFinite(n) || n <= 0) fail(`${label} باید عدد مثبت باشد`);
    return round(n);
  };
  const str = (v, label, { required = true, max = 200 } = {}) => {
    const s = (v == null ? '' : String(v)).trim();
    if (required && !s) fail(`${label} الزامی است`);
    if (s.length > max) fail(`${label} بیش از حد طولانی است`);
    return s;
  };
  const normPhone = (p) => String(p || '').replace(/[^\d+]/g, '');
  const toLatinDigits = (s) => String(s || '')
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

  // Small non-cryptographic hash used only to chain audit entries (tamper-evidence).
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

  const byId = (arr, id) => arr.find((x) => x.id === Number(id));
  const userById = (s, id) => byId(s.users, id);
  const assetById = (s, id) => byId(s.assets, id);

  function audit(state, now, actorId, type, ref, detail) {
    const prev = state.audit.length ? state.audit[state.audit.length - 1].hash : 'genesis';
    const entry = { id: nextId(state, 'audit'), at: now, actorId: actorId || null, type, ref: ref || null, detail: detail || '' };
    entry.hash = chainHash(prev + JSON.stringify(entry));
    state.audit.push(entry);
  }
  function notify(state, now, userId, text, link) {
    state.notifications.push({ id: nextId(state, 'notif'), userId, text, link: link || '', read: false, at: now });
  }
  function notifyAdmins(state, now, text, link) {
    state.users.filter((u) => u.role === 'admin' && u.status === 'approved').forEach((a) => notify(state, now, a.id, text, link));
  }
  const displayName = (u) => (u ? (u.company || u.name) : '—');

  function fmtAmount(order, asset, amount) {
    return `${Number(amount).toLocaleString('en-US')} ${order.unit || (asset && asset.unit) || ''}`.trim();
  }

  /* ---------- expiry sweep ---------- */
  function sweep(state, now) {
    let changed = false;
    for (const o of state.orders) {
      if (o.status === 'active' && o.expiresAt && o.expiresAt <= now) {
        o.status = 'expired';
        changed = true;
        for (const d of state.deals) {
          if (d.orderId === o.id && d.status === 'pending') {
            d.status = 'rejected'; d.updatedAt = now; d.reason = 'سفارش منقضی شد';
            notify(state, now, d.requesterId, `سفارش #${o.id} منقضی شد و درخواست شما بسته شد.`, '#dashboard-sent');
          }
        }
        notify(state, now, o.userId, `سفارش #${o.id} شما منقضی شد.`, '#dashboard-orders');
        audit(state, now, null, 'order.expired', `order:${o.id}`, '');
      }
    }
    return changed;
  }

  /* ---------- auth (password hashing is injected by the host) ---------- */
  function register(state, input, { now, hashPassword }) {
    const name = str(input.name, 'نام و نام خانوادگی', { max: 80 });
    const phone = normPhone(toLatinDigits(input.phone));
    if (phone.length < 9) fail('شماره تماس معتبر نیست');
    const whatsapp = normPhone(toLatinDigits(input.whatsapp)) || phone;
    const company = str(input.company, 'نام صرافی یا شرکت', { max: 80 });
    const activity = ACTIVITIES[input.activity] ? input.activity : fail('نوع فعالیت را انتخاب کنید');
    const password = String(input.password || '');
    if (password.length < 6) fail('رمز عبور باید حداقل ۶ حرف باشد');
    if (state.users.some((u) => u.phone === phone)) fail('این شماره قبلاً ثبت شده است', 'conflict');
    const kyc = kycFields(input, { requireAll: state.users.length > 0 });
    const isFirst = state.users.length === 0;
    const user = {
      id: nextId(state, 'user'), name, phone, whatsapp, company, activity,
      role: isFirst ? 'admin' : 'member', status: isFirst ? 'approved' : 'pending',
      showContact: true, bio: '', createdAt: now, passHash: hashPassword(password), ...kyc,
    };
    state.users.push(user);
    audit(state, now, user.id, 'user.registered', `user:${user.id}`, company);
    if (!isFirst) notifyAdmins(state, now, `درخواست عضویت جدید: «${company}» از ${kyc.province} — منتظر بررسی شما.`, `#admin-review-${user.id}`);
    state.version++;
    return user;
  }
  function login(state, input, { verifyPassword }) {
    const phone = normPhone(toLatinDigits(input.phone));
    const user = state.users.find((u) => u.phone === phone);
    if (!user || !verifyPassword(String(input.password || ''), user.passHash)) fail('شماره یا رمز عبور اشتباه است', 'unauthorized');
    if (user.status === 'blocked') fail('حساب شما مسدود شده است. با مدیر سیستم تماس بگیرید.', 'forbidden');
    return user;
  }

  function kycFields(p, { requireAll = true } = {}) {
    const province = str(p.province, 'ولایت', { required: requireAll, max: 30 });
    if (province && !PROVINCES.includes(province)) fail('ولایت را از فهرست انتخاب کنید');
    return {
      province,
      city: str(p.city, 'شهر / ولسوالی', { required: false, max: 40 }),
      address: str(p.address, 'آدرس دفتر یا دکان', { required: requireAll, max: 200 }),
      experience: str(p.experience, 'سابقه کار', { required: false, max: 40 }),
      guarantorName: str(p.guarantorName, 'نام ضامن', { required: false, max: 80 }),
      guarantorPhone: normPhone(toLatinDigits(p.guarantorPhone)),
      about: str(p.about, 'معرفی', { required: false, max: 500 }),
    };
  }

  /* ---------- permission guards ---------- */
  function requireUser(state, actorId) {
    const u = userById(state, actorId);
    if (!u) fail('ابتدا وارد حساب شوید', 'unauthorized');
    if (u.status === 'blocked') fail('حساب شما مسدود است', 'forbidden');
    return u;
  }
  function requireApproved(state, actorId) {
    const u = requireUser(state, actorId);
    if (u.status !== 'approved') fail('حساب شما هنوز توسط مدیر تأیید نشده است', 'forbidden');
    return u;
  }
  function requireAdmin(state, actorId) {
    const u = requireApproved(state, actorId);
    if (u.role !== 'admin') fail('این بخش فقط برای مدیر است', 'forbidden');
    return u;
  }

  /* ---------- actions ---------- */
  const actions = {
    'profile.update'(s, me, p, now) {
      const u = requireUser(s, me);
      if (p.name !== undefined) u.name = str(p.name, 'نام', { max: 80 });
      if (p.company !== undefined) u.company = str(p.company, 'نام صرافی', { max: 80 });
      if (p.whatsapp !== undefined) u.whatsapp = normPhone(toLatinDigits(p.whatsapp)) || u.phone;
      if (p.activity !== undefined) { if (!ACTIVITIES[p.activity]) fail('نوع فعالیت نامعتبر'); u.activity = p.activity; }
      if (p.bio !== undefined) u.bio = str(p.bio, 'توضیحات', { required: false, max: 400 });
      if (p.showContact !== undefined) u.showContact = !!p.showContact;
      audit(s, now, me, 'user.profile', `user:${u.id}`, '');
      return { ok: true };
    },

    'order.create'(s, me, p, now) {
      const u = requireApproved(s, me);
      const asset = assetById(s, p.assetId);
      if (!asset || !asset.active) fail('دارایی انتخاب‌شده معتبر نیست');
      const side = p.side === 'buy' ? 'buy' : p.side === 'sell' ? 'sell' : fail('نوع معامله را انتخاب کنید');
      const amount = num(p.amount, 'مقدار');
      const price = num(p.price, 'نرخ');
      const unit = str(p.unit || asset.unit, 'واحد', { max: 20 });
      const priceCurrency = str(p.priceCurrency || asset.priceCurrency, 'واحد قیمت', { max: 20 });
      const minAmount = p.minAmount ? num(p.minAmount, 'حداقل مقدار') : 0;
      if (minAmount > amount) fail('حداقل مقدار نمی‌تواند از کل مقدار بیشتر باشد');
      const hours = Number(p.validHours || 0);
      const expiresAt = hours > 0 ? now + hours * 3600e3 : null;
      const dup = s.orders.find((o) => o.userId === me && o.status === 'active' && o.assetId === asset.id &&
        o.side === side && o.price === price && o.amount === amount && now - o.createdAt < 10 * 60e3);
      if (dup) fail(`سفارش مشابه (#${dup.id}) چند دقیقه پیش ثبت شده است`, 'conflict');
      const order = {
        id: nextId(s, 'order'), userId: me, side, assetId: asset.id, amount, remaining: amount, minAmount,
        price, priceCurrency, unit, note: str(p.note, 'توضیحات', { required: false, max: 300 }),
        status: 'active', createdAt: now, expiresAt, updatedAt: now,
      };
      s.orders.push(order);
      audit(s, now, me, 'order.created', `order:${order.id}`,
        `${side} ${amount} ${unit} ${asset.code} @ ${price} ${priceCurrency}`);
      return { orderId: order.id, _name: displayName(u) };
    },

    'order.cancel'(s, me, p, now) {
      const u = requireUser(s, me);
      const o = byId(s.orders, p.orderId) || fail('سفارش پیدا نشد', 'not_found');
      if (o.userId !== me && u.role !== 'admin') fail('اجازه ندارید', 'forbidden');
      if (!['active', 'filled'].includes(o.status)) fail('این سفارش قابل بستن نیست');
      const hasOpen = s.deals.some((d) => d.orderId === o.id && d.status === 'accepted');
      o.status = hasOpen ? 'closed' : (o.amount === o.remaining ? 'cancelled' : 'closed');
      o.updatedAt = now;
      for (const d of s.deals) {
        if (d.orderId === o.id && d.status === 'pending') {
          d.status = 'rejected'; d.updatedAt = now; d.reason = 'سفارش بسته شد';
          notify(s, now, d.requesterId, `سفارش #${o.id} بسته شد و درخواست شما رد شد.`, '#dashboard-sent');
        }
      }
      if (o.userId !== me) notify(s, now, o.userId, `سفارش #${o.id} شما توسط مدیر بسته شد.`, '#dashboard-orders');
      audit(s, now, me, 'order.closed', `order:${o.id}`, `remaining ${o.remaining}`);
      return { ok: true };
    },

    'deal.request'(s, me, p, now) {
      const u = requireApproved(s, me);
      const o = byId(s.orders, p.orderId) || fail('سفارش پیدا نشد', 'not_found');
      if (o.status !== 'active') fail('این سفارش دیگر فعال نیست');
      if (o.userId === me) fail('نمی‌توانید به سفارش خودتان درخواست بدهید');
      const amount = num(p.amount, 'مقدار درخواستی');
      if (amount > o.remaining) fail(`مقدار درخواستی از مقدار باقی‌مانده (${o.remaining}) بیشتر است`);
      if (o.minAmount && amount < o.minAmount && amount !== o.remaining) fail(`حداقل مقدار برای این سفارش ${o.minAmount} است`);
      if (s.deals.some((d) => d.orderId === o.id && d.requesterId === me && d.status === 'pending'))
        fail('شما برای این سفارش یک درخواست در انتظار دارید', 'conflict');
      const asset = assetById(s, o.assetId);
      const deal = {
        id: nextId(s, 'deal'), orderId: o.id, ownerId: o.userId, requesterId: me, amount, acceptedAmount: 0,
        price: o.price, note: str(p.note, 'پیام', { required: false, max: 300 }),
        status: 'pending', ownerDone: false, requesterDone: false, createdAt: now, updatedAt: now,
      };
      s.deals.push(deal);
      const verb = o.side === 'sell' ? 'خرید' : 'فروش';
      notify(s, now, o.userId, `«${displayName(u)}» درخواست ${verb} ${fmtAmount(o, asset, amount)} ${asset.code} از سفارش #${o.id} فرستاد.`, '#dashboard-received');
      audit(s, now, me, 'deal.requested', `deal:${deal.id}`, `order ${o.id} amount ${amount}`);
      return { dealId: deal.id };
    },

    'deal.accept'(s, me, p, now) {
      requireApproved(s, me);
      const d = byId(s.deals, p.dealId) || fail('درخواست پیدا نشد', 'not_found');
      const o = byId(s.orders, d.orderId);
      if (d.ownerId !== me) fail('فقط صاحب سفارش می‌تواند تأیید کند', 'forbidden');
      if (d.status !== 'pending') fail('این درخواست قبلاً پاسخ داده شده است');
      if (o.status !== 'active') fail('سفارش فعال نیست');
      const amount = p.amount ? num(p.amount, 'مقدار تأیید') : d.amount;
      if (amount > d.amount) fail('مقدار تأیید نمی‌تواند از مقدار درخواست بیشتر باشد');
      // Core rule: accepted total can never exceed what is available.
      if (amount > o.remaining) fail(`فقط ${o.remaining} باقی مانده است؛ نمی‌توان ${amount} را تأیید کرد`, 'conflict');
      o.remaining = round(o.remaining - amount);
      o.updatedAt = now;
      d.acceptedAmount = amount; d.status = 'accepted'; d.updatedAt = now; d.acceptedAt = now;
      const asset = assetById(s, o.assetId);
      const partial = amount < d.amount ? ` (به‌صورت جزئی از ${d.amount})` : '';
      notify(s, now, d.requesterId, `درخواست شما برای ${fmtAmount(o, asset, amount)} ${asset.code}${partial} تأیید شد. اطلاعات تماس طرف مقابل در دسترس است.`, `#deal-${d.id}`);
      if (o.remaining <= 0) {
        o.status = 'filled';
        for (const x of s.deals) {
          if (x.orderId === o.id && x.status === 'pending') {
            x.status = 'rejected'; x.updatedAt = now; x.reason = 'ظرفیت سفارش تکمیل شد';
            notify(s, now, x.requesterId, `ظرفیت سفارش #${o.id} تکمیل شد و درخواست شما بسته شد.`, '#dashboard-sent');
          }
        }
      }
      audit(s, now, me, 'deal.accepted', `deal:${d.id}`, `amount ${amount}, order ${o.id} remaining ${o.remaining}`);
      return { ok: true, remaining: o.remaining };
    },

    'deal.reject'(s, me, p, now) {
      requireUser(s, me);
      const d = byId(s.deals, p.dealId) || fail('درخواست پیدا نشد', 'not_found');
      if (d.ownerId !== me) fail('اجازه ندارید', 'forbidden');
      if (d.status !== 'pending') fail('این درخواست قبلاً پاسخ داده شده است');
      d.status = 'rejected'; d.updatedAt = now; d.reason = str(p.reason, 'دلیل', { required: false, max: 200 });
      notify(s, now, d.requesterId, `درخواست شما برای سفارش #${d.orderId} رد شد.`, '#dashboard-sent');
      audit(s, now, me, 'deal.rejected', `deal:${d.id}`, d.reason);
      return { ok: true };
    },

    'deal.withdraw'(s, me, p, now) {
      requireUser(s, me);
      const d = byId(s.deals, p.dealId) || fail('درخواست پیدا نشد', 'not_found');
      if (d.requesterId !== me) fail('اجازه ندارید', 'forbidden');
      if (d.status !== 'pending') fail('فقط درخواست در انتظار قابل پس‌گرفتن است');
      d.status = 'cancelled'; d.updatedAt = now;
      notify(s, now, d.ownerId, `یک درخواست برای سفارش #${d.orderId} پس گرفته شد.`, '#dashboard-received');
      audit(s, now, me, 'deal.withdrawn', `deal:${d.id}`, '');
      return { ok: true };
    },

    'deal.cancel'(s, me, p, now) {
      const u = requireUser(s, me);
      const d = byId(s.deals, p.dealId) || fail('معامله پیدا نشد', 'not_found');
      if (![d.ownerId, d.requesterId].includes(me) && u.role !== 'admin') fail('اجازه ندارید', 'forbidden');
      if (d.status !== 'accepted') fail('فقط معامله در حال انجام قابل لغو است');
      const o = byId(s.orders, d.orderId);
      d.status = 'cancelled'; d.updatedAt = now; d.reason = str(p.reason, 'دلیل', { required: false, max: 200 });
      // Return the reserved quantity to the order.
      o.remaining = round(o.remaining + d.acceptedAmount);
      if (o.status === 'filled') o.status = (o.expiresAt && o.expiresAt <= now) ? 'expired' : 'active';
      o.updatedAt = now;
      const other = me === d.ownerId ? d.requesterId : d.ownerId;
      notify(s, now, other, `معامله #${d.id} لغو شد${d.reason ? ': ' + d.reason : ''}.`, `#deal-${d.id}`);
      if (u.role === 'admin' && other !== d.ownerId && me !== d.ownerId) notify(s, now, d.ownerId, `معامله #${d.id} توسط مدیر لغو شد.`, `#deal-${d.id}`);
      audit(s, now, me, 'deal.cancelled', `deal:${d.id}`, `returned ${d.acceptedAmount} to order ${o.id}`);
      return { ok: true };
    },

    'deal.complete'(s, me, p, now) {
      requireUser(s, me);
      const d = byId(s.deals, p.dealId) || fail('معامله پیدا نشد', 'not_found');
      if (![d.ownerId, d.requesterId].includes(me)) fail('اجازه ندارید', 'forbidden');
      if (d.status !== 'accepted') fail('این معامله در حال انجام نیست');
      if (me === d.ownerId) d.ownerDone = true; else d.requesterDone = true;
      d.updatedAt = now;
      const other = me === d.ownerId ? d.requesterId : d.ownerId;
      if (d.ownerDone && d.requesterDone) {
        d.status = 'completed'; d.completedAt = now;
        notify(s, now, other, `معامله #${d.id} توسط هر دو طرف نهایی شد.`, `#deal-${d.id}`);
        notify(s, now, me, `معامله #${d.id} نهایی شد.`, `#deal-${d.id}`);
      } else {
        notify(s, now, other, `طرف مقابل معامله #${d.id} را تکمیل‌شده اعلام کرد. لطفاً شما هم تأیید کنید.`, `#deal-${d.id}`);
      }
      audit(s, now, me, 'deal.confirmed', `deal:${d.id}`, d.status);
      return { ok: true, status: d.status };
    },

    'message.send'(s, me, p, now) {
      requireApproved(s, me);
      const d = byId(s.deals, p.dealId) || fail('معامله پیدا نشد', 'not_found');
      if (![d.ownerId, d.requesterId].includes(me)) fail('اجازه ندارید', 'forbidden');
      if (!['accepted', 'completed', 'pending'].includes(d.status)) fail('گفتگوی این معامله بسته است');
      const text = str(p.text, 'پیام', { max: 1000 });
      s.messages.push({ id: nextId(s, 'msg'), dealId: d.id, userId: me, text, at: now });
      const other = me === d.ownerId ? d.requesterId : d.ownerId;
      notify(s, now, other, `پیام جدید در معامله #${d.id}`, `#deal-${d.id}`);
      return { ok: true };
    },

    'notifications.read'(s, me, p) {
      requireUser(s, me);
      s.notifications.forEach((n) => { if (n.userId === me && (!p.id || n.id === Number(p.id))) n.read = true; });
      return { ok: true, _quiet: true };
    },

    'report.create'(s, me, p, now) {
      requireApproved(s, me);
      const target = userById(s, p.userId) || fail('کاربر پیدا نشد', 'not_found');
      if (target.id === me) fail('نمی‌توانید خودتان را گزارش دهید');
      const r = { id: nextId(s, 'report'), reporterId: me, userId: target.id, dealId: p.dealId ? Number(p.dealId) : null,
        reason: str(p.reason, 'شرح گزارش', { max: 500 }), status: 'open', createdAt: now };
      s.reports.push(r);
      notifyAdmins(s, now, `گزارش جدید درباره «${displayName(target)}»`, '#admin-reports');
      audit(s, now, me, 'report.created', `user:${target.id}`, r.reason);
      return { ok: true };
    },

    /* ----- admin ----- */
    'admin.user.setStatus'(s, me, p, now) {
      requireAdmin(s, me);
      const u = userById(s, p.userId) || fail('کاربر پیدا نشد', 'not_found');
      if (!USER_STATUS[p.status]) fail('وضعیت نامعتبر');
      if (u.id === me && p.status !== 'approved') fail('نمی‌توانید حساب خودتان را مسدود کنید');
      const reason = str(p.reason, 'دلیل', { required: p.status === 'rejected', max: 300 });
      u.status = p.status;
      u.reviewedAt = now; u.reviewedBy = me;
      u.statusReason = p.status === 'approved' ? '' : reason;
      if (p.status === 'blocked' || p.status === 'rejected') {
        for (const o of s.orders) if (o.userId === u.id && o.status === 'active') { o.status = 'closed'; o.updatedAt = now; }
        for (const d of s.deals) if (d.requesterId === u.id && d.status === 'pending') { d.status = 'cancelled'; d.updatedAt = now; }
      }
      const msg = {
        approved: '✅ تبریک! حساب شما توسط مدیریت سرای شهزاده تأیید شد. اکنون می‌توانید سفارش ثبت کنید و معامله کنید.',
        rejected: `❌ درخواست عضویت شما رد شد. دلیل: ${reason}. می‌توانید مشخصات را اصلاح کرده و دوباره ارسال کنید.`,
        blocked: `⛔ حساب شما مسدود شد.${reason ? ' دلیل: ' + reason : ''}`,
        pending: 'وضعیت حساب شما به «در انتظار بررسی» تغییر کرد.',
      }[p.status];
      notify(s, now, u.id, msg, '#profile');
      audit(s, now, me, 'admin.user.status', `user:${u.id}`, p.status + (reason ? ': ' + reason : ''));
      return { ok: true };
    },
    'account.resubmit'(s, me, p, now) {
      const u = userById(s, me) || fail('ابتدا وارد حساب شوید', 'unauthorized');
      if (u.status !== 'rejected') fail('فقط درخواست ردشده قابل ارسال دوباره است');
      if (p.name !== undefined) u.name = str(p.name, 'نام', { max: 80 });
      if (p.company !== undefined) u.company = str(p.company, 'نام صرافی', { max: 80 });
      if (p.whatsapp !== undefined) u.whatsapp = normPhone(toLatinDigits(p.whatsapp)) || u.phone;
      if (p.activity !== undefined && ACTIVITIES[p.activity]) u.activity = p.activity;
      Object.assign(u, kycFields(p));
      u.status = 'pending'; u.statusReason = ''; u.resubmittedAt = now;
      notifyAdmins(s, now, `«${displayName(u)}» مشخصات خود را اصلاح و دوباره برای بررسی فرستاد.`, `#admin-review-${u.id}`);
      notify(s, now, u.id, 'درخواست شما دوباره برای مدیریت ارسال شد. نتیجه بررسی به شما اعلام می‌شود.', '#profile');
      audit(s, now, me, 'user.resubmit', `user:${u.id}`, '');
      return { ok: true };
    },
    'admin.user.setRole'(s, me, p, now) {
      requireAdmin(s, me);
      const u = userById(s, p.userId) || fail('کاربر پیدا نشد', 'not_found');
      if (!['admin', 'member'].includes(p.role)) fail('نقش نامعتبر');
      if (u.id === me && p.role !== 'admin') fail('نمی‌توانید نقش مدیر را از خودتان بگیرید');
      u.role = p.role;
      audit(s, now, me, 'admin.user.role', `user:${u.id}`, p.role);
      return { ok: true };
    },
    'admin.asset.save'(s, me, p, now) {
      requireAdmin(s, me);
      const code = str(p.code, 'کد دارایی', { max: 12 }).toUpperCase();
      const data = { code, name: str(p.name, 'نام دارایی', { max: 40 }), unit: str(p.unit, 'واحد مقدار', { max: 12 }),
        priceCurrency: str(p.priceCurrency, 'واحد قیمت', { max: 12 }), kind: p.kind === 'metal' ? 'metal' : 'currency' };
      let a = p.id ? assetById(s, p.id) : null;
      if (s.assets.some((x) => x.code === code && (!a || x.id !== a.id))) fail('این کد قبلاً ثبت شده است', 'conflict');
      if (a) Object.assign(a, data);
      else { a = { id: nextId(s, 'asset'), ...data, active: true }; s.assets.push(a); }
      audit(s, now, me, 'admin.asset.save', `asset:${a.id}`, code);
      return { assetId: a.id };
    },
    'admin.asset.toggle'(s, me, p, now) {
      requireAdmin(s, me);
      const a = assetById(s, p.assetId) || fail('دارایی پیدا نشد', 'not_found');
      a.active = !a.active;
      audit(s, now, me, 'admin.asset.toggle', `asset:${a.id}`, String(a.active));
      return { ok: true };
    },
    'admin.rate.set'(s, me, p, now) {
      requireAdmin(s, me);
      const a = assetById(s, p.assetId) || fail('دارایی پیدا نشد', 'not_found');
      const buy = num(p.buy, 'نرخ خرید'), sell = num(p.sell, 'نرخ فروش');
      let r = s.rates.find((x) => x.assetId === a.id);
      const prevMid = r ? (r.buy + r.sell) / 2 : null;
      if (!r) { r = { assetId: a.id }; s.rates.push(r); }
      Object.assign(r, { buy, sell, updatedAt: now, prevMid, currency: str(p.currency || a.priceCurrency, 'واحد', { max: 12 }) });
      s.rateHistory.push({ assetId: a.id, at: now, buy, sell });
      if (s.rateHistory.length > 5000) s.rateHistory.splice(0, s.rateHistory.length - 5000);
      audit(s, now, me, 'admin.rate.set', `asset:${a.id}`, `${buy}/${sell}`);
      return { ok: true };
    },
    'admin.report.resolve'(s, me, p, now) {
      requireAdmin(s, me);
      const r = byId(s.reports, p.reportId) || fail('گزارش پیدا نشد', 'not_found');
      r.status = 'resolved'; r.resolvedAt = now; r.note = str(p.note, 'یادداشت', { required: false, max: 300 });
      audit(s, now, me, 'admin.report.resolve', `report:${r.id}`, r.note);
      return { ok: true };
    },
    'admin.broadcast'(s, me, p, now) {
      requireAdmin(s, me);
      const text = str(p.text, 'متن اعلان', { max: 300 });
      s.users.filter((u) => u.status === 'approved').forEach((u) => notify(s, now, u.id, `📢 ${text}`, ''));
      audit(s, now, me, 'admin.broadcast', null, text);
      return { ok: true };
    },
  };

  function dispatch(state, actorId, type, payload, { now }) {
    const fn = actions[type];
    if (!fn) fail('عملیات نامعتبر');
    sweep(state, now);
    const result = fn(state, actorId == null ? null : Number(actorId), payload || {}, now) || {};
    if (!result._quiet) state.version++;
    return result;
  }

  /* ---------- per-user view (what a given user is allowed to see) ---------- */
  function publicUser(u, { contact = false, self = false, kyc = false } = {}) {
    if (!u) return null;
    const out = { id: u.id, name: u.name, company: u.company, activity: u.activity, status: u.status, role: u.role, createdAt: u.createdAt, bio: u.bio || '' };
    if (self || (contact && u.showContact)) { out.phone = u.phone; out.whatsapp = u.whatsapp; }
    if (self) out.showContact = u.showContact;
    if (self || kyc) {
      Object.assign(out, { province: u.province || '', city: u.city || '', address: u.address || '', experience: u.experience || '',
        guarantorName: u.guarantorName || '', guarantorPhone: u.guarantorPhone || '', about: u.about || '',
        statusReason: u.statusReason || '', reviewedAt: u.reviewedAt || null, resubmittedAt: u.resubmittedAt || null });
    }
    return out;
  }

  function buildView(state, actorId, { now } = {}) {
    if (now) sweep(state, now);
    const me = actorId != null ? userById(state, actorId) : null;
    const isAdmin = !!(me && me.role === 'admin' && me.status === 'approved');
    const canSeeMarket = !!me && me.status === 'approved';
    const myDeals = me ? state.deals.filter((d) => isAdmin || d.ownerId === me.id || d.requesterId === me.id) : [];
    const contactWith = new Set();
    if (me) for (const d of state.deals) {
      if (['accepted', 'completed'].includes(d.status)) {
        if (d.ownerId === me.id) contactWith.add(d.requesterId);
        if (d.requesterId === me.id) contactWith.add(d.ownerId);
      }
      if (d.status === 'pending' && d.ownerId === me.id) contactWith.add(d.requesterId); // owner sees requester info
    }
    const users = state.users.map((u) => publicUser(u, { contact: isAdmin || contactWith.has(u.id), self: me && u.id === me.id }));
    // Market is public in summary for guests (no names/contacts); full for approved members.
    const orders = state.orders
      .filter((o) => canSeeMarket ? (o.status === 'active' || isAdmin || o.userId === me.id || myDeals.some((d) => d.orderId === o.id)) : o.status === 'active')
      .map((o) => (canSeeMarket ? o : { ...o, userId: null, note: '' }));
    const stats = {
      members: state.users.filter((u) => u.status === 'approved').length,
      activeOrders: state.orders.filter((o) => o.status === 'active').length,
      completedDeals: state.deals.filter((d) => d.status === 'completed').length,
      activeDeals: state.deals.filter((d) => d.status === 'accepted').length,
      sellOrders: state.orders.filter((o) => o.status === 'active' && o.side === 'sell').length,
      buyOrders: state.orders.filter((o) => o.status === 'active' && o.side === 'buy').length,
    };
    const view = {
      version: state.version,
      me: me ? publicUser(me, { self: true }) : null,
      assets: state.assets,
      rates: state.rates,
      rateHistory: state.rateHistory.slice(-600),
      orders, stats,
      users: canSeeMarket ? users.filter((u) => isAdmin || u.status === 'approved' || u.id === me.id) : [],
      deals: myDeals,
      messages: me ? state.messages.filter((m) => myDeals.some((d) => d.id === m.dealId && (d.ownerId === me.id || d.requesterId === me.id))) : [],
      notifications: me ? state.notifications.filter((n) => n.userId === me.id).slice(-100).reverse() : [],
    };
    if (isAdmin) {
      view.admin = {
        users: state.users.map((u) => publicUser(u, { contact: true, kyc: true })),
        reports: state.reports,
        audit: state.audit.slice(-300).reverse(),
        auditIntact: verifyAudit(state),
      };
    }
    return view;
  }

  function verifyAudit(state) {
    let prev = 'genesis';
    for (const e of state.audit) {
      const { hash, ...rest } = e;
      if (chainHash(prev + JSON.stringify(rest)) !== hash) return false;
      prev = hash;
    }
    return true;
  }

  /* ---------- demo data ---------- */
  function seed(state, { now, hashPassword }) {
    const H = 3600e3;
    const mk = (name, phone, company, activity, role = 'member', status = 'approved') => {
      const u = { id: nextId(state, 'user'), name, phone, whatsapp: phone, company, activity, role, status, showContact: true, bio: '', createdAt: status === 'pending' ? now - 2 * H : now - 30 * 24 * H,
        province: 'کابل', city: 'کابل', address: 'سرای شهزاده، منزل دوم، دکان ' + (10 + state.users.length), experience: (3 + state.users.length * 2) + ' سال', guarantorName: role === 'admin' ? '' : 'حاجی محمود', guarantorPhone: role === 'admin' ? '' : '0799000111', about: '', passHash: hashPassword(role === 'admin' ? 'admin123' : '123456') };
      state.users.push(u); return u;
    };
    const admin = mk('مدیر سیستم', '0700000000', 'مدیریت سرای شهزاده', 'other', 'admin');
    const u1 = mk('حاجی احمد کریمی', '0700000001', 'صرافی کریمی', 'saraf');
    const u2 = mk('محمد نادر', '0700000002', 'صرافی نادر', 'saraf');
    const u3 = mk('عبدالرحیم زرگر', '0700000003', 'زرگری رحیمی', 'zargar');
    const u4 = mk('فرید احمدی', '0700000004', 'تجارتی احمدی', 'tajer');
    mk('سمیع‌الله', '0700000005', 'صرافی سمیع', 'saraf', 'member', 'pending');
    void admin;
    const assets = [
      ['USD', 'دالر آمریکا', 'USD', 'AFN', 'currency'], ['EUR', 'یورو', 'EUR', 'AFN', 'currency'],
      ['GBP', 'پوند انگلیس', 'GBP', 'AFN', 'currency'], ['PKR', 'کلدار پاکستان', 'PKR', 'AFN', 'currency'],
      ['IRR', 'تومان ایران', 'IRT', 'AFN', 'currency'], ['AED', 'درهم امارات', 'AED', 'AFN', 'currency'],
      ['XAU', 'طلا', 'OZ', 'USD', 'metal'], ['XAG', 'نقره', 'KG', 'USD', 'metal'],
    ].map(([code, name, unit, priceCurrency, kind]) => {
      const a = { id: nextId(state, 'asset'), code, name, unit, priceCurrency, kind, active: true }; state.assets.push(a); return a;
    });
    const A = Object.fromEntries(assets.map((a) => [a.code, a]));
    const base = { USD: [65.2, 65.35], EUR: [70.6, 70.9], GBP: [82.4, 82.9], PKR: [0.232, 0.235], IRR: [0.00079, 0.00082], AED: [17.7, 17.85], XAU: [4490, 4510], XAG: [51.5, 52.3] };
    for (const [code, [b, sl]] of Object.entries(base)) {
      for (let i = 14; i >= 1; i--) {
        const wobble = 1 + Math.sin(i * 1.7 + code.length) * 0.006 + (14 - i) * 0.0004;
        state.rateHistory.push({ assetId: A[code].id, at: now - i * 24 * H, buy: round(b * wobble, 6), sell: round(sl * wobble, 6) });
      }
      const last = state.rateHistory[state.rateHistory.length - 1];
      state.rates.push({ assetId: A[code].id, buy: b, sell: sl, currency: A[code].priceCurrency, updatedAt: now - 2 * H, prevMid: (last.buy + last.sell) / 2 });
      state.rateHistory.push({ assetId: A[code].id, at: now - 2 * H, buy: b, sell: sl });
    }
    const ord = (u, side, code, amount, price, note = '', ageH = 1) => {
      const a = A[code];
      const o = { id: nextId(state, 'order'), userId: u.id, side, assetId: a.id, amount, remaining: amount, minAmount: 0, price, priceCurrency: a.priceCurrency, unit: a.unit, note, status: 'active', createdAt: now - ageH * H, expiresAt: now + 24 * H, updatedAt: now - ageH * H };
      state.orders.push(o); return o;
    };
    const o1 = ord(u1, 'sell', 'USD', 40000, 65.30, 'تحویل نقد در سرای شهزاده', 3);
    ord(u2, 'buy', 'USD', 20000, 65.20, '', 2);
    ord(u4, 'sell', 'XAG', 40, 52, 'نقره خالص ۹۹۹', 5);
    ord(u3, 'sell', 'XAU', 10, 4500, 'شمش استاندارد', 4);
    ord(u2, 'sell', 'EUR', 15000, 70.85, '', 6);
    ord(u4, 'buy', 'PKR', 2000000, 0.233, 'نیاز فوری', 1);
    ord(u1, 'buy', 'AED', 50000, 17.75, '', 7);
    // A partially filled sell order with requests in various states.
    const d1 = { id: nextId(state, 'deal'), orderId: o1.id, ownerId: u1.id, requesterId: u2.id, amount: 15000, acceptedAmount: 15000, price: o1.price, note: 'امروز تحویل می‌گیرم', status: 'accepted', ownerDone: false, requesterDone: false, createdAt: now - 2 * H, updatedAt: now - H, acceptedAt: now - H };
    const d2 = { id: nextId(state, 'deal'), orderId: o1.id, ownerId: u1.id, requesterId: u3.id, amount: 10000, acceptedAmount: 0, price: o1.price, note: '', status: 'pending', ownerDone: false, requesterDone: false, createdAt: now - 0.5 * H, updatedAt: now - 0.5 * H };
    const d3 = { id: nextId(state, 'deal'), orderId: o1.id, ownerId: u1.id, requesterId: u4.id, amount: 20000, acceptedAmount: 0, price: o1.price, note: 'در صورت امکان کامل', status: 'pending', ownerDone: false, requesterDone: false, createdAt: now - 0.3 * H, updatedAt: now - 0.3 * H };
    state.deals.push(d1, d2, d3);
    o1.remaining = 25000;
    state.messages.push({ id: nextId(state, 'msg'), dealId: d1.id, userId: u2.id, text: 'سلام، ساعت ۲ در دفتر شما هستم.', at: now - 0.8 * H });
    state.messages.push({ id: nextId(state, 'msg'), dealId: d1.id, userId: u1.id, text: 'قبول، منتظرتان هستم.', at: now - 0.7 * H });
    notify(state, now - 0.5 * H, u1.id, '«زرگری رحیمی» درخواست خرید 10,000 USD از سفارش #1 فرستاد.', '#dashboard-received');
    notify(state, now - 0.3 * H, u1.id, '«تجارتی احمدی» درخواست خرید 20,000 USD از سفارش #1 فرستاد.', '#dashboard-received');
    notify(state, now - H, u2.id, 'درخواست شما برای 15,000 USD تأیید شد.', `#deal-${d1.id}`);
    audit(state, now, null, 'system.seed', null, 'demo data');
    state.version++;
    return state;
  }

  return {
    ACTIVITIES, ORDER_STATUS, DEAL_STATUS, USER_STATUS, PROVINCES, EngineError,
    emptyState, register, login, dispatch, buildView, seed, verifyAudit, sweep, actions: Object.keys(actions),
  };
});
