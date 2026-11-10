'use strict';

function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cells = splitLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] !== undefined ? cells[i].trim() : ''; });
    return row;
  });
}
function splitLine(line) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
}
function toCsv(rows, headers) {
  const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}
function rollup(metrics) {
  const byPlatform = {};
  for (const m of metrics || []) {
    const p = m.platform || 'unknown';
    const r = byPlatform[p] || (byPlatform[p] = { platform: p, posts: 0, likes: 0, comments: 0, shares: 0, clicks: 0, reach: 0 });
    r.posts += 1;
    for (const k of ['likes','comments','shares','clicks','reach']) r[k] += Number(m[k]) || 0;
  }
  return Object.values(byPlatform).sort((a, b) => b.likes + b.clicks - (a.likes + a.clicks));
}

// Numeric-or-null: only a finite number counts as a measured value.
// null / undefined / '' / non-numeric => null (UNAVAILABLE) — never 0.
function numOrNull(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

// Additive second pass (Awaken Meta PKG-1): totals grouped by
// platform x label so pulled numbers are never silently blended with
// hand-entered ones. Legacy rows carry no label — they are the
// pre-existing import path, so they group as IMPORTED. A field's value
// is the sum of its numeric values only, or null when NO row in the
// group carried a number for it (unavailableRows counts those rows) —
// a missing value is never totalled as 0.
// sessions/visitors added by Awaken Meta PKG-3 (PostHog website rows);
// spendCents/impressions/conversions added by PKG-9 (Meta Ads rows);
// rows that never carry them count them as unavailable, same null law.
const SOURCE_FIELDS = ['likes', 'comments', 'shares', 'clicks', 'reach', 'views', 'followers', 'newFollowers', 'profileVisits', 'sessions', 'visitors', 'spendCents', 'impressions', 'conversions'];
function rollupBySource(metrics) {
  const groups = {};
  for (const m of metrics || []) {
    const platform = m.platform || 'unknown';
    const label = m.label || 'IMPORTED';
    const key = platform + '|' + label;
    const g = groups[key] || (groups[key] = { platform, label, source: m.source || 'import', rows: 0, fields: {} });
    g.rows += 1;
    for (const f of SOURCE_FIELDS) {
      const cell = g.fields[f] || (g.fields[f] = { value: null, unavailableRows: 0 });
      const n = numOrNull(m[f]);
      if (n === null) cell.unavailableRows += 1;
      else cell.value = (cell.value === null ? 0 : cell.value) + n;
    }
  }
  return Object.values(groups).sort((a, b) => (a.platform + a.label).localeCompare(b.platform + b.label));
}

// The one honest rendering of a metric value: a number renders as
// itself; anything else renders UNAVAILABLE — never 0.
function formatMetric(v) {
  return numOrNull(v) === null ? 'UNAVAILABLE' : String(v);
}

module.exports = { parseCsv, toCsv, rollup, rollupBySource, formatMetric, numOrNull, SOURCE_FIELDS };
