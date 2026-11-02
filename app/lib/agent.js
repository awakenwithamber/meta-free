'use strict';
// Profile Completion Agent — a bounded, idempotent worker (a Muse Prime-style role,
// executed by Muse/the app, not a persistent autonomous agent).
//
// What it does, in order, all from the owner's canonical sheet:
//  1. Fills EMPTY workspace fields (tagline, hours) — never overwrites a set value.
//  2. Ensures the default link-page links exist (dedupes by URL).
//  3. Ensures the default auto-reply rules exist (dedupes by keyword).
//  4. Seeds the connections registry.
//  5. Writes a run report: filled / already-set / needs-owner-hand (external fields
//     the app cannot write: platform business-contact fields, pending connections).
// Running it twice fills nothing the second time.

const { CANONICAL, seedConnections } = require('./connections');

const NEEDS_HAND = [
  'Threads: link @awakenwithamber via the Meta Accounts Center connect link (owner tap).',
  'Instagram business contact email still shows the old consultant address — editable only in the Instagram app / Business Suite (owner or browser session).',
  'Facebook Page About/website/phone fields — editable in Meta Business Suite (browser session), not via API connector.',
  'WhatsApp: register 801-819-6795 in a Meta developer app (owner hand) before any API agent can run.',
  'TikTok / LinkedIn / YouTube profile fields — browser/app sessions only (no connectors).',
];

function runCompletion(store, workspace) {
  const wsId = workspace.id;
  const filled = [], alreadySet = [];

  // 1. workspace fields
  const patch = {};
  if (!workspace.tagline) { patch.tagline = CANONICAL.tagline; filled.push('workspace.tagline'); } else alreadySet.push('workspace.tagline');
  if (!workspace.hours) { patch.hours = CANONICAL.hours; filled.push('workspace.hours'); } else alreadySet.push('workspace.hours');
  let ws = workspace;
  if (Object.keys(patch).length) ws = store.update('workspaces', wsId, patch);

  // 2. default links
  const existingUrls = new Set(store.all('links', l => l.workspaceId === wsId).map(l => l.url.replace(/\/$/, '')));
  let sort = store.all('links', l => l.workspaceId === wsId).length;
  for (const link of CANONICAL.defaultLinks) {
    if (existingUrls.has(link.url.replace(/\/$/, ''))) { alreadySet.push('link:' + link.url); continue; }
    store.insert('links', { workspaceId: wsId, title: link.title, url: link.url, clicks: 0, sort: sort++ });
    filled.push('link:' + link.url);
  }

  // 3. default auto-reply rules
  const existingKw = new Set(store.all('rules', r => r.workspaceId === wsId).map(r => String(r.keyword).toLowerCase()));
  for (const rule of CANONICAL.defaultRules) {
    if (existingKw.has(rule.keyword.toLowerCase())) { alreadySet.push('rule:' + rule.keyword); continue; }
    store.insert('rules', { workspaceId: wsId, keyword: rule.keyword, reply: rule.reply, enabled: true });
    filled.push('rule:' + rule.keyword);
  }

  // 4. connections
  const before = store.all('connections', c => c.workspaceId === wsId).length;
  const conns = seedConnections(store, wsId);
  if (conns.length > before) filled.push(`connections:seeded ${conns.length - before}`); else alreadySet.push('connections');

  // 5. report
  const run = store.insert('agentRuns', { workspaceId: wsId, agent: 'profile-completion', filled, alreadySet, needsHand: NEEDS_HAND, summary: `Filled ${filled.length} field(s); ${alreadySet.length} already set; ${NEEDS_HAND.length} item(s) need the owner's hand.` });
  store.insert('notifications', { workspaceId: wsId, text: `Profile Completion Agent ran: ${run.summary}` });
  return run;
}

module.exports = { runCompletion, NEEDS_HAND };
