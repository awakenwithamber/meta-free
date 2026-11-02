# Meta Free — Connections & the Profile Completion Agent

## Connections registry (v0.2)
Every workspace carries a connections registry (`GET /api/connections`, seeded automatically) with one row per platform: handle, status, and an honest note about what the connection can and cannot do.

Statuses: `connected_via_muse` (Muse's connectors can work it today) · `api_ready` (official API path exists, dev-app step pending) · `browser_only` (no connector; browser/app only) · `action_needed` (a named owner step is pending) · `not_started`.

Amber's registry as seeded 2026-11-02, from a live audit the same day:
- **Facebook** — connected via Muse. 6 managed Pages inventoried (Awaken With Amber LLC, Ambers Alchemy Apothecary, Awaken Mobile, Josephine mines, LSSC; the FNSM Page is excluded by standing rule and never used). Connector covers publishing/insights; Page About fields are Business Suite edits.
- **Instagram @awakenwithamber** — connected via Muse. Audit found: bio complete and claim-safe; bio links 1–2 complete (links hub, booking); bio link 3 is a Facebook-page link whose title/URL are controlled from the Facebook side (a title edit via the connector returned success but readback shows it unchanged — not completable here); business contact email still shows the pre-2026 consultant address and category/city/website are blank in the business-info block — those fields are editable only in the Instagram app / Business Suite.
- **Messenger** — connected via Muse.
- **Threads @awakenwithamber** — account exists, connector shows **no linked account**; owner step = Threads connect link (Meta Accounts Center).
- **WhatsApp 801-819-6795** — owner step pending since Oct 2026: register the number in a Meta developer app (WhatsApp Cloud API). Muse prepared the walkthrough then; registration itself is the owner's hand.
- **YouTube @awakenagain, TikTok @awakenwithamber, LinkedIn** — browser/app only, no connectors.

## Profile Completion Agent
- Definition: a bounded role + run report, executed on the owner's tap (`POST /api/agent/run`) — Muse Prime pattern: a named role with a queue and an audit trail, **not** a persistent autonomous agent and not a silent autopilot.
- Scope (all from the canonical sheet in `app/lib/connections.js`): fill empty workspace tagline/hours; add any missing default link-page links; add any missing starter auto-reply rules; seed connections. It **never overwrites a set value**, dedupes by URL/keyword, and is idempotent — a second run fills 0 (test-verified).
- Every run writes an `agentRuns` record (filled / already-set / needs-owner-hand) and a notification, shown in the Connect view.
- The needs-hand list is part of the product, not fine print: Threads linking, IG business-contact fields, FB Page About fields, WhatsApp developer registration, and TikTok/LinkedIn/YouTube fields each name the exact surface where they're completed.

## Canonical sheet rules
Display values only: Amber@awakenagain.com, 801-819-6795, Salt Lake City, awakenagain.com, @awakenwithamber. Never on any public profile or agent-filled field: DOB, SSN/EIN, personal phone (…8984), street address, passwords, codes. A unit test asserts the canonical sheet contains none of the private markers.
