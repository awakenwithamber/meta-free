'use strict';
// Billing provider configuration + selection (network pattern: the
// AwakenPay BillingProvider boundary from UNIVERSAL-BILLING-DESIGN
// §6 — one provider interface, selected by configuration, fail-closed).
//
// DEFAULT provider is 'simulation'. It mirrors trials into local
// records labeled SIMULATED and can never move real money
// (live: false, always). Simulation stays the default selection —
// Stripe is used only when META_FREE_BILLING_PROVIDER=stripe is set
// explicitly AND the full key set validates.
//
// The Stripe slot is ENV-GATED and FAIL-CLOSED, following the network's
// authorizenet.js pattern: unless the FULL key set is present in the
// environment AND well-shaped/mode-consistent, the provider reports
// NOT CONFIGURED and refuses to construct. The shared Stripe REST
// client was extracted from AwakenFlow into lib/providers/stripe.js on
// 2026-11-07. Key VALUES are never read into status output; only key
// NAMES are ever reported.
//
// Selection: env META_FREE_BILLING_PROVIDER ('simulation' | 'stripe').
// Default: 'simulation'.

// The full set required before the Stripe slot will even consider
// itself configured. A partial set is a misconfiguration, never a
// partial enablement.
const STRIPE_ENV_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET'];

function selectedName(env = process.env) {
  const raw = String(env.META_FREE_BILLING_PROVIDER || 'simulation').trim().toLowerCase();
  return raw || 'simulation';
}

function stripeReadiness(env = process.env) {
  const missing = STRIPE_ENV_KEYS.filter(k => !env[k] || !String(env[k]).trim());
  if (missing.length === STRIPE_ENV_KEYS.length) return { state: 'not-configured', missing, present: [] };
  if (missing.length > 0) return { state: 'partial', missing, present: STRIPE_ENV_KEYS.filter(k => !missing.includes(k)) };
  return { state: 'keys-present', missing: [], present: STRIPE_ENV_KEYS.slice() };
}

// The honest status the Plans UI renders (data-driven; the view never
// hard-codes provider wording). Simulation and every unconfigured or
// malformed Stripe state report live: false. A fully configured Stripe
// slot reports its real mode (TEST MODE / LIVE MODE) — it can only be
// reached when the operator has explicitly selected it AND supplied a
// complete, valid key set.
function statusInfo(env = process.env) {
  const selected = selectedName(env);
  if (selected === 'simulation') {
    return {
      provider: 'simulation',
      live: false,
      state: 'records-only',
      label: 'SIMULATION',
      line: 'Billing provider: not configured — trials are records only. (A simulation mirror is kept for testing; no real charges are possible.)',
    };
  }
  if (selected === 'stripe') {
    const r = stripeReadiness(env);
    if (r.state === 'not-configured') {
      return {
        provider: 'stripe', live: false, state: 'unavailable', label: 'UNAVAILABLE',
        line: 'Billing provider: Stripe is not configured (no keys set) — trials are records only and you will not be charged.',
      };
    }
    if (r.state === 'partial') {
      return {
        provider: 'stripe', live: false, state: 'partial', label: 'UNAVAILABLE',
        line: `Billing provider: Stripe is partially configured (missing: ${r.missing.join(', ')}) and is disabled — trials are records only and you will not be charged.`,
      };
    }
    // Keys present: shape decides. Malformed or mode-mismatched keys
    // are a misconfiguration — the slot stays disabled and says so.
    const { getStripeConfig } = require('./stripe');
    const cfg = getStripeConfig(env);
    if (!cfg.configured) {
      return {
        provider: 'stripe', live: false, state: 'unavailable', label: 'UNAVAILABLE',
        line: 'Billing provider: Stripe keys are present but are not valid (malformed or mode-mismatched) and the provider is disabled — trials are records only and you will not be charged.',
      };
    }
    const modeLabel = cfg.mode === 'live' ? 'LIVE MODE' : 'TEST MODE';
    return {
      provider: 'stripe', live: cfg.mode === 'live', state: 'configured', label: modeLabel, mode: cfg.mode,
      line: `Billing provider: Stripe is configured (${modeLabel}). Trials bind to Stripe with the first-charge date shown; you can cancel any time before then.`,
    };
  }
  return {
    provider: selected, live: false, state: 'unavailable', label: 'UNAVAILABLE',
    line: `Billing provider: '${selected}' is not a recognized provider and is disabled — trials are records only and you will not be charged.`,
  };
}

// Factory: returns a ready provider instance for the selected name.
// Throws (fail-closed) for an unconfigured/malformed Stripe slot and
// for unknown names — callers that cannot tolerate a throw should read
// statusInfo() first. fetchImpl/baseUrl pass through so tests can run
// the Stripe provider against a local stub of the Stripe API.
function createProvider(store, { env = process.env, now, fetchImpl, baseUrl } = {}) {
  const selected = selectedName(env);
  if (selected === 'simulation') {
    const { SimulationProvider } = require('./simulation');
    return new SimulationProvider({ store, now });
  }
  if (selected === 'stripe') {
    const { StripeProvider } = require('./stripe');
    return new StripeProvider({ store, env, now, fetchImpl, baseUrl }); // constructor throws when unconfigured, fail-closed
  }
  throw new Error(`Unknown billing provider '${selected}' (META_FREE_BILLING_PROVIDER) — refusing to continue.`);
}

module.exports = { STRIPE_ENV_KEYS, selectedName, stripeReadiness, statusInfo, createProvider };
