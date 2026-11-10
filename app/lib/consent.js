'use strict';
// Terms Acceptance System (owner directive 2026-11-07) — the standard
// consent module, built once and shipped in every Awaken Network platform
// with only the CONFIG block below changed per platform.
//
// ACTIVATION GATE (hard owner rule): the legal agreements must NOT go
// live until the final documents have the owner's approval + legal
// review. Enforcement is therefore behind env CONSENT_ENFORCEMENT
// (default 'off'). With the flag OFF, registration behaves exactly as it
// did before this module existed — no checkbox, no blocking, no consent
// records, identical responses. With the flag ON:
//   - registration requires an affirmative Terms acceptance (unchecked
//     by default, the owner's exact acknowledgement text, server-side
//     enforced — missing, forged, or stale-version acceptance rejected);
//   - a SEPARATE billing authorization is required before a trial,
//     subscription, or checkout can start (the Terms checkbox never
//     substitutes for it);
//   - promotional email/SMS opt-ins are separate, unchecked by default,
//     and recorded only when affirmatively checked (absence = no
//     consent, never inferred);
//   - every acceptance is an append-only record in the consentRecords
//     collection: platform, account id, kind, the policy versions
//     accepted, timestamp, IP, user-agent, source, and context.
//   - accounts whose recorded Terms version is older than the current
//     registry version are flagged needsReacceptance and (except the
//     founder/owner, who is prompted but NEVER blocked — the network's
//     never-lockout rule) must re-accept before using gated features.
//
// POLICY_VERSIONS lives here — the single config point per platform.
// Advancing a version = editing VERSION_DEFAULTS (or the CONSENT_*_VERSION
// env overrides used by tests/deployments); effectiveStatus stays 'draft'
// until the owner approves final documents (legal-drafts/ in the Prime
// reports tree carries the drafts + the approval checklist).

// ================= CONFIG (the only per-platform block) =================
const PLATFORM_ID = 'meta-free';
const PLATFORM_SCHEDULE = {
  name: 'Awaken Affordable Meta',
  productDescription: 'Awaken Affordable Meta — a social-media workspace: a public link page, a post planner, an inbox, analytics, a competitor watchlist, team settings, and an assistant. It prepares content you publish yourself; it does not post into Meta\u2019s apps. Awaken Affordable Meta is an independent product of Awaken With Amber LLC and is not affiliated with Meta Platforms, Inc.',
  dataPractices: [
    'Workspace profile content: your brand name, tagline, public links, and link click counts.',
    'Planned and scheduled posts and their content, and inbox messages recorded in your workspace.',
    'Metrics you import or enter, and competitor/watchlist entries you add.',
    'Settings and connection records, trial and waitlist records (including waitlist reference codes), and an activity log.',
  ],
  hasBilling: true,
  pricingNote: 'Paid founding tiers: Essential $7.50/month, Advanced $25.00/month, Expert $74.50/month, Max $249.50/month; the Free tier is $0 forever. Billing is not live yet: trials are pre-launch records and no charge is made until billing activates (see the trial notice in the product). Annual prices are not offered until approved.',
};
// =======================================================================

const VERSION_DEFAULTS = { terms: 'draft-1', privacy: 'draft-1', billing: 'draft-1' };
const EFFECTIVE_STATUS = 'draft'; // 'draft' until owner approval + legal review — never claim otherwise

const COLLECTION = 'consentRecords';
const KINDS = ['terms', 'billing', 'promo-email', 'promo-sms'];

// The canonical policy registry for the whole network (AwakenConnect):
// one system, one version line, registered per platform. AwakenFlow's
// /api/connect/consent/status serves this registry plus live counts for
// itself; the other platforms expose the same summary shape at their own
// /api/consent/summary (owner-gated) — live federation is staged until
// the platforms can call each other (see the status route's honesty note).
const NETWORK_PLATFORMS = [
  { id: 'awakenflow', name: 'AwakenFlow', summaryPath: '/api/consent/summary' },
  { id: 'meta-free', name: 'Awaken Affordable Meta', summaryPath: '/api/consent/summary' },
  { id: 'awaken-social', name: 'Awaken Social', summaryPath: '/api/consent/summary' },
];

