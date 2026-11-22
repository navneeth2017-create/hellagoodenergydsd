'use strict';
/*
 * DSD authentication: scrypt password hashes and a signed session token in an httpOnly cookie.
 * No extra dependencies — Node's crypto covers both.
 *
 *   hashPassword(pw) / verifyPassword(pw, stored)   — scrypt, per-user salt
 *   signSession({id, role}) / verifySession(token)  — HMAC-SHA256, expiring payload
 *   setSessionCookie / clearSessionCookie           — httpOnly, SameSite=Lax, Secure in prod
 *   readSession(req)                                 — the payload (or null) from the cookie
 */
const crypto = require('crypto');

const SECRET = () => process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const COOKIE = 'hgd_dsd';
const TTL_MS = 1000 * 60 * 60 * 24 * 14; // two weeks

/* ---------- passwords ---------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}

/* ---------- session token ---------- */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signSession(payload) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + TTL_MS }));
  const sig = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.sub !== 'number' || !(payload.exp > Date.now())) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/* ---------- cookies ---------- */

const sameSite = 'Lax';
const secureFlag = () => (process.env.NODE_ENV === 'production' ? '; Secure' : '');

function setSessionCookie(res, token) {
  const maxAge = Math.floor(TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secureFlag()}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${secureFlag()}`);
}

function readSession(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return verifySession(decodeURIComponent(v.join('=')));
  }
  return null;
}

module.exports = {
  COOKIE, TTL_MS,
  hashPassword, verifyPassword,
  signSession, verifySession,
  setSessionCookie, clearSessionCookie, readSession,
};
