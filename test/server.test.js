'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, orderSummary, CHECKOUT_SOON, cleanSecretKey } = require('../server.js');

const quiet = { info() {}, warn() {}, error() {}, log() {} };

async function withServer(app, fn) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); }
  finally { await new Promise((r) => server.close(r)); }
}

const post = (base, body, path = '/api/checkout') =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

function stubStripe() {
  return {
    checkout: {
      sessions: {
        async create() { return { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' }; },
      },
    },
    webhooks: {
      constructEvent(body, sig, secret) {
        if (sig !== 'good' || secret !== 'whsec_test') throw new Error('bad signature');
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
  };
}

// No DATABASE_URL is configured in these tests: account endpoints answer "not configured yet".
test('/health reports the version and DB status', async () => {
  await withServer(createApp({ stripe: null, logger: quiet, commit: '3f9c2a7e1b4d' }), async (base) => {
    const r = await fetch(base + '/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.checkout, false);
    assert.equal(j.db, false);
    assert.equal(j.version, '3f9c2a7');
  });
});

test('account endpoints answer cleanly while the database is not configured', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const cases = [
      ['GET', '/api/me', 503, 'Accounts are not configured yet.'],
      ['POST', '/api/login', 503, 'Accounts are not configured yet.'],
      ['POST', '/api/apply', 503, 'Applications are not open yet.'],
      ['POST', '/api/invite', 503, 'Accounts are not configured yet.'],
      ['GET', '/api/orders', 503, 'Accounts are not configured yet.'],
      ['POST', '/api/checkout', 503, 'Accounts are not configured yet.'],
      ['GET', '/api/admin/dsds', 503, 'Accounts are not configured yet.'],
    ];
    for (const [method, p, status, error] of cases) {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, status, `${method} ${p}`);
      assert.equal((await r.json()).error, error, `${method} ${p}`);
    }
    // Logout never needs the DB.
    const logout = await fetch(base + '/api/logout', { method: 'POST' });
    assert.equal(logout.status, 200);
  });
});

test('/api/logout clears the session cookie', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const r = await fetch(base + '/api/logout', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /hgd_dsd=;/);
  });
});

test('unknown API routes 404 with JSON', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const r = await fetch(base + '/api/config');
    assert.equal(r.status, 404);
    assert.equal((await r.json()).ok, false);
  });
});

test('Stripe errors surface as a friendly 502 (DB-backed path is exercised in the integration test)', async () => {
  // The checkout route is auth-gated; without a DB it returns 503 before reaching Stripe.
  await withServer(createApp({ stripe: stubStripe(), logger: quiet }), async (base) => {
    const r = await post(base, { items: [{ flavor: 'blue-razz', qty: 1 }] });
    assert.equal(r.status, 503);
  });
});

test('webhook verifies signatures and logs paid orders without card data', async () => {
  const logged = [];
  const logger = { ...quiet, info: (...a) => logged.push(a.join(' ')) };
  const event = {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_paid',
        payment_status: 'paid',
        amount_total: 3494,
        metadata: { items: 'blue-razz:5', total_packs: '5', user_id: '7' },
        customer_details: { email: 'buyer@example.com', phone: '+15555550100' },
        collected_information: { shipping_details: { name: 'Beast Mode', address: { city: 'Oakland', state: 'CA', line1: '1 Main St' } } },
      },
    },
  };
  await withServer(createApp({ stripe: stubStripe(), webhookSecret: 'whsec_test', logger }), async (base) => {
    const bad = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'nope' }, body: JSON.stringify(event) });
    assert.equal(bad.status, 400);
    const good = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'good' }, body: JSON.stringify(event) });
    assert.equal(good.status, 200);
  });
  const orders = logged.filter((l) => l.startsWith('[order paid]'));
  assert.equal(orders.length, 1);
  assert.match(orders[0], /cs_test_paid/);
  assert.match(orders[0], /blue-razz:5/);
  assert.match(orders[0], /\$34\.94/);
  assert.match(orders[0], /Beast Mode/);
  assert.doesNotMatch(orders[0], /1 Main St|buyer@example|5555550100/);
});

test('webhook is disabled cleanly when not configured', async () => {
  await withServer(createApp({ stripe: null, webhookSecret: undefined, logger: quiet }), async (base) => {
    const r = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 503);
  });
});

test('security headers: CSP allows Stripe, fonts are self-hosted', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' https:\/\/js\.stripe\.com/);
    assert.match(csp, /font-src 'self';/);
    assert.doesNotMatch(csp, /googleapis|gstatic/);
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.ok(r.headers.get('x-content-type-options'));
  });
});

test('login rate limiting kicks in without a DB', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    let last;
    for (let i = 0; i < 31; i++) last = await post(base, { email: 'a@b.com', password: 'x' }, '/api/login');
    assert.equal(last.status, 429);
  });
});

test('orderSummary strips contact data but keeps the safe fields', () => {
  const s = orderSummary({ id: 'cs_x', amount_total: 100, shipping_details: { name: 'A', address: { city: 'Seattle', state: 'WA' } } });
  assert.equal(s.shipCity, 'Seattle, WA');
  assert.equal(s.orderId, 'cs_x');
  assert.equal(s.total, '$1.00');
});
