'use strict';
// Awaken Meta PKG-6 — Campaign Command Center core (design §2).
//
// The marketing campaign layer inside Awaken Affordable Meta. It
// implements the AwakenAds preparation report's machinery
// (AWAKENADS-PREPARATION-2026-11-07) as records, gates, and an audit
// trail — drafts and approvals only:
//
// - Campaigns are workspace-scoped records in the `campaigns`
//   collection (declared in PKG-1, inert until this package). A
//   campaign can only be created in one of the PKG-2 brand
//   workspaces (a workspace row carrying a brandId).
// - Lifecycle `status` (draft → in_review → approved → active →
//   paused → completed → archived) is deliberately separate from the
//   `approval` state, exactly as posts separate the two in this
//   codebase. Approval moves reuse lib/approvals.js unchanged — the
//   same states, the same transition table, the same owner/editor
//   role rule — through the campaignApprovals wrapper below.
// - The evidence check (AwakenAds pipeline step 2) is a hard gate:
//   a campaign cannot be submitted for review until its evidence
//   check is complete (audience defined, content drafted,
//   measurement plan set, claims verified — with a checker and a
//   timestamp). Approval itself is per campaign; there is no
//   bulk-approve path anywhere in this module or its routes.
// - Money: the budget cap defaults to $0. A positive cap can only be
//   recorded when the OWNER sets it explicitly (owner role + an
//   explicit owner-set flag on the call). Even then, THIS package
//   contains no spend path and no paid activation: activating a
//   campaign with a positive cap is refused outright, and activation
//   itself is a bookkeeping state only — it creates nothing in any
//   platform, publishes nothing, and spends nothing. (Paid placement
//   belongs to the gated AwakenAds step 4, a later package.)
// - Activation also checks the connections registry: a channel that
//   maps to a platform whose registry row says browser_only /
//   action_needed / not_started cannot be marked active, and the
//   refusal quotes the registry's own note (design §2.2).
// - Content rules (owner canon, enforced in validation):
//   * No remedy/treatment/cure/healing claim wording in any text
//     field — rejected with a plain-language error.
//   * Organic campaigns carry Amber's genuine, non-sales voice by
//     default (`voice: 'genuine'`): hard-sell pitch wording is
//     rejected. Campaign-plan drafts imported from the owner's own
//     approved-preparation documents carry `voice: 'campaign-plan'`
//     and are stored verbatim (design §2.6 step 1); the claim scan
//     and the exclusion scan apply to every campaign regardless.
//   * The permanently secret project and the separate professional
//     lane can never be a campaign brand or subject: every text
//     field is swept with the PKG-2 forbidden-term scan
//     (lib/brands scanForForbidden — one shared list) and refused.
// - Every create, update, evidence update, and transition writes an
//   activity/audit entry (design §2.2 event names: campaign.created,
//   campaign.submitted, campaign.approved, campaign.activated,
//   campaign.paused; other changes log campaign.updated with the
//   change named in the detail).
const approvals = require('./approvals');
const { scanForForbidden } = require('./brands');
const { logActivity } = require('./activity');

// ---------- lifecycle ----------
const LIFECYCLE = ['draft', 'in_review', 'approved', 'active', 'paused', 'completed', 'archived'];
// Direct status moves. Moves into in_review / approved are NOT here:
// they happen only through the approval pipeline (transitionApproval),
// which keeps lifecycle and approval in sync. Activation ('active')
// additionally passes the activation gates in transitionStatus.
const LIFECYCLE_TRANSITIONS = {
  draft: ['archived'],
  in_review: ['archived'],
  approved: ['active', 'archived'],
  active: ['paused', 'completed', 'archived'],
  paused: ['active', 'completed', 'archived'],
  completed: ['archived'],
  archived: [],
};

