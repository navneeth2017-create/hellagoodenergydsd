'use strict';
/*
 * Postgres access for the HELLA GOOD! DSD portal. One pool, lazy-init (so the D2C-style
 * server can boot and serve pages even before DATABASE_URL is configured), and idempotent
 * migrations run once at boot.
 */
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : undefined,
      max: 10,
      connectionTimeoutMillis: 10000,
    })
  : null;

// Test seam: swap in an in-memory pool (e.g. pg-mem) so the DB-backed flows can run without Postgres.
let injected = null;
function _setPool(p) { injected = p; }
const activePool = () => injected || pool;

function available() {
  return Boolean(activePool());
}

async function query(text, params) {
  const p = activePool();
  if (!p) throw new Error('DATABASE_URL is not configured.');
  return p.query(text, params);
}
const one = async (text, params) => (await query(text, params)).rows[0] || null;
const all = async (text, params) => (await query(text, params)).rows;

/** Every CREATE TABLE/INDEX is IF NOT EXISTS so this is safe to run on every boot. */
async function migrate() {
  if (!available()) return;
  await query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    company TEXT,
    phone TEXT,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'dsd' CHECK (role IN ('admin','dsd')),
    status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','invited','active','disabled')),
    wholesale_pct NUMERIC(5,2),
    invite_token TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ
  )`);
  await query(`CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_session_id TEXT,
    items JSONB NOT NULL,
    subtotal_cents INTEGER NOT NULL,
    shipping_cents INTEGER NOT NULL,
    tax_cents INTEGER,
    total_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'paid',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC)');
  await query('CREATE INDEX IF NOT EXISTS idx_users_status ON users(status, created_at DESC)');
  await query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

/** A single key/value setting, falling back when unset. */
async function getSetting(key, fallback = null) {
  const row = await one('SELECT value FROM settings WHERE key=$1', [key]);
  return row ? row.value : fallback;
}
async function setSetting(key, value) {
  await query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)]
  );
}

async function close() {
  const p = activePool();
  if (p && p.end) await p.end().catch(() => {});
}

module.exports = { pool, available, query, one, all, migrate, close, getSetting, setSetting, _setPool };
