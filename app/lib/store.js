'use strict';
// Tiny JSON store. Default backend: one local file with atomic writes (human-readable,
// easy to back up/export). Optional durable backend (app/lib/blob.js): the same JSON
// document lives in a remote store — loaded once by init(), then written through on
// every save() in serialized order. The sync in-memory API never changes (see docs/07).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 'trials' = pre-launch trial records (workspace-scoped, exported with the
// workspace). 'claimCodes' = the founder-claim operator store: rows carry NO
// workspaceId, so workspace export never includes them, and no API returns
// them — the operator reads them out-of-band from the database itself.
// 'providerSubs' / 'providerInvoices' = billing-provider mirrors of trials
// and their (simulated) invoices, written by lib/providers; workspace-scoped.
// 'consentRecords' = Terms Acceptance System (owner directive
// 2026-11-07): append-only consent records (terms / billing /
// promo-email / promo-sms). Written ONLY while CONSENT_ENFORCEMENT=on
// (lib/consent.js); the collection stays empty while the system ships
// dark. Rows carry no workspaceId — consent history is account-scoped,
// so workspace export never includes another account's records.
// 'passwordResets' = self-service password recovery (owner directive
// 2026-11-07, lib/password-reset.js): rows store ONLY the SHA-256 hash
// of the reset token, an expiry, and a used stamp — never the raw
// token. 'outbox' = queued outbound email: no email provider is
// connected, so messages are written here with status QUEUED and are
// never presented as sent; a future provider sender drains this
// collection. Both are account-scoped (rows carry workspaceId null),
// so workspace export never includes token hashes or queued mail.
// 'providerCalls' = the Stripe provider's call log (ids, amounts,
// results — never credentials or card data), written by
// lib/providers/stripe.js. 'stripeEvents' = applied Stripe webhook
// events, recorded once per event id so Stripe's at-least-once
// delivery can never double-apply an effect. Both are operator-scoped
// (rows carry no workspaceId), so workspace export never includes them.
// 'feedRuns' + 'ordersDaily' = Awaken Meta data-feed layer (PKG-1,
// lib/feeds.js): feedRuns is one health row per feed execution;
// ordersDaily holds store daily aggregates only (no customer PII).
// Feed-written 'metrics' rows are additive extensions of the import
// row shape — they add source/label/date/window fields and may carry
// null (never 0) for values a connector did not return numerically.
// 'campaigns' / 'segments' / 'personas' / 'abTests' are declared in
// the same pass so the store shape lands once; they stay empty until
// the Campaign Command Center packages write them.
const COLLECTIONS = ['users','sessions','workspaces','posts','links','messages','metrics','rules','members','competitors','notifications','watchlist','connections','agentRuns','activity','planInterest','trials','claimCodes','providerSubs','providerInvoices','consentRecords','passwordResets','outbox','providerCalls','stripeEvents','feedRuns','ordersDaily','campaigns','segments','personas','abTests','settings'];

function emptyDb() {
  const db = {};
  for (const c of COLLECTIONS) db[c] = [];
  return db;
}

class Store {
  constructor(file, backend) {
    this.backend = backend || null;
    this._writeChain = Promise.resolve();
    this._ready = null;
    this.lastSaveError = null;
    if (this.backend) {
      // Remote-backed: start empty; init() replaces this.db with the stored document.
      // Callers must await init() (the server handler does) before trusting reads.
      this.file = null;
      this.db = emptyDb();
      return;
    }
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      try { this.db = Object.assign(emptyDb(), JSON.parse(fs.readFileSync(file, 'utf8'))); }
      catch { this.db = emptyDb(); }
    } else { this.db = emptyDb(); this.save(); }
  }
  // Loads the remote document exactly once (no-op for the file backend). If the remote
  // store is empty, seeds it with the current (empty) db. Rejects on load failure so a
  // broken backend fails loudly instead of silently running on empty state.
  init() {
    if (!this.backend) return Promise.resolve(this);
    if (!this._ready) {
      this._ready = (async () => {
        const text = await this.backend.load();
        if (text) {
          try { this.db = Object.assign(emptyDb(), JSON.parse(text)); }
          catch { this.db = emptyDb(); }
        } else {
          await this.backend.save(JSON.stringify(this.db, null, 2));
        }
        return this;
      })();
    }
    return this._ready;
  }
  save() {
    if (this.backend) {
      // Snapshot now, persist in call order; errors are recorded, not thrown — the sync
      // API stays sync, and the server awaits flush() before ending each response.
      const text = JSON.stringify(this.db, null, 2);
      this._writeChain = this._writeChain
        .then(() => this.backend.save(text))
        .catch(e => { this.lastSaveError = e; console.error('Meta Free: durable save failed:', e.message); });
      return this._writeChain;
    }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }
  // Resolves when every queued remote write has completed (file backend: immediately).
  flush() { return this._writeChain; }
  insert(coll, record) {
    record.id = record.id || crypto.randomUUID();
    record.createdAt = record.createdAt || new Date().toISOString();
    this.db[coll].push(record); this.save(); return record;
  }
  all(coll, filter) {
    let rows = this.db[coll];
    if (filter) rows = rows.filter(filter);
    return rows;
  }
  find(coll, filter) { return this.db[coll].find(filter) || null; }
  update(coll, id, patch) {
    const row = this.db[coll].find(r => r.id === id);
    if (!row) return null;
    Object.assign(row, patch); this.save(); return row;
  }
  remove(coll, id) {
    const before = this.db[coll].length;
    this.db[coll] = this.db[coll].filter(r => r.id !== id);
    if (this.db[coll].length !== before) { this.save(); return true; }
    return false;
  }
  removeWhere(coll, filter) {
    this.db[coll] = this.db[coll].filter(r => !filter(r)); this.save();
  }
  exportWorkspace(workspaceId) {
    const out = {};
    for (const c of COLLECTIONS) out[c] = this.db[c].filter(r => r.workspaceId === workspaceId || r.id === workspaceId);
    // never export password hashes or session tokens
    out.users = []; out.sessions = [];
    return out;
  }
}

module.exports = { Store, COLLECTIONS, emptyDb };
