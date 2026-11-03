'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../app/lib/store');
const { BlobBackend } = require('../app/lib/blob');
const enterprise = require('../app/lib/enterprise');
const { logActivity, listActivity } = require('../app/lib/activity');
const { APPROVAL_STATES, approvalOf, canTransition, roleCanApprove, dueQueue } = require('../app/lib/approvals');
const backups = require('../app/lib/backups');

const TOKEN = 'vercel_blob_rw_TESTSTOREID123_secretvalue';
function freshStore() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mf-ent-')), 'db.json');
  return new Store(file);
}

test('enterprise: edition is Enterprise, every feature is on, no prices anywhere', () => {
  assert.equal(enterprise.EDITION, 'Enterprise');
  const feats = enterprise.features();
  assert.ok(feats.length >= 12);
  assert.ok(feats.every(f => f.state === 'on'));
  const text = JSON.stringify(enterprise);
  assert.ok(!/\$\s?\d/.test(text), 'no dollar amounts in the enterprise module');
  assert.equal(enterprise.FREE_LINE, 'Free. No fees, no subscription, no payment — ever.');
  assert.match(enterprise.HONEST_LIMIT, /verified badge/);
  assert.equal(enterprise.isEnterprise({}), true);
  assert.equal(enterprise.isEnterprise({ edition: 'Enterprise' }), true);
});

test('approvals: transition matrix follows draft → pending_review → approved with send-backs', () => {
  assert.deepEqual(APPROVAL_STATES, ['draft', 'pending_review', 'approved']);
  assert.equal(canTransition('draft', 'pending_review'), true);
  assert.equal(canTransition('draft', 'approved'), false); // must pass through review
  assert.equal(canTransition('pending_review', 'approved'), true);
  assert.equal(canTransition('pending_review', 'draft'), true);
  assert.equal(canTransition('approved', 'draft'), true);
  assert.equal(canTransition('approved', 'pending_review'), false);
  assert.equal(canTransition('approved', 'bogus'), false);
  assert.equal(roleCanApprove('owner'), true);
  assert.equal(roleCanApprove('editor'), true);
  assert.equal(roleCanApprove('viewer'), false);
});

test('approvals: legacy posts without an approval field count as approved', () => {
  assert.equal(approvalOf({}), 'approved');
  assert.equal(approvalOf({ approval: 'pending_review' }), 'pending_review');
  assert.equal(approvalOf({ approval: 'nonsense' }), 'approved');
});

test('activity: events are logged per workspace and listed newest first', () => {
  const s = freshStore();
  const ws = s.insert('workspaces', { name: 'W' }); ws.workspaceId = ws.id;
  logActivity(s, ws.id, 'owner@x.co', 'post.created', 'instagram · scheduled');
  logActivity(s, ws.id, 'owner@x.co', 'rule.added', 'hours');
  logActivity(s, 'someone-else', 'owner@x.co', 'post.created', 'nope');
  const rows = listActivity(s, ws.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, 'rule.added');
  assert.equal(rows[1].detail, 'instagram · scheduled');
  // activity rides the workspace export
  const out = s.exportWorkspace(ws.id);
  assert.equal(out.activity.length, 2);
});

test('due queue: past-due scheduled posts split by approval; future and published excluded', () => {
  const s = freshStore();
  const ws = s.insert('workspaces', { name: 'W' }); ws.workspaceId = ws.id;
  const past = new Date(Date.now() - 3600e3).toISOString();
  const future = new Date(Date.now() + 3600e3).toISOString();
  s.insert('posts', { workspaceId: ws.id, platform: 'instagram', caption: 'due approved', status: 'scheduled', approval: 'approved', scheduledAt: past });
  s.insert('posts', { workspaceId: ws.id, platform: 'instagram', caption: 'due legacy', status: 'scheduled', scheduledAt: past }); // no approval field
  s.insert('posts', { workspaceId: ws.id, platform: 'instagram', caption: 'due draft', status: 'scheduled', approval: 'draft', scheduledAt: past });
  s.insert('posts', { workspaceId: ws.id, platform: 'instagram', caption: 'future', status: 'scheduled', approval: 'approved', scheduledAt: future });
  s.insert('posts', { workspaceId: ws.id, platform: 'instagram', caption: 'done', status: 'published', approval: 'approved', scheduledAt: past });
  const q = dueQueue(s, ws.id);
  assert.deepEqual(q.ready.map(p => p.caption).sort(), ['due approved', 'due legacy']);
  assert.deepEqual(q.awaitingApproval.map(p => p.caption), ['due draft']);
});