// ---------- evidence check ----------
// The design §2.1 evidenceCheck block { checkedAt, checkedBy, notes }
// plus the four required items the gate checks. Complete means: all
// four items true AND a checker AND a timestamp are recorded.
const EVIDENCE_ITEMS = [
  ['audienceDefined', 'audience defined'],
  ['contentDrafted', 'content drafted'],
  ['measurementPlanSet', 'measurement plan set'],
  ['claimsVerified', 'price and feature claims verified'],
];
function emptyEvidence(notes) {
  return {
    checkedAt: null, checkedBy: null, notes: String(notes || ''),
    audienceDefined: false, contentDrafted: false, measurementPlanSet: false, claimsVerified: false,
  };
}
function evidenceOf(campaign) {
  const ec = (campaign && campaign.evidenceCheck) || {};
  return { ...emptyEvidence(), ...ec };
}
function missingEvidence(ec) {
  const e = { ...emptyEvidence(), ...(ec || {}) };
  const missing = EVIDENCE_ITEMS.filter(([k]) => e[k] !== true).map(([, label]) => label);
  if (!e.checkedAt || !e.checkedBy) missing.push('checker and timestamp recorded');
  return missing;
}
function evidenceComplete(ec) { return missingEvidence(ec).length === 0; }

// ---------- the 7 templates (design §2.3) ----------
// Catalog data only. Every template has budgetCapCents: 0 and
// instantiating one creates a DRAFT campaign — nothing about a
// template approves, activates, or spends anything.
const TEMPLATES = [
  {
    templateId: 'product-launch',
    name: 'Product launch',
    objective: 'Launch a product: signups, waitlist joins, or paid orders for the launch, per the product’s own conversion definition.',
    defaultChannels: ['first-party', 'organic-social', 'launch-list'],
    measurementPlan: 'Conversion is defined per product before the campaign runs (signup / waitlist join / paid order — an order counts when paid, never when merely ordered). CTR is clicks ÷ impressions per placement, never blended across platforms.',
    evidenceChecklist: [
      'Every price and feature claim re-verified against the shipped build and the approved price cards',
      'Audience defined (a segment or persona is attached)',
      'Campaign copy drafted in full',
      'Measurement plan set, with the per-product conversion definition named',
      'Landing page checked live',
    ],
    budgetCapCents: 0,
  },
  {
    templateId: 'subscriber-acquisition',
    name: 'Subscriber acquisition',
    objective: 'Grow newsletter or membership subscribers through first-party surfaces, organic social, and referrals.',
    defaultChannels: ['first-party', 'organic-social', 'referral'],
    measurementPlan: 'Conversion = a confirmed subscription record. Referral arrivals are attributed with the network UTM convention and AwakenFlow ?ref= codes where the landing supports them.',
    evidenceChecklist: [
      'Every price and feature claim re-verified against the shipped build and the approved price cards',
      'Audience defined (a segment or persona is attached)',
      'Campaign copy drafted in full',
      'Measurement plan set (conversion = confirmed subscription record)',
      'Landing page and signup flow checked live',
    ],
    budgetCapCents: 0,
  },
  {
    templateId: 'seasonal-promotion',
    name: 'Seasonal promotion',
    objective: 'A time-boxed seasonal flight (Wheel-of-the-Year pattern): one season, one offer window, then it ends.',
    defaultChannels: ['first-party', 'organic-social'],
    measurementPlan: 'Judged inside the flight window only: MEASURED reach, module CTR per placement, and the campaign’s own conversion definition. A flight is never extended into always-on without data.',
    evidenceChecklist: [
      'Flight dates set — this template is time-boxed, never always-on without data',
      'Every price and feature claim re-verified against the shipped build and the approved price cards',
      'Audience defined (a segment or persona is attached)',
      'Campaign copy drafted in full',
      'Measurement plan set for the flight window',
    ],
    requiresFlightDates: true,
    budgetCapCents: 0,
  },
  {
    templateId: 'brand-awareness',
    name: 'Brand awareness',
    objective: 'Reach and recognition for the brand itself — being seen and remembered, honestly measured.',
    defaultChannels: ['first-party', 'organic-social'],
    measurementPlan: 'Judged on MEASURED reach and first-party module CTR only. No conversion is promised or reported for this template.',
    evidenceChecklist: [
      'Audience defined (a segment or persona is attached)',
      'Campaign copy drafted in full',
      'Measurement plan set (reach + module CTR only — no conversion promise)',
      'Every claim in the copy checked — awareness copy still makes no unverified claim',
    ],
    budgetCapCents: 0,
  },
  {
    templateId: 'lead-generation',
    name: 'Lead generation',
    objective: 'Capture consented leads: quiz leads, consultation requests, or launch-list joins.',
    defaultChannels: ['first-party', 'organic-social'],
    measurementPlan: 'Conversion = a captured, consented lead record in the intake that owns it (quiz-lead / newsletter / consultation). Cost per lead is only ever computed from labeled spend and labeled conversions.',
    evidenceChecklist: [
      'The capture intake (quiz / newsletter / consultation form) checked live',
      'Audience defined (a segment or persona is attached)',
      'Campaign copy drafted in full',
      'Measurement plan set (conversion = consented lead record)',
      'Every price and feature claim re-verified against the shipped build and the approved price cards',
    ],
    budgetCapCents: 0,
  },
  {
    templateId: 'customer-retention',
    name: 'Customer retention',
    objective: 'Keep existing customers and members close: news, care, and reasons to stay.',
    defaultChannels: ['first-party', 'in-app'],
    measurementPlan: 'Judged on recorded retention signals only: repeat orders (RECORDED), subscription renewals, and in-app engagement where a feed measures it. Anything without a feed renders UNAVAILABLE.',
    evidenceChecklist: [
      'Audience defined (existing customers/members segment attached)',
      'Campaign copy drafted in full',
      'Measurement plan set from recorded signals only',
      'Channel reality acknowledged: no email until the sending provider is connected (owner hand-step H1)',
    ],
    templateNote: 'The email channel does not exist yet — no sending provider is connected (owner hand-step H1). Until then this template runs in-app and first-party only, and says so.',
    budgetCapCents: 0,
  },
  {
    templateId: 'community-growth',
    name: 'Community growth',
    objective: 'Grow the community: Awaken Social registrations and group joins, in free framing.',
    defaultChannels: ['first-party', 'organic-social'],
    measurementPlan: 'Conversion = a completed free registration or a group join, recorded by Awaken Social. Judged on registrations and weekly active posters where measurable.',
    evidenceChecklist: [
      'Copy carries no prices — free framing only for this template',
      'Audience defined (a segment or persona is attached)',
      'Campaign copy drafted in full',
      'Measurement plan set (conversion = free registration or group join)',
    ],
    budgetCapCents: 0,
  },
];
function templateById(templateId) { return TEMPLATES.find(t => t.templateId === templateId) || null; }

