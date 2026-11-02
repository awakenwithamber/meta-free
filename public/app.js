'use strict';
const $ = s => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let ME = null;

async function boot() {
  try { ME = await api('/api/me'); showApp(); } catch { showAuth(); }
}
function showAuth() { $('#auth').hidden = false; $('#app').hidden = true; $('#topnav').hidden = true; }
function showApp() { $('#auth').hidden = true; $('#app').hidden = false; $('#topnav').hidden = false; refreshAll(); fillSettings(); }
function formData(f) { return Object.fromEntries(new FormData(f).entries()); }

$('#loginForm').addEventListener('submit', async e => { e.preventDefault(); try { await api('/api/login', { method: 'POST', body: JSON.stringify(formData(e.target)) }); ME = await api('/api/me'); showApp(); } catch (err) { $('#authErr').textContent = err.message; } });
$('#registerForm').addEventListener('submit', async e => { e.preventDefault(); try { await api('/api/register', { method: 'POST', body: JSON.stringify(formData(e.target)) }); ME = await api('/api/me'); showApp(); } catch (err) { $('#authErr').textContent = err.message; } });
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST', body: '{}' }); location.reload(); });

document.querySelectorAll('#topnav button[data-view]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  $('#view-' + b.dataset.view).hidden = false;
}));

$('#commandForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await api('/api/command', { method: 'POST', body: JSON.stringify({ command: $('#command').value }) });
    $('#commandMsg').textContent = `Created ${r.post.status} post on ${r.post.platform}${r.post.scheduledAt ? ' for ' + new Date(r.post.scheduledAt).toLocaleString() : ''}.`;
    $('#command').value = ''; refreshAll();
  } catch (err) { $('#commandMsg').textContent = err.message; }
});

$('#postForm').addEventListener('submit', async e => {
  e.preventDefault(); const d = formData(e.target);
  if (d.scheduledAt) d.scheduledAt = new Date(d.scheduledAt).toISOString();
  await api('/api/posts', { method: 'POST', body: JSON.stringify(d) }); e.target.reset(); refreshAll();
});
$('#aiCaption').addEventListener('click', async () => {
  const f = $('#postForm'); const topic = f.caption.value || 'New handmade botanical soap drop';
  const r = await api('/api/assistant/caption', { method: 'POST', body: JSON.stringify({ topic, platform: f.platform.value }) });
  f.caption.value = r.caption;
});

$('#msgForm').addEventListener('submit', async e => { e.preventDefault(); await api('/api/messages', { method: 'POST', body: JSON.stringify(formData(e.target)) }); e.target.reset(); refreshAll(); });
$('#ruleForm').addEventListener('submit', async e => { e.preventDefault(); await api('/api/rules', { method: 'POST', body: JSON.stringify(formData(e.target)) }); e.target.reset(); refreshAll(); });
$('#linkForm').addEventListener('submit', async e => { e.preventDefault(); await api('/api/links', { method: 'POST', body: JSON.stringify(formData(e.target)) }); e.target.reset(); refreshAll(); });
$('#competitorForm').addEventListener('submit', async e => { e.preventDefault(); await api('/api/competitors', { method: 'POST', body: JSON.stringify(formData(e.target)) }); e.target.reset(); refreshAll(); });
$('#watchForm').addEventListener('submit', async e => { e.preventDefault(); await api('/api/watchlist', { method: 'POST', body: JSON.stringify(formData(e.target)) }); e.target.reset(); refreshAll(); });
$('#inviteForm').addEventListener('submit', async e => { e.preventDefault(); try { const r = await api('/api/members/invite', { method: 'POST', body: JSON.stringify(formData(e.target)) }); $('#inviteMsg').textContent = 'Invite code: ' + r.inviteCode; refreshAll(); } catch (err) { $('#inviteMsg').textContent = err.message; } });
$('#joinForm').addEventListener('submit', async e => { e.preventDefault(); await api('/api/members/join', { method: 'POST', body: JSON.stringify(formData(e.target)) }); ME = await api('/api/me'); refreshAll(); alert('Joined workspace: ' + ME.workspace.name); });
$('#askForm').addEventListener('submit', async e => { e.preventDefault(); const r = await api('/api/assistant/ask', { method: 'POST', body: JSON.stringify(formData(e.target)) }); $('#askAnswer').textContent = r.answer; });
$('#importCsv').addEventListener('click', async () => { const r = await api('/api/metrics/import', { method: 'POST', body: JSON.stringify({ csv: $('#csvBox').value }) }); alert('Imported ' + r.added + ' rows'); refreshAll(); });
$('#importJson').addEventListener('click', async () => { try { const data = JSON.parse($('#importBox').value); const r = await api('/api/import', { method: 'POST', body: JSON.stringify({ data }) }); alert('Imported ' + r.added + ' records'); refreshAll(); } catch (e) { alert(e.message); } });
$('#wipe').addEventListener('click', async () => { if (confirm('Wipe all posts, links, messages, metrics and rules in this workspace?')) { await api('/api/wipe', { method: 'POST', body: '{}' }); refreshAll(); } });

