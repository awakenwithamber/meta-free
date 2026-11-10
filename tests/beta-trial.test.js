'use strict';
// Beta tester trial (owner order 2026-11-10; lib/beta):
//  - A GATED path: beta signups are CLOSED until the platform owner
//    opens them (settings route, owner only). Public signup behavior
//    and the public pre-launch trial are untouched by the gate.
//  - Beta terms differ from the public trial and the copy must say so
//    BEFORE signup: free for 30 days, no payment method taken, never
//    charged — and on day 30 the workspace returns to the Free plan.
//  - The no-charge rule is structural: a beta trial is never registered
//    with a billing provider and carries no first-charge anchor, so
//    the conversion tick can never select it and no invoice can exist.
//  - One free trial per workspace, ever, across BOTH paths.
// Consent enforcement is env-gated and OFF in this test process (the
// default), exactly as in billing-trial.test.js; when it is on, the
// beta route validates the same acceptance fields as the public route.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-beta-'));
process.env.META_FREE_DB = path.join(tmpDir, 'db.json');

const beta = require('../app/lib/beta');
const billing = require('../app/lib/billing');
const plansLib = require('../app/lib/plans');
const providers = require('../app/lib/providers');
const { Store } = require('../app/lib/store');

const DAY = 24 * 3600 * 1000;

// ---------- unit: the gate --------------------------------------------------
test('beta gate: closed by default; the owner setting opens and closes it', () => {
  const store = new Store(path.join(tmpDir, 'gate-db.json'));
  assert.equal(beta.betaEnabled(store), false, 'beta signups start CLOSED');
  const on = beta.setBetaEnabled(store, true, 'amber@awakenagain.com');
  assert.equal(on.enabled, true);
  assert.equal(on.updatedBy, 'amber@awakenagain.com');
  assert.equal(beta.betaEnabled(store), true);
  beta.setBetaEnabled(store, false, 'amber@awakenagain.com');
  assert.equal(beta.betaEnabled(store), false);
});

// ---------- unit: the copy says the true terms, before signup ---------------
test('beta copy: 30 days free, no payment method, never charged, returns to Free', () => {
  const n = plansLib.BETA_TRIAL_NOTICE;
  assert.match(n, /30 days/);
  assert.match(n, /will not be charged/i);
  assert.match(n, /no payment method is taken/i);
  assert.match(n, /returns to the Free plan/i);
  assert.match(n, /cancel any time/i);
  assert.doesNotMatch(n, /first charge/i, 'beta copy must never carry the public trial\u2019s first-charge framing');
  const c = beta.betaConsentText({ planName: 'Advanced', priceText: '$25.00' });
  assert.match(c, /Advanced/);
  assert.match(c, /\$25\.00/);
  assert.match(c, /will not be charged/i);
  assert.match(c, /returns to the Free plan/i);
  assert.doesNotMatch(c, /authorize .* to charge/i, 'the beta acceptance never authorizes a charge');
});

// ---------- unit: record shape + access window ------------------------------
test('beta trial record: frozen disclosures, beta stamps, and NO charge machinery', () => {
  const store = new Store(path.join(tmpDir, 'unit-db.json'));
  const ws = store.insert('workspaces', { name: 'Beta Unit', slug: 'beta-unit', ownerId: 'u1', planId: 'free', grandfathered: false });
  const now = Date.parse('2026-11-10T17:00:00Z');
  const plan = plansLib.planById('advanced');
  const rec = beta.startBetaTrial(store, { ws, user: { id: 'u1', email: 'beta@test.co' }, plan, now });
  assert.equal(rec.beta, true);
  assert.equal(rec.kind, 'beta-tester');
  assert.equal(rec.status, 'running');
  assert.equal(rec.termsVersion, beta.BETA_TERMS_VERSION);
  assert.equal(rec.disclosedPriceCents, 2500, 'the exact approved Advanced price, frozen');
  assert.equal(Date.parse(rec.endsAt) - Date.parse(rec.startedAt), 30 * DAY, 'exactly 30×24h');
  assert.equal(rec.billingDate, null, 'no billing date — nothing is ever charged');
  assert.equal(rec.firstChargeAt, null, 'no first-charge anchor exists');
  assert.equal(rec.providerSubscriptionId, undefined, 'never registered with a provider');
  assert.equal(rec.providerName, null);
  assert.equal(rec.betaNoCharge, true);
  assert.equal(store.all('providerSubs').length, 0);
  assert.equal(store.all('providerInvoices').length, 0);

  // Access: the tier's full feature set during the trial…
  let ent = billing.effectiveEntitlements(store, ws, now + DAY);
  assert.equal(ent.via, 'trial');
  assert.deepEqual(ent.features, plansLib.TIER_FEATURES.advanced);
  // …kept to the end after a cancel…
  store.update('trials', rec.id, { status: 'canceled', canceledAt: new Date(now + DAY).toISOString() });
  ent = billing.effectiveEntitlements(store, ws, now + 2 * DAY);
  assert.equal(ent.via, 'trial-canceled');
  assert.deepEqual(ent.features, plansLib.TIER_FEATURES.advanced);
  // …and on day 30 the workspace is simply back on Free.
  ent = billing.effectiveEntitlements(store, ws, Date.parse(rec.endsAt) + 1000);
  assert.equal(ent.planId, 'free');
  assert.deepEqual(ent.features, ['link-page', 'planner']);
});

