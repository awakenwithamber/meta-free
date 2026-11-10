'use strict';
// Awaken Meta PKG-7 — segments, personas, and A/B test records
// (design §2.1 + §2.4–2.5), on top of PKG-6's Campaign Command
// Center. Records and gates only: nothing here publishes, sends,
// spends, or activates anything, and no test concludes itself.
//
// SEGMENTS are named audiences scoped to the PKG-2 brand
// workspaces, defined by criteria over data this platform actually
// holds:
//   - platform_followers / platform_engagers — the labeled metrics
//     rows the PKG-1 feeds write (followers on account rows;
//     engagement summed from per-platform rows);
//   - link_engagers — the link page's own click counters;
//   - campaign_engagers — metrics rows carrying a campaignId;
//   - store_customers — ordersDaily aggregates (orders, RECORDED);
//   - subscriber_status — CRM-shaped subscriber data. This
//     platform has NO subscriber feed and the email channel is not
//     operational (owner hand-step H1), so this criterion is always
//     UNAVAILABLE: the segment still saves, with the criterion
//     marked, rather than silently matching everyone or no one.
// A segment's size is computed from MEASURED / RECORDED data only
// and carries its label (design §2.1 sizeLabel); anything else is
// UNAVAILABLE with a null size — never an invented count, never a
// zero filled in for missing data. With more than one criterion
// the segment size is UNAVAILABLE: the criteria come from
// aggregate sources whose overlap cannot be counted honestly, and
// each criterion still reports its own status and size. Segments
// may also carry an externalRef (an AwakenFlow CRM segment ID, or
// a platform custom-audience ID read after consent) — a reference
// alone carries no size until a feed measures it.
//
// PERSONAS are owner-authored PLANNING artifacts, stored as drafts.
// They are not measured research and never render as facts; the
// PKG-5 summary contract has no persona field at all, by design.
// A persona created as an example carries label EXAMPLE in its
// data, not just in its prose. Nothing seeds invented personas.
//
// A/B TESTS are records: definition (campaign, variants, one of
// the fixed measurement definitions, window), manual result entry
// with source labeling, and a conclusion guard. A test cannot be
// concluded with a winner unless EVERY variant has result rows,
// every row is labeled MEASURED or RECORDED, every variant's
// recorded sample meets MIN_WINNER_SAMPLE, the rows' stated
// periods cover the full test window for every variant, and the
// conclusion carries a minimum-sample note. There is no
// auto-conclusion path. (Feed-fed results and the full-window
// MEASURED-feed enforcement arrive with PKG-8.)
//
// Content rules (PKG-6, shared): every text field is swept with
// the shared forbidden-term scan (lib/brands) and the campaign
// claim patterns (lib/campaigns CLAIM_PATTERNS) — a remedy /
// treatment claim or an excluded subject is refused, everywhere.
const campaigns = require('./campaigns');
const { scanForForbidden } = require('./brands');
const { logActivity } = require('./activity');

// ---------- shared helpers (campaigns.js patterns) ----------
function fail(status, errors) { return { ok: false, status, errors: Array.isArray(errors) ? errors : [errors] }; }
function str(v, max) { return v == null ? '' : String(v).slice(0, max); }
function stringList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x).slice(0, maxLen)).filter(Boolean).slice(0, maxItems);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXCLUDED_ERROR = 'This record names a brand or subject that is permanently excluded from this system, so it can’t be created here.';

function scanTexts(texts) {
  const errors = [];
  const joined = texts.filter(v => v != null).map(String).join('\n');
  if (scanForForbidden(joined).length) errors.push(EXCLUDED_ERROR);
  if (campaigns.CLAIM_PATTERNS.some(re => texts.some(t => t != null && re.test(String(t))))) {
    errors.push(campaigns.CLAIM_ERROR);
  }
  return errors;
}
function requireBrandWorkspace(ws) {
  if (!ws) return 'Workspace not found.';
  if (!ws.brandId) return 'Audience records live in the Awaken Meta brand workspaces. This workspace isn’t one of them, so they can’t be created here.';
  return null;
}

// ---------- segment criteria ----------
// Each criterion type knows how to validate its parameters against
// the workspace's real records and how to evaluate itself against
// the store. Evaluation returns { status, size, label, note }:
// status AVAILABLE means size is a real count from labeled data.
const PLATFORMS = ['facebook', 'instagram'];
const SIZE_LABELS = ['MEASURED', 'RECORDED'];

