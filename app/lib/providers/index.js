'use strict';
// Billing providers — selection, trial binding, and the conversion
// tick (design: UNIVERSAL-BILLING-DESIGN §5/§6; AwakenPay provider
// boundary). Trials remain the disclosure of record (lib/billing);
// this module mirrors them into the selected provider and processes
// due conversions. Simulation is the DEFAULT provider: every mirror
// and invoice it produces is labeled SIMULATED and it can never move
// real money. The Stripe provider (extracted from AwakenFlow
// 2026-11-07) is selected only by explicit configuration with a full,
// valid key set; its network calls are async, so the binding functions
// below return a Promise when Stripe is the selected provider and a
// plain value for simulation — the HTTP call sites await either.
//
// FOUNDER EXEMPTION: the founder/owner never registers with any
// provider, on any platform (network rule — the owner plan is created
// with NO provider objects, mirroring AwakenFlow's guard). A trial
// recorded by the platform owner (verified role) or from a founder
// claim email is marked providerExempt and skipped by every binding
// function and by the tick.

const providerConfig = require('./config');
const config = require('../config');

function isBillingExempt(user) {
  if (!user) return false;
  return user.platformRole === 'owner' || config.isOwnerEmail(user.email);
}

// Register a freshly created trial with the selected provider. Creates
// the provider customer + subscription mirror with the trial's frozen
// anchors copied verbatim, and stamps the references back onto the
// trial record. Exempt (founder) trials create NO provider objects.
function registerTrial(store, trial, user, opts = {}) {
  if (!trial) return trial;
  if (isBillingExempt(user)) {
    return store.update('trials', trial.id, { providerName: null, providerExempt: true, simulated: false });
  }
  const provider = providerConfig.createProvider(store, opts);
  if (provider.name === 'stripe') return registerTrialStripe(store, trial, provider);
  const customer = provider.createCustomer({ accountId: trial.workspaceId, email: trial.email });
  const sub = provider.createSubscription({
    providerCustomerId: customer.providerCustomerId,
    workspaceId: trial.workspaceId,
    tierId: trial.tierId,
    amountCents: trial.disclosedPriceCents,
    trialEndsAt: trial.endsAt,
    firstChargeAt: trial.firstChargeAt,
  });
  return store.update('trials', trial.id, {
    providerName: provider.name,
    providerExempt: false,
    providerCustomerId: customer.providerCustomerId,
    providerSubscriptionId: sub.providerSubscriptionId,
    simulated: provider.name === 'simulation',
  });
}

// Stripe binding: customer + subscription mirror over the network.
// The anchors handed to Stripe are the trial's frozen strings, and the
// mirror stores them verbatim — identical semantics to simulation.
async function registerTrialStripe(store, trial, provider) {
  const customer = await provider.getOrCreateCustomer({ accountId: trial.workspaceId, email: trial.email });
  const sub = await provider.createSubscription({
    providerCustomerId: customer.providerCustomerId,
    workspaceId: trial.workspaceId,
    tierId: trial.tierId,
    amountCents: trial.disclosedPriceCents,
    trialEndsAt: trial.endsAt,
    firstChargeAt: trial.firstChargeAt,
  });
  return store.update('trials', trial.id, {
    providerName: provider.name,
    providerExempt: false,
    providerCustomerId: customer.providerCustomerId,
    providerSubscriptionId: sub.providerSubscriptionId,
    simulated: false,
  });
}

// Mid-trial tier switch: the mirror's tier + amount follow the record;
// anchors never move (createSubscription stored them verbatim and
// updateSubscription has no anchor parameters at all).
function syncTrialSwitch(store, trial, opts = {}) {
  if (!trial || !trial.providerSubscriptionId) return trial;
  const provider = providerConfig.createProvider(store, opts);
  if (provider.name === 'stripe') {
    return provider.updateSubscription({
      providerSubscriptionId: trial.providerSubscriptionId,
      tierId: trial.tierId,
      amountCents: trial.disclosedPriceCents,
    }).then(() => trial);
  }
  provider.updateSubscription({
    providerSubscriptionId: trial.providerSubscriptionId,
    tierId: trial.tierId,
    amountCents: trial.disclosedPriceCents,
  });
  return trial;
}

// Cancel: the provider mirror cancels with the record, so a canceled
// trial can never convert later.
function cancelTrialProvider(store, trial, opts = {}) {
  if (!trial || !trial.providerSubscriptionId) return trial;
  const provider = providerConfig.createProvider(store, opts);
  if (provider.name === 'stripe') {
    return provider.cancelSubscription({ providerSubscriptionId: trial.providerSubscriptionId })
      .then(() => store.update('trials', trial.id, { providerCanceledAt: new Date().toISOString() }));
  }
  provider.cancelSubscription({ providerSubscriptionId: trial.providerSubscriptionId });
  return store.update('trials', trial.id, { providerCanceledAt: new Date().toISOString() });
}

