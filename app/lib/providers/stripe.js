'use strict';
// StripeProvider — Meta Free's implementation of the network
// BillingProvider interface, extracted 2026-11-07 from AwakenFlow's
// Stripe REST client (awakenflow-crm/app/lib/billing/stripe.js) so the
// two platforms share ONE provider core: fetch + Stripe form encoding,
// env-gated fail-closed configuration, and Stripe-Signature webhook
// verification. It implements the same interface as Meta Free's
// SimulationProvider (createCustomer, attachPaymentMethod,
// defaultPaymentMethod, charge, refund, getChargeByKey — plus
// createSubscription / updateSubscription / cancelSubscription for the
// trial mirror, and createCheckoutSession for hosted enrollment).
//
// Rules carried over verbatim from the AwakenFlow core:
//
//   ENV-GATED, FAIL CLOSED. The provider constructs only when
//   STRIPE_SECRET_KEY + STRIPE_PUBLISHABLE_KEY + STRIPE_WEBHOOK_SECRET
//   are ALL present, well-shaped, and mode-consistent (all test or all
//   live — the mode is read from the key prefixes). Missing, partial,
//   or malformed configuration is identically "not configured" and the
//   constructor throws. getStripeConfig() is the only place the secret
//   VALUES exist; nothing here logs, serializes, or stores a key, and
//   no code path accepts a key from anywhere but the environment.
//
//   NO SDK. Zero-dependency Node; the provider speaks to
//   api.stripe.com with fetch and Stripe's form encoding. The base URL
//   is injectable so the sandbox suite can run the provider against a
//   local stub of the Stripe API (tests/stripe-provider.test.js).
//
//   NO CARD DATA, EVER. Payment methods are collected ONLY on
//   Stripe-hosted pages (Checkout, Customer Portal). This server stores
//   Stripe's ids, the card fingerprint Stripe returns for a
//   hosted-collected method, brand/last4 for display, amounts, and
//   statuses — nothing else.
//
//   TRIAL ANCHORING. Subscriptions and Checkout Sessions are created
//   with trial_end set to the trial record's frozen firstChargeAt
//   instant (the 2:00 AM America/Denver anchor) — never a bare
//   trial_period_days — and the anchors are copied VERBATIM into the
//   local mirror and the Stripe metadata, exactly as the simulation
//   mirror stores them.
//
//   PRICES come only from the caller's config-passed priceCents (the
//   trial's disclosed price, which originates in lib/plans.js — the
//   pricing matrix's code source). No amount is hardcoded here.
//
//   FOUNDER EXEMPTION is enforced one layer up (lib/providers/index.js
//   refuses to register an exempt account with ANY provider), so this
//   class is never constructed on the founder's behalf.

const crypto = require('crypto');
const providerConfig = require('./config');
const plansLib = require('../plans');

const PROVIDER_NAME = 'stripe';
const DEFAULT_BASE_URL = 'https://api.stripe.com';
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // Stripe's own tolerance

// ============================================================
// Configuration (env-gated, fail closed — AwakenFlow getConfig port)
// ============================================================

function getStripeConfig(env = process.env) {
  const secretKey = typeof env.STRIPE_SECRET_KEY === 'string' ? env.STRIPE_SECRET_KEY.trim() : '';
  const webhookSecret = typeof env.STRIPE_WEBHOOK_SECRET === 'string' ? env.STRIPE_WEBHOOK_SECRET.trim() : '';
  const publishableKey = typeof env.STRIPE_PUBLISHABLE_KEY === 'string' ? env.STRIPE_PUBLISHABLE_KEY.trim() : '';
  const secretMode = secretKey.startsWith('sk_test_') ? 'test' : secretKey.startsWith('sk_live_') ? 'live' : null;
  const publishableMode = publishableKey.startsWith('pk_test_') ? 'test' : publishableKey.startsWith('pk_live_') ? 'live' : null;
  const shapeOk =
    !!secretMode && secretKey.length >= 24 &&
    webhookSecret.startsWith('whsec_') && webhookSecret.length >= 16 &&
    !!publishableMode && publishableKey.length >= 24 &&
    secretMode === publishableMode; // a test secret with a live publishable key (or vice versa) is a misconfiguration, not a mode
  const configured = !!shapeOk;
  return {
    // SAFE to log/return: booleans and the mode label only.
    configured,
    mode: configured ? secretMode : null,
    // Credential VALUES live only inside this object, which is never
    // serialized to clients, persisted, or logged.
    secretKey: configured ? secretKey : null,
    webhookSecret: configured ? webhookSecret : null,
    publishableKey: configured ? publishableKey : null,
  };
}

