# Meta Free — Deployment, User Guide & Roadmap

## Deployment (pick one — all $0 to start)

### A. On your own computer / this VM (simplest, what was verified)
```bash
cd meta-free
node app/server.js          # or: PORT=8080 node app/server.js
# open http://localhost:4173
```
No install step — there are no dependencies. Node ≥20 is the only requirement.
Keep it running with any process keeper (`pm2`, `systemd`, `nohup`). Data lives in `data/db.json` — back that one file up.

### B. Free hosted tier
The app is a single Node process with no build step, so it fits free web-service tiers (e.g. Render/Fly free or trial tiers) and any VPS:
1. Push this folder to a Git repo, create a web service, start command: `node app/server.js`.
2. Set `PORT` if your host requires it (the app already reads `PORT`).
3. **Honest limits:** free tiers may sleep when idle (first visit wakes it, ~30s), may have ephemeral disks — if the disk resets, `data/db.json` resets. For anything you care about, option A (your own hardware) or a paid tiny VPS is the durable choice; the app itself stays $0 forever.

### D. Vercel (the live deployment)
Deployed at https://meta-free-awakenagain2.vercel.app. Storage is **durable**: a private
Vercel Blob store (`meta-free-db`) holds the database, so accounts and data survive
deploys and restarts — see [07 — Storage backends](07-storage.md) for how it works.
(Vercel without a connected Blob store would fall back to ephemeral `/tmp` storage.)

### C. Self-host with a domain + HTTPS
Put it behind Caddy or nginx with automatic TLS, pointed at the Node port. Set the session cookie `Secure` flag (see docs/04) once HTTPS is on.

**Nothing was deployed publicly by this build** — deployment to a public host is a consequential step left to Amber's go-ahead, with the host named.

## User guide (the 10-minute start)
1. **Register** — name, email, password, brand name. This creates your workspace and your public link-page slug.
2. **Link Page** — add your shop, booking link, socials. Share `yourhost/p/your-brand` everywhere — unlimited links, click counts included.
3. **Planner** — type in the command bar: `schedule Fall soap drop https://awakenagain.com tomorrow at 9am on instagram #handmade`, or use the form. When it's time, Copy → paste into the app → Mark published.
4. **Inbox** — log customer messages; you get a suggested reply instantly (price/hours/shipping/order intents built in). Add auto-reply rules for your FAQs.
5. **Analytics** — export a CSV from wherever you have numbers, match the columns `platform,timestamp,likes,comments,shares,clicks,reach`, import. Your history never expires and exports back out any time.
6. **Team** — Team & Settings → invite by email, share the code privately. Editors can plan; viewers can look. Nobody ever shares a password.
7. **Your data** — Export everything (JSON) for backup; import restores posts/links/rules/competitors. Wipe clears the workspace content.
8. **Ask Meta Free** (Settings) — built-in help for common questions.

## Maintenance
- Back up `data/db.json` (that's the whole database) on the file backend; on Vercel the
  durable copy is the Blob store — use Settings → Export JSON for a portable backup.
- Update = replace `app/` and `public/`; your data file is untouched by code updates.
- Tests: `npm test` (18 tests, Node's built-in runner).

## Roadmap
| Phase | Item | Blocker / note |
|---|---|---|
| v0.2 | Direct publishing to Facebook/Instagram via Meta Content Publishing API | Needs a Meta developer app + app review — Amber's hand for app creation/terms |
| v0.2 | WhatsApp Cloud API inbox (real messages in, auto-replies out) | Needs WhatsApp Business API setup for 801-819-6795 (already her chosen route from Oct 12) |
| v0.2 | Scheduler worker that flips scheduled → ready + in-app/browser notifications | None — pure build |
| v0.3 | Local LLM assistant via Ollama (offline, $0) | None — optional download of a local model |
| v0.3 | SQLite store swap, rate limiting, 2FA (TOTP), Secure cookie flag toggle | None |
| v0.4 | Fediverse publishing (Mastodon/PeerTube) — audiences you fully own | None |
| Ongoing | Evaluate Postiz/Postflare interop rather than rebuilding their platform-API breadth | Their stacks are heavier; Meta Free stays the light, owned core |
