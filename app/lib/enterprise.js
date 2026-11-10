'use strict';
// Enterprise edition: every workspace runs the full Enterprise feature set.
// There are no tiers, no locked features, no caps to buy past, and no payment
// mechanics anywhere in Meta Free — this module is the single source of truth
// the settings view and API read from.

const EDITION = 'Enterprise';

const FREE_LINE = 'Free. No fees, no subscription, no payment — ever.';

// The standing honest limit, stated in the product (see docs/01 and docs/08):
// these are Meta-internal capabilities no external app can provide.
const HONEST_LIMIT = 'No external app can issue Meta\u2019s verified badge, provide Meta-internal impersonation protection, or lift Meta\u2019s in-app link caps. Awaken Affordable Meta does not fake these — the impersonation watchlist is a record-keeping aid to help you document and report impersonators.';

const FEATURES = [
  { id: 'link-page', name: 'Public link page', state: 'on', note: 'Unlimited links, click counts included' },
  { id: 'planner', name: 'Content planner + command bar', state: 'on', note: 'Unlimited posts, unlimited scheduling horizon' },
  { id: 'approvals', name: 'Post approval workflow', state: 'on', note: 'Draft → in review → approved, owner/editor gated' },
  { id: 'due-queue', name: 'Due queue', state: 'on', note: 'Posts whose time has come, listed ready to publish' },
  { id: 'inbox', name: 'Inbox + suggested replies', state: 'on', note: 'Local assistant, works offline' },
  { id: 'auto-reply-rules', name: 'Auto-reply rules', state: 'on', note: 'Unlimited keyword rules' },
  { id: 'analytics', name: 'Analytics', state: 'on', note: 'Unlimited history, CSV + JSON export' },
  { id: 'competitors', name: 'Competitor tracker', state: 'on', note: 'Unlimited profiles tracked' },
  { id: 'watchlist', name: 'Impersonation watchlist', state: 'on', note: 'Record-keeping aid for reports (see honest limit)' },
  { id: 'team', name: 'Team access', state: 'on', note: 'Owner / editor / viewer roles, invite codes, no seat limit, no password sharing' },
  { id: 'audit-log', name: 'Activity / audit log', state: 'on', note: 'Every key workspace event, exportable' },
  { id: 'backups', name: 'Automated backups', state: 'on', note: 'Versioned snapshots, last 7 kept, one-tap restore' },
  { id: 'connections', name: 'Connections registry + Profile Completion Agent', state: 'on', note: 'Canonical profile sheet, fill-only-empty agent runs' },
  { id: 'brand-workspaces', name: 'Brand workspaces (Awaken Meta)', state: 'on', note: 'Fixed brand set B1–B5, one workspace per brand with its claimed Pages/accounts — PKG-2' },
  { id: 'enterprise-rollup', name: 'Enterprise roll-up (Awaken Meta)', state: 'on', note: 'Platform-owner-only cross-brand totals from labeled feed data; unavailable metrics stay UNAVAILABLE, never 0 — PKG-2, gate corrected per PKG-11 F-01' },
  { id: 'campaigns', name: 'Campaign Command Center (Awaken Meta)', state: 'on', note: 'Draft marketing campaigns in the brand workspaces: 7 templates, evidence-gated per-campaign approvals, budget caps stay at zero by default — nothing activates or spends without the owner — PKG-6' },
  { id: 'audiences', name: 'Segments, personas + A/B records (Awaken Meta)', state: 'on', note: 'Audience segments sized only from labeled data (unavailable stays UNAVAILABLE, never invented), owner-authored persona planning drafts, and A/B test records whose winner guard requires labeled results, full-window coverage, and a minimum sample — PKG-7' },
  { id: 'campaign-measurement', name: 'Campaign measurement + flagging (Awaken Meta)', state: 'on', note: 'Fixed measurement definitions computed from labeled inputs only: reach and engagement from measured social rows, conversions and revenue only from recorded paid orders, acquisition cost and return only when real spend and revenue both exist — anything missing renders UNAVAILABLE with its reason, and underperformance is flagged for a human, never acted on — PKG-8' },
  { id: 'plugins', name: 'Plugin registry', state: 'on', note: 'Built-in plugins included; roadmap plugins land free when built' },
  { id: 'data-portability', name: 'Full data export / import / wipe', state: 'on', note: 'Your data is yours — JSON out any time' },
];

function features() { return FEATURES.map(f => ({ ...f })); }
function isEnterprise(workspace) { return !workspace || !workspace.edition || workspace.edition === EDITION; }

module.exports = { EDITION, FREE_LINE, HONEST_LIMIT, FEATURES, features, isEnterprise };
