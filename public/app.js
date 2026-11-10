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

// ---------- plan features (tier gating, client side) ----------
// The server enforces the same gates on the API (403 + plain-language
// explanation); this side simply never shows a locked feature as if it
// were available. MYF/MYPLAN come from GET /api/plans (myPlan) at the
// top of refreshAll; PLANS_DATA is the full payload for lock labels.
let MYF = new Set();
let MYPLAN = null;
let PLANS_DATA = null;
const has = f => MYF.has(f);
const NAV_FEATURE = { planner: 'planner', inbox: 'inbox', links: 'link-page', analytics: 'analytics', connect: 'connections', activity: 'audit-log' };
function planNameFor(featureId, pl) {
  if (!pl) return '';
  if (pl.free && pl.free.includes.some(f => f.id === featureId)) return 'Free';
  const t = (pl.plans || []).find(t => t.includes.some(f => f.id === featureId));
  return t ? `${t.name} (${t.price}/month)` : '';
}
function lockText(featureId, pl) {
  return `🔒 This is part of the ${planNameFor(featureId, pl)} plan. See Plans to join the founding waitlist or record a 30-day pre-launch trial — founding pricing, checkout not yet connected, no payment is taken.`;
}
function planBannerText() {
  if (!MYPLAN) return '';
  if (MYPLAN.via === 'owner-plan') return 'Your plan: Max — $0.00/month · platform owner plan. You are never charged, and this workspace is never registered with a billing provider.';
  if (MYPLAN.grandfathered) return 'Your plan: Enterprise (grandfathered) — the full feature set, free. Nothing was taken away when the Free plan launched.';
  if (MYPLAN.via === 'trial' || MYPLAN.via === 'trial-canceled') return `Your plan right now: ${MYPLAN.planName} (pre-launch trial) — trial dates are on the Plans page. Billing is not live; you will not be charged.`;
  return `Your plan: ${MYPLAN.planName} — free forever, no card, ever. Founding tiers below unlock more.`;
}
// Disable a form's controls while its feature is locked, with the reason
// written above it (visible-notices rule: stated before submit, in plain
// words). Idempotent — refreshAll runs this on every refresh.
function gateForm(formSel, feature, pl) {
  const form = $(formSel);
  if (!form) return;
  const locked = !has(feature);
  form.querySelectorAll('button, input, select, textarea').forEach(el => { el.disabled = locked; });
  let note = form.parentElement.querySelector(`.lock-note[data-for="${feature}"]`);
  if (locked && !note) {
    note = document.createElement('p');
    note.className = 'lock-note';
    note.dataset.for = feature;
    note.setAttribute('role', 'note');
    form.parentElement.insertBefore(note, form);
  }
  if (note) { note.hidden = !locked; note.textContent = locked ? lockText(feature, pl) : ''; }
}

