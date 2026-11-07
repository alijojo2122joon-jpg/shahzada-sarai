// End-to-end API test: spins up the server on a temp DB and walks through the full trading flow.
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarai-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const { server } = require('../server.js');

function client(base) {
  let cookie = '';
  const call = async (p, body) => {
    const res = await fetch(base + p, body === undefined ? { headers: { cookie } } : {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const data = await res.json();
    return { status: res.status, data };
  };
  return {
    call,
    login: (phone, password) => call('/api/login', { phone, password }),
    act: (type, payload) => call('/api/action', { type, payload }),
    state: () => call('/api/state').then((r) => r.data),
  };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const guest = client(base), seller = client(base), b1 = client(base), b2 = client(base), b3 = client(base), admin = client(base), fresh = client(base);
  let ok = 0; const pass = (m) => { ok++; console.log('  ✓', m); };

  const g = await guest.state();
  assert(g.orders.length > 0 && g.orders.every((o) => o.userId === null)); pass('guest sees market without seller identities');
  assert((await guest.act('order.create', {})).status === 401); pass('guest cannot place orders');

  assert((await seller.login('0700000001', 'wrong')).status === 401); pass('wrong password rejected');
  await seller.login('0700000001', '123456'); await b1.login('0700000002', '123456'); await b2.login('0700000003', '123456'); await b3.login('0700000004', '123456'); await admin.login('0700000000', 'admin123');

  const usd = (await seller.state()).assets.find((a) => a.code === 'USD');
  const r = await seller.act('order.create', { assetId: usd.id, side: 'sell', amount: '40,000', price: 65.3, validHours: 24 });
  assert.equal(r.status, 200); const oid = r.data.result.orderId; pass('seller posts 40,000 USD @ 65.30');
  assert.equal((await seller.act('order.create', { assetId: usd.id, side: 'sell', amount: 40000, price: 65.3 })).status, 409); pass('duplicate order blocked');

  const q1 = await b1.act('deal.request', { orderId: oid, amount: 20000 });
  const q2 = await b2.act('deal.request', { orderId: oid, amount: 15000 });
  const q3 = await b3.act('deal.request', { orderId: oid, amount: 10000 });
  assert([q1, q2, q3].every((x) => x.status === 200)); pass('three buyers request 20k / 15k / 10k');
  assert.equal((await b1.act('deal.request', { orderId: oid, amount: 5 })).status, 409); pass('second pending request from same buyer blocked');
  assert.equal((await b1.act('deal.request', { orderId: oid, amount: 50000 })).status, 400); pass('request above remaining blocked');

  const sv = await seller.state();
  assert(sv.notifications.some((n) => n.text.includes('20,000'))); pass('seller notified of incoming requests');
  const reqView = sv.users.find((u) => u.id === 3);
  assert(reqView.phone); pass('seller sees requester contact on pending request');
  assert(!(await b3.state()).users.find((u) => u.id === 2).phone); pass('buyer does not see seller contact before acceptance');

  const d1 = q1.data.result.dealId, d2 = q2.data.result.dealId, d3 = q3.data.result.dealId;
  assert.equal((await b1.act('deal.accept', { dealId: d1 })).status, 403); pass('only owner can accept');
  await seller.act('deal.accept', { dealId: d1 });
  await seller.act('deal.accept', { dealId: d2, amount: 15000 });
  let o = (await seller.state()).orders.find((x) => x.id === oid);
  assert.equal(o.remaining, 5000); pass('remaining shows 5,000 after accepting 35,000');
  const over = await seller.act('deal.accept', { dealId: d3, amount: 10000 });
  assert.equal(over.status, 409); pass('over-allocation refused (10k > 5k remaining)');
  await seller.act('deal.accept', { dealId: d3, amount: 5000 });
  o = (await seller.state()).orders.find((x) => x.id === oid);
  assert.equal(o.remaining, 0); assert.equal(o.status, 'filled'); pass('partial accept of 5k fills the order');

  assert((await b3.state()).users.find((u) => u.id === 2).phone); pass('buyer sees seller contact after acceptance');
  await b1.act('message.send', { dealId: d1, text: 'سلام' });
  assert((await seller.state()).messages.some((m) => m.text === 'سلام')); pass('deal chat works');

  await b2.act('deal.cancel', { dealId: d2, reason: 'test' });
  o = (await seller.state()).orders.find((x) => x.id === oid);
  assert.equal(o.remaining, 15000); assert.equal(o.status, 'active'); pass('cancelled deal returns 15k and reopens order');

  await seller.act('deal.complete', { dealId: d1 });
  let d = (await b1.state()).deals.find((x) => x.id === d1);
  assert.equal(d.status, 'accepted'); await b1.act('deal.complete', { dealId: d1 });
  d = (await b1.state()).deals.find((x) => x.id === d1);
  assert.equal(d.status, 'completed'); pass('deal completes only after both sides confirm');

  const noKyc = await client(base).call('/api/register', { name: 'x', phone: '0788888888', company: 'x', activity: 'saraf', password: '123456' });
  assert.equal(noKyc.status, 400); pass('registration requires province and office address');
  await fresh.call('/api/register', { name: 'تست', phone: '0799999999', company: 'صرافی تست', activity: 'saraf', password: '123456', province: 'هرات', address: 'سرای شهزاده دکان ۵', guarantorName: 'ضامن', guarantorPhone: '0777' });
  let adm = await admin.state();
  const applicant = adm.admin.users.find((u) => u.phone === '0799999999');
  assert(applicant.province === 'هرات' && applicant.address && applicant.status === 'pending'); pass('admin sees full applicant details');
  assert(adm.notifications.some((n) => n.text.includes('صرافی تست'))); pass('admin notified of new registration');
  assert.equal((await admin.act('admin.user.setStatus', { userId: applicant.id, status: 'rejected' })).status, 400); pass('rejection requires a reason');
  await admin.act('admin.user.setStatus', { userId: applicant.id, status: 'rejected', reason: 'آدرس ناقص است' });
  let fv = await fresh.state();
  assert(fv.me.status === 'rejected' && fv.me.statusReason === 'آدرس ناقص است' && fv.notifications[0].text.includes('رد شد')); pass('applicant notified of rejection with reason');
  await fresh.act('account.resubmit', { province: 'کابل', address: 'سرای شهزاده، منزل دوم، دکان ۵' });
  assert.equal((await fresh.state()).me.status, 'pending'); pass('applicant can fix details and resubmit');
  assert.equal((await fresh.act('order.create', { assetId: usd.id, side: 'buy', amount: 1, price: 1 })).status, 403); pass('unapproved member cannot trade');
  const newId = (await admin.state()).admin.users.find((u) => u.phone === '0799999999').id;
  await admin.act('admin.user.setStatus', { userId: newId, status: 'approved' });
  assert((await fresh.state()).notifications[0].text.includes('تأیید شد')); pass('applicant notified of approval');
  assert.equal((await fresh.act('order.create', { assetId: usd.id, side: 'buy', amount: 1000, price: 65.1 })).status, 200); pass('admin approval unlocks trading');
  assert.equal((await b1.act('admin.user.setStatus', { userId: newId, status: 'blocked' })).status, 403); pass('non-admin cannot use admin actions');

  await admin.act('admin.asset.save', { code: 'SAR', name: 'ریال سعودی', unit: 'SAR', priceCurrency: 'AFN' });
  const sar = (await admin.state()).assets.find((a) => a.code === 'SAR');
  await admin.act('admin.rate.set', { assetId: sar.id, buy: 17.3, sell: 17.45 });
  assert((await guest.state()).rates.some((x) => x.assetId === sar.id)); pass('admin adds asset and publishes rate');

  const av = await admin.state();
  assert(av.admin.auditIntact && av.admin.audit.length > 10); pass('audit chain intact');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.DB_PATH);
  assert.throws(() => db.exec('DELETE FROM event_log')); pass('event log is append-only in the database');

  const xorigin = await fetch(base + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  assert.equal(xorigin.status, 403); pass('cross-origin POST blocked');

  console.log(`\n${ok} checks passed`);
  server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
