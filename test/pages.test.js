'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server.js');

const quiet = { info() {}, warn() {}, error() {}, log() {} };
const ORIGIN = 'https://hellagood.example';

async function withServer(app, fn) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); }
  finally { await new Promise((r) => server.close(r)); }
}

const get = (base, p, init) => fetch(base + p, { redirect: 'manual', ...init });

function stubStripe(session) {
  return {
    checkout: {
      sessions: {
        async create() { return { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' }; },
        async retrieve(id, params) { if (!session) throw new Error('No such checkout.session'); return { id, ...session }; },
      },
    },
    webhooks: { constructEvent() { throw new Error('unused'); } },
  };
}

test('landing: DSD pitch, 25% off, $4.49 price, login + apply CTAs', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const r = await get(base, '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    const html = await r.text();
    assert.match(html, /DSD Wholesale Portal/);
    assert.match(html, /Wholesale for DSDs/);
    assert.match(html, /25% off/);
    assert.match(html, /\$4\.49/);
    assert.match(html, /DSD Login/);
    assert.match(html, /Apply to become a DSD/);
    assert.ok(html.includes('href="/login"') && html.includes('href="/apply"'));
    assert.ok(html.includes('Razzilicious') && html.includes('Strawberry Lemonade') && html.includes('Orange Pineapple Mango'));
    assert.ok(html.includes('<link rel="stylesheet" href="/css/dsd.css?v='), 'dsd.css is versioned');
    assert.doesNotMatch(html, /<!--#include|\{\{[A-Z_]+\}\}/, 'no template syntax leaks');
    assert.doesNotMatch(html, /name="robots"/, 'landing is indexable');
  });
});

test('login page renders the form and apply link', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const html = await (await get(base, '/login')).text();
    assert.match(html, /<form id="login-form"/);
    assert.match(html, /href="\/apply"/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /\/js\/login\.js\?v=/);
  });
});

test('apply page renders the application form', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const html = await (await get(base, '/apply')).text();
    assert.match(html, /<form id="apply-form"/);
    assert.match(html, /id="company"/);
    assert.match(html, /id="password"/);
    assert.doesNotMatch(html, /name="robots"/, 'apply is indexable');
  });
});

test('invite page shows the expired state when the token is missing', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const html = await (await get(base, '/invite/bad')).text();
    assert.match(html, /Link <em>expired<\/em>/);
    assert.match(html, /<meta name="robots" content="noindex">/);
  });
});

test('portal and admin redirect to login when unauthenticated', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const portal = await get(base, '/portal');
    assert.equal(portal.status, 302);
    assert.equal(portal.headers.get('location'), '/login?next=/portal');
    const admin = await get(base, '/admin');
    assert.equal(admin.status, 302);
    assert.equal(admin.headers.get('location'), '/login?next=/admin');
  });
});

test('success page without a key: generic thank-you, noindex', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const r = await get(base, '/success?session_id=cs_test_a1B2c3D4e5F6g7H8');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /Thank <em>you!<\/em>/);
    assert.match(html, /Order received/);
    assert.match(html, /<meta name="robots" content="noindex">/);
  });
});

test('success page with a session shows the wholesale order summary (no tier line)', async () => {
  const stripe = stubStripe({
    payment_status: 'paid',
    amount_subtotal: 4490,
    amount_total: 5289,
    total_details: { amount_shipping: 799, amount_tax: 0 },
    metadata: { wholesale_pct: '25' },
    line_items: { data: [{ description: 'HELLA GOOD! Energy Gummies: Razzilicious', quantity: 10, amount_total: 4490 }] },
  });
  await withServer(createApp({ stripe, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const html = await (await get(base, '/success?session_id=cs_test_a1B2c3D4e5F6g7H8')).text();
    assert.match(html, /Order confirmed/);
    assert.match(html, /Razzilicious/);
    assert.match(html, /10 &times; \$4\.49/);
    assert.match(html, /<dt>Shipping<\/dt><dd>\$7\.99<\/dd>/);
    assert.match(html, /<dt>Total<\/dt><dd>\$52\.89<\/dd>/);
    assert.doesNotMatch(html, /Mix &amp; match/, 'no retail tier line for DSD orders');
  });
});

test('cancel page points back to the portal', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const html = await (await get(base, '/cancel')).text();
    assert.match(html, /Checkout cancelled/);
    assert.match(html, /href="\/portal"/);
    assert.match(html, /<meta name="robots" content="noindex">/);
  });
});

test('robots.txt blocks the API and points at the sitemap', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const body = await (await get(base, '/robots.txt')).text();
    assert.match(body, /^Disallow: \/api\/$/m);
    assert.match(body, new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, 'm'));
  });
});

test('sitemap lists the landing and apply page, skipping drafts and auth pages', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const xml = await (await get(base, '/sitemap.xml')).text();
    assert.ok(xml.includes(`<loc>${ORIGIN}/</loc>`));
    assert.ok(xml.includes(`<loc>${ORIGIN}/apply</loc>`));
    for (const p of ['/login', '/invite', '/portal', '/admin', '/success', '/cancel', '/privacy', '/terms']) {
      assert.ok(!xml.includes(`<loc>${ORIGIN}${p}</loc>`), p);
    }
  });
});

test('404 page is branded, noindex and returns 404', async () => {
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const r = await get(base, '/nope');
    assert.equal(r.status, 404);
    const html = await r.text();
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(html, /<!--#include/);
  });
});

test('static assets: versioned assets cache for a year', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const html = await (await get(base, '/')).text();
    const css = html.match(/\/css\/styles\.css\?v=[0-9a-f]{10}/)[0];
    const v = await get(base, css);
    assert.equal(v.status, 200);
    assert.equal(v.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const dsd = html.match(/\/css\/dsd\.css\?v=[0-9a-f]{10}/)[0];
    assert.equal((await get(base, dsd)).status, 200);
  });
});