// ---------- Terms Acceptance System ----------
// The acceptance UI exists ONLY while the server reports enforcement on
// (GET /api/consent/policy). While it is off — the production default
// until the owner approves the legal documents — nothing renders, no
// button is disabled by this code, and every flow is the pre-system
// flow. While on: the Terms box starts unticked, Create stays disabled
// until it is ticked, a NEW trial requires the separate billing
// authorization panel first, and a signed-in account whose recorded
// policy version fell behind gets the reacceptance prompt (blocking
// modal for customers; dismissible for the founder — prompted, never
// locked out; the server enforces the same distinction).
let consentPolicy = null;
async function loadConsentPolicy() {
  try { consentPolicy = await api('/api/consent/policy'); } catch { consentPolicy = null; }
  renderRegConsent();
  return consentPolicy;
}
function renderRegConsent() {
  const box = $('#regConsent');
  if (!box) return;
  const btn = $('#registerSubmit');
  if (!consentPolicy || !consentPolicy.enforcement) { box.innerHTML = ''; if (btn) btn.disabled = false; return; }
  const v = consentPolicy.versions;
  box.innerHTML = `
<label class="consent-check"><input type="checkbox" id="consent-terms"> <span>I have read and agree to the <a href="/legal/terms" target="_blank" rel="noopener">Terms of Service and User Agreement</a>, and acknowledge the <a href="/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
<label class="consent-check"><input type="checkbox" id="consent-promo-email"> <span>${esc(consentPolicy.promoEmailText)}</span></label>
<label class="consent-check"><input type="checkbox" id="consent-promo-sms"> <span>${esc(consentPolicy.promoSmsText)}</span></label>
<input type="hidden" id="consent-terms-version" value="${esc(v.termsVersion)}">
<input type="hidden" id="consent-privacy-version" value="${esc(v.privacyVersion)}">`;
  const sync = () => { if (btn) btn.disabled = !$('#consent-terms').checked; };
  box.querySelectorAll('input[type=checkbox]').forEach(c => c.addEventListener('change', sync));
  sync();
}
function consentPayload() {
  if (!consentPolicy || !consentPolicy.enforcement) return {};
  return {
    termsAccepted: !!($('#consent-terms') && $('#consent-terms').checked),
    termsVersion: $('#consent-terms-version') ? $('#consent-terms-version').value : null,
    privacyVersion: $('#consent-privacy-version') ? $('#consent-privacy-version').value : null,
    promoEmail: !!($('#consent-promo-email') && $('#consent-promo-email').checked),
    promoSms: !!($('#consent-promo-sms') && $('#consent-promo-sms').checked),
  };
}
function maybeShowReaccept(consentState) {
  const modal = $('#consentModal');
  if (!modal) return;
  if (!consentState || !consentState.needsReacceptance) { modal.hidden = true; modal.innerHTML = ''; return; }
  const v = consentState.versions || {};
  modal.innerHTML = `<div class="consent-modal-overlay"><div class="card consent-modal-card" role="alertdialog" aria-modal="true" aria-label="Updated legal agreements">
<h2>Our Terms were updated</h2>
<p>Please review and accept the current <a href="/legal/terms" target="_blank" rel="noopener">Terms of Service and User Agreement</a> and <a href="/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a> (version ${esc(v.termsVersion || '')}) to continue.</p>
<label class="consent-check"><input type="checkbox" id="reaccept-terms"> <span>I have read and agree to the Terms of Service and User Agreement, and acknowledge the Privacy Policy.</span></label>
<p class="err" id="reacceptErr" role="alert"></p>
<button id="reacceptAccept" disabled>Accept and continue</button>
${consentState.founderExempt ? '<button id="reacceptLater" type="button">Later — remind me next time</button>' : ''}
</div></div>`;
  modal.hidden = false;
  const box = $('#reaccept-terms');
  const btn = $('#reacceptAccept');
  box.addEventListener('change', () => { btn.disabled = !box.checked; });
  btn.addEventListener('click', async () => {
    try {
      await api('/api/consent/accept', { method: 'POST', body: JSON.stringify({ termsAccepted: box.checked, termsVersion: v.termsVersion, privacyVersion: v.privacyVersion }) });
      modal.hidden = true; modal.innerHTML = '';
      ME = await api('/api/me');
      refreshAll();
    } catch (err) { $('#reacceptErr').textContent = err.message; }
  });
  const later = $('#reacceptLater');
  if (later) later.addEventListener('click', () => { modal.hidden = true; modal.innerHTML = ''; });
}
// The first-charge DATE the 2:00 AM America/Denver rule produces for a
// trial starting now (the server's trial record carries the exact
// instant; the date follows from the same rule — Denver calendar date
// after the trial's completion date).
function firstChargeDateText(startMs) {
  const ends = startMs + 30 * 24 * 3600 * 1000;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ends));
  const o = {}; for (const p of parts) o[p.type] = p.value;
  return new Date(Date.UTC(+o.year, +o.month - 1, +o.day) + 24 * 3600 * 1000).toISOString().slice(0, 10);
}
function billingConsentSentence(plan) {
  return `I authorize Awaken With Amber LLC to charge my payment method ${plan.price}/month for the ${plan.name} subscription. My 30-day free trial starts today and no payment is taken today. If I do not cancel during the trial, the first charge of ${plan.price} is scheduled for ${firstChargeDateText(Date.now())} at about 2:00 AM Mountain Time (America/Denver), and my payment method will be charged ${plan.price} each month after that until I cancel. I understand I can cancel any time during the trial and I will not be charged, that canceling stops future charges, and that refunds follow the Terms of Service. Billing is not live yet — you will not be charged; this records your authorization and the exact price and dates above.`;
}

async function boot() {
  loadConsentPolicy();
  try { ME = await api('/api/me'); showApp(); maybeShowReaccept(ME.consent); } catch { showAuth(); }
}
function showAuth() { $('#auth').hidden = false; $('#app').hidden = true; $('#topnav').hidden = true; }
function showApp() { $('#auth').hidden = true; $('#app').hidden = false; $('#topnav').hidden = false; $('#ownerBadge').hidden = !(ME && ME.platformRole === 'owner'); refreshAll(); fillSettings(); }
function formData(f) { return Object.fromEntries(new FormData(f).entries()); }

$('#loginForm').addEventListener('submit', async e => { e.preventDefault(); try { await api('/api/login', { method: 'POST', body: JSON.stringify(formData(e.target)) }); ME = await api('/api/me'); showApp(); } catch (err) { $('#authErr').textContent = err.message; } });
$('#registerForm').addEventListener('submit', async e => { e.preventDefault(); try { await api('/api/register', { method: 'POST', body: JSON.stringify({ ...formData(e.target), ...consentPayload() }) }); ME = await api('/api/me'); showApp(); } catch (err) { $('#authErr').textContent = err.message; } });

// ---------- show/hide password + forgot password (owner directive 2026-11-07) ----------
// One wiring for every .pw-toggle button on the auth card: flips the
// target input between password and text and swaps the button's own
// label, so what tapping again does is always written on the button.
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide password' : 'Show password';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    input.focus();
  });
});
// Forgot view: the link reveals the reset-request form under the auth
// card, with the email carried over from the sign-in box so it never
// has to be typed twice.
$('#forgotLink').addEventListener('click', e => {
  e.preventDefault();
  const form = $('#forgotForm');
  form.hidden = false;
  const loginEmail = $('#loginForm input[name="email"]').value;
  if (loginEmail && !$('#forgotEmail').value) $('#forgotEmail').value = loginEmail;
  $('#forgotEmail').focus();
});
$('#forgotForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#forgotMsg');
  try {
    // The server answers the SAME message whether or not the account
    // exists — and says honestly that the message is QUEUED in the
    // outbox, not sent (no email provider is connected yet).
    const d = await api('/api/password/forgot', { method: 'POST', body: JSON.stringify({ email: $('#forgotEmail').value }) });
    msg.className = 'ok';
    msg.textContent = d.message || 'If an account exists for that email, a password reset link has been queued in the outbox.';
  } catch (err) {
    msg.className = 'err';
    msg.textContent = err.message;
  }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST', body: '{}' }); location.reload(); });

