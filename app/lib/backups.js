'use strict';
// Automated backups: a full-database snapshot, stored versioned alongside the
// database itself — Blob mode: meta-free/backups/<timestamp>.json in the same
// private store; file mode: <data dir>/backups/<timestamp>.json. The newest
// KEEP snapshots are retained; older ones are pruned on each new backup.
// Restore replaces the whole in-memory DB with the snapshot and persists it.

const fs = require('fs');
const path = require('path');
const { emptyDb } = require('./store');

const KEEP = 7;
const BLOB_PREFIX = 'meta-free/backups/';

function backupName(date = new Date()) {
  return 'backup-' + date.toISOString().replace(/[:.]/g, '-') + '.json';
}

function fileBackupDir(store) { return path.join(path.dirname(store.file), 'backups'); }
function validName(name) { return typeof name === 'string' && /^backup-[\w.-]+\.json$/.test(name); }

async function listBackups(store) {
  if (store.backend) {
    const blobs = await store.backend.list(BLOB_PREFIX);
    return blobs
      .map(b => ({ name: b.pathname.slice(BLOB_PREFIX.length), pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt }))
      .sort((a, b) => String(b.name).localeCompare(String(a.name)));
  }
  const dir = fileBackupDir(store);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => validName(f))
    .map(name => { const st = fs.statSync(path.join(dir, name)); return { name, size: st.size, uploadedAt: st.mtime.toISOString() }; })
    .sort((a, b) => String(b.name).localeCompare(String(a.name)));
}

async function pruneBackups(store) {
  const all = await listBackups(store);
  const extra = all.slice(KEEP);
  for (const b of extra) {
    if (store.backend) await store.backend.remove(BLOB_PREFIX + b.name);
    else fs.rmSync(path.join(fileBackupDir(store), b.name), { force: true });
  }
  return extra.length;
}

async function createBackup(store) {
  const name = backupName();
  const text = JSON.stringify(store.db, null, 2);
  if (store.backend) {
    await store.backend.save(text, BLOB_PREFIX + name);
  } else {
    const dir = fileBackupDir(store);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  await pruneBackups(store);
  return { name, size: Buffer.byteLength(text) };
}

async function readBackupText(store, name) {
  if (!validName(name)) throw new Error('Invalid backup name.');
  if (store.backend) return store.backend.load(BLOB_PREFIX + name);
  const full = path.join(fileBackupDir(store), name);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

async function restoreBackup(store, name) {
  const text = await readBackupText(store, name);
  if (!text) throw new Error('Backup not found.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Backup is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.users) || !Array.isArray(parsed.workspaces)) {
    throw new Error('Backup does not look like an Awaken Affordable Meta database.');
  }
  store.db = Object.assign(emptyDb(), parsed);
  store.save();
  await store.flush();
  if (store.lastSaveError) throw store.lastSaveError;
  return { name };
}

module.exports = { KEEP, BLOB_PREFIX, backupName, listBackups, createBackup, restoreBackup, pruneBackups };
