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
  async load() {
    const res = await this.fetch(`${this.host}/${this.pathname}?cache=0`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`blob load failed: HTTP ${res.status}`);
    return res.text();
  }
  // Write-through: replaces the whole DB blob with the given JSON text.
  async save(text) {
    const res = await this.fetch(`${this.apiUrl}?pathname=${encodeURIComponent(this.pathname)}`, {
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
  // Deletes the DB blob (used by tests/cleanup tooling, not by the app itself).
  async remove() {
    const res = await this.fetch(`${this.apiUrl}/delete`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-api-version': API_VERSION,
        'x-vercel-blob-store-id': this.storeId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ urls: [`${this.host}/${this.pathname}`] }),
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
