'use strict';
// SimulationProvider — Meta Free's implementation of the network
// BillingProvider interface (same method names as AwakenFlow's
// provider: createCustomer, attachPaymentMethod, defaultPaymentMethod,
// charge, refund, getChargeByKey — plus createSubscription /
// updateSubscription / cancelSubscription for the trial mirror).
//
// SIMULATION ONLY: live is false, forever, in this module. It mirrors
// trial records into local 'providerSubs' / 'providerInvoices' rows
// labeled SIMULATED so the trial → conversion flow can be exercised
// end-to-end before Phase 7. No raw card, bank, credential, or identity
// data exists here: a "payment method" is a scenario token, and only a
// SHA-256 fingerprint of it is stored (design §4.7).

const crypto = require('crypto');

const PROVIDER_NAME = 'simulation';
const SCENARIOS = ['succeed', 'decline', 'decline-then-succeed', 'insufficient-funds', 'expired-card'];

function fingerprintOf(cardKey) {
  return crypto.createHash('sha256').update('sim-card:' + String(cardKey)).digest('hex');
}
function shortHash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 20);
}

class SimulationProvider {
  // opts: { store, now } — now() is the injectable clock (tests drive
  // it); it may return a Date or epoch milliseconds.
  constructor({ store, now } = {}) {
    if (!store) throw new Error('SimulationProvider requires a store.');
    this.store = store;
    this._nowFn = typeof now === 'function' ? now : () => new Date();
    this.name = PROVIDER_NAME;
    this.live = false; // never true in this module
  }

  now() {
    const v = this._nowFn();
    return v instanceof Date ? v : new Date(v);
  }
  nowIso() { return this.now().toISOString(); }

  createCustomer({ accountId, email }) {
    const providerCustomerId = 'sim_cus_' + shortHash(accountId);
    return { providerCustomerId };
  }

