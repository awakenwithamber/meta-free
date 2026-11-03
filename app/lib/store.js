'use strict';
// Tiny JSON store. Default backend: one local file with atomic writes (human-readable,
// easy to back up/export). Optional durable backend (app/lib/blob.js): the same JSON
// document lives in a remote store — loaded once by init(), then written through on
// every save() in serialized order. The sync in-memory API never changes (see docs/07).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COLLECTIONS = ['users','sessions','workspaces','posts','links','messages','metrics','rules','members','competitors','notifications','watchlist','connections','agentRuns'];

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
