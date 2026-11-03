# Meta Free — Architecture & Technology Stack

## Stack decision (why zero-dependency Node)
| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 24 (built-ins only) | Already on Amber's VM; zero `npm install`, zero supply-chain risk, runs anywhere Node runs |
| Server | `node:http` custom micro-framework (app/server.js) | No Express dependency to maintain or pay for |
| Storage | JSON file DB with atomic writes (app/lib/store.js) | Human-readable, trivially backed up/exported; swap point for SQLite/Postgres documented below |
| Auth | `node:crypto` scrypt + random session tokens, httpOnly cookies | Industry-standard password hashing, no auth SaaS |
| Frontend | Vanilla HTML/CSS/JS in `public/` | No build step, <50KB, works offline after first load, accessible semantic markup |
| AI assistant | Local rule-based engine (app/lib/assistant.js) | Free, offline, private; interface shaped so Ollama/local LLM can drop in later |
| Tests | `node --test` (built-in) | No test-framework dependency |

**Cost to run: nothing** on a machine you already have; free tiers that fit it: Cloudflare/VPS free tiers, a Fly/Render free web service, or your own computer. Honest limit: free hosted tiers sleep/cold-start and have small disks — for always-on use, self-host on hardware you own.

## Architecture
```
public/            Browser UI (dashboard, planner, inbox, analytics, links, team, settings)
  index.html  app.js  styles.css
app/
  server.js        HTTP server, routing, session middleware, API
  lib/
    store.js       JSON store: users, workspaces, posts, links, messages, metrics, rules, members, plugins
    auth.js        scrypt hash/verify, session create/check
    nl.js          Natural-language command parser ("schedule X tomorrow 9am on instagram #tags")
    assistant.js   Local AI: caption drafts, hashtag sets, reply suggestions, best-time heuristic, error hints
    analytics.js   Metric rollups, CSV parse/serialize
    plugins.js     Plugin registry (manifest-based, enable/disable per workspace)
    enterprise.js  Enterprise edition: feature registry, honest-limit statement
    activity.js    Activity / audit log (workspace-scoped event rows)
    approvals.js   Post approval state machine + due queue
    backups.js     Versioned DB snapshots (file or Blob), keep-last-7, restore
data/db.json       Created at first run (git-ignored, yours alone)
tests/             node:test suites for auth, nl parser, analytics, store, assistant
```

## Data flow
Browser → REST API (`/api/*`, session cookie) → lib modules → JSON store.
Public link page `/p/:slug` is the only unauthenticated route besides login/register.
Publishing to Meta platforms is a **queue + hand-off** in v0.1: posts move draft → scheduled → ready, and the UI gives a one-tap copy/open hand-off. Direct API publishing (roadmap R15) plugs into the same queue once a Meta developer app exists — no redesign needed.

## Specialist workflow map (Phase 3, as executed)
This build was coordinated as parallel roles, all executed by Muse/subagents in this workspace (no persistent autonomous agents):
research (audit) · product (PRD/matrix) · frontend (public/) · backend (app/) · AI/automation (assistant/nl) · security (auth/session/privacy review in docs/04) · QA (tests/) · devops (deployment doc). Each role's output is a file above — no duplicated or conflicting writes because each owns a distinct path.

## Scaling path (documented, not required now)
1. Swap `store.js` for SQLite (same interface) when a workspace passes ~10k records.
2. Add a worker process for the scheduler; the queue schema already carries `scheduledAt` + `status`.
3. Add official API publishers as plugins: `meta-publisher` (Content Publishing API), `whatsapp-agent` (Cloud API).
4. Add Ollama endpoint to `assistant.js` behind a settings flag — local model, still free.

## Security model (see docs/04-security-and-privacy.md)
Scrypt password hashing with per-user salt · session tokens hashed at rest · httpOnly + SameSite=Lax cookies · all workspace queries scoped by workspaceId (no cross-tenant reads) · input length caps · no third-party requests from server or client · full export + wipe available to the owner at any time.
