'use strict';
// Founding plans / rate card (docs/09) — RECORDS ONLY.
// Amber's directive (2026-11-03): her clone products sell at 50% of the
// original's prices ("Make it 50% of the meta prices", confirmed "Both" —
// AwakenFlow at 50% of HighLevel, Meta Free at 50% of Meta One).
// Source prices are Meta One's, verified from Meta's official plans page
// (meta.com/meta-one-plans) on 2026-11-02. There is NO checkout and NO
// payment processing anywhere in Meta Free: "subscribing" stores a
// waitlist/interest record and nothing else (see server /api/plans).
const enterprise = require('./enterprise');

const SOURCE = {
  product: 'Meta One',
  verifiedFrom: "Meta's official plans page (meta.com/meta-one-plans)",
  verifiedOn: '2026-11-02',
  rate: 0.5,
};

// Meta One's published monthly prices, in integer cents.
const SOURCE_PRICE_CENTS = { essential: 1499, advanced: 4999, expert: 14900, max: 49900 };

// Rounding note (stated openly, docs/09): the true half of $14.99 is $7.495
// and of $49.99 is $24.995. Halving in integer cents and rounding half-up
// gives 750 and 2500 cents — $7.50 and $25.00 — per Amber's pricing
// instruction. $149 and $499 halve exactly ($74.50 / $249.50).
function halfPriceCents(sourceCents) { return Math.round(sourceCents / 2); }

function fmt(cents) { return '$' + (cents / 100).toFixed(2); }

// Tier contents map ONLY to capabilities that already exist in the app
// (enterprise.js FEATURES — every id below is a real feature id there).
const TIER_FEATURES = {
  essential: ['link-page', 'planner', 'inbox'],
  advanced: ['link-page', 'planner', 'inbox', 'auto-reply-rules', 'analytics', 'competitors'],
  expert: ['link-page', 'planner', 'inbox', 'auto-reply-rules', 'analytics', 'competitors', 'approvals', 'due-queue', 'team', 'watchlist'],
  max: ['link-page', 'planner', 'inbox', 'auto-reply-rules', 'analytics', 'competitors', 'approvals', 'due-queue', 'team', 'watchlist', 'audit-log', 'backups', 'connections', 'plugins', 'data-portability'],
};

const TIER_ORDER = ['essential', 'advanced', 'expert', 'max'];
const TIER_NAMES = { essential: 'Essential', advanced: 'Advanced', expert: 'Expert', max: 'Max' };

// Permanent Free tier (design §3.1/§10, approved scope proposal): $0
// forever, no card, never auto-converts. A real, usable plan — a new
// workspace starts here and its link page + planner work from minute one.
// Paid tiers are reached only by a deliberate waitlist join or trial opt-in.
const FREE_TIER = { id: 'free', name: 'Free', priceCents: 0, features: ['link-page', 'planner'] };

function freePlan() {
  const byId = Object.fromEntries(enterprise.features().map(f => [f.id, f]));
  return {
    id: FREE_TIER.id,
    name: FREE_TIER.name,
    priceCents: 0,
    price: fmt(0),
    per: 'month',
    includes: FREE_TIER.features.map(fid => ({ id: fid, name: byId[fid].name, note: byId[fid].note })),
  };
}

const FOUNDING_LABEL = 'Founding pricing — checkout not yet connected';
const INTEREST_LABEL = 'Join the founding waitlist — no payment is taken.';

// Payments → Bluevine (Amber's directive, 2026-11-03; standing decision
// 2026-10-21: Bluevine is the designated bank for RECEIVING payments for
// Awaken With Amber LLC). Meta Free stays WAITLIST-ONLY: this note is the
// whole payment story — founding subscriptions will be invoiced through
// Bluevine when enrollment opens. There is no checkout, no card route,
// and no active subscription created anywhere in this product, and bank
// routing/account numbers are never printed.
const PAYMENT_NOTE = 'Founding subscriptions are invoiced by Awaken With Amber LLC through Bluevine — pay by ACH or check with your reference; no card checkout yet.';
const REFERENCE_MESSAGE = "you'll receive a Bluevine invoice when founding enrollment opens";

