'use strict';
// Meta Free — zero-dependency server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./lib/store');
const { blobBackendFromEnv } = require('./lib/blob');
const auth = require('./lib/auth');
const { parseCommand, PLATFORMS } = require('./lib/nl');
const assistant = require('./lib/assistant');
const analytics = require('./lib/analytics');
const { listPlugins, BUILTIN } = require('./lib/plugins');
const { CANONICAL, seedConnections } = require('./lib/connections');
const { runCompletion } = require('./lib/agent');
const enterprise = require('./lib/enterprise');
const plansLib = require('./lib/plans');
const billing = require('./lib/billing');
const beta = require('./lib/beta');
const claims = require('./lib/claims');
const providers = require('./lib/providers');
const stripeLib = require('./lib/providers/stripe');
const verifyFounder = require('./lib/connect/verify-founder');
const passwordReset = require('./lib/password-reset');
const consent = require('./lib/consent');
const legal = require('./lib/legal');
const config = require('./lib/config');
const { logActivity, listActivity } = require('./lib/activity');
const approvals = require('./lib/approvals');
const backupsLib = require('./lib/backups');
const feeds = require('./lib/feeds');
const brands = require('./lib/brands');
const campaignsLib = require('./lib/campaigns');
const audiencesLib = require('./lib/audiences');
const measurementLib = require('./lib/measurement');
const ratelimit = require('./lib/ratelimit');

