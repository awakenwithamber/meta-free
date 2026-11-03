'use strict';
// Meta Free — zero-dependency server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./lib/store');
const { blobBackendFromEnv } = require('./lib/blob');
const auth = require('./lib/auth');
const { parseCommand, PLATFORMS } = require('./lib/nl');
const assistant = require('./lib/assistant');
const analytics = require('./lib/analytics');
const { listPlugins, BUILTIN } = require('./lib/plugins');
const { CANONICAL, seedConnections } = require('./lib/connections');
const { runCompletion } = require('./lib/agent');
const enterprise = require('./lib/enterprise');
const { logActivity, listActivity } = require('./lib/activity');
const approvals = require('./lib/approvals');
const backupsLib = require('./lib/backups');

const PORT = process.env.PORT || 4173;
const ROOT = path.join(__dirname, '..');
// Storage (docs/07): with BLOB_READ_WRITE_TOKEN set (Vercel adds it when the Blob store
// is connected), the DB lives in a durable private Blob and survives deploys/restarts.
// META_FREE_DB forces the file backend. Otherwise: durable local data/db.json; on Vercel
// without a Blob store, /tmp — ephemeral per function instance (a try-it limit only).
const DATA_FILE = process.env.META_FREE_DB || (process.env.VERCEL ? '/tmp/meta-free-db.json' : path.join(ROOT, 'data', 'db.json'));
const blobBackend = process.env.META_FREE_DB ? null : blobBackendFromEnv();
const store = blobBackend ? new Store(null, blobBackend) : new Store(DATA_FILE);
const PUBLIC = path.join(ROOT, 'public');

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2_000_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const token = cookies(req).mf_session;
  if (!token) return null;
  const sess = store.find('sessions', s => s.tokenHash === auth.tokenHash(token));
  if (!sess) return null;
  if (new Date(sess.expiresAt) < new Date()) { store.remove('sessions', sess.id); return null; }
  return store.find('users', u => u.id === sess.userId);
}
function slugify(s) { return String(s || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page'; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  // Durable backend: never end a response while a write-through save is still in
  // flight — on serverless the instance can freeze the moment the response ends.
  const rawEnd = res.end.bind(res);
  let endCalled = false;
  res.end = (...args) => {
    if (endCalled) return;
    endCalled = true;
    Promise.resolve(store.flush()).catch(() => {}).then(() => rawEnd(...args));
  };
  try {
    await store.init(); // loads the durable document once per instance (no-op for file backend)
    // ---------- public link page ----------
    if (req.method === 'GET' && p.startsWith('/p/')) {
      const slug = decodeURIComponent(p.slice(3));
      const ws = store.find('workspaces', w => w.slug === slug);
      if (!ws) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<h1>Page not found</h1>'); }
      const links = store.all('links', l => l.workspaceId === ws.id).sort((a, b) => (a.sort || 0) - (b.sort || 0));
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ws.name)} — Links</title><link rel="stylesheet" href="/styles.css"></head>
<body class="linkpage"><main><h1 class="brand-font">${esc(ws.name)}</h1><p>${esc(ws.tagline || '')}</p>
${links.map(l => `<a class="linkbtn" href="/go/${l.id}" rel="noopener">${esc(l.title)}</a>`).join('\n')}
<footer><small>Powered by Meta Free — free forever, your data stays yours.</small></footer></main></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html);
    }
    if (req.method === 'GET' && p.startsWith('/go/')) {
      const link = store.find('links', l => l.id === p.slice(4));
      if (!link) { res.writeHead(404); return res.end('not found'); }
      store.update('links', link.id, { clicks: (link.clicks || 0) + 1 });
      res.writeHead(302, { Location: link.url }); return res.end();
    }

    // ---------- auth ----------
    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req);
      if (!auth.validEmail(b.email)) return json(res, 400, { error: 'Enter a valid email.' });
      if (!auth.strongEnough(b.password)) return json(res, 400, { error: 'Password must be at least 8 characters.' });
      if (store.find('users', u => u.email === b.email.toLowerCase())) return json(res, 409, { error: 'That email already has an account on this instance.' });
      const { salt, hash } = auth.hashPassword(b.password);
      const user = store.insert('users', { email: b.email.toLowerCase(), salt, hash, name: String(b.name || '').slice(0, 80) });
      const wsName = String(b.workspace || 'My Brand').slice(0, 80);
      let slug = slugify(wsName); let n = 1;
      while (store.find('workspaces', w => w.slug === slug)) slug = slugify(wsName) + '-' + (++n);
      const ws = store.insert('workspaces', { name: wsName, slug, tagline: '', ownerId: user.id, edition: enterprise.EDITION, plugins: {}, widgets: { planner: true, inbox: true, analytics: true, links: true, bestTimes: true, competitors: true } });
      ws.workspaceId = ws.id; store.save();
      store.insert('members', { workspaceId: ws.id, userId: user.id, email: user.email, role: 'owner' });
      return startSession(res, user, { ok: true, workspace: publicWs(ws) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const user = store.find('users', u => u.email === String(b.email || '').toLowerCase());
      if (!user || !auth.verifyPassword(String(b.password || ''), user.salt, user.hash)) return json(res, 401, { error: 'Email or password did not match.' });
      return startSession(res, user, { ok: true });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const token = cookies(req).mf_session;
      if (token) { const s = store.find('sessions', x => x.tokenHash === auth.tokenHash(token)); if (s) store.remove('sessions', s.id); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'mf_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
      return res.end('{"ok":true}');
    }

    // everything below requires login
    const user = currentUser(req);
    if (p.startsWith('/api/')) {
      if (!user) return json(res, 401, { error: 'Please sign in.' });
      const member = store.find('members', m => m.userId === user.id);
      if (!member && p !== '/api/me') return json(res, 403, { error: 'No workspace membership.' });
      const wsId = member ? member.workspaceId : null;
      const ws = wsId ? store.find('workspaces', w => w.id === wsId) : null;
      const canWrite = member && (member.role === 'owner' || member.role === 'editor');
      const act = (action, detail) => logActivity(store, wsId, user.email, action, detail);

      if (p === '/api/me' && req.method === 'GET') return json(res, 200, { user: { email: user.email, name: user.name }, workspace: ws ? publicWs(ws) : null, role: member ? member.role : null });

      if (p === '/api/dashboard' && req.method === 'GET') {
        const posts = store.all('posts', x => x.workspaceId === wsId);
        const messages = store.all('messages', x => x.workspaceId === wsId);
        const metrics = store.all('metrics', x => x.workspaceId === wsId);
        return json(res, 200, {
          counts: { posts: posts.length, scheduled: posts.filter(x => x.status === 'scheduled').length, due: approvals.dueQueue(store, wsId).ready.length, inboxOpen: messages.filter(x => x.status === 'open').length, links: store.all('links', x => x.workspaceId === wsId).length },
          upcoming: posts.filter(x => x.status === 'scheduled').sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt))).slice(0, 5),
          bestTimes: assistant.bestTimes(metrics),
          rollup: analytics.rollup(metrics),
          notifications: store.all('notifications', x => x.workspaceId === wsId).slice(-5).reverse(),
          widgets: ws.widgets,
        });
      }

      // posts
      if (p === '/api/posts' && req.method === 'GET') return json(res, 200, { posts: store.all('posts', x => x.workspaceId === wsId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
      if (p === '/api/posts' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot create posts.' });
        const b = await readBody(req);
        const post = store.insert('posts', { workspaceId: wsId, platform: PLATFORMS.includes(b.platform) ? b.platform : 'facebook', caption: String(b.caption || '').slice(0, 2200), status: ['draft', 'scheduled', 'ready', 'published'].includes(b.status) ? b.status : 'draft', approval: approvals.APPROVAL_STATES.includes(b.approval) ? b.approval : 'draft', scheduledAt: b.scheduledAt || null });
        notify(wsId, `Post created for ${post.platform}`);
        act('post.created', `${post.platform} · ${post.status}`);
        return json(res, 201, { post });
      }
      if (p === '/api/command' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot create posts.' });
        const b = await readBody(req);
        const parsed = parseCommand(String(b.command || ''));
        if (parsed.error) return json(res, 400, { error: parsed.error });
        // A typed command is the author's own instruction — it enters approved.
        const post = store.insert('posts', { workspaceId: wsId, platform: parsed.platform, caption: parsed.caption, status: parsed.status, approval: 'approved', scheduledAt: parsed.scheduledAt });
        act('post.created', `${post.platform} · ${post.status} · via command bar`);
        return json(res, 201, { post, parsed });
      }
      if (p === '/api/due' && req.method === 'GET') {
        const q = approvals.dueQueue(store, wsId);
        for (const post of q.ready) {
          if (!post.dueNotified) {
            store.update('posts', post.id, { dueNotified: true });
            notify(wsId, `Due now: ${post.platform} post is ready to publish — copy it from the Planner.`);
            post.dueNotified = true;
          }
        }
        return json(res, 200, { ready: q.ready, awaitingApproval: q.awaitingApproval });
      }
      const postMatch = p.match(/^\/api\/posts\/(.+)$/);
      if (postMatch && req.method === 'PATCH') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot edit posts.' });
        const b = await readBody(req);
        const post = store.find('posts', x => x.id === postMatch[1] && x.workspaceId === wsId);
        if (!post) return json(res, 404, { error: 'Post not found.' });
        const patch = {};
        const prevStatus = post.status;
        const prevApproval = approvals.approvalOf(post);
        if (b.status) patch.status = b.status;
        if (b.caption !== undefined) patch.caption = String(b.caption).slice(0, 2200);
        if (b.scheduledAt !== undefined) patch.scheduledAt = b.scheduledAt;
        if (b.approval !== undefined) {
          if (!approvals.roleCanApprove(member.role)) return json(res, 403, { error: 'Your role cannot change approval state.' });
          if (!approvals.canTransition(prevApproval, b.approval)) return json(res, 400, { error: `Approval cannot move from ${prevApproval} to ${b.approval}.` });
          patch.approval = b.approval;
        }
        const updated = store.update('posts', post.id, patch);
        if (patch.approval && patch.approval !== prevApproval) act('post.approval', `${post.platform} → ${patch.approval}`);
        else if (patch.status && patch.status !== prevStatus) act('post.status', `${post.platform} → ${patch.status}`);
        else act('post.updated', post.platform);
        return json(res, 200, { post: updated });
      }
      if (postMatch && req.method === 'DELETE') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot delete posts.' });
        const post = store.find('posts', x => x.id === postMatch[1] && x.workspaceId === wsId);
        if (!post) return json(res, 404, { error: 'Post not found.' });
        store.remove('posts', post.id); act('post.deleted', post.platform); return json(res, 200, { ok: true });
      }

      // links
      if (p === '/api/links' && req.method === 'GET') return json(res, 200, { links: store.all('links', x => x.workspaceId === wsId).sort((a, b) => (a.sort || 0) - (b.sort || 0)), slug: ws.slug });
      if (p === '/api/links' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot edit links.' });
        const b = await readBody(req);
        if (!/^https?:\/\//i.test(String(b.url || ''))) return json(res, 400, { error: 'Link URL must start with http:// or https://' });
        const link = store.insert('links', { workspaceId: wsId, title: String(b.title || 'Link').slice(0, 120), url: String(b.url).slice(0, 2000), clicks: 0, sort: store.all('links', x => x.workspaceId === wsId).length });
        act('link.added', link.url);
        return json(res, 201, { link });
      }
      const linkMatch = p.match(/^\/api\/links\/(.+)$/);
      if (linkMatch && req.method === 'DELETE') {
        const link = store.find('links', x => x.id === linkMatch[1] && x.workspaceId === wsId);
        if (!link) return json(res, 404, { error: 'Link not found.' });
        store.remove('links', link.id); act('link.removed', link.url); return json(res, 200, { ok: true });
      }

      // inbox
      if (p === '/api/messages' && req.method === 'GET') return json(res, 200, { messages: store.all('messages', x => x.workspaceId === wsId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) });
      if (p === '/api/messages' && req.method === 'POST') {
        const b = await readBody(req);
        const body = String(b.body || '').slice(0, 2000);
        const rule = assistant.matchAutoReply(body, store.all('rules', x => x.workspaceId === wsId));
        const sugg = assistant.suggestReply(body, { linkPage: '/p/' + ws.slug, hours: ws.hours });
        const msg = store.insert('messages', { workspaceId: wsId, platform: PLATFORMS.includes(b.platform) ? b.platform : 'instagram', from: String(b.from || 'Customer').slice(0, 80), body, status: 'open', suggestedReply: rule ? rule.reply : sugg.reply, autoRule: rule ? rule.id : null });
        return json(res, 201, { message: msg });
      }
      const msgMatch = p.match(/^\/api\/messages\/(.+)$/);
      if (msgMatch && req.method === 'PATCH') {
        const b = await readBody(req);
        const msg = store.find('messages', x => x.id === msgMatch[1] && x.workspaceId === wsId);
        if (!msg) return json(res, 404, { error: 'Message not found.' });
        return json(res, 200, { message: store.update('messages', msg.id, { status: b.status === 'resolved' ? 'resolved' : 'open' }) });
      }

      // automation rules
      if (p === '/api/rules' && req.method === 'GET') return json(res, 200, { rules: store.all('rules', x => x.workspaceId === wsId) });
      if (p === '/api/rules' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot edit rules.' });
        const b = await readBody(req);
        const rule = store.insert('rules', { workspaceId: wsId, keyword: String(b.keyword || '').slice(0, 60), reply: String(b.reply || '').slice(0, 1000), enabled: true });
        act('rule.added', rule.keyword);
        return json(res, 201, { rule });
      }
      const ruleMatch = p.match(/^\/api\/rules\/(.+)$/);
      if (ruleMatch && req.method === 'DELETE') { const rule = store.find('rules', x => x.id === ruleMatch[1] && x.workspaceId === wsId); store.removeWhere('rules', x => x.id === ruleMatch[1] && x.workspaceId === wsId); if (rule) act('rule.removed', rule.keyword); return json(res, 200, { ok: true }); }

      // metrics / analytics
      if (p === '/api/metrics' && req.method === 'GET') {
        const metrics = store.all('metrics', x => x.workspaceId === wsId);
        return json(res, 200, { count: metrics.length, rollup: analytics.rollup(metrics), bestTimes: assistant.bestTimes(metrics), metrics });
      }
      if (p === '/api/metrics/import' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot import.' });
        const b = await readBody(req);
        const rows = analytics.parseCsv(String(b.csv || ''));
        let added = 0;
        for (const r of rows) {
          store.insert('metrics', { workspaceId: wsId, platform: PLATFORMS.includes(r.platform) ? r.platform : 'facebook', timestamp: r.timestamp || r.date || new Date().toISOString(), likes: +r.likes || 0, comments: +r.comments || 0, shares: +r.shares || 0, clicks: +r.clicks || 0, reach: +r.reach || 0 });
          added++;
        }
        notify(wsId, `Imported ${added} metric rows`);
        act('metrics.imported', `${added} rows`);
        return json(res, 201, { added });
      }
      if (p === '/api/metrics/export.csv' && req.method === 'GET') {
        const rows = store.all('metrics', x => x.workspaceId === wsId);
        const csv = analytics.toCsv(rows, ['platform', 'timestamp', 'likes', 'comments', 'shares', 'clicks', 'reach']);
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="meta-free-metrics.csv"' }); return res.end(csv);
      }
      if (p === '/api/posts/export.csv' && req.method === 'GET') {
        const rows = store.all('posts', x => x.workspaceId === wsId);
        const csv = analytics.toCsv(rows, ['platform', 'status', 'approval', 'scheduledAt', 'caption', 'createdAt']);
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="meta-free-posts.csv"' }); return res.end(csv);
      }

      // competitors + watchlist
      if (p === '/api/competitors' && req.method === 'GET') return json(res, 200, { competitors: store.all('competitors', x => x.workspaceId === wsId) });
      if (p === '/api/competitors' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 201, { competitor: store.insert('competitors', { workspaceId: wsId, handle: String(b.handle || '').slice(0, 80), platform: String(b.platform || 'instagram'), notes: String(b.notes || '').slice(0, 500) }) });
      }
      if (p === '/api/watchlist' && req.method === 'GET') return json(res, 200, { entries: store.all('watchlist', x => x.workspaceId === wsId) });
      if (p === '/api/watchlist' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 201, { entry: store.insert('watchlist', { workspaceId: wsId, handle: String(b.handle || '').slice(0, 80), platform: String(b.platform || 'instagram'), status: 'reported' in b ? 'reported' : 'watching', notes: String(b.notes || '').slice(0, 500) }) });
      }

      // assistant
      if (p === '/api/assistant/caption' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, { caption: assistant.draftCaption(String(b.topic || ''), b.platform || 'instagram', ws.name), hashtags: assistant.suggestHashtags(String(b.topic || ''), ws.name) });
      }
      if (p === '/api/assistant/ask' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, { answer: assistant.diagnose(String(b.question || '')) });
      }

      // team
      if (p === '/api/members' && req.method === 'GET') return json(res, 200, { members: store.all('members', x => x.workspaceId === wsId).map(m => ({ email: m.email, role: m.role, inviteCode: m.inviteCode || null })) });
      if (p === '/api/members/invite' && req.method === 'POST') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can invite.' });
        const b = await readBody(req);
        if (!auth.validEmail(b.email)) return json(res, 400, { error: 'Enter a valid email.' });
        const role = ['editor', 'viewer'].includes(b.role) ? b.role : 'viewer';
        const code = crypto.randomBytes(6).toString('hex');
        store.insert('members', { workspaceId: wsId, userId: null, email: b.email.toLowerCase(), role, inviteCode: code });
        act('team.invited', `${b.email.toLowerCase()} as ${role}`);
        return json(res, 201, { inviteCode: code, note: 'Share this code with your teammate. When they register with the same email, enter the code in Settings to join this workspace (join endpoint below).' });
      }
      if (p === '/api/members/join' && req.method === 'POST') {
        const b = await readBody(req);
        const inv = store.find('members', m => m.inviteCode === String(b.code || '') && m.email === user.email && !m.userId);
        if (!inv) return json(res, 404, { error: 'No invite found for your email with that code.' });
        // move membership: remove old membership rows for this user, attach invite
        store.removeWhere('members', m => m.userId === user.id);
        store.update('members', inv.id, { userId: user.id, inviteCode: null });
        logActivity(store, inv.workspaceId, user.email, 'team.joined', ws ? ws.name : '');
        return json(res, 200, { ok: true });
      }

      // connections + profile completion agent
      if (p === '/api/connections' && req.method === 'GET') {
        const connections = seedConnections(store, wsId);
        return json(res, 200, { connections, canonical: CANONICAL });
      }
      const connMatch = p.match(/^\/api\/connections\/(.+)$/);
      if (connMatch && req.method === 'PATCH') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot edit connections.' });
        const b = await readBody(req);
        const conn = store.find('connections', x => x.platform === connMatch[1] && x.workspaceId === wsId);
        if (!conn) return json(res, 404, { error: 'Connection not found.' });
        const patch = {};
        if (b.status) patch.status = String(b.status).slice(0, 40);
        if (b.handle !== undefined) patch.handle = String(b.handle).slice(0, 120);
        if (b.note !== undefined) patch.note = String(b.note).slice(0, 500);
        return json(res, 200, { connection: store.update('connections', conn.id, patch) });
      }
      if (p === '/api/agent/run' && req.method === 'POST') {
        if (!canWrite) return json(res, 403, { error: 'Viewer role cannot run the agent.' });
        const run = runCompletion(store, ws);
        act('agent.run', run.summary);
        return json(res, 201, { run });
      }
      if (p === '/api/agent/runs' && req.method === 'GET') {
        return json(res, 200, { runs: store.all('agentRuns', x => x.workspaceId === wsId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10) });
      }

      // workspace settings, plugins, widgets, export/import/wipe
      if (p === '/api/workspace' && req.method === 'PATCH') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can change workspace settings.' });
        const b = await readBody(req);
        const patch = {};
        if (b.name) patch.name = String(b.name).slice(0, 80);
        if (b.tagline !== undefined) patch.tagline = String(b.tagline).slice(0, 160);
        if (b.hours !== undefined) patch.hours = String(b.hours).slice(0, 80);
        if (b.widgets) patch.widgets = { ...ws.widgets, ...b.widgets };
        if (b.plugins) { patch.plugins = { ...ws.plugins }; for (const pl of BUILTIN) if (pl.id in b.plugins && !pl.roadmap) patch.plugins[pl.id] = !!b.plugins[pl.id]; }
        const updatedWs = store.update('workspaces', ws.id, patch);
        act('workspace.settings', Object.keys(patch).join(', '));
        return json(res, 200, { workspace: publicWs(updatedWs) });
      }
      if (p === '/api/plugins' && req.method === 'GET') return json(res, 200, { plugins: listPlugins(ws) });
      if (p === '/api/export' && req.method === 'GET') {
        const data = store.exportWorkspace(wsId);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="meta-free-export.json"' });
        return res.end(JSON.stringify(data, null, 2));
      }
      if (p === '/api/import' && req.method === 'POST') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can import.' });
        const b = await readBody(req);
        const backup = await backupsLib.createBackup(store); // safety snapshot first
        let added = 0;
        for (const coll of ['posts', 'links', 'rules', 'competitors']) {
          for (const row of (b.data && b.data[coll]) || []) {
            const { id, ...rest } = row; store.insert(coll, { ...rest, workspaceId: wsId }); added++;
          }
        }
        act('data.imported', `${added} records · pre-import backup ${backup.name}`);
        return json(res, 201, { added, backup: backup.name });
      }
      if (p === '/api/wipe' && req.method === 'POST') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can wipe the workspace.' });
        const backup = await backupsLib.createBackup(store); // safety snapshot first
        for (const coll of ['posts', 'links', 'messages', 'metrics', 'rules', 'competitors', 'notifications', 'watchlist', 'connections', 'agentRuns', 'activity']) store.removeWhere(coll, x => x.workspaceId === wsId);
        act('data.wiped', `pre-wipe backup ${backup.name}`);
        notify(wsId, `Workspace data wiped. A backup snapshot (${backup.name}) was saved first — restore it from Enterprise settings if this was a mistake.`);
        return json(res, 200, { ok: true, backup: backup.name });
      }

      // activity / audit log
      if (p === '/api/activity' && req.method === 'GET') return json(res, 200, { activity: listActivity(store, wsId) });
      if (p === '/api/activity/export.csv' && req.method === 'GET') {
        const rows = listActivity(store, wsId);
        const csv = analytics.toCsv(rows, ['createdAt', 'actor', 'action', 'detail']);
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="meta-free-activity.csv"' }); return res.end(csv);
      }

      // enterprise edition: features, storage, honest limit
      if (p === '/api/enterprise' && req.method === 'GET') {
        return json(res, 200, {
          edition: enterprise.EDITION,
          workspaceEdition: ws.edition || enterprise.EDITION,
          freeLine: enterprise.FREE_LINE,
          features: enterprise.features(),
          storage: blobBackend ? 'Durable cloud storage (private, survives deploys and restarts)' : 'Local file storage (data/db.json)',
          backupsKept: backupsLib.KEEP,
          honestLimit: enterprise.HONEST_LIMIT,
        });
      }

      // automated backups (owner only — a backup holds the whole database)
      if (p === '/api/backups' && req.method === 'GET') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can manage backups.' });
        return json(res, 200, { backups: await backupsLib.listBackups(store) });
      }
      if (p === '/api/backups' && req.method === 'POST') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can manage backups.' });
        const backup = await backupsLib.createBackup(store);
        act('backup.created', backup.name);
        return json(res, 201, { backup });
      }
      if (p === '/api/backups/restore' && req.method === 'POST') {
        if (member.role !== 'owner') return json(res, 403, { error: 'Only the owner can manage backups.' });
        const b = await readBody(req);
        const safety = await backupsLib.createBackup(store); // snapshot current state first
        try {
          await backupsLib.restoreBackup(store, String(b.name || ''));
        } catch (e) { return json(res, 400, { error: e.message }); }
        // The restore replaced the DB — log into the restored state so the event survives.
        const member2 = store.find('members', m => m.userId === user.id);
        if (member2) logActivity(store, member2.workspaceId, user.email, 'backup.restored', `${b.name} · pre-restore backup ${safety.name}`);
        return json(res, 200, { ok: true, restored: b.name, preRestoreBackup: safety.name });
      }

      return json(res, 404, { error: 'Unknown API route.' });
    }

    // ---------- static ----------
    const file = p === '/' ? 'index.html' : p.replace(/^\//, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(full));
  } catch (e) {
    return json(res, 500, { error: 'Server error: ' + e.message });
  }
};
const server = http.createServer(handler);

function publicWs(ws) { return { id: ws.id, name: ws.name, slug: ws.slug, tagline: ws.tagline || '', hours: ws.hours || '', edition: ws.edition || enterprise.EDITION, widgets: ws.widgets || {} }; }
function notify(workspaceId, text) { store.insert('notifications', { workspaceId, text }); }
function startSession(res, user, body) {
  const token = auth.newSessionToken();
  store.insert('sessions', { userId: user.id, tokenHash: auth.tokenHash(token), expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() });
  const s = JSON.stringify(body);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `mf_session=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax` });
  res.end(s);
}

if (require.main === module) server.listen(PORT, () => console.log(`Meta Free running at http://localhost:${PORT}`));
module.exports = { server, store, handler };
