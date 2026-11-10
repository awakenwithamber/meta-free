'use strict';
// Password reset (owner directive 2026-11-07 — "Fix Authentication
// Across the Entire Awaken Network": every platform carries the same
// self-service recovery standard, first built for AwakenFlow).
//
// Design rules (deliberate — read before changing):
//  - Tokens are 32 crypto-random bytes. ONLY the SHA-256 hash is stored
//    (passwordResets.tokenHash, via auth.tokenHash — the same helper the
//    session store uses). The raw token exists in exactly one place: the
//    body of the queued outbox email, because a queued email is the
//    message that would be sent. Tokens never appear in the activity
//    log, in any API response, or in any log line.
//  - A token lives 60 minutes, is single-use, and requesting a new link
//    deletes every earlier unused token for that account.
//  - A successful reset changes the password AND deletes every session
//    for the account, so a stolen session dies with the old password.
//  - POST /api/password/forgot answers the SAME generic 200 for every
//    email — account or no account — so the endpoint cannot be used to
//    enumerate who has an account (the same anti-enumeration stance as
//    /api/login, which answers one generic message for every failure).
//  - Recovery NEVER bypasses identity verification (owner security
//    correction, 2026-11-07): the raw token travels ONLY inside the
//    outbound email addressed to the account's own verified email.
//    There is deliberately NO route, view, export, or log that reads a
//    token or link back out — no admin/outbox view displays them, and
//    workspace export excludes both collections (account-scoped rows).
//    There is NO founder/owner special case: every account, including
//    the platform owner's, recovers through this same email-only path.
//
// EMAIL DELIVERY — THE HONEST PART: no email provider is connected to
// Awaken Affordable Meta, so nothing can actually be sent. The reset email is
// written to the `outbox` collection with status QUEUED — visible
// evidence of what *would* be sent, addressed to the account's email,
// carrying the reset link. When a provider is connected later, its
// sender drains QUEUED outbox rows and this email goes out like any
// other; until then the API and the UI say "queued — not sent" in
// plain words and never pretend otherwise.
const crypto = require('crypto');
const auth = require('./auth');
const { logActivity } = require('./activity');

const TTL_MS = 60 * 60 * 1000; // reset links expire 60 minutes after the request

const GENERIC_MESSAGE = 'If an account exists for that email, a password reset link has been queued in the outbox. No email provider is connected to Awaken Affordable Meta yet, so the message is QUEUED — not sent. Reset links expire 60 minutes after they are requested.';
const INVALID_MESSAGE = 'This reset link is invalid or has expired. Please request a new one from the sign-in page.';

// ----- rate limiting (in-memory; per-IP and per-email buckets) -----
// Caps count REQUESTS, keyed by the submitted email and by connection,
// whether or not an account exists — and an over-cap request still gets
// the same generic 200, it simply creates nothing. No lockout: the cap
// window is one hour, it only ever throttles link creation, and it can
// never block signing in with a working password.
const WINDOW_MS = 60 * 60 * 1000;
const EMAIL_CAP = 5;  // reset links created per email per hour
const IP_CAP = 20;    // reset requests per connection per hour
const buckets = new Map(); // key -> { count, start }
function bucket(key, now) {
  let b = buckets.get(key);
  if (!b || now - b.start >= WINDOW_MS) { b = { count: 0, start: now }; buckets.set(key, b); }
  return b;
}
function overCap(ip, email, now) {
  return bucket('reset-email:' + email, now).count >= EMAIL_CAP
    || bucket('reset-ip:' + ip, now).count >= IP_CAP;
}
function noteRequest(ip, email, now) {
  bucket('reset-email:' + email, now).count += 1;
  bucket('reset-ip:' + ip, now).count += 1;
  if (buckets.size > 5000) for (const [k, b] of buckets) if (now - b.start >= WINDOW_MS) buckets.delete(k);
}

// Account-scoped audit: activity rows are workspace-scoped in this app,
// so the event is written to the activity log of the workspace the
// account belongs to (its first membership). Detail text carries no
// secrets — never a token, never a password.
function auditFor(store, user, action, detail) {
  const m = store.find('members', x => x.userId === user.id);
  if (m) logActivity(store, m.workspaceId, user.email, action, detail);
}

