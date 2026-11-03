# Meta Free — Storage backends

One JSON document is the whole database (users, sessions, workspaces, posts, links,
messages, metrics, rules, members, competitors, notifications, watchlist, connections,
agentRuns). The `Store` class (`app/lib/store.js`) keeps it in memory behind a small
sync API; the backend decides where the document actually lives.

## Backends

| Backend | When | Durable? |
| --- | --- | --- |
| **File** (default) | Local / self-hosted | Yes — `data/db.json`, atomic writes (tmp file + rename). Back this one file up. |
| **Vercel Blob** (production) | `BLOB_READ_WRITE_TOKEN` is set | Yes — a **private** Blob store; survives deploys, restarts and instance recycling. |
| File on `/tmp` | On Vercel with **no** Blob store connected | **No** — ephemeral per function instance. Try-it only. |

Selection order in `app/server.js`:

1. `META_FREE_DB=/path/to/file` — forces the file backend at that path.
2. `BLOB_READ_WRITE_TOKEN` present — Blob backend (`app/lib/blob.js`).
3. Otherwise the file backend: `data/db.json` locally, `/tmp/meta-free-db.json` on Vercel.

## How the Blob backend works

- Zero dependencies: Node built-ins + global `fetch`, speaking the same REST contract
  as the official `@vercel/blob` SDK (API version 13).
- **Load once per instance:** the first request awaits `store.init()`, which GETs the
  blob from the store host with `?cache=0` (never a CDN-stale copy). An empty store is
  seeded with an empty database. A failed load fails the request loudly — the app never
  silently runs on empty state and overwrites real data later.
- **Write-through on every save:** mutations snapshot the document and queue a PUT
  (private access, allow-overwrite, no random suffix) in call order. The server holds
  each response open until queued writes settle (`store.flush()`), because a serverless
  instance can freeze the moment a response ends.
- **Pathname:** `meta-free/db.json` (override with `META_FREE_BLOB_PATH`).
- **Privacy:** the store is created with private access; every read/write carries the
  read-write token as a Bearer header. The blob is never publicly readable.

## Provisioning (what's live)

- Blob store **`meta-free-db`** (`store_pRx8xzxjSpYvBfJi`, region `iad1`, private),
  connected to the Vercel project `meta-free`. Connecting it automatically set the
  encrypted `BLOB_READ_WRITE_TOKEN` env var (production + preview + development).
- Free tier: Blob usage for this app's single small JSON document sits far inside the
  included quota; nothing was purchased.

## Limits & notes

- **Last writer wins across concurrent instances.** Two cold instances writing at the
  same moment can interleave whole-document writes. Fine at this app's scale (one
  brand, low traffic); the documented next step past ~10k records is SQLite/Postgres
  behind the same Store interface (docs/03).
- **Backups:** the app's own Export (Settings → Export JSON) works regardless of
  backend. For a raw copy, GET the blob with the token, or keep the local file backend
  as a mirror on your own hardware.
- The local `data/db.json` remains the durable store for the self-hosted copy and is
  untouched by the production backend.