// Waitlist reference, e.g. MF-7K2QX9AB — unique across existing records,
// shown to the joiner and to the owner so a future Bluevine invoice (and
// the payment that answers it) can be matched to this record.
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newReference(existingRefs) {
  const crypto = require('crypto');
  const taken = new Set(existingRefs || []);
  let ref;
  do {
    ref = 'MF-' + Array.from(crypto.randomBytes(8)).map(b => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
  } while (taken.has(ref));
  return ref;
}
// Pre-launch trial honesty label (visible-notices rule: prominent, plain,
// shown before anyone opts in). Trials in Meta Free are RECORDS ONLY until
// billing activates — this wording must never overstate that.
const TRIAL_NOTICE = 'PRE-LAUNCH TRIAL — billing is not live yet, and you will not be charged. Starting a trial only records your tier, its exact founding price, and the dates shown. If billing ever activates, the first charge would fall on the first-charge date shown — and you can cancel any time before then and pay nothing.';
// Beta tester trial (owner order 2026-11-10): a SEPARATE, gated path from
// the public pre-launch trial above. The terms differ in one important
// way and the copy must never blur it: a beta trial NEVER charges — not
// during the 30 days and not at the end. On day 30 the workspace returns
// to the Free plan unless the tester chooses a paid plan when billing
// opens. Visible-notices rule: stated in full, before anyone signs up.
const BETA_TRIAL_LABEL = 'Beta tester trial — 30 days free';
const BETA_TRIAL_NOTICE = 'BETA TESTER TRIAL — free for 30 days, and you will not be charged. Beta testers try one paid plan free for 30 days: you get the full plan from the day you start, no payment method is taken, and nothing is charged during the trial or when it ends. When the 30 days end, your workspace simply returns to the Free plan, unless you choose to join the founding waitlist or start a paid plan when billing opens. You can cancel any time during the trial and keep access until the trial end date shown. One beta trial per workspace.';
const CURRENT_STATE_NOTE = 'Workspaces created before the Free plan existed keep the full Enterprise feature set, free (grandfathered — nothing was taken away). New workspaces start on the Free plan (link page + planner). Paid founding tiers can be reserved on the waitlist, or recorded as a pre-launch trial — billing is not live and no payment is taken.';

function plans() {
  const byId = Object.fromEntries(enterprise.features().map(f => [f.id, f]));
  return TIER_ORDER.map(id => {
    const sourceCents = SOURCE_PRICE_CENTS[id];
    const priceCents = halfPriceCents(sourceCents);
    return {
      id,
      name: TIER_NAMES[id],
      sourceName: TIER_NAMES[id],
      sourcePriceCents: sourceCents,
      sourcePrice: fmt(sourceCents),
      priceCents,
      price: fmt(priceCents),
      per: 'month',
      // Annual slot (design §3.3): designed but NOT approved — priceCents
      // stays null and nothing annual renders or sells until Amber prices it.
      intervals: { monthly: { priceCents, approved: true }, annual: { priceCents: null, approved: false } },
      foundingLabel: FOUNDING_LABEL,
      includes: TIER_FEATURES[id].map(fid => ({ id: fid, name: byId[fid].name, note: byId[fid].note })),
    };
  });
}

function planById(id) { return plans().find(p => p.id === id) || null; }

// The lowest-priced plan whose feature set includes a feature — Free first,
// then the paid tiers in price order (tiers are cumulative, so the first
// match is the entry point). Plan gates use this to tell a user exactly
// which plan a locked feature belongs to, in plain language.
function planForFeature(featureId) {
  if (FREE_TIER.features.includes(featureId)) return { id: 'free', name: 'Free', priceCents: 0, price: fmt(0) };
  for (const id of TIER_ORDER) {
    if (TIER_FEATURES[id].includes(featureId)) return planById(id);
  }
  return null;
}

module.exports = { SOURCE, SOURCE_PRICE_CENTS, TIER_FEATURES, TIER_ORDER, TIER_NAMES, FREE_TIER, FOUNDING_LABEL, INTEREST_LABEL, CURRENT_STATE_NOTE, TRIAL_NOTICE, BETA_TRIAL_LABEL, BETA_TRIAL_NOTICE, PAYMENT_NOTE, REFERENCE_MESSAGE, newReference, halfPriceCents, fmt, plans, planById, freePlan, planForFeature };