// Create a reset for `email` if an account exists. Returns
// { created: true, record } or { created: false } — callers must NOT
// surface the difference (the route answers GENERIC_MESSAGE either way).
function requestReset(store, { email, ip, origin }) {
  const now = Date.now();
  const cleanIp = ip || 'unknown';
  if (overCap(cleanIp, email, now)) return { created: false, capped: true };
  noteRequest(cleanIp, email, now);
  const user = store.find('users', u => u.email === email);
  if (!user) return { created: false };
  // A fresh request invalidates every earlier unused link for this user.
  store.removeWhere('passwordResets', r => r.userId === user.id && !r.usedAt);
  const rawToken = crypto.randomBytes(32).toString('hex'); // 32 bytes, hex-encoded
  const record = store.insert('passwordResets', {
    userId: user.id,
    tokenHash: auth.tokenHash(rawToken), // hash only — the raw token is never stored here
    expiresAt: new Date(now + TTL_MS).toISOString(),
    usedAt: null,
    requestedIp: cleanIp,
  });
  const link = `${origin}/reset-password?token=${rawToken}`;
  // Queue the email in the outbox (status QUEUED — not sent; no provider
  // is connected). workspaceId is null: this is account mail, not a
  // workspace message, so it never appears in a workspace export or
  // count, but it lives in the same collection a future provider
  // sender will drain.
  store.insert('outbox', {
    workspaceId: null,
    userId: user.id,
    channel: 'email',
    to: user.email,
    subject: 'Reset your Awaken Affordable Meta password',
    body: [
      'Hello,',
      '',
      'Someone asked to reset the password for this Awaken Affordable Meta account.',
      'Use this link within 60 minutes to choose a new password:',
      '',
      link,
      '',
      'If that was not you, ignore this message — your password has not changed.',
      '',
      'Awaken Affordable Meta — Enterprise Edition',
    ].join('\n'),
    status: 'QUEUED', // not sent externally — no provider connected
    source: 'password-reset',
    passwordResetId: record.id,
  });
  auditFor(store, user, 'password.reset.requested',
    'Password reset requested — reset link queued in the outbox (QUEUED, not sent: no email provider is connected)');
  return { created: true, record };
}

// The unused, unexpired reset record for a raw token, or null. Token
// validity errors are safe to state plainly (INVALID_MESSAGE) — a token
// proves nothing about whether an account exists until it validates.
function findValid(store, token, now = new Date()) {
  if (!token || typeof token !== 'string') return null;
  const rec = store.find('passwordResets', r => r.tokenHash === auth.tokenHash(token.trim()));
  if (!rec || rec.usedAt) return null;
  if (new Date(rec.expiresAt) < now) return null;
  return rec;
}

// Apply a validated reset: new salt/hash, token marked used, and EVERY
// session for the user deleted (the old password's sessions end here).
function consumeReset(store, record, newPassword) {
  const user = store.find('users', u => u.id === record.userId);
  if (!user) return null;
  const { salt, hash } = auth.hashPassword(newPassword);
  store.update('users', user.id, { salt, hash });
  store.update('passwordResets', record.id, { usedAt: new Date().toISOString() });
  store.removeWhere('sessions', s => s.userId === user.id);
  auditFor(store, user, 'password.reset',
    'Password changed with a reset link; all sessions for the account were signed out');
  return user;
}

// ---------- public pages (the app shell: /styles.css, .card, .banner) ----------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function shell(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Awaken Affordable Meta</title><link rel="stylesheet" href="/styles.css"></head>
<body>
<header><div class="brand"><span class="brand-font">Awaken Affordable Meta</span> <span class="badge">Enterprise Edition</span></div></header>
<main><section class="card">
${inner}
</section></main>
<footer><small>Awaken Affordable Meta — free forever, your data stays yours.</small></footer>
</body></html>`;
}

// Shown for a missing token: how to get a link, in plain words.
function requestHelpPage() {
  return shell('Reset your password', `
