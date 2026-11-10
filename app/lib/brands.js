'use strict';
// Awaken Meta PKG-2 — brand workspace formalization + enterprise
// roll-up (design §3). Affordable Meta workspaces already exist and
// everything in the app is workspace-scoped; this module formalizes
// the FIXED brand set (B1–B5) on top of them:
//
// - Each brand is a data definition (BRAND_WORKSPACES). A brand maps
//   to exactly one workspace row, stamped with its brandId. Seeding
//   is idempotent and additive: it never renames or recreates an
//   existing workspace — a workspace whose own data (feed metrics /
//   connections) already names a brand's claimed Page/account is
//   CLAIMED as that brand, per the design's rollback note.
// - A brand's assets are named in its claims, and the claims are
//   written into the workspace's existing connections rows (the
//   registry the feeds already read) with the external ID attached.
// - Future properties join by registering another definition object
//   (registerBrand) — data, not a code change. Definitions are
//   validated and scanned before they can create anything.
// - The enterprise roll-up is a read: per-workspace labeled totals
//   via analytics.rollupBySource (PKG-1), plus ordersDaily totals.
//   The honesty law carries through unchanged — a field with no
//   numeric value anywhere totals as null and renders UNAVAILABLE
//   via analytics.formatMetric, never 0, and totals are sums of the
//   per-workspace numbers only (never a blend across labels).
//
// Exclusions, absolute (owner rules, enforced in code):
// - The project under the owner's permanent secrecy rule is NOT a
//   workspace and is never named in this module's data. The
//   attestation scan below sweeps the catalog, the seeded workspace
//   data, and the rendered roll-up labels for the forbidden terms.
// - The separate professional lane is excluded entirely, the same
//   list PKG-1 enforces (lib/feeds EXCLUDED_*): a claim naming one
//   of its accounts is refused, and it has no brand definition.
// - Awaken the Magic (B5) has a workspace so planning has a home,
//   but NO feed is wired into it: its metrics render UNAVAILABLE
//   until a separate Awaken Social feed decision. That is enforced
//   in the roll-up, not left to convention — rows placed in B5 by
//   any other path still do not surface as its metrics.
const analytics = require('./analytics');
const enterprise = require('./enterprise');
const { isExcludedExternal } = require('./feeds');
const { logActivity } = require('./activity');

// Terms that must never appear in a brand definition, a seeded
// workspace, its registry rows, or a rendered roll-up label: the
// secret project's name (owner's permanent secrecy rule) and the
// excluded professional lane's identifiers. The scan returns counts
// and locations only — callers (reports) never print the terms.
const FORBIDDEN_TERMS = ['terramorph', 'fnsm', 'functional neurology', 'sleep medicine', 'the_sleep_doctor_slc'];
function scanForForbidden(text) {
  const t = String(text == null ? '' : text).toLowerCase();
  return FORBIDDEN_TERMS.filter(term => t.includes(term));
}

const WIDGETS = { planner: true, inbox: true, analytics: true, links: true, bestTimes: true, competitors: true };