// ---------- content rules ----------
const CLAIM_PATTERNS = [
  /\bremed(y|ies)\b/i,
  // cure/cures/cured — but NOT "curing": in this brand's vocabulary
  // curing is a soap-making process ("the soaps are curing on the
  // shelf"), not a health claim. The evidence check (pipeline step 2)
  // is the backstop for claim-shaped uses of the word.
  /\bcur(e|es|ed)\b/i,
  /\bheal(s|ed|ing)?\b/i,
  /\btreat(s|ed|ing|ment|ments)?\b/i,
  /\bdiagnos(e|es|ed|is|tic)\b/i,
  /\breliev(e|es|ed|ing)\b/i,
];
const CLAIM_ERROR = 'Campaign copy can’t describe a product or service as a remedy or treatment, or claim that it cures, heals, diagnoses, or relieves a condition. Please reword it to say what the product is, not what it treats.';
const HARD_SELL_PHRASES = ['buy now', 'shop now', 'act now', 'order now', 'limited time', 'sale ends', 'while supplies last', "don't miss out", 'offer ends', 'hurry'];
const EXCLUDED_ERROR = 'This campaign names a brand or subject that is permanently excluded from this system, so it can’t be created here.';

function copyTexts(copy) {
  if (!copy || typeof copy !== 'object') return [];
  const out = [];
  for (const k of ['headlines', 'descriptions', 'socialVariants']) {
    if (Array.isArray(copy[k])) for (const s of copy[k]) out.push(String(s));
  }
  if (copy.adCopy && typeof copy.adCopy === 'object') {
    for (const k of ['headline', 'primaryText', 'cta']) if (copy.adCopy[k]) out.push(String(copy.adCopy[k]));
  }
  return out;
}
// All of a campaign's scannable text, from a raw input or a stored row.
function campaignTexts(src) {
  if (!src || typeof src !== 'object') return [];
  const texts = [src.name, src.objective, src.audience, src.notes, src.measurementPlan, src.landingUrl, src.templateNote]
    .filter(v => v != null).map(String);
  if (Array.isArray(src.channels)) texts.push(...src.channels.map(String));
  return texts.concat(copyTexts(src.copy));
}
function scanCampaignText(src, voice) {
  const errors = [];
  const texts = campaignTexts(src);
  const joined = texts.join('\n');
  if (scanForForbidden(joined).length) errors.push(EXCLUDED_ERROR);
  if (CLAIM_PATTERNS.some(re => texts.some(t => re.test(t)))) errors.push(CLAIM_ERROR);
  if (voice === 'genuine') {
    const lower = joined.toLowerCase();
    const hit = HARD_SELL_PHRASES.find(ph => lower.includes(ph));
    if (hit) errors.push(`Organic campaigns use Amber’s genuine, non-sales voice — the wording “${hit}” reads like a sales pitch. Please reword it as sharing what you’re creating.`);
  }
  return errors;
}

