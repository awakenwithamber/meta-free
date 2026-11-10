'use strict';
// Awaken Meta data-feed layer (PKG-1). Read-only feeds pull platform
// numbers through the already-connected Muse connectors and write
// them into the existing analytics store through ONE authenticated
// ingest path. Honesty rules, enforced here rather than by convention:
//
// - Every feed row carries source + label (MEASURED / RECORDED /
//   IMPORTED), set by the writer, never by a renderer.
// - A value the connector did not return as a NUMBER is stored as
//   null (UNAVAILABLE) — never 0, and never parsed out of a display
//   string. (The Facebook connector currently returns every metric
//   with value:null plus a rendered_text display string; those
//   strings are presentation, not data, and are never parsed.)
// - A failed run writes NO metric rows and never touches prior data;
//   it records one feedRuns row with status 'failed' and the error.
// - Ingest is upsert-by-natural-key, so re-running a window corrects
//   rows instead of double-counting them.
// - The ingest service token is stored ONLY as its SHA-256 hash (env
//   FEED_INGEST_TOKEN_HASH), the same pattern passwordResets uses.
//   The plaintext token is never logged or persisted.
const crypto = require('crypto');
const { logActivity } = require('./activity');

const LABELS = ['MEASURED', 'RECORDED', 'IMPORTED'];
const METRIC_FIELDS = ['likes', 'comments', 'shares', 'clicks', 'reach', 'views', 'followers', 'newFollowers', 'profileVisits'];
// Website rows (PKG-3, PostHog) carry two extended numeric fields the
// social row shape has no honest equivalent for. Same null law.
const WEBSITE_FIELDS = ['sessions', 'visitors'];
// Meta Ads rows (PKG-9) carry three extended numeric fields the social
// row shape has no honest equivalent for: spend (integer cents — the
// store's money unit everywhere), impressions, and the platform's own
// reported conversions. Same null law, enforced at the ingest door.
const ADS_FIELDS = ['spendCents', 'impressions', 'conversions'];

// Permanently excluded external accounts (owner rule): a separate
// professional lane that never enters this marketing system. Feeds
// never pull these IDs, the job never claims them, and ingest drops
// any row naming one even if a caller sends it.
const EXCLUDED_EXTERNAL_IDS = new Set(['743318325528475', '17841476844283949']);
const EXCLUDED_USERNAMES = new Set(['the_sleep_doctor_slc']);
function isExcludedExternal(externalId, username) {
  if (externalId != null && EXCLUDED_EXTERNAL_IDS.has(String(externalId))) return true;
  if (username != null && EXCLUDED_USERNAMES.has(String(username).toLowerCase())) return true;
  return false;
}

