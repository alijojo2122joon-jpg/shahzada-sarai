// End-to-end API tests: start the server on a temporary database and exercise trading, membership review and security.
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarai-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const { server, totpAt } = require('../server.js');

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
  const rate = (await guest.state()).rates.find((x) => x.assetId === usd.id);
  assert(rate.buy === 65.4 && rate.sell === 65.5); pass('public sees only the verified rate');

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
