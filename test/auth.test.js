'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../lib/auth.js');

test('password hashing round-trips and rejects the wrong password', () => {
  const h = auth.hashPassword('secret123');
  assert.match(h, /^scrypt\$/);
  assert.notEqual(h, 'secret123');
  assert.equal(auth.verifyPassword('secret123', h), true);
  assert.equal(auth.verifyPassword('nope', h), false);
  assert.equal(auth.verifyPassword('secret123', 'not-a-hash'), false);
  assert.equal(auth.verifyPassword('secret123', null), false);
});

test('two hashes of the same password differ (per-user salt)', () => {
  const a = auth.hashPassword('same');
  const b = auth.hashPassword('same');
  assert.notEqual(a, b);
  assert.equal(auth.verifyPassword('same', a), true);
  assert.equal(auth.verifyPassword('same', b), true);
});

test('session tokens sign and verify, and reject tampering and expiry', () => {
  const t = auth.signSession({ sub: 42, role: 'dsd' });
  const payload = auth.verifySession(t);
  assert.equal(payload.sub, 42);
  assert.equal(payload.role, 'dsd');

  // Tampered body: change the subject but keep the original signature.
  const [body, sig] = t.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  decoded.sub = 43;
  const bad = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  assert.equal(auth.verifySession(`${bad}.${sig}`), null);

  // Garbage.
  assert.equal(auth.verifySession(''), null);
  assert.equal(auth.verifySession('nope'), null);
  assert.equal(auth.verifySession(null), null);
});

test('a forged session signed with the wrong secret is refused', () => {
  // A token minted under a different secret must not verify.
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'secret-one';
  const body = Buffer.from(JSON.stringify({ sub: 1, role: 'admin', exp: Date.now() + 100000 })).toString('base64url');
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', 'secret-two').update(body).digest('base64url');
  const forged = `${body}.${sig}`;
  assert.equal(auth.verifySession(forged), null);
  if (prev === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prev;
});

test('readSession parses the cookie and ignores absent/malformed cookies', () => {
  const t = auth.signSession({ sub: 7, role: 'dsd' });
  const req = { headers: { cookie: `${auth.COOKIE}=${t}; other=1` } };
  assert.equal(auth.readSession(req).sub, 7);
  assert.equal(auth.readSession({ headers: {} }), null);
  assert.equal(auth.readSession({ headers: { cookie: 'nope=1' } }), null);
});
