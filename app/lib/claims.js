'use strict';
// Founder-claim hardening (2026-11-07): registering with a founder email
// (lib/config OWNER_CLAIM_EMAILS) NO LONGER grants the platform-owner role.
// It creates the account with claimStatus 'pending' and issues a ONE-TIME
// claim code. The code record lives ONLY in the 'claimCodes' collection —
// the operator store. It is never returned by any API response; the
// platform operator reads it out-of-band from the database itself (the way
// Muse reads the production DB when performing owner verification).
//
// Verification compares HASHES (sha256, timing-safe), is rate-limited per
// code (MAX_ATTEMPTS wrong tries lock the code), and is single-use: a
// 'used' or 'locked' or 'superseded' code can never verify. A locked code
// is replaced by a fresh one when the founder signs in again (see server),
// so the founder can never lock herself out permanently — the replacement
// code, too, exists only in the operator store.
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_ATTEMPTS = 5;

function newCode() {
  return 'MF-' + Array.from(crypto.randomBytes(10)).map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code || '').trim().toUpperCase()).digest('hex');
}

// Returns the live pending code record if one exists; otherwise supersedes
// any stale records and issues a fresh one.
function issueClaimCode(store, user) {
  const live = store.find('claimCodes', c => c.userId === user.id && c.status === 'pending');
  if (live) return live;
  for (const c of store.all('claimCodes', c => c.userId === user.id && (c.status === 'locked' || c.status === 'pending'))) {
    store.update('claimCodes', c.id, { status: 'superseded' });
  }
  const code = newCode();
  return store.insert('claimCodes', {
    userId: user.id,
    email: user.email,
    // Plaintext is stored ONLY so the operator can read it back out-of-band
    // from the database; verification below never compares plaintext.
    code,
    codeHash: hashCode(code),
    attempts: 0,
    status: 'pending',
    usedAt: null,
  });
}

function verifyClaimCode(store, user, submitted) {
  const mine = store.all('claimCodes', c => c.userId === user.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const rec = mine.find(c => c.status === 'pending') || mine[0] || null;
  if (!rec) return { ok: false, reason: 'no-code' };
  if (rec.status === 'locked') return { ok: false, reason: 'locked' };
  if (rec.status !== 'pending') return { ok: false, reason: 'no-code' };
  const candidate = Buffer.from(hashCode(submitted), 'hex');
  const stored = Buffer.from(rec.codeHash, 'hex');
  const match = candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  if (!match) {
    const attempts = (rec.attempts || 0) + 1;
    const locked = attempts >= MAX_ATTEMPTS;
    store.update('claimCodes', rec.id, { attempts, ...(locked ? { status: 'locked' } : {}) });
    return { ok: false, reason: locked ? 'locked' : 'mismatch', attempts };
  }
  store.update('claimCodes', rec.id, { status: 'used', usedAt: new Date().toISOString() });
  return { ok: true };
}

module.exports = { MAX_ATTEMPTS, newCode, hashCode, issueClaimCode, verifyClaimCode };