// The owner's exact acknowledgement text (directive 2026-11-07 §2). The
// two document names inside it render as links to /legal/terms and
// /legal/privacy wherever the checkbox is shown.
const TERMS_CHECKBOX_TEXT = 'I have read and agree to the Terms of Service and User Agreement, and acknowledge the Privacy Policy.';
const PROMO_EMAIL_TEXT = 'Email me occasional news, offers, and updates from Awaken With Amber LLC. (Optional — leave unticked if you prefer not to receive them.)';
const PROMO_SMS_TEXT = 'Text me occasional news and offers by SMS. Message and data rates may apply; reply STOP to end. (Optional — leave unticked if you prefer not to receive them.)';

const TERMS_REQUIRED_ERROR = 'Before your account can be created, please tick the box that says you have read and agree to the Terms of Service and User Agreement, and acknowledge the Privacy Policy. The box starts unticked on purpose — account creation stays off until you tick it.';
const STALE_VERSION_ERROR = 'The Terms of Service or Privacy Policy changed since this page was loaded, so that acceptance cannot be used. Please reload the page, read the current documents, and tick the box again.';
const BILLING_REQUIRED_ERROR = 'Before this can start, please tick the separate billing authorization box below — it is what allows the recurring subscription charge after the free trial. (Ticking the Terms box when you registered does not cover billing.)';
const BILLING_STALE_ERROR = 'The billing authorization text changed since this page was loaded. Please reload the page, read the current authorization, and tick the box again.';
const REACCEPTANCE_ERROR = 'Our Terms of Service and Privacy Policy were updated. Please review and accept the current versions to continue — it takes one tick of a box.';

// ---------- flag + versions --------------------------------------------
function enforcementOn(env = process.env) {
  return String((env && env.CONSENT_ENFORCEMENT) || '').toLowerCase() === 'on';
}

function currentVersions(env = process.env) {
  return {
    termsVersion: (env && env.CONSENT_TERMS_VERSION) || VERSION_DEFAULTS.terms,
    privacyVersion: (env && env.CONSENT_PRIVACY_VERSION) || VERSION_DEFAULTS.privacy,
    billingVersion: (env && env.CONSENT_BILLING_VERSION) || VERSION_DEFAULTS.billing,
    effectiveStatus: EFFECTIVE_STATUS,
  };
}

// ---------- request metadata ---------------------------------------------
function clientIp(req) {
  if (!req) return null;
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim().slice(0, 64) || null;
  return (req.socket && req.socket.remoteAddress) ? String(req.socket.remoteAddress).slice(0, 64) : null;
}
function userAgentOf(req) {
  const ua = req && req.headers && req.headers['user-agent'];
  return ua ? String(ua).slice(0, 300) : null;
}

// ---------- acceptance parsing -------------------------------------------
// An affirmative acceptance is an explicit true-ish value from a checkbox
// ('true'/'on' from forms, boolean true from JSON clients). Anything else
// — missing, false, arbitrary strings — is not acceptance.
function acceptedValue(v) {
  return v === true || v === 1 || v === 'true' || v === 'on';
}
// Pull {accepted, termsVersion, privacyVersion} / billing equivalents out
// of either a nested object (body.termsConsent / body.billingConsent) or
// flat fields (termsAccepted / billingConsentAccepted + version fields,
// including urlencoded form posts).
function acceptanceFrom(body, kind) {
  const b = body || {};
  if (kind === 'terms') {
    const nested = (b.termsConsent && typeof b.termsConsent === 'object') ? b.termsConsent : {};
    return {
      accepted: acceptedValue(nested.accepted !== undefined ? nested.accepted : b.termsAccepted),
      termsVersion: nested.termsVersion || b.termsVersion || null,
      privacyVersion: nested.privacyVersion || b.privacyVersion || null,
    };
  }
  const nested = (b.billingConsent && typeof b.billingConsent === 'object') ? b.billingConsent : {};
  return {
    accepted: acceptedValue(nested.accepted !== undefined ? nested.accepted : (b.billingConsentAccepted !== undefined ? b.billingConsentAccepted : b.billingAccepted)),
    billingVersion: nested.billingVersion || b.billingVersion || null,
  };
}