function engagementOf(row) {
  let n = 0, seen = false;
  for (const k of ['likes', 'comments', 'shares']) {
    if (typeof row[k] === 'number') { n += row[k]; seen = true; }
  }
  return seen ? n : null;
}
// Engagement rows grouped by label: a size can only be stated for
// one label, so mixed-label or import-only data is UNAVAILABLE.
function labeledEngagement(rows) {
  if (!rows.length) return { status: 'UNAVAILABLE', size: null, label: null, note: 'No metrics rows exist for this yet.' };
  const byLabel = new Map();
  for (const r of rows) {
    const e = engagementOf(r);
    if (e === null) continue;
    const label = r.label || 'IMPORTED';
    byLabel.set(label, (byLabel.get(label) || 0) + e);
  }
  if (!byLabel.size) return { status: 'UNAVAILABLE', size: null, label: null, note: 'Metrics rows exist but carry no engagement counts.' };
  const usable = [...byLabel.keys()].filter(l => SIZE_LABELS.includes(l));
  if (usable.length === 1 && byLabel.size === 1) {
    return { status: 'AVAILABLE', size: byLabel.get(usable[0]), label: usable[0], note: '' };
  }
  if (!usable.length) return { status: 'UNAVAILABLE', size: null, label: null, note: 'Only IMPORTED data exists for this — a size is only ever stated from MEASURED or RECORDED data.' };
  return { status: 'UNAVAILABLE', size: null, label: null, note: 'Metrics rows carry mixed labels, and sizes are never blended across labels.' };
}

const CRITERION_TYPES = [
  {
    type: 'platform_followers',
    describe: 'Followers of a claimed platform account, from the latest labeled account metrics row.',
    validate(store, ws, c, errors) {
      if (!PLATFORMS.includes(c.platform)) errors.push(`platform_followers needs a platform of: ${PLATFORMS.join(', ')}.`);
    },
    evaluate(store, ws, c) {
      const rows = store.all('metrics', r => r.workspaceId === ws.id && r.platform === c.platform
        && !r.postId && typeof r.followers === 'number');
      if (!rows.length) return { status: 'UNAVAILABLE', size: null, label: null, note: `No follower counts have been measured for ${c.platform} in this workspace yet.` };
      const latest = rows.slice().sort((a, b) => String(b.date || b.timestamp || b.createdAt).localeCompare(String(a.date || a.timestamp || a.createdAt)))[0];
      if (!SIZE_LABELS.includes(latest.label || '')) {
        return { status: 'UNAVAILABLE', size: null, label: null, note: `Follower data for ${c.platform} exists but is not MEASURED or RECORDED data, so no size is stated.` };
      }
      return { status: 'AVAILABLE', size: latest.followers, label: latest.label, note: `Latest measured follower count for ${c.platform}${latest.date ? ' (' + latest.date + ')' : ''}.` };
    },
  },
  {
    type: 'platform_engagers',
    describe: 'People engaging with a platform’s posts, summed from labeled per-platform metrics rows.',
    validate(store, ws, c, errors) {
      if (!PLATFORMS.includes(c.platform)) errors.push(`platform_engagers needs a platform of: ${PLATFORMS.join(', ')}.`);
    },
    evaluate(store, ws, c) {
      return labeledEngagement(store.all('metrics', r => r.workspaceId === ws.id && r.platform === c.platform));
    },
  },
  {
    type: 'link_engagers',
    describe: 'Clicks recorded on the workspace’s link page (or one named link).',
    validate(store, ws, c, errors) {
      if (c.linkId !== undefined && c.linkId !== null && c.linkId !== ''
        && !store.find('links', r => r.id === c.linkId && r.workspaceId === ws.id)) {
        errors.push('link_engagers names a link that doesn’t exist in this workspace.');
      }
    },
    evaluate(store, ws, c) {
      const rows = store.all('links', r => r.workspaceId === ws.id && (!c.linkId || r.id === c.linkId));
      if (!rows.length) return { status: 'UNAVAILABLE', size: null, label: null, note: 'No link page links exist in this workspace yet.' };
      const size = rows.reduce((n, r) => n + (typeof r.clicks === 'number' ? r.clicks : 0), 0);
      return { status: 'AVAILABLE', size, label: 'RECORDED', note: 'Recorded link-page click counters.' };
    },
  },
  {
    type: 'campaign_engagers',
    describe: 'Engagement on metrics rows recorded against one campaign.',
    validate(store, ws, c, errors) {
      if (!c.campaignId || !campaigns.findCampaign(store, ws, String(c.campaignId))) {
        errors.push('campaign_engagers names a campaign that doesn’t exist in this workspace.');
      }
    },
    evaluate(store, ws, c) {
      return labeledEngagement(store.all('metrics', r => r.workspaceId === ws.id && r.campaignId === c.campaignId));
    },
  },
  {
    type: 'store_customers',
    describe: 'Store customers in aggregate: orders recorded in the daily store aggregates.',
    validate() {},
    evaluate(store, ws) {
      const rows = store.all('ordersDaily', r => r.workspaceId === ws.id && typeof r.orders === 'number');
      if (!rows.length) return { status: 'UNAVAILABLE', size: null, label: null, note: 'No store order aggregates have been recorded for this workspace yet.' };
      const size = rows.reduce((n, r) => n + r.orders, 0);
      return { status: 'AVAILABLE', size, label: 'RECORDED', note: 'Aggregate recorded orders — a customer count only where one order is one customer engagement; the store feed records orders, not identities.' };
    },
  },
  {
    type: 'subscriber_status',
    describe: 'Subscribers by status, from CRM-shaped subscriber data.',
    validate(store, ws, c, errors) {
      if (!str(c.status, 40).trim()) errors.push('subscriber_status needs the subscriber status it selects (for example: active).');
    },
    evaluate() {
      // There is no subscriber data source in this platform: no
      // subscriber feed is connected and the email channel is not
      // operational (owner hand-step H1). The criterion is marked
      // UNAVAILABLE on every segment that uses it — it never
      // silently matches everyone or no one.
      return { status: 'UNAVAILABLE', size: null, label: null, note: 'Subscriber data is not available in Awaken Meta yet — no subscriber feed is connected and the email channel is not operational.' };
    },
  },
];
function criterionType(type) { return CRITERION_TYPES.find(t => t.type === type) || null; }

