# 08 — Enterprise Edition

Meta Free has one edition: **Enterprise**. Every workspace gets every feature, with
nothing metered, nothing locked, and no way to pay for anything — there is no billing
code, no checkout, and no price displayed anywhere in the app or these docs.

**Free. No fees, no subscription, no payment — ever.**

## What's on for every workspace

Managed in `app/lib/enterprise.js` (single source of truth; the Enterprise settings
view and `GET /api/enterprise` read from it):

- Link page — unlimited links with click counts
- Content planner + natural-language command bar — unlimited posts, unlimited horizon
- Post approval workflow (below)
- Due queue (below)
- Inbox with local suggested replies — offline, unmetered
- Auto-reply rules — unlimited
- Analytics — unlimited history, CSV + JSON export
- Competitor tracker — unlimited
- Impersonation watchlist — record-keeping for reports
- Team access — owner/editor/viewer roles, invite codes, no seat limit
- Activity / audit log (below)
- Automated backups (below)
- Connections registry + Profile Completion Agent
- Plugin registry
- Full data export / import / wipe

Caps audit (2026-11-02): the codebase was swept for functional caps. The analytics
endpoint's last-200-rows display cut was removed — it now returns the full history.
What remains are input-safety bounds (caption/message field lengths, the request-body
size guard) and dashboard preview truncations (next 5 upcoming posts, last 5
notifications) — presentation, not feature limits. The Activity view and exports
always show everything.

## Post approval workflow

Posts carry an `approval` state next to their scheduling `status`
(`app/lib/approvals.js`):

```
draft → pending_review → approved → (status: scheduled → published)
```

- Any step can send a post back to `draft`.
- Draft cannot jump straight to approved — it passes through review.
- Owners and editors can move posts through the flow; viewers cannot change
  anything (same role model as the rest of the app).
- Posts typed into the command bar enter already approved — the command is the
  author's own instruction.
- Posts created before this feature have no approval field and are treated as
  approved, so existing queues keep working.

## Due queue

`GET /api/due` lists scheduled posts whose time has arrived, split into
**ready** (approved — cleared to publish) and **awaitingApproval**. The Planner's
"Due — ready to publish" card works from it: Copy → paste into the platform app →
Mark published. The first time a post shows up as due, a notification is recorded.
Meta Free cannot post into Meta's apps directly (that needs a Meta developer app +
review — a roadmap item), and the UI says so rather than faking it.

## Activity / audit log

`app/lib/activity.js` writes one row per key event — post created / status /
approval / deleted, link added / removed, rule added / removed, team invites and
joins, metrics imports, agent runs, settings changes, data import / wipe, backup
created / restored — each with the actor's email and a timestamp. The Activity view
lists them newest-first; `GET /api/activity/export.csv` exports them. Audit rows
are workspace-scoped and ride the normal durable storage, workspace JSON export,
and backups.

## Automated backups

`app/lib/backups.js` snapshots the whole database:

- Blob mode: `meta-free/backups/<timestamp>.json` in the same private store.
- File mode: `<data dir>/backups/<timestamp>.json`.
- Newest 7 are kept; older snapshots are pruned when a new one is taken.
- **Back up now** button (owner) in Enterprise settings; a snapshot is also taken
  automatically before every import, wipe, and restore.
- Restore (owner) replaces the database with the chosen snapshot — after first
  taking a safety snapshot of the current state, so a restore is itself undoable.

## Multi-workspace note

The data model stores memberships per user, but the session resolves to a single
active membership and the join flow moves (rather than adds) membership — surfacing
a workspace switcher would mean re-architecting session/auth resolution. It was
deliberately **not** forced in this pass; one account = one active workspace
remains the model, with team invites as the way people share a workspace.

## The honest limit, unchanged

No external app can issue Meta's verified badge, provide Meta-internal
impersonation protection, or lift Meta's in-app link caps. Enterprise Edition does
not fake these — the watchlist stays a record-keeping aid, and direct publishing
stays a roadmap item until a Meta developer app exists.