// Validate a Terms acceptance against the CURRENT registry versions.
// Returns { ok: true, versions } or { ok: false, error } with a
// plain-language, visible-notices-style message.
function validateTermsAcceptance(body, env = process.env) {
  const a = acceptanceFrom(body, 'terms');
  if (!a.accepted) return { ok: false, error: TERMS_REQUIRED_ERROR };
  const v = currentVersions(env);
  if (a.termsVersion !== v.termsVersion || a.privacyVersion !== v.privacyVersion) {
    return { ok: false, error: STALE_VERSION_ERROR };
  }
  return { ok: true, versions: v };
}

function validateBillingAcceptance(body, env = process.env) {
  const a = acceptanceFrom(body, 'billing');
  if (!a.accepted) return { ok: false, error: BILLING_REQUIRED_ERROR };
  const v = currentVersions(env);
  if (a.billingVersion !== v.billingVersion) return { ok: false, error: BILLING_STALE_ERROR };
  return { ok: true, versions: v };
}

// The billing authorization sentence, with plan specifics filled from the
// pricing config by the caller (never hand-typed at a call site).
function billingConsentText({ planName, priceText, firstChargeText }) {
  return `I authorize Awaken With Amber LLC to charge my payment method ${priceText}/month for the ${planName} subscription. My 30-day free trial starts today and no payment is taken today. If I do not cancel during the trial, the first charge of ${priceText} is scheduled for ${firstChargeText} at about 2:00 AM Mountain Time (America/Denver), and my payment method will be charged ${priceText} each month after that until I cancel. I understand I can cancel any time during the trial and I will not be charged, that canceling stops future charges, and that refunds follow the Terms of Service.`;
}

