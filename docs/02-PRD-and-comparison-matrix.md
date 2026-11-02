# Meta Free — Product Requirements Document + Comparison Matrix

## Product
**Meta Free** — a free, self-hostable, local-first workspace that recreates the *user-owned workflow* Meta One charges for: publishing planning, link pages, analytics, inbox/AI replies, team workflow and automations — with no subscription, no per-profile fees, no meters, and full data ownership.

**Non-goals (honest):** Meta Free does not and cannot issue Meta's verified badge, provide Meta's impersonation protection, lift Meta's in-app link caps, or run an agent natively inside WhatsApp. See audit §"Hard limits".

## Users
Creators and small businesses paying (or about to pay) $14.99–$499/mo per profile for Meta One — starting with Amber / Awaken With Amber LLC, currently on Essential ($14.99/mo) for Facebook.

## Requirements (MVP = shipped in v0.1)
| # | Requirement | Status |
|---|---|---|
| R1 | Secure registration/login: scrypt password hashing, httpOnly session cookies, logout | MVP |
| R2 | Customizable dashboard: toggleable widgets, per-user layout saved | MVP |
| R3 | Link page builder: unlimited links, public page at /p/:slug, click counts | MVP |
| R4 | Content planner: multi-platform posts, unlimited links in copy, draft/scheduled/ready/published states, calendar list | MVP |
| R5 | Natural-language commands to create/schedule posts | MVP |
| R6 | Unified inbox workspace: message log, statuses, local AI suggested replies (offline, rule-based) | MVP |
| R7 | Automations: keyword auto-reply rules, scheduled-task list | MVP |
| R8 | Analytics: CSV metric import, unlimited history, per-platform rollups, CSV/JSON export | MVP |
| R9 | Competitor tracker: unlimited entries with notes (vs Meta One's 10) | MVP |
| R10 | Team: role-based members (owner/editor/viewer) + invite codes — no password sharing | MVP |
| R11 | Import/export: full workspace JSON export & import; per-table CSV | MVP |
| R12 | Privacy: data stays local, one-click workspace wipe, no third-party calls | MVP |
| R13 | Plugins: registry manifest so features can be added as modules | MVP (registry + 2 sample plugins) |
| R14 | Accessibility/performance: semantic HTML, keyboard-friendly, zero-dependency frontend, <50KB JS | MVP |
| R15 | Direct publishing via official Meta Content Publishing / WhatsApp Cloud APIs | Roadmap (needs Meta app review — user-held step) |
| R16 | Optional local LLM (Ollama) for the assistant | Roadmap |

## Feature comparison matrix

| Capability | Meta One Essential $14.99/profile | Meta One Advanced $49.99/profile | **Meta Free $0** |
|---|---|---|---|
| Verified badge on Meta apps | Apply (Meta decides) | Apply | ✗ Cannot issue — Meta's alone |
| Impersonation protection | ✓ (Meta-internal) | ✓ | ✗ Cannot — Meta-internal; Meta Free adds a *watchlist log* to record/report impersonators |
| Link-in-bio page | Up to 20 links | Up to 20 links | **Unlimited links, own domain, click stats** |
| Links in planned posts | Effectively capped in-app (reported 2/mo free) | 4 posts + 4 Reels/mo (reported) | **Unlimited in planner** (in-app caps are Meta's, outside any tool) |
| Scheduling | — | Stories ≤30 days ahead | **Unlimited horizon, all post types, calendar** |
| Analytics history | Standard (≤90 days in-app) | Beyond 90 days | **Unlimited, you keep the raw data** |
| Analytics export | — | ✓ | **✓ CSV + JSON, one click** |
| Competitor insights | — | Up to 10 accounts | **Unlimited entries** |
| AI customer replies | Business Agent, metered | Business Agent, more capacity | **Local suggested replies + auto-reply rules, unmetered, offline** |
| AI captions/hashtags | Via Meta AI quota | Via Meta AI quota | **Local generator, unmetered** |
| Team access without password sharing | — | ✓ | **✓ Roles + invite codes** |
| Human support | — | — (Expert $149+) | Community/self — you own the code |
| Price for 3 profiles | $44.97/mo | $149.97/mo | **$0** |
| Data ownership / export everything | ✗ | ✗ | **✓ Full JSON export, local storage** |
| Self-hosting | ✗ | ✗ | **✓ Any Node host / your own machine** |
| Works offline | ✗ | ✗ | **✓ (local-first)** |

*Pricing/feature cells for Meta One: VERIFIED from Meta's official plans page and 15 Sep 2026 business announcement as quoted by trade press; per-tier link counts are REPORTED (see audit).*

## Success criteria for v0.1
- A new user can register, build a link page, plan a week of posts by typing one natural-language command, import a metrics CSV, export everything, and invite a teammate — in under 10 minutes, at $0, with tests passing.
