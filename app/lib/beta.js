'use strict';
// Beta tester program — the 30-day free trial for beta testers
// (owner order 2026-11-10: "Set up payments with 30 day free trial for
// beta testers"). This is a GATED path alongside the public pre-launch
// trial (lib/billing), not a change to it:
//
//  - The platform owner opens and closes beta signups with a setting
//    (settings collection, key 'betaTrial'; default CLOSED). Nothing
//    about public signup behavior changes when the beta opens.
//  - A beta trial is a normal trial record (same frozen disclosures,
//    same entitlement engine) with three structural differences that
//    make "you will not be charged" a fact of the code, not a promise:
//      1. It is NEVER registered with a billing provider — no provider
//         customer, no subscription mirror, nothing to charge with.
//      2. It carries NO first-charge anchor (billingDate/firstChargeAt
//         are null), so the conversion tick never selects it — there
//         is no date on which anything could be charged.
//      3. When the 30 days end, entitlement resolution simply falls
//         back to the Free plan (billing.trialGrantsAccess ends at
//         endsAt). No invoice is created, manual or otherwise.
//  - One free trial per workspace, ever, across BOTH paths — a beta
//    trial and the public pre-launch trial share the same trials
//    collection and the same one-trial rule, so neither path can be
//    used to stack a second free month.
//  - The live card rail (Authorize.net) is still under merchant review;
//    when billing opens, a beta tester who wants to stay on a paid plan
//    follows the same manual/invoice flow as everyone else. No copy in
//    this module promises automatic charging, because none exists.
const billing = require('./billing');
const plansLib = require('./plans');

const BETA_TERMS_VERSION = '2026-11-10-beta-v1';
const SETTINGS_KEY = 'betaTrial';

// ---------- the owner-controlled gate -------------------------------------
function betaEnabled(store) {
  const row = store.find('settings', x => x.key === SETTINGS_KEY);
  return !!(row && row.enabled === true);
}
function setBetaEnabled(store, enabled, actorEmail) {
  const now = new Date().toISOString();
  const row = store.find('settings', x => x.key === SETTINGS_KEY);
  if (row) return store.update('settings', row.id, { enabled: !!enabled, updatedAt: now, updatedBy: actorEmail || null });
  return store.insert('settings', { key: SETTINGS_KEY, enabled: !!enabled, updatedAt: now, updatedBy: actorEmail || null });
}

// ---------- the beta authorization sentence --------------------------------
// Shown next to the acceptance box BEFORE a beta trial starts (the
// Terms Acceptance flow validates the same fields as the public path;
// only the words differ, because the beta terms differ: no charge, ever).
function betaConsentText({ planName, priceText }) {
  return `I understand the beta tester trial for the ${planName} plan (${priceText}/month at founding pricing): it is free for 30 days starting today, no payment method is taken, and I will not be charged — not during the trial and not when it ends. When the 30 days end, my workspace returns to the Free plan unless I choose a paid plan when billing opens. I can cancel any time during the trial and keep access until the trial end date.`;
}

// ---------- views -----------------------------------------------------------
function betaTrialOf(store, workspaceId) {
  const t = billing.latestTrial(store, workspaceId);
  return t && t.beta ? t : null;
}
function betaTrialView(trial, nowMs = Date.now()) {
  if (!trial) return null;
  const view = billing.trialView(trial, nowMs);
  return {
    ...view,
    beta: true,
    // Honest end-of-trial semantics, stated on every beta surface:
    willCharge: false,
    endBehavior: 'returns-to-free',
    // A beta trial has no charge date — never render the public
    // trial's first-charge framing for it.
    billingDate: null,
    firstChargeAt: null,
  };
}

// ---------- start -----------------------------------------------------------
// Creates the beta trial record. Caller (the route) has already checked
// the gate, the plan, the Terms Acceptance, and the one-trial rule.
// Deliberately does NOT call providers.registerTrial — see header.
function startBetaTrial(store, { ws, user, plan, now = Date.now() }) {
  const w = billing.trialWindow(now);
  return store.insert('trials', {
    workspaceId: ws.id, userId: user.id, email: user.email,
    tierId: plan.id, tierName: plan.name, interval: 'monthly',
    disclosedPriceCents: plan.priceCents, disclosedPrice: plan.price,
    startedAt: w.startedAt, endsAt: w.endsAt,
    // No charge anchor exists for a beta trial — nothing is ever charged.
    billingDate: null, firstChargeAt: null,
    termsVersion: BETA_TERMS_VERSION, consentedAt: new Date(now).toISOString(),
    status: 'running', preLaunch: true,
    kind: 'beta-tester', beta: true, betaNoCharge: true,
    providerName: null, providerExempt: false, simulated: false,
  });
}

module.exports = {
  BETA_TERMS_VERSION, SETTINGS_KEY,
  betaEnabled, setBetaEnabled,
  betaConsentText, betaTrialOf, betaTrialView, startBetaTrial,
};