// ---------- service token ----------
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function expectedTokenHash(env) {
  const h = String((env || process.env).FEED_INGEST_TOKEN_HASH || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}
function tokenOk(presented, env) {
  const expected = expectedTokenHash(env);
  if (!expected || !presented) return false;
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- numbers ----------
// Only a finite number is a value. Everything else is null.
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
// A connector metric entry ({ value, rendered_text, ... }): the value
// is the number or null. rendered_text is NEVER consulted.
function metricValue(entry) { return entry ? num(entry.value) : null; }
function metricMap(entries) {
  const out = {};
  for (const e of entries || []) if (e && e.field) out[e.field] = metricValue(e);
  return out;
}
function sumNums(...vals) {
  const ns = vals.map(num).filter(v => v !== null);
  return ns.length ? ns.reduce((a, b) => a + b, 0) : null;
}
// Meta Ads values (PKG-9). The ads API family returns metric counts
// and money as numbers OR as plain numeric strings ("5000", "12.34")
// — those strings are data values in the payload, not display text,
// so a string that is exactly one plain number converts; anything
// else (abbreviated display text like "1.2K", prose, objects) is
// null, never guessed at. Money: amount_spent is a decimal amount in
// the account's currency (major units — the connector references fix
// that reading; minor units are used only where a schema identifies
// them, which this field does not), so cents = round(amount × 100),
// the same integer-cent unit the rest of the store uses.
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
function countValue(v) {
  if (typeof v === 'number') return num(v);
  if (typeof v === 'string' && PLAIN_NUMBER.test(v.trim())) return Number(v.trim());
  return null;
}
function spendToCents(v) {
  const n = countValue(v);
  return n === null ? null : Math.round(n * 100);
}

// ---------- row shape ----------
// One feed-written metrics row. All metric fields default to null;
// writers set only what the connector actually returned numerically.
function baseRow({ workspaceId, platform, source, label, date, window, windowStart, windowEnd, externalId, postId, timestamp }) {
  const row = {
    workspaceId, platform, source, label,
    date: date || null, window: window || null,
    windowStart: windowStart || null, windowEnd: windowEnd || null,
    externalId: externalId != null ? String(externalId) : null,
    timestamp: timestamp || new Date().toISOString(),
  };
  if (postId != null) row.postId = String(postId);
  for (const f of METRIC_FIELDS) row[f] = null;
  return row;
}

// ---------- normalizers (pure; CLI JSON in, store rows out) ----------
// Facebook Page account insights -> one account row for the window.
// Window dates come from the connector's own insights_time_range.
function normalizeFacebookAccount(workspaceId, pageId, json, opts = {}) {
  if (!json || !Array.isArray(json.results)) return null;
  const range = json.insights_time_range || {};
  const m = metricMap((json.results[0] || {}).metrics);
  const row = baseRow({
    workspaceId, platform: 'facebook', source: 'connector:facebook_cli', label: 'MEASURED',
    date: range.end_date || null, window: opts.window || null,
    windowStart: range.start_date || null, windowEnd: range.end_date || null,
    externalId: pageId, timestamp: opts.pulledAt,
  });
  row.followers = m.follower_count;
  row.views = m.views;
  row.reach = m.unique_viewers; // Accounts reached equivalent: unique viewers
  row.profileVisits = m.profile_visits;
  row.newFollowers = m.new_followers;
  // engagement_including_clicks has no honest field in the row shape: dropped.
  return row;
}

// Facebook Page posts (list results, optionally enriched by posts get
// results keyed by object_id) -> one row per post, lifetime counts as
// of the pull, dated to the pull window's end date.
function normalizeFacebookPosts(workspaceId, pageId, listJson, getJson, opts = {}) {
  const range = (listJson && listJson.content_date_range) || {};
  const enriched = {};
  for (const r of (getJson && getJson.results) || []) if (r && r.object_id) enriched[r.object_id] = metricMap(r.metrics);
  const rows = [];
  for (const r of (listJson && listJson.results) || []) {
    if (!r || !r.object_id) continue;
    const act = metricMap(r.activity);
    const met = { ...metricMap(r.metrics), ...(enriched[r.object_id] || {}) };
    const row = baseRow({
      workspaceId, platform: 'facebook', source: 'connector:facebook_cli', label: 'MEASURED',
      date: range.end_date || opts.windowEnd || null, window: opts.window || null,
      windowStart: range.start_date || null, windowEnd: range.end_date || opts.windowEnd || null,
      externalId: pageId, postId: r.object_id, timestamp: opts.pulledAt,
    });
    row.likes = act.reactions;
    row.comments = act.comment_count;
    row.shares = sumNums(act.shares, met.saves); // saves+shares where returned
    row.clicks = met.clicks !== null && met.clicks !== undefined ? met.clicks : met.link_clicks;
    row.reach = met.unique_viewers;
    row.views = met.views;
    rows.push(row);
  }
  return rows;
}

// Instagram account insights -> one account row for the window.
// Metrics are real numerics here; window dates are supplied by the
// caller (the connector returns a preset name, not explicit dates).
function normalizeInstagramAccount(workspaceId, accountId, json, opts = {}) {
  const acct = json && Array.isArray(json.accounts) ? json.accounts[0] : null;
  if (!acct || acct.error) return null;
  const m = acct.metrics || {};
  const row = baseRow({
    workspaceId, platform: 'instagram', source: 'connector:instagram', label: 'MEASURED',
    date: opts.windowEnd || null, window: opts.window || null,
    windowStart: opts.windowStart || null, windowEnd: opts.windowEnd || null,
    externalId: accountId, timestamp: opts.pulledAt,
  });
  row.views = num(m.ig_account_aggregated_content_views_count); // "Views"
  row.followers = num(m.instagram_account_follows_count);
  row.reach = num(m.instagram_organic_account_content_meta_viewer_count); // "Accounts reached"
  row.profileVisits = num(m.instagram_account_profile_visits_count);
  row.newFollowers = num(m.instagram_user_follower_growth);
  return row;
}

// One Instagram post: the posts-list row (numeric likes/comments)
// enriched by individual-post-insights totals when available.
function normalizeInstagramPost(workspaceId, accountId, post, postInsights, opts = {}) {
  if (!post || post.post_id == null) return null;
  const im = (postInsights && postInsights.metrics) || {};
  const total = k => (im[k] && typeof im[k] === 'object') ? num(im[k].total) : num(im[k]);
  const row = baseRow({
    workspaceId, platform: 'instagram', source: 'connector:instagram', label: 'MEASURED',
    date: String(post.created_at || '').slice(0, 10) || null,
    externalId: accountId, postId: post.post_id, timestamp: opts.pulledAt,
  });
  row.likes = total('ig_total_likes_count') !== null ? total('ig_total_likes_count') : num(post.likes);
  row.comments = total('ig_total_comments_count') !== null ? total('ig_total_comments_count') : num(post.comments);
  row.shares = sumNums(total('ig_total_shares_count'), total('ig_total_saves_count')); // saves+shares
  row.views = total('instagram_organic_media_content_views_count') !== null
    ? total('instagram_organic_media_content_views_count') : total('instagram_media_impressions_count');
  row.reach = total('instagram_organic_media_content_meta_viewer_count');
  row.followers = num(post.follower_count);
  return row;
}

// ---------- PostHog website analytics (PKG-3) ----------
// The AwakenAgain site already ships PostHog wired and inert (client
// tracker + server events, token env NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
// on the SITE — never read by this app). This feed reads daily
// aggregates back through PostHog's HogQL query API with a read-only
// personal API key held in the pull job's env (never stored here).
// Rows land in the B2 AwakenAgain workspace (brandId 'awakenagain',
// PKG-2) with platform 'website', source 'posthog', label MEASURED.
//
// Event names below are the site's REAL wired events, verified
// 2026-11-09 against lib/analytics/events.ts in the AwakenAgain tree:
// quiz_started / quiz_completed (client), checkout_initiated (client),
// order_completed (client), and the four add-to-cart events
// (soap/bundle/formula/tea). An event the wiring does not emit is
// never queried and never appears here. $pageview is PostHog's own
// built-in pageview event, captured by the site's tracker config.
const POSTHOG_ADD_TO_CART_EVENTS = ['soap_added_to_cart', 'bundle_added_to_cart', 'formula_added_to_cart', 'tea_added_to_cart'];
const POSTHOG_EVENT_FIELDS = [
  ['quiz_started', 'quizStarted'],
  ['quiz_completed', 'quizCompleted'],
  ['checkout_initiated', 'checkoutInitiated'],
  ['order_completed', 'orderCompleted'],
];

// A HogQL query API response ({ columns: [...], results: [[...]] })
// -> an array of plain objects keyed by column name. Anything that
// is not that shape yields [] (the caller treats it as no data).
function hogqlRows(resp) {
  if (!resp || !Array.isArray(resp.columns) || !Array.isArray(resp.results)) return [];
  return resp.results.filter(Array.isArray).map(vals => {
    const o = {};
    resp.columns.forEach((c, i) => { o[c] = vals[i]; });
    return o;
  });
}

// PostHog daily bundle -> ONE metrics row for the day.
// bundle: { totals, referrers, pages, events } — each a raw HogQL
// response (or null/absent when that query returned nothing usable).
// A section that is absent yields null fields — never 0. An event
// absent from the events result (PostHog GROUP BY omits zero-count
// events) contributes null; addToCart sums only the add-to-cart
// events that are present, and is null when none are.
function normalizePostHogDaily(workspaceId, date, bundle, opts = {}) {
  if (!workspaceId || !date || !bundle) return null;
  const row = baseRow({
    workspaceId, platform: 'website', source: 'posthog', label: 'MEASURED',
    date, window: 'DAILY', windowStart: date, windowEnd: date,
    externalId: null, timestamp: opts.pulledAt,
  });
  row.sessions = null;
  row.visitors = null;

  const totals = hogqlRows(bundle.totals)[0] || null;
  if (totals) {
    row.views = num(totals.pageviews); // $pageview count for the day
    row.sessions = num(totals.sessions);
    row.visitors = num(totals.visitors);
  }

  const counts = {};
  for (const r of hogqlRows(bundle.events)) if (r && r.event) counts[String(r.event)] = num(r.count);
  const events = {};
  for (const [name, field] of POSTHOG_EVENT_FIELDS) events[field] = counts[name] !== undefined ? counts[name] : null;
  events.addToCart = sumNums(...POSTHOG_ADD_TO_CART_EVENTS.map(n => (counts[n] !== undefined ? counts[n] : null)));
  row.events = events;

  const refs = hogqlRows(bundle.referrers)
    .filter(r => r && r.referrer != null && String(r.referrer) !== '')
    .map(r => ({ name: String(r.referrer), sessions: num(r.sessions) }));
  row.topReferrers = refs.length ? refs : null;

  const pages = hogqlRows(bundle.pages)
    .filter(r => r && r.path != null && String(r.path) !== '')
    .map(r => ({ path: String(r.path), views: num(r.views) }));
  row.topPages = pages.length ? pages : null;

  return row;
}

// ---------- Meta Ads insights (PKG-9) ----------
// READ-ONLY forever in this layer: the only ads read the feed ever
// performs is the campaign-level entity read (ads_get_ad_entities)
// the pull job issues after the owner's consent step (hand-step H3).
// There is no create / update / pause / activate path anywhere in
// this package — paid activation lives behind the §2.6 pipeline's
// separate per-campaign approval and is not feed machinery.
//
// The read is consent-gated: until Amber completes H3 in her own
// sitting, the pull job records 'not_configured' runs and NO ads
// rows exist, so every ads surface renders UNAVAILABLE (the §4
// summary's meta_ads entry stays BLOCKED). Nothing here can consent,
// and nothing here runs the lookup.
//
// Row shape (design §1.3b): ONE row per campaign per day — daily
// rows, window 'DAILY' with windowStart = windowEnd = the day, so a
// multi-day total is always a sum of true daily rows at render time,
// never a window aggregate stored under one date (the PKG-1 trap).
// The job pulls one explicit day per call (time_range since=until=
// the day). platform 'meta_ads', source 'connector:meta_ads', label
// MEASURED, externalId = the ad account ID Amber named at H3.
//   spendCents          integer cents from amount_spent (null when
//                       the platform returned no numeric amount)
//   impressions / reach / clicks   as reported (null when absent)
//   conversions         the PLATFORM's reported conversion outcomes,
//                       as reported. This is ads-platform attribution,
//                       stored for reference only: PKG-8's conversion
//                       and CAC/ROI figures come from RECORDED store
//                       orders, never from this field, so the two can
//                       never be blended or double-counted.
//   campaignExternalId  the Meta campaign ID, always recorded.
//   campaignId          the local PKG-6 campaign ID when the feed
//                       config's campaignMap names one for this
//                       external ID; otherwise null — the row lands
//                       workspace-level with its external ID visible,
//                       NEVER silently merged into a local campaign.
//   campaignName        the campaign's name as reported (truncated).
// Deliberately NO account-total row: PKG-8 sums this platform's
// spendCents rows for a window, so an account row on top of the
// campaign rows would double-count spend. Campaign rows are the
// complete, non-overlapping record.
//
// Envelope tolerance: the entity list is accepted as a bare array or
// under results / entities / data — the shapes this API family uses.
// Anything else yields no rows (the job treats a response with no
// usable campaign rows for a configured account as a failed pull,
// never as a day of zeros).
function metaAdsEntities(resp) {
  if (Array.isArray(resp)) return resp;
  for (const k of ['results', 'entities', 'data']) {
    if (resp && Array.isArray(resp[k])) return resp[k];
  }
  return [];
}
// True when the response carries a recognizable entity-list envelope
// (possibly empty — an account whose campaigns delivered nothing
// that day is a successful read of zero rows, not a failure). False
// for error payloads and unrecognizable shapes, which the job treats
// as failed pulls: no rows, one failed run record, nothing faked.
function metaAdsEnvelopeOk(resp) {
  return Array.isArray(resp) || ['results', 'entities', 'data'].some(k => !!resp && Array.isArray(resp[k]));
}

function normalizeMetaAdsDaily(workspaceId, accountId, date, resp, opts = {}) {
  if (!workspaceId || !accountId || !date) return [];
  const map = (opts && opts.campaignMap) || {};
  const byExt = new Map(); // a duplicated campaign in one response: last wins
  for (const e of metaAdsEntities(resp)) {
    if (!e || typeof e !== 'object') continue;
    const ext = e.campaign_id != null ? e.campaign_id : e.id;
    if (ext == null || String(ext) === '') continue;
    const campaignExternalId = String(ext);
    const row = baseRow({
      workspaceId, platform: 'meta_ads', source: 'connector:meta_ads', label: 'MEASURED',
      date, window: 'DAILY', windowStart: date, windowEnd: date,
      externalId: accountId, timestamp: opts.pulledAt,
    });
    row.clicks = countValue(e.clicks);
    row.reach = countValue(e.reach);
    row.impressions = countValue(e.impressions);
    row.spendCents = spendToCents(e.amount_spent);
    row.conversions = countValue(e.conversions);
    row.campaignExternalId = campaignExternalId;
    row.campaignId = map[campaignExternalId] ? String(map[campaignExternalId]) : null;
    const nm = e.campaign_name != null ? e.campaign_name : e.name;
    row.campaignName = nm != null ? String(nm).slice(0, 200) : null;
    byExt.set(campaignExternalId, row);
  }
  return [...byExt.values()];
}

// ---------- AwakenAgain store orders (PKG-4) ----------
// The store's own ledgers are the source of truth — three append-only
// JSONL files in the AwakenAgain app (inspected read-only 2026-11-09;
// schemas from lib/checkout/order.ts, lib/payments/stripe.ts,
// lib/subscriptions/subscriptions.ts):
//   orders ledger        OrderRecord lines: items, integer-cent
//                        total_cents, created_at, payment_method, and
//                        an OPTIONAL status ('pending_payment' |
//                        'paid' | 'cancelled'; legacy lines omit it).
//   stripe payments      StripePaymentRecord lines, written ONLY by
//     ledger             the signature-verified webhook, keyed by
//                        order_id; amount_total_cents includes tax.
//   subscriptions        SubscriptionRecord lines (append-only;
//     ledger             latest line per email is current state):
//                        status 'pending_payment' | 'active' |
//                        'cancelled'; a record becomes 'active' ONLY
//                        via owner confirmation of the first payment
//                        (confirmed_at / confirmed_by set on that line).
// The ledger records NO refunds anywhere, so this feed emits no
// refund figure — absence is stated, never estimated.
//
// PAID LAW (the site's own resolveOrderStatus, lib/payments/stripe.ts):
// a Stripe payment record for the order wins; otherwise the order
// record's own status; a missing status means 'pending_payment'.
// Revenue counts PAID orders only, at the ORDER's total_cents (never
// the payment record's tax-inclusive amount, so rails stay
// comparable). An order merely received is never revenue.
//
// STREAMS: the ledger distinguishes membership income (the
// subscription ledger) from shop orders (the orders ledger), so the
// two are separate rows per day — stream 'membership' vs 'shop'.
// Membership income = FIRST payments, counted once per
// subscription_id, on the owner-confirmation day (Denver date of
// confirmed_at); pending signups never count, and a later
// cancellation does not erase a confirmed first payment (no refund
// record exists to reverse it). The ledger carries no separate
// unlock marker in this schema, so no unlock stream is invented.
//
// AGGREGATES ONLY cross: counts and cents. Customer names, emails,
// addresses, order/subscription IDs, and line-item detail are never
// copied into an emitted row (the aggregator never reads them out),
// and scanForPii below is the enforced second line of defense at
// both the extractor and the ingest door.
const ORDER_DAILY_FIELDS = ['orders', 'ordersPaid', 'recordedRevenueCents', 'items', 'checkoutsAttempted', 'checkoutsAccepted'];
const ORDER_STREAMS = ['shop', 'membership'];
const STORE_BRAND_ID = 'awakenagain'; // PKG-2 brand B2 — the store's workspace

const _denverFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' });
// ISO timestamp -> its America/Denver calendar date (YYYY-MM-DD), or null.
function denverDate(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = {};
  for (const p of _denverFmt.formatToParts(d)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Paid resolution mirroring the site's resolveOrderStatus exactly.
function resolveOrderPaid(order, paidOrderIds) {
  if (order && paidOrderIds && paidOrderIds.has(String(order.order_id))) return true;
  return !!order && order.status === 'paid';
}

function isOrderRecordShape(r) {
  return !!r && typeof r === 'object' && typeof r.order_id === 'string'
    && typeof r.created_at === 'string' && Array.isArray(r.items)
    && typeof r.total_cents === 'number';
}

// Parsed ledger contents -> daily ordersDaily rows for a window.
// input: { orders, stripePayments, subscriptions } (arrays of parsed
// JSONL lines; malformed/non-record entries are skipped and counted
// in stats). opts: { workspaceId, fromDate, toDate } — Denver dates,
// inclusive; rows are emitted ONLY for days the ledger itself has
// activity for that stream, so a day with orders but no payments is
// a real recorded 0 and a day with no orders is simply absent
// (never a zero-filled claim). checkoutsAttempted is null: checkout
// ATTEMPTS exist only as analytics events, never as ledger records,
// and this feed reads ledgers only. checkoutsAccepted for the shop
// stream = persisted orders (intake persists only validated orders).
function aggregateStoreOrdersDaily(input, opts = {}) {
  const { orders = [], stripePayments = [], subscriptions = [] } = input || {};
  const workspaceId = opts.workspaceId;
  const from = opts.fromDate || null;
  const to = opts.toDate || null;
  const stats = { ordersSeen: 0, ordersSkipped: 0, paymentsSeen: 0, subscriptionLinesSeen: 0, subscriptionLinesSkipped: 0 };
  const paidIds = new Set();
  for (const p of stripePayments) {
    if (p && typeof p.order_id === 'string') { paidIds.add(p.order_id); stats.paymentsSeen++; }
  }
  const byKey = new Map();
  const blank = (date, stream) => ({
    workspaceId, brandId: STORE_BRAND_ID, stream, date,
    orders: 0, ordersPaid: 0, recordedRevenueCents: 0,
    items: stream === 'shop' ? 0 : null,
    checkoutsAttempted: null,
    checkoutsAccepted: stream === 'shop' ? 0 : null,
    label: 'RECORDED', source: 'store:awakenagain',
  });
  const inWindow = date => !!date && (!from || date >= from) && (!to || date <= to);
  const bump = (date, stream) => {
    const k = `${date}|${stream}`;
    if (!byKey.has(k)) byKey.set(k, blank(date, stream));
    return byKey.get(k);
  };
  for (const o of orders) {
    if (!isOrderRecordShape(o)) { stats.ordersSkipped++; continue; }
    stats.ordersSeen++;
    const date = denverDate(o.created_at);
    if (!inWindow(date)) continue;
    const row = bump(date, 'shop');
    row.orders += 1;
    row.checkoutsAccepted += 1;
    row.items += o.items.reduce((n, line) => n + (line && typeof line.quantity === 'number' ? line.quantity : 0), 0);
    if (resolveOrderPaid(o, paidIds)) { row.ordersPaid += 1; row.recordedRevenueCents += o.total_cents; }
  }
  // Membership: the FIRST owner-confirmed first payment per
  // subscription_id (the earliest 'active' line carrying confirmed_at).
  const confirmed = new Map();
  for (const s of subscriptions) {
    if (!s || typeof s !== 'object' || typeof s.subscription_id !== 'string') { stats.subscriptionLinesSkipped++; continue; }
    stats.subscriptionLinesSeen++;
    if (s.status !== 'active' || typeof s.confirmed_at !== 'string' || !s.confirmed_at) continue;
    const prev = confirmed.get(s.subscription_id);
    if (!prev || s.confirmed_at < prev.confirmed_at) confirmed.set(s.subscription_id, s);
  }
  for (const s of confirmed.values()) {
    const date = denverDate(s.confirmed_at);
    if (!inWindow(date)) continue;
    const row = bump(date, 'membership');
    row.orders += 1;
    row.ordersPaid += 1;
    row.recordedRevenueCents += (typeof s.price_cents === 'number' ? s.price_cents : 0);
  }
  const rows = [...byKey.values()].sort((a, b) => (a.date === b.date
    ? (a.stream < b.stream ? -1 : 1)
    : (a.date < b.date ? -1 : 1)));
  return { rows, stats };
}

// ---------- PII boundary scan (PKG-4) ----------
// The enforced boundary between the store's ledgers (which hold
// customer PII by necessity) and Affordable Meta (which must never
// receive any). scanForPii deep-walks a payload and returns a list of
// violations: forbidden FIELD names (customer identity fields, record
// identifiers, line-item detail fields) and forbidden VALUE patterns
// (email-shaped, phone-shaped, and ORD-/SUB- record-ID-shaped
// strings) anywhere in the structure. An empty list means clean.
// The field-name set is deliberately specific — aggregate keys the
// feed legitimately emits (workspaceId, brandId, date, orders,
// recordedRevenueCents, items-as-a-count, …) are not in it, while a
// line-item `items` ARRAY is caught structurally through its detail
// fields (product_handle / title / quantity / unit_price_cents).
const PII_FIELD_NAMES = new Set([
  'name', 'fullname', 'customer', 'customername', 'customeremail', 'customerphone',
  'email', 'emailaddress', 'phone', 'phonenumber',
  'address', 'street', 'streetaddress', 'shippingaddress', 'billingaddress',
  'zip', 'zipcode', 'postalcode', 'notes', 'customernotes',
  'orderid', 'subscriptionid', 'paymentintentid', 'stripesessionid', 'sessionid',
  'producthandle', 'title', 'unitpricecents', 'quantity', 'trackingnumber',
]);
function scanForPii(value) {
  const violations = [];
  const emailRe = /[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+/;
  const idRe = /\b(?:ORD|SUB)-[A-Z0-9]{4,}(?:-[A-Z0-9]+)*/i;
  const phoneRe = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/;
  const walk = (v, path) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        const norm = k.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (PII_FIELD_NAMES.has(norm)) violations.push(`forbidden field '${k}' at ${path || '<root>'}`);
        walk(val, path ? `${path}.${k}` : k);
      }
      return;
    }
    if (typeof v === 'string') {
      if (emailRe.test(v)) violations.push(`email-shaped value at ${path || '<root>'}`);
      if (idRe.test(v)) violations.push(`record-id-shaped value at ${path || '<root>'}`);
      if (phoneRe.test(v)) violations.push(`phone-shaped value at ${path || '<root>'}`);
    }
  };
  walk(value, '');
  return violations;
}

// ---------- upsert (natural keys; feed rows only ever match feed rows) ----------
function sameKey(a, b) {
  return a.workspaceId === b.workspaceId && a.platform === b.platform && a.date === b.date
    && (a.postId || null) === (b.postId || null) && (a.externalId || null) === (b.externalId || null)
    && (a.campaignExternalId || null) === (b.campaignExternalId || null) // PKG-9: campaigns on one account+day are distinct rows
    && a.source === b.source;
}
function upsertMetric(store, row) {
  const existing = store.find('metrics', m => sameKey(m, row));
  if (existing) { store.update('metrics', existing.id, { ...row }); return 'updated'; }
  store.insert('metrics', row);
  return 'inserted';
}
// ordersDaily natural key (PKG-4): (workspaceId, date, stream) — the
// workspace embodies the brand (B2 awakenagain) and the row also
// carries brandId. Rows written before streams existed carry no
// stream and are the shop stream by definition.
function streamOf(r) { return r && r.stream === 'membership' ? 'membership' : 'shop'; }
function upsertOrdersDaily(store, row) {
  const existing = store.find('ordersDaily', r => r.workspaceId === row.workspaceId && r.date === row.date && streamOf(r) === streamOf(row));
  if (existing) { store.update('ordersDaily', existing.id, { ...row }); return 'updated'; }
  store.insert('ordersDaily', row);
  return 'inserted';
}

// ---------- ingest ----------
// payload: { feed, workspaceId, window, startedAt, finishedAt,
//            status: 'ok'|'failed'|'not_configured', error?, label,
//            metricRows?: [...], ordersDailyRows?: [...] }
// A 'failed' payload records ONLY the run — no data rows are read
// from it, and prior data is never touched. A 'not_configured'
// payload (PKG-3: the feed's credentials are not set yet — an owner
// hand-step is pending) likewise records ONLY the run, with status
// 'not_configured': it is explicitly NOT a failure, writes no metric
// rows, and touches neither prior data nor connections state.
function ingest(store, payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Payload must be an object.' };
  const workspaceId = String(payload.workspaceId || '');
  const feed = String(payload.feed || '').slice(0, 60);
  if (!workspaceId || !feed) return { ok: false, error: 'workspaceId and feed are required.' };
  const label = LABELS.includes(payload.label) ? payload.label : 'MEASURED';
  const base = {
    workspaceId, feed,
    startedAt: payload.startedAt || new Date().toISOString(),
    finishedAt: payload.finishedAt || new Date().toISOString(),
    window: payload.window || null, label,
  };
  if (payload.status === 'failed') {
    const runRow = store.insert('feedRuns', { ...base, status: 'failed', rowsWritten: 0, error: String(payload.error || 'unknown failure').slice(0, 300) });
    logActivity(store, workspaceId, `feed:${feed}`, 'feed.failed', String(payload.error || 'unknown failure').slice(0, 200));
    return { ok: true, rowsWritten: 0, runId: runRow.id };
  }
  if (payload.status === 'not_configured') {
    const note = String(payload.error || 'feed not configured').slice(0, 300);
    const runRow = store.insert('feedRuns', { ...base, status: 'not_configured', rowsWritten: 0, error: note });
    logActivity(store, workspaceId, `feed:${feed}`, 'feed.not_configured', note.slice(0, 200));
    return { ok: true, rowsWritten: 0, runId: runRow.id };
  }
  // PII boundary (PKG-4): an 'ok' payload whose orders rows fail the
  // scan is refused WHOLE — recorded as a failed run, nothing written
  // (not even its metric rows), prior data untouched. Aggregates are
  // the only legal shape for orders data in this store.
  const rawOrders = Array.isArray(payload.ordersDailyRows) ? payload.ordersDailyRows : [];
  if (rawOrders.length) {
    const violations = scanForPii(rawOrders);
    if (violations.length) {
      const msg = `PII scan refused orders payload (${violations.length} violation(s)): ${violations.slice(0, 3).join('; ')}`.slice(0, 300);
      const runRow = store.insert('feedRuns', { ...base, status: 'failed', rowsWritten: 0, error: msg });
      logActivity(store, workspaceId, `feed:${feed}`, 'feed.failed', msg.slice(0, 200));
      return { ok: true, rowsWritten: 0, runId: runRow.id, refused: 'pii' };
    }
  }
  let rowsWritten = 0, skippedExcluded = 0;
  const touchedPlatforms = new Set();
  for (const raw of Array.isArray(payload.metricRows) ? payload.metricRows : []) {
    if (!raw || !raw.platform || !raw.date) continue;
    if (isExcludedExternal(raw.externalId, raw.username)) { skippedExcluded++; continue; }
    const row = { ...raw, workspaceId, label: LABELS.includes(raw.label) ? raw.label : label };
    for (const f of METRIC_FIELDS) row[f] = num(row[f]); // nulls stay null; nothing becomes 0
    for (const f of WEBSITE_FIELDS) if (f in row) row[f] = num(row[f]); // website extended fields, same law
    for (const f of ADS_FIELDS) if (f in row) row[f] = num(row[f]); // ads extended fields (PKG-9), same law — a string amount dies at this door; only the normalizer converts API strings
    upsertMetric(store, row);
    rowsWritten++;
    touchedPlatforms.add(raw.platform);
  }
  for (const raw of rawOrders) {
    if (!raw || !raw.date) continue;
    // Sanitized to the aggregate shape — only the known fields are
    // carried into the store, numerics through the same num() law.
    const row = {
      workspaceId,
      brandId: raw.brandId != null ? String(raw.brandId).slice(0, 60) : STORE_BRAND_ID,
      stream: ORDER_STREAMS.includes(raw.stream) ? raw.stream : 'shop',
      date: String(raw.date),
      label: 'RECORDED', source: 'store:awakenagain',
    };
    for (const f of ORDER_DAILY_FIELDS) row[f] = num(raw[f]);
    upsertOrdersDaily(store, row);
    rowsWritten++;
  }
  const runRow = store.insert('feedRuns', { ...base, status: 'ok', rowsWritten });
  // Feeds register their state on the connections rows that already
  // exist for the workspace (additive fields; the capability note is
  // never rewritten by a feed).
  for (const platform of touchedPlatforms) {
    const conn = store.find('connections', c => c.workspaceId === workspaceId && c.platform === platform);
    if (conn) store.update('connections', conn.id, { lastFeedAt: base.finishedAt, lastFeedStatus: 'ok', lastFeedRows: rowsWritten });
  }
  logActivity(store, workspaceId, `feed:${feed}`, 'feed.ingested', `${rowsWritten} rows · window ${base.window || 'n/a'}`);
  return { ok: true, rowsWritten, skippedExcluded, runId: runRow.id };
}

module.exports = {
  LABELS, METRIC_FIELDS, WEBSITE_FIELDS, ADS_FIELDS,
  EXCLUDED_EXTERNAL_IDS, EXCLUDED_USERNAMES, isExcludedExternal,
  hashToken, expectedTokenHash, tokenOk,
  num, metricValue, metricMap, sumNums, baseRow,
  normalizeFacebookAccount, normalizeFacebookPosts,
  normalizeInstagramAccount, normalizeInstagramPost,
  POSTHOG_ADD_TO_CART_EVENTS, POSTHOG_EVENT_FIELDS, hogqlRows, normalizePostHogDaily,
  countValue, spendToCents, metaAdsEntities, metaAdsEnvelopeOk, normalizeMetaAdsDaily,
  ORDER_DAILY_FIELDS, ORDER_STREAMS, STORE_BRAND_ID,
  denverDate, resolveOrderPaid, aggregateStoreOrdersDaily, scanForPii, streamOf,
  upsertMetric, upsertOrdersDaily, ingest,
};