// UI-safe provider state: null when Stripe is not configured (fail
// closed — status surfaces then report simulation / not configured,
// never a faked connection), else booleans/labels only.
function publicState(env = process.env) {
  const cfg = getStripeConfig(env);
  if (!cfg.configured) return null;
  return {
    available: true,
    provider: PROVIDER_NAME,
    mode: cfg.mode,
    modeLabel: cfg.mode === 'live' ? 'LIVE MODE' : 'TEST MODE',
  };
}

// ============================================================
// Webhook signatures — Stripe's real scheme
// Header: t=<unix>,v1=<hex>[,v1=<hex>...][,v0=...]; the signed payload
// is "<t>.<rawBody>" under HMAC-SHA256 with the webhook secret. Stripe
// may send several v1 values (secret rotation) — ANY match verifies.
// ============================================================

function signPayload(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
function signatureHeader(secret, at, rawBody) {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${signPayload(secret, t, rawBody)}`;
}

function verifyStripeSignature(rawBody, header, secret, now = new Date()) {
  if (typeof header !== 'string' || !header) return { ok: false, reason: 'missing Stripe-Signature header' };
  let t = null;
  const v1s = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1s.push(v);
  }
  const ts = t === null ? NaN : Number(t);
  if (!Number.isFinite(ts) || !v1s.length) return { ok: false, reason: 'malformed Stripe-Signature header' };
  const skew = Math.abs(now.getTime() - ts * 1000);
  if (skew > REPLAY_WINDOW_MS) return { ok: false, reason: 'stale signature timestamp (replay window exceeded)' };
  const expected = Buffer.from(signPayload(secret, ts, rawBody), 'utf8');
  const match = v1s.some(v1 => {
    const got = Buffer.from(v1, 'utf8');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
  return match ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

// ============================================================
// Stripe form encoding (bracket notation: items[0][price_data][...])
// ============================================================

function encodeForm(params, prefix = '', out = []) {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item && typeof item === 'object') encodeForm(item, `${name}[${i}]`, out);
        else out.push([`${name}[${i}]`, String(item)]);
      });
    } else if (typeof value === 'object') {
      encodeForm(value, name, out);
    } else if (typeof value === 'boolean') {
      out.push([name, value ? 'true' : 'false']);
    } else {
      out.push([name, String(value)]);
    }
  }
  return out;
}
function formBody(params) {
  return encodeForm(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function shortHash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 20);
}

// ============================================================
// The provider
// ============================================================

const REFUND_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer'];

class StripeProvider {
  // opts: { store, env, now, fetchImpl, baseUrl }. Construction is the
  // fail-closed gate: missing keys throw naming the missing env KEYS
  // (names only); present-but-malformed or mode-mismatched keys throw
  // "not configured" as well. Only a full, well-formed, consistent key
  // set produces an instance.
  constructor({ store = null, env = process.env, now = null, fetchImpl = null, baseUrl = null } = {}) {
    const readiness = providerConfig.stripeReadiness(env);
    if (readiness.state !== 'keys-present') {
      throw new Error(
        `Stripe provider is not configured in Awaken Affordable Meta (missing: ${readiness.missing.join(', ')}). ` +
        'Trials remain records only; no charge is possible.'
      );
    }
    const cfg = getStripeConfig(env);
    if (!cfg.configured) {
      throw new Error(
        'Stripe provider is not configured in Awaken Affordable Meta: the keys present are malformed or ' +
        'mode-mismatched (the secret, publishable, and webhook keys must be complete and all test ' +
        'or all live). Trials remain records only; no charge is possible.'
      );
    }
    this.config = cfg;
    this.store = store;
    this._nowFn = typeof now === 'function' ? now : () => new Date();
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.name = PROVIDER_NAME;
    this.mode = cfg.mode;
    this.live = cfg.mode === 'live';
  }

  now() {
    const v = this._nowFn();
    return v instanceof Date ? v : new Date(v);
  }
  nowIso() { return this.now().toISOString(); }

  _log(method, detail = {}) {
    if (!this.store) return null;
    return this.store.insert('providerCalls', {
      provider: PROVIDER_NAME, method, at: this.nowIso(),
      subscriptionId: detail.subscriptionId || null,
      amountCents: detail.amountCents ?? null,
      idempotencyKey: detail.idempotencyKey || null,
      result: detail.result || null,
      simulated: false,
    });
  }

  async _request(method, path, params = {}, { idempotencyKey = null } = {}) {
    const headers = { Authorization: `Bearer ${this.config.secretKey}` };
    let body;
    if (method === 'GET') {
      const qs = formBody(params);
      if (qs) path += (path.includes('?') ? '&' : '?') + qs;
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = formBody(params);
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res;
    try {
      res = await this.fetch(this.baseUrl + path, { method, headers, body });
    } catch {
      // Sanitized: the path carries ids only, never credentials.
      const e = new Error(`Stripe request failed (${method} ${path.split('?')[0]}): network error.`);
      e.code = 'stripe-network-error';
      throw e;
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      const se = (data && data.error) || {};
      const e = new Error(se.message || `Stripe returned HTTP ${res.status}.`);
      e.code = se.code || 'stripe-error';
      e.type = se.type || null;
      e.status = res.status;
      throw e;
    }
    return data;
  }

  // ---- customers (interface: createCustomer) ----

  async createCustomer({ accountId, email }) {
    const data = await this._request('POST', '/v1/customers', {
      email,
      metadata: { metafree_workspace_id: String(accountId) },
    }, { idempotencyKey: `metafree-customer:${accountId}` });
    this._log('createCustomer', { result: data.id });
    return { providerCustomerId: data.id };
  }

  async findCustomerByEmail(email) {
    const data = await this._request('GET', '/v1/customers', { email, limit: 1 });
    const found = data && Array.isArray(data.data) ? data.data[0] : null;
    return found ? { providerCustomerId: found.id } : null;
  }

  async getOrCreateCustomer({ accountId, email }) {
    if (email) {
      const found = await this.findCustomerByEmail(email);
      if (found) return found;
    }
    return this.createCustomer({ accountId, email });
  }

  // ---- payment methods (interface: attachPaymentMethod) ----
  // Only methods Stripe already holds (collected on a hosted page) can
  // be attached/referenced from here — there is deliberately no code
  // path that accepts card fields.

  async attachPaymentMethod({ providerCustomerId, paymentMethodId }) {
    const pm = await this._request('POST', `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}/attach`, {
      customer: providerCustomerId,
    });
    const full = await this.getPaymentMethod({ paymentMethodId: pm.id });
    this._log('attachPaymentMethod', { result: pm.id });
    return { paymentMethodRef: pm.id, fingerprint: full.fingerprint, last4: full.last4, brand: full.brand, providerCustomerId };
  }

  async getPaymentMethod({ paymentMethodId }) {
    const pm = await this._request('GET', `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`);
    const card = pm.card || {};
    return {
      paymentMethodRef: pm.id,
      fingerprint: card.fingerprint || null,
      last4: card.last4 || null,
      brand: card.brand || null,
    };
  }

  defaultPaymentMethod() {
    // Honest interface behavior: Stripe has no server-side default —
    // methods are collected on hosted pages only.
    const e = new Error('Stripe collects payment methods on its hosted pages only — start a Checkout Session instead.');
    e.code = 'hosted-collection-required';
    throw e;
  }

  // ---- subscriptions: the trial mirror (interface parity with the
  // simulation provider). The local providerSubs row stores the frozen
  // anchors VERBATIM from the trial record — the mirror never
  // recomputes them (the trial record is the disclosure of record). ----

  _priceData(tierId, priceCents) {
    const plan = plansLib.planById(tierId);
    return {
      currency: 'usd',
      product_data: { name: plan ? `Awaken Affordable Meta ${plan.name}` : 'Awaken Affordable Meta plan' },
      unit_amount: priceCents,
      recurring: { interval: 'month' },
    };
  }

  _mirrorFor(providerSubscriptionId) {
    return this.store ? this.store.find('providerSubs', s => s.providerSubscriptionId === providerSubscriptionId) : null;
  }

  async createSubscription({ providerCustomerId, workspaceId, tierId, amountCents, trialEndsAt, firstChargeAt }) {
    if (!this.store) throw new Error('StripeProvider requires a store for subscription mirrors.');
    const existing = this.store.find('providerSubs', s =>
      s.provider === PROVIDER_NAME && s.providerCustomerId === providerCustomerId &&
      s.workspaceId === workspaceId && s.firstChargeAt === firstChargeAt);
    if (existing) return { providerSubscriptionId: existing.providerSubscriptionId, mirror: existing };
    const data = await this._request('POST', '/v1/subscriptions', {
      customer: providerCustomerId,
      items: [{ price_data: this._priceData(tierId, amountCents) }],
      // The anchor: trial_end is the trial's frozen firstChargeAt
      // instant — NOT a bare trial_period_days.
      trial_end: Math.floor(new Date(firstChargeAt).getTime() / 1000),
      payment_settings: { save_default_payment_method: 'on_subscription' },
      metadata: {
        metafree_workspace_id: String(workspaceId),
        metafree_tier_id: String(tierId),
        metafree_trial_ends_at: String(trialEndsAt),
        metafree_first_charge_at: String(firstChargeAt),
      },
    }, { idempotencyKey: `metafree-subscription:${workspaceId}:${tierId}:${firstChargeAt}` });
    const mirror = this.store.insert('providerSubs', {
      provider: PROVIDER_NAME, simulated: false,
      providerSubscriptionId: data.id, providerCustomerId, workspaceId,
      tierId, amountCents,
      trialEndsAt, firstChargeAt, // frozen anchors, copied exactly
      status: data.status || 'trialing',
      createdAt: this.nowIso(),
    });
    this._log('createSubscription', { subscriptionId: mirror.id, amountCents, result: data.id });
    return { providerSubscriptionId: data.id, mirror };
  }

  // Tier switch mid-trial: tier + amount move; the anchors NEVER do
  // (the disclosed trial end is frozen — the update carries no anchor
  // parameters, exactly like the simulation mirror).
  async updateSubscription({ providerSubscriptionId, tierId, amountCents, prorationBehavior = 'create_prorations' }) {
    const mirror = this._mirrorFor(providerSubscriptionId);
    if (!mirror) throw new Error(`Unknown Stripe subscription: ${providerSubscriptionId}`);
    const sub = await this._request('GET', `/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`);
    const itemId = sub.items && Array.isArray(sub.items.data) && sub.items.data[0] ? sub.items.data[0].id : null;
    if (!itemId) { const e = new Error('Stripe subscription has no item to update.'); e.code = 'stripe-no-item'; throw e; }
    await this._request('POST', `/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, {
      items: [{ id: itemId, price_data: this._priceData(tierId, amountCents) }],
      proration_behavior: prorationBehavior,
    });
    const updated = this.store.update('providerSubs', mirror.id, { tierId, amountCents, switchedAt: this.nowIso() });
    this._log('updateSubscription', { subscriptionId: mirror.id, amountCents, result: providerSubscriptionId });
    return updated;
  }

  // Cancel: immediate at Stripe (a canceled TRIAL must never convert),
  // and the mirror cancels with the record.
  async cancelSubscription({ providerSubscriptionId }) {
    const mirror = this._mirrorFor(providerSubscriptionId);
    if (!mirror) throw new Error(`Unknown Stripe subscription: ${providerSubscriptionId}`);
    if (mirror.status === 'canceled') return { providerSubscriptionId, status: 'canceled', already: true };
    await this._request('DELETE', `/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`);
    this.store.update('providerSubs', mirror.id, { status: 'canceled', canceledAt: this.nowIso() });
    this._log('cancelSubscription', { subscriptionId: mirror.id, result: 'canceled' });
    return { providerSubscriptionId, status: 'canceled' };
  }

  async getSubscription({ providerSubscriptionId }) {
    const s = await this._request('GET', `/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`);
    const unixIso = v => (v ? new Date(v * 1000).toISOString() : null);
    return {
      providerSubscriptionId: s.id,
      status: s.status,
      trialEnd: unixIso(s.trial_end),
      currentPeriodStart: unixIso(s.current_period_start),
      currentPeriodEnd: unixIso(s.current_period_end),
      cancelAtPeriodEnd: !!s.cancel_at_period_end,
      latestInvoiceId: s.latest_invoice || null,
      defaultPaymentMethodId: s.default_payment_method || null,
      customerId: s.customer || null,
      metadata: s.metadata || {},
    };
  }

  // ---- charges (interface: charge) ----
  // A one-off invoice charge against the subscription's customer:
  // invoice item + invoice + pay, keyed end-to-end by the caller's
  // idempotency key. A local providerInvoices row is the reconciliation
  // record (getChargeByKey reads it), and a key that already produced
  // an invoice returns that invoice — no second charge is ever created.
  // Returns the SimulationProvider's result shape.
  async charge({ subscriptionId, amountCents, idempotencyKey, paymentMethod = null }) {
    if (!this.store) throw new Error('StripeProvider requires a store for charges.');
    const key = String(idempotencyKey || `charge:${subscriptionId}:${amountCents}`);
    const prior = this.store.find('providerInvoices', i => i.idempotencyKey === key);
    if (prior) {
      return prior.status === 'paid'
        ? { status: 'succeeded', providerChargeId: prior.providerChargeId, providerInvoiceId: prior.stripeInvoiceId || prior.id, replay: true }
        : { status: 'failed', code: prior.failureCode || 'card_declined', providerInvoiceId: prior.stripeInvoiceId || prior.id, replay: true };
    }
    const mirror = subscriptionId ? this._mirrorFor(subscriptionId) : null;
    const providerCustomerId = mirror ? mirror.providerCustomerId : null;
    if (!providerCustomerId) {
      const e = new Error('A Stripe customer is required to charge.');
      e.code = 'stripe-customer-required';
      throw e;
    }
    let inv = null;
    try {
      await this._request('POST', '/v1/invoiceitems', {
        customer: providerCustomerId, amount: amountCents, currency: 'usd',
        ...(subscriptionId ? { subscription: subscriptionId } : {}),
        description: 'Awaken Affordable Meta subscription charge',
      }, { idempotencyKey: `${key}:item` });
      inv = await this._request('POST', '/v1/invoices', {
        customer: providerCustomerId, auto_advance: false,
        ...(subscriptionId ? { subscription: subscriptionId } : {}),
        metadata: {
          metafree_subscription_id: String(subscriptionId || ''),
          metafree_idempotency_key: key,
        },
      }, { idempotencyKey: `${key}:invoice` });
      const paid = await this._request('POST', `/v1/invoices/${encodeURIComponent(inv.id)}/pay`, {}, { idempotencyKey: `${key}:pay` });
      const row = this.store.insert('providerInvoices', {
        provider: PROVIDER_NAME, simulated: false, label: 'STRIPE',
        providerSubscriptionId: subscriptionId || null, workspaceId: mirror ? mirror.workspaceId : null,
        amountCents, idempotencyKey: key, paymentMethodRef: null,
        status: 'paid', providerChargeId: paid.charge || null, stripeInvoiceId: paid.id,
        createdAt: this.nowIso(),
      });
      if (mirror && mirror.status === 'trialing') {
        this.store.update('providerSubs', mirror.id, { status: 'active', convertedAt: this.nowIso() });
      }
      this._log('charge', { subscriptionId: mirror.id, amountCents, idempotencyKey: key, result: 'succeeded' });
      return { status: 'succeeded', providerChargeId: paid.charge || null, providerInvoiceId: paid.id, localInvoiceId: row.id };
    } catch (e) {
      if (e && (e.type === 'card_error' || e.status === 402)) {
        this.store.insert('providerInvoices', {
          provider: PROVIDER_NAME, simulated: false, label: 'STRIPE',
          providerSubscriptionId: subscriptionId || null, workspaceId: mirror ? mirror.workspaceId : null,
          amountCents, idempotencyKey: key, paymentMethodRef: null,
          status: 'failed', failureCode: e.code || 'card_declined', stripeInvoiceId: inv ? inv.id : null,
          createdAt: this.nowIso(),
        });
        this._log('charge', { subscriptionId: mirror.id, amountCents, idempotencyKey: key, result: `failed:${e.code || 'card_declined'}` });
        return { status: 'failed', code: e.code || 'card_declined', message: e.message, providerInvoiceId: inv ? inv.id : null };
      }
      throw e;
    }
  }

  // ---- refunds (interface: refund) ----
  async refund({ subscriptionId, providerChargeId, amountCents, reason }) {
    const data = await this._request('POST', '/v1/refunds', {
      charge: providerChargeId, amount: amountCents,
      reason: REFUND_REASONS.includes(reason) ? reason : 'requested_by_customer',
    });
    this._log('refund', { subscriptionId: subscriptionId || null, amountCents, result: data.status || 'succeeded' });
    return { refundId: data.id, status: data.status === 'succeeded' ? 'refunded' : (data.status || 'pending') };
  }

  // The provider's own view of a charge, for reconciliation — a LOCAL
  // read of the invoice rows charge() recorded (synchronous, like the
  // simulation provider's, so the existing tick/tests shape holds).
  getChargeByKey(idempotencyKey) {
    if (!this.store) return null;
    const inv = this.store.find('providerInvoices', i => i.idempotencyKey === idempotencyKey);
    return inv ? { status: inv.status, amountCents: inv.amountCents, providerChargeId: inv.providerChargeId || null, simulated: false } : null;
  }

  // ---- hosted flows: Checkout + Customer Portal ----

  // Hosted Checkout (mode=subscription). The Price is created inline
  // via price_data from the config-passed priceCents, so no dashboard
  // pre-setup is needed. subscription_data.trial_end is the trial's
  // frozen firstChargeAt instant. Metadata on both the session and the
  // subscription carries our ids + the frozen anchors verbatim, so the
  // signed checkout.session.completed webhook can bind the local trial
  // with identical anchors.
  async createCheckoutSession({ providerCustomerId, tierId, priceCents, trialEnd, metadata = {}, successUrl, cancelUrl, idempotencyKey = null }) {
    const data = await this._request('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer: providerCustomerId,
      line_items: [{ quantity: 1, price_data: this._priceData(tierId, priceCents) }],
      subscription_data: {
        trial_end: Math.floor(new Date(trialEnd).getTime() / 1000),
        metadata,
      },
      metadata,
      success_url: successUrl,
      cancel_url: cancelUrl,
    }, { idempotencyKey: idempotencyKey || undefined });
    this._log('createCheckoutSession', { result: data.id });
    return { id: data.id, url: data.url, status: data.status };
  }

  // Hosted enrollment for an existing trial RECORD (Meta Free's model:
  // the record with its frozen disclosures exists first). The amount is
  // the trial's disclosed price — config-passed from lib/plans.js at
  // record creation, never recomputed or hardcoded here.
  async createCheckoutForTrial({ trial, successUrl, cancelUrl }) {
    const customer = await this.getOrCreateCustomer({ accountId: trial.workspaceId, email: trial.email });
    const metadata = {
      metafree_trial_id: String(trial.id),
      metafree_workspace_id: String(trial.workspaceId),
      metafree_tier_id: String(trial.tierId),
      metafree_trial_ends_at: String(trial.endsAt),
      metafree_first_charge_at: String(trial.firstChargeAt),
    };
    const session = await this.createCheckoutSession({
      providerCustomerId: customer.providerCustomerId,
      tierId: trial.tierId,
      priceCents: trial.disclosedPriceCents,
      trialEnd: trial.firstChargeAt, // the frozen anchor — NOT a bare 30 days
      metadata,
      successUrl,
      cancelUrl,
      idempotencyKey: `metafree-checkout:${trial.id}:${trial.firstChargeAt}`,
    });
    return { ...session, providerCustomerId: customer.providerCustomerId };
  }

  async createPortalSession({ providerCustomerId, returnUrl }) {
    const data = await this._request('POST', '/v1/billing_portal/sessions', {
      customer: providerCustomerId, return_url: returnUrl,
    });
    this._log('createPortalSession', { result: data.id });
    return { id: data.id, url: data.url };
  }
}