// ---------- records (append-only) -----------------------------------------
function recordConsent(store, { accountId, kind, versions, ip = null, userAgent = null, source = null, context = null, env = process.env } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown consent kind: ${kind}`);
  const v = versions || currentVersions(env);
  return store.insert(COLLECTION, {
    platform: PLATFORM_ID,
    accountId: accountId || null,
    kind,
    termsVersion: v.termsVersion,
    privacyVersion: v.privacyVersion,
    billingVersion: v.billingVersion,
    effectiveStatus: v.effectiveStatus || EFFECTIVE_STATUS,
    acceptedAt: new Date().toISOString(),
    ip: ip || null,
    userAgent: userAgent || null,
    source: source || null,
    context: context || null,
    enforcement: 'on',
  });
}

function recordsFor(store, accountId) {
  return store.all(COLLECTION, r => r.accountId === accountId)
    .slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
function latestTermsRecord(store, accountId) {
  const rows = store.all(COLLECTION, r => r.accountId === accountId && r.kind === 'terms')
    .slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows[0] || null;
}
function hasBillingConsent(store, accountId) {
  return !!store.find(COLLECTION, r => r.accountId === accountId && r.kind === 'billing');
}

// Is the account's latest Terms acceptance at the CURRENT versions?
function acceptanceValid(store, accountId, env = process.env) {
  const rec = latestTermsRecord(store, accountId);
  if (!rec) return false;
  const v = currentVersions(env);
  return rec.termsVersion === v.termsVersion && rec.privacyVersion === v.privacyVersion;
}
// Reacceptance applies only while enforcement is on: an account with no
// record (created before activation) or an older-version record must
// re-accept. With the flag off this is always false — nothing changes.
function needsReacceptance(store, accountId, env = process.env) {
  if (!enforcementOn(env)) return false;
  return !acceptanceValid(store, accountId, env);
}

// The consent block for registration: the Terms record (the caller has
// already validated the acceptance) + promo opt-ins recorded ONLY when
// affirmatively checked. Absence of a promo record = no consent.
function recordRegistrationConsents(store, req, user, body, { source = 'registration', env = process.env } = {}) {
  const meta = { accountId: user.id, ip: clientIp(req), userAgent: userAgentOf(req), env };
  const terms = recordConsent(store, { ...meta, kind: 'terms', source });
  const written = [terms];
  if (acceptedValue(body && (body.promoEmail !== undefined ? body.promoEmail : (body.promo && body.promo.email)))) {
    written.push(recordConsent(store, { ...meta, kind: 'promo-email', source }));
  }
  if (acceptedValue(body && (body.promoSms !== undefined ? body.promoSms : (body.promo && body.promo.sms)))) {
    written.push(recordConsent(store, { ...meta, kind: 'promo-sms', source }));
  }
  return written;
}

// The status object responses carry while enforcement is on (login, /me,
// register). founderExempt tells the client the account is prompted but
// never blocked (founder/owner) — the server enforces that distinction.
function statusFor(store, user, { founderExempt = false, env = process.env } = {}) {
  if (!enforcementOn(env)) return null;
  return {
    enforcement: true,
    needsReacceptance: needsReacceptance(store, user.id, env),
    versions: currentVersions(env),
    founderExempt: !!founderExempt,
  };
}

// ---------- views ----------------------------------------------------------
// Public policy info for clients: drives the checkbox UI. Carries the
// versions the client must echo back (a mismatch = stale page = reject).
function policyView(env = process.env) {
  return {
    platform: PLATFORM_ID,
    enforcement: enforcementOn(env),
    versions: currentVersions(env),
    termsCheckboxText: TERMS_CHECKBOX_TEXT,
    promoEmailText: PROMO_EMAIL_TEXT,
    promoSmsText: PROMO_SMS_TEXT,
    legalLinks: { terms: '/legal/terms', privacy: '/legal/privacy' },
  };
}

function countsByKind(store) {
  const counts = Object.fromEntries(KINDS.map(k => [k, 0]));
  for (const r of store.all(COLLECTION)) if (counts[r.kind] !== undefined) counts[r.kind]++;
  return counts;
}

// The per-platform summary shape (owner-gated GET /api/consent/summary on
// every platform — AwakenConnect's registry consumes this shape).
function summaryView(store, env = process.env) {
  const counts = countsByKind(store);
  return {
    platform: PLATFORM_ID,
    versions: currentVersions(env),
    enforcement: enforcementOn(env),
    counts,
    recordsTotal: Object.values(counts).reduce((a, b) => a + b, 0),
    summaryPath: '/api/consent/summary',
  };
}

// AwakenConnect registry view (served by AwakenFlow at
// GET /api/connect/consent/status). HONESTY: AwakenFlow's own row is LIVE
// from its database. The other platforms' rows carry the canonical
// registry versions and their summary endpoint, with live counts marked
// STAGED — this process cannot read their databases, and federation
// (platforms calling each other's summary endpoints) is not built yet.
function networkStatusView(store, env = process.env) {
  const v = currentVersions(env);
  const own = summaryView(store, env);
  return {
    service: 'AwakenConnect — terms acceptance registry',
    canonicalVersions: v,
    effectiveStatus: EFFECTIVE_STATUS,
    activationNote: 'Agreements are DRAFT and enforcement defaults OFF on every platform until the owner approves the final documents and legal review is complete.',
    federation: 'staged — per-platform summaries exist at each platform\u2019s /api/consent/summary (owner-gated); live cross-platform polling is not built, so only the awakenflow row below is live.',
    platforms: NETWORK_PLATFORMS.map(p => p.id === PLATFORM_ID
      ? { ...p, live: true, versions: own.versions, enforcement: own.enforcement, counts: own.counts, recordsTotal: own.recordsTotal }
      : { ...p, live: false, basis: 'STAGED — canonical registry versions; counts available from that platform\u2019s owner-gated summary endpoint', versions: v, enforcement: null, counts: null }),
  };
}

module.exports = {
  PLATFORM_ID, PLATFORM_SCHEDULE, VERSION_DEFAULTS, EFFECTIVE_STATUS,
  COLLECTION, KINDS, NETWORK_PLATFORMS,
  TERMS_CHECKBOX_TEXT, PROMO_EMAIL_TEXT, PROMO_SMS_TEXT,
  TERMS_REQUIRED_ERROR, STALE_VERSION_ERROR, BILLING_REQUIRED_ERROR, BILLING_STALE_ERROR, REACCEPTANCE_ERROR,
  enforcementOn, currentVersions, clientIp, userAgentOf,
  acceptedValue, acceptanceFrom, validateTermsAcceptance, validateBillingAcceptance, billingConsentText,
  recordConsent, recordsFor, latestTermsRecord, hasBillingConsent,
  acceptanceValid, needsReacceptance, recordRegistrationConsents, statusFor,
  policyView, countsByKind, summaryView, networkStatusView,
};