// ---------- validation / normalization ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function fail(status, errors) { return { ok: false, status, errors: Array.isArray(errors) ? errors : [errors] }; }
function str(v, max) { return v == null ? '' : String(v).slice(0, max); }
function stringList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x).slice(0, maxLen)).filter(Boolean).slice(0, maxItems);
}

// The budget-cap rule, shared by create and update. Returns an error
// string or null. A positive cap needs BOTH the owner role and the
// explicit owner-set flag on this call — anything else is refused
// and the cap stays $0.
function capError(value, actor, input) {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) return 'Budget cap must be a whole number of cents, $0 or more.';
  if (value > 0 && !(actor && actor.role === 'owner' && input && input.ownerSetCap === true)) {
    return 'A budget cap above $0 can only be set by the owner, explicitly, as an owner-set cap. Until then every campaign cap stays $0 — and no campaign in this system spends anything.';
  }
  return null;
}

function normalizeInput(store, ws, input, actor, existing) {
  const errors = [];
  const base = existing || {};
  const merged = { ...base, ...(input || {}) };
  const voice = ['genuine', 'campaign-plan'].includes(merged.voice) ? merged.voice : 'genuine';

  if (!existing && !str(merged.name, 120).trim()) errors.push('A campaign needs a name.');
  if (merged.template != null && merged.template !== '' && !templateById(String(merged.template))) {
    errors.push(`Unknown campaign template: ${merged.template}.`);
  }
  const capE = capError(input && input.budgetCapCents, actor, input);
  if (capE) errors.push(capE);
  for (const f of ['startsOn', 'endsOn']) {
    if (merged[f] != null && merged[f] !== '' && !DATE_RE.test(String(merged[f]))) errors.push(`${f} must be a date like 2026-12-01.`);
  }
  if (merged.startsOn && merged.endsOn && String(merged.endsOn) < String(merged.startsOn)) {
    errors.push('The end date can’t be before the start date.');
  }
  for (const [field, coll] of [['segmentIds', 'segments'], ['personaIds', 'personas']]) {
    if (merged[field] !== undefined) {
      if (!Array.isArray(merged[field])) { errors.push(`${field} must be a list.`); continue; }
      for (const id of merged[field]) {
        if (!store.find(coll, r => r.id === id && r.workspaceId === ws.id)) {
          errors.push(`A ${coll === 'segments' ? 'segment' : 'persona'} named in ${field} doesn’t exist in this workspace.`);
        }
      }
    }
  }
  errors.push(...scanCampaignText(merged, voice));
  if (errors.length) return { ok: false, errors };

  const now = new Date().toISOString();
  const value = {
    name: str(merged.name, 120),
    template: merged.template ? String(merged.template) : null,
    objective: str(merged.objective, 1000),
    audience: str(merged.audience, 500),
    voice,
    budgetCapCents: merged.budgetCapCents === undefined ? 0 : merged.budgetCapCents,
    channels: stringList(merged.channels, 10, 40),
    landingUrl: merged.landingUrl ? str(merged.landingUrl, 500) : null,
    utmCampaign: merged.utmCampaign ? str(merged.utmCampaign, 80) : `${ws.brandId}-${slugify(merged.name)}`,
    refCode: merged.refCode ? str(merged.refCode, 40) : null,
    startsOn: merged.startsOn ? String(merged.startsOn) : null,
    endsOn: merged.endsOn ? String(merged.endsOn) : null,
    segmentIds: Array.isArray(merged.segmentIds) ? [...merged.segmentIds] : [],
    personaIds: Array.isArray(merged.personaIds) ? [...merged.personaIds] : [],
    measurementPlan: str(merged.measurementPlan, 1000),
    evidenceChecklist: stringList(merged.evidenceChecklist, 12, 300),
    templateNote: merged.templateNote ? str(merged.templateNote, 500) : null,
    copy: normalizeCopy(merged.copy),
    notes: str(merged.notes, 2000),
    sourceRef: merged.sourceRef ? str(merged.sourceRef, 200) : null,
    updatedAt: now,
  };
  return { ok: true, value };
}
function slugify(name) {
  return String(name || 'campaign').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'campaign';
}
function normalizeCopy(copy) {
  if (!copy || typeof copy !== 'object') return { headlines: [], descriptions: [], socialVariants: [] };
  const out = {
    headlines: stringList(copy.headlines, 20, 300),
    descriptions: stringList(copy.descriptions, 20, 1000),
    socialVariants: stringList(copy.socialVariants, 20, 1000),
  };
  if (copy.adCopy && typeof copy.adCopy === 'object') {
    out.adCopy = {
      headline: str(copy.adCopy.headline, 300),
      primaryText: str(copy.adCopy.primaryText, 1000),
      cta: str(copy.adCopy.cta, 80),
    };
  }
  return out;
}

