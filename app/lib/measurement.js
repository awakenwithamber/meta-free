'use strict';
// Awaken Meta PKG-8 — campaign measurement + flagging (design §2.2
// measurement definitions, §2.6 step 5, §5.1 PKG-8).
//
// The measurement engine computes a campaign's fixed metrics from
// LABELED inputs only, and every figure it returns carries the label
// of the data it came from:
//
//   - reach / impressions / clicks / engagement — from MEASURED
//     social rows (PKG-1 feed rows) in the campaign's workspace and
//     measurement window. Per-post rows are preferred; account rows
//     are the fallback when a platform has no per-post rows in the
//     window (the two kinds are never summed together — that would
//     double-count). CTR is computed PER PLATFORM, never blended:
//     the campaign-level ctr is only stated when exactly one
//     platform contributes one.
//   - conversions / revenue — ONLY from RECORDED ordersDaily rows
//     in the window (PKG-4 store aggregates). A conversion is a
//     PAID order (ordersPaid); revenue is recordedRevenueCents.
//     Merely-ordered (unpaid) volume never counts. ordersDaily rows
//     are workspace aggregates — the store feed does not attribute
//     orders to individual campaigns, and the measurement says so.
//   - spend — ONLY from MEASURED meta_ads rows carrying spendCents
//     (PKG-9's feed; absent until the owner's consent step). The
//     campaign's budget CAP is not spend and is never used as one.
//   - CAC = spend ÷ conversions, ROI = (revenue − spend) ÷ spend —
//     computed only when BOTH inputs are real labeled figures.
//     With $0 caps and no ads feed, both stay UNAVAILABLE and the
//     measurement states why, in plain language.
//
// UNAVAILABLE law (design §0.3): any figure whose inputs are missing
// is null with label 'UNAVAILABLE' and a stated reason — never an
// estimate, never a zero filled in for missing data. A figure that
// is genuinely zero (measured rows exist and sum to zero, recorded
// rows exist with zero paid orders) is stated as 0 with its label.
//
// The flagger (design §2.2 underperformer detection) FLAGS — never
// acts. Flags land on the campaign row (campaign.flags) in the
// summary contract's shape ({ kind, text, brandId } + campaignId +
// raisedAt) and, for the measurement-failed state, on the
// campaign.measurementFailed field the PKG-5 summary builder already
// translates to the owner's FAILED status. NOTE (verified against
// PKG-5's builder, scripts/build-marketing-summary.js in the
// AwakenFlow tree): the builder generates its own feed_stale flags
// and reads campaign.measurement + campaign.measurementFailed, but
// it does not yet read campaign.flags — surfacing those in the
// summary flags[] is a one-mapping /empire-side change, documented
// in PKG-8-REPORT.md. Nothing in AwakenFlow was edited by PKG-8.
//
// A/B feeding: feedAbTestResults turns this engine's labeled
// per-post outputs into PKG-7 A/B result rows (via audiences'
// recordResult, source-labeled MEASURED), satisfying the winner
// guard's inputs. Variants are told apart by the operator assigning
// the campaign's measured posts to variants — the engine never
// guesses which post belonged to which variant.
const campaigns = require('./campaigns');
const audiences = require('./audiences');
const { logActivity } = require('./activity');

const SOCIAL_PLATFORMS = ['facebook', 'instagram'];
const STALE_FEED_MS = 36 * 3600 * 1000; // design §1.5
const EVIDENCE_STALE_DAYS = 14;
// Opportunity threshold: measured engagement rate at or above this,
// on at least MIN_OPPORTUNITY_REACH measured reach, is flagged as an
// opportunity (a recommendation — never an action).
const OPPORTUNITY_ENGAGEMENT_RATE = 0.05;
const MIN_OPPORTUNITY_REACH = 100;