// ---------- unit: the conversion tick can never charge a beta trial ---------
test('no-charge invariant: a long-finished beta trial is never converted and never invoiced', () => {
  const store = new Store(path.join(tmpDir, 'tick-db.json'));
  const ws = store.insert('workspaces', { name: 'Old Beta', slug: 'old-beta', ownerId: 'u2', planId: 'free', grandfathered: false });
  const rec = beta.startBetaTrial(store, { ws, user: { id: 'u2', email: 'old@test.co' }, plan: plansLib.planById('expert'), now: Date.parse('2026-09-01T17:00:00Z') });
  const summary = providers.runConversionTick(store, Date.parse('2027-01-01T00:00:00Z'));
  const after = store.find('trials', x => x.id === rec.id);
  assert.notEqual(after.status, 'converted');
  assert.equal(after.conversionOutcome, undefined, 'the tick never even selects a beta trial (no charge anchor)');
  assert.equal(summary.converted, 0);
  assert.equal(store.all('providerInvoices').length, 0, 'no invoice — simulated or otherwise');
  assert.equal(store.all('providerSubs').length, 0);
});

// ---------- HTTP: gate, owner control, start/switch/cancel -------------------
const { server, store } = require('../app/server');
let base;
test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

function client() {
  let ck = '';
  return {
    async api(method, p, body) {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.getSetCookie()[0];
      if (sc) ck = sc.split(';')[0];
      return { status: r.status, data: await r.json().catch(() => ({})) };
    },
  };
}
const tester = client();
const owner = client();
const picky = client();
let betaTrialId = null;
let betaEndsAt = null;

test('http: beta is closed by default — start refused in plain words, settings are owner-only', async () => {
  const reg = await tester.api('POST', '/api/register', { name: 'Beta Tester', email: 'tester@test.co', password: 'password-123', workspace: 'Beta Brand' });
  assert.equal(reg.status, 200);
  const pl = await tester.api('GET', '/api/plans');
  assert.equal(pl.data.beta.enabled, false);
  assert.equal(pl.data.beta.mine, null);
  assert.match(pl.data.beta.notice, /will not be charged/i, 'the beta terms are visible on the plans read even while closed');
  const start = await tester.api('POST', '/api/plans/beta-trial', { planId: 'advanced' });
  assert.equal(start.status, 403);
  assert.match(start.data.error, /not open/i);
  const toggle = await tester.api('POST', '/api/plans/beta/settings', { enabled: true });
  assert.equal(toggle.status, 403, 'a non-owner can never open the beta');
  assert.equal(store.all('trials').length, 0, 'no trial record was created');
});

test('http: the platform owner opens the beta; her own workspace needs no trial', async () => {
  const reg = await owner.api('POST', '/api/register', { name: 'Amber Lynn Patten', email: 'Amber@awakenagain.com', password: 'owner-pass-123', workspace: 'AwakenAgain' });
  assert.equal(reg.status, 200);
  const rows = store.all('claimCodes', c => c.email === 'amber@awakenagain.com' && c.status === 'pending');
  const verify = await owner.api('POST', '/api/claim/verify', { code: rows[rows.length - 1].code });
  assert.equal(verify.status, 200);
  assert.equal(verify.data.platformRole, 'owner');
  const open = await owner.api('POST', '/api/plans/beta/settings', { enabled: true });
  assert.equal(open.status, 200);
  assert.equal(open.data.beta.enabled, true);
  const pl = await owner.api('GET', '/api/plans');
  assert.equal(pl.data.beta.enabled, true);
  const ownStart = await owner.api('POST', '/api/plans/beta-trial', { planId: 'max' });
  assert.equal(ownStart.status, 400, 'the owner plan already runs Max at $0 — no trial record is created for her');
  assert.equal(store.all('trials').length, 0);
});

