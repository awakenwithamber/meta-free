'use strict';
// Tiny JSON store with atomic writes. One file, human-readable, easy to back up/export.
// Interface is intentionally small so it can be swapped for SQLite later (see docs/03).
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
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      try { this.db = Object.assign(emptyDb(), JSON.parse(fs.readFileSync(file, 'utf8'))); }
      catch { this.db = emptyDb(); }
    } else { this.db = emptyDb(); this.save(); }
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }
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
