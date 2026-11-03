# Meta Free — Enterprise Edition

A free, local-first, self-hostable alternative to the workflow Meta One reserves for its paid tiers.

**Free. No fees, no subscription, no payment — ever.**

**Meta One** (Meta Platforms, launched 15 Sep 2026, meta.com/meta-one-plans) sells creators and businesses a verified-badge application, a capped link page, metered links in posts, Story scheduling windows, exportable analytics with history limits, capped competitor insights, metered AI replies, and team access — tier by tier, profile by profile.

**Meta Free recreates everything in that list that belongs to you, at the Enterprise level, for every workspace** — unlimited link pages, unlimited planned link posts, unlimited scheduling horizon, unlimited analytics history with CSV/JSON export, unlimited competitor tracking, offline AI caption/reply help, role-based team access with invite codes, a post approval workflow, a due queue, an activity/audit log, and automated backups — with your data on your hardware.

Honest limit: no third-party app can issue Meta's verified badge, run Meta's impersonation protection, or lift caps inside Meta's own apps. Meta Free says so in the product, in the audit (docs/01), and keeps a watchlist tool to help you record and report impersonators.

## Run it
```bash
node app/server.js     # Node ≥20, zero dependencies, nothing to install
# → http://localhost:4173
npm test               # 26 automated tests
```

## Docs
- [01 — Meta One feature audit](docs/01-meta-one-feature-audit.md) (verified vs reported, with sources)
- [02 — PRD + comparison matrix](docs/02-PRD-and-comparison-matrix.md)
- [03 — Architecture & stack](docs/03-architecture-and-stack.md)
- [04 — Security & privacy](docs/04-security-and-privacy.md)
- [05 — Deployment, user guide & roadmap](docs/05-deployment-user-guide-roadmap.md)
- [06 — Connections & the Profile Completion Agent](docs/06-connections-and-agent.md)
- [07 — Storage backends](docs/07-storage.md) (local file, or durable private Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set)
- [08 — Enterprise Edition](docs/08-enterprise.md) (everything on: approvals, due queue, audit log, backups — and no payments, anywhere)

## Layout
```
app/server.js        server + REST API
app/lib/             store (+ durable Blob backend), auth, nl parser, assistant, analytics, plugins,
                     enterprise (edition + features), activity (audit log), approvals, backups
public/              dashboard / planner / inbox / links / analytics / connect / activity / enterprise / team UI
tests/               node:test suite
data/db.json         your database (created on first run; back this file up)
```

Not affiliated with Meta Platforms, Inc. "Meta One" is used only to identify the subscription this tool provides an alternative workflow to. No Meta branding, code, or assets are used.
