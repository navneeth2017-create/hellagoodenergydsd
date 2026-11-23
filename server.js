'use strict';
/*
 * HELLA GOOD! Energy Gummies — DSD (distributor) portal.
 *
 * The branded storefront for DSDs: a public landing + login, an apply/invite flow, an admin console
 * to approve and manage DSD accounts, and a wholesale shop (flat 25% off by default) that checks out
 * through Stripe. Server-computed prices only; the browser's numbers are display.
 *
 * Built on the D2C storefront (same Express/Helmet/Stripe/renderer) with Postgres + signed-cookie auth added.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const pricing = require('./public/js/pricing.js');
const site = require('./lib/site.js');
const db = require('./lib/db.js');
const auth = require('./lib/auth.js');
const pkg = require('./package.json');

const CHECKOUT_SOON = 'Checkout opens soon! Online ordering for HELLA GOOD! Energy Gummies is almost live. Your cart is saved.';
const PRODUCT_PREFIX = 'HELLA GOOD! Energy Gummies: ';
const SESSION_ID_RE = /^cs_(?:test|live)_[A-Za-z0-9]{8,250}$/;

/** The secret key as pasted into Railway, or '' when it is not clearly a Stripe secret key. */
function cleanSecretKey(raw) {
  const k = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  return /^(?:sk|rk)_(?:live|test)_\w+$/.test(k) ? k : '';
}
function cleanWebhookSecret(raw) {
  const k = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  return /^whsec_\w+$/.test(k) ? k : '';
}
function keyStatus(raw) {
  if (!String(raw || '').trim()) return 'Stripe key not set: checkout shows "opens soon"';
  const k = cleanSecretKey(raw);
  if (!k) return 'STRIPE_SECRET_KEY is set but is not a Stripe secret key: checkout stays off';
  return `Stripe checkout ON (${k.includes('_live_') ? 'live' : 'TEST'} mode)`;
}

function makeStripe(secretKey) {
  secretKey = cleanSecretKey(secretKey);
  if (!secretKey) return null;
  const Stripe = require('stripe');
  return new Stripe(secretKey, { maxNetworkRetries: 2, appInfo: { name: 'hellagoodenergydsd' } });
}