// ============================================================
// Webhook event application — idempotent by Stripe event id.
// The route (app/server.js) verifies the Stripe-Signature header with
// verifyStripeSignature BEFORE calling this; an event id that was
// already applied returns { duplicate: true } and changes nothing, so
// Stripe's at-least-once delivery can never double-apply an effect.
// ============================================================

function processStripeEvent(store, event, now = new Date()) {
  if (!store || !event || !event.id || !event.type) return { ok: false, reason: 'malformed event' };
  const prior = store.find('stripeEvents', e => e.eventId === event.id);
  if (prior) return { ok: true, duplicate: true };
  const obj = (event.data && event.data.object) || {};
  const effects = [];
  if (event.type === 'checkout.session.completed') {
    const trialId = obj.metadata && obj.metadata.metafree_trial_id;
    const trial = trialId ? store.find('trials', t => t.id === trialId) : null;
    if (trial) {
      store.update('trials', trial.id, {
        providerName: PROVIDER_NAME,
        providerCustomerId: obj.customer || trial.providerCustomerId || null,
        providerSubscriptionId: obj.subscription || trial.providerSubscriptionId || null,
        simulated: false,
      });
      effects.push('trial-bound');
    }
  } else if (event.type === 'customer.subscription.deleted') {
    const mirror = store.find('providerSubs', s => s.providerSubscriptionId === obj.id);
    if (mirror && mirror.status !== 'canceled') {
      store.update('providerSubs', mirror.id, { status: 'canceled', canceledAt: now.toISOString() });
      effects.push('mirror-canceled');
    }
  } else if (event.type === 'invoice.paid') {
    const mirror = obj.subscription ? store.find('providerSubs', s => s.providerSubscriptionId === obj.subscription) : null;
    if (mirror) {
      store.update('providerSubs', mirror.id, {
        lastInvoicePaidAt: now.toISOString(),
        ...(mirror.status === 'trialing' ? { status: 'active' } : {}),
      });
      effects.push('invoice-paid-noted');
    }
  } else if (event.type === 'invoice.payment_failed') {
    const mirror = obj.subscription ? store.find('providerSubs', s => s.providerSubscriptionId === obj.subscription) : null;
    if (mirror) {
      store.update('providerSubs', mirror.id, { lastPaymentFailedAt: now.toISOString() });
      effects.push('payment-failed-noted');
    }
  }
  store.insert('stripeEvents', {
    eventId: event.id, type: event.type,
    handled: effects.length > 0, effects,
    processedAt: now.toISOString(),
  });
  return { ok: true, duplicate: false, handled: effects.length > 0, effects };
}

module.exports = {
  StripeProvider, PROVIDER_NAME, DEFAULT_BASE_URL, REPLAY_WINDOW_MS,
  getStripeConfig, publicState,
  signPayload, signatureHeader, verifyStripeSignature,
  encodeForm, formBody, processStripeEvent,
};