test('backups (file mode): create, list, prune to last 7, restore', async () => {
  const s = freshStore();
  const ws = s.insert('workspaces', { name: 'Original' }); ws.workspaceId = ws.id;
  const first = await backups.createBackup(s);
  assert.match(first.name, /^backup-.*\.json$/);
  s.update('workspaces', ws.id, { name: 'Changed' });
  // make 7 more backups with distinct timestamps
  for (let i = 0; i < 7; i++) {
    await new Promise(r => setTimeout(r, 5));
    await backups.createBackup(s);
  }
  const listed = await backups.listBackups(s);
  assert.equal(listed.length, backups.KEEP);
  assert.ok(!listed.some(b => b.name === first.name), 'oldest backup pruned');
  await backups.restoreBackup(s, listed[listed.length - 1].name); // oldest kept = state 'Original' or first change era
  const restored = s.find('workspaces', w => w.id === ws.id);
  assert.ok(restored, 'workspace present after restore');
  await assert.rejects(() => backups.restoreBackup(s, 'backup-nope.json'), /not found/);
  await assert.rejects(() => backups.restoreBackup(s, '../db.json'), /Invalid backup name/);
});

// In-memory Blob stand-in implementing the same contract as BlobBackend.
function blobLike() {
  const files = new Map();
  return {
    files,
    async load(pathname) { return files.has(pathname) ? files.get(pathname) : null; },
    async save(text, pathname) { files.set(pathname || 'meta-free/db.json', text); return {}; },
    async list(prefix) { return [...files.keys()].filter(k => k.startsWith(prefix)).map(k => ({ pathname: k, size: files.get(k).length, uploadedAt: new Date().toISOString() })); },
    async remove(pathname) { files.delete(pathname || 'meta-free/db.json'); return true; },
  };
}

test('backups (blob-shaped backend): snapshot lands at versioned path, restore round-trips', async () => {
  const backend = blobLike();
  const s = new Store(null, backend);
  await s.init();
  const ws = s.insert('workspaces', { name: 'BlobBrand' }); ws.workspaceId = ws.id;
  await s.flush();
  const bk = await backups.createBackup(s);
  assert.ok(backend.files.has(backups.BLOB_PREFIX + bk.name));
  s.update('workspaces', ws.id, { name: 'Renamed' });
  await backups.restoreBackup(s, bk.name);
  assert.equal(s.find('workspaces', w => w.id === ws.id).name, 'BlobBrand');
  const listed = await backups.listBackups(s);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, bk.name);
});

test('blob backend: arbitrary pathnames save/load/list/delete (backup primitives)', async () => {
  const files = new Map();
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (init.method === 'PUT') {
      files.set(u.searchParams.get('pathname'), init.body);
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    }
    if (url.includes('/delete')) {
      const { urls } = JSON.parse(init.body);
      for (const full of urls) files.delete(decodeURIComponent(full.split('.com/')[1]));
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    }
    if (u.searchParams.has('prefix')) {
      const prefix = u.searchParams.get('prefix');
      const blobs = [...files.keys()].filter(k => k.startsWith(prefix)).map(k => ({ pathname: k, size: files.get(k).length, uploadedAt: new Date().toISOString() }));
      return { ok: true, status: 200, json: async () => ({ blobs, hasMore: false }), text: async () => '' };
    }
    // GET from store host
    const pathname = decodeURIComponent(u.pathname.slice(1));
    if (!files.has(pathname)) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => files.get(pathname) };
  };
  const b = new BlobBackend({ token: TOKEN, fetchImpl });
  await b.save('{"v":1}', 'meta-free/backups/backup-a.json');
  await b.save('{"v":2}', 'meta-free/backups/backup-b.json');
  assert.equal(await b.load('meta-free/backups/backup-a.json'), '{"v":1}');
  const listed = await b.list('meta-free/backups/');
  assert.deepEqual(listed.map(x => x.pathname).sort(), ['meta-free/backups/backup-a.json', 'meta-free/backups/backup-b.json']);
  await b.remove('meta-free/backups/backup-a.json');
  assert.equal(await b.load('meta-free/backups/backup-a.json'), null);
});