  // A scenario payment method. cardKey identifies the simulated card
  // for fingerprint purposes (default: the scenario name).
  attachPaymentMethod({ providerCustomerId, scenario = 'succeed', cardKey = null }) {
    if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown simulation scenario: ${scenario}`);
    const key = cardKey || scenario;
    const ref = 'sim_pm_' + shortHash(providerCustomerId + ':' + key);
    return { paymentMethodRef: ref, fingerprint: fingerprintOf(key), scenario, last4: '4242' };
  }

  // The stand-in method attached automatically in simulation mode (no
  // hosted checkout exists pre-launch). Same convention as AwakenFlow.
  defaultPaymentMethod({ providerCustomerId }) {
    return this.attachPaymentMethod({ providerCustomerId, scenario: 'succeed', cardKey: 'simulation-default' });
  }

  // Create the subscription mirror for a trial. The frozen anchors are
  // stored VERBATIM from the trial record — the mirror must never
  // recompute them (the trial record is the disclosure of record).
  createSubscription({ providerCustomerId, workspaceId, tierId, amountCents, trialEndsAt, firstChargeAt, scenario = 'succeed' }) {
    if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown simulation scenario: ${scenario}`);
    const providerSubscriptionId = 'sim_sub_' + shortHash(providerCustomerId + ':' + workspaceId + ':' + firstChargeAt);
    const existing = this.store.find('providerSubs', s => s.providerSubscriptionId === providerSubscriptionId);
    if (existing) return { providerSubscriptionId, mirror: existing };
    const mirror = this.store.insert('providerSubs', {
      provider: PROVIDER_NAME, simulated: true,
      providerSubscriptionId, providerCustomerId, workspaceId,
      tierId, amountCents, scenario,
      trialEndsAt, firstChargeAt, // frozen anchors, copied exactly
      status: 'trialing',
      createdAt: this.nowIso(),
    });
    return { providerSubscriptionId, mirror };
  }

  // Tier switch mid-trial: tier + amount move; the anchors NEVER do
  // (the disclosed trial end is frozen — design §4.5).
  updateSubscription({ providerSubscriptionId, tierId, amountCents }) {
    const mirror = this.store.find('providerSubs', s => s.providerSubscriptionId === providerSubscriptionId);
    if (!mirror) throw new Error(`Unknown simulated subscription: ${providerSubscriptionId}`);
    return this.store.update('providerSubs', mirror.id, { tierId, amountCents, switchedAt: this.nowIso() });
  }

  cancelSubscription({ providerSubscriptionId }) {
    const mirror = this.store.find('providerSubs', s => s.providerSubscriptionId === providerSubscriptionId);
    if (!mirror) throw new Error(`Unknown simulated subscription: ${providerSubscriptionId}`);
    if (mirror.status === 'canceled') return { providerSubscriptionId, status: 'canceled', already: true };
    this.store.update('providerSubs', mirror.id, { status: 'canceled', canceledAt: this.nowIso() });
    return { providerSubscriptionId, status: 'canceled' };
  }

  // Charge by idempotency key: a key that already produced an invoice
  // returns that invoice — no second charge is ever created (§5.3).
  charge({ subscriptionId, amountCents, idempotencyKey, paymentMethod = null }) {
    const prior = this.store.find('providerInvoices', i => i.idempotencyKey === idempotencyKey);
    if (prior) {
      return prior.status === 'paid'
        ? { status: 'succeeded', providerChargeId: prior.providerChargeId, providerInvoiceId: prior.id, replay: true }
        : { status: 'failed', code: prior.failureCode || 'card_declined', providerInvoiceId: prior.id, replay: true };
    }
    const mirror = subscriptionId
      ? this.store.find('providerSubs', s => s.providerSubscriptionId === subscriptionId)
      : null;
    const scenario = (paymentMethod && paymentMethod.scenario) || (mirror && mirror.scenario) || 'succeed';
    const ref = (paymentMethod && paymentMethod.paymentMethodRef) || (mirror ? 'sim_pm_' + shortHash(mirror.providerCustomerId + ':simulation-default') : null);
    let outcome = { status: 'succeeded' };
    if (scenario === 'decline') outcome = { status: 'failed', code: 'card_declined', message: 'The card was declined (simulation).' };
    else if (scenario === 'insufficient-funds') outcome = { status: 'failed', code: 'insufficient_funds', message: 'Insufficient funds (simulation).' };
    else if (scenario === 'expired-card') outcome = { status: 'failed', code: 'expired_card', message: 'The card has expired (simulation).' };
    else if (scenario === 'decline-then-succeed') {
      const priorFailures = this.store.all('providerInvoices', i => i.paymentMethodRef === ref && i.status === 'failed').length;
      if (priorFailures === 0) outcome = { status: 'failed', code: 'card_declined', message: 'The card was declined (simulation).' };
    }
    if (outcome.status === 'failed') {
      const inv = this.store.insert('providerInvoices', {
        provider: PROVIDER_NAME, simulated: true, label: 'SIMULATED',
        providerSubscriptionId: subscriptionId || null, workspaceId: mirror ? mirror.workspaceId : null,
        amountCents, idempotencyKey, paymentMethodRef: ref,
        status: 'failed', failureCode: outcome.code, createdAt: this.nowIso(),
      });
      return { status: 'failed', code: outcome.code, message: outcome.message, providerInvoiceId: inv.id };
    }
    const providerChargeId = 'sim_ch_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const inv = this.store.insert('providerInvoices', {
      provider: PROVIDER_NAME, simulated: true, label: 'SIMULATED',
      providerSubscriptionId: subscriptionId || null, workspaceId: mirror ? mirror.workspaceId : null,
      amountCents, idempotencyKey, paymentMethodRef: ref,
      status: 'paid', providerChargeId, createdAt: this.nowIso(),
    });
    if (mirror && mirror.status === 'trialing') {
      this.store.update('providerSubs', mirror.id, { status: 'active', convertedAt: this.nowIso() });
    }
    return { status: 'succeeded', providerChargeId, providerInvoiceId: inv.id };
  }

  refund({ subscriptionId, providerChargeId, amountCents, reason }) {
    const refundId = 'sim_re_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    return { refundId, status: 'refunded' };
  }

  // The provider's own view of a charge, for reconciliation (§8).
  getChargeByKey(idempotencyKey) {
    const inv = this.store.find('providerInvoices', i => i.idempotencyKey === idempotencyKey);
    return inv ? { status: inv.status, amountCents: inv.amountCents, providerChargeId: inv.providerChargeId || null, simulated: true } : null;
  }
}

module.exports = { SimulationProvider, PROVIDER_NAME, SCENARIOS, fingerprintOf };