function normalizeCriteria(store, ws, input) {
  const errors = [];
  if (input === undefined) return { ok: true, criteria: [] };
  if (!Array.isArray(input)) return { ok: false, errors: ['Segment criteria must be a list.'] };
  const criteria = [];
  for (const raw of input.slice(0, 10)) {
    if (!raw || typeof raw !== 'object' || !criterionType(String(raw.type || ''))) {
      errors.push(`Unknown segment criterion type: ${raw && raw.type}. Known types: ${CRITERION_TYPES.map(t => t.type).join(', ')}.`);
      continue;
    }
    const c = { type: String(raw.type) };
    if (raw.platform !== undefined) c.platform = String(raw.platform).slice(0, 40);
    if (raw.linkId) c.linkId = String(raw.linkId);
    if (raw.campaignId) c.campaignId = String(raw.campaignId);
    if (raw.status !== undefined) c.status = str(raw.status, 40);
    criterionType(c.type).validate(store, ws, c, errors);
    criteria.push(c);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, criteria };
}

// Per-criterion evaluation + the segment-level size. Pure reads —
// evaluating a segment never writes.
function evaluateSegment(store, segment) {
  const ws = { id: segment.workspaceId };
  const criterionStatus = (segment.criteria || []).map(c => {
    const r = criterionType(c.type)
      ? criterionType(c.type).evaluate(store, ws, c)
      : { status: 'UNAVAILABLE', size: null, label: null, note: 'Unknown criterion type.' };
    return { type: c.type, ...r };
  });
  if (!criterionStatus.length) {
    return { sizeEstimate: null, sizeLabel: 'UNAVAILABLE', sizeNote: 'This segment has no criteria yet, so no size can be stated.', criterionStatus };
  }
  if (criterionStatus.length === 1) {
    const only = criterionStatus[0];
    if (only.status === 'AVAILABLE') {
      return { sizeEstimate: only.size, sizeLabel: only.label, sizeNote: only.note || 'Computed from labeled data only.', criterionStatus };
    }
    return { sizeEstimate: null, sizeLabel: 'UNAVAILABLE', sizeNote: only.note, criterionStatus };
  }
  return {
    sizeEstimate: null, sizeLabel: 'UNAVAILABLE',
    sizeNote: 'This segment combines criteria from aggregate sources; their overlap can’t be counted from aggregate data, so no combined size is stated. Each criterion’s own status is listed.',
    criterionStatus,
  };
}
// The stored row plus its freshly computed size fields overlaid.
function presentSegment(store, segment) {
  if (!segment) return null;
  return { ...segment, ...evaluateSegment(store, segment) };
}

