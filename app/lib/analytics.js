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

module.exports = { parseCsv, toCsv, rollup };
