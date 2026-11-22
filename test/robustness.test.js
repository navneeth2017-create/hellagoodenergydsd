'use strict';
/* Health/version, caching per route, security.txt, the 500 page, request logging, graceful shutdown, assets. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createApp, logPath } = require('../server.js');
const site = require('../lib/site.js');
const pkg = require('../package.json');

const quiet = { info() {}, warn() {}, error() {}, log() {} };
const ORIGIN = 'https://hellagood.example';

async function withServer(app, fn) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

const get = (base, p, init) => fetch(base + p, { redirect: 'manual', ...init });

test('/health reports the deploy version and is never cached', async () => {
  const sha = '3f9c2a7e1b4d5c6f7a8b9c0d1e2f3a4b5c6d7e8f';
  await withServer(createApp({ stripe: null, logger: quiet, commit: sha }), async (base) => {
    const r = await get(base, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.checkout, false);
    assert.equal(j.db, false);
    assert.equal(j.version, '3f9c2a7');
    assert.equal(j.commit, sha);
  });
  await withServer(createApp({ stripe: null, logger: quiet, commit: undefined }), async (base) => {
    assert.equal((await (await get(base, '/health')).json()).version, pkg.version);
  });
});

test('/health answers 503 while the server drains for shutdown', async () => {
  const app = createApp({ stripe: null, logger: quiet });
  await withServer(app, async (base) => {
    app.locals.draining = true;
    const r = await get(base, '/health');
    assert.equal(r.status, 503);
    assert.equal((await r.json()).ok, false);
  });
});

test('every route has a deliberate Cache-Control', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const html = await (await get(base, '/')).text();
    const versionedCss = html.match(/\/css\/styles\.css\?v=[0-9a-f]{10}/)[0];
    const versionedAvif = html.match(/\/images\/pack-strawberry-lemonade\.avif\?v=[0-9a-f]{10}/)[0];
    const YEAR = 'public, max-age=31536000, immutable';
    const cases = [
      ['GET', '/', 200, 'no-cache'],
      ['GET', '/login', 200, 'no-cache'],
      ['GET', '/apply', 200, 'no-cache'],
      ['GET', '/privacy', 200, 'no-cache'],
      ['GET', '/terms', 200, 'no-cache'],
      ['GET', '/cancel', 200, 'no-cache'],
      ['GET', '/success', 200, 'no-store'],
      ['GET', '/nope', 404, 'no-cache'],
      ['GET', '/health', 200, 'no-store'],
      ['GET', '/api/me', 503, 'no-store'],
      ['GET', '/api/nope', 404, 'no-store'],
      ['GET', '/robots.txt', 200, 'public, max-age=3600'],
      ['GET', '/sitemap.xml', 200, 'public, max-age=3600'],
      ['GET', '/.well-known/security.txt', 200, 'public, max-age=86400'],
      ['GET', versionedCss, 200, YEAR],
      ['GET', '/css/styles.css', 200, 'public, max-age=3600'],
      ['GET', versionedAvif, 200, YEAR],
      ['GET', '/images/pack-razzilicious.avif', 200, 'public, max-age=604800'],
      ['GET', '/fonts/inter-v20-latin.woff2', 200, YEAR],
      ['GET', '/fonts/OFL-Inter.txt', 200, 'public, max-age=3600'],
    ];
    for (const [method, p, status, cc] of cases) {
      const r = await get(base, p);
      assert.equal(r.status, status, `${method} ${p} status`);
      assert.equal(r.headers.get('cache-control'), cc, `${method} ${p} cache-control`);
    }
  });
});

test('security.txt: RFC 9116 fields and a support contact', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const r = await get(base, '/.well-known/security.txt');
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /^Contact: mailto:admin@hellagoodenergy\.com$/m);
    assert.doesNotMatch(body, /TODO/);
    const expires = new Date(body.match(/^Expires: (.+)$/m)[1]);
    const days = (expires - Date.now()) / 86400000;
    assert.ok(days > 90 && days < 365, `Expires ${days} days out`);
  });
});

test('500: branded HTML for browsers, JSON otherwise, never cached', async () => {
  const errors = [];
  const logger = { ...quiet, error: (...a) => errors.push(a.join(' ')) };
  const extraRoutes = (app) => app.get('/boom', () => { throw new Error('kaboom internal detail'); });
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger, extraRoutes }), async (base) => {
    const r = await get(base, '/boom?session_id=cs_test_secret123', { headers: { accept: 'text/html' } });
    assert.equal(r.status, 500);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(html, /kaboom/);
    const j = await get(base, '/boom', { headers: { accept: 'application/json' } });
    assert.equal(j.status, 500);
    assert.deepEqual(await j.json(), { ok: false, error: 'Something went wrong.' });
    assert.match(errors[0], /\[error\] GET \/boom kaboom internal detail/);
    assert.doesNotMatch(errors.join('\n'), /cs_test_secret123/);
  });
});

test('request log: method, path, status and time only; no secrets', async () => {
  const lines = [];
  const logger = { ...quiet, info: (...a) => lines.push(a.join(' ')) };
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger }), async (base) => {
    await get(base, '/success?session_id=cs_test_a1B2c3D4e5F6g7H8', { headers: { 'user-agent': 'SecretBrowser/1.0' } });
    await get(base, '/orders/jane.doe%40example.com/5551234567');
    await fetch(base + '/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'buyer@example.com' }) });
  });
  const reqs = lines.filter((l) => l.startsWith('[req]')).map((l) => l.replace(/ \d+ms$/, ' Nms'));
  assert.deepEqual(reqs, [
    '[req] GET /success 200 Nms',
    '[req] GET /orders/[redacted]/[redacted] 404 Nms',
    '[req] POST /api/checkout 503 Nms',
  ]);
  const all = lines.join('\n');
  for (const secret of ['cs_test_a1B2', 'SecretBrowser', 'jane.doe', '5551234567', 'buyer@example.com']) assert.ok(!all.includes(secret), `log leaks ${secret}`);
});

test('logPath strips queries, control characters, emails and long numbers', () => {
  assert.equal(logPath('/success?session_id=cs_test_x'), '/success');
  assert.equal(logPath('/a%0Ab'), '/a?b');
  assert.equal(logPath('/u/someone@example.org/x'), '/u/[redacted]/x');
  assert.equal(logPath('/track/4111111111111111'), '/track/[redacted]');
  assert.equal(logPath('/' + 'a'.repeat(500)).length, 200);
});

test('SIGTERM: drains, closes keep-alive sockets and exits 0', { timeout: 20000, skip: process.platform === 'win32' }, async () => {
  const env = { ...process.env, PORT: '0', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' };
  delete env.DATABASE_URL;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    child.stdout.on('data', () => {
      const m = out.match(/DSD portal on :(\d+)/);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
  });
  const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { connection: 'keep-alive' } });
  assert.equal(r.status, 200);
  const t0 = Date.now();
  child.kill('SIGTERM');
  assert.equal(await exited, 0, out);
  assert.ok(Date.now() - t0 < 5000, 'exits promptly');
  assert.match(out, /\[shutdown\] SIGTERM: finishing in-flight requests/);
});

test('images: every <picture> offers AVIF first and referenced files are served', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    const html = await (await get(base, '/')).text();
    const pictures = html.match(/<picture>[\s\S]*?<\/picture>/g);
    assert.ok(pictures.length >= 4, `found ${pictures.length}`);
    for (const p of pictures) assert.match(p, /<source type="image\/avif" srcset="[^"]+\.avif\?v=[0-9a-f]{10}[^"]*"/);
    const urls = new Set();
    for (const m of html.matchAll(/(?:src|href)="(\/images\/[^"]+)"/g)) urls.add(m[1]);
    for (const u of urls) {
      const r = await get(base, u);
      assert.equal(r.status, 200, u);
    }
  });
});

test('stylesheet is served minified', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
  await withServer(createApp({ stripe: null, logger: quiet }), async (base) => {
    const css = await (await get(base, '/css/styles.css')).text();
    assert.ok(css.length < src.length * 0.9, `${css.length} vs ${src.length}`);
    assert.doesNotMatch(css, /\/\*/);
  });
  assert.equal(site.minifyCss('/* c */\n.a :hover { width: calc(100% - 14px); }\n.b,\n.c { color: red; }\n'), '.a :hover{width:calc(100% - 14px)}.b,.c{color:red}');
});

test('the brand is HELLA GOOD! on every page', async () => {
  await withServer(createApp({ stripe: null, publicUrl: ORIGIN, logger: quiet }), async (base) => {
    for (const p of ['/', '/login', '/apply', '/nope']) {
      const html = await (await get(base, p)).text();
      assert.match(html, /class="brand"[^>]*>[\s\S]*?brand-hella[\s\S]*?HELLA[\s\S]*?brand-good[\s\S]*?GOOD!/, p);
    }
  });
});