function fail(status, errors) { return { ok: false, status, errors: Array.isArray(errors) ? errors : [errors] }; }
function numOrNull(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function dateOf(v) {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
function todayDenver(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(now || new Date());
}
function sumField(rows, field) {
  let total = null;
  for (const r of rows) {
    const n = numOrNull(r[field]);
    if (n !== null) total = (total === null ? 0 : total) + n;
  }
  return total;
}
// A row's impressions: the impressions field where the platform
// reports one, else its views (the feed's per-post mapping stores
// the platform's view count in `views`).
function rowImpressions(r) {
  const i = numOrNull(r.impressions);
  return i !== null ? i : numOrNull(r.views);
}
function sumImpressions(rows) {
  let total = null;
  for (const r of rows) {
    const n = rowImpressions(r);
    if (n !== null) total = (total === null ? 0 : total) + n;
  }
  return total;
}
// Engagement per row: likes + comments + shares over whichever of
// the three the row actually carries numerically (PKG-7's rule).
function rowEngagement(r) {
  let n = 0, seen = false;
  for (const k of ['likes', 'comments', 'shares']) {
    const v = numOrNull(r[k]);
    if (v !== null) { n += v; seen = true; }
  }
  return seen ? n : null;
}
function sumEngagement(rows) {
  let total = null;
  for (const r of rows) {
    const n = rowEngagement(r);
    if (n !== null) total = (total === null ? 0 : total) + n;
  }
  return total;
}
function figure(value, label, reason) {
  return value === null || value === undefined
    ? { value: null, label: 'UNAVAILABLE', reason: reason || 'No labeled inputs.' }
    : { value, label, reason: null };
}

// ---------- the measurement window ----------
// [startsOn, endsOn] when the campaign carries flight dates; else
// [creation date, asOf]. Callers may override either end.
function windowOf(campaign, opts) {
  const o = opts || {};
  const asOf = dateOf(o.asOf) || todayDenver(o.now ? new Date(o.now) : undefined);
  const start = dateOf(o.windowStart) || dateOf(campaign.startsOn) || dateOf(campaign.createdAt) || asOf;
  const end = dateOf(o.windowEnd) || dateOf(campaign.endsOn) || asOf;
  return { start, end, asOf };
}
function inWindow(dateStr, w) {
  const d = dateOf(dateStr);
  return d !== null && d >= w.start && d <= w.end;
}

// ---------- per-platform social measurement ----------
function measurePlatform(rows) {
  const postRows = rows.filter(r => r.postId);
  const chosen = postRows.length ? postRows : rows.filter(r => !r.postId);
  const reach = sumField(chosen, 'reach');
  const impressions = sumImpressions(chosen);
  const clicks = sumField(chosen, 'clicks');
  const engagement = sumEngagement(chosen);
  const ctr = (clicks !== null && impressions !== null && impressions > 0)
    ? Math.round((clicks / impressions) * 10000) / 10000 : null;
  return { rowsUsed: chosen.length, rowKind: postRows.length ? 'per-post' : 'account', reach, impressions, clicks, engagement, ctr };
}

// ---------- the engine ----------
function computeMeasurement(store, ws, campaign, opts) {
  const w = windowOf(campaign, opts || {});
  const measuredAt = new Date(((opts || {}).now) || Date.now()).toISOString();

  // Social inputs: MEASURED rows only. Anything else in the metrics
  // collection (IMPORTED, unlabeled) is counted as rejected, never used.
  const allSocial = store.all('metrics', r => r.workspaceId === ws.id && SOCIAL_PLATFORMS.includes(r.platform));
  const socialRows = allSocial.filter(r => r.label === 'MEASURED' && inWindow(r.date || r.timestamp, w));
  const perPlatform = {};
  for (const p of SOCIAL_PLATFORMS) perPlatform[p] = measurePlatform(socialRows.filter(r => r.platform === p));
  const combine = field => {
    const vals = SOCIAL_PLATFORMS.map(p => perPlatform[p][field]).filter(v => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const reach = combine('reach');
  const impressions = combine('impressions');
  const clicks = combine('clicks');
  const engagement = combine('engagement');
  const ctrPlatforms = SOCIAL_PLATFORMS.filter(p => perPlatform[p].ctr !== null);
  const ctr = ctrPlatforms.length === 1 ? perPlatform[ctrPlatforms[0]].ctr : null;

  // Conversions / revenue: RECORDED ordersDaily only, paid orders only.
  const allOrders = store.all('ordersDaily', r => r.workspaceId === ws.id);
  const orderRows = allOrders.filter(r => r.label === 'RECORDED' && inWindow(r.date, w));
  const conversions = orderRows.length ? sumField(orderRows, 'ordersPaid') : null;
  const revenueCents = orderRows.length ? sumField(orderRows, 'recordedRevenueCents') : null;
  const ordersRecorded = orderRows.length ? sumField(orderRows, 'orders') : null;

  // Spend: MEASURED meta_ads rows carrying a numeric spendCents.
  const spendRows = store.all('metrics', r => r.workspaceId === ws.id && r.platform === 'meta_ads'
    && r.label === 'MEASURED' && inWindow(r.date || r.timestamp, w) && numOrNull(r.spendCents) !== null);
  const spendCents = spendRows.length ? spendRows.reduce((n, r) => n + r.spendCents, 0) : null;

  // CAC / ROI: only from BOTH real inputs.
  const cacReasons = [];
  if (spendCents === null) cacReasons.push(campaign.budgetCapCents > 0
    ? 'no MEASURED spend has been recorded for this campaign’s window — a budget cap is not spend, so CAC is not derived from it'
    : 'no spend is recorded — this campaign’s budget cap is $0 and no MEASURED ads spend rows exist for its window (the ads feed lands with PKG-9, after the owner’s consent step)');
  if (conversions === null) cacReasons.push('no RECORDED conversions exist for the window');
  else if (conversions === 0) cacReasons.push('recorded conversions for the window are zero, so a per-conversion cost cannot be divided out');
  const cacCents = (spendCents !== null && conversions !== null && conversions > 0)
    ? Math.round(spendCents / conversions) : null;
  const roiReasons = [];
  if (spendCents === null) roiReasons.push('ROI needs a real spend figure; none is recorded (see CAC)');
  else if (spendCents === 0) roiReasons.push('recorded spend for the window is $0, so a return ratio cannot be divided out');
  if (revenueCents === null) roiReasons.push('no RECORDED revenue exists for the window');
  const roi = (spendCents !== null && spendCents > 0 && revenueCents !== null)
    ? Math.round(((revenueCents - spendCents) / spendCents) * 10000) / 10000 : null;

  const noSocial = 'No MEASURED social rows exist for this workspace in the campaign window.';
  const metrics = {
    reach: figure(reach, 'MEASURED', noSocial),
    impressions: figure(impressions, 'MEASURED', noSocial),
    clicks: figure(clicks, 'MEASURED', noSocial),
    engagement: figure(engagement, 'MEASURED', noSocial),
    ctr: ctr !== null
      ? { value: ctr, label: 'MEASURED', reason: null }
      : { value: null, label: 'UNAVAILABLE', reason: ctrPlatforms.length > 1
          ? 'More than one platform has a CTR for this window — CTR is stated per platform (see perPlatform), never blended into one figure.'
          : 'CTR needs MEASURED clicks and impressions for the same platform and window; one or both are missing.' },
    conversions: figure(conversions, 'RECORDED', 'No RECORDED store rows (ordersDaily) exist for this workspace in the campaign window.'),
    revenueCents: figure(revenueCents, 'RECORDED', 'No RECORDED store rows (ordersDaily) exist for this workspace in the campaign window.'),
    spendCents: figure(spendCents, 'MEASURED', 'No MEASURED ads spend rows exist for this window.'),
    cacCents: cacCents !== null ? { value: cacCents, label: 'MEASURED/RECORDED', reason: null }
      : { value: null, label: 'UNAVAILABLE', reason: cacReasons.join('; ') + '.' },
    roi: roi !== null ? { value: roi, label: 'MEASURED/RECORDED', reason: null }
      : { value: null, label: 'UNAVAILABLE', reason: roiReasons.join('; ') + '.' },
  };

  // The summary-facing block (PKG-5 contract shape, exactly the
  // fields its builder reads): label is MEASURED when social inputs
  // produced figures, RECORDED when only store inputs did, else
  // UNAVAILABLE — and UNAVAILABLE always pairs with nulls.
  const label = (reach !== null || impressions !== null || engagement !== null) ? 'MEASURED'
    : (conversions !== null || revenueCents !== null) ? 'RECORDED' : 'UNAVAILABLE';

  return {
    label,
    impressions: label === 'UNAVAILABLE' ? null : impressions,
    ctr: label === 'UNAVAILABLE' ? null : ctr,
    conversions: label === 'UNAVAILABLE' ? null : conversions,
    cacCents: label === 'UNAVAILABLE' ? null : cacCents,
    window: { start: w.start, end: w.end },
    measuredAt,
    metrics,
    perPlatform,
    inputs: {
      socialRows: socialRows.length,
      socialRowsRejected: allSocial.filter(r => inWindow(r.date || r.timestamp, w) && r.label !== 'MEASURED').length,
      ordersRows: orderRows.length,
      ordersRowsRejected: allOrders.filter(r => inWindow(r.date, w) && r.label !== 'RECORDED').length,
      spendRows: spendRows.length,
      sources: [...new Set([...socialRows.map(r => r.source), ...orderRows.map(r => r.source), ...spendRows.map(r => r.source)].filter(Boolean))],
    },
    notes: [
      'Conversions and revenue are this workspace’s RECORDED paid orders inside the campaign window — the store feed records orders per workspace and day, not per campaign, so they are the campaign window’s recorded store outcome, not a per-campaign attribution.',
      'Reach from per-post rows sums each post’s own unique-viewer count; the same person seeing two posts counts once per post.',
    ],
  };
}

// ---------- the flagger ----------
function latestFeedRun(store, ws, feed) {
  const runs = store.all('feedRuns', r => r.workspaceId === ws.id && r.feed === feed)
    .sort((a, b) => String(b.finishedAt || b.startedAt || '').localeCompare(String(a.finishedAt || a.startedAt || '')));
  return runs[0] || null;
}
function feedFailedNow(store, ws) {
  const latest = latestFeedRun(store, ws, 'social_insights');
  if (!latest || latest.status !== 'failed') return false;
  const okAt = store.all('feedRuns', r => r.workspaceId === ws.id && r.feed === 'social_insights' && r.status === 'ok')
    .map(r => r.finishedAt || r.startedAt).filter(Boolean).sort().pop();
  const failedAt = latest.finishedAt || latest.startedAt || '';
  return !okAt || okAt <= failedAt;
}
function feedStale(store, ws, asOfMs) {
  const okRuns = store.all('feedRuns', r => r.workspaceId === ws.id && r.feed === 'social_insights' && r.status === 'ok');
  if (!okRuns.length) return true;
  const lastOk = Math.max(...okRuns.map(r => Date.parse(r.finishedAt || r.startedAt || '') || 0));
  return asOfMs - lastOk > STALE_FEED_MS;
}

// Pure: given a campaign + its measurement, what flags apply and
// should the campaign carry the measurement-failed state?
function evaluateFlags(store, ws, campaign, measurement, opts) {
  const o = opts || {};
  const w = windowOf(campaign, o);
  const asOfMs = Date.parse((o.asOf || w.asOf) + 'T23:59:59Z');
  const windowElapsed = w.end < w.asOf;
  const live = ['active', 'paused', 'completed'].includes(campaign.status);
  const flags = [];
  const add = (kind, text) => flags.push({ kind, text, brandId: ws.brandId || campaign.brandId || null, campaignId: campaign.id, raisedAt: new Date((o.now || Date.now())).toISOString() });
  const m = measurement.metrics;
  let measurementFailed = false;

  if (live && windowElapsed && measurement.inputs.socialRows === 0 && measurement.inputs.ordersRows === 0) {
    measurementFailed = true;
    add('measurement_failed', `Campaign “${campaign.name}” finished its measurement window (${w.start} to ${w.end}) with no labeled data at all — no MEASURED social rows and no RECORDED store rows — so nothing about it can be measured. It reports FAILED in the summary until labeled data exists.`);
  }
  if (live && feedFailedNow(store, ws)) {
    measurementFailed = true;
    add('measurement_failed', `The social insights feed’s latest run failed for this workspace, so campaign “${campaign.name}” cannot be measured from fresh data right now. It reports FAILED in the summary until a feed run succeeds.`);
  }
  if (live && windowElapsed && m.reach.value === 0) {
    add('underperformer', `Campaign “${campaign.name}” recorded zero measured reach across its whole window (${w.start} to ${w.end}) — the content was published but reached nobody the feeds can see. Worth a human look before running its like again.`);
  }
  if (live && windowElapsed && m.reach.value !== null && m.reach.value > 0 && m.conversions.value === 0) {
    add('underperformer', `Campaign “${campaign.name}” reached ${m.reach.value} (MEASURED) in its window but recorded zero paid conversions (RECORDED) in the same window — reach is not turning into recorded store outcomes yet.`);
  }
  if (campaign.status === 'active' && feedStale(store, ws, asOfMs)) {
    add('feed_stale', `The social insights evidence behind campaign “${campaign.name}” is stale — no successful feed run in over 36 hours — so its measured figures are older than they look. The feed state, not the campaign, needs attention.`);
  }
  if (m.engagement.value !== null && m.reach.value !== null && m.reach.value >= MIN_OPPORTUNITY_REACH
    && m.engagement.value / m.reach.value >= OPPORTUNITY_ENGAGEMENT_RATE) {
    add('opportunity', `Campaign “${campaign.name}” is engaging strongly: ${m.engagement.value} measured engagements on ${m.reach.value} measured reach (${Math.round((m.engagement.value / m.reach.value) * 1000) / 10}%). A follow-up or an A/B test on this angle is worth drafting — a recommendation only; nothing runs itself.`);
  }
  const checkedAt = campaign.evidenceCheck && campaign.evidenceCheck.checkedAt;
  if (checkedAt && ['draft', 'in_review', 'approved', 'active'].includes(campaign.status)) {
    const ageDays = (asOfMs - Date.parse(checkedAt)) / 86400000;
    if (ageDays > EVIDENCE_STALE_DAYS) {
      add('evidence_stale', `Campaign “${campaign.name}”’s evidence check is ${Math.floor(ageDays)} days old — prices and feature claims were verified then, not now. Re-verify the evidence before this campaign is relied on or extended.`);
    }
  }
  return { flags, measurementFailed };
}

// Measure + flag a campaign and persist the results on its row:
// campaign.measurement (PKG-5 contract block + detail),
// campaign.flags, campaign.measurementFailed, campaign.measuredAt.
function measureCampaign(store, ws, id, actor, opts) {
  if (!ws) return fail(400, 'Workspace not found.');
  if (!ws.brandId) return fail(400, 'Measurement lives in the Awaken Meta brand workspaces. This workspace isn’t one of them.');
  const c = campaigns.findCampaign(store, ws, id);
  if (!c) return fail(404, 'Campaign not found.');
  const measurement = computeMeasurement(store, ws, c, opts || {});
  const { flags, measurementFailed } = evaluateFlags(store, ws, c, measurement, opts || {});
  const updated = store.update('campaigns', c.id, {
    measurement, flags, measurementFailed, measuredAt: measurement.measuredAt,
    updatedAt: new Date().toISOString(),
  });
  logActivity(store, ws.id, actor && actor.email, 'campaign.measured',
    `${c.name} · window ${measurement.window.start}..${measurement.window.end} · label ${measurement.label} · reach ${measurement.metrics.reach.value === null ? 'UNAVAILABLE' : measurement.metrics.reach.value} · conversions ${measurement.metrics.conversions.value === null ? 'UNAVAILABLE' : measurement.metrics.conversions.value}`);
  if (flags.length) {
    logActivity(store, ws.id, actor && actor.email, 'campaign.flagged',
      `${c.name} · ${flags.map(f => f.kind).join(', ')}`);
  }
  return { ok: true, status: 200, campaign: updated, measurement, flags };
}

// ---------- A/B feeding ----------
// Turn the engine's labeled per-post outputs into PKG-7 A/B result
// rows. The operator assigns the campaign's measured posts to
// variants (variantPostIds: { <variantKey>: [postId, ...] }); the
// engine sums the MEASURED per-post rows for those posts inside the
// test window and records one result row per variant through
// audiences.recordResult — label MEASURED, source naming the engine
// and the exact posts — which is exactly what the winner guard
// (conclusionBlockers) requires: labeled rows, a sample (the summed
// impressions), and periods covering the full test window (the
// engine attests it measured the whole window; the row's period IS
// the test window). Any variant with no measured rows refuses the
// whole feed — a partial feed would poison the guard's inputs.
function feedAbTestResults(store, ws, abTestId, input, actor) {
  if (!ws) return fail(400, 'Workspace not found.');
  if (!ws.brandId) return fail(400, 'A/B feeding lives in the Awaken Meta brand workspaces. This workspace isn’t one of them.');
  const t = audiences.findAbTest(store, ws, abTestId);
  if (!t) return fail(404, 'A/B test not found.');
  if (t.status === 'concluded' || t.status === 'archived') {
    return fail(400, 'This test is closed — results are no longer recorded on it.');
  }
  const assignments = (input && input.variantPostIds) || {};
  const errors = [];
  const perVariant = {};
  for (const v of t.variants || []) {
    const postIds = assignments[v.key];
    if (!Array.isArray(postIds) || !postIds.length) {
      errors.push(`Variant “${v.key}” has no posts assigned — assign the measured posts that ran as this variant (variantPostIds).`);
      continue;
    }
    const rows = store.all('metrics', r => r.workspaceId === ws.id && r.label === 'MEASURED'
      && r.postId && postIds.includes(r.postId)
      && inWindow(r.date || r.timestamp, { start: t.windowStart, end: t.windowEnd }));
    if (!rows.length) {
      errors.push(`Variant “${v.key}”’s assigned posts have no MEASURED rows in the test window (${t.windowStart} to ${t.windowEnd}) — nothing labeled exists to feed.`);
      continue;
    }
    const impressions = sumImpressions(rows);
    const clicks = sumField(rows, 'clicks');
    const reach = sumField(rows, 'reach');
    const counts = {};
    if (impressions !== null) counts.impressions = impressions;
    if (clicks !== null) counts.clicks = clicks;
    if (reach !== null) counts.reach = reach;
    perVariant[v.key] = {
      counts,
      sampleSize: impressions !== null ? impressions : (reach || 0),
      postIds: [...new Set(rows.map(r => r.postId))],
      sources: [...new Set(rows.map(r => r.source).filter(Boolean))],
    };
  }
  if (errors.length) return fail(400, errors);
  let updated = t;
  for (const v of t.variants) {
    const pv = perVariant[v.key];
    const r = audiences.recordResult(store, ws, t.id, {
      variantKey: v.key,
      label: 'MEASURED',
      source: `PKG-8 measurement engine · MEASURED rows (${pv.sources.join(', ') || 'connector feed'}) · posts ${pv.postIds.join(', ')}`,
      counts: pv.counts,
      sampleSize: pv.sampleSize,
      periodStart: t.windowStart,
      periodEnd: t.windowEnd,
      note: 'Fed from the campaign measurement engine’s labeled outputs — not hand-entered.',
    }, actor);
    if (!r.ok) return r;
    updated = r.abTest;
  }
  return { ok: true, status: 201, abTest: updated, fed: perVariant };
}

module.exports = {
  SOCIAL_PLATFORMS, STALE_FEED_MS, EVIDENCE_STALE_DAYS,
  OPPORTUNITY_ENGAGEMENT_RATE, MIN_OPPORTUNITY_REACH,
  windowOf, computeMeasurement, evaluateFlags, measureCampaign,
  feedAbTestResults, feedFailedNow, feedStale,
};
