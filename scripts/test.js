// End-to-end API tests: start the server on a temporary database and exercise trading, membership review and security.
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarai-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.TELEGRAM_FETCH = '0';
const { server, totpAt, parseTelegramHtml } = require('../server.js');
const Engine = require('../shared/engine.js');
const { DatabaseSync: DatabaseSyncCheck } = require('node:sqlite');

function client(base, scope = 'user') {
  let cookie = '';
  const headers = () => ({ cookie, ...(scope === 'admin' ? { 'X-Scope': 'admin' } : {}) });
  const call = async (p, body) => {
    const res = await fetch(base + p, body === undefined ? { headers: headers() } : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  return {
    call,
    login: (phone, password, code) => call(scope === 'admin' ? '/api/admin/login' : '/api/login', { phone, password, code }),
    act: (type, payload, password) => call('/api/action', { type, payload, password }),
    state: () => call('/api/state').then((r) => r.data),
  };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const guest = client(base), seller = client(base), b1 = client(base), b2 = client(base), b3 = client(base);
  const admin = client(base, 'admin'), adminAsUser = client(base), fresh = client(base);
  let ok = 0; const pass = (m) => { ok++; console.log('  ✓', m); };

  /* --- public access --- */
  const g = await guest.state();
  assert(g.orders.length > 0 && g.orders.every((o) => o.userId === null) && g.users.length === 0); pass('guests see the market without identities');
  assert((await guest.act('order.create', {})).status === 401); pass('guests cannot trade');

  /* --- login & lockout --- */
  assert.equal((await seller.login('0700000001', 'wrong')).status, 401); pass('wrong password rejected');
  const victim = client(base);
  for (let i = 0; i < 5; i++) await victim.login('0700000004', 'bad');
  assert.equal((await victim.login('0700000004', '123456')).status, 423); pass('account locks after 5 failed attempts');

  await seller.login('0700000001', '123456'); await b1.login('0700000002', '123456'); await b2.login('0700000003', '123456');
  await adminAsUser.login('0700000000', 'admin123');

  /* --- trading flow --- */
  const usd = (await seller.state()).assets.find((a) => a.code === 'USD');
  const r = await seller.act('order.create', { assetId: usd.id, side: 'sell', amount: '40,000', price: 65.3, validHours: 24 });
  assert.equal(r.status, 200); const oid = r.data.result.orderId; pass('seller posts 40,000 USD @ 65.30');
  assert.equal((await seller.act('order.create', { assetId: usd.id, side: 'sell', amount: 40000, price: 65.3 })).status, 409); pass('duplicate order blocked');
  const q1 = await b1.act('deal.request', { orderId: oid, amount: 20000 });
  const q2 = await b2.act('deal.request', { orderId: oid, amount: 15000 });
  const q3 = await adminAsUser.act('deal.request', { orderId: oid, amount: 10000 });
  assert([q1, q2, q3].every((x) => x.status === 200)); pass('three buyers request 20k / 15k / 10k');
  assert.equal((await b1.act('deal.request', { orderId: oid, amount: 5 })).status, 409); pass('second pending request blocked');
  assert.equal((await b1.act('deal.request', { orderId: oid, amount: 50000 })).status, 400); pass('request above remaining blocked');
  const d1 = q1.data.result.dealId, d2 = q2.data.result.dealId, d3 = q3.data.result.dealId;
  assert.equal((await b1.act('deal.accept', { dealId: d1 })).status, 403); pass('only the owner can accept');
  await seller.act('deal.accept', { dealId: d1 });
  await seller.act('deal.accept', { dealId: d2 });
  let o = (await seller.state()).orders.find((x) => x.id === oid);
  assert.equal(o.remaining, 5000); pass('remaining is 5,000 after accepting 35,000');
  assert.equal((await seller.act('deal.accept', { dealId: d3, amount: 10000 })).status, 409); pass('over-allocation refused');
  await seller.act('deal.accept', { dealId: d3, amount: 5000 });
  o = (await seller.state()).orders.find((x) => x.id === oid);
  assert(o.remaining === 0 && o.status === 'filled'); pass('partial acceptance fills the order');
  await b1.act('message.send', { dealId: d1, text: 'سلام' });
  assert((await seller.state()).messages.some((m) => m.text === 'سلام')); pass('deal messages delivered');
  await b2.act('deal.cancel', { dealId: d2, reason: 'test' });
  o = (await seller.state()).orders.find((x) => x.id === oid);
  assert(o.remaining === 15000 && o.status === 'active'); pass('cancelled deal returns quantity and reopens order');
  await seller.act('deal.complete', { dealId: d1 }); await b1.act('deal.complete', { dealId: d1 });
  assert.equal((await b1.state()).deals.find((x) => x.id === d1).status, 'completed'); pass('deal completes after both confirmations');

  /* --- admin separation & 2FA --- */
  assert.equal((await adminAsUser.act('admin.user.setStatus', { userId: 2, status: 'blocked' })).status, 403); pass('admin actions refused from a public-site session');
  assert(!(await adminAsUser.state()).admin); pass('public session never receives admin data');
  assert.equal((await client(base, 'admin').login('0700000001', '123456')).status, 403); pass('non-admin cannot open the admin panel');
  assert.equal((await admin.login('0700000000', 'admin123')).status, 200); pass('admin signs in to the panel');
  const setup = await admin.call('/api/admin/2fa/setup', {});
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await admin.call('/api/admin/2fa/enable', { password: 'admin123', code: totpAt(setup.data.secret, step) })).status, 200); pass('admin enables two-step verification');
  const admin2 = client(base, 'admin');
  assert((await admin2.login('0700000000', 'admin123')).data.need2fa); pass('panel login asks for the second factor');
  assert.equal((await admin2.login('0700000000', 'admin123', '000000')).status, 401); pass('wrong second-factor code rejected');
  assert.equal((await admin2.login('0700000000', 'admin123', totpAt(setup.data.secret, step + 1))).status, 200); pass('correct code opens the panel');

  /* --- membership review --- */
  assert.equal((await client(base).call('/api/register', { name: 'x', phone: '0788888888', company: 'x', activity: 'saraf', password: '12345678' })).status, 400); pass('registration requires province and office address');
  assert.equal((await client(base).call('/api/register', { name: 'x', phone: '0788888887', company: 'x', activity: 'saraf', password: '123', province: 'کابل', address: 'x' })).status, 400); pass('short passwords refused');
  await fresh.call('/api/register', { name: 'تست', phone: '0799999999', company: 'صرافی تست', activity: 'saraf', password: '12345678', province: 'هرات', address: 'سرای شهزاده دکان ۵' });
  let adm = await admin.state();
  const applicant = adm.admin.pending.find((u) => u.phone === '0799999999');
  assert(applicant && applicant.province === 'هرات' && applicant.address); pass('admin sees the applicant with full details');
  assert(adm.notifications.some((n) => n.text.includes('صرافی تست'))); pass('admin notified of the application');
  assert.equal((await fresh.act('order.create', { assetId: usd.id, side: 'buy', amount: 1, price: 1 })).status, 403); pass('pending member cannot trade');
  assert.equal((await admin.act('admin.user.setStatus', { userId: applicant.id, status: 'rejected' })).status, 400); pass('rejection requires a reason');
  await admin.act('admin.user.setStatus', { userId: applicant.id, status: 'rejected', reason: 'آدرس ناقص است' });
  let fv = await fresh.state();
  assert(fv.me.status === 'rejected' && fv.me.statusReason === 'آدرس ناقص است' && fv.notifications[0].text.includes('رد شد')); pass('applicant notified of rejection with the reason');
  await fresh.act('account.resubmit', { province: 'کابل', address: 'سرای شهزاده، منزل دوم، دکان ۵' });
  assert.equal((await fresh.state()).me.status, 'pending'); pass('applicant corrects details and resubmits');
  await admin.act('admin.user.setStatus', { userId: applicant.id, status: 'approved' });
  assert((await fresh.state()).notifications[0].text.includes('تأیید شد')); pass('applicant notified of approval');
  assert.equal((await fresh.act('order.create', { assetId: usd.id, side: 'buy', amount: 1000, price: 65.1 })).status, 200); pass('approved member can trade');
  const search = await admin.call('/api/admin/users?q=' + encodeURIComponent('تست'));
  assert.equal(search.data.users[0].phone, '0799999999'); pass('admin member search works');

  /* --- official rates integrity --- */
  assert.equal((await admin.act('admin.rate.set', { assetId: usd.id, buy: 65.4, sell: 65.5 })).status, 401); pass('rate change needs the admin password');
  assert.equal((await admin.act('admin.rate.set', { assetId: usd.id, buy: 65.4, sell: 65.5 }, 'admin123')).status, 200); pass('rate change with password succeeds');
  assert.equal((await admin.act('admin.rate.set', { assetId: usd.id, buy: 90, sell: 90.2 }, 'admin123')).status, 428); pass('rate jump above 15% needs explicit confirmation');
  assert.equal((await admin.act('admin.rate.set', { assetId: usd.id, buy: 66, sell: 60 }, 'admin123')).status, 400); pass('sell below buy refused');
  const rate = (await guest.state()).rates.find((x) => x.key === 'USD|AFN|کابل|cash');
  assert(rate.buy === 65.4 && rate.sell === 65.5); pass('public sees only the verified rate');

  /* --- Telegram rates --- */
  const html = '<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="kabul_dalarr_Toman/126571"><a class="tgme_widget_message_reply"><div class="tgme_widget_message_text js-message_reply_text">quoted old text</div></a><div class="tgme_widget_message_text js-message_text" dir="auto">دالر به افغانی <i class="emoji" style=""><b>🇺🇲</b></i> کابل<br/>خرید 64.92 &#33; فروش 64.94</div><a class="tgme_widget_message_date"><time datetime="2026-11-07T04:16:00+00:00" class="time">08:46</time></a></div></div>';
  const tm = parseTelegramHtml(html);
  assert(tm.length === 1 && tm[0].msgId === '126571' && tm[0].text.includes('خرید 64.92') && !tm[0].text.includes('quoted') && tm[0].postedAt === Date.parse('2026-11-07T04:16:00Z')); pass('channel page parsed (id, text, time; quoted replies ignored)');
  {
    const M = Engine.MemoryStore(); const t0 = Date.now();
    Engine.ensureCurrencies(M); Engine.ensureDefaultSource(M, { now: t0 });
    const src = M.one('sources', {});
    const ing = (id, min, text) => Engine.ingestMessage(M, { now: t0 }, src, { msgId: id, postedAt: t0 + min * 60e3, text });
    const adm = Engine.createAdmin(M, { phone: '0700000999', password: 'x'.repeat(10), now: t0 }, { hashPassword: (x) => x });
    assert.equal(ing(1, 1, 'دالر به افغانی 🇺🇲 🇦🇫 کابل\nخرید 64.88 🔺💵🔻 فروش 64.90').status, 'review'); pass('first rate of a new instrument needs admin approval');
    const first = M.one('tgMessages', { msgId: '1' });
    Engine.dispatch(M, adm.id, 'admin.message.apply', { id: first.id, items: first.items }, { now: t0, scope: 'admin' });
    let r = M.one('rates', { key: 'USD|AFN|کابل|cash' });
    assert(r && r.buy === 64.88 && r.sell === 64.9); pass('buy and sell extracted into separate fields');
    ing(2, 2, 'دالر به افغانی کابل\nخرید 64.92 فروش 64.94');
    r = M.one('rates', { key: 'USD|AFN|کابل|cash' });
    assert(r.prevBuy === 64.88 && r.buy === 64.92 && M.count('rateHistory', {}) === 2); pass('new message replaces rate, keeps history and previous values');
    assert.equal(ing(2, 2, 'دالر به افغانی کابل\nخرید 64.92 فروش 64.94').status, 'duplicate'); pass('duplicate message ignored');
    assert.equal(ing(0, -5, 'دالر به افغانی کابل\nخرید 60 فروش 60.1').status, 'stale'); pass('older message never overwrites a newer rate');
    assert.equal(ing(3, 3, 'دالر به افغانی کابل\nخرید 72 فروش 72.1').status, 'review'); pass('jump above 10% goes to review');
    assert.equal(ing(4, 4, 'دالر به افغانی کابل\nفروش 64.90 خرید 64.95').status, 'review'); pass('buy above sell (possible swap) goes to review');
    assert.equal(ing(5, 5, 'هرات\nدالر به تومان\n258.500 نرخ نقدی').status, 'review'); pass('unlabelled rate goes to review (no guessing)');
    ing(6, 6, 'کلدار به افغانی کابل\nخرید 2.30');
    const m6 = M.one('tgMessages', { msgId: '6' });
    Engine.dispatch(M, adm.id, 'admin.message.apply', { id: m6.id, items: m6.items }, { now: t0, scope: 'admin' });
    r = M.one('rates', { key: 'PKR|AFN|کابل|cash' });
    assert(r.buy === 2.3 && r.sell === null); pass('buy-only message stores buy only');
    const it = Engine.parseRateMessage('دالر به تومان هرات\nخرید 258.500 فروش 259.000', { assets: M.find('assets', {}) })[0];
    assert(it.quote === 'IRT' && it.buy === 258500 && it.sell === 259000); pass('toman thousands separators parsed correctly');
    assert.equal(ing(7, 7, 'دالر به افغانی کندهار\nخرید 64.95 فروش 64.97').status, 'applied'); pass('new city accepted automatically when consistent with another city');
    const fa = Engine.parseRateMessage('دالر به افغانی کابل خرید ۶۴٫۹۲ فروش ۶۴٫۹۴', { assets: M.find('assets', {}) })[0];
    assert(fa.buy === 64.92 && fa.sell === 64.94); pass('Persian digits and decimal separator parsed exactly');
    const ex = Engine.parseRateMessage('دالر به افغانی خرید 1e9 فروش 1e10', { assets: M.find('assets', {}) })[0];
    assert(ex.issues.length > 0); pass('malformed numbers flagged, never published');
    const ns = Engine.parseRateMessage('دالر به افغانی کابل\nخرید 64.90 فروش', { assets: M.find('assets', {}) })[0];
    assert(ns.buy === 64.9 && ns.sell === null); pass('a number is never reused for both buy and sell');
    const kd = Engine.parseRateMessage('دالر به افغانی 🇺🇲 🇦🇫 لوی کندهار\nخرید 64.97 🔺💵🔻 فروش 65.00', { assets: M.find('assets', {}) })[0];
    assert(kd.market === 'کندهار' && kd.buy === 64.97 && kd.sell === 65); pass('city detected (Kandahar)');
  }
  const paste = await admin.act('admin.message.paste', { text: 'یورو به افغانی کابل\nخرید 70.10 فروش 70.40' });
  assert.equal(paste.data.result.status, 'review'); pass('pasted message queued for review');
  const msgs = await admin.call('/api/admin/messages?status=review');
  const pm = msgs.data.messages[0];
  assert(pm.items[0].code === 'EUR' && pm.items[0].buy === 70.1); pass('review queue shows parsed values');
  assert.equal((await admin.act('admin.message.apply', { id: pm.id, items: [pm.items[0]] })).status, 401); pass('applying reviewed rates needs the password');
  assert.equal((await admin.act('admin.message.apply', { id: pm.id, items: [pm.items[0]] }, 'admin123')).status, 200); pass('admin applies reviewed rate');
  const eur = (await guest.state()).rates.find((x) => x.key === 'EUR|AFN|کابل|cash');
  assert(eur && eur.buy === 70.1 && eur.sell === 70.4 && eur.kind === 'reviewed'); pass('reviewed rate published');
  await admin.act('admin.rate.set', { code: 'EUR', quote: 'AFN', market: 'کابل', settlement: 'cash', sell: 70.5 }, 'admin123');
  let eur2 = (await guest.state()).rates.find((x) => x.key === 'EUR|AFN|کابل|cash');
  assert(eur2.manual && eur2.sell === 70.5 && eur2.buy === 70.1); pass('manual edit of one side marked as manual');
  await admin.act('admin.rate.auto', { key: 'EUR|AFN|کابل|cash' }, 'admin123');
  assert(!(await guest.state()).rates.find((x) => x.key === 'EUR|AFN|کابل|cash').manual); pass('rate returned to automatic mode');
  const hist = await guest.call('/api/rates/history?key=' + encodeURIComponent('EUR|AFN|کابل|cash') + '&period=today');
  assert(hist.data.points.length === 2); pass('history endpoint returns all changes');
  assert.equal((await admin.act('admin.source.save', { channel: 'https://t.me/another_rates_ch', defaultMarket: 'هرات' }, 'admin123')).status, 200); pass('new Telegram source can be added');

  /* --- elite: fixing, signatures, status, sessions, anomaly --- */
  {
    const M = Engine.MemoryStore(); const t0 = Date.now() - 40 * 60e3;
    Engine.ensureCurrencies(M); Engine.ensureDefaultSource(M, { now: t0 });
    const adm = Engine.createAdmin(M, { phone: '0700000998', password: 'x'.repeat(10), now: t0 }, { hashPassword: (x) => x });
    const src = M.one('sources', {});
    Engine.ingestMessage(M, { now: t0 }, src, { msgId: 'a0', postedAt: t0, text: 'دالر به افغانی کابل\nخرید 64.90 فروش 64.92' });
    const m0 = M.one('tgMessages', { msgId: 'a0' });
    Engine.dispatch(M, adm.id, 'admin.message.apply', { id: m0.id, items: m0.items }, { now: t0, scope: 'admin' });
    let v = 64.92;
    for (let i = 1; i <= 25; i++) { v = Math.round((v + (i % 2 ? 0.01 : -0.01)) * 100) / 100; Engine.ingestMessage(M, { now: t0 }, src, { msgId: 'a' + i, postedAt: t0 + i * 60e3, text: `دالر به افغانی کابل\nخرید ${(v - 0.02).toFixed(2)} فروش ${v.toFixed(2)}` }); }
    const st = Engine.ingestMessage(M, { now: t0 }, src, { msgId: 'a99', postedAt: t0 + 30 * 60e3, text: 'دالر به افغانی کابل\nخرید 65.98 فروش 66.00' });
    const iss = M.one('tgMessages', { msgId: 'a99' }).items[0].issues.join(' ');
    assert(st.status === 'review' && iss.includes('آماری')); pass('statistical outlier (5σ) held for review even below the 10% limit');
  }
  const fx = await admin.act('admin.fixing.run', {}, 'admin123');
  assert.equal(fx.status, 200); pass('daily reference rate published');
  assert.equal((await admin.act('admin.fixing.run', {}, 'admin123')).status, 400); pass('reference rate can be published only once per day');
  const fl = await guest.call('/api/public/fixings');
  const fix = fl.data.fixings[0];
  assert(fix && fix.signature && fix.payload); pass('reference rate is digitally signed (Ed25519)');
  const ver = await guest.call('/api/public/verify?id=' + fix.id);
  assert.equal(ver.data.valid, true); pass('signature verifies with the public key');
  const crypto = require('node:crypto');
  const pk = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(fl.data.publicKey, 'base64')]), format: 'der', type: 'spki' });
  const tampered = fix.payload.replace(/"sell":[0-9.]+/, '"sell":99');
  assert(crypto.verify(null, Buffer.from(fix.payload), pk, Buffer.from(fix.signature, 'base64')) && !crypto.verify(null, Buffer.from(tampered), pk, Buffer.from(fix.signature, 'base64'))); pass('independent verification works; a changed price fails');
  assert.throws(() => new DatabaseSyncCheck(process.env.DB_PATH).exec("UPDATE t_fixings SET data = '{}'")); pass('reference rates cannot be altered in the database');
  const pub = await guest.call('/api/public/rates');
  assert(crypto.verify(null, Buffer.from(JSON.stringify(pub.data.rates)), pk, Buffer.from(pub.data.signature, 'base64'))); pass('public API snapshot is signed');
  const stat = await guest.call('/api/public/status');
  assert(stat.data.status === 'operational' && stat.data.data.auditIntact && Array.isArray(stat.data.sources)); pass('public status endpoint');
  const ses = await seller.call('/api/sessions');
  assert(ses.data.sessions.some((x) => x.current)); pass('member sees active sessions');
  const other = client(base); await other.login('0700000001', '123456');
  assert.equal((await seller.call('/api/sessions')).data.sessions.length, 2);
  await seller.call('/api/sessions/revoke', { id: 'others' });
  assert.equal((await other.state()).me, null); pass('signing out other devices revokes their sessions');

  /* --- audit & transport --- */
  adm = await admin.state();
  assert(adm.admin.auditIntact && adm.admin.audit.length > 10); pass('audit chain intact');
  const { DatabaseSync } = require('node:sqlite');
  assert.throws(() => new DatabaseSync(process.env.DB_PATH).exec('DELETE FROM t_audit')); pass('audit log cannot be deleted in the database');
  const xo = await fetch(base + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(xo.status, 403); pass('cross-origin requests blocked');
  const h = await fetch(base + '/');
  assert(h.headers.get('content-security-policy').includes("frame-ancestors 'none'")); pass('security headers present');

  console.log(`\n${ok} checks passed`);
  server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
