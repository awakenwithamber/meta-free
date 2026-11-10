'use strict';
// Billing core — trial engine + entitlements (design:
// muse-prime-awaken-network/reports/UNIVERSAL-BILLING-DESIGN-2026-11-07.md).
//
// PRE-LAUNCH STATE: no live payment rail exists. This module manages
// RECORDS ONLY — trial opt-ins with frozen disclosures, entitlement
// resolution, and the first-charge date math. Nothing here charges anyone,
// creates a provider object, or creates a Payment Due. When (and only
// when) billing activates at Phase 7, a provider implementation consumes
// the frozen firstChargeAt anchors computed here.
const enterprise = require('./enterprise');
const plansLib = require('./plans');

const TRIAL_DAYS = 30;
const TRIAL_MS = TRIAL_DAYS * 24 * 3600 * 1000;
const TERMS_VERSION = '2026-11-07-prelaunch-v1';
const DENVER = 'America/Denver';

// ---------- America/Denver wall-clock helpers (IANA via Intl, no deps) ----
const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: DENVER, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function denverParts(ms) {
  const p = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: (+p.hour) % 24, minute: +p.minute, second: +p.second };
}
// Offset (wall-clock-as-UTC minus UTC) for the zone at instant ms.
function denverOffsetMs(ms) {
  const p = denverParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
// UTC instant of a Denver wall time. For a NONEXISTENT wall time (the
// spring-forward gap) this lands near the gap; firstChargeInstant() below
// does not rely on it for the 2:00 AM target — it searches instead.
function denverWallToUtc(year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target + 7 * 3600 * 1000;
  for (let i = 0; i < 4; i++) {
    const next = target - denverOffsetMs(guess);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}
// The first-charge rule (design §5.2): the earliest UTC instant on the
// billing date at which the Denver wall clock reads 2:00 AM or later.
//  - Normal day: 2:00 AM MST (09:00Z) or MDT (08:00Z).
//  - Spring forward (e.g. 2027-03-14): 2:00 AM does not exist → 3:00 AM MDT
//    (09:00Z), the first valid instant at/after the promised time. Never early.
//  - Fall back (e.g. 2027-11-07): the repeated hour is 1:00–1:59 AM, so the
//    first instant reading ≥2:00 AM is the single 2:00 AM MST (09:00Z).
// Binary search over the local day at minute precision; local time is
// monotonic in UTC across both transitions for the ≥2:00 predicate.
function firstChargeInstant(year, month, day) {
  const lo = denverWallToUtc(year, month, day, 0, 0); // local midnight
  const hi = lo + 26 * 3600 * 1000;
  const dateKey = Date.UTC(year, month - 1, day);
  const atOrAfter2 = (t) => {
    const p = denverParts(t);
    const dk = Date.UTC(p.year, p.month - 1, p.day);
    if (dk !== dateKey) return dk > dateKey;
    return p.hour * 60 + p.minute >= 120;
  };
  let a = lo, b = hi;
  while (b - a > 60000) {
    const mid = Math.floor((a + b) / 120000) * 60000;
    if (atOrAfter2(mid)) b = mid; else a = mid;
  }
  return b;
}
const pad = n => String(n).padStart(2, '0');

// ---------- Trial window (design §4.4 + §5.1) -----------------------------
// endsAt = startedAt + exactly 30×24h (absolute — across a DST change the
// wall-clock end shifts; the user always gets 30 full days). Billing date =
// the Denver calendar date AFTER the completion date; the trial is never
// shortened to reach 2:00 AM — the gap (~2–26h) is free bridge access.
function trialWindow(startMs) {
  const endsAt = startMs + TRIAL_MS;
  const ep = denverParts(endsAt);
  const bd = new Date(Date.UTC(ep.year, ep.month - 1, ep.day) + 24 * 3600 * 1000);
  const by = bd.getUTCFullYear(), bm = bd.getUTCMonth() + 1, bday = bd.getUTCDate();
  return {
    startedAt: new Date(startMs).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    billingDate: `${by}-${pad(bm)}-${pad(bday)}`,
    firstChargeAt: new Date(firstChargeInstant(by, bm, bday)).toISOString(),
  };
}

// ---------- Trial record views ---------------------------------------------
function trialView(trial, nowMs = Date.now()) {
  if (!trial) return null;
  const endsMs = Date.parse(trial.endsAt);
  let effectiveStatus = trial.status;
  if (trial.status === 'running' && nowMs >= endsMs) effectiveStatus = 'expired';
  const msRemaining = Math.max(0, endsMs - nowMs);
  return {
    id: trial.id,
    tierId: trial.tierId,
    tierName: trial.tierName,
    price: trial.disclosedPrice,
    priceCents: trial.disclosedPriceCents,
    interval: trial.interval,
    status: trial.status,
    effectiveStatus,
    startedAt: trial.startedAt,
    endsAt: trial.endsAt,
    billingDate: trial.billingDate,
    firstChargeAt: trial.firstChargeAt,
    daysRemaining: Math.ceil(msRemaining / (24 * 3600 * 1000)),
    canceledAt: trial.canceledAt || null,
    // Provider binding (lib/providers): which provider mirrors this
    // trial, whether that mirror is simulation, and the conversion
    // tick's outcome once the first-charge instant has been processed.
    provider: trial.providerName || null,
    providerExempt: !!trial.providerExempt,
    simulated: !!trial.simulated,
    conversionOutcome: trial.conversionOutcome || null,
    preLaunch: true,
  };
}
function latestTrial(store, workspaceId) {
  const rows = store.all('trials', t => t.workspaceId === workspaceId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows[0] || null;
}
// Does this trial currently grant its tier's features? Running and not yet
// ended — or canceled but still inside the endsAt window (directive: cancel
// keeps access to the disclosed trial end, and is never charged).
function trialGrantsAccess(trial, nowMs = Date.now()) {
  if (!trial) return false;
  if (trial.status === 'converted') return true;
  if (trial.status !== 'running' && trial.status !== 'canceled') return false;
  return nowMs < Date.parse(trial.endsAt);
}

// ---------- Grandfathering + entitlements (design §3.5) --------------------
// Workspaces created BEFORE the Free tier existed carry no plan fields.
// The first time such a record is touched it is stamped grandfathered —
// it keeps the full Enterprise feature set it has always had. Nothing is
// ever taken away from an existing workspace by this code.
function ensureWorkspacePlan(store, ws) {
  if (!ws) return ws;
  if (ws.grandfathered === undefined) {
    ws.grandfathered = true;
    ws.planId = 'enterprise-grandfathered';
    store.save();
  }
  return ws;
}

function effectiveEntitlements(store, ws, nowMs = Date.now(), opts = {}) {
  ensureWorkspacePlan(store, ws);
  // Platform-owner plan (owner directive 2026-11-08): the verified platform
  // owner's own workspace runs the TOP tier (Max — the full feature set) at
  // $0. This is structural, not a discount or a coupon: the owner is never
  // registered with a billing provider and never charged (the provider
  // exemption in lib/providers mirrors it), and no other account can reach
  // this branch — the server passes platformOwner only for the hardened
  // local claim or a verified AwakenConnect founder assertion.
  if (opts.platformOwner) {
    return {
      planId: 'max',
      planName: 'Max',
      grandfathered: !!ws.grandfathered,
      via: 'owner-plan',
      priceCents: 0,
      features: (plansLib.TIER_FEATURES.max || []).slice(),
      trial: null,
    };
  }
  if (ws.grandfathered) {
    return {
      planId: 'enterprise-grandfathered',
      planName: 'Enterprise (grandfathered)',
      grandfathered: true,
      via: 'grandfathered',
      features: enterprise.features().map(f => f.id),
      trial: null,
    };
  }
  const trial = latestTrial(store, ws.id);
  if (trialGrantsAccess(trial, nowMs)) {
    return {
      planId: trial.tierId,
      planName: trial.tierName,
      grandfathered: false,
      via: trial.status === 'canceled' ? 'trial-canceled' : 'trial',
      features: (plansLib.TIER_FEATURES[trial.tierId] || []).slice(),
      trial: trialView(trial, nowMs),
    };
  }
  const free = plansLib.freePlan();
  return {
    planId: 'free',
    planName: 'Free',
    grandfathered: false,
    via: 'free',
    features: free.includes.map(f => f.id),
    trial: trial ? trialView(trial, nowMs) : null,
  };
}

// ---------- Plan gate (route enforcement) ----------------------------------
// The visible-notices rule applied to plan limits: when a workspace's plan
// does not include a feature, the answer is a complete, plain-language
// explanation — what the feature is, which plan includes it, its exact
// founding price, and the honest billing state (waitlist / pre-launch
// trial records only; no payment is taken). Returns null when the feature
// IS included (the common path — grandfathered and owner-plan workspaces
// hold the full set, so nothing changes for them).
function featureGate(entitlements, featureId) {
  if (!entitlements || !Array.isArray(entitlements.features)) return null;
  if (entitlements.features.includes(featureId)) return null;
  const byId = Object.fromEntries(enterprise.features().map(f => [f.id, f]));
  const fname = byId[featureId] ? byId[featureId].name : featureId;
  const need = plansLib.planForFeature(featureId);
  const needTxt = need ? ` It is part of the ${need.name} plan (${need.price}/month at founding pricing).` : '';
  return {
    error: `“${fname}” is not included in your current plan (${entitlements.planName}).${needTxt} ${plansLib.FOUNDING_LABEL} — join the founding waitlist or record a 30-day pre-launch trial on the Plans page; no payment is taken.`,
    code: 'FEATURE_NOT_IN_PLAN',
    feature: featureId,
    neededPlan: need ? need.id : null,
  };
}

module.exports = {
  TRIAL_DAYS, TRIAL_MS, TERMS_VERSION, DENVER,
  denverParts, firstChargeInstant, trialWindow,
  trialView, latestTrial, trialGrantsAccess,
  ensureWorkspacePlan, effectiveEntitlements, featureGate,
};