function baseUrlFor(req, publicUrl) {
  if (publicUrl) return publicUrl.replace(/\/+$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `${req.protocol}://${req.get('host')}`;
}

/** The wholesale percent off, from the settings table (admin-editable) with an env fallback. */
async function getWholesalePct() {
  let v = Number(process.env.WHOLESALE_PERCENT_OFF);
  if (!Number.isFinite(v)) v = pricing.WHOLESALE_PERCENT_OFF_DEFAULT;
  if (db.available()) {
    try {
      const s = await db.getSetting('wholesale_percent_off');
      if (s !== null && s !== '' && Number.isFinite(Number(s))) v = Number(s);
    } catch (e) { /* keep env */ }
  }
  return Math.max(0, Math.min(90, Math.round(v)));
}

/** Build the Stripe Checkout Session params for a DSD order. Server-computed wholesale prices only. */
function buildWholesaleSession(items, baseUrl, pct, userId) {
  const q = pricing.quoteWholesale(items, pct);
  const httpsBase = baseUrl.startsWith('https://');
  // A complete display = exactly 1 box of each flavor (3 boxes, 45 packs).
  const hasCompleteDisplay = q.displays >= 1 && q.lines.length === 3 &&
    q.lines.every((l) => l.boxes === 1);

  let line_items;
  if (hasCompleteDisplay) {
    // One Display line item (the bundle).
    const displayProduct = {
      name: `${PRODUCT_PREFIX}Display (3 boxes: Razzilicious, Strawberry Lemonade, Orange Pineapple Mango)`,
      description: `DSD wholesale (${pct}% off) - ${pricing.formatCents(q.displayCents)} per display, ${q.totalPacks} packs (3 flavors × ${pricing.PACKS_PER_BOX})`,
    };
    if (httpsBase) {
      // Use the first flavor's image as the display image.
      const flavor = pricing.flavorById(q.lines[0].flavor);
      if (flavor) displayProduct.images = [baseUrl + flavor.image];
    }
    line_items = [{
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: q.displayCents, tax_behavior: 'exclusive', product_data: displayProduct },
    }];
    // Remaining loose boxes (if they ordered >1 display worth, e.g., 2/2/1 = 1 display + 1 loose box)
    const looseBoxes = q.totalBoxes - 3;
    if (looseBoxes > 0) {
      // Find which flavors have extra boxes beyond 1.
      q.lines.forEach((l) => {
        const extra = l.boxes - 1;
        if (extra <= 0) return;
        const flavor = pricing.flavorById(l.flavor);
        const product = {
          name: `${PRODUCT_PREFIX}${l.name} - Box of ${pricing.PACKS_PER_BOX}`,
          description: `DSD wholesale (${pct}% off) - ${pricing.formatCents(l.unitCents)} per box, ${l.packs} packs`,
        };
        if (httpsBase && flavor) product.images = [baseUrl + flavor.image];
        line_items.push({
          quantity: extra,
          price_data: { currency: 'usd', unit_amount: l.unitCents, tax_behavior: 'exclusive', product_data: product },
        });
      });
    }
  } else {
    // No complete display: individual box lines per flavor.
    line_items = q.lines.map((l) => {
      const flavor = pricing.flavorById(l.flavor);
      const product = {
        name: `${PRODUCT_PREFIX}${l.name} - Box of ${pricing.PACKS_PER_BOX}`,
        description: `DSD wholesale (${pct}% off) - ${pricing.formatCents(l.unitCents)} per box, ${l.packs} packs`,
      };
      if (httpsBase && flavor) product.images = [baseUrl + flavor.image];
      return {
        quantity: l.boxes,
        price_data: { currency: 'usd', unit_amount: l.unitCents, tax_behavior: 'exclusive', product_data: product },
      };
    });
  }

  return {
    mode: 'payment',
    client_reference_id: String(userId),
    line_items,
    automatic_tax: { enabled: true },
    shipping_address_collection: { allowed_countries: ['US'] },
    shipping_options: [
      { shipping_rate_data: { type: 'fixed_amount', display_name: 'Flat-rate shipping', fixed_amount: { amount: pricing.SHIPPING_CENTS, currency: 'usd' }, tax_behavior: 'exclusive' } },
    ],
    phone_number_collection: { enabled: true },
    billing_address_collection: 'auto',
    success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/portal`,
    metadata: {
      items: q.lines.map((l) => `${l.flavor}:${l.boxes}`).join(','),
      units: hasCompleteDisplay ? 'display+box' : 'box',
      packs_per_box: String(pricing.PACKS_PER_BOX),
      total_boxes: String(q.totalBoxes),
      total_packs: String(q.totalPacks),
      user_id: String(userId),
      wholesale_pct: String(pct),
      unit_cents: String(q.unitCents),
      has_display: String(hasCompleteDisplay),
    },
  };
}

/** Log a paid order. Order id, items, total, shipping name + city only: no card or contact data. */
function orderSummary(session) {
  const ship = (session.collected_information && session.collected_information.shipping_details) || session.shipping_details || null;
  return {
    orderId: session.id,
    items: (session.metadata && session.metadata.items) || '',
    totalPacks: session.metadata && session.metadata.total_packs,
    total: typeof session.amount_total === 'number' ? pricing.formatCents(session.amount_total) : null,
    shipName: ship ? ship.name : null,
    shipCity: ship && ship.address ? `${ship.address.city || ''}, ${ship.address.state || ''}`.replace(/^, |, $/g, '') : null,
  };
}

/** A request path safe to log: no query string, control chars stripped, emails and long numbers redacted. */
function logPath(url) {
  let p = String(url || '').split('?')[0].split('#')[0];
  try { p = decodeURIComponent(p); } catch (e) { /* raw */ }
  return p.slice(0, 200).replace(/[^\x21-\x7e]/g, '?').replace(/[^/@]*@[^/@]*/g, '[redacted]').replace(/\d{6,}/g, '[redacted]');
}

const STATIC_RE = /^\/(?:css|js|images|fonts)\/|^\/(?:favicon\.svg|favicon\.ico|apple-touch-icon\.png)$/;

function requestLogger(log) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const p = logPath(req.originalUrl);
      if (p === '/health') return;
      if (res.statusCode < 400 && STATIC_RE.test(p)) return;
      log.info(`[req] ${req.method} ${p} ${res.statusCode} ${Math.round(Number(process.hrtime.bigint() - start) / 1e6)}ms`);
    });
    next();
  };
}

/** The /success status card. With a retrievable Checkout Session it lists the order; otherwise a generic thank-you. */
function successHtml(session) {
  const esc = site.escapeHtml;
  const lines = session && session.line_items && Array.isArray(session.line_items.data) ? session.line_items.data : null;
  if (!session || !lines || !lines.length) {
    return `      <section class="status-card" aria-labelledby="status-title">
        <p class="status-badge"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg> Order received</p>
        <h1 id="status-title" class="h2">Thank <em>you!</em></h1>
        <p class="lede">Thanks for your order. Your HELLA GOOD! Energy Gummies are on the way soon.</p>
      </section>`;
  }
  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  const td = session.total_details || {};
  const money = (c) => pricing.formatCents(Number(c) || 0);
  const rows = lines.map((l) => {
    const name = String(l.description || '').replace(PRODUCT_PREFIX, '');
    const unit = l.quantity ? Math.round((l.amount_total || 0) / l.quantity) : 0;
    return `          <li><span class="os-name">${esc(name)}</span><span class="os-qty">${esc(l.quantity)} &times; ${money(unit)}</span><span class="os-amt">${money(l.amount_total)}</span></li>`;
  }).join('\n');
  const extra = [`<div><dt>Shipping</dt><dd>${money(td.amount_shipping)}</dd></div>`];
  if (td.amount_tax) extra.push(`<div><dt>Tax</dt><dd>${money(td.amount_tax)}</dd></div>`);
  return `      <section class="status-card" aria-labelledby="status-title">
        <p class="status-badge${paid ? '' : ' pending'}"><svg class="ico" aria-hidden="true"><use href="#${paid ? 'i-check' : 'i-bolt'}"/></svg> ${paid ? 'Order confirmed' : 'Payment processing'}</p>
        <h1 id="status-title" class="h2">Thank <em>you!</em></h1>
        <p class="lede">${paid ? 'Your order is confirmed. Your HELLA GOOD! Energy Gummies are on the way soon.' : 'We have your order. It ships as soon as your payment clears.'}</p>
        <div class="order-summary">
          <h2 class="status-h3">Order summary <span class="os-ref">Ref &hellip;${esc(String(session.id).slice(-8))}</span></h2>
          <ul class="os-lines">
${rows}
          </ul>
          <dl class="os-totals">
            <div><dt>Subtotal</dt><dd>${money(session.amount_subtotal)}</dd></div>
            ${extra.join('\n            ')}
            <div class="os-grand"><dt>Total</dt><dd>${money(session.amount_total)}</dd></div>
          </dl>
        </div>
      </section>`;
}

/** Seed the first admin from env so Nav can log in and approve the first DSD. Idempotent. */
async function seedAdmin(log) {
  if (!db.available()) return;
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!email || !pw) return;
  try {
    const existing = await db.one('SELECT id, role FROM users WHERE email=$1', [email]);
    if (existing) {
      if (existing.role !== 'admin') await db.query("UPDATE users SET role='admin' WHERE id=$1", [existing.id]);
      return;
    }
    await db.query("INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Admin', 'admin', 'active', $2)", [email, auth.hashPassword(pw)]);
    log.log(`[admin] seeded ${email}`);
  } catch (e) {
    log.error('[admin] seed failed:', e.message);
  }
}

function createApp(opts = {}) {
  const stripe = 'stripe' in opts ? opts.stripe : makeStripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = 'webhookSecret' in opts ? opts.webhookSecret : (cleanWebhookSecret(process.env.STRIPE_WEBHOOK_SECRET) || undefined);
  const publicUrl = 'publicUrl' in opts ? opts.publicUrl : process.env.PUBLIC_URL;
  const log = opts.logger || console;
  const commit = 'commit' in opts ? opts.commit : process.env.RAILWAY_GIT_COMMIT_SHA;
  const version = commit ? String(commit).slice(0, 7) : pkg.version;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.locals.draining = false;
  app.use(requestLogger(log));

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", 'https://js.stripe.com'],
          'style-src': ["'self'"],
          'font-src': ["'self'"],
          'img-src': ["'self'", 'data:', 'https://*.stripe.com'],
          'connect-src': ["'self'", 'https://api.stripe.com'],
          'frame-src': ['https://js.stripe.com', 'https://hooks.stripe.com', 'https://checkout.stripe.com'],
          'form-action': ["'self'", 'https://checkout.stripe.com'],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'upgrade-insecure-requests': process.env.NODE_ENV === 'production' ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );
  app.use(compression());

  app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(app.locals.draining ? 503 : 200).json({ ok: !app.locals.draining, checkout: Boolean(stripe), db: db.available(), version, commit: commit || null });
  });

  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Stripe webhook needs the raw body for signature checks, mounted before express.json.
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (!stripe || !webhookSecret) return res.status(503).json({ ok: false, error: 'Webhook not configured.' });
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret);
    } catch (err) {
      log.warn('[webhook] signature check failed:', err.message);
      return res.status(400).json({ ok: false, error: 'Invalid signature.' });
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        log.info('[order paid]', JSON.stringify(orderSummary(session)));
        // Record the DSD order (attributed via metadata.user_id) for "My orders" and the admin console.
        const userId = parseInt(session.metadata && session.metadata.user_id, 10);
        const items = session.metadata && session.metadata.items
          ? session.metadata.items.split(',').map((part) => { const [flavor, qty] = part.split(':'); return { flavor, qty: parseInt(qty, 10) || 0 }; }).filter((i) => i.qty > 0)
          : [];
        if (db.available() && Number.isInteger(userId) && items.length) {
          try {
            await db.query(
              `INSERT INTO orders (user_id, stripe_session_id, items, subtotal_cents, shipping_cents, tax_cents, total_cents, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'paid')`,
              [userId, session.id, JSON.stringify(items), session.amount_subtotal || 0, (session.total_details && session.total_details.amount_shipping) || 0, (session.total_details && session.total_details.amount_tax) || null, session.amount_total || 0]
            );
          } catch (e) { log.error('[webhook] order insert failed:', e.message); }
        }
      }
    }
    res.json({ received: true });
  });

  app.use('/api', express.json({ limit: '64kb' }));

  /* ---------- auth ---------- */

  const requireAuth = async (req, res, next) => {
    if (!db.available()) return res.status(503).json({ ok: false, error: 'Accounts are not configured yet.' });
    const s = auth.readSession(req);
    if (!s) return res.status(401).json({ ok: false, error: 'Please log in.' });
    try {
      const user = await db.one('SELECT id, email, name, company, phone, role, status, wholesale_pct FROM users WHERE id=$1', [s.sub]);
      if (!user) return res.status(401).json({ ok: false, error: 'Account not found.' });
      if (user.status !== 'active') return res.status(403).json({ ok: false, error: 'Your account is not active yet.' });
      req.user = user;
      next();
    } catch (e) { next(e); }
  };
  const requireAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admins only.' });
    next();
  };

  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, company: u.company, role: u.role });

  const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' } });

  app.post('/api/login', authLimiter, async (req, res) => {
    if (!db.available()) return res.status(503).json({ ok: false, error: 'Accounts are not configured yet.' });
    const email = String(req.body && req.body.email || '').trim().toLowerCase();
    const password = String(req.body && req.body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) return res.status(400).json({ ok: false, error: 'Enter your email and password.' });
    const user = await db.one('SELECT * FROM users WHERE email=$1', [email]).catch(() => null);
    if (!user || !auth.verifyPassword(password, user.password_hash)) return res.status(401).json({ ok: false, error: 'Wrong email or password.' });
    if (user.status === 'applied') return res.status(403).json({ ok: false, error: 'Your application is still under review.' });
    if (user.status === 'invited') return res.status(403).json({ ok: false, error: 'Finish setting up your account from the invite link we emailed you.' });
    if (user.status === 'disabled') return res.status(403).json({ ok: false, error: 'This account has been disabled.' });
    await db.query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]).catch(() => {});
    auth.setSessionCookie(res, auth.signSession({ sub: user.id, role: user.role }));
    res.json({ ok: true, user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });

  app.get('/api/me', requireAuth, async (req, res) => {
    const pct = await getWholesalePct();
    res.json({
      ok: true,
      user: publicUser(req.user),
      wholesalePercentOff: pct,
      boxCents: pricing.boxCentsFor(pct),
      displayCents: pricing.displayCentsFor(pct),
      packsPerBox: pricing.PACKS_PER_BOX,
      packsPerDisplay: pricing.PACKS_PER_DISPLAY,
    });
  });

  // Apply to become a DSD. Creates a pending application for Nav to approve.
  app.post('/api/apply', authLimiter, async (req, res) => {
    if (!db.available()) return res.status(503).json({ ok: false, error: 'Applications are not open yet.' });
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 120);
    const company = String(b.company || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().toLowerCase();
    const phone = String(b.phone || '').trim().slice(0, 40);
    const password = String(b.password || '');
    if (!name) return res.status(400).json({ ok: false, error: 'Enter your name.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email.' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Use a password of at least 8 characters.' });
    const existing = await db.one('SELECT id FROM users WHERE email=$1', [email]).catch(() => null);
    if (existing) return res.status(409).json({ ok: false, error: 'That email already has an account.' });
    await db.query(
      "INSERT INTO users (email, name, company, phone, password_hash, role, status) VALUES ($1,$2,$3,$4,$5,'dsd','applied')",
      [email, name, company, phone, auth.hashPassword(password)]
    );
    log.info('[apply] new DSD application:', email);
    res.json({ ok: true, message: 'Application received. We will email you once your account is approved.' });
  });

  // Finish an invited account: set name + password, activate.
  app.post('/api/invite', authLimiter, async (req, res) => {
    if (!db.available()) return res.status(503).json({ ok: false, error: 'Accounts are not configured yet.' });
    const token = String(req.body && req.body.token || '').trim();
    const name = String(req.body && req.body.name || '').trim().slice(0, 120);
    const password = String(req.body && req.body.password || '');
    if (!token) return res.status(400).json({ ok: false, error: 'Missing invite token.' });
    if (!name) return res.status(400).json({ ok: false, error: 'Enter your name.' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Use a password of at least 8 characters.' });
    const user = await db.one("SELECT id, email, status FROM users WHERE invite_token=$1 AND role='dsd'", [token]).catch(() => null);
    if (!user) return res.status(400).json({ ok: false, error: 'That invite link is invalid or already used.' });
    await db.query("UPDATE users SET name=$1, password_hash=$2, status='active', invite_token=NULL, approved_at=now() WHERE id=$3", [name, auth.hashPassword(password), user.id]);
    auth.setSessionCookie(res, auth.signSession({ sub: user.id, role: 'dsd' }));
    res.json({ ok: true, user: { id: user.id, email: user.email, name, role: 'dsd' } });
  });

  /* ---------- admin ---------- */

  app.get('/api/admin/dsds', requireAuth, requireAdmin, async (req, res) => {
    const rows = await db.all(
      `SELECT u.id, u.email, u.name, u.company, u.phone, u.status, u.wholesale_pct, u.created_at, u.approved_at, u.last_login_at,
              COUNT(o.id)::int AS orders,
              COALESCE(SUM(o.total_cents), 0)::int AS total_cents
         FROM users u
         LEFT JOIN orders o ON o.user_id = u.id
        WHERE u.role='dsd'
        GROUP BY u.id, u.email, u.name, u.company, u.phone, u.status, u.wholesale_pct, u.created_at, u.approved_at, u.last_login_at
        ORDER BY u.created_at DESC`
    ).catch(() => []);
    res.json({ ok: true, dsds: rows });
  });

  // Invite a DSD by email: creates an 'invited' account with a one-time setup link.
  app.post('/api/admin/dsds', requireAuth, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const name = String(b.name || '').trim().slice(0, 120);
    const company = String(b.company || '').trim().slice(0, 120);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email.' });
    const existing = await db.one('SELECT id FROM users WHERE email=$1', [email]).catch(() => null);
    if (existing) return res.status(409).json({ ok: false, error: 'That email already has an account.' });
    const token = crypto.randomBytes(24).toString('hex');
    await db.query("INSERT INTO users (email, name, company, role, status, invite_token) VALUES ($1,$2,$3,'dsd','invited',$4)", [email, name, company, token]);
    log.info('[admin] invited DSD:', email);
    res.json({ ok: true, invite_url: `/invite/${token}` });
  });

  app.post('/api/admin/dsds/:id/approve', requireAuth, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await db.query("UPDATE users SET status='active', approved_at=now(), invite_token=NULL WHERE id=$1 AND role='dsd' AND status IN ('applied','invited')", [id]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Nothing to approve.' });
    res.json({ ok: true });
  });

  app.post('/api/admin/dsds/:id/disable', requireAuth, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await db.query("UPDATE users SET status='disabled' WHERE id=$1 AND role='dsd'", [id]);
    res.json({ ok: true });
  });

  app.post('/api/admin/dsds/:id/enable', requireAuth, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await db.query("UPDATE users SET status='active' WHERE id=$1 AND role='dsd'", [id]);
    res.json({ ok: true });
  });

  // Per-DSD wholesale override (or null = site default), plus name/company.
  app.patch('/api/admin/dsds/:id', requireAuth, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const fields = [], params = [id];
    if ('wholesale_pct' in b) {
      const v = b.wholesale_pct === null || b.wholesale_pct === '' ? null : Number(b.wholesale_pct);
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > 90)) return res.status(400).json({ ok: false, error: 'Discount must be 0–90.' });
      fields.push(`wholesale_pct=$${params.length + 1}`); params.push(v);
    }
    if ('name' in b) { fields.push(`name=$${params.length + 1}`); params.push(String(b.name).trim().slice(0, 120)); }
    if ('company' in b) { fields.push(`company=$${params.length + 1}`); params.push(String(b.company).trim().slice(0, 120)); }
    if (!fields.length) return res.status(400).json({ ok: false, error: 'Nothing to change.' });
    await db.query(`UPDATE users SET ${fields.join(', ')} WHERE id=$1 AND role='dsd'`, params);
    res.json({ ok: true });
  });

  app.get('/api/admin/orders', requireAuth, requireAdmin, async (req, res) => {
    const rows = await db.all(
      `SELECT o.id, o.created_at, o.items, o.subtotal_cents, o.shipping_cents, o.tax_cents, o.total_cents, o.status,
              COALESCE(NULLIF(u.name,''), u.email) AS who, u.email
         FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 500`
    ).catch(() => []);
    res.json({ ok: true, orders: rows });
  });

  app.get('/api/admin/config', requireAuth, requireAdmin, async (req, res) => {
    const pct = await getWholesalePct();
    res.json({
      ok: true,
      wholesalePercentOff: pct,
      unitCents: pricing.wholesaleUnitCentsFor(pct),
      boxCents: pricing.boxCentsFor(pct),
      displayCents: pricing.displayCentsFor(pct),
      packsPerBox: pricing.PACKS_PER_BOX,
      packsPerDisplay: pricing.PACKS_PER_DISPLAY,
    });
  });

  app.patch('/api/admin/config', requireAuth, requireAdmin, async (req, res) => {
    const v = Number(req.body && req.body.wholesalePercentOff);
    if (!Number.isFinite(v) || v < 0 || v > 90) return res.status(400).json({ ok: false, error: 'Discount must be 0–90.' });
    await db.setSetting('wholesale_percent_off', Math.round(v));
    res.json({ ok: true, wholesalePercentOff: await getWholesalePct() });
  });

  /* ---------- DSD portal ---------- */

  app.get('/api/orders', requireAuth, async (req, res) => {
    const rows = await db.all(
      'SELECT id, items, subtotal_cents, shipping_cents, tax_cents, total_cents, status, created_at FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200',
      [req.user.id]
    ).catch(() => []);
    res.json({ ok: true, orders: rows });
  });

  const checkoutLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { ok: false, error: 'Too many checkout attempts. Please wait a few minutes and try again.' } });

  app.post('/api/checkout', requireAuth, checkoutLimiter, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const v = pricing.validateItems(body.items);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    const pct = req.user.wholesale_pct != null ? Number(req.user.wholesale_pct) : await getWholesalePct();
    const q = pricing.quoteWholesale(v.items, pct);
    if (!stripe) return res.status(503).json({ ok: false, code: 'checkout_unavailable', message: CHECKOUT_SOON, quote: q });
    try {
      const session = await stripe.checkout.sessions.create(buildWholesaleSession(v.items, baseUrlFor(req, publicUrl), pct, req.user.id));
      res.json({ ok: true, url: session.url, quote: q });
    } catch (err) {
      log.error('[checkout] Stripe error:', err && err.message);
      res.status(502).json({ ok: false, error: 'We could not start checkout right now. Please try again in a moment.' });
    }
  });

  /* ---------- read-only feed for Jarvis and the ADDY admin ---------- */
  // Off unless FEED_TOKEN is set. Bearer token, same pattern as AddyDSD's /api/jarvis feed.
  // Nothing here writes; it is aggregate counts plus the last few orders/applications.
  const FEED_TOKEN = String(process.env.FEED_TOKEN || '');
  function feedTokenOk(given) {
    if (!FEED_TOKEN || !given) return false;
    const a = crypto.createHash('sha256').update(String(given)).digest();
    const b = crypto.createHash('sha256').update(FEED_TOKEN).digest();
    return crypto.timingSafeEqual(a, b);
  }

  app.get('/api/feed/summary', async (req, res) => {
    if (!FEED_TOKEN) return res.status(404).json({ ok: false, error: 'Not found.' });
    const h = String(req.headers.authorization || '');
    const given = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-feed-token'] || '');
    if (!feedTokenOk(given)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
    if (!db.available()) return res.status(503).json({ ok: false, error: 'Database not configured.' });
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const win = String(days);
    try {
      const pct = await getWholesalePct();
      const totals = await db.one(`
        SELECT
          (SELECT COUNT(*)::int FROM users WHERE role='dsd' AND status='active')   AS dsds_active,
          (SELECT COUNT(*)::int FROM users WHERE role='dsd' AND status='applied')  AS applications,
          (SELECT COUNT(*)::int FROM users WHERE role='dsd' AND status='invited')  AS open_invites,
          (SELECT COUNT(*)::int FROM users WHERE role='dsd' AND created_at > now() - ($1 || ' days')::interval) AS new_dsds,
          (SELECT COUNT(*)::int FROM orders WHERE status <> 'cancelled' AND created_at > now() - ($1 || ' days')::interval) AS orders,
          (SELECT COALESCE(SUM(total_cents),0)::bigint FROM orders WHERE status <> 'cancelled' AND created_at > now() - ($1 || ' days')::interval) AS revenue_cents
      `, [win]);
      const packs = await db.one(`
        SELECT COALESCE(SUM((i->>'qty')::int),0)::int AS boxes
          FROM orders o, jsonb_array_elements(o.items) i
         WHERE o.status <> 'cancelled' AND o.created_at > now() - ($1 || ' days')::interval
      `, [win]).catch(() => ({ boxes: 0 }));
      const orders = await db.all(`
        SELECT o.id, o.created_at, o.total_cents, o.status, o.items,
               COALESCE(NULLIF(u.name,''), u.email) AS who, u.company, u.email
          FROM orders o JOIN users u ON u.id = o.user_id
         ORDER BY o.created_at DESC LIMIT 20
      `).catch(() => []);
      const applications = await db.all(`
        SELECT id, created_at, name, company, email, phone, status
          FROM users WHERE role='dsd' AND status IN ('applied','invited')
         ORDER BY created_at DESC LIMIT 20
      `).catch(() => []);
      const recentDsds = await db.all(`
        SELECT id, created_at, approved_at, last_login_at, name, company, email, status
          FROM users WHERE role='dsd'
         ORDER BY created_at DESC LIMIT 20
      `).catch(() => []);
      const boxCents = pricing.boxCentsFor(pct);
      const boxes = Number(packs.boxes) || 0;
      const revenueCents = Number(totals.revenue_cents) || 0;
      const orderCount = Number(totals.orders) || 0;
      res.json({
        ok: true,
        at: new Date().toISOString(),
        window_days: days,
        pricing: {
          wholesalePercentOff: pct,
          boxCents,
          displayCents: boxCents * pricing.BOXES_PER_DISPLAY,
          packsPerBox: pricing.PACKS_PER_BOX,
          packsPerDisplay: pricing.PACKS_PER_DISPLAY,
        },
        totals: {
          dsdsActive: Number(totals.dsds_active) || 0,
          applications: Number(totals.applications) || 0,
          openInvites: Number(totals.open_invites) || 0,
          newDsds: Number(totals.new_dsds) || 0,
          orders: orderCount,
          revenueCents,
          boxes,
          packs: boxes * pricing.PACKS_PER_BOX,
          avgOrderCents: orderCount ? Math.round(revenueCents / orderCount) : 0,
        },
        recentOrders: orders.map((o) => {
          const items = Array.isArray(o.items) ? o.items : [];
          const b = items.reduce((n, i) => n + (Number(i && i.qty) || 0), 0);
          return {
            id: o.id,
            at: o.created_at,
            who: o.who,
            company: o.company,
            email: o.email,
            totalCents: Number(o.total_cents) || 0,
            status: o.status,
            boxes: b,
            packs: b * pricing.PACKS_PER_BOX,
            items,
          };
        }),
        applications,
        recentDsds,
      });
    } catch (e) {
      log.error('[feed] summary failed:', e.message);
      res.status(500).json({ ok: false, error: 'Could not build the feed.' });
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

  /* ---------- pages ---------- */

  const renderer = site.createRenderer();
  const originFor = (req) => baseUrlFor(req, publicUrl);
  const sendPage = (req, res, key, extra = {}, status = 200) => {
    res.status(status).set('Cache-Control', 'no-cache').type('html');
    res.send(renderer.render(key, { origin: originFor(req), checkoutEnabled: Boolean(stripe), ...extra }));
  };

  app.get('/robots.txt', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('text/plain').send(site.robotsTxt(originFor(req))));
  app.get('/sitemap.xml', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(site.sitemapXml(originFor(req), renderer.sitemapRoutes())));
  app.get('/llms.txt', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('text/plain').send(site.llmsTxt(originFor(req))));
  app.get('/.well-known/security.txt', (req, res) => {
    const expires = new Date(Date.now() + 182 * 24 * 60 * 60 * 1000);
    expires.setUTCHours(0, 0, 0, 0);
    res.set('Cache-Control', 'public, max-age=86400').type('text/plain').send(site.securityTxt(originFor(req), expires));
  });
  app.get('/security.txt', (req, res) => res.redirect(301, '/.well-known/security.txt'));

  // The DSD landing.
  app.get('/', async (req, res) => {
    const sid = typeof req.query.session_id === 'string' && SESSION_ID_RE.test(req.query.session_id) ? req.query.session_id : '';
    if (req.query.checkout === 'success') return res.redirect(302, '/success' + (sid ? `?session_id=${sid}` : ''));
    if (req.query.checkout === 'cancelled') return res.redirect(302, '/portal');
    const session = auth.readSession(req);
    const pct = await getWholesalePct();
    sendPage(req, res, '/', {
      vars: {
        SESSION: session ? '1' : '',
        WHOLESALE_PCT: String(pct),
        WHOLESALE_UNIT: pricing.formatCents(pricing.wholesaleUnitCentsFor(pct)),
        BOX_PRICE: pricing.formatCents(pricing.boxCentsFor(pct)),
        DISPLAY_PRICE: pricing.formatCents(pricing.displayCentsFor(pct)),
        PACKS_PER_BOX: String(pricing.PACKS_PER_BOX),
        PACKS_PER_DISPLAY: String(pricing.PACKS_PER_DISPLAY),
        HEADER_NAV: '<a class="dsd-link" href="/apply">Apply</a><a class="btn btn-red" style="padding:9px 18px;font-size:14px;" href="/login">DSD Login</a>',
      },
    });
  });

  app.get('/login', (req, res) => {
    if (auth.readSession(req)) return res.redirect(302, '/portal');
    sendPage(req, res, '/login', { vars: { NEXT: String(req.query.next || '/portal').replace(/[^\w/.-]/g, ''), HEADER_NAV: '<a class="dsd-link" href="/apply">Apply</a>' } });
  });
  app.get('/apply', (req, res) => sendPage(req, res, '/apply', { vars: { HEADER_NAV: '<a class="dsd-link" href="/login">Login</a>' } }));

  // Invite links: /invite/<token>.
  app.get('/invite/:token', async (req, res) => {
    const token = String(req.params.token || '');
    let ok = false;
    if (db.available() && /^[a-f0-9]{20,64}$/.test(token)) {
      const u = await db.one("SELECT id FROM users WHERE invite_token=$1 AND role='dsd' AND status='invited'", [token]).catch(() => null);
      ok = Boolean(u);
    }
    sendPage(req, res, '/invite', { vars: { TOKEN: ok ? token : '', VALID: ok ? '1' : '0', HEADER_NAV: '<a class="dsd-link" href="/login">Login</a>' } });
  });

  const portalGuard = async (req, res, next) => {
    const s = auth.readSession(req);
    if (!s) return res.redirect(302, '/login?next=/portal');
    if (!db.available()) return next();
    const u = await db.one('SELECT id, name, email, role, status FROM users WHERE id=$1', [s.sub]).catch(() => null);
    if (!u || u.status !== 'active') return res.redirect(302, '/login?next=/portal');
    req.user = u;
    next();
  };
  const adminGuard = async (req, res, next) => {
    const s = auth.readSession(req);
    if (!s) return res.redirect(302, '/login?next=/admin');
    if (!db.available()) return res.redirect(302, '/login');
    const u = await db.one('SELECT id, name, email, role, status FROM users WHERE id=$1', [s.sub]).catch(() => null);
    if (!u || u.status !== 'active') return res.redirect(302, '/login?next=/admin');
    if (u.role !== 'admin') return res.redirect(302, '/portal');
    req.user = u;
    next();
  };

  app.get('/portal', portalGuard, async (req, res) => {
    const pct = await getWholesalePct();
    sendPage(req, res, '/portal', {
      vars: {
        USER_NAME: site.escapeHtml(req.user.name || req.user.email),
        USER_EMAIL: req.user.email,
        WHOLESALE_PCT: String(pct),
        BOX_PRICE: pricing.formatCents(pricing.boxCentsFor(pct)),
        DISPLAY_PRICE: pricing.formatCents(pricing.displayCentsFor(pct)),
        PACKS_PER_BOX: String(pricing.PACKS_PER_BOX),
        PACKS_PER_DISPLAY: String(pricing.PACKS_PER_DISPLAY),
        HEADER_NAV: '<a class="dsd-link" href="/portal">Portal</a><a class="dsd-link muted" href="#" data-logout>Sign out</a>',
      },
    });
  });
  app.get('/admin', adminGuard, (req, res) => sendPage(req, res, '/admin', {
    vars: {
      USER_NAME: site.escapeHtml(req.user.name || req.user.email),
      HEADER_NAV: '<a class="dsd-link" href="/portal">Portal</a><a class="dsd-link muted" href="#" data-logout>Sign out</a>',
    },
  }));

  app.get('/success', async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    const id = typeof req.query.session_id === 'string' ? req.query.session_id : '';
    let session = null;
    if (stripe && SESSION_ID_RE.test(id)) {
      try { session = await stripe.checkout.sessions.retrieve(id, { expand: ['line_items'] }); }
      catch (err) { log.warn('[success] could not load session:', err && err.message); }
    }
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderer.render('/success', { origin: originFor(req), checkoutEnabled: Boolean(stripe), main: successHtml(session) }));
  });

  // Simple pages: privacy, terms, cancel.
  for (const route of ['/privacy', '/terms', '/cancel']) {
    app.get(route, (req, res) => sendPage(req, res, route));
  }

  // Templates are never served raw: /privacy.html -> /privacy, anything else .html -> 404.
  app.use((req, res, next) => {
    if (!/\.html?$/i.test(req.path)) return next();
    const clean = req.path.replace(/\.html?$/i, '').replace(/\/index$/, '/') || '/';
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    if (clean in site.PAGES) return res.redirect(301, clean + qs);
    return sendPage(req, res, '404', {}, 404);
  });

  const YEAR = 365 * 24 * 60 * 60;
  const assetCache = (req) => (typeof req.query.v === 'string' ? `public, max-age=${YEAR}, immutable` : 'public, max-age=3600');

  const css = site.minifyCss(fs.readFileSync(path.join(__dirname, 'public', 'css', 'styles.css'), 'utf8'));
  app.get('/css/styles.css', (req, res) => res.set('Cache-Control', assetCache(req)).type('text/css').send(css));

  app.use(
    express.static(path.join(__dirname, 'public'), {
      index: false,
      setHeaders(res, filePath) {
        const versioned = res.req && res.req.query && typeof res.req.query.v === 'string';
        if (versioned || /\.woff2$/.test(filePath)) res.setHeader('Cache-Control', `public, max-age=${YEAR}, immutable`);
        else if (/\.(avif|webp|png|jpg|svg|ico)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
        else res.setHeader('Cache-Control', 'public, max-age=3600');
      },
    })
  );

  if (typeof opts.extraRoutes === 'function') opts.extraRoutes(app);

  app.use((req, res) => sendPage(req, res, '404', {}, 404));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.set('Cache-Control', 'no-store');
    const wantsJson = req.originalUrl.startsWith('/api') || !req.accepts('html');
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Invalid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'Request too large.' });
    const status = Number(err && (err.status || err.statusCode));
    if (status >= 400 && status < 500) {
      if (wantsJson) return res.status(status).json({ ok: false, error: 'Bad request.' });
      if (status === 404) return sendPage(req, res, '404', {}, 404);
      return res.status(status).type('text/plain').send('Bad request.');
    }
    log.error('[error]', req.method, logPath(req.originalUrl), err && err.message);
    if (wantsJson) return res.status(500).json({ ok: false, error: 'Something went wrong.' });
    try { res.status(500).type('html').send(renderer.render('500', { origin: originFor(req), checkoutEnabled: Boolean(stripe) })); }
    catch (e) { res.status(500).type('text/plain').send('Something went wrong. Please try again in a moment.'); }
  });

  return app;
}

function start({ port = process.env.PORT ? Number(process.env.PORT) : 3000, graceMs = 10000, log = console } = {}) {
  const app = createApp({ logger: log });
  const server = app.listen(port, async (err) => {
    if (err) { log.error(`Could not listen on :${port}: ${err.message}`); process.exit(1); }
    log.log(`HELLA GOOD! DSD portal on :${server.address().port} (${keyStatus(process.env.STRIPE_SECRET_KEY)})`);
    if (db.available()) {
      try { await db.migrate(); await seedAdmin(log); } catch (e) { log.error('[db] migrate failed:', e.message); }
    }
  });
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    app.locals.draining = true;
    log.log(`[shutdown] ${signal}: finishing in-flight requests`);
    server.close((err) => { log.log('[shutdown] done'); process.exit(err ? 1 : 0); });
    server.closeIdleConnections();
    setTimeout(() => { log.error(`[shutdown] still busy after ${graceMs}ms, exiting`); server.closeAllConnections(); process.exit(1); }, graceMs).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) start();

module.exports = { createApp, start, buildWholesaleSession, orderSummary, successHtml, logPath, CHECKOUT_SOON, cleanSecretKey, cleanWebhookSecret, keyStatus, makeStripe, getWholesalePct };