const PORT = process.env.PORT || 4173;
const ROOT = path.join(__dirname, '..');
// Storage (docs/07): with BLOB_READ_WRITE_TOKEN set (Vercel adds it when the Blob store
// is connected), the DB lives in a durable private Blob and survives deploys/restarts.
// META_FREE_DB forces the file backend. Otherwise: durable local data/db.json; on Vercel
// without a Blob store, /tmp — ephemeral per function instance (a try-it limit only).
const DATA_FILE = process.env.META_FREE_DB || (process.env.VERCEL ? '/tmp/meta-free-db.json' : path.join(ROOT, 'data', 'db.json'));
const blobBackend = process.env.META_FREE_DB ? null : blobBackendFromEnv();
const store = blobBackend ? new Store(null, blobBackend) : new Store(DATA_FILE);
const PUBLIC = path.join(ROOT, 'public');

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2_000_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
// The RAW body, unparsed — Stripe's webhook signature is computed over
// the exact bytes Stripe sent, so the webhook route must not go
// through the JSON-parsing readBody above.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2_000_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const token = cookies(req).mf_session;
  if (!token) return null;
  const sess = store.find('sessions', s => s.tokenHash === auth.tokenHash(token));
  if (!sess) return null;
  if (new Date(sess.expiresAt) < new Date()) { store.remove('sessions', sess.id); return null; }
  return store.find('users', u => u.id === sess.userId);
}
function slugify(s) { return String(s || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page'; }
// Connection identity for rate limiting: the first forwarded hop when a
// proxy set one (Vercel does), else the socket address.
function clientIp(req) {
  const fwd = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}
// Absolute origin of THIS deployment, for password-reset links — they
// always point back at our own /reset-password page.
function requestOrigin(req) {
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim() || 'http';
  const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'localhost');
  return `${proto}://${host}`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// Sign-in timing equalizer (PKG-11): when the submitted email has no
// account, the login handler still runs one full password verification
// against this fixed dummy pair, so response timing cannot reveal
// whether the account exists. The dummy password is not a credential —
// it belongs to no account and its verification result is discarded.
const DUMMY_SALT = 'pkg11-dummy-salt-00000000000000';
const DUMMY_HASH = '79aad4dc5727685494177d2248be26da9a803308b35fe13474985d357dea13c23dd13d2553c3be5a108cd198783799030f30a8b768574a3081bb4667f8977f8d';

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  // Durable backend: never end a response while a write-through save is still in
  // flight — on serverless the instance can freeze the moment the response ends.
  const rawEnd = res.end.bind(res);
  let endCalled = false;
  res.end = (...args) => {
    if (endCalled) return;
    endCalled = true;
    Promise.resolve(store.flush()).catch(() => {}).then(() => rawEnd(...args));
  };
  try {
    await store.init(); // loads the durable document once per instance (no-op for file backend)
    // ---------- public link page ----------
    if (req.method === 'GET' && p.startsWith('/p/')) {
      const slug = decodeURIComponent(p.slice(3));
      const ws = store.find('workspaces', w => w.slug === slug);
      if (!ws) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<h1>Page not found</h1>'); }
      const links = store.all('links', l => l.workspaceId === ws.id).sort((a, b) => (a.sort || 0) - (b.sort || 0));
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ws.name)} — Links</title><link rel="stylesheet" href="/styles.css"></head>
<body class="linkpage"><main><h1 class="brand-font">${esc(ws.name)}</h1><p>${esc(ws.tagline || '')}</p>
${links.map(l => `<a class="linkbtn" href="/go/${l.id}" rel="noopener">${esc(l.title)}</a>`).join('\n')}
<footer><small>Powered by Awaken Affordable Meta — free forever, your data stays yours.</small></footer></main></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html);
    }
    if (req.method === 'GET' && p.startsWith('/go/')) {
      const link = store.find('links', l => l.id === p.slice(4));
      if (!link) { res.writeHead(404); return res.end('not found'); }
      store.update('links', link.id, { clicks: (link.clicks || 0) + 1 });
      res.writeHead(302, { Location: link.url }); return res.end();
    }

    // ---------- Terms Acceptance System (owner directive 2026-11-07) ----------
    // Public legal pages + the policy info clients use to render the
    // acceptance UI. The documents are DRAFTS and every page says so in
    // a prominent banner. Enforcement is behind CONSENT_ENFORCEMENT
    // (default off — lib/consent.js): with the flag off, nothing in
    // registration or trials changes; these routes simply exist.
    if (req.method === 'GET' && p === '/legal/terms') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(legal.termsPage()); }
    if (req.method === 'GET' && p === '/legal/privacy') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(legal.privacyPage()); }
    if (req.method === 'GET' && p === '/api/consent/policy') return json(res, 200, consent.policyView());

    // ---------- public rate card (landing page) ----------
    // The founding rate card is public information (docs/09): the landing
    // page renders its pricing table from this endpoint so the public
    // numbers can never drift from lib/plans.js. Rate-card data ONLY —
    // no user, workspace, or waitlist data is exposed here.
    if (req.method === 'GET' && p === '/api/plans/public') {
      return json(res, 200, {
        plans: plansLib.plans(),
        free: plansLib.freePlan(),
        source: plansLib.SOURCE,
        foundingLabel: plansLib.FOUNDING_LABEL,
        interestLabel: plansLib.INTEREST_LABEL,
        paymentNote: plansLib.PAYMENT_NOTE,
        honestLimit: enterprise.HONEST_LIMIT,
      });
    }

    // ---------- Stripe webhooks (AwakenPay provider boundary) ----------
    // Public by necessity (Stripe cannot sign in), and exempt from the
    // /api auth gate below for exactly this path — the Stripe-Signature
    // header is the authentication. DARK while unconfigured: until a
    // full, valid Stripe key set exists in the environment, every
    // method on this path returns the same 404 (mirroring AwakenFlow).
    // When configured, POST verifies the signature over the RAW body
    // (5-minute replay window) and applies the event idempotently.
    if (p === '/api/billing/webhooks/stripe') {
      const stripeCfg = stripeLib.getStripeConfig(process.env);
      if (!stripeCfg.configured) return json(res, 404, { error: 'Stripe webhooks are not configured on this deployment.' });
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found.' });
      const raw = await readRawBody(req);
      const verdict = stripeLib.verifyStripeSignature(raw, req.headers['stripe-signature'], stripeCfg.webhookSecret, new Date());
      if (!verdict.ok) return json(res, 400, { error: 'Webhook signature verification failed.' });
      let event;
      try { event = JSON.parse(raw); } catch { return json(res, 400, { error: 'Webhook payload was not valid JSON.' }); }
      const applied = stripeLib.processStripeEvent(store, event);
      if (!applied.ok) return json(res, 400, { error: 'Webhook event was malformed.' });
      return json(res, 200, { received: true, ...(applied.duplicate ? { duplicate: true } : {}) });
    }

    // ---------- Awaken Meta feed ingest (PKG-1, lib/feeds.js) ----------
    // Public by necessity (the scheduled feed jobs are not signed in),
    // and exempt from the /api auth gate below for exactly this path —
    // the service token is the authentication. The token exists only
    // as its SHA-256 hash in FEED_INGEST_TOKEN_HASH (the passwordResets
    // pattern); the plaintext is never logged or stored. DARK while
    // unconfigured: with no valid hash in the environment, every
    // method on this path returns the same 404.
    if (p === '/api/feeds/ingest') {
      if (!feeds.expectedTokenHash(process.env)) return json(res, 404, { error: 'Feed ingest is not configured on this deployment.' });
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found.' });
      const bearer = String(req.headers.authorization || '');
      const presented = req.headers['x-feed-token'] || (bearer.startsWith('Bearer ') ? bearer.slice(7) : null);
      if (!feeds.tokenOk(presented, process.env)) return json(res, 401, { error: 'Feed token rejected.' });
      const b = await readBody(req);
      if (!store.find('workspaces', w => w.id === String(b.workspaceId || ''))) return json(res, 404, { error: 'Workspace not found.' });
      const out = feeds.ingest(store, b);
      if (!out.ok) return json(res, 400, { error: out.error });
      return json(res, 200, out);
    }

    // ---------- auth ----------
    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req);
      if (!auth.validEmail(b.email)) return json(res, 400, { error: 'Enter a valid email.' });
      if (!auth.strongEnough(b.password)) return json(res, 400, { error: 'Password must be at least 8 characters.' });
      if (store.find('users', u => u.email === b.email.toLowerCase())) return json(res, 409, { error: 'That email already has an account on this instance.' });
      // Terms Acceptance System: while enforcement is on, no account is
      // created without a valid, current-version Terms acceptance in
      // the request (lib/consent.js). Flag off = unchanged behavior.
      const consentOn = consent.enforcementOn();
      if (consentOn) {
        const tv = consent.validateTermsAcceptance(b);
        if (!tv.ok) return json(res, 400, { error: tv.error });
      }
      const { salt, hash } = auth.hashPassword(b.password);
      // Platform-owner claim (lib/config, hardened 2026-11-07): a claim email
      // NO LONGER grants the owner role at registration. The account starts
      // as claimStatus 'pending' with a one-time claim code in the operator
      // store (lib/claims) — the role activates only when the holder enters
      // that code via /api/claim/verify. Any role/platformRole a client
      // submits in the register body is ignored — the fields below are a
      // whitelist.
      const founder = config.isOwnerEmail(b.email);
      const user = store.insert('users', { email: b.email.toLowerCase(), salt, hash, name: String(b.name || '').slice(0, 80), platformRole: 'member', ...(founder ? { claimStatus: 'pending' } : {}) });
      if (consentOn) consent.recordRegistrationConsents(store, req, user, b, { source: 'registration' });
      if (founder) claims.issueClaimCode(store, user);
      const wsName = String(b.workspace || 'My Brand').slice(0, 80);
      let slug = slugify(wsName); let n = 1;
      while (store.find('workspaces', w => w.slug === slug)) slug = slugify(wsName) + '-' + (++n);
      // New workspaces start on the permanent Free plan (not grandfathered).
      const ws = store.insert('workspaces', { name: wsName, slug, tagline: '', ownerId: user.id, edition: enterprise.EDITION, planId: 'free', grandfathered: false, plugins: {}, widgets: { planner: true, inbox: true, analytics: true, links: true, bestTimes: true, competitors: true } });
      ws.workspaceId = ws.id; store.save();
      store.insert('members', { workspaceId: ws.id, userId: user.id, email: user.email, role: 'owner' });
      return startSession(res, user, { ok: true, workspace: publicWs(ws), platformRole: platformRoleOf(user), ...(founder ? { claimStatus: 'pending' } : {}), ...(consentOn ? { consent: consent.statusFor(store, user, { founderExempt: founder }) } : {}) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').toLowerCase();
      const ip = clientIp(req);
      // Sign-in throttling (PKG-11, lib/ratelimit.js — mirrors the
      // AwakenFlow pattern; config-gated by LOGIN_THROTTLE). Hard caps
      // answer 429 with the plain-language pause message; the
      // per-account progressive delay is applied before verification.
      // There is no account-wide lockout: caps bind connections, so
      // the owner can always sign in from a fresh connection.
      if (ratelimit.enabled()) {
        if (ratelimit.capped(ip, email)) {
          return json(res, 429, { error: ratelimit.lockoutMessage(ratelimit.retryAfterSeconds(ip, email)) });
        }
        const d = ratelimit.delayFor(email);
        if (d > 0) await ratelimit.sleep(d);
      }
      let user = store.find('users', u => u.email === email);
      // Unknown email and wrong password get the IDENTICAL 401 body,
      // and the unknown-email path runs a dummy verification so the
      // timing matches too (no account-existence oracle).
      let passwordOk = false;
      if (user) passwordOk = auth.verifyPassword(String(b.password || ''), user.salt, user.hash);
      else auth.verifyPassword(String(b.password || ''), DUMMY_SALT, DUMMY_HASH);
      if (!passwordOk) {
        if (ratelimit.enabled()) ratelimit.recordFailure(ip, email);
        return json(res, 401, { error: 'Email or password did not match.' });
      }
      if (ratelimit.enabled()) ratelimit.recordSuccess(ip, email);
      // Claim state at sign-in (hardened): sign-in NEVER grants the owner
      // role. It only (a) leaves an already-claimed owner untouched, and
      // (b) makes sure an unverified founder account is 'pending' with a
      // live claim code in the operator store (a locked code is replaced,
      // so the founder cannot lock herself out — the fresh code, too,
      // exists only in the database). No other account takes this path.
      user = applyClaimState(user);
      // Terms Acceptance System: sign-in always succeeds on valid
      // credentials; while enforcement is on the response carries the
      // reacceptance state so the client can prompt (gated APIs refuse
      // until re-acceptance; the founder is prompted, never blocked).
      return startSession(res, user, { ok: true, platformRole: platformRoleOf(user), ...(config.isOwnerEmail(user.email) ? { claimStatus: user.claimStatus || null } : {}), ...(consent.enforcementOn() ? { consent: consent.statusFor(store, user, { founderExempt: config.isOwnerEmail(user.email) }) } : {}) });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const token = cookies(req).mf_session;
      if (token) { const s = store.find('sessions', x => x.tokenHash === auth.tokenHash(token)); if (s) store.remove('sessions', s.id); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'mf_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
      return res.end('{"ok":true}');
    }

    // ---------- password reset (owner directive 2026-11-07) ----------
    // Public on purpose — this is how a locked-out account gets back in.
    // forgot: ALWAYS the same generic 200, account or no account (no
    // enumeration). If the account exists, lib/password-reset.js stores
    // a hashed token and queues the reset email in the outbox (QUEUED —
    // not sent; no email provider is connected, and the message says so).
    if (p === '/api/password/forgot' && req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').toLowerCase().trim();
      if (auth.validEmail(email)) {
        passwordReset.requestReset(store, { email, ip: clientIp(req), origin: requestOrigin(req) });
      }
      return json(res, 200, { ok: true, message: passwordReset.GENERIC_MESSAGE });
    }
    // reset: the token is validated first (one plain message for
    // invalid / expired / used), then the same 8-character rule as
    // registration. Success changes the password and revokes ALL of the
    // user's sessions (inside consumeReset).
    if (p === '/api/password/reset' && req.method === 'POST') {
      const b = await readBody(req);
      const rec = passwordReset.findValid(store, String(b.token || ''));
      if (!rec) return json(res, 400, { error: passwordReset.INVALID_MESSAGE });
      if (!auth.strongEnough(b.password)) return json(res, 400, { error: 'Password must be at least 8 characters.' });
      if (b.confirm !== undefined && b.confirm !== null && String(b.confirm) !== String(b.password)) {
        return json(res, 400, { error: 'The two passwords did not match. Please type the same new password in both boxes.' });
      }
      const user = passwordReset.consumeReset(store, rec, String(b.password));
      if (!user) return json(res, 400, { error: passwordReset.INVALID_MESSAGE });
      return json(res, 200, { ok: true, message: 'Your password has been changed. Sign in with your new password.' });
    }
    // The reset page itself: the token in the link is the credential. A
    // valid, unused, unexpired token gets the set-new-password form;
    // anything else gets a plain-language page that guides instead of
    // trapping. Page builders live in lib/password-reset.js.
    if (req.method === 'GET' && p === '/reset-password') {
      const token = (url.searchParams.get('token') || '').trim();
      if (!token) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(passwordReset.requestHelpPage()); }
      if (!passwordReset.findValid(store, token)) { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(passwordReset.invalidPage()); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(passwordReset.resetFormPage(token));
    }

    // everything below requires login
    const user = currentUser(req);
    if (p.startsWith('/api/')) {
      if (!user) return json(res, 401, { error: 'Please sign in.' });
      const member = store.find('members', m => m.userId === user.id);
      if (!member && p !== '/api/me') return json(res, 403, { error: 'No workspace membership.' });
      const wsId = member ? member.workspaceId : null;
      const ws = wsId ? store.find('workspaces', w => w.id === wsId) : null;
      // Grandfathering: a workspace record from before the Free plan existed
      // has no plan fields — stamp it grandfathered on first touch so it
      // keeps the full Enterprise set it has always had (lib/billing).
      if (ws) billing.ensureWorkspacePlan(store, ws);
      const canWrite = member && (member.role === 'owner' || member.role === 'editor');
      const act = (action, detail) => logActivity(store, wsId, user.email, action, detail);

      // AwakenConnect central founder assertion (Founder & Pricing
      // Directive 2026-11-07 §1/§5) — an ADDITIONAL accepted proof of
      // founder scope, verified LOCALLY with the shared library (no
      // network call). The local hardened-claim enforcement above stays
      // the base layer and decides exactly as it always has whenever no
      // valid assertion is presented: the founder is NEVER locked out
      // because the center is down or unconfigured. A presented-but-
      // invalid assertion is written to the activity/audit log and
      // local enforcement decides. Assertions bind the founder identity
      // (email hash) and are only ever issued for it, so no other
      // account can gain anything from this path.
      const founderAssertion = verifyFounder.checkRequest(req, { platform: 'meta-free', email: user.email });
      if (founderAssertion.presented) {
        if (founderAssertion.ok) act('connect.assertion', 'AwakenConnect founder assertion accepted — founder scope granted centrally');
        else act('connect.assertion-fallback', `AwakenConnect founder assertion not honored (${founderAssertion.reason}) — local enforcement decides`);
      }
      const platformOwnerNow = platformRoleOf(user) === 'owner' || founderAssertion.ok;

      // ---------- plan entitlements + feature gate ----------
      // Resolved once per request from the same engine the Plans view
      // renders (lib/billing): grandfathered workspaces and the platform
      // owner's own workspace hold the full set; a running/canceled trial
      // grants its tier; everyone else holds exactly their plan's
      // features. denyFeature answers with the plain-language gate
      // (billing.featureGate) and returns true when it has answered.
      const ent = ws ? billing.effectiveEntitlements(store, ws, Date.now(), { platformOwner: platformOwnerNow }) : null;
      const denyFeature = (featureId) => {
        const g = billing.featureGate(ent, featureId);
        if (!g) return false;
        json(res, 403, g);
        return true;
      };

      if (p === '/api/me' && req.method === 'GET') return json(res, 200, { user: { email: user.email, name: user.name }, workspace: ws ? publicWs(ws) : null, role: member ? member.role : null, platformRole: platformRoleOf(user), platformOwner: platformOwnerNow, founderScopeVia: founderAssertion.ok ? 'central-assertion' : (platformRoleOf(user) === 'owner' ? 'local-claim' : null), claimStatus: config.isOwnerEmail(user.email) ? (user.claimStatus || null) : null, ...(consent.enforcementOn() ? { consent: consent.statusFor(store, user, { founderExempt: config.isOwnerEmail(user.email) || platformOwnerNow }) } : {}) });

      // ---------- Terms Acceptance System: accept / summary / gate ----------
      // Accept sits ABOVE the gate: it is how a flagged account clears
      // the flag. The summary is the platform-owner view AwakenConnect's
      // registry format consumes (counts + versions for THIS platform).
      if (p === '/api/consent/accept' && req.method === 'POST') {
        const b = await readBody(req);
        const tv = consent.validateTermsAcceptance(b);
        if (!tv.ok) return json(res, 400, { error: tv.error });
        consent.recordConsent(store, {
          accountId: user.id, kind: 'terms', source: 'reacceptance',
          ip: consent.clientIp(req), userAgent: consent.userAgentOf(req),
        });
        act('consent.reaccept', `terms re-accepted at version ${consent.currentVersions().termsVersion}`);
        return json(res, 200, { ok: true, consent: consent.statusFor(store, user, { founderExempt: config.isOwnerEmail(user.email) || platformOwnerNow }) });
      }
      if (p === '/api/consent/summary' && req.method === 'GET') {
        if (!platformOwnerNow) return json(res, 403, { error: 'Owner only.' });
        return json(res, 200, consent.summaryView(store));
      }
      // Reacceptance gate: while enforcement is on, an account whose
      // recorded Terms version is behind the registry is refused on
      // gated APIs (plain-language 403) until it re-accepts. The
      // founder — claim-email account or locally/centrally verified
      // platform owner — is EXEMPT from blocking (never-lockout rule);
      // she is prompted via the status payload only.
      if (consent.enforcementOn() && !config.isOwnerEmail(user.email) && !platformOwnerNow && consent.needsReacceptance(store, user.id)) {
        return json(res, 403, { error: consent.REACCEPTANCE_ERROR, code: 'REACCEPTANCE_REQUIRED' });
      }

      if (p === '/api/dashboard' && req.method === 'GET') {
        const posts = store.all('posts', x => x.workspaceId === wsId);
        const messages = store.all('messages', x => x.workspaceId === wsId);
        const metrics = store.all('metrics', x => x.workspaceId === wsId);
        return json(res, 200, {
          counts: { posts: posts.length, scheduled: posts.filter(x => x.status === 'scheduled').length, due: approvals.dueQueue(store, wsId).ready.length, inboxOpen: messages.filter(x => x.status === 'open').length, links: store.all('links', x => x.workspaceId === wsId).length },
          upcoming: posts.filter(x => x.status === 'scheduled').sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt))).slice(0, 5),
          bestTimes: assistant.bestTimes(metrics),
          rollup: analytics.rollup(metrics),
          notifications: store.all('notifications', x => x.workspaceId === wsId).slice(-5).reverse(),
          widgets: ws.widgets,
        });
      }

      // posts
      if (p === '/api/posts' && req.method === 'GET') return json(res, 200, { posts: store.all('posts', x => x.workspaceId === wsId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
      if (p === '/api/posts' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot create posts.' });
        if (denyFeature('planner')) return;
        const b = await readBody(req);
        const post = store.insert('posts', { workspaceId: wsId, platform: PLATFORMS.includes(b.platform) ? b.platform : 'facebook', caption: String(b.caption || '').slice(0, 2200), status: ['draft', 'scheduled', 'ready', 'published'].includes(b.status) ? b.status : 'draft', approval: approvals.APPROVAL_STATES.includes(b.approval) ? b.approval : 'draft', scheduledAt: b.scheduledAt || null });
        notify(wsId, `Post created for ${post.platform}`);
        act('post.created', `${post.platform} · ${post.status}`);
        return json(res, 201, { post });
      }
      if (p === '/api/command' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot create posts.' });
        if (denyFeature('planner')) return;
        const b = await readBody(req);
        const parsed = parseCommand(String(b.command || ''));
        if (parsed.error) return json(res, 400, { error: parsed.error });
        // A typed command is the author's own instruction — it enters approved.
        const post = store.insert('posts', { workspaceId: wsId, platform: parsed.platform, caption: parsed.caption, status: parsed.status, approval: 'approved', scheduledAt: parsed.scheduledAt });
        act('post.created', `${post.platform} · ${post.status} · via command bar`);
        return json(res, 201, { post, parsed });
      }
      if (p === '/api/due' && req.method === 'GET') {
        if (denyFeature('due-queue')) return;
        const q = approvals.dueQueue(store, wsId);
        for (const post of q.ready) {
          if (!post.dueNotified) {
            store.update('posts', post.id, { dueNotified: true });
            notify(wsId, `Due now: ${post.platform} post is ready to publish — copy it from the Planner.`);
            post.dueNotified = true;
          }
        }
        return json(res, 200, { ready: q.ready, awaitingApproval: q.awaitingApproval });
      }
      const postMatch = p.match(/^\/api\/posts\/(.+)$/);
      if (postMatch && req.method === 'PATCH') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot edit posts.' });
        const b = await readBody(req);
        const post = store.find('posts', x => x.id === postMatch[1] && x.workspaceId === wsId);
        if (!post) return json(res, 404, { error: 'Post not found.' });
        const patch = {};
        const prevStatus = post.status;
        const prevApproval = approvals.approvalOf(post);
        if (b.status) patch.status = b.status;
        if (b.caption !== undefined) patch.caption = String(b.caption).slice(0, 2200);
        if (b.scheduledAt !== undefined) patch.scheduledAt = b.scheduledAt;
        if (b.approval !== undefined) {
          if (denyFeature('approvals')) return;
          if (!approvals.roleCanApprove(member.role)) return json(res, 403, { error: 'Your role cannot change approval state.' });
          if (!approvals.canTransition(prevApproval, b.approval)) return json(res, 400, { error: `Approval cannot move from ${prevApproval} to ${b.approval}.` });
          patch.approval = b.approval;
        }
        const updated = store.update('posts', post.id, patch);
        if (patch.approval && patch.approval !== prevApproval) act('post.approval', `${post.platform} → ${patch.approval}`);
        else if (patch.status && patch.status !== prevStatus) act('post.status', `${post.platform} → ${patch.status}`);
        else act('post.updated', post.platform);
        return json(res, 200, { post: updated });
      }
      if (postMatch && req.method === 'DELETE') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot delete posts.' });
        const post = store.find('posts', x => x.id === postMatch[1] && x.workspaceId === wsId);
        if (!post) return json(res, 404, { error: 'Post not found.' });
        store.remove('posts', post.id); act('post.deleted', post.platform); return json(res, 200, { ok: true });
      }

      // links
      if (p === '/api/links' && req.method === 'GET') return json(res, 200, { links: store.all('links', x => x.workspaceId === wsId).sort((a, b) => (a.sort || 0) - (b.sort || 0)), slug: ws.slug });
      if (p === '/api/links' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot edit links.' });
        if (denyFeature('link-page')) return;
        const b = await readBody(req);
        if (!/^https?:\/\//i.test(String(b.url || ''))) return json(res, 400, { error: 'Link URL must start with http:// or https://' });
        const link = store.insert('links', { workspaceId: wsId, title: String(b.title || 'Link').slice(0, 120), url: String(b.url).slice(0, 2000), clicks: 0, sort: store.all('links', x => x.workspaceId === wsId).length });
        act('link.added', link.url);
        return json(res, 201, { link });
      }
      const linkMatch = p.match(/^\/api\/links\/(.+)$/);
      if (linkMatch && req.method === 'DELETE') {
        if (denyFeature('link-page')) return;
        const link = store.find('links', x => x.id === linkMatch[1] && x.workspaceId === wsId);
        if (!link) return json(res, 404, { error: 'Link not found.' });
        store.remove('links', link.id); act('link.removed', link.url); return json(res, 200, { ok: true });
      }

      // inbox
      if (p === '/api/messages' && req.method === 'GET') return json(res, 200, { messages: store.all('messages', x => x.workspaceId === wsId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
      if (p === '/api/messages' && req.method === 'POST') {
        if (denyFeature('inbox')) return;
        const b = await readBody(req);
        const body = String(b.body || '').slice(0, 2000);
        const rule = assistant.matchAutoReply(body, store.all('rules', x => x.workspaceId === wsId));
        const sugg = assistant.suggestReply(body, { linkPage: '/p/' + ws.slug, hours: ws.hours });
        const msg = store.insert('messages', { workspaceId: wsId, platform: PLATFORMS.includes(b.platform) ? b.platform : 'instagram', from: String(b.from || 'Customer').slice(0, 80), body, status: 'open', suggestedReply: rule ? rule.reply : sugg.reply, autoRule: rule ? rule.id : null });
        return json(res, 201, { message: msg });
      }
      const msgMatch = p.match(/^\/api\/messages\/(.+)$/);
      if (msgMatch && req.method === 'PATCH') {
        if (denyFeature('inbox')) return;
        const b = await readBody(req);
        const msg = store.find('messages', x => x.id === msgMatch[1] && x.workspaceId === wsId);
        if (!msg) return json(res, 404, { error: 'Message not found.' });
        return json(res, 200, { message: store.update('messages', msg.id, { status: b.status === 'resolved' ? 'resolved' : 'open' }) });
      }

      // automation rules
      if (p === '/api/rules' && req.method === 'GET') return json(res, 200, { rules: store.all('rules', x => x.workspaceId === wsId) });
      if (p === '/api/rules' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot edit rules.' });
        if (denyFeature('auto-reply-rules')) return;
        const b = await readBody(req);
        const rule = store.insert('rules', { workspaceId: wsId, keyword: String(b.keyword || '').slice(0, 60), reply: String(b.reply || '').slice(0, 1000), enabled: true });
        act('rule.added', rule.keyword);
        return json(res, 201, { rule });
      }
      const ruleMatch = p.match(/^\/api\/rules\/(.+)$/);
      if (ruleMatch && req.method === 'DELETE') { if (denyFeature('auto-reply-rules')) return; const rule = store.find('rules', x => x.id === ruleMatch[1] && x.workspaceId === wsId); store.removeWhere('rules', x => x.id === ruleMatch[1] && x.workspaceId === wsId); if (rule) act('rule.removed', rule.keyword); return json(res, 200, { ok: true }); }

      // metrics / analytics
      if (p === '/api/metrics' && req.method === 'GET') {
        const metrics = store.all('metrics', x => x.workspaceId === wsId);
        return json(res, 200, { count: metrics.length, rollup: analytics.rollup(metrics), rollupBySource: analytics.rollupBySource(metrics), bestTimes: assistant.bestTimes(metrics), metrics });
      }
      if (p === '/api/metrics/import' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot import.' });
        if (denyFeature('analytics')) return;
        const b = await readBody(req);
        const rows = analytics.parseCsv(String(b.csv || ''));
        let added = 0;
        for (const r of rows) {
          store.insert('metrics', { workspaceId: wsId, platform: PLATFORMS.includes(r.platform) ? r.platform : 'facebook', timestamp: r.timestamp || r.date || new Date().toISOString(), likes: +r.likes || 0, comments: +r.comments || 0, shares: +r.shares || 0, clicks: +r.clicks || 0, reach: +r.reach || 0 });
          added++;
        }
        notify(wsId, `Imported ${added} metric rows`);
        act('metrics.imported', `${added} rows`);
        return json(res, 201, { added });
      }
      // Awaken Meta PKG-2: brand workspaces + enterprise roll-up.
      // PLATFORM-owner-only (PKG-11 finding F-01, fixed in the F-01
      // follow-up) — both views read across every brand workspace, so
      // the gate is the platform-owner determination (platformOwnerNow:
      // the verified founder claim, or a valid AwakenConnect founder
      // assertion), NOT workspace membership. Registration is open and
      // instantly makes anyone the owner of a workspace they create;
      // that must not grant a read of the house brands' cross-workspace
      // aggregates. Same gate as /api/consent/summary and the
      // /api/plans cross-workspace list. Workspace scoping for
      // everything else is unchanged (the caller's own member row
      // decides, exactly as above).
      if (p === '/api/enterprise/workspaces' && req.method === 'GET') {
        if (!platformOwnerNow) return json(res, 403, { error: 'Only the platform owner can view the brand workspaces.' });
        return json(res, 200, { brands: brands.listBrandWorkspaces(store) });
      }
      if (p === '/api/enterprise/rollup' && req.method === 'GET') {
        if (!platformOwnerNow) return json(res, 403, { error: 'Only the platform owner can view the enterprise roll-up.' });
        return json(res, 200, brands.enterpriseRollup(store));
      }

      // Awaken Meta PKG-6: Campaign Command Center — draft campaigns
      // in the caller's brand workspace. Drafts and approvals only:
      // these routes create records, run them through the evidence-
      // gated approval pipeline, and record lifecycle states. Nothing
      // here publishes, activates anything in a platform, or spends —
      // the module (lib/campaigns.js) enforces the $0 cap rule, the
      // evidence gate, the content rules, and the exclusions, and
      // writes every change to the activity/audit log.
      const campaignActor = { email: user.email, role: member.role };
      if (p === '/api/campaigns/templates' && req.method === 'GET') {
        return json(res, 200, { templates: campaignsLib.TEMPLATES });
      }
      if (p === '/api/campaigns' && req.method === 'GET') {
        return json(res, 200, { campaigns: campaignsLib.listCampaigns(store, wsId, { status: url.searchParams.get('status') || undefined, template: url.searchParams.get('template') || undefined }) });
      }
      if (p === '/api/campaigns/calendar' && req.method === 'GET') {
        return json(res, 200, { campaigns: campaignsLib.calendarCampaigns(store, wsId, url.searchParams.get('from'), url.searchParams.get('to')) });
      }
      if (p === '/api/campaigns' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot create campaigns.' });
        const b = await readBody(req);
        const r = b.templateId
          ? campaignsLib.instantiateTemplate(store, ws, String(b.templateId), b, campaignActor)
          : campaignsLib.createCampaign(store, ws, b, campaignActor);
        if (!r.ok) return json(res, r.status || 400, { error: r.errors.join(' '), errors: r.errors });
        return json(res, 201, { campaign: r.campaign });
      }
      // Awaken Meta PKG-8: campaign measurement + flagging. A POST
      // measures one campaign from labeled inputs only and persists
      // the measurement + flags on its row. Read-only toward the
      // world: it computes, flags, and records — never acts.
      const measureMatch = p.match(/^\/api\/campaigns\/(.+)\/measure$/);
      if (measureMatch && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot measure campaigns.' });
        const b = await readBody(req);
        const r = measurementLib.measureCampaign(store, ws, measureMatch[1], campaignActor, {
          asOf: b.asOf || undefined, windowStart: b.windowStart || undefined, windowEnd: b.windowEnd || undefined,
        });
        if (!r.ok) return json(res, r.status || 400, { error: r.errors.join(' '), errors: r.errors });
        return json(res, 200, { campaign: r.campaign, measurement: r.measurement, flags: r.flags });
      }
      const campaignMatch = p.match(/^\/api\/campaigns\/(.+)$/);
      if (campaignMatch && req.method === 'GET') {
        const c = campaignsLib.findCampaign(store, ws, campaignMatch[1]);
        if (!c) return json(res, 404, { error: 'Campaign not found.' });
        return json(res, 200, { campaign: c });
      }
      if (campaignMatch && req.method === 'PATCH') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot change campaigns.' });
        const b = await readBody(req);
        const id = campaignMatch[1];
        if (!campaignsLib.findCampaign(store, ws, id)) return json(res, 404, { error: 'Campaign not found.' });
        // One PATCH may carry an evidence update, field edits, an
        // approval move, and a lifecycle move; they apply in pipeline
        // order and the first refusal answers the whole request.
        let current = null;
        if (b.evidenceCheck !== undefined) {
          const r = campaignsLib.setEvidence(store, ws, id, b.evidenceCheck, campaignActor);
          if (!r.ok) return json(res, r.status || 400, { error: r.errors.join(' '), errors: r.errors });
          current = r.campaign;
        }
        const fieldKeys = ['name', 'objective', 'audience', 'voice', 'budgetCapCents', 'ownerSetCap', 'channels', 'landingUrl', 'utmCampaign', 'refCode', 'startsOn', 'endsOn', 'segmentIds', 'personaIds', 'measurementPlan', 'copy', 'notes'];
        const fieldPatch = {};
        for (const k of fieldKeys) if (b[k] !== undefined) fieldPatch[k] = b[k];
        if (Object.keys(fieldPatch).length) {
          const r = campaignsLib.updateCampaign(store, ws, id, fieldPatch, campaignActor);
          if (!r.ok) return json(res, r.status || 400, { error: r.errors.join(' '), errors: r.errors });
          current = r.campaign;
        }
        if (b.approval !== undefined) {
          const r = campaignsLib.transitionApproval(store, ws, id, String(b.approval), campaignActor);
          if (!r.ok) return json(res, r.status || 400, { error: r.errors.join(' '), errors: r.errors });
          current = r.campaign;
        }
        if (b.status !== undefined) {
          const r = campaignsLib.transitionStatus(store, ws, id, String(b.status), campaignActor);
          if (!r.ok) return json(res, r.status || 400, { error: r.errors.join(' '), errors: r.errors });
          current = r.campaign;
        }
        return json(res, 200, { campaign: current || campaignsLib.findCampaign(store, ws, id) });
      }

      // Awaken Meta PKG-7: segments, personas, A/B test records —
      // the audience half of the Campaign Command Center. Records
      // and gates only: segment sizes are computed from labeled
      // data or rendered UNAVAILABLE, personas are planning drafts,
      // and an A/B test can only be concluded by a person, with a
      // winner, when the module's labeled-data/sample/window guard
      // passes. Nothing here publishes, sends, spends, or activates.
      const audienceActor = { email: user.email, role: member.role };
      const audienceErr = (res, r) => json(res, r.status || 400, { error: r.errors.join(' '), errors: r.errors });
      if (p === '/api/segments' && req.method === 'GET') {
        return json(res, 200, { segments: audiencesLib.listSegments(store, wsId) });
      }
      if (p === '/api/segments' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot create segments.' });
        const b = await readBody(req);
        const r = audiencesLib.createSegment(store, ws, b, audienceActor);
        if (!r.ok) return audienceErr(res, r);
        return json(res, 201, { segment: r.segment });
      }
      const segmentRefresh = p.match(/^\/api\/segments\/(.+)\/refresh$/);
      if (segmentRefresh && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot change segments.' });
        const r = audiencesLib.refreshSegmentSize(store, ws, segmentRefresh[1], audienceActor);
        if (!r.ok) return audienceErr(res, r);
        return json(res, 200, { segment: r.segment });
      }
      const segmentMatch = p.match(/^\/api\/segments\/(.+)$/);
      if (segmentMatch && req.method === 'GET') {
        const s = audiencesLib.getSegment(store, ws, segmentMatch[1]);
        if (!s) return json(res, 404, { error: 'Segment not found.' });
        return json(res, 200, { segment: s });
      }
      if (segmentMatch && req.method === 'PATCH') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot change segments.' });
        const b = await readBody(req);
        const r = audiencesLib.updateSegment(store, ws, segmentMatch[1], b, audienceActor);
        if (!r.ok) return audienceErr(res, r);
        return json(res, 200, { segment: r.segment });
      }
      if (p === '/api/personas' && req.method === 'GET') {
        return json(res, 200, { personas: audiencesLib.listPersonas(store, wsId) });
      }
      if (p === '/api/personas' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot create personas.' });
        const b = await readBody(req);
        const r = audiencesLib.createPersona(store, ws, b, audienceActor);
        if (!r.ok) return audienceErr(res, r);
        return json(res, 201, { persona: r.persona });
      }
      const personaMatch = p.match(/^\/api\/personas\/(.+)$/);
      if (personaMatch && req.method === 'GET') {
        const persona = audiencesLib.findPersona(store, ws, personaMatch[1]);
        if (!persona) return json(res, 404, { error: 'Persona not found.' });
        return json(res, 200, { persona });
      }
      if (personaMatch && req.method === 'PATCH') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot change personas.' });
        const b = await readBody(req);
        const r = audiencesLib.updatePersona(store, ws, personaMatch[1], b, audienceActor);
        if (!r.ok) return audienceErr(res, r);
        return json(res, 200, { persona: r.persona });
      }
      if (p === '/api/ab-tests/metrics' && req.method === 'GET') {
        return json(res, 200, { metrics: audiencesLib.METRICS, resultLabels: audiencesLib.RESULT_LABELS, minWinnerSample: audiencesLib.MIN_WINNER_SAMPLE });
      }
      if (p === '/api/ab-tests' && req.method === 'GET') {
        return json(res, 200, { abTests: audiencesLib.listAbTests(store, wsId, { status: url.searchParams.get('status') || undefined, campaignId: url.searchParams.get('campaignId') || undefined }) });
      }
      if (p === '/api/ab-tests' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot create A/B tests.' });
        const b = await readBody(req);
        const r = audiencesLib.createAbTest(store, ws, b, audienceActor);
        if (!r.ok) return audienceErr(res, r);
        return json(res, 201, { abTest: r.abTest });
      }
      // Awaken Meta PKG-8: feed an A/B test's results from the
      // measurement engine's labeled per-post outputs (the operator
      // assigns posts to variants; the engine records MEASURED rows
      // through the PKG-7 record path).
      const abFeedMatch = p.match(/^\/api\/ab-tests\/(.+)\/feed-results$/);
      if (abFeedMatch && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot feed A/B results.' });
        const b = await readBody(req);
        const r = measurementLib.feedAbTestResults(store, ws, abFeedMatch[1], b, audienceActor);
        if (!r.ok) return audienceErr(res, r);
        return json(res, 201, { abTest: r.abTest, fed: r.fed });
      }
      const abMatch = p.match(/^\/api\/ab-tests\/(.+)$/);
      if (abMatch && req.method === 'GET') {
        const t = audiencesLib.findAbTest(store, ws, abMatch[1]);
        if (!t) return json(res, 404, { error: 'A/B test not found.' });
        return json(res, 200, { abTest: t });
      }
      if (abMatch && req.method === 'PATCH') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot change A/B tests.' });
        const b = await readBody(req);
        const id = abMatch[1];
        if (!audiencesLib.findAbTest(store, ws, id)) return json(res, 404, { error: 'A/B test not found.' });
        // One PATCH may record a result entry, start the test,
        // conclude it, archive it, or edit its definition; they
        // apply in that order and the first refusal answers.
        let current = null;
        if (b.resultEntry !== undefined) {
          const r = audiencesLib.recordResult(store, ws, id, b.resultEntry, audienceActor);
          if (!r.ok) return audienceErr(res, r);
          current = r.abTest;
        }
        if (b.action === 'start') {
          const r = audiencesLib.startAbTest(store, ws, id, audienceActor);
          if (!r.ok) return audienceErr(res, r);
          current = r.abTest;
        } else if (b.action === 'conclude') {
          const r = audiencesLib.concludeAbTest(store, ws, id, b.conclude || {}, audienceActor);
          if (!r.ok) return audienceErr(res, r);
          current = r.abTest;
        } else if (b.action === 'archive') {
          const r = audiencesLib.archiveAbTest(store, ws, id, audienceActor);
          if (!r.ok) return audienceErr(res, r);
          current = r.abTest;
        }
        const defPatch = {};
        for (const k of ['campaignId', 'name', 'hypothesis', 'variants', 'metric', 'windowStart', 'windowEnd']) {
          if (b[k] !== undefined) defPatch[k] = b[k];
        }
        if (Object.keys(defPatch).length) {
          const r = audiencesLib.updateAbTest(store, ws, id, defPatch, audienceActor);
          if (!r.ok) return audienceErr(res, r);
          current = r.abTest;
        }
        return json(res, 200, { abTest: current || audiencesLib.findAbTest(store, ws, id) });
      }

      if (p === '/api/metrics/export.csv' && req.method === 'GET') {
        if (denyFeature('analytics')) return;
        const rows = store.all('metrics', x => x.workspaceId === wsId);
        const csv = analytics.toCsv(rows, ['platform', 'timestamp', 'likes', 'comments', 'shares', 'clicks', 'reach']);
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="meta-free-metrics.csv"' }); return res.end(csv);
      }
      if (p === '/api/posts/export.csv' && req.method === 'GET') {
        const rows = store.all('posts', x => x.workspaceId === wsId);
        const csv = analytics.toCsv(rows, ['platform', 'status', 'approval', 'scheduledAt', 'caption', 'createdAt']);
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="meta-free-posts.csv"' }); return res.end(csv);
      }

      // competitors + watchlist
      if (p === '/api/competitors' && req.method === 'GET') return json(res, 200, { competitors: store.all('competitors', x => x.workspaceId === wsId) });
      if (p === '/api/competitors' && req.method === 'POST') {
        if (denyFeature('competitors')) return;
        const b = await readBody(req);
        return json(res, 201, { competitor: store.insert('competitors', { workspaceId: wsId, handle: String(b.handle || '').slice(0, 80), platform: String(b.platform || 'instagram'), notes: String(b.notes || '').slice(0, 500) }) });
      }
      if (p === '/api/watchlist' && req.method === 'GET') return json(res, 200, { entries: store.all('watchlist', x => x.workspaceId === wsId) });
      if (p === '/api/watchlist' && req.method === 'POST') {
        if (denyFeature('watchlist')) return;
        const b = await readBody(req);
        return json(res, 201, { entry: store.insert('watchlist', { workspaceId: wsId, handle: String(b.handle || '').slice(0, 80), platform: String(b.platform || 'instagram'), status: 'reported' in b ? 'reported' : 'watching', notes: String(b.notes || '').slice(0, 500) }) });
      }

      // assistant
      if (p === '/api/assistant/caption' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, { caption: assistant.draftCaption(String(b.topic || ''), b.platform || 'instagram', ws.name), hashtags: assistant.suggestHashtags(String(b.topic || ''), ws.name) });
      }
      if (p === '/api/assistant/ask' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, { answer: assistant.diagnose(String(b.question || '')) });
      }

      // team
      if (p === '/api/members' && req.method === 'GET') return json(res, 200, { members: store.all('members', x => x.workspaceId === wsId).map(m => ({ email: m.email, role: m.role, inviteCode: m.inviteCode || null })) });
      if (p === '/api/members/invite' && req.method === 'POST') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can invite.' });
        if (denyFeature('team')) return;
        const b = await readBody(req);
        if (!auth.validEmail(b.email)) return json(res, 400, { error: 'Enter a valid email.' });
        const role = ['editor', 'viewer'].includes(b.role) ? b.role : 'viewer';
        const code = crypto.randomBytes(6).toString('hex');
        store.insert('members', { workspaceId: wsId, userId: null, email: b.email.toLowerCase(), role, inviteCode: code });
        act('team.invited', `${b.email.toLowerCase()} as ${role}`);
        return json(res, 201, { inviteCode: code, note: 'Share this code with your teammate. When they register with the same email, enter the code in Settings to join this workspace (join endpoint below).' });
      }
      if (p === '/api/members/join' && req.method === 'POST') {
        const b = await readBody(req);
        const inv = store.find('members', m => m.inviteCode === String(b.code || '') && m.email === user.email && !m.userId);
        if (!inv) return json(res, 404, { error: 'No invite found for your email with that code.' });
        // move membership: remove old membership rows for this user, attach invite
        store.removeWhere('members', m => m.userId === user.id);
        store.update('members', inv.id, { userId: user.id, inviteCode: null });
        logActivity(store, inv.workspaceId, user.email, 'team.joined', ws ? ws.name : '');
        return json(res, 200, { ok: true });
      }

      // connections + profile completion agent
      if (p === '/api/connections' && req.method === 'GET') {
        if (denyFeature('connections')) return;
        const connections = seedConnections(store, wsId);
        return json(res, 200, { connections, canonical: CANONICAL });
      }
      const connMatch = p.match(/^\/api\/connections\/(.+)$/);
      if (connMatch && req.method === 'PATCH') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot edit connections.' });
        if (denyFeature('connections')) return;
        const b = await readBody(req);
        const conn = store.find('connections', x => x.platform === connMatch[1] && x.workspaceId === wsId);
        if (!conn) return json(res, 404, { error: 'Connection not found.' });
        const patch = {};
        if (b.status) patch.status = String(b.status).slice(0, 40);
        if (b.handle !== undefined) patch.handle = String(b.handle).slice(0, 120);
        if (b.note !== undefined) patch.note = String(b.note).slice(0, 500);
        return json(res, 200, { connection: store.update('connections', conn.id, patch) });
      }
      if (p === '/api/agent/run' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot run the agent.' });
        if (denyFeature('connections')) return;
        const run = runCompletion(store, ws);
        act('agent.run', run.summary);
        return json(res, 201, { run });
      }
      if (p === '/api/agent/runs' && req.method === 'GET') {
        return json(res, 200, { runs: store.all('agentRuns', x => x.workspaceId === wsId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10) });
      }

      // workspace settings, plugins, widgets, export/import/wipe
      if (p === '/api/workspace' && req.method === 'PATCH') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can change workspace settings.' });
        const b = await readBody(req);
        if (b.plugins && denyFeature('plugins')) return;
        const patch = {};
        if (b.name) patch.name = String(b.name).slice(0, 80);
        if (b.tagline !== undefined) patch.tagline = String(b.tagline).slice(0, 160);
        if (b.hours !== undefined) patch.hours = String(b.hours).slice(0, 80);
        if (b.widgets) patch.widgets = { ...ws.widgets, ...b.widgets };
        if (b.plugins) { patch.plugins = { ...ws.plugins }; for (const pl of BUILTIN) if (pl.id in b.plugins && !pl.roadmap) patch.plugins[pl.id] = !!b.plugins[pl.id]; }
        const updatedWs = store.update('workspaces', ws.id, patch);
        act('workspace.settings', Object.keys(patch).join(', '));
        return json(res, 200, { workspace: publicWs(updatedWs) });
      }
      if (p === '/api/plugins' && req.method === 'GET') return json(res, 200, { plugins: listPlugins(ws) });
      if (p === '/api/export' && req.method === 'GET') {
        if (denyFeature('data-portability')) return;
        const data = store.exportWorkspace(wsId);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="meta-free-export.json"' });
        return res.end(JSON.stringify(data, null, 2));
      }
      if (p === '/api/import' && req.method === 'POST') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can import.' });
        if (denyFeature('data-portability')) return;
        const b = await readBody(req);
        const backup = await backupsLib.createBackup(store); // safety snapshot first
        let added = 0;
        for (const coll of ['posts', 'links', 'rules', 'competitors']) {
          for (const row of (b.data && b.data[coll]) || []) {
            const { id, ...rest } = row; store.insert(coll, { ...rest, workspaceId: wsId }); added++;
          }
        }
        act('data.imported', `${added} records · pre-import backup ${backup.name}`);
        return json(res, 201, { added, backup: backup.name });
      }
      if (p === '/api/wipe' && req.method === 'POST') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can wipe the workspace.' });
        if (denyFeature('data-portability')) return;
        const backup = await backupsLib.createBackup(store); // safety snapshot first
        for (const coll of ['posts', 'links', 'messages', 'metrics', 'rules', 'competitors', 'notifications', 'watchlist', 'connections', 'agentRuns', 'activity', 'planInterest', 'trials', 'providerSubs', 'providerInvoices', 'feedRuns', 'ordersDaily', 'campaigns', 'segments', 'personas', 'abTests']) store.removeWhere(coll, x => x.workspaceId === wsId);
        act('data.wiped', `pre-wipe backup ${backup.name}`);
        notify(wsId, `Workspace data wiped. A backup snapshot (${backup.name}) was saved first — restore it from Enterprise settings if this was a mistake.`);
        return json(res, 200, { ok: true, backup: backup.name });
      }

      // activity / audit log
      if (p === '/api/activity' && req.method === 'GET') return json(res, 200, { activity: listActivity(store, wsId) });
      if (p === '/api/activity/export.csv' && req.method === 'GET') {
        if (denyFeature('audit-log')) return;
        const rows = listActivity(store, wsId);
        const csv = analytics.toCsv(rows, ['createdAt', 'actor', 'action', 'detail']);
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="meta-free-activity.csv"' }); return res.end(csv);
      }

      // founding plans / rate card (docs/09): records only — no checkout, no payment.
      // "Subscribing" stores a waitlist (interest) record in the workspace.
      if (p === '/api/plans' && req.method === 'GET') {
        // Internal sweep (no cron): process any due trial conversions
        // through the selected provider before rendering plan state.
        // Simulation-only today; a provider misconfiguration must never
        // break the plans read, so failures leave outcomes unlabeled.
        try { await providers.runConversionTick(store, Date.now()); } catch { /* labeled in billingProvider status */ }
        const interest = store.all('planInterest', x => x.workspaceId === wsId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const isPlatformOwner = platformOwnerNow;
        // Platform owner (claim rule only) sees EVERY waitlist record across
        // all workspaces; a workspace owner sees only their own workspace's
        // list; everyone else sees neither. Records only — still no checkout.
        const allInterest = isPlatformOwner
          ? store.all('planInterest').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
            .map(x => { const w = store.find('workspaces', w2 => w2.id === x.workspaceId); return { email: x.email, planId: x.planId, planName: x.planName, price: x.price, reference: x.reference || null, followUp: x.followUp ? x.followUp.status : null, createdAt: x.createdAt, workspaceId: x.workspaceId, workspaceName: w ? w.name : '' }; })
          : undefined;
        const entitlements = billing.effectiveEntitlements(store, ws, Date.now(), { platformOwner: platformOwnerNow });
        return json(res, 200, {
          plans: plansLib.plans(),
          free: plansLib.freePlan(),
          billingProvider: providers.statusInfo(),
          trialNotice: plansLib.TRIAL_NOTICE,
          myPlan: { planId: entitlements.planId, planName: entitlements.planName, via: entitlements.via, grandfathered: entitlements.grandfathered, priceCents: entitlements.priceCents !== undefined ? entitlements.priceCents : null, features: entitlements.features },
          myTrial: entitlements.trial || billing.trialView(billing.latestTrial(store, wsId)),
          source: plansLib.SOURCE,
          foundingLabel: plansLib.FOUNDING_LABEL,
          interestLabel: plansLib.INTEREST_LABEL,
          currentStateNote: plansLib.CURRENT_STATE_NOTE,
          paymentNote: plansLib.PAYMENT_NOTE,
          myInterest: interest.filter(x => x.userId === user.id).map(x => x.planId),
          myReferences: Object.fromEntries(interest.filter(x => x.userId === user.id).map(x => [x.planId, x.reference || null])),
          // the interest list is visible to the workspace owner (Amber's list)
          interest: member.role === 'owner' ? interest.map(x => ({ email: x.email, planId: x.planId, planName: x.planName, price: x.price, reference: x.reference || null, followUp: x.followUp ? x.followUp.status : null, createdAt: x.createdAt })) : undefined,
          platformOwner: isPlatformOwner,
          allInterest,
          // Beta tester trial (lib/beta): a gated path, closed unless
          // the platform owner opens it. `mine` is this workspace's
          // beta trial (null when its trial — if any — came from the
          // public path). Consent sentences are generated server-side
          // from the rate card so the wording can never drift.
          beta: {
            enabled: beta.betaEnabled(store),
            label: plansLib.BETA_TRIAL_LABEL,
            notice: plansLib.BETA_TRIAL_NOTICE,
            mine: beta.betaTrialView(beta.betaTrialOf(store, wsId)),
            consentTextByPlan: Object.fromEntries(plansLib.plans().map(pl2 => [pl2.id, beta.betaConsentText({ planName: pl2.name, priceText: pl2.price })])),
          },
        });
      }
      if (p === '/api/plans/interest' && req.method === 'POST') {
        const b = await readBody(req);
        const plan = plansLib.planById(String(b.planId || ''));
        if (!plan) return json(res, 400, { error: 'Unknown plan.' });
        const existing = store.find('planInterest', x => x.workspaceId === wsId && x.userId === user.id && x.planId === plan.id);
        if (existing) return json(res, 200, { ok: true, already: true, interest: existing });
        const reference = plansLib.newReference(store.all('planInterest').map(x => x.reference));
        // Waitlist follow-up flow (launch plan, staged): joining prepares a
        // follow-up email DRAFT on the record and notifies the workspace
        // owner in the dashboard. The draft is NEVER sent from here — no
        // email provider sends waitlist mail, and sending anything is an
        // owner-approved step. Status stays 'draft-not-sent' until a human
        // changes the flow.
        const followUp = {
          status: 'draft-not-sent',
          channel: 'email',
          subject: `Your ${plan.name} founding waitlist place — Awaken Affordable Meta`,
          body: `Thank you for joining the ${plan.name} founding waitlist for Awaken Affordable Meta (${plan.price}/month at founding pricing). Your reference: ${reference} — ${plansLib.REFERENCE_MESSAGE} ${plansLib.PAYMENT_NOTE}`,
        };
        const rec = store.insert('planInterest', { workspaceId: wsId, userId: user.id, email: user.email, planId: plan.id, planName: plan.name, priceCents: plan.priceCents, price: plan.price, kind: 'waitlist', reference, followUp });
        notify(wsId, `New founding waitlist signup: ${user.email} — ${plan.name} (${plan.price}/month) · ref ${reference}. A follow-up email draft is saved on the record — not sent.`);
        act('plan.interest', `${plan.name} · ${plan.price}/month · waitlist · ref ${reference}`);
        return json(res, 201, { ok: true, interest: rec, referenceMessage: `Your reference: ${reference} — ${plansLib.REFERENCE_MESSAGE}` });
      }

      // ---------- founder ownership claim (hardened 2026-11-07) ----------
      // Registration alone never grants the platform-owner role anymore.
      // The holder enters the one-time code that was written to the operator
      // store (claimCodes) at registration; hashes are compared, attempts
      // are rate-limited, and the code is single-use (lib/claims).
      if (p === '/api/claim/verify' && req.method === 'POST') {
        if (!config.isOwnerEmail(user.email)) return json(res, 403, { error: 'This account has no ownership claim to verify.' });
        if (platformRoleOf(user) === 'owner') return json(res, 200, { ok: true, already: true, platformRole: 'owner', claimStatus: 'verified' });
        const b = await readBody(req);
        const r = claims.verifyClaimCode(store, user, String(b.code || ''));
        if (!r.ok) {
          const msg = r.reason === 'locked'
            ? 'Too many wrong tries — this claim code is now locked. Sign out and sign back in to have a new code issued, then try again.'
            : r.reason === 'no-code'
              ? 'No active claim code exists for this account. Sign out and sign back in to have one issued.'
              : 'That code did not match. Check it carefully and try again.';
          return json(res, 400, { error: msg });
        }
        store.update('users', user.id, { platformRole: 'owner', claimStatus: 'verified' });
        act('claim.verified', 'platform owner claim verified with the one-time code');
        return json(res, 200, { ok: true, platformRole: 'owner', claimStatus: 'verified' });
      }

      // ---------- pre-launch trials (RECORDS ONLY — no charge exists) ----
      // Explicit opt-in to a named paid tier with the terms frozen on the
      // record: exact founding price, start, end (start + exactly 30×24h),
      // and the first-charge date the 2:00 AM America/Denver rule produces
      // (lib/billing). One trial per workspace ever; a mid-trial tier
      // switch edits the SAME trial (end unchanged). Cancel keeps access
      // to endsAt and is never charged. Billing is NOT live (TRIAL_NOTICE).
      if (p === '/api/plans/trial' && req.method === 'POST') {
        const b = await readBody(req);
        const plan = plansLib.planById(String(b.planId || ''));
        if (!plan) return json(res, 400, { error: 'Unknown plan.' });
        const existing = billing.latestTrial(store, wsId);
        if (existing) {
          if (existing.status === 'running') {
            if (existing.tierId !== plan.id) {
              const upd = store.update('trials', existing.id, { tierId: plan.id, tierName: plan.name, disclosedPriceCents: plan.priceCents, disclosedPrice: plan.price, switchedAt: new Date().toISOString() });
              await providers.syncTrialSwitch(store, upd); // mirror follows tier/amount; anchors never move
              act('plan.trial.switch', `${plan.name} · ${plan.price}/month · trial end unchanged (${existing.endsAt})`);
              return json(res, 200, { ok: true, switched: true, trial: billing.trialView(upd), notice: plansLib.TRIAL_NOTICE });
            }
            return json(res, 200, { ok: true, already: true, trial: billing.trialView(existing), notice: plansLib.TRIAL_NOTICE });
          }
          return json(res, 409, { error: 'This workspace has already used its free trial. The founding waitlist is still open.' });
        }
        // Terms Acceptance System: a NEW trial requires the separate
        // billing authorization while enforcement is on — validated
        // before the record exists; the Terms acceptance from
        // registration never substitutes. (A mid-trial tier SWITCH
        // above keeps the original trial's authorization — it edits
        // the same record and never moves its anchors.)
        const consentOn = consent.enforcementOn();
        if (consentOn) {
          const bv = consent.validateBillingAcceptance(b);
          if (!bv.ok) return json(res, 400, { error: bv.error });
        }
        const now = Date.now();
        const w = billing.trialWindow(now);
        let rec = store.insert('trials', {
          workspaceId: wsId, userId: user.id, email: user.email,
          tierId: plan.id, tierName: plan.name, interval: 'monthly',
          disclosedPriceCents: plan.priceCents, disclosedPrice: plan.price,
          startedAt: w.startedAt, endsAt: w.endsAt, billingDate: w.billingDate, firstChargeAt: w.firstChargeAt,
          termsVersion: billing.TERMS_VERSION, consentedAt: new Date(now).toISOString(),
          status: 'running', preLaunch: true,
        });
        // Bind the record to the selected billing provider (simulation
        // mirror today; the founder/owner is exempt and never registers).
        rec = await providers.registerTrial(store, rec, user);
        if (consentOn) {
          consent.recordConsent(store, {
            accountId: user.id, kind: 'billing', source: 'trial-start',
            ip: consent.clientIp(req), userAgent: consent.userAgentOf(req),
            context: { planId: plan.id, planName: plan.name, priceCents: plan.priceCents, firstChargeAt: w.firstChargeAt },
          });
        }
        act('plan.trial', `${plan.name} · ${plan.price}/month · pre-launch trial · ends ${w.endsAt} · first charge would be ${w.firstChargeAt}`);
        return json(res, 201, { ok: true, trial: billing.trialView(rec), notice: plansLib.TRIAL_NOTICE });
      }
      if (p === '/api/plans/trial/cancel' && req.method === 'POST') {
        const existing = billing.latestTrial(store, wsId);
        if (!existing || existing.status !== 'running') return json(res, 404, { error: 'No running trial to cancel.' });
        await providers.cancelTrialProvider(store, existing); // mirror cancels too — a canceled trial can never convert
        const upd = store.update('trials', existing.id, { status: 'canceled', canceledAt: new Date().toISOString() });
        act('plan.trial.cancel', `${existing.tierName} · access retained to ${existing.endsAt} · no charge`);
        return json(res, 200, { ok: true, trial: billing.trialView(upd), notice: 'Trial canceled. Your access continues until the trial end date shown, and you will not be charged.' });
      }

      // ---------- beta tester trial (lib/beta — GATED, never charges) --
      // The owner opens/closes beta signups with the settings route
      // below (platform owner only). Starting a beta trial follows the
      // public trial's rules — named paid tier, Terms Acceptance when
      // enforcement is on, one free trial per workspace EVER across
      // both paths — with the beta differences enforced in lib/beta:
      // no provider registration and no charge anchor, so nothing can
      // ever be charged, and the workspace returns to Free at the end.
      if (p === '/api/plans/beta/settings' && req.method === 'POST') {
        if (!platformOwnerNow) return json(res, 403, { error: 'Only the platform owner can open or close beta tester signups.' });
        const b = await readBody(req);
        const row = beta.setBetaEnabled(store, b.enabled === true, user.email);
        act('plan.beta.settings', `beta tester signups ${row.enabled ? 'OPENED' : 'CLOSED'}`);
        return json(res, 200, { ok: true, beta: { enabled: row.enabled } });
      }
      if (p === '/api/plans/beta-trial' && req.method === 'POST') {
        if (!beta.betaEnabled(store)) return json(res, 403, { error: 'The beta tester trial is not open right now. Beta signups open and close by the platform owner — the founding waitlist is open to everyone in the meantime.' });
        if (platformOwnerNow) return json(res, 400, { error: 'The platform owner workspace already runs the full Max plan at $0 — no trial is needed.' });
        const b = await readBody(req);
        const plan = plansLib.planById(String(b.planId || ''));
        if (!plan) return json(res, 400, { error: 'Unknown plan.' });
        const existing = billing.latestTrial(store, wsId);
        if (existing) {
          if (existing.status === 'running' && existing.beta) {
            if (existing.tierId !== plan.id) {
              // Mid-trial tier switch edits the SAME beta trial; the
              // end never moves and there is no provider mirror to sync.
              const upd = store.update('trials', existing.id, { tierId: plan.id, tierName: plan.name, disclosedPriceCents: plan.priceCents, disclosedPrice: plan.price, switchedAt: new Date().toISOString() });
              act('plan.beta.switch', `${plan.name} · ${plan.price}/month · beta trial end unchanged (${existing.endsAt})`);
              return json(res, 200, { ok: true, switched: true, trial: beta.betaTrialView(upd), notice: plansLib.BETA_TRIAL_NOTICE });
            }
            return json(res, 200, { ok: true, already: true, trial: beta.betaTrialView(existing), notice: plansLib.BETA_TRIAL_NOTICE });
          }
          if (existing.status === 'running') return json(res, 409, { error: 'This workspace already has a free trial running. One free trial per workspace — the beta trial cannot be stacked on top of it.' });
          return json(res, 409, { error: 'This workspace has already used its free trial. The founding waitlist is still open.' });
        }
        // Same Terms Acceptance gate as the public path: a NEW trial
        // requires the separate billing authorization while enforcement
        // is on; the beta panel shows the beta wording (lib/beta).
        const consentOn = consent.enforcementOn();
        if (consentOn) {
          const bv = consent.validateBillingAcceptance(b);
          if (!bv.ok) return json(res, 400, { error: bv.error });
        }
        const rec = beta.startBetaTrial(store, { ws, user, plan, now: Date.now() });
        if (consentOn) {
          consent.recordConsent(store, {
            accountId: user.id, kind: 'billing', source: 'beta-trial-start',
            ip: consent.clientIp(req), userAgent: consent.userAgentOf(req),
            context: { planId: plan.id, planName: plan.name, priceCents: plan.priceCents, beta: true, endsAt: rec.endsAt },
          });
        }
        act('plan.beta', `${plan.name} · ${plan.price}/month · beta tester trial · ends ${rec.endsAt} · returns to Free · no charge`);
        return json(res, 201, { ok: true, trial: beta.betaTrialView(rec), notice: plansLib.BETA_TRIAL_NOTICE });
      }

      // enterprise edition: features, storage, honest limit
      if (p === '/api/enterprise' && req.method === 'GET') {
        return json(res, 200, {
          edition: enterprise.EDITION,
          myPlan: { planId: ent.planId, planName: ent.planName, via: ent.via, features: ent.features },
          workspaceEdition: ws.edition || enterprise.EDITION,
          freeLine: enterprise.FREE_LINE,
          features: enterprise.features(),
          storage: blobBackend ? 'Durable cloud storage (private, survives deploys and restarts)' : 'Local file storage (data/db.json)',
          backupsKept: backupsLib.KEEP,
          honestLimit: enterprise.HONEST_LIMIT,
        });
      }

      // automated backups (owner only — a backup holds the whole database)
      if (p === '/api/backups' && req.method === 'GET') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can manage backups.' });
        if (denyFeature('backups')) return;
        return json(res, 200, { backups: await backupsLib.listBackups(store) });
      }
      if (p === '/api/backups' && req.method === 'POST') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can manage backups.' });
        if (denyFeature('backups')) return;
        const backup = await backupsLib.createBackup(store);
        act('backup.created', backup.name);
        return json(res, 201, { backup });
      }
      if (p === '/api/backups/restore' && req.method === 'POST') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can manage backups.' });
        if (denyFeature('backups')) return;
        const b = await readBody(req);
        const safety = await backupsLib.createBackup(store); // snapshot current state first
        try {
          await backupsLib.restoreBackup(store, String(b.name || ''));
        } catch (e) { return json(res, 400, { error: e.message }); }
        // The restore replaced the DB — log into the restored state so the event survives.
        const member2 = store.find('members', m => m.userId === user.id);
        if (member2) logActivity(store, member2.workspaceId, user.email, 'backup.restored', `${b.name} · pre-restore backup ${safety.name}`);
        return json(res, 200, { ok: true, restored: b.name, preRestoreBackup: safety.name });
      }

      return json(res, 404, { error: 'Unknown API route.' });
    }

    // ---------- static ----------
    const file = p === '/' ? 'index.html' : p.replace(/^\//, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(full));
  } catch (e) {
    return json(res, 500, { error: 'Server error: ' + e.message });
  }
};
const server = http.createServer(handler);

