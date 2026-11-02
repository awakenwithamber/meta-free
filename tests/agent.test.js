'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../app/lib/store');
const { runCompletion } = require('../app/lib/agent');
const { CANONICAL, seedConnections, CONNECTION_TEMPLATE } = require('../app/lib/connections');

function freshStore() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mf-agent-')), 'db.json');
  return new Store(file);
}

test('agent fills empty workspace fields, default links and rules from canonical sheet', () => {
  const s = freshStore();
  const ws = s.insert('workspaces', { name: 'Awaken With Amber', slug: 'awaken', tagline: '', hours: '' });
  ws.workspaceId = ws.id;
  const run = runCompletion(s, ws);
  const after = s.find('workspaces', w => w.id === ws.id);
  assert.equal(after.tagline, CANONICAL.tagline);
  assert.equal(after.hours, CANONICAL.hours);
  assert.equal(s.all('links', l => l.workspaceId === ws.id).length, CANONICAL.defaultLinks.length);
  assert.equal(s.all('rules', r => r.workspaceId === ws.id).length, CANONICAL.defaultRules.length);
  assert.equal(s.all('connections', c => c.workspaceId === ws.id).length, CONNECTION_TEMPLATE.length);
  assert.ok(run.filled.length > 0);
  assert.equal(run.needsHand.length, 5);
});

test('agent is idempotent and never overwrites a set value', () => {
  const s = freshStore();
  const ws = s.insert('workspaces', { name: 'X', slug: 'x', tagline: 'My own tagline', hours: '' });
  ws.workspaceId = ws.id;
  const first = runCompletion(s, ws);
  assert.ok(first.alreadySet.includes('workspace.tagline'));
  assert.equal(s.find('workspaces', w => w.id === ws.id).tagline, 'My own tagline');
  const second = runCompletion(s, s.find('workspaces', w => w.id === ws.id));
  assert.equal(second.filled.length, 0);
  assert.equal(s.all('links', l => l.workspaceId === ws.id).length, CANONICAL.defaultLinks.length);
});

test('canonical sheet contains no private data', () => {
  const text = JSON.stringify(CANONICAL);
  assert.ok(!/414-8984|239 S 1200|EIN|SSN/i.test(text));
  assert.match(text, /Amber@awakenagain\.com/);
  assert.match(text, /801-819-6795/);
});

test('connections template covers all eight platforms with honest statuses', () => {
  const platforms = CONNECTION_TEMPLATE.map(c => c.platform).sort();
  assert.deepEqual(platforms, ['facebook', 'instagram', 'linkedin', 'messenger', 'threads', 'tiktok', 'whatsapp', 'youtube']);
  const threads = CONNECTION_TEMPLATE.find(c => c.platform === 'threads');
  assert.equal(threads.status, 'action_needed');
});