// The fixed brand set (design §3.1). brandId strings match the
// /empire marketing-summary contract (design §4.2) exactly, so the
// summary builder can key on them without a translation table.
// Claims carry ONLY verified external IDs (the feed config's claimed
// Pages/account). A brand with no verified Page ID claims none —
// its connections row says what is pending instead of inventing one.
const BRAND_WORKSPACES = [
  {
    brandId: 'llc', order: 1, name: 'Awaken With Amber LLC', slug: 'awaken-with-amber-llc',
    primeProject: null, metricsMode: 'feeds',
    tagline: 'The umbrella brand — parent company workspace and enterprise roll-up home.',
    claims: [
      { platform: 'facebook', externalId: '1125112937358042', handle: 'Awaken With Amber LLC (Facebook Page)', status: 'connected_via_muse', note: 'The LLC Facebook Page, claimed by the B1 workspace. Insights feed (PKG-1) reads it here.' },
      { platform: 'instagram', externalId: '17841448052924927', handle: '@awakenwithamber', status: 'connected_via_muse', note: 'The brand Instagram account, claimed by the B1 workspace. Insights feed (PKG-1) reads it here.' },
    ],
  },
  {
    brandId: 'awakenagain', order: 2, name: 'AwakenAgain', slug: 'awakenagain',
    primeProject: '02', metricsMode: 'feeds',
    tagline: 'Store + Living Grimoire surfaces, Garden Club.',
    claims: [
      { platform: 'website', externalId: null, handle: 'awakenagain.com', status: 'not_started', note: 'Store orders (PKG-4) and website analytics (PKG-3) land in this workspace. No Facebook Page claim is verified for this brand, so none is recorded.' },
    ],
  },
  {
    brandId: 'apothecary', order: 3, name: "Amber's Alchemy Apothecary", slug: 'ambers-alchemy-apothecary',
    primeProject: '03', metricsMode: 'feeds',
    tagline: 'Apothecary Page, product and soap line marketing.',
    claims: [
      { platform: 'facebook', externalId: '1385934337938955', handle: "Amber's Alchemy Apothecary (Facebook Page)", status: 'connected_via_muse', note: 'The Apothecary Facebook Page, claimed by the B3 workspace. Insights feed (PKG-1) reads it here.' },
      { platform: 'website', externalId: null, handle: 'awakenagain.com', status: 'not_started', note: 'The Apothecary sells through the shared AwakenAgain store. Order aggregates stay in B2 unless a store record honestly supports a product-line split (design §3.1).' },
    ],
  },
  {
    brandId: 'eco-villages', order: 4, name: 'Awaken Eco-Villages', slug: 'awaken-eco-villages',
    primeProject: '05', metricsMode: 'feeds',
    tagline: 'Eco-villages brand and community land projects.',
    claims: [
      { platform: 'facebook', externalId: null, handle: 'Limitless EcoLiving (Facebook Page)', status: 'action_needed', note: 'The brand has a Facebook Page presence, but its Page ID is not yet claimed by this workspace. The insights feed reads it here once the Page ID is added to this claim.' },
    ],
  },
  {
    brandId: 'awaken-the-magic', order: 5, name: 'Awaken the Magic', slug: 'awaken-the-magic',
    primeProject: '06', metricsMode: 'unavailable',
    tagline: 'The community brand. Its operating home is Awaken Social, a separate app.',
    claims: [
      { platform: 'awaken-social', externalId: null, handle: 'Awaken Social (separate app)', status: 'browser_only', note: 'This workspace exists so campaigns and planning for the brand have a home. Metrics render UNAVAILABLE until a separate Awaken Social feed decision (design §3.1) — no Awaken Social data is wired into this workspace.' },
    ],
  },
];

// ---------- definition validation + registration (future properties) ----------
function validateBrandDef(def, catalog) {
  const errors = [];
  if (!def || typeof def !== 'object') return { ok: false, errors: ['definition must be an object'] };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(def.brandId || ''))) errors.push('brandId must be a lowercase slug');
  if (!String(def.name || '').trim()) errors.push('name is required');
  if (def.metricsMode !== undefined && !['feeds', 'unavailable'].includes(def.metricsMode)) errors.push("metricsMode must be 'feeds' or 'unavailable'");
  const hits = scanForForbidden(JSON.stringify(def));
  if (hits.length) errors.push(`definition contains ${hits.length} forbidden term(s)`);
  const list = Array.isArray(catalog) ? catalog : BRAND_WORKSPACES;
  if (list.some(d => d.brandId === def.brandId)) errors.push('brandId already exists in the catalog');
  for (const claim of def.claims || []) {
    if (!claim || !claim.platform) { errors.push('each claim needs a platform'); continue; }
    if (isExcludedExternal(claim.externalId, claim.handle)) errors.push('claim names a permanently excluded account');
  }
  return { ok: errors.length === 0, errors };
}