$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault(); const d = formData(e.target);
  const widgets = { planner: !!d.w_planner, inbox: !!d.w_inbox, analytics: !!d.w_analytics, links: !!d.w_links, bestTimes: !!d.w_bestTimes, competitors: !!d.w_competitors };
  ME.workspace = (await api('/api/workspace', { method: 'PATCH', body: JSON.stringify({ name: d.name, tagline: d.tagline, hours: d.hours, widgets }) })).workspace;
  refreshAll(); alert('Saved');
});
function fillSettings() {
  if (!ME || !ME.workspace) return;
  const f = $('#settingsForm'); f.name.value = ME.workspace.name || ''; f.tagline.value = ME.workspace.tagline || ''; f.hours.value = ME.workspace.hours || '';
  const w = ME.workspace.widgets || {};
  for (const k of ['planner','inbox','analytics','links','bestTimes','competitors']) { const el = f.querySelector(`[name="w_${k}"]`); if (el) el.checked = w[k] !== false; }
}

async function refreshAll() {
  if (!ME) return;
  const dash = await api('/api/dashboard');
  const names = { planner: ['Posts', dash.counts.posts + ' total · ' + dash.counts.scheduled + ' scheduled'], inbox: ['Inbox', dash.counts.inboxOpen + ' open'], analytics: ['Analytics', 'Unlimited history'], links: ['Link page links', dash.counts.links], bestTimes: ['Best time', dash.bestTimes[0] ? dash.bestTimes[0].hour + ':00' : 'Import metrics'], competitors: ['Competitors', 'Unlimited tracking'] };
  $('#dashWidgets').innerHTML = Object.entries(names).filter(([k]) => !dash.widgets || dash.widgets[k] !== false).map(([k, v]) => `<div class="card"><h2>${v[0]}</h2><p>${esc(v[1])}</p></div>`).join('');
  $('#upcoming').innerHTML = dash.upcoming.map(p => `<li><span class="badge">${esc(p.platform)}</span>${esc(new Date(p.scheduledAt).toLocaleString())} — ${esc(p.caption.slice(0, 90))}</li>`).join('') || '<li>Nothing scheduled yet — try the command bar.</li>';
  $('#bestTimes').innerHTML = dash.bestTimes.map(t => `<li>${t.hour}:00 — avg engagement ${t.avgEngagement} across ${t.posts} posts</li>`).join('') || '<li>Import metrics in Analytics to unlock this.</li>';
  $('#notifs').innerHTML = dash.notifications.map(n => `<li>${esc(new Date(n.createdAt).toLocaleString())} — ${esc(n.text)}</li>`).join('') || '<li>No activity yet.</li>';

  const posts = (await api('/api/posts')).posts;
  $('#postList').innerHTML = posts.map(p => `<li><span class="badge">${esc(p.platform)}</span><span class="badge">${esc(p.status)}</span> ${p.scheduledAt ? esc(new Date(p.scheduledAt).toLocaleString()) + ' — ' : ''}${esc(p.caption)} <button data-act="copy" data-id="${p.id}">Copy</button> ${p.status !== 'published' ? `<button data-act="pub" data-id="${p.id}">Mark published</button>` : ''} <button data-act="del" data-id="${p.id}">Delete</button></li>`).join('') || '<li>No posts yet.</li>';
  $('#postList').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
    const post = posts.find(x => x.id === b.dataset.id);
    if (b.dataset.act === 'copy') { await navigator.clipboard.writeText(post.caption); b.textContent = 'Copied ✓'; }
    if (b.dataset.act === 'pub') { await api('/api/posts/' + post.id, { method: 'PATCH', body: JSON.stringify({ status: 'published' }) }); refreshAll(); }
    if (b.dataset.act === 'del') { await api('/api/posts/' + post.id, { method: 'DELETE' }); refreshAll(); }
  }));

  const msgs = (await api('/api/messages')).messages;
  $('#msgList').innerHTML = msgs.map(m => `<li><span class="badge">${esc(m.platform)}</span><strong>${esc(m.from)}:</strong> ${esc(m.body)}<br><em>Suggested reply${m.autoRule ? ' (auto-rule)' : ''}:</em> ${esc(m.suggestedReply || '')} ${m.status === 'open' ? `<button data-id="${m.id}">Mark resolved</button>` : '✓ resolved'}</li>`).join('') || '<li>Inbox is empty.</li>';
  $('#msgList').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => { await api('/api/messages/' + b.dataset.id, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) }); refreshAll(); }));
  const rules = (await api('/api/rules')).rules;
  $('#ruleList').innerHTML = rules.map(r => `<li>“${esc(r.keyword)}” → ${esc(r.reply)}</li>`).join('');

  const links = await api('/api/links');
  $('#publicLink').textContent = location.origin + '/p/' + links.slug; $('#publicLink').href = '/p/' + links.slug;
  $('#linkList').innerHTML = links.links.map(l => `<li>${esc(l.title)} — <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a> · ${l.clicks || 0} clicks <button data-id="${l.id}">Delete</button></li>`).join('') || '<li>No links yet — add your shop, booking page, socials.</li>';
  $('#linkList').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => { await api('/api/links/' + b.dataset.id, { method: 'DELETE' }); refreshAll(); }));

  const mets = await api('/api/metrics');
  $('#rollup').innerHTML = mets.rollup.length ? '<ul>' + mets.rollup.map(r => `<li><strong>${esc(r.platform)}</strong>: ${r.posts} posts · ${r.likes} likes · ${r.comments} comments · ${r.shares} shares · ${r.clicks} clicks · ${r.reach} reach</li>`).join('') + '</ul>' : '<p>No metrics imported yet.</p>';

  const comps = (await api('/api/competitors')).competitors;
  $('#competitorList').innerHTML = comps.map(c => `<li><strong>${esc(c.handle)}</strong> (${esc(c.platform)}) — ${esc(c.notes || '')}</li>`).join('');
  const watch = (await api('/api/watchlist')).entries;
  $('#watchList').innerHTML = watch.map(w => `<li>${esc(w.handle)} (${esc(w.platform)}) — ${esc(w.status)} ${esc(w.notes || '')}</li>`).join('');
  const members = (await api('/api/members')).members;
  $('#memberList').innerHTML = members.map(m => `<li>${esc(m.email)} — ${esc(m.role)}${m.inviteCode ? ' (invite pending)' : ''}</li>`).join('');
  const plugins = (await api('/api/plugins')).plugins;
  $('#pluginList').innerHTML = plugins.map(p => `<li><strong>${esc(p.name)}</strong> ${p.roadmap ? '<span class="badge">roadmap</span>' : p.enabled ? '<span class="badge">on</span>' : ''} — ${esc(p.description)}</li>`).join('');
}
boot();