document.querySelectorAll('#topnav button[data-view]').forEach(b => {
  b.dataset.label = b.textContent;
  b.addEventListener('click', () => {
    const f = NAV_FEATURE[b.dataset.view];
    if (f && ME && !has(f)) {
      // Locked view: land on Plans with the reason in plain words.
      document.querySelectorAll('.view').forEach(v => v.hidden = true);
      $('#view-plans').hidden = false;
      const msg = $('#planMsg');
      if (msg) msg.textContent = lockText(f, PLANS_DATA);
      return;
    }
    document.querySelectorAll('.view').forEach(v => v.hidden = true);
    $('#view-' + b.dataset.view).hidden = false;
  });
});

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
$('#claimForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/claim/verify', { method: 'POST', body: JSON.stringify(formData(e.target)) });
    ME = await api('/api/me');
    $('#claimMsg').textContent = 'Claim verified — platform owner access is unlocked.';
    $('#ownerBadge').hidden = !(ME && ME.platformRole === 'owner');
    refreshAll();
  } catch (err) { $('#claimMsg').textContent = err.message; }
});
$('#inviteForm').addEventListener('submit', async e => { e.preventDefault(); try { const r = await api('/api/members/invite', { method: 'POST', body: JSON.stringify(formData(e.target)) }); $('#inviteMsg').textContent = 'Invite code: ' + r.inviteCode; refreshAll(); } catch (err) { $('#inviteMsg').textContent = err.message; } });
$('#joinForm').addEventListener('submit', async e => { e.preventDefault(); await api('/api/members/join', { method: 'POST', body: JSON.stringify(formData(e.target)) }); ME = await api('/api/me'); refreshAll(); alert('Joined workspace: ' + ME.workspace.name); });
$('#askForm').addEventListener('submit', async e => { e.preventDefault(); const r = await api('/api/assistant/ask', { method: 'POST', body: JSON.stringify(formData(e.target)) }); $('#askAnswer').textContent = r.answer; });
$('#importCsv').addEventListener('click', async () => { const r = await api('/api/metrics/import', { method: 'POST', body: JSON.stringify({ csv: $('#csvBox').value }) }); alert('Imported ' + r.added + ' rows'); refreshAll(); });
$('#importJson').addEventListener('click', async () => { try { const data = JSON.parse($('#importBox').value); const r = await api('/api/import', { method: 'POST', body: JSON.stringify({ data }) }); alert('Imported ' + r.added + ' records'); refreshAll(); } catch (e) { alert(e.message); } });
$('#wipe').addEventListener('click', async () => { if (confirm('Wipe all posts, links, messages, metrics and rules in this workspace?')) { await api('/api/wipe', { method: 'POST', body: '{}' }); refreshAll(); } });
$('#runAgent').addEventListener('click', async () => {
  const r = await api('/api/agent/run', { method: 'POST', body: '{}' });
  renderAgentRun(r.run);
  refreshAll();
});
function renderAgentRun(run) {
  if (!run) { $('#agentReport').innerHTML = ''; return; }
  $('#agentReport').innerHTML = `<p><strong>${esc(run.summary)}</strong></p>
    ${run.filled.length ? '<p>Filled: ' + run.filled.map(esc).join(' · ') + '</p>' : ''}
    ${run.needsHand && run.needsHand.length ? '<p>Needs your hand:</p><ul>' + run.needsHand.map(n => `<li>${esc(n)}</li>`).join('') + '</ul>' : ''}`;
}

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
  // Plans FIRST: every other render below is shaped by the workspace's
  // current plan features (MYF), so a locked feature is never fetched or
  // shown as if it were available. The server enforces the same gates.
  const pl = await api('/api/plans');
  PLANS_DATA = pl;
  MYPLAN = pl.myPlan || null;
  MYF = new Set(MYPLAN ? MYPLAN.features : []);
  document.querySelectorAll('#topnav button[data-view]').forEach(b => {
    const f = NAV_FEATURE[b.dataset.view];
    b.textContent = (f && !has(f)) ? b.dataset.label + ' 🔒' : b.dataset.label;
  });
  const dash = await api('/api/dashboard');
  const names = { planner: ['Posts', dash.counts.posts + ' total · ' + dash.counts.scheduled + ' scheduled'], inbox: ['Inbox', dash.counts.inboxOpen + ' open'], analytics: ['Analytics', 'Unlimited history'], links: ['Link page links', dash.counts.links], bestTimes: ['Best time', dash.bestTimes[0] ? dash.bestTimes[0].hour + ':00' : 'Import metrics'], competitors: ['Competitors', 'Unlimited tracking'] };
  const WIDGET_FEATURE = { planner: 'planner', inbox: 'inbox', analytics: 'analytics', links: 'link-page', bestTimes: 'analytics', competitors: 'competitors' };
  $('#dashWidgets').innerHTML = Object.entries(names).filter(([k]) => (!dash.widgets || dash.widgets[k] !== false) && (!WIDGET_FEATURE[k] || has(WIDGET_FEATURE[k]))).map(([k, v]) => `<div class="card"><h2>${v[0]}</h2><p>${esc(v[1])}</p></div>`).join('');
  $('#upcoming').innerHTML = dash.upcoming.map(p => `<li><span class="badge">${esc(p.platform)}</span>${esc(new Date(p.scheduledAt).toLocaleString())} — ${esc(p.caption.slice(0, 90))}</li>`).join('') || '<li>Nothing scheduled yet — try the command bar.</li>';
  $('#bestTimes').innerHTML = dash.bestTimes.map(t => `<li>${t.hour}:00 — avg engagement ${t.avgEngagement} across ${t.posts} posts</li>`).join('') || '<li>Import metrics in Analytics to unlock this.</li>';
  $('#notifs').innerHTML = dash.notifications.map(n => `<li>${esc(new Date(n.createdAt).toLocaleString())} — ${esc(n.text)}</li>`).join('') || '<li>No activity yet.</li>';

  const posts = (await api('/api/posts')).posts;
  const apprLabel = { draft: 'draft', pending_review: 'in review', approved: 'approved' };
  const apprButtons = p => {
    if (!has('approvals')) return '';
    const a = p.approval || 'approved';
    if (a === 'draft') return `<button data-act="submit" data-id="${p.id}">Submit for review</button>`;
    if (a === 'pending_review') return `<button data-act="approve" data-id="${p.id}">Approve</button> <button data-act="sendback" data-id="${p.id}">Send back</button>`;
    return `<button data-act="sendback" data-id="${p.id}">Back to draft</button>`;
  };
  $('#postList').innerHTML = posts.map(p => `<li><span class="badge">${esc(p.platform)}</span><span class="badge">${esc(p.status)}</span><span class="badge">${esc(apprLabel[p.approval] || 'approved')}</span> ${p.scheduledAt ? esc(new Date(p.scheduledAt).toLocaleString()) + ' — ' : ''}${esc(p.caption)} <button data-act="copy" data-id="${p.id}">Copy</button> ${apprButtons(p)} ${p.status !== 'published' ? `<button data-act="pub" data-id="${p.id}">Mark published</button>` : ''} <button data-act="del" data-id="${p.id}">Delete</button></li>`).join('') || '<li>No posts yet.</li>';
  $('#postList').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
    const post = posts.find(x => x.id === b.dataset.id);
    if (b.dataset.act === 'copy') { await navigator.clipboard.writeText(post.caption); b.textContent = 'Copied ✓'; }
    if (b.dataset.act === 'pub') { await api('/api/posts/' + post.id, { method: 'PATCH', body: JSON.stringify({ status: 'published' }) }); refreshAll(); }
    if (b.dataset.act === 'submit') { await api('/api/posts/' + post.id, { method: 'PATCH', body: JSON.stringify({ approval: 'pending_review' }) }); refreshAll(); }
    if (b.dataset.act === 'approve') { await api('/api/posts/' + post.id, { method: 'PATCH', body: JSON.stringify({ approval: 'approved' }) }); refreshAll(); }
    if (b.dataset.act === 'sendback') { await api('/api/posts/' + post.id, { method: 'PATCH', body: JSON.stringify({ approval: 'draft' }) }); refreshAll(); }
    if (b.dataset.act === 'del') { await api('/api/posts/' + post.id, { method: 'DELETE' }); refreshAll(); }
  }));

  if (has('due-queue')) {
    const due = await api('/api/due');
    $('#dueList').innerHTML = due.ready.map(p => `<li><span class="badge">${esc(p.platform)}</span><span class="badge">due</span> ${esc(new Date(p.scheduledAt).toLocaleString())} — ${esc(p.caption)} <button data-due="copy" data-id="${p.id}">Copy</button> <button data-due="pub" data-id="${p.id}">Mark published</button></li>`).join('') || '<li>Nothing due right now.</li>';
    $('#dueList').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
      const post = due.ready.find(x => x.id === b.dataset.id);
      if (b.dataset.due === 'copy') { await navigator.clipboard.writeText(post.caption); b.textContent = 'Copied ✓'; }
      if (b.dataset.due === 'pub') { await api('/api/posts/' + post.id, { method: 'PATCH', body: JSON.stringify({ status: 'published' }) }); refreshAll(); }
    }));
    $('#dueAwaiting').textContent = due.awaitingApproval.length ? `${due.awaitingApproval.length} due post(s) are still waiting on approval and are not in the publish queue yet.` : '';
  } else {
    $('#dueList').innerHTML = `<li>${esc(lockText('due-queue', pl))}</li>`;
    $('#dueAwaiting').textContent = '';
  }

  gateForm('#msgForm', 'inbox', pl);
  if (has('inbox')) {
    const msgs = (await api('/api/messages')).messages;
    $('#msgList').innerHTML = msgs.map(m => `<li><span class="badge">${esc(m.platform)}</span><strong>${esc(m.from)}:</strong> ${esc(m.body)}<br><em>Suggested reply${m.autoRule ? ' (auto-rule)' : ''}:</em> ${esc(m.suggestedReply || '')} ${m.status === 'open' ? `<button data-id="${m.id}">Mark resolved</button>` : '✓ resolved'}</li>`).join('') || '<li>Inbox is empty.</li>';
    $('#msgList').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => { await api('/api/messages/' + b.dataset.id, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) }); refreshAll(); }));
  } else {
    $('#msgList').innerHTML = `<li>${esc(lockText('inbox', pl))}</li>`;
  }
  gateForm('#ruleForm', 'auto-reply-rules', pl);
  if (has('auto-reply-rules')) {
    const rules = (await api('/api/rules')).rules;
    $('#ruleList').innerHTML = rules.map(r => `<li>“${esc(r.keyword)}” → ${esc(r.reply)}</li>`).join('');
  } else {
    $('#ruleList').innerHTML = `<li>${esc(lockText('auto-reply-rules', pl))}</li>`;
  }

  const links = await api('/api/links');
  $('#publicLink').textContent = location.origin + '/p/' + links.slug; $('#publicLink').href = '/p/' + links.slug;
  $('#linkList').innerHTML = links.links.map(l => `<li>${esc(l.title)} — <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a> · ${l.clicks || 0} clicks <button data-id="${l.id}">Delete</button></li>`).join('') || '<li>No links yet — add your shop, booking page, socials.</li>';
  $('#linkList').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => { await api('/api/links/' + b.dataset.id, { method: 'DELETE' }); refreshAll(); }));

  if (has('analytics')) {
    const mets = await api('/api/metrics');
    $('#rollup').innerHTML = mets.rollup.length ? '<ul>' + mets.rollup.map(r => `<li><strong>${esc(r.platform)}</strong>: ${r.posts} posts · ${r.likes} likes · ${r.comments} comments · ${r.shares} shares · ${r.clicks} clicks · ${r.reach} reach</li>`).join('') + '</ul>' : '<p>No metrics imported yet.</p>';
  } else {
    $('#rollup').innerHTML = `<p>${esc(lockText('analytics', pl))}</p>`;
  }

  gateForm('#competitorForm', 'competitors', pl);
  if (has('competitors')) {
    const comps = (await api('/api/competitors')).competitors;
    $('#competitorList').innerHTML = comps.map(c => `<li><strong>${esc(c.handle)}</strong> (${esc(c.platform)}) — ${esc(c.notes || '')}</li>`).join('');
  } else {
    $('#competitorList').innerHTML = `<li>${esc(lockText('competitors', pl))}</li>`;
  }
  gateForm('#watchForm', 'watchlist', pl);
  if (has('watchlist')) {
    const watch = (await api('/api/watchlist')).entries;
    $('#watchList').innerHTML = watch.map(w => `<li>${esc(w.handle)} (${esc(w.platform)}) — ${esc(w.status)} ${esc(w.notes || '')}</li>`).join('');
  } else {
    $('#watchList').innerHTML = `<li>${esc(lockText('watchlist', pl))}</li>`;
  }
  gateForm('#inviteForm', 'team', pl);
  const members = (await api('/api/members')).members;
  $('#memberList').innerHTML = members.map(m => `<li>${esc(m.email)} — ${esc(m.role)}${m.inviteCode ? ' (invite pending)' : ''}</li>`).join('');
  if (has('connections')) {
    const conns = await api('/api/connections');
    const statusLabel = { connected_via_muse: 'connected via Muse', action_needed: 'action needed', browser_only: 'browser only', api_ready: 'API ready', not_started: 'not started' };
    $('#connList').innerHTML = conns.connections.map(c => `<li><span class="badge">${esc(c.platform)}</span><span class="badge">${esc(statusLabel[c.status] || c.status)}</span> <strong>${esc(c.handle || '')}</strong><br><small>${esc(c.note || '')}</small></li>`).join('');
    const can = conns.canonical;
    $('#canonicalList').innerHTML = [['Display name', can.displayName], ['Handle', can.handle], ['Website', can.website], ['Contact email (display)', can.emailDisplay], ['Business phone (display)', can.phoneDisplay], ['Location', can.location], ['Hours', can.hours]].map(([k, v]) => `<li><strong>${esc(k)}:</strong> ${esc(v)}</li>`).join('');
    const runs = (await api('/api/agent/runs')).runs;
    if (runs.length) renderAgentRun(runs[0]);
  } else {
    $('#connList').innerHTML = `<li>${esc(lockText('connections', pl))}</li>`;
    $('#canonicalList').innerHTML = '';
  }
  const runAgentBtn = $('#runAgent');
  if (runAgentBtn) runAgentBtn.disabled = !has('connections');

  const plugins = (await api('/api/plugins')).plugins;
  $('#pluginList').innerHTML = plugins.map(p => `<li><strong>${esc(p.name)}</strong> ${p.roadmap ? '<span class="badge">roadmap</span>' : p.enabled ? '<span class="badge">on</span>' : ''} — ${esc(p.description)}</li>`).join('') + (has('plugins') ? '' : `<li>${esc(lockText('plugins', pl))}</li>`);

  if (has('audit-log')) {
    const activity = (await api('/api/activity')).activity;
    $('#activityList').innerHTML = activity.map(a => `<li>${esc(new Date(a.createdAt).toLocaleString())} — <strong>${esc(a.actor)}</strong> · ${esc(a.action)}${a.detail ? ' · ' + esc(a.detail) : ''}</li>`).join('') || '<li>No activity recorded yet.</li>';
  } else {
    $('#activityList').innerHTML = `<li>${esc(lockText('audit-log', pl))}</li>`;
  }

  // (pl was fetched at the top of refreshAll — every render above and
  // below is shaped by the same payload.)
  $('#plansFoundingLabel').textContent = pl.foundingLabel;
  $('#myPlanBanner').textContent = planBannerText();
  // Settings data controls follow the same data-portability gate the
  // server enforces (GET /api/export, POST /api/import, POST /api/wipe).
  const wipeBtn = $('#wipe'), importBtn = $('#importJson'), fileInput = $('#importFile');
  if (wipeBtn) wipeBtn.disabled = !has('data-portability');
  if (importBtn) importBtn.disabled = !has('data-portability');
  if (fileInput) fileInput.disabled = !has('data-portability');
  const expLink = document.querySelector('a[href="/api/export"]');
  if (expLink && !expLink.dataset.gated) {
    expLink.dataset.gated = '1';
    expLink.addEventListener('click', e => { if (!has('data-portability')) { e.preventDefault(); alert(lockText('data-portability', PLANS_DATA)); } });
  }
  $('#trialBanner').textContent = pl.trialNotice || '';
  $('#plansProviderLine').textContent = (pl.billingProvider && pl.billingProvider.line) || '';
  $('#plansPaymentNote').textContent = pl.paymentNote || '';
  $('#plansNote').textContent = pl.currentStateNote;
  $('#plansSource').textContent = `Rate card: 50% of ${pl.source.product} prices verified from ${pl.source.verifiedFrom} on ${pl.source.verifiedOn}. True halves of $14.99 and $49.99 are $7.495 and $24.995, rounded half-up to $7.50 and $25.00.`;
  const trial = pl.myTrial;
  const trialBlock = t => {
    if (trial && trial.beta) {
      // Beta trial (lib/beta): never a first charge — when it ends the
      // workspace returns to Free. Never render the public trial's
      // first-charge framing for it.
      if (trial.tierId === t.id && trial.effectiveStatus === 'running' && trial.status !== 'canceled') return `<p><span class="badge">Beta trial running</span><br><strong>Beta trial: ${trial.daysRemaining} day${trial.daysRemaining === 1 ? '' : 's'} left</strong> — ${esc(t.name)}, ${esc(t.price)}/month at founding pricing.<br>When it ends, your workspace returns to the Free plan — you will not be charged.<br><button data-cancel-trial="1">Cancel trial</button></p>`;
      if (trial.tierId === t.id && trial.status === 'canceled') return `<p><span class="badge">Beta trial canceled</span><br>Your access continues until ${esc(new Date(trial.endsAt).toLocaleString())}, then your workspace returns to the Free plan. You will not be charged.</p>`;
      if (trial.effectiveStatus === 'running') return `<button data-beta-switch="${esc(t.id)}">Switch my beta trial to ${esc(t.name)} (same end date)</button>`;
      return '<p><small>This workspace has already used its free trial.</small></p>';
    }
    if (!trial) return `<button data-trial="${esc(t.id)}">Start 30-day free trial — pre-launch record, no charge</button>`;
    if (trial.tierId === t.id && trial.effectiveStatus === 'running') return `<p><span class="badge">Trial running</span><br><strong>Trial: ${trial.daysRemaining} day${trial.daysRemaining === 1 ? '' : 's'} left</strong> — ${esc(t.name)}, ${esc(t.price)}/month.<br>First charge would be ${esc(new Date(trial.firstChargeAt).toLocaleString())} (about 2:00 AM Mountain Time). Billing is not live yet — you will not be charged.<br><button data-cancel-trial="1">Cancel trial</button></p>`;
    if (trial.tierId === t.id && trial.status === 'canceled') return `<p><span class="badge">Trial canceled</span><br>Your access continues until ${esc(new Date(trial.endsAt).toLocaleString())}, and you will not be charged.</p>`;
    if (trial.effectiveStatus === 'running') return `<button data-trial="${esc(t.id)}">Switch my trial to ${esc(t.name)} (same end date)</button>`;
    return '<p><small>This workspace has already used its free trial.</small></p>';
  };
  const freeCard = pl.free ? `<div class="card"><h2 class="brand-font">${esc(pl.free.name)}</h2>
    <p><strong>${esc(pl.free.price)}</strong> / month — free forever, no card, ever.</p>
    <ul>${pl.free.includes.map(f => `<li>✓ ${esc(f.name)}</li>`).join('')}</ul>
    ${pl.myPlan && pl.myPlan.planId === 'free' ? '<p><span class="badge">Your current plan</span></p>' : pl.myPlan && pl.myPlan.grandfathered ? '<p><small>Your workspace is grandfathered on the full Enterprise set — the Free plan is what new workspaces start on.</small></p>' : ''}
  </div>` : '';
  $('#planGrid').innerHTML = freeCard + pl.plans.map(t => `<div class="card"><h2 class="brand-font">${esc(t.name)}</h2>
    <p><strong>${esc(t.price)}</strong> / month <small>(Meta One: ${esc(t.sourcePrice)} / month)</small></p>
    <ul>${t.includes.map(f => `<li>✓ ${esc(f.name)}</li>`).join('')}</ul>
    ${pl.myInterest.includes(t.id) ? `<p><span class="badge">On the founding waitlist</span>${pl.myReferences && pl.myReferences[t.id] ? `<br><small>Your reference: <strong>${esc(pl.myReferences[t.id])}</strong> — you'll receive a Bluevine invoice when founding enrollment opens.</small>` : ''}</p>` : `<button data-plan="${esc(t.id)}">${esc(pl.interestLabel)}</button>`}
    ${trialBlock(t)}
  </div>`).join('');
  $('#planGrid').querySelectorAll('button[data-plan]').forEach(b => b.addEventListener('click', async () => {
    try {
      const r = await api('/api/plans/interest', { method: 'POST', body: JSON.stringify({ planId: b.dataset.plan }) });
      $('#planMsg').textContent = r.already ? (r.interest && r.interest.reference ? `You are already on the waitlist for that tier. Your reference: ${r.interest.reference}.` : 'You are already on the waitlist for that tier.') : (r.referenceMessage || 'Added to the founding waitlist — no payment taken.');
      refreshAll();
    } catch (err) { $('#planMsg').textContent = err.message; }
  }));
  $('#planGrid').querySelectorAll('button[data-trial]').forEach(b => b.addEventListener('click', async () => {
    const startTrial = async (extra) => {
      const r = await api('/api/plans/trial', { method: 'POST', body: JSON.stringify({ planId: b.dataset.trial, ...(extra || {}) }) });
      $('#planMsg').textContent = r.switched ? 'Trial switched — the end date did not change, and you will not be charged.' : 'Trial recorded. Billing is not live yet — you will not be charged.';
      refreshAll();
    };
    try {
      // Terms Acceptance System: starting a NEW trial while enforcement
      // is on first shows the separate billing authorization panel —
      // the trial posts only once that box is ticked. A tier SWITCH
      // keeps the original trial's authorization and posts directly.
      if (consentPolicy && consentPolicy.enforcement && !trial) {
        const plan = pl.plans.find(t => t.id === b.dataset.trial);
        const panel = $('#billingConsentPanel');
        panel.innerHTML = `<div class="card"><h2>Billing authorization — ${esc(plan.name)}</h2>
<label class="consent-check"><input type="checkbox" id="billing-consent-check"> <span>${esc(billingConsentSentence(plan))}</span></label>
<p class="err" id="billingConsentErr" role="alert"></p>
<button id="billingConsentGo" disabled>Start my 30-day free trial</button>
<button id="billingConsentCancel" type="button">Not now</button></div>`;
        const check = $('#billing-consent-check');
        const go = $('#billingConsentGo');
        check.addEventListener('change', () => { go.disabled = !check.checked; });
        $('#billingConsentCancel').addEventListener('click', () => { panel.innerHTML = ''; });
        go.addEventListener('click', async () => {
          try {
            await startTrial({ billingConsentAccepted: check.checked, billingVersion: consentPolicy.versions.billingVersion });
            panel.innerHTML = '';
          } catch (err) { $('#billingConsentErr').textContent = err.message; }
        });
        return;
      }
      await startTrial();
    } catch (err) { $('#planMsg').textContent = err.message; }
  }));
  $('#planGrid').querySelectorAll('button[data-cancel-trial]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api('/api/plans/trial/cancel', { method: 'POST', body: '{}' });
      $('#planMsg').textContent = 'Trial canceled. Access continues until the trial end date, and you will not be charged.';
      refreshAll();
    } catch (err) { $('#planMsg').textContent = err.message; }
  }));
  // Beta tester trial (lib/beta): its own card, shown when signups are
  // open, when this workspace holds a beta trial, or to the platform
  // owner (who controls the gate). The full beta notice renders ABOVE
  // any button — terms first, signup second (visible-notices rule).
  const betaInfo = pl.beta;
  const postBetaTrial = async (planId, extra) => api('/api/plans/beta-trial', { method: 'POST', body: JSON.stringify({ planId, ...(extra || {}) }) });
  const startBetaWithConsent = async (planId, msgEl) => {
    const startBeta = async (extra) => {
      const r = await postBetaTrial(planId, extra);
      msgEl.textContent = r.switched ? 'Beta trial switched — the end date did not change, and you will not be charged.' : 'Beta trial started. It is free for 30 days, and you will not be charged — when it ends, your workspace returns to the Free plan.';
      refreshAll();
    };
    if (consentPolicy && consentPolicy.enforcement) {
      const plan = pl.plans.find(t => t.id === planId);
      const panel = $('#billingConsentPanel');
      panel.innerHTML = `<div class="card"><h2>Beta trial terms — ${esc(plan.name)}</h2>
<label class="consent-check"><input type="checkbox" id="billing-consent-check"> <span>${esc((betaInfo.consentTextByPlan || {})[plan.id] || '')}</span></label>
<p class="err" id="billingConsentErr" role="alert"></p>
<button id="billingConsentGo" disabled>Start my 30-day beta trial</button>
<button id="billingConsentCancel" type="button">Not now</button></div>`;
      const check = $('#billing-consent-check');
      const go = $('#billingConsentGo');
      check.addEventListener('change', () => { go.disabled = !check.checked; });
      $('#billingConsentCancel').addEventListener('click', () => { panel.innerHTML = ''; });
      go.addEventListener('click', async () => {
        try {
          await startBeta({ billingConsentAccepted: check.checked, billingVersion: consentPolicy.versions.billingVersion });
          panel.innerHTML = '';
        } catch (err) { $('#billingConsentErr').textContent = err.message; }
      });
      return;
    }
    await startBeta();
  };
  $('#planGrid').querySelectorAll('button[data-beta-switch]').forEach(b => b.addEventListener('click', async () => {
    try {
      const r = await postBetaTrial(b.dataset.betaSwitch);
      $('#planMsg').textContent = r.switched ? 'Beta trial switched — the end date did not change, and you will not be charged.' : 'Beta trial updated.';
      refreshAll();
    } catch (err) { $('#planMsg').textContent = err.message; }
  }));
  const betaCard = $('#betaCard');
  if (betaCard && betaInfo) {
    const mine = betaInfo.mine;
    betaCard.hidden = !(betaInfo.enabled || mine || pl.platformOwner);
    $('#betaTitle').textContent = betaInfo.label || 'Beta tester trial — 30 days free';
    $('#betaNotice').textContent = betaInfo.notice || '';
    const body = $('#betaBody');
    if (mine && mine.status !== 'canceled' && mine.effectiveStatus === 'running') {
      body.innerHTML = `<p><span class="badge">Beta trial running</span><br><strong>${mine.daysRemaining} day${mine.daysRemaining === 1 ? '' : 's'} left</strong> — ${esc(mine.tierName)}, ${esc(mine.price)}/month at founding pricing.<br>Your trial ends ${esc(new Date(mine.endsAt).toLocaleString())}. When it ends, your workspace returns to the Free plan — you will not be charged.<br><button data-beta-cancel="1">Cancel beta trial</button></p>`;
    } else if (mine && mine.status === 'canceled') {
      body.innerHTML = `<p><span class="badge">Beta trial canceled</span><br>Your access continues until ${esc(new Date(mine.endsAt).toLocaleString())}, then your workspace returns to the Free plan. You will not be charged.</p>`;
    } else if (mine) {
      body.innerHTML = '<p><small>This workspace has already used its free trial.</small></p>';
    } else if (betaInfo.enabled) {
      body.innerHTML = pl.plans.map(t => `<p><strong>${esc(t.name)}</strong> — ${esc(t.price)}/month at founding pricing<br><button data-beta-trial="${esc(t.id)}">Start my 30-day beta trial — ${esc(t.name)}</button></p>`).join('');
    } else {
      body.innerHTML = '<p><small>Beta tester signups are closed right now.</small></p>';
    }
    body.querySelectorAll('button[data-beta-trial]').forEach(b => b.addEventListener('click', async () => {
      try { await startBetaWithConsent(b.dataset.betaTrial, $('#betaMsg')); }
      catch (err) { $('#betaMsg').textContent = err.message; }
    }));
    const betaCancel = body.querySelector('button[data-beta-cancel]');
    if (betaCancel) betaCancel.addEventListener('click', async () => {
      try {
        await api('/api/plans/trial/cancel', { method: 'POST', body: '{}' });
        $('#betaMsg').textContent = 'Beta trial canceled. Access continues until the trial end date, and you will not be charged.';
        refreshAll();
      } catch (err) { $('#betaMsg').textContent = err.message; }
    });
  }
  const betaOwnerCard = $('#betaOwnerCard');
  if (betaOwnerCard && betaInfo) {
    betaOwnerCard.hidden = !pl.platformOwner;
    if (pl.platformOwner) {
      const toggle = $('#betaEnabledToggle');
      toggle.checked = !!betaInfo.enabled;
      toggle.onchange = async () => {
        try {
          const r = await api('/api/plans/beta/settings', { method: 'POST', body: JSON.stringify({ enabled: toggle.checked }) });
          $('#betaOwnerMsg').textContent = r.beta && r.beta.enabled ? 'Beta tester signups are now OPEN.' : 'Beta tester signups are now CLOSED.';
          refreshAll();
        } catch (err) { $('#betaOwnerMsg').textContent = err.message; toggle.checked = !toggle.checked; }
      };
    }
  }
  $('#claimCard').hidden = !(ME && ME.claimStatus === 'pending');
  if (pl.interest) {
    $('#planInterestCard').hidden = false;
    $('#planInterestList').innerHTML = pl.interest.map(i => `<li>${esc(i.email)} — <strong>${esc(i.planName)}</strong> · ${esc(i.price)}/month · ${esc(new Date(i.createdAt).toLocaleString())}${i.reference ? ` · Reference: <strong>${esc(i.reference)}</strong>` : ''}${i.followUp ? ` · Follow-up email: draft saved — not sent` : ''}</li>`).join('') || '<li>No waitlist signups yet.</li>';
  } else {
    $('#planInterestCard').hidden = true;
  }
  if (pl.platformOwner && pl.allInterest) {
    $('#ownerWaitlistCard').hidden = false;
    $('#ownerWaitlistList').innerHTML = pl.allInterest.map(i => `<li>${esc(i.email)} — <strong>${esc(i.planName)}</strong> · ${esc(i.price)}/month · ${esc(i.workspaceName || 'workspace')} · ${esc(new Date(i.createdAt).toLocaleString())}${i.reference ? ` · Reference: <strong>${esc(i.reference)}</strong>` : ''}${i.followUp ? ` · Follow-up email: draft saved — not sent` : ''}</li>`).join('') || '<li>No waitlist signups anywhere yet.</li>';
  } else {
    $('#ownerWaitlistCard').hidden = true;
  }

  const ent = await api('/api/enterprise');
  $('#entFreeLine').textContent = ent.freeLine;
  $('#entPlanLine').textContent = planBannerText();
  $('#entStorage').textContent = `Edition: ${ent.edition} · Storage: ${ent.storage} · Backups kept: ${ent.backupsKept}`;
  $('#entLimit').textContent = ent.honestLimit;
  $('#backupKeep').textContent = ent.backupsKept;
  $('#featureList').innerHTML = ent.features.map(f => MYF.has(f.id)
    ? `<li>✓ <strong>${esc(f.name)}</strong> — ${esc(f.note)}</li>`
    : `<li>🔒 <strong>${esc(f.name)}</strong> — part of the ${esc(planNameFor(f.id, pl))} plan</li>`).join('');
  if (ME.role === 'owner' && has('backups')) {
    const bk = await api('/api/backups');
    $('#backupList').innerHTML = bk.backups.map(b => `<li>${esc(b.name)} · ${esc(new Date(b.uploadedAt).toLocaleString())} · ${Math.round((b.size || 0) / 1024)} KB <button data-backup="${esc(b.name)}">Restore</button></li>`).join('') || '<li>No backups yet — take the first one.</li>';
    $('#backupList').querySelectorAll('button').forEach(btn => btn.addEventListener('click', async () => {
      if (confirm('Restore the whole database from ' + btn.dataset.backup + '? A safety snapshot of the current state is taken first.')) {
        await api('/api/backups/restore', { method: 'POST', body: JSON.stringify({ name: btn.dataset.backup }) });
        $('#backupMsg').textContent = 'Restored from ' + btn.dataset.backup;
        refreshAll();
      }
    }));
  } else if (ME.role === 'owner') {
    $('#backupList').innerHTML = `<li>${esc(lockText('backups', pl))}</li>`;
  } else {
    $('#backupList').innerHTML = '<li>Backups are managed by the workspace owner.</li>';
  }
  const backupNowBtn = $('#backupNow');
  if (backupNowBtn) backupNowBtn.disabled = !has('backups');
}
$('#backupNow').addEventListener('click', async () => {
  try { const r = await api('/api/backups', { method: 'POST', body: '{}' }); $('#backupMsg').textContent = 'Backup saved: ' + r.backup.name; refreshAll(); }
  catch (err) { $('#backupMsg').textContent = err.message; }
});
boot();