function requireBrandWorkspace(ws) {
  if (!ws) return 'Workspace not found.';
  if (!ws.brandId) return 'Campaigns live in the Awaken Meta brand workspaces. This workspace isn’t one of them, so campaigns can’t be created here.';
  return null;
}
function findCampaign(store, ws, id) {
  return store.find('campaigns', c => c.id === id && c.workspaceId === ws.id) || null;
}

// ---------- create / instantiate / import path ----------
function createCampaign(store, ws, input, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const v = normalizeInput(store, ws, input || {}, actor, null);
  if (!v.ok) return fail(400, v.errors);
  const campaign = store.insert('campaigns', {
    workspaceId: ws.id,
    brandId: ws.brandId,
    ...v.value,
    status: 'draft',
    approval: 'draft',
    // A new campaign's evidence check always starts incomplete. An
    // import may carry explanatory notes, but the four items, the
    // checker, and the timestamp can only ever be recorded through
    // setEvidence — never pre-filled at creation.
    evidenceCheck: emptyEvidence(input && input.evidenceCheck ? input.evidenceCheck.notes : ''),
    activationBlocked: false,
    measurementFailed: false,
    createdBy: actor && actor.email ? actor.email : 'system',
  });
  logActivity(store, ws.id, campaign.createdBy, 'campaign.created',
    `${campaign.name}${input && input.createdVia ? ' · via ' + input.createdVia : ''}${campaign.template ? ' · template ' + campaign.template : ''}`);
  return { ok: true, status: 201, campaign };
}

