'use strict';
const test = require('node:test');
const assert = require('node:assert');
const auth = require('../app/lib/auth');
const { parseCommand } = require('../app/lib/nl');
const analytics = require('../app/lib/analytics');
const assistant = require('../app/lib/assistant');
const { Store } = require('../app/lib/store');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('password hashing verifies correct password and rejects wrong one', () => {
  const { salt, hash } = auth.hashPassword('correct horse battery');
  assert.equal(auth.verifyPassword('correct horse battery', salt, hash), true);
  assert.equal(auth.verifyPassword('wrong', salt, hash), false);
});
test('email + password validation', () => {
  assert.equal(auth.validEmail('amber@awakenagain.com'), true);
  assert.equal(auth.validEmail('nope'), false);
  assert.equal(auth.strongEnough('12345678'), true);
  assert.equal(auth.strongEnough('short'), false);
});
test('NL parser: schedule tomorrow 9am on instagram keeps link + hashtags', () => {
  const now = new Date('2026-11-02T08:30:00');
  const r = parseCommand('schedule New soap drop https://awakenagain.com tomorrow at 9am on instagram #handmade #utah', now);
  assert.equal(r.platform, 'instagram');
  assert.equal(r.status, 'scheduled');
  assert.deepEqual(r.links, ['https://awakenagain.com']);
  assert.deepEqual(r.hashtags, ['handmade', 'utah']);
  const d = new Date(r.scheduledAt);
  assert.equal(d.getDate(), 3); assert.equal(d.getHours(), 9);
  assert.match(r.caption, /New soap drop/);
});
test('NL parser: draft default and empty command error', () => {
  const r = parseCommand('draft hello world on facebook');
  assert.equal(r.status, 'draft'); assert.equal(r.platform, 'facebook'); assert.equal(r.caption, 'hello world');
  assert.ok(parseCommand('   ').error);
});
test('CSV parse + rollup', () => {
  const rows = analytics.parseCsv('platform,timestamp,likes,comments,shares,clicks,reach\ninstagram,2026-11-01T15:00,10,2,1,5,100\ninstagram,2026-11-01T19:00,20,4,2,7,200\nfacebook,2026-11-01T09:00,3,0,0,1,50');
  assert.equal(rows.length, 3);
  const roll = analytics.rollup(rows.map(r => ({ ...r, likes: +r.likes, comments: +r.comments, shares: +r.shares, clicks: +r.clicks, reach: +r.reach })));
  assert.equal(roll[0].platform, 'instagram'); assert.equal(roll[0].likes, 30); assert.equal(roll[0].posts, 2);
});
test('assistant: suggested replies by intent + auto-reply rule precedence data', () => {
  assert.equal(assistant.suggestReply('how much is the soap?').intent, 'price');
  assert.equal(assistant.suggestReply('when are you open?').intent, 'hours');
  const rule = assistant.matchAutoReply('do you have hours listed?', [{ keyword: 'hours', reply: 'We are open 11-7', enabled: true }]);
  assert.equal(rule.reply, 'We are open 11-7');
  assert.equal(assistant.matchAutoReply('hello', [{ keyword: 'hours', reply: 'x', enabled: false }]), null);
});
test('assistant: bestTimes picks highest-engagement hour', () => {
  const metrics = [
    { timestamp: '2026-11-01T09:00', likes: 1, comments: 0, shares: 0, clicks: 0 },
    { timestamp: '2026-11-01T19:00', likes: 50, comments: 5, shares: 2, clicks: 10 },
    { timestamp: '2026-11-02T19:30', likes: 40, comments: 5, shares: 1, clicks: 8 },
  ];
  assert.equal(assistant.bestTimes(metrics)[0].hour, 19);
});
test('store: workspace-scoped export contains no users/sessions', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mf-')), 'db.json');
  const s = new Store(file);
  const ws = s.insert('workspaces', { name: 'Test' }); ws.workspaceId = ws.id;
  s.insert('posts', { workspaceId: ws.id, caption: 'hi' });
  s.insert('posts', { workspaceId: 'other', caption: 'no' });
  const out = s.exportWorkspace(ws.id);
  assert.equal(out.posts.length, 1);
  assert.deepEqual(out.users, []); assert.deepEqual(out.sessions, []);
});