function normalizeDef(def, catalog) {
  const orders = (catalog || BRAND_WORKSPACES).map(d => d.order || 0);
  return {
    brandId: String(def.brandId),
    order: Number.isFinite(def.order) ? def.order : (orders.length ? Math.max(...orders) + 1 : 1),
    name: String(def.name).slice(0, 80),
    slug: String(def.slug || def.brandId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || String(def.brandId),
    primeProject: def.primeProject || null,
    metricsMode: def.metricsMode || 'feeds',
    tagline: String(def.tagline || '').slice(0, 160),
    claims: (def.claims || []).map(c => ({
      platform: String(c.platform).slice(0, 40),
      externalId: c.externalId != null ? String(c.externalId) : null,
      handle: String(c.handle || '').slice(0, 120),
      status: String(c.status || 'not_started').slice(0, 40),
      note: String(c.note || '').slice(0, 500),
    })),
  };
}

// ---------- seeding / claiming ----------
function uniqueSlug(store, base) {
  let slug = base; let n = 1;
  while (store.find('workspaces', w => w.slug === slug)) slug = base + '-' + (++n);
  return slug;
}

// Which brand (if any) does this workspace's own data already claim?
// Determined by the external IDs present in its feed-written metrics
// rows and its connections rows — the same claims the feeds read.
function claimedBrandForWorkspace(store, ws, catalog) {
  const ids = new Set();
  for (const m of store.all('metrics', x => x.workspaceId === ws.id)) if (m.externalId) ids.add(String(m.externalId));
  for (const c of store.all('connections', x => x.workspaceId === ws.id)) if (c.externalId) ids.add(String(c.externalId));
  if (!ids.size) return null;
  for (const def of catalog || BRAND_WORKSPACES) {
    if ((def.claims || []).some(c => c.externalId && ids.has(String(c.externalId)))) return def;
  }
  return null;
}

// Write a brand's claims into its workspace's connections rows.
// Idempotent: a claim is keyed by platform + externalId (or platform
// alone when the claim has no external ID yet).
function ensureClaims(store, ws, def) {
  const added = [];
  for (const claim of def.claims || []) {
    if (isExcludedExternal(claim.externalId, claim.handle)) continue; // paranoia: never seed an excluded claim
    const exists = store.find('connections', c => c.workspaceId === ws.id && c.platform === claim.platform
      && (claim.externalId ? String(c.externalId || '') === String(claim.externalId) : !c.externalId));
    if (!exists) added.push(store.insert('connections', { workspaceId: ws.id, ...claim, brandClaim: true }));
  }
  return added;
}

function createBrandWorkspace(store, def) {
  const ws = store.insert('workspaces', {
    name: def.name, slug: uniqueSlug(store, def.slug), tagline: def.tagline || '',
    ownerId: null, edition: enterprise.EDITION, planId: 'free', grandfathered: false,
    plugins: {}, widgets: { ...WIDGETS },
    brandId: def.brandId, brandOrder: def.order, kind: 'brand', metricsMode: def.metricsMode,
  });
  ws.workspaceId = ws.id; store.save();
  return ws;
}

// Seed the catalog's brand workspaces. For each brand, in order:
// already seeded → keep (claims re-ensured); an existing unclaimed
// workspace whose data names the brand's assets → CLAIM it (stamp
// brandId; the workspace itself is never renamed or recreated);
// otherwise → create it. Returns one result row per brand.
function seedBrandWorkspaces(store, catalog) {
  const list = [...(catalog || BRAND_WORKSPACES)].sort((a, b) => (a.order || 0) - (b.order || 0));
  const results = [];
  for (const def of list) {
    let ws = store.find('workspaces', w => w.brandId === def.brandId);
    let action = 'existing';
    if (!ws) {
      const candidate = store.all('workspaces', w => !w.brandId)
        .find(w => { const d = claimedBrandForWorkspace(store, w, list); return d && d.brandId === def.brandId; });
      if (candidate) {
        ws = store.update('workspaces', candidate.id, { brandId: def.brandId, brandOrder: def.order, kind: 'brand', metricsMode: def.metricsMode });
        action = 'claimed';
      } else {
        ws = createBrandWorkspace(store, def);
        action = 'created';
      }
    }
    const claimsAdded = ensureClaims(store, ws, def);
    results.push({ brandId: def.brandId, name: def.name, workspaceId: ws.id, action, claimsAdded: claimsAdded.length });
  }
  return results;
}

// Register a future property: validate the definition, then seed it
// through the exact same path as the built-in catalog. Idempotent —
// a brandId that already has a workspace returns it unchanged.
function registerBrand(store, def, catalog) {
  const list = [...(catalog || BRAND_WORKSPACES)];
  if (!def || typeof def !== 'object' || !def.brandId) return { ok: false, errors: ['a definition with a brandId is required'] };
  const existingWs = store.find('workspaces', w => w.brandId === def.brandId);
  if (existingWs) return { ok: true, action: 'existing', workspace: existingWs };
  if (list.some(d => d.brandId === def.brandId)) {
    // A catalog brand that simply has not been seeded yet: seed the
    // catalog's own definition (a passed def never overrides it).
    const r = seedBrandWorkspaces(store, list).find(x => x.brandId === def.brandId);
    return { ok: true, action: r ? r.action : 'created', workspace: store.find('workspaces', w => w.brandId === def.brandId) };
  }
  const v = validateBrandDef(def, list);
  if (!v.ok) return { ok: false, errors: v.errors };
  const nd = normalizeDef(def, list);
  const r = seedBrandWorkspaces(store, [...list, nd]).find(x => x.brandId === nd.brandId);
  const ws = store.find('workspaces', w => w.brandId === nd.brandId);
  if (ws) logActivity(store, ws.id, 'system', 'brand.registered', `${nd.name} (${nd.brandId})`);
  return { ok: true, action: r ? r.action : 'created', workspace: ws };
}

// ---------- listing ----------
function listBrandWorkspaces(store, catalog) {
  const list = [...(catalog || BRAND_WORKSPACES)].sort((a, b) => (a.order || 0) - (b.order || 0));
  return list.map(def => {
    const ws = store.find('workspaces', w => w.brandId === def.brandId);
    return {
      brandId: def.brandId, order: def.order, name: def.name,
      primeProject: def.primeProject || null, metricsMode: def.metricsMode,
      seeded: !!ws, workspaceId: ws ? ws.id : null,
      slug: ws ? ws.slug : def.slug,
      claims: (def.claims || []).map(c => ({ platform: c.platform, externalId: c.externalId || null, handle: c.handle, status: c.status })),
    };
  });
}

// ---------- enterprise roll-up ----------
const ORDER_FIELDS = ['orders', 'ordersPaid', 'recordedRevenueCents', 'items', 'checkoutsAttempted', 'checkoutsAccepted'];
function nullFields(fields) {
  const out = {};
  for (const f of fields) out[f] = { value: null, unavailableRows: 0 };
  return out;
}
// Sum order aggregates with the null law: a field totals the numeric
// values only, and is null when no row carried a number for it.
function ordersRollup(rows) {
  const fields = nullFields(ORDER_FIELDS);
  for (const r of rows || []) {
    for (const f of ORDER_FIELDS) {
      const n = analytics.numOrNull(r[f]);
      if (n === null) fields[f].unavailableRows += 1;
      else fields[f].value = (fields[f].value === null ? 0 : fields[f].value) + n;
    }
  }
  return { label: rows && rows.length ? 'RECORDED' : 'UNAVAILABLE', rows: (rows || []).length, fields };
}
// Merge per-brand rollupBySource groups into enterprise totals, per
// platform × label. A field's total is the sum of the brands' numeric
// group values, or null when NO brand has a number — brands whose
// value is unavailable contribute their unavailable-row count,
// never a 0.
function mergeSourceGroups(groups) {
  const merged = {};
  for (const g of groups || []) {
    const key = g.platform + '|' + g.label;
    const m = merged[key] || (merged[key] = { platform: g.platform, label: g.label, rows: 0, fields: nullFields(analytics.SOURCE_FIELDS) });
    m.rows += g.rows || 0;
    for (const f of analytics.SOURCE_FIELDS) {
      const cell = (g.fields || {})[f] || { value: null, unavailableRows: 0 };
      m.fields[f].unavailableRows += cell.unavailableRows || 0;
      if (cell.value !== null && cell.value !== undefined) m.fields[f].value = (m.fields[f].value === null ? 0 : m.fields[f].value) + cell.value;
    }
  }
  return Object.values(merged).sort((a, b) => (a.platform + a.label).localeCompare(b.platform + b.label));
}
function mergeOrders(rollups) {
  const fields = nullFields(ORDER_FIELDS);
  let rows = 0; let anyRecorded = false;
  for (const r of rollups || []) {
    rows += r.rows || 0;
    if (r.label === 'RECORDED') anyRecorded = true;
    for (const f of ORDER_FIELDS) {
      const cell = (r.fields || {})[f] || { value: null, unavailableRows: 0 };
      fields[f].unavailableRows += cell.unavailableRows || 0;
      if (cell.value !== null && cell.value !== undefined) fields[f].value = (fields[f].value === null ? 0 : fields[f].value) + cell.value;
    }
  }
  return { label: anyRecorded ? 'RECORDED' : 'UNAVAILABLE', rows, fields };
}

function workspaceRollup(store, def, ws) {
  const base = {
    brandId: def.brandId, order: def.order, name: def.name,
    primeProject: def.primeProject || null, metricsMode: def.metricsMode,
    seeded: !!ws, workspaceId: ws ? ws.id : null,
  };
  if (!ws) {
    return { ...base, social: [], orders: ordersRollup([]), campaigns: { total: 0, byStatus: {} }, local: { posts: 0, links: 0 } };
  }
  const local = {
    posts: store.all('posts', x => x.workspaceId === ws.id).length,
    links: store.all('links', x => x.workspaceId === ws.id).length,
  };
  const campRows = store.all('campaigns', x => x.workspaceId === ws.id);
  const byStatus = {};
  for (const c of campRows) byStatus[c.status || 'draft'] = (byStatus[c.status || 'draft'] || 0) + 1;
  const campaigns = { total: campRows.length, byStatus };
  if (def.metricsMode === 'unavailable') {
    // No feed is wired into this brand (design §3.1): its metrics
    // render UNAVAILABLE even if rows exist in the workspace.
    return {
      ...base, social: [], orders: ordersRollup([]), campaigns, local,
      metricsNote: 'UNAVAILABLE — no feed is wired into this brand yet (separate Awaken Social feed decision pending).',
    };
  }
  return {
    ...base,
    social: analytics.rollupBySource(store.all('metrics', x => x.workspaceId === ws.id)),
    orders: ordersRollup(store.all('ordersDaily', x => x.workspaceId === ws.id)),
    campaigns, local,
  };
}

function enterpriseRollup(store, catalog) {
  const list = [...(catalog || BRAND_WORKSPACES)].sort((a, b) => (a.order || 0) - (b.order || 0));
  const brands = list.map(def => workspaceRollup(store, def, store.find('workspaces', w => w.brandId === def.brandId)));
  return {
    generatedAt: new Date().toISOString(),
    source: 'awaken-affordable-meta',
    brands,
    totals: {
      social: mergeSourceGroups(brands.flatMap(b => b.social || [])),
      orders: mergeOrders(brands.map(b => b.orders)),
      campaigns: { total: brands.reduce((n, b) => n + (b.campaigns ? b.campaigns.total : 0), 0) },
    },
  };
}

// Plain-text rendering of the roll-up with every value passed
// through formatMetric — the rendered-labels surface the attestation
// scan sweeps, and a human-checkable view of the same numbers.
function renderRollupText(roll) {
  const lines = [`Enterprise roll-up — generated ${roll.generatedAt}`];
  const fmtFields = fields => analytics.SOURCE_FIELDS.concat(ORDER_FIELDS).filter(f => fields && fields[f])
    .map(f => `${f}: ${analytics.formatMetric(fields[f].value)}`).join(' · ');
  for (const b of roll.brands || []) {
    lines.push(`${b.order}. ${b.name} [${b.brandId}]${b.seeded ? '' : ' (not seeded)'}`);
    if (b.metricsNote) lines.push(`   metrics: ${b.metricsNote}`);
    for (const g of b.social || []) lines.push(`   ${g.platform} · ${g.label} · ${fmtFields(g.fields)}`);
    if (b.orders) lines.push(`   orders · ${b.orders.label} · ${fmtFields(b.orders.fields)}`);
    lines.push(`   campaigns: ${b.campaigns ? b.campaigns.total : 0}`);
  }
  lines.push('Enterprise totals');
  for (const g of (roll.totals && roll.totals.social) || []) lines.push(`   ${g.platform} · ${g.label} · ${fmtFields(g.fields)}`);
  if (roll.totals && roll.totals.orders) lines.push(`   orders · ${roll.totals.orders.label} · ${fmtFields(roll.totals.orders.fields)}`);
  return lines.join('\n');
}

// ---------- attestation ----------
// Sweeps the catalog, every brand workspace's own data (workspace
// row, connections, links, campaigns) and the rendered roll-up
// labels for the forbidden terms. Returns counts + locations only.
function attestationScan(store, catalog) {
  const list = catalog || BRAND_WORKSPACES;
  const hits = [];
  const scan = (where, text) => { for (const term of scanForForbidden(text)) hits.push({ where, term }); };
  scan('catalog', JSON.stringify(list));
  for (const def of list) {
    const ws = store.find('workspaces', w => w.brandId === def.brandId);
    if (!ws) continue;
    scan(`workspace:${def.brandId}`, JSON.stringify(ws));
    for (const c of store.all('connections', x => x.workspaceId === ws.id)) scan(`connection:${def.brandId}/${c.platform}`, JSON.stringify(c));
    for (const l of store.all('links', x => x.workspaceId === ws.id)) scan(`link:${def.brandId}`, `${l.title || ''} ${l.url || ''}`);
    for (const c of store.all('campaigns', x => x.workspaceId === ws.id)) scan(`campaign:${def.brandId}`, JSON.stringify(c));
  }
  scan('rollup-render', renderRollupText(enterpriseRollup(store, list)));
  return { ok: hits.length === 0, hits };
}

module.exports = {
  BRAND_WORKSPACES, FORBIDDEN_TERMS, scanForForbidden,
  validateBrandDef, registerBrand,
  claimedBrandForWorkspace, seedBrandWorkspaces, listBrandWorkspaces,
  ordersRollup, mergeSourceGroups, mergeOrders,
  enterpriseRollup, renderRollupText, attestationScan,
};