function instantiateTemplate(store, ws, templateId, overrides, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const t = templateById(String(templateId || ''));
  if (!t) return fail(400, `Unknown campaign template: ${templateId}.`);
  const o = overrides || {};
  if (t.requiresFlightDates && (!o.startsOn || !o.endsOn)) {
    return fail(400, `${t.name} campaigns are time-boxed flights: set both a start date (startsOn) and an end date (endsOn).`);
  }
  const merged = {
    name: o.name || `${t.name} campaign`,
    objective: o.objective || t.objective,
    channels: Array.isArray(o.channels) && o.channels.length ? o.channels : [...t.defaultChannels],
    measurementPlan: o.measurementPlan || t.measurementPlan,
    evidenceChecklist: [...t.evidenceChecklist],
    templateNote: t.templateNote || null,
    budgetCapCents: 0,
    ...o,
    template: t.templateId,
  };
  delete merged.templateId;
  const v = normalizeInput(store, ws, merged, actor, null);
  if (!v.ok) return fail(400, v.errors);
  const campaign = store.insert('campaigns', {
    workspaceId: ws.id,
    brandId: ws.brandId,
    ...v.value,
    status: 'draft',
    approval: 'draft',
    evidenceCheck: emptyEvidence(),
    activationBlocked: false,
    measurementFailed: false,
    createdBy: actor && actor.email ? actor.email : 'system',
  });
  logActivity(store, ws.id, campaign.createdBy, 'campaign.created', `${campaign.name} · from template ${t.templateId}`);
  return { ok: true, status: 201, campaign };
}

// ---------- update / evidence ----------
const UPDATABLE = ['name', 'objective', 'audience', 'voice', 'budgetCapCents', 'channels', 'landingUrl', 'utmCampaign', 'refCode', 'startsOn', 'endsOn', 'segmentIds', 'personaIds', 'measurementPlan', 'copy', 'notes'];
function updateCampaign(store, ws, id, patch, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const c = findCampaign(store, ws, id);
  if (!c) return fail(404, 'Campaign not found.');
  const p = patch || {};
  if (p.status !== undefined || p.approval !== undefined) {
    return fail(400, 'Status and approval don’t change by editing fields — they move through the campaign approval pipeline.');
  }
  if (p.evidenceCheck !== undefined) {
    return fail(400, 'The evidence check is recorded through the evidence step, not by editing fields.');
  }
  const input = {};
  for (const k of UPDATABLE) if (p[k] !== undefined) input[k] = p[k];
  if (p.ownerSetCap !== undefined) input.ownerSetCap = p.ownerSetCap;
  if (!Object.keys(input).filter(k => k !== 'ownerSetCap').length) return { ok: true, status: 200, campaign: c };
  const v = normalizeInput(store, ws, input, actor, c);
  if (!v.ok) return fail(400, v.errors);
  const updated = store.update('campaigns', c.id, v.value);
  // PKG-7: a campaign with a segment or persona linked has its
  // audience defined by that record — linking satisfies the
  // "audience defined" evidence item (the same rule setEvidence
  // applies). The checker/timestamp stamp follows setEvidence's
  // rule: it is only applied once all four items are true.
  let result = updated;
  if ((updated.segmentIds || []).length || (updated.personaIds || []).length) {
    const ev = evidenceOf(updated);
    if (!ev.audienceDefined) {
      ev.audienceDefined = true;
      if (EVIDENCE_ITEMS.every(([k]) => ev[k] === true)) {
        ev.checkedAt = ev.checkedAt || new Date().toISOString();
        ev.checkedBy = actor && actor.email ? actor.email : ev.checkedBy;
      }
      result = store.update('campaigns', c.id, { evidenceCheck: ev, updatedAt: new Date().toISOString() });
    }
  }
  logActivity(store, ws.id, actor && actor.email, 'campaign.updated',
    `${c.name} · ${Object.keys(input).filter(k => k !== 'ownerSetCap').join(', ')}`);
  return { ok: true, status: 200, campaign: result };
}