<h1 class="brand-font">Reset your password</h1>
<p class="banner" role="alert">This page needs a reset link. Links are requested from the sign-in page and expire 60 minutes after they are requested.</p>
<p>Go to the sign-in page, tap <strong>“Forgot your password?”</strong>, enter your email, and tap
<strong>“Email me a reset link”</strong>. If an account exists for that email, the reset message is
written and queued in Awaken Affordable Meta's outbox — no email provider is connected yet, so it is
<strong>queued, not sent</strong>.</p>
<p><a href="/">Go to the sign-in page</a></p>`);
}

// Shown for an invalid / expired / already-used token.
function invalidPage() {
  return shell('Reset your password', `
<h1 class="brand-font">Reset your password</h1>
<p class="err" role="alert">This reset link is invalid or has expired.</p>
<p>Reset links work once and expire 60 minutes after they are requested. Request a fresh one:
go to the sign-in page and tap <strong>“Forgot your password?”</strong>.</p>
<p><a href="/">Go to the sign-in page</a></p>`);
}

// The set-new-password form for a valid token. A server-rendered form
// plus a small inline script that posts JSON to /api/password/reset
// and shows the answer in the banner at the top of the card — the same
// prominent-notice pattern as the sign-in page, never a small hidden
// line. The 8-character rule is stated BEFORE the submit button, and
// each password box has its own labelled Show/Hide toggle.
function resetFormPage(token) {
  return shell('Choose a new password', `
<h1 class="brand-font">Choose a new password</h1>
<p class="banner" id="rp-notice" role="alert" hidden></p>
<p><strong>Password must be at least 8 characters.</strong> Choose a new password below, type it twice, then tap “Set new password”. Every device signed in with your old password will be signed out.</p>
<form id="rp-form">
<input type="hidden" id="rp-token" name="token" value="${esc(token)}">
<label for="rp-pw1">New password</label>
<input id="rp-pw1" name="password" type="password" autocomplete="new-password">
<button type="button" class="pw-toggle" data-target="rp-pw1" aria-pressed="false">Show password</button>
<label for="rp-pw2">Confirm new password</label>
<input id="rp-pw2" name="confirm-password" type="password" autocomplete="new-password">
<button type="button" class="pw-toggle" data-target="rp-pw2" aria-pressed="false">Show password</button>
<button type="submit">Set new password</button>
</form>
<p id="rp-done" hidden>Your password has been changed. <a href="/">Sign in with your new password</a>.</p>
<script>
document.querySelectorAll('.pw-toggle').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var input = document.getElementById(btn.getAttribute('data-target'));
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide password' : 'Show password';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    input.focus();
  });
});
document.getElementById('rp-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  var notice = document.getElementById('rp-notice');
  var pw1 = document.getElementById('rp-pw1').value;
  var pw2 = document.getElementById('rp-pw2').value;
  function fail(msg) { notice.textContent = msg; notice.className = 'err'; notice.hidden = false; notice.scrollIntoView({ block: 'nearest' }); }
  if (pw1.length < 8) { fail('Password must be at least 8 characters. Please choose a longer password.'); return; }
  if (pw1 !== pw2) { fail('The two passwords did not match. Please type the same new password in both boxes.'); return; }
  try {
    var r = await fetch('/api/password/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: document.getElementById('rp-token').value, password: pw1, confirm: pw2 }) });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) { fail(d.error || 'Something went wrong — please request a new reset link from the sign-in page.'); return; }
    document.getElementById('rp-form').hidden = true;
    notice.textContent = d.message || 'Your password has been changed.';
    notice.className = 'banner';
    notice.hidden = false;
    document.getElementById('rp-done').hidden = false;
  } catch (err) {
    fail('Could not reach the server — check your connection and try again.');
  }
});
</script>`);
}

module.exports = {
  TTL_MS, GENERIC_MESSAGE, INVALID_MESSAGE,
  requestReset, findValid, consumeReset,
  requestHelpPage, invalidPage, resetFormPage,
  _buckets: buckets, LIMITS: { WINDOW_MS, EMAIL_CAP, IP_CAP },
};
