'use strict';
// Sign-in throttling (Awaken Meta PKG-11, Phase 9). In-memory,
// zero-dependency. Mirrors the ecosystem pattern in AwakenFlow's
// app/lib/ratelimit.js, adapted to this stack in one deliberate way:
// every threshold is read from the environment at call time, because
// this app's rollback story is a config gate, not a code change —
// LOGIN_THROTTLE=off disables throttling entirely.
//
// Design rules (deliberate — read before tuning):
//  - Progressive delay per ACCOUNT: after FREE_FAILURES failed attempts
//    inside the window, each further attempt is slowed (base delay
//    doubling, capped). The delay follows the ACCOUNT (the submitted
//    email), not the connection, so distributed guessing against one
//    account slows down too. Counters are keyed by the submitted email
//    whether or not an account exists, so throttle behavior can never
//    be used to probe which emails have accounts.
//  - Hard caps answer 429, but ONLY per connection: PAIR_CAP failures
//    for one (connection, account) pair, or IP_CAP failures from one
//    connection across all accounts, inside the window.
//  - There is NO account-wide lockout. The owner can always sign in
//    from a fresh connection — at worst after the short progressive
//    delay — so an attacker cannot weaponise throttling to lock the
//    owner out of her own platform.
//  - A successful sign-in clears the (connection, account) counter.
//  - The 429 message follows the owner's visible-notices rule: plain
//    words, says what is checkable, and points at the password-reset
//    path — a paused user is guided, never trapped.
//  - This module is consulted ONLY by the sign-in route. No other
//    route slows down or caps because of it.
const DEFAULTS = {
  WINDOW_MS: 15 * 60 * 1000,
  FREE_FAILURES: 3,
  BASE_DELAY_MS: 100,
  MAX_DELAY_MS: 2000,
  PAIR_CAP: 20,
  IP_CAP: 50,
};

function num(v, d, allowZero) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return (allowZero ? n >= 0 : n > 0) ? Math.floor(n) : d;
}
function config(env) {
  const e = env || process.env;
  const off = ['off', '0', 'false', 'no'].includes(String(e.LOGIN_THROTTLE || '').trim().toLowerCase());
  return {
    enabled: !off,
    windowMs: num(e.LOGIN_THROTTLE_WINDOW_MS, DEFAULTS.WINDOW_MS),
    freeFailures: num(e.LOGIN_THROTTLE_FREE_FAILURES, DEFAULTS.FREE_FAILURES, true),
    baseDelayMs: num(e.LOGIN_THROTTLE_BASE_DELAY_MS, DEFAULTS.BASE_DELAY_MS, true),
    maxDelayMs: num(e.LOGIN_THROTTLE_MAX_DELAY_MS, DEFAULTS.MAX_DELAY_MS, true),
    pairCap: num(e.LOGIN_THROTTLE_PAIR_CAP, DEFAULTS.PAIR_CAP),
    ipCap: num(e.LOGIN_THROTTLE_IP_CAP, DEFAULTS.IP_CAP),
  };
}
function enabled(env) { return config(env).enabled; }

const buckets = new Map(); // key -> { count, start }
function bucket(key, now, cfg) {
  let b = buckets.get(key);
  if (!b || now - b.start >= cfg.windowMs) { b = { count: 0, start: now }; buckets.set(key, b); }
  return b;
}
function prune(now, cfg) {
  if (buckets.size < 5000) return;
  for (const [k, b] of buckets) if (now - b.start >= cfg.windowMs) buckets.delete(k);
}
const acctKey = email => 'acct:' + email;
const pairKey = (ip, email) => `pair:${ip}|${email}`;
const ipKey = ip => 'ip:' + ip;

function delayFor(email, now = Date.now(), env) {
  const cfg = config(env);
  if (!cfg.enabled) return 0;
  const c = bucket(acctKey(email), now, cfg).count;
  if (c <= cfg.freeFailures) return 0;
  return Math.min(cfg.baseDelayMs * 2 ** (c - cfg.freeFailures - 1), cfg.maxDelayMs);
}
function capped(ip, email, now = Date.now(), env) {
  const cfg = config(env);
  if (!cfg.enabled) return false;
  return bucket(pairKey(ip, email), now, cfg).count >= cfg.pairCap
    || bucket(ipKey(ip), now, cfg).count >= cfg.ipCap;
}
// Seconds until the capping bucket(s) reset — used only to word the
// 429 message honestly ("about N more minutes"), never as data.
function retryAfterSeconds(ip, email, now = Date.now(), env) {
  const cfg = config(env);
  let until = 0;
  for (const [key, cap] of [[pairKey(ip, email), cfg.pairCap], [ipKey(ip), cfg.ipCap]]) {
    const b = bucket(key, now, cfg);
    if (b.count >= cap) until = Math.max(until, b.start + cfg.windowMs - now);
  }
  return Math.max(1, Math.ceil(until / 1000));
}
function recordFailure(ip, email, now = Date.now(), env) {
  const cfg = config(env);
  if (!cfg.enabled) return;
  bucket(acctKey(email), now, cfg).count += 1;
  bucket(pairKey(ip, email), now, cfg).count += 1;
  bucket(ipKey(ip), now, cfg).count += 1;
  prune(now, cfg);
}
function recordSuccess(ip, email) { buckets.delete(pairKey(ip, email)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// The lockout message (owner's visible-notices rule): prominent, plain
// words, states what happened, what can be checked, and the way back
// in. Rendered by the sign-in form's error line, which the user is
// already looking at.
function lockoutMessage(retrySec) {
  const mins = Math.max(1, Math.ceil((Number(retrySec) || 0) / 60));
  return `Too many failed sign-in attempts from this connection. Sign-in from here is paused for about ${mins} more minute${mins === 1 ? '' : 's'}. Check that you're using the email and password for this account — passwords are case-sensitive — then try again when the pause ends, or use "Forgot your password?" below to reset it.`;
}

module.exports = {
  config, enabled, delayFor, capped, retryAfterSeconds,
  recordFailure, recordSuccess, sleep, lockoutMessage,
  DEFAULTS, _buckets: buckets,
};