function setEvidence(store, ws, id, evidence, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const c = findCampaign(store, ws, id);
  if (!c) return fail(404, 'Campaign not found.');
  const e = evidenceOf(c);
  const incoming = evidence || {};
  for (const [k] of EVIDENCE_ITEMS) if (incoming[k] !== undefined) e[k] = incoming[k] === true;
  if (incoming.notes !== undefined) e.notes = str(incoming.notes, 2000);
  // PKG-7: a linked segment or persona IS the audience definition —
  // when one is attached to this campaign, the audience-defined
  // item is satisfied by the link and can't be left false by an
  // evidence form that simply didn't mention the audience.
  if ((c.segmentIds || []).length || (c.personaIds || []).length) e.audienceDefined = true;
  // Completeness is judged on the four items; the checker + timestamp
  // are then stamped by this step (they are part of what "complete"
  // means, so they can't be a precondition of their own stamping).
  if (EVIDENCE_ITEMS.every(([k]) => e[k] === true)) {
    e.checkedAt = e.checkedAt || new Date().toISOString();
    e.checkedBy = actor && actor.email ? actor.email : e.checkedBy;
  } else {
    e.checkedAt = null;
    e.checkedBy = null;
  }
  const updated = store.update('campaigns', c.id, { evidenceCheck: e, updatedAt: new Date().toISOString() });
  logActivity(store, ws.id, actor && actor.email, 'campaign.updated',
    `${c.name} · evidence check ${evidenceComplete(e) ? 'completed' : 'updated (still incomplete: ' + missingEvidence(e).join(', ') + ')'}`);
  return { ok: true, status: 200, campaign: updated };
}
// ---------- the approval pipeline (campaignApprovals) ----------
// AwakenAds steps 1–3 over lib/approvals.js, unmodified: same states,
// same transition table, same owner/editor role rule as post
// approvals. The one addition is the step-2 evidence gate on the way
// into pending_review. Lifecycle status follows the pipeline so the
// two never disagree.
function transitionApproval(store, ws, id, to, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const c = findCampaign(store, ws, id);
  if (!c) return fail(404, 'Campaign not found.');
  if (!approvals.roleCanApprove(actor && actor.role)) {
    return fail(403, 'Your role cannot change approval state.');
  }
  const from = approvals.approvalOf(c);
  if (['active', 'paused', 'completed', 'archived'].includes(c.status) && to !== from) {
    return fail(400, 'This campaign has moved past the approval stage, so its approval state no longer changes.');
  }
  if (!approvals.canTransition(from, to)) {
    return fail(400, `Approval cannot move from ${from} to ${to}.`);
  }
  if (to === from) return { ok: true, status: 200, campaign: c };
  if (to === 'pending_review') {
    const missing = missingEvidence(c.evidenceCheck);
    if (missing.length) {
      return fail(400, `The evidence check is not complete yet — still missing: ${missing.join(', ')}. A campaign cannot go to review until its evidence check is done.`);
    }
  }
  const patch = { approval: to, updatedAt: new Date().toISOString() };
  if (to === 'pending_review' && c.status === 'draft') patch.status = 'in_review';
  if (to === 'approved' && (c.status === 'in_review' || c.status === 'draft')) patch.status = 'approved';
  if (to === 'draft' && (c.status === 'in_review' || c.status === 'approved')) patch.status = 'draft';
  const updated = store.update('campaigns', c.id, patch);
  if (to === 'pending_review') logActivity(store, ws.id, actor.email, 'campaign.submitted', c.name);
  else if (to === 'approved') logActivity(store, ws.id, actor.email, 'campaign.approved', c.name);
  else logActivity(store, ws.id, actor.email, 'campaign.updated', `${c.name} · approval → draft (sent back)`);
  return { ok: true, status: 200, campaign: updated };
}

// ---------- lifecycle transitions + activation gates ----------
const BLOCKING_CONNECTION_STATES = ['browser_only', 'action_needed', 'not_started'];
const CHANNEL_PLATFORMS = ['facebook', 'instagram', 'threads', 'tiktok', 'youtube', 'linkedin', 'whatsapp', 'messenger'];
function channelPlatform(channel) {
  const s = String(channel || '').toLowerCase();
  return CHANNEL_PLATFORMS.find(p => s === p || s.includes(p)) || null;
}
function activationBlockers(store, ws, c) {
  const blockers = [];
  if (approvals.approvalOf(c) !== 'approved') {
    blockers.push('Only an approved campaign can be activated — this one is not approved yet.');
  }
  if ((c.budgetCapCents || 0) > 0) {
    blockers.push('This campaign has a budget cap above $0. Paid activation does not exist in Awaken Meta — no campaign can spend — so it cannot be activated here.');
  }
  for (const ch of c.channels || []) {
    const platform = channelPlatform(ch);
    if (!platform) continue;
    const row = store.find('connections', x => x.workspaceId === ws.id && x.platform === platform);
    if (row && BLOCKING_CONNECTION_STATES.includes(row.status)) {
      blockers.push(`Channel “${ch}” is not ready: ${platform} is ${row.status} in the connections registry — ${row.note || 'a connection step is still pending.'}`);
    }
  }
  return blockers;
}