// ---------- segments ----------
const SEGMENT_KINDS = ['crm', 'platform', 'manual'];
function deriveKind(criteria, given) {
  if (given && SEGMENT_KINDS.includes(given)) return given;
  if ((criteria || []).some(c => c.type === 'subscriber_status')) return 'crm';
  if ((criteria || []).some(c => c.type.startsWith('platform_'))) return 'platform';
  return 'manual';
}
function normalizeSegment(store, ws, input, existing) {
  const errors = [];
  const merged = { ...(existing || {}), ...(input || {}) };
  if (!existing && !str(merged.name, 120).trim()) errors.push('A segment needs a name.');
  const crit = normalizeCriteria(store, ws, input && input.criteria !== undefined ? input.criteria : (existing ? existing.criteria : []));
  if (!crit.ok) errors.push(...crit.errors);
  errors.push(...scanTexts([merged.name, merged.definition, merged.externalRef]));
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: str(merged.name, 120),
      kind: deriveKind(crit.criteria, merged.kind),
      definition: str(merged.definition, 1000),
      criteria: crit.criteria,
      externalRef: merged.externalRef ? str(merged.externalRef, 200) : null,
      updatedAt: new Date().toISOString(),
    },
  };
}
function findSegment(store, ws, id) {
  return store.find('segments', s => s.id === id && s.workspaceId === ws.id) || null;
}
function createSegment(store, ws, input, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const v = normalizeSegment(store, ws, input || {}, null);
  if (!v.ok) return fail(400, v.errors);
  const segment = store.insert('segments', {
    workspaceId: ws.id, brandId: ws.brandId, ...v.value,
    createdBy: actor && actor.email ? actor.email : 'system',
  });
  // Persist the computed snapshot alongside the definition; reads
  // always re-evaluate, so the snapshot can never pose as fresh.
  const ev = evaluateSegment(store, segment);
  store.update('segments', segment.id, { sizeEstimate: ev.sizeEstimate, sizeLabel: ev.sizeLabel, sizeNote: ev.sizeNote });
  logActivity(store, ws.id, segment.createdBy, 'segment.created', `${segment.name} · kind ${segment.kind} · size ${ev.sizeLabel}`);
  return { ok: true, status: 201, segment: presentSegment(store, findSegment(store, ws, segment.id)) };
}
function updateSegment(store, ws, id, patch, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const s = findSegment(store, ws, id);
  if (!s) return fail(404, 'Segment not found.');
  const v = normalizeSegment(store, ws, patch || {}, s);
  if (!v.ok) return fail(400, v.errors);
  const updated = store.update('segments', s.id, v.value);
  const ev = evaluateSegment(store, updated);
  store.update('segments', s.id, { sizeEstimate: ev.sizeEstimate, sizeLabel: ev.sizeLabel, sizeNote: ev.sizeNote });
  logActivity(store, ws.id, actor && actor.email, 'segment.updated', s.name);
  return { ok: true, status: 200, segment: presentSegment(store, findSegment(store, ws, s.id)) };
}
function refreshSegmentSize(store, ws, id, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const s = findSegment(store, ws, id);
  if (!s) return fail(404, 'Segment not found.');
  const ev = evaluateSegment(store, s);
  store.update('segments', s.id, { sizeEstimate: ev.sizeEstimate, sizeLabel: ev.sizeLabel, sizeNote: ev.sizeNote, updatedAt: new Date().toISOString() });
  logActivity(store, ws.id, actor && actor.email, 'segment.updated', `${s.name} · size refreshed (${ev.sizeLabel})`);
  return { ok: true, status: 200, segment: presentSegment(store, findSegment(store, ws, s.id)) };
}
function getSegment(store, ws, id) {
  const s = findSegment(store, ws, id);
  return s ? presentSegment(store, s) : null;
}
function listSegments(store, workspaceId) {
  return store.all('segments', s => s.workspaceId === workspaceId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(s => presentSegment(store, s));
}

// ---------- personas ----------
// Planning artifacts, owner-authored (or clearly labeled EXAMPLE),
// always drafts until the owner approves them. They carry no
// measured data and have no summary/briefing field anywhere.
function normalizePersona(store, ws, input, existing) {
  const errors = [];
  const merged = { ...(existing || {}), ...(input || {}) };
  if (!existing && !str(merged.name, 120).trim()) errors.push('A persona needs a name.');
  const segmentIds = merged.segmentIds === undefined ? [] : merged.segmentIds;
  if (!Array.isArray(segmentIds)) errors.push('segmentIds must be a list.');
  else for (const id of segmentIds) {
    if (!findSegment(store, ws, id)) errors.push('A segment named in segmentIds doesn’t exist in this workspace.');
  }
  const description = merged.description !== undefined ? merged.description : merged.summary;
  const goals = merged.goals !== undefined ? merged.goals : merged.motivations;
  errors.push(...scanTexts([merged.name, description, merged.offerFit, merged.sourceNotes,
    ...(Array.isArray(goals) ? goals : []), ...(Array.isArray(merged.pains) ? merged.pains : []),
    ...(Array.isArray(merged.channels) ? merged.channels : [])]));
  if (errors.length) return { ok: false, errors };
  const example = merged.example === true || merged.label === 'EXAMPLE';
  const status = ['draft', 'approved'].includes(merged.status) ? merged.status : 'draft';
  return {
    ok: true,
    value: {
      name: str(merged.name, 120),
      description: str(description, 1000),
      summary: str(description, 1000),
      goals: stringList(goals, 12, 300),
      motivations: stringList(goals, 12, 300),
      pains: stringList(merged.pains, 12, 300),
      channels: stringList(merged.channels, 10, 40),
      segmentIds: Array.isArray(segmentIds) ? [...segmentIds] : [],
      offerFit: str(merged.offerFit, 500),
      sourceNotes: str(merged.sourceNotes, 1000),
      planningArtifact: true,
      example,
      label: example ? 'EXAMPLE' : 'OWNER-AUTHORED',
      status: example ? 'draft' : status,
      updatedAt: new Date().toISOString(),
    },
  };
}
function findPersona(store, ws, id) {
  return store.find('personas', p => p.id === id && p.workspaceId === ws.id) || null;
}
function createPersona(store, ws, input, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const v = normalizePersona(store, ws, input || {}, null);
  if (!v.ok) return fail(400, v.errors);
  const persona = store.insert('personas', {
    workspaceId: ws.id, brandId: ws.brandId, ...v.value,
    createdBy: actor && actor.email ? actor.email : 'system',
  });
  logActivity(store, ws.id, persona.createdBy, 'persona.created', `${persona.name} · ${persona.label} · planning draft`);
  return { ok: true, status: 201, persona };
}
function updatePersona(store, ws, id, patch, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const p = findPersona(store, ws, id);
  if (!p) return fail(404, 'Persona not found.');
  const v = normalizePersona(store, ws, patch || {}, p);
  if (!v.ok) return fail(400, v.errors);
  const updated = store.update('personas', p.id, v.value);
  logActivity(store, ws.id, actor && actor.email, 'persona.updated', p.name);
  return { ok: true, status: 200, persona: updated };
}
function listPersonas(store, workspaceId) {
  return store.all('personas', p => p.workspaceId === workspaceId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ---------- A/B test records ----------
// The fixed measurement definitions (AwakenAds report §1.3, carried
// as data by PKG-6's templates): a test's metric is one of these
// ids, never a free-text invention.
const METRICS = [
  { id: 'impressions', name: 'Impressions', definition: 'Impressions served, counted per placement — never blended across platforms.' },
  { id: 'reach', name: 'Reach', definition: 'Unique accounts/people reached, per the platform’s own count for the placement.' },
  { id: 'clicks', name: 'Clicks', definition: 'Clicks on the placement (link clicks where the platform separates them).' },
  { id: 'ctr', name: 'Click-through rate', definition: 'CTR = clicks ÷ impressions, computed per placement, never blended across platforms.' },
  { id: 'conversions', name: 'Conversions', definition: 'Conversions per the product’s own definition (signup / waitlist join / paid order — an order counts when paid, never when merely ordered).' },
  { id: 'cac', name: 'Customer acquisition cost', definition: 'CAC = labeled spend ÷ labeled conversions for the same window; unlabeled inputs are refused, never estimated.' },
];
function metricById(id) { return METRICS.find(m => m.id === id) || null; }
const RESULT_LABELS = ['MEASURED', 'RECORDED'];
// The minimum recorded sample per variant before a winner may be
// concluded, and the conclusion must carry a note stating the
// sample it rests on. A smaller or undocumented sample can be
// recorded — it just can never produce a winner.
const MIN_WINNER_SAMPLE = 100;
const AB_STATUSES = ['draft', 'running', 'concluded', 'archived'];

function normalizeVariants(input) {
  const errors = [];
  if (!Array.isArray(input) || input.length < 2) {
    return { ok: false, errors: ['An A/B test needs at least two variants.'] };
  }
  const seen = new Set();
  const variants = [];
  for (const raw of input.slice(0, 6)) {
    if (!raw || typeof raw !== 'object' || !str(raw.key, 40).trim()) { errors.push('Every variant needs a key.'); continue; }
    const key = str(raw.key, 40).trim();
    if (seen.has(key)) { errors.push(`Variant keys must be unique — “${key}” appears twice.`); continue; }
    seen.add(key);
    variants.push({
      key,
      description: str(raw.description, 500),
      utmContent: raw.utmContent ? str(raw.utmContent, 80) : key,
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, variants };
}
function normalizeAbTest(store, ws, input, existing) {
  const errors = [];
  const merged = { ...(existing || {}), ...(input || {}) };
  let campaign = null;
  if (merged.campaignId) campaign = campaigns.findCampaign(store, ws, String(merged.campaignId));
  if (!existing && !campaign) errors.push('An A/B test must name a campaign that exists in this workspace.');
  if (existing && merged.campaignId && !campaign) errors.push('An A/B test must name a campaign that exists in this workspace.');
  if (!metricById(String(merged.metric || ''))) {
    errors.push(`Unknown metric: ${merged.metric}. A test’s metric is one of the fixed measurement definitions: ${METRICS.map(m => m.id).join(', ')}.`);
  }
  for (const f of ['windowStart', 'windowEnd']) {
    if (merged[f] != null && merged[f] !== '' && !DATE_RE.test(String(merged[f]))) errors.push(`${f} must be a date like 2026-12-01.`);
  }
  if (!existing && (!merged.windowStart || !merged.windowEnd)) errors.push('An A/B test needs a window: windowStart and windowEnd.');
  if (merged.windowStart && merged.windowEnd && String(merged.windowEnd) < String(merged.windowStart)) {
    errors.push('The window end can’t be before the window start.');
  }
  let variants = existing ? existing.variants : null;
  if (!existing || input.variants !== undefined) {
    const v = normalizeVariants(merged.variants);
    if (!v.ok) errors.push(...v.errors); else variants = v.variants;
  }
  errors.push(...scanTexts([merged.name, merged.hypothesis,
    ...(variants || []).map(v => v.description)]));
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      campaignId: String(merged.campaignId),
      name: str(merged.name, 120),
      hypothesis: str(merged.hypothesis, 1000),
      variants,
      metric: String(merged.metric),
      windowStart: String(merged.windowStart),
      windowEnd: String(merged.windowEnd),
      updatedAt: new Date().toISOString(),
    },
  };
}
function findAbTest(store, ws, id) {
  return store.find('abTests', t => t.id === id && t.workspaceId === ws.id) || null;
}
function createAbTest(store, ws, input, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const v = normalizeAbTest(store, ws, input || {}, null);
  if (!v.ok) return fail(400, v.errors);
  const test = store.insert('abTests', {
    workspaceId: ws.id, brandId: ws.brandId, ...v.value,
    status: 'draft', results: [], result: null,
    createdBy: actor && actor.email ? actor.email : 'system',
  });
  logActivity(store, ws.id, test.createdBy, 'abtest.created', `${test.name || test.id} · campaign ${test.campaignId} · metric ${test.metric}`);
  return { ok: true, status: 201, abTest: test };
}
function updateAbTest(store, ws, id, patch, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const t = findAbTest(store, ws, id);
  if (!t) return fail(404, 'A/B test not found.');
  if (t.status === 'concluded' || t.status === 'archived') {
    return fail(400, 'A concluded or archived test is a closed record — its definition no longer changes.');
  }
  const p = patch || {};
  if (p.status !== undefined || p.results !== undefined || p.result !== undefined) {
    return fail(400, 'Status, results, and the conclusion don’t change by editing fields — they move through the test’s record / start / conclude steps.');
  }
  const input = {};
  for (const k of ['campaignId', 'name', 'hypothesis', 'variants', 'metric', 'windowStart', 'windowEnd']) {
    if (p[k] !== undefined) input[k] = p[k];
  }
  if (!Object.keys(input).length) return { ok: true, status: 200, abTest: t };
  const v = normalizeAbTest(store, ws, input, t);
  if (!v.ok) return fail(400, v.errors);
  const updated = store.update('abTests', t.id, v.value);
  logActivity(store, ws.id, actor && actor.email, 'abtest.updated', t.name || t.id);
  return { ok: true, status: 200, abTest: updated };
}

// Manual result entry with source labeling. Only MEASURED /
// RECORDED rows can ever be recorded — an unlabeled or imported
// figure is refused at the door, not merely at conclusion.
function recordResult(store, ws, id, entry, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const t = findAbTest(store, ws, id);
  if (!t) return fail(404, 'A/B test not found.');
  if (t.status === 'concluded' || t.status === 'archived') {
    return fail(400, 'This test is closed — results are no longer recorded on it.');
  }
  const e = entry || {};
  const errors = [];
  if (!(t.variants || []).some(v => v.key === e.variantKey)) {
    errors.push(`Result names variant “${e.variantKey}”, which is not one of this test’s variants.`);
  }
  if (!RESULT_LABELS.includes(e.label)) {
    errors.push('A result row must carry a source label of MEASURED or RECORDED — unlabeled figures are never recorded.');
  }
  if (!str(e.source, 200).trim()) errors.push('A result row must name its source (where the numbers came from).');
  if (!Number.isInteger(e.sampleSize) || e.sampleSize < 0) errors.push('A result row needs a sampleSize: a whole number, 0 or more.');
  if (!DATE_RE.test(String(e.periodStart || '')) || !DATE_RE.test(String(e.periodEnd || ''))) {
    errors.push('A result row must state the period it covers (periodStart and periodEnd, like 2026-12-01).');
  } else if (String(e.periodEnd) < String(e.periodStart)) {
    errors.push('The result period end can’t be before its start.');
  }
  const counts = {};
  if (e.counts && typeof e.counts === 'object') {
    for (const k of ['impressions', 'clicks', 'conversions', 'reach', 'spendCents']) {
      if (e.counts[k] !== undefined) {
        if (typeof e.counts[k] !== 'number' || !(e.counts[k] >= 0)) { errors.push(`counts.${k} must be a number, 0 or more.`); continue; }
        counts[k] = e.counts[k];
      }
    }
  }
  errors.push(...scanTexts([e.source, e.note]));
  if (errors.length) return fail(400, errors);
  const row = {
    variantKey: String(e.variantKey),
    label: e.label,
    source: str(e.source, 200),
    counts,
    sampleSize: e.sampleSize,
    periodStart: String(e.periodStart),
    periodEnd: String(e.periodEnd),
    note: str(e.note, 500),
    recordedBy: actor && actor.email ? actor.email : 'system',
    recordedAt: new Date().toISOString(),
  };
  const updated = store.update('abTests', t.id, { results: [...(t.results || []), row], updatedAt: row.recordedAt });
  logActivity(store, ws.id, row.recordedBy, 'abtest.recorded', `${t.name || t.id} · variant ${row.variantKey} · ${row.label} · sample ${row.sampleSize}`);
  return { ok: true, status: 201, abTest: updated };
}

function startAbTest(store, ws, id, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const t = findAbTest(store, ws, id);
  if (!t) return fail(404, 'A/B test not found.');
  if (t.status !== 'draft') return fail(400, `Only a draft test can be started — this one is ${t.status}.`);
  const updated = store.update('abTests', t.id, { status: 'running', updatedAt: new Date().toISOString() });
  logActivity(store, ws.id, actor && actor.email, 'abtest.updated', `${t.name || t.id} · started`);
  return { ok: true, status: 200, abTest: updated };
}
function archiveAbTest(store, ws, id, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const t = findAbTest(store, ws, id);
  if (!t) return fail(404, 'A/B test not found.');
  if (t.status === 'archived') return { ok: true, status: 200, abTest: t };
  const updated = store.update('abTests', t.id, { status: 'archived', updatedAt: new Date().toISOString() });
  logActivity(store, ws.id, actor && actor.email, 'abtest.updated', `${t.name || t.id} · archived`);
  return { ok: true, status: 200, abTest: updated };
}

// Do the stated periods cover [start, end] with no gap? Dates are
// whole days, so an interval ending the day before the next begins
// is contiguous.
function periodsCover(periods, start, end) {
  const sorted = periods.slice().sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  let coveredThrough = null;
  for (const [s, e] of sorted) {
    if (coveredThrough === null) {
      if (s > start) return false;
      coveredThrough = e;
    } else {
      const nextDay = new Date(Date.parse(coveredThrough + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
      if (s > nextDay) return false;
      if (e > coveredThrough) coveredThrough = e;
    }
    if (coveredThrough >= end) return true;
  }
  return coveredThrough !== null && coveredThrough >= end;
}
// The winner guard (design §2.1): every reason a conclusion is
// refused, in plain language. Empty array = conclusion may proceed.
function conclusionBlockers(t, winner, sampleNote) {
  const blockers = [];
  if (!(t.variants || []).some(v => v.key === winner)) {
    blockers.push(`“${winner}” is not one of this test’s variants, so it can’t be named the winner.`);
  }
  if (!str(sampleNote, 1000).trim()) {
    blockers.push('A conclusion must carry a minimum-sample note stating the recorded sample it rests on.');
  }
  const rows = t.results || [];
  for (const v of t.variants || []) {
    const vRows = rows.filter(r => r.variantKey === v.key);
    if (!vRows.length) { blockers.push(`Variant “${v.key}” has no recorded results yet.`); continue; }
    if (vRows.some(r => !RESULT_LABELS.includes(r.label))) {
      blockers.push(`Variant “${v.key}” has result rows without a MEASURED or RECORDED label — a winner can only rest on labeled data.`);
    }
    const sample = vRows.reduce((n, r) => n + (Number.isInteger(r.sampleSize) ? r.sampleSize : 0), 0);
    if (sample < MIN_WINNER_SAMPLE) {
      blockers.push(`Variant “${v.key}” has a recorded sample of ${sample}; a winner needs at least ${MIN_WINNER_SAMPLE} per variant.`);
    }
    if (!periodsCover(vRows.map(r => [r.periodStart, r.periodEnd]), t.windowStart, t.windowEnd)) {
      blockers.push(`Variant “${v.key}”’s recorded periods don’t cover the full test window (${t.windowStart} to ${t.windowEnd}) — a partial window can’t produce a winner.`);
    }
  }
  return blockers;
}
function concludeAbTest(store, ws, id, conclusion, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const t = findAbTest(store, ws, id);
  if (!t) return fail(404, 'A/B test not found.');
  if (t.status !== 'running') {
    return fail(400, `Only a running test can be concluded — this one is ${t.status}. There is no auto-conclusion; a person records the winner.`);
  }
  const c = conclusion || {};
  const blockers = conclusionBlockers(t, c.winner, c.sampleNote);
  if (blockers.length) return fail(400, blockers);
  const perVariant = {};
  const labels = new Set();
  for (const v of t.variants) {
    const vRows = (t.results || []).filter(r => r.variantKey === v.key);
    const counts = {};
    for (const r of vRows) {
      labels.add(r.label);
      for (const [k, n] of Object.entries(r.counts || {})) counts[k] = (counts[k] || 0) + n;
    }
    perVariant[v.key] = { sampleSize: vRows.reduce((n, r) => n + r.sampleSize, 0), counts };
  }
  const now = new Date().toISOString();
  const result = {
    winner: String(c.winner),
    label: labels.size === 1 ? [...labels][0] : 'MEASURED/RECORDED',
    perVariant,
    sampleNote: str(c.sampleNote, 1000),
    concludedBy: actor && actor.email ? actor.email : 'system',
    concludedAt: now,
  };
  const updated = store.update('abTests', t.id, { status: 'concluded', result, updatedAt: now });
  logActivity(store, ws.id, result.concludedBy, 'abtest.concluded', `${t.name || t.id} · winner ${result.winner} · ${result.label}`);
  return { ok: true, status: 200, abTest: updated };
}
function listAbTests(store, workspaceId, filters) {
  const f = filters || {};
  return store.all('abTests', t => t.workspaceId === workspaceId
    && (!f.status || t.status === f.status)
    && (!f.campaignId || t.campaignId === f.campaignId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ---------- evidence-gate wiring ----------
// Linking a segment or persona to a campaign satisfies the
// campaign's "audience defined" evidence item: the link is made
// through campaigns.updateCampaign (which validates that the
// records exist in this workspace), and campaigns.setEvidence /
// updateCampaign treat a linked audience as the definition (the
// gate itself enforces it — see lib/campaigns.js, PKG-7 notes).
// This helper is the one-call path: union the links onto the
// campaign, then report the campaign's evidence state.
function linkAudience(store, ws, campaignId, links, actor) {
  const wsErr = requireBrandWorkspace(ws);
  if (wsErr) return fail(400, wsErr);
  const c = campaigns.findCampaign(store, ws, campaignId);
  if (!c) return fail(404, 'Campaign not found.');
  const l = links || {};
  const union = (current, add) => [...new Set([...(current || []), ...(Array.isArray(add) ? add : [])])];
  const patch = {};
  if (l.segmentIds !== undefined) patch.segmentIds = union(c.segmentIds, l.segmentIds);
  if (l.personaIds !== undefined) patch.personaIds = union(c.personaIds, l.personaIds);
  if (!Object.keys(patch).length) return fail(400, 'Nothing to link: pass segmentIds and/or personaIds.');
  const r = campaigns.updateCampaign(store, ws, campaignId, patch, actor);
  if (!r.ok) return r;
  logActivity(store, ws.id, actor && actor.email, 'campaign.updated',
    `${c.name} · audience linked (${(patch.segmentIds || []).length} segments, ${(patch.personaIds || []).length} personas) — audience-defined evidence ${campaigns.evidenceOf(r.campaign).audienceDefined ? 'satisfied' : 'not yet satisfied'}`);
  return { ok: true, status: 200, campaign: r.campaign };
}

module.exports = {
  CRITERION_TYPES, criterionType, SIZE_LABELS,
  evaluateSegment, presentSegment,
  SEGMENT_KINDS, findSegment, createSegment, updateSegment, refreshSegmentSize, getSegment, listSegments,
  findPersona, createPersona, updatePersona, listPersonas,
  METRICS, metricById, RESULT_LABELS, MIN_WINNER_SAMPLE, AB_STATUSES,
  findAbTest, createAbTest, updateAbTest, recordResult, startAbTest, archiveAbTest, concludeAbTest, conclusionBlockers, listAbTests,
  linkAudience, scanTexts,
};
