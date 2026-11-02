# Meta Free — Security & Privacy Review

## Implemented in v0.1 (verified by tests + live smoke test 2026-11-02)
- Passwords: scrypt (Node crypto) with per-user random salt; plaintext never stored.
- Sessions: random 32-byte tokens; only a SHA-256 hash of the token is stored; cookie is httpOnly + SameSite=Lax, 30-day expiry.
- Authorization: every `/api/*` route requires a session; every record read/write is scoped by `workspaceId` from the caller's membership — no cross-workspace access by guessing IDs (post/link/message lookups all filter on workspaceId).
- Roles: viewer cannot create/edit posts, links, rules or import; only owner can invite, import, or wipe.
- Exports deliberately exclude users and sessions (no password hashes or tokens ever leave in an export).
- Public surface: only `/p/:slug` (your link page) and `/go/:id` (click counter redirect) are unauthenticated.
- Privacy: zero third-party requests from server or client; no analytics, no tracking pixels, no model training on your data; the assistant runs locally.
- Input caps: request body ≤2MB; caption/field length caps throughout.

## Known limits (honest)
- Run it behind HTTPS in production (a reverse proxy / host with TLS). Session cookies should get the `Secure` flag when served over HTTPS — set that in your proxy config or patch the cookie line in `app/server.js`.
- The JSON store is single-instance; for multi-instance hosting, move to SQLite/Postgres per docs/03 scaling path.
- No rate-limiting or 2FA in v0.1 — roadmap items. For a personal/small-team instance on a private network this is an acceptable v0.1 posture; do not expose a public registration page to the open internet without adding rate limits first.
- Invite codes are bearer secrets — share them privately, they expire on use (cleared when redeemed).

## Privacy promise vs Meta One
Meta One runs inside Meta's apps under Meta's data practices. Meta Free's data file (`data/db.json`) sits on hardware you control, exports in one click, and wipes in one click. Nothing you type into Meta Free is sent anywhere by the app itself.
