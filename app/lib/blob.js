'use strict';
// Durable storage backend for production: Vercel Blob (private store) via its REST API.
// Node built-ins + fetch only — Meta Free stays zero-dependency.
//
// The whole database is stored as ONE JSON blob (default pathname: meta-free/db.json),
// mirroring the local data/db.json file backend. Reads hit the store host directly with
// ?cache=0 so a fresh instance never sees a CDN-stale copy; writes go through the Blob
// API with allow-overwrite. See docs/07-storage.md.
//
// Active only when BLOB_READ_WRITE_TOKEN is set (Vercel adds it automatically when the
// Blob store is connected to the project). Without it, the app uses the file backend.

const API_URL = process.env.VERCEL_BLOB_API_URL || 'https://vercel.com/api/blob';
const API_VERSION = '13'; // matches the current @vercel/blob SDK (BLOB_API_VERSION)
const DEFAULT_PATHNAME = 'meta-free/db.json';

// Read-write tokens are shaped vercel_blob_rw_<storeId>_<secret>; the store id is the
// subdomain of the store host (same parsing the official SDK uses).
function storeIdFromToken(token) {
  const parts = String(token || '').split('_');
  return parts.length >= 4 ? parts[3] : '';
}

class BlobBackend {
  constructor({ token, fetchImpl, pathname, apiUrl } = {}) {
    this.token = token;
    this.fetch = fetchImpl || globalThis.fetch;
    this.pathname = pathname || process.env.META_FREE_BLOB_PATH || DEFAULT_PATHNAME;
    this.apiUrl = apiUrl || API_URL;
    this.storeId = storeIdFromToken(token);
    if (!this.storeId) throw new Error('storage token does not contain a store id');
    this.host = `https://${this.storeId}.private.blob.vercel-storage.com`;
  }
  // Returns the stored JSON text, or null when the blob does not exist yet.
  // `pathname` defaults to the DB blob; backups pass their own versioned path.
  async load(pathname = this.pathname) {
    const res = await this.fetch(`${this.host}/${pathname}?cache=0`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`blob load failed: HTTP ${res.status}`);
    return res.text();
  }
  // Write-through: replaces the blob at `pathname` (default: the DB blob) with the text.
  async save(text, pathname = this.pathname) {
    const res = await this.fetch(`${this.apiUrl}?pathname=${encodeURIComponent(pathname)}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-api-version': API_VERSION,
        'x-vercel-blob-store-id': this.storeId,
        'x-vercel-blob-access': 'private',
        'x-content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-allow-overwrite': '1',
        'x-cache-control-max-age': '0',
      },
      body: text,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      throw new Error(`blob save failed: HTTP ${res.status} ${detail}`);
    }
    return res.json().catch(() => ({}));
  }
  // Lists blobs under a prefix: [{pathname, size, uploadedAt}], oldest pages followed.
  async list(prefix = '') {
    const out = [];
    let cursor = null;
    do {
      const q = new URLSearchParams({ prefix, limit: '1000' });
      if (cursor) q.set('cursor', cursor);
      const res = await this.fetch(`${this.apiUrl}?${q.toString()}`, {
        headers: {
          authorization: `Bearer ${this.token}`,
          'x-api-version': API_VERSION,
          'x-vercel-blob-store-id': this.storeId,
        },
      });
      if (!res.ok) throw new Error(`blob list failed: HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      for (const b of data.blobs || []) out.push({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt });
      cursor = data.hasMore ? data.cursor : null;
    } while (cursor);
    return out;
  }
  // Deletes the blob at `pathname` (default: the DB blob; used by backup pruning too).
  async remove(pathname = this.pathname) {
    const res = await this.fetch(`${this.apiUrl}/delete`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-api-version': API_VERSION,
        'x-vercel-blob-store-id': this.storeId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ urls: [`${this.host}/${pathname}`] }),
    });
    if (!res.ok) throw new Error(`blob delete failed: HTTP ${res.status}`);
    return true;
  }
}

function blobBackendFromEnv(env = process.env, fetchImpl) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  return new BlobBackend({ token, fetchImpl });
}

module.exports = { BlobBackend, blobBackendFromEnv, storeIdFromToken, DEFAULT_PATHNAME };