function publicWs(ws) { return { id: ws.id, name: ws.name, slug: ws.slug, tagline: ws.tagline || '', hours: ws.hours || '', edition: ws.edition || enterprise.EDITION, planId: ws.planId || 'free', grandfathered: !!ws.grandfathered, widgets: ws.widgets || {} }; }
// Platform-owner role (lib/config claim rule) — distinct from workspace
// membership roles. Anything not explicitly stamped 'owner' is a member.
function platformRoleOf(user) { return user && user.platformRole === 'owner' ? 'owner' : 'member'; }
// Sign-in claim state (hardened 2026-11-07): NEVER grants the owner role.
// An account that already claimed owner (pre-hardening) is left exactly as
// it is — only its claimStatus bookkeeping is completed. An unverified
// founder account is kept 'pending' with a live code in the operator store.
function applyClaimState(user) {
  if (!user || !config.isOwnerEmail(user.email)) return user;
  if (user.platformRole === 'owner') {
    if (user.claimStatus !== 'verified') return store.update('users', user.id, { claimStatus: 'verified' });
    return user;
  }
  if (user.claimStatus !== 'pending') user = store.update('users', user.id, { claimStatus: 'pending' });
  claims.issueClaimCode(store, user); // no-op while a live pending code exists; replaces a locked one
  return user;
}
function notify(workspaceId, text) { store.insert('notifications', { workspaceId, text }); }
function startSession(res, user, body) {
  const token = auth.newSessionToken();
  store.insert('sessions', { userId: user.id, tokenHash: auth.tokenHash(token), expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() });
  const s = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `mf_session=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax` });
  res.end(s);
}

if (require.main === module) server.listen(PORT, () => console.log(`Meta Free running at http://localhost:${PORT}`));
module.exports = { server, store, handler };
