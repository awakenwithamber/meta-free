'use strict';
// AwakenConnect — founder entitlement assertions: SHARED VERIFICATION
// LIBRARY. This exact file lives in every Awaken Network platform
// (AwakenFlow: app/lib/connect/, Meta Free: app/lib/connect/, Awaken
// Social: app/lib/connect/) so each platform can verify a central
// founder assertion LOCALLY — no network call to the center at request
// time, and the center being down can never lock the founder out (her
// platforms always fall back to their local enforcement).
//
// An assertion is a short-lived (≤ 15 minutes) HMAC-SHA256-signed token
// issued ONLY by AwakenFlow's AwakenConnect founder service, and ONLY
// for the founder's own account. The payload binds:
//   platform   — the one platform the assertion is valid on
//   sub        — SHA-256 hash of the founder's account email (the email
//                itself never travels in the token)
//   accountId  — the founder's account id on the ISSUING platform
//   scope      — 'founder-all-access'
//   iat / exp  — issued-at / expiry (unix seconds; exp − iat ≤ 15 min)
//
// The shared secret comes from the CONNECT_FOUNDER_SECRET environment
// variable on each deployment. FAIL-CLOSED: with no (or too short a)
// secret configured, verification is disabled and every presented
// assertion is rejected with reason 'disabled' — local enforcement
// then decides exactly as it always has. The secret is never logged,
// never stored in the database, and never returned by any function here
// (only its presence is reported).
//
// Verification NEVER grants anything to a non-founder account: the
// caller must pass the signed-in account's email, and the token's sub
// must equal that email's hash. Assertions are only ever minted for the
// founder identity, so a token that verifies for an account proves that
// account IS the founder account.
const crypto = require('crypto');

const HEADER = 'x-founder-assertion';
const SCOPE = 'founder-all-access';
const ISSUER = 'awakenconnect';
const MAX_TTL_SEC = 15 * 60; // assertions live at most 15 minutes
const CLOCK_SKEW_SEC = 60;
const MIN_SECRET_LEN = 16;

function getSecret(env = process.env) {
  const s = env && env.CONNECT_FOUNDER_SECRET;
  return (typeof s === 'string' && s.length >= MIN_SECRET_LEN) ? s : null;
}
// Whether central assertion verification/issuance is configured at all.
function enabled(env = process.env) { return getSecret(env) !== null; }

function emailHash(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
}

function signAssertion(claims, env = process.env) {
  const secret = getSecret(env);
  if (!secret) { const e = new Error('CONNECT_FOUNDER_SECRET is not configured — assertion issuance is disabled.'); e.code = 'issuance-disabled'; throw e; }
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

// verifyAssertion(token, { platform, email, accountId, now, env })
// → { ok: true, claims } | { ok: false, reason }
// Reasons: 'disabled' | 'malformed' | 'bad-signature' | 'bad-payload' |
// 'wrong-scope' | 'wrong-platform' | 'wrong-account' | 'bad-times' |
// 'expired' | 'not-yet-valid'.
function verifyAssertion(token, opts = {}) {
  const { platform, email, accountId, now = Date.now(), env = process.env } = opts;
  const fail = (reason) => ({ ok: false, reason });
  const secret = getSecret(env);
  if (!secret) return fail('disabled');
  if (typeof token !== 'string' || !token) return fail('malformed');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return fail('malformed');
  const [payloadB64, sigB64] = parts;
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  let given;
  try { given = Buffer.from(sigB64, 'base64url'); } catch { return fail('bad-signature'); }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return fail('bad-signature');
  let claims;
  try { claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); }
  catch { return fail('bad-payload'); }
  if (!claims || typeof claims !== 'object') return fail('bad-payload');
  if (claims.iss !== ISSUER || claims.scope !== SCOPE) return fail('wrong-scope');
  if (platform && claims.platform !== platform) return fail('wrong-platform');
  // Account binding: the assertion must belong to the account presenting
  // it. Callers pass the signed-in account's email (and id where the ids
  // are comparable); a mismatch means this token is not theirs.
  if (email && claims.sub !== emailHash(email)) return fail('wrong-account');
  if (accountId && claims.accountId && claims.accountId !== accountId) return fail('wrong-account');
  const iat = Number(claims.iat), exp = Number(claims.exp);
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat || exp - iat > MAX_TTL_SEC + CLOCK_SKEW_SEC) return fail('bad-times');
  const nowSec = Math.floor(now / 1000);
  if (nowSec >= exp) return fail('expired');
  if (iat > nowSec + CLOCK_SKEW_SEC) return fail('not-yet-valid');
  return { ok: true, claims };
}

// checkRequest(req, opts) — reads the X-Founder-Assertion header.
// → { presented: false, ok: false, reason: 'absent' } when no header was
// sent (the normal case — local enforcement decides, nothing to log), or
// { presented: true, ...verifyAssertion(...) } when one was.
function checkRequest(req, opts = {}) {
  const raw = req && req.headers ? req.headers[HEADER] : null;
  if (!raw || typeof raw !== 'string') return { presented: false, ok: false, reason: 'absent' };
  return { presented: true, ...verifyAssertion(raw.trim(), opts) };
}

module.exports = {
  HEADER, SCOPE, ISSUER, MAX_TTL_SEC, MIN_SECRET_LEN,
  enabled, emailHash, signAssertion, verifyAssertion, checkRequest,
};