function transitionStatus(store, ws, id, to, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const c = findCampaign(store, ws, id);
  if (!c) return fail(404, 'Campaign not found.');
  if (!LIFECYCLE.includes(to)) return fail(400, `Unknown campaign status: ${to}.`);
  const from = LIFECYCLE.includes(c.status) ? c.status : 'draft';
  if (to === from) return { ok: true, status: 200, campaign: c };
  if (to === 'in_review' || to === 'approved') {
    return fail(400, 'Review and approval move through the approval pipeline (submit → approve), not the status field.');
  }
  if (!(LIFECYCLE_TRANSITIONS[from] || []).includes(to)) {
    return fail(400, `A campaign cannot move from ${from} to ${to} from here.`);
  }
  const patch = { status: to, updatedAt: new Date().toISOString() };
  if (to === 'active') {
    const blockers = activationBlockers(store, ws, c);
    if (blockers.length) {
      // A cap or registry block is a durable fact about this campaign
      // (the summary renders it BLOCKED); a not-yet-approved attempt
      // is just sequencing, and stamps nothing.
      if (approvals.approvalOf(c) === 'approved') store.update('campaigns', c.id, { activationBlocked: true, updatedAt: patch.updatedAt });
      return fail(400, blockers);
    }
    patch.activationBlocked = false;
  }
  const updated = store.update('campaigns', c.id, patch);
  if (to === 'active') logActivity(store, ws.id, actor && actor.email, 'campaign.activated', c.name);
  else if (to === 'paused') logActivity(store, ws.id, actor && actor.email, 'campaign.paused', c.name);
  else logActivity(store, ws.id, actor && actor.email, 'campaign.updated', `${c.name} · status ${from} → ${to}`);
  return { ok: true, status: 200, campaign: updated };
}

// ---------- reads ----------
function listCampaigns(store, workspaceId, filters) {
  const f = filters || {};
  return store.all('campaigns', c => c.workspaceId === workspaceId
    && (!f.status || c.status === f.status)
    && (!f.template || c.template === f.template))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
// The campaign calendar view: a read over campaign flight dates.
// A campaign with no dates is always in the window; a dated campaign
// is in it when its [startsOn, endsOn] overlaps [from, to].
function calendarCampaigns(store, workspaceId, from, to) {
  return store.all('campaigns', c => c.workspaceId === workspaceId
    && (!from || !c.endsOn || c.endsOn >= from)
    && (!to || !c.startsOn || c.startsOn <= to))
    .sort((a, b) => String(a.startsOn || '').localeCompare(String(b.startsOn || '')) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

// The network UTM convention (AwakenAds report §4.3), as a builder
// for placement time: utm_campaign is stored on the campaign; source
// is fixed; medium and content vary by placement.
function utmParams(campaign, opts) {
  const o = opts || {};
  const params = new URLSearchParams({
    utm_source: 'awaken-network',
    utm_medium: o.medium || 'module',
    utm_campaign: campaign.utmCampaign || '',
  });
  if (o.content) params.set('utm_content', o.content);
  return params.toString();
}

module.exports = {
  LIFECYCLE, LIFECYCLE_TRANSITIONS,
  EVIDENCE_ITEMS, emptyEvidence, evidenceOf, missingEvidence, evidenceComplete,
  TEMPLATES, templateById,
  CLAIM_PATTERNS, CLAIM_ERROR, HARD_SELL_PHRASES,
  campaignTexts, scanCampaignText,
  findCampaign, createCampaign, instantiateTemplate, updateCampaign, setEvidence,
  transitionApproval, transitionStatus, activationBlockers,
  listCampaigns, calendarCampaigns, utmParams,
};
