# Meta Free

A free, local-first, self-hostable alternative to the workflow Meta One charges for.

**Meta One** (Meta Platforms, launched 15 Sep 2026, meta.com/meta-one-plans) sells creators and businesses:
Essential **$14.99/mo per profile**, Advanced **$49.99**, Expert **$149**, Max **$499** — for a verified-badge application, a 20-link bio page, metered links in posts, 30-day Story scheduling, exportable analytics with >90-day history, competitor insights (≤10), metered AI replies, and team access without password sharing.

**Meta Free recreates everything in that list that belongs to you** — unlimited link pages, unlimited planned link posts, unlimited scheduling horizon, unlimited analytics history with CSV/JSON export, unlimited competitor tracking, offline AI caption/reply help, role-based team access with invite codes — at **$0, with your data on your hardware**.

Honest limit: no third-party app can issue Meta's verified badge, run Meta's impersonation protection, or lift caps inside Meta's own apps. Meta Free says so in the product, in the audit (docs/01), and keeps a watchlist tool to help you record and report impersonators.

## Run it
```bash
node app/server.js     # Node ≥20, zero dependencies, nothing to install
# → http://localhost:4173
npm test               # 8 automated tests
```

## Docs
- [01 — Meta One feature audit](docs/01-meta-one-feature-audit.md) (verified vs reported, with sources)
- [02 — PRD + comparison matrix](docs/02-PRD-and-comparison-matrix.md)
- [03 — Architecture & stack](docs/03-architecture-and-stack.md)
- [04 — Security & privacy](docs/04-security-and-privacy.md)
- [05 — Deployment, user guide & roadmap](docs/05-deployment-user-guide-roadmap.md)

## Layout
```
app/server.js        server + REST API
app/lib/             store, auth, nl parser, assistant, analytics, plugins
public/              dashboard / planner / inbox / links / analytics / team UI
tests/               node:test suite
data/db.json         your database (created on first run; back this file up)
```

Not affiliated with Meta Platforms, Inc. "Meta One" is used only to identify the subscription this tool provides an alternative workflow to. No Meta branding, code, or assets are used.