test('http: a beta tester starts a 30-day beta trial — full tier access, no charge machinery', async () => {
  const start = await tester.api('POST', '/api/plans/beta-trial', { planId: 'advanced' });
  assert.equal(start.status, 201);
  const t = start.data.trial;
  betaTrialId = t.id;
  betaEndsAt = t.endsAt;
  assert.equal(t.beta, true);
  assert.equal(t.status, 'running');
  assert.equal(t.tierId, 'advanced');
  assert.equal(t.priceCents, 2500);
  assert.equal(t.daysRemaining, 30);
  assert.equal(t.willCharge, false);
  assert.equal(t.endBehavior, 'returns-to-free');
  assert.equal(t.firstChargeAt, null);
  assert.match(start.data.notice, /returns to the Free plan/i);
  const stored = store.find('trials', x => x.id === t.id);
  assert.equal(stored.beta, true);
  assert.equal(stored.providerSubscriptionId, undefined);
  assert.equal(store.all('providerSubs').length, 0);
  assert.equal(store.all('providerInvoices').length, 0);

  const pl = await tester.api('GET', '/api/plans');
  assert.equal(pl.data.myPlan.via, 'trial');
  assert.deepEqual(pl.data.myPlan.features, plansLib.TIER_FEATURES.advanced);
  assert.equal(pl.data.myTrial.beta, true, 'the shared trial view carries the beta flag so no surface shows a first charge');
  assert.equal(pl.data.beta.mine.id, t.id);
});

test('http: a mid-trial beta switch edits the same trial; unknown and free plans are rejected', async () => {
  const sw = await tester.api('POST', '/api/plans/beta-trial', { planId: 'expert' });
  assert.equal(sw.status, 200);
  assert.equal(sw.data.switched, true);
  assert.equal(sw.data.trial.id, betaTrialId);
  assert.equal(sw.data.trial.tierId, 'expert');
  assert.equal(sw.data.trial.priceCents, 7450);
  assert.equal(sw.data.trial.endsAt, betaEndsAt, 'switching never moves the end');
  assert.equal(store.all('trials').length, 1);

  const reg = await picky.api('POST', '/api/register', { name: 'Picky', email: 'picky2@test.co', password: 'password-123', workspace: 'Picky Beta' });
  assert.equal(reg.status, 200);
  assert.equal((await picky.api('POST', '/api/plans/beta-trial', { planId: 'free' })).status, 400);
  assert.equal((await picky.api('POST', '/api/plans/beta-trial', { planId: 'platinum' })).status, 400);
  assert.equal(store.all('trials').length, 1, 'rejected starts create nothing');
});

test('http: cancel keeps access to the end; one free trial per workspace across BOTH paths', async () => {
  const cancel = await tester.api('POST', '/api/plans/trial/cancel', {});
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.trial.status, 'canceled');
  const pl = await tester.api('GET', '/api/plans');
  assert.equal(pl.data.myPlan.via, 'trial-canceled');
  assert.deepEqual(pl.data.myPlan.features, plansLib.TIER_FEATURES.expert);
  assert.equal(pl.data.beta.mine.status, 'canceled');
  const againBeta = await tester.api('POST', '/api/plans/beta-trial', { planId: 'essential' });
  assert.equal(againBeta.status, 409, 'no second beta trial');
  const againPublic = await tester.api('POST', '/api/plans/trial', { planId: 'essential' });
  assert.equal(againPublic.status, 409, 'and no public trial after a beta one — one free trial per workspace, ever');
});

test('http: the owner closes the beta and starts are refused again', async () => {
  const close = await owner.api('POST', '/api/plans/beta/settings', { enabled: false });
  assert.equal(close.status, 200);
  assert.equal(close.data.beta.enabled, false);
  const start = await picky.api('POST', '/api/plans/beta-trial', { planId: 'advanced' });
  assert.equal(start.status, 403);
  assert.equal(store.all('trials', x => x.workspaceId !== undefined).length, 1, 'still only the one beta trial record exists');
});