// Conversion tick — invoked by an internal sweep (the plans read path
// calls it lazily; no new cron is created). Processes every trial whose
// frozen firstChargeAt has arrived:
//  - running + mirror   → provider charge by idempotency key; success
//    converts the trial (first invoice labeled SIMULATED), failure
//    leaves a failed-labeled state with the provider's code.
//  - canceled            → outcome recorded as 'canceled'; never charged.
//  - founder-exempt      → skipped silently (never any provider object).
//  - running, no mirror  → a pre-wiring record: outcome labeled
//    'no-provider' so the state is explicit, never silently converted.
// Idempotent: converted/canceled/failed outcomes are terminal here, and
// the provider charge itself is idempotency-keyed, so re-running the
// tick can never double-charge.
function runConversionTick(store, nowMs = Date.now(), opts = {}) {
  // Stripe's charge path is network I/O: same tick semantics, async.
  if (providerConfig.selectedName(opts.env || process.env) === 'stripe') {
    return runConversionTickStripe(store, nowMs, opts);
  }
  const summary = { converted: 0, canceled: 0, failed: 0, skipped: 0 };
  const due = store.all('trials', t =>
    (t.status === 'running' || t.status === 'canceled') &&
    !t.conversionOutcome &&
    Date.parse(t.firstChargeAt) <= nowMs);
  let provider = null;
  const getProvider = () => provider || (provider = providerConfig.createProvider(store, { ...opts, now: opts.now || (() => new Date(nowMs)) }));
  for (const trial of due) {
    if (trial.providerExempt) { summary.skipped++; continue; }
    if (trial.status === 'canceled') {
      store.update('trials', trial.id, { conversionOutcome: 'canceled', conversionAt: new Date(nowMs).toISOString() });
      summary.canceled++;
      continue;
    }
    if (!trial.providerSubscriptionId) {
      store.update('trials', trial.id, { conversionOutcome: 'no-provider', conversionAt: new Date(nowMs).toISOString() });
      summary.skipped++;
      continue;
    }
    const result = getProvider().charge({
      subscriptionId: trial.providerSubscriptionId,
      amountCents: trial.disclosedPriceCents,
      idempotencyKey: `mf-trial:${trial.id}:first-charge`,
    });
    if (result.status === 'succeeded') {
      store.update('trials', trial.id, {
        status: 'converted',
        conversionOutcome: 'converted',
        conversionAt: new Date(nowMs).toISOString(),
        providerInvoiceId: result.providerInvoiceId || null,
        providerChargeId: result.providerChargeId || null,
      });
      summary.converted++;
    } else {
      store.update('trials', trial.id, {
        status: 'conversion-failed',
        conversionOutcome: 'failed',
        conversionAt: new Date(nowMs).toISOString(),
        conversionError: result.code || 'charge_failed',
        providerInvoiceId: result.providerInvoiceId || null,
      });
      summary.failed++;
    }
  }
  return summary;
}

// The Stripe conversion tick: identical outcome rules to the sync
// (simulation) tick above — canceled never charges, exempt is skipped,
// a missing mirror is labeled 'no-provider', charges are
// idempotency-keyed — with the provider's async charge awaited.
async function runConversionTickStripe(store, nowMs, opts) {
  const summary = { converted: 0, canceled: 0, failed: 0, skipped: 0 };
  const due = store.all('trials', t =>
    (t.status === 'running' || t.status === 'canceled') &&
    !t.conversionOutcome &&
    Date.parse(t.firstChargeAt) <= nowMs);
  let provider = null;
  const getProvider = () => provider || (provider = providerConfig.createProvider(store, { ...opts, now: opts.now || (() => new Date(nowMs)) }));
  for (const trial of due) {
    if (trial.providerExempt) { summary.skipped++; continue; }
    if (trial.status === 'canceled') {
      store.update('trials', trial.id, { conversionOutcome: 'canceled', conversionAt: new Date(nowMs).toISOString() });
      summary.canceled++;
      continue;
    }
    if (!trial.providerSubscriptionId) {
      store.update('trials', trial.id, { conversionOutcome: 'no-provider', conversionAt: new Date(nowMs).toISOString() });
      summary.skipped++;
      continue;
    }
    const result = await getProvider().charge({
      subscriptionId: trial.providerSubscriptionId,
      amountCents: trial.disclosedPriceCents,
      idempotencyKey: `mf-trial:${trial.id}:first-charge`,
    });
    if (result.status === 'succeeded') {
      store.update('trials', trial.id, {
        status: 'converted',
        conversionOutcome: 'converted',
        conversionAt: new Date(nowMs).toISOString(),
        providerInvoiceId: result.providerInvoiceId || null,
        providerChargeId: result.providerChargeId || null,
      });
      summary.converted++;
    } else {
      store.update('trials', trial.id, {
        status: 'conversion-failed',
        conversionOutcome: 'failed',
        conversionAt: new Date(nowMs).toISOString(),
        conversionError: result.code || 'charge_failed',
        providerInvoiceId: result.providerInvoiceId || null,
      });
      summary.failed++;
    }
  }
  return summary;
}

module.exports = {
  statusInfo: providerConfig.statusInfo,
  createProvider: providerConfig.createProvider,
  selectedName: providerConfig.selectedName,
  stripeReadiness: providerConfig.stripeReadiness,
  isBillingExempt, registerTrial, syncTrialSwitch, cancelTrialProvider, runConversionTick,
};
