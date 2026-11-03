'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { BlobBackend, blobBackendFromEnv, storeIdFromToken } = require('../app/lib/blob');
const { Store } = require('../app/lib/store');

const TOKEN = 'vercel_blob_rw_TESTSTOREID123_secretvalue';

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => { calls.push({ url, init }); return handler(url, init, calls); };
  fn.calls = calls;
  return fn;
}
const okJson = (body = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('blob: store id is parsed from the read-write token', () => {
  assert.equal(storeIdFromToken(TOKEN), 'TESTSTOREID123');
  assert.equal(storeIdFromToken('garbage'), '');
  assert.throws(() => new BlobBackend({ token: 'garbage', fetchImpl: async () => okJson() }), /store id/);
});

test('blob: env gating — no token, no backend', () => {
  assert.equal(blobBackendFromEnv({}), null);
  const b = blobBackendFromEnv({ BLOB_READ_WRITE_TOKEN: TOKEN }, async () => okJson());
  assert.ok(b instanceof BlobBackend);
  assert.equal(b.pathname, 'meta-free/db.json');
});

test('blob: load returns text, maps 404 to null, and bypasses cache', async () => {
  const fetchImpl = mockFetch(async () => ({ ok: true, status: 200, text: async () => '{"users":[]}' }));
  const b = new BlobBackend({ token: TOKEN, fetchImpl });
  assert.equal(await b.load(), '{"users":[]}');
  const { url, init } = fetchImpl.calls[0];
  assert.match(url, /^https:\/\/TESTSTOREID123\.private\.blob\.vercel-storage\.com\/meta-free\/db\.json\?cache=0$/);
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);

  const missing = new BlobBackend({ token: TOKEN, fetchImpl: mockFetch(async () => ({ ok: false, status: 404, text: async () => '' })) });
  assert.equal(await missing.load(), null);

  const broken = new BlobBackend({ token: TOKEN, fetchImpl: mockFetch(async () => ({ ok: false, status: 500, text: async () => '' })) });
  await assert.rejects(() => broken.load(), /HTTP 500/);
});

test('blob: save PUTs the whole document with private-access overwrite headers', async () => {
  const fetchImpl = mockFetch(async () => okJson({ pathname: 'meta-free/db.json' }));
  const b = new BlobBackend({ token: TOKEN, fetchImpl });
  await b.save('{"users":[1]}');
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://vercel.com/api/blob?pathname=meta-free%2Fdb.json');
  assert.equal(init.method, 'PUT');
  assert.equal(init.body, '{"users":[1]}');
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers['x-vercel-blob-access'], 'private');
  assert.equal(init.headers['x-vercel-blob-store-id'], 'TESTSTOREID123');
  assert.equal(init.headers['x-add-random-suffix'], '0');
  assert.equal(init.headers['x-allow-overwrite'], '1');
  assert.equal(init.headers['x-content-type'], 'application/json');
});

test('store over blob backend: init loads, mutations write through in order, flush settles', async () => {
  let saved = null;
  const backend = {
    async load() { return saved; },
    async save(text) { saved = text; },
  };
  const s = new Store(null, backend);
  await s.init(); // empty remote -> seeds
  assert.ok(saved && JSON.parse(saved).users.length === 0);
  const ws = s.insert('workspaces', { name: 'Durable' });
  s.insert('posts', { workspaceId: ws.id, caption: 'persist me' });
  await s.flush();
  const persisted = JSON.parse(saved);
  assert.equal(persisted.workspaces.length, 1);
  assert.equal(persisted.posts[0].caption, 'persist me');

  // A fresh Store over the same backend sees the data after init (simulates a cold start).
  const s2 = new Store(null, backend);
  assert.equal(s2.all('posts').length, 0); // not loaded yet
  await s2.init();
  assert.equal(s2.all('posts').length, 1);
  assert.equal(s2.find('workspaces', w => w.id === ws.id).name, 'Durable');
});

test('store over blob backend: save errors are recorded, not thrown', async () => {
  const backend = {
    async load() { return null; },
    async save() { throw new Error('boom'); },
  };
  const s = new Store(null, backend);
  await assert.rejects(() => s.init(), /boom/); // seeding save fails loudly at init
  const s2 = new Store(null, { async load() { return '{"users":[]}'; }, async save() { throw new Error('later'); } });
  await s2.init();
  s2.insert('users', { email: 'a@b.co' }); // must not throw synchronously
  await s2.flush();
  assert.equal(s2.lastSaveError.message, 'later');
});
