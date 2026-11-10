'use strict';
// Local, offline assistant: caption drafts, hashtags, reply suggestions, best-time heuristic.
// No network calls, no quota, no training on your data. Interface mirrors what a local LLM
// (e.g. Ollama) would provide so one can be dropped in later behind the same functions.

const STOP = new Set('the a an and or of to in for on with our your you is are this that it its from by at as be we'.split(' '));

function keywords(text) {
  return [...new Set((String(text).toLowerCase().match(/[a-z][a-z\-]{2,}/g) || []).filter(w => !STOP.has(w)))].slice(0, 6);
}

function suggestHashtags(text, brand = '') {
  const tags = keywords(text).map(w => '#' + w.replace(/-/g, ''));
  const base = ['#SmallBusiness', '#ShopLocal'];
  const brandTag = brand ? ['#' + brand.replace(/[^A-Za-z0-9]/g, '')] : [];
  return [...new Set([...brandTag, ...tags, ...base])].slice(0, 12);
}

function draftCaption(topic, platform = 'instagram', brand = '') {
  const tags = suggestHashtags(topic, brand).join(' ');
  const hooks = {
    instagram: `✨ ${topic}\n\nMade with care, shared with love. Tap the link in our page to see more.\n\n${tags}`,
    facebook: `${topic}\n\nSee more on our page — link in the comments and on our profile. Questions? Message us any time.\n\n${tags}`,
    whatsapp: `Hi! ${topic} — reply here to order or ask a question.`,
    threads: `${topic} ${tags}`,
  };
  return hooks[platform] || hooks.instagram;
}

// Suggested reply for an inbound message. Rule-based intent matching.
const INTENTS = [
  { name: 'price', match: /\b(price|cost|how much|pricing)\b/i, reply: (ctx) => `Thanks for asking! Prices are on our page here: ${ctx.linkPage || 'see the link on our profile'}. Want me to point you to a specific item?` },
  { name: 'hours', match: /\b(hours|open|when)\b/i, reply: (ctx) => `We're available ${ctx.hours || 'Mon–Fri 11am–7pm'}. Message us here any time and we'll reply as soon as we're in.` },
  { name: 'shipping', match: /\b(ship|shipping|deliver|delivery)\b/i, reply: () => `We ship in 3–5 business days and you'll get a note when your order ships. Orders $45+ ship free.` },
  { name: 'order', match: /\b(order|buy|purchase|checkout)\b/i, reply: (ctx) => `You can order right here: ${ctx.linkPage || 'link on our profile'}. Put your order number as the reference if you pay by Venmo/Cash App.` },
  { name: 'thanks', match: /\b(thank|thanks|great|love)\b/i, reply: () => `Thank you so much — that means a lot. 💜 Anything else I can help with?` },
  { name: 'help', match: /\b(help|problem|issue|broken|wrong)\b/i, reply: () => `I'm sorry that happened — let's fix it. Can you share your order number and what went wrong? We'll make it right.` },
];
function suggestReply(message, ctx = {}) {
  for (const intent of INTENTS) if (intent.match.test(message)) return { intent: intent.name, reply: intent.reply(ctx) };
  return { intent: 'general', reply: `Thanks for reaching out! We got your message and will reply shortly. In the meantime, our page has links, hours and FAQs: ${ctx.linkPage || 'see profile link'}` };
}

function matchAutoReply(message, rules) {
  for (const rule of rules || []) {
    if (!rule.enabled) continue;
    if (rule.keyword && message.toLowerCase().includes(String(rule.keyword).toLowerCase())) return rule;
  }
  return null;
}

// Best posting hour from imported metrics: hour (local) with highest average engagement.
function bestTimes(metrics) {
  const byHour = new Map();
  for (const m of metrics || []) {
    if (!m.timestamp) continue;
    const h = new Date(m.timestamp).getHours();
    const eng = (Number(m.likes) || 0) + (Number(m.comments) || 0) * 3 + (Number(m.shares) || 0) * 5 + (Number(m.clicks) || 0) * 2;
    const cur = byHour.get(h) || { hour: h, total: 0, n: 0 };
    cur.total += eng; cur.n += 1; byHour.set(h, cur);
  }
  return [...byHour.values()].map(r => ({ hour: r.hour, avgEngagement: Math.round((r.total / r.n) * 10) / 10, posts: r.n }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement).slice(0, 3);
}

function diagnose(text) {
  const t = String(text).toLowerCase();
  if (t.includes('login') || t.includes('password')) return 'Check caps lock, then use Settings → Export to confirm you are in the right workspace. Passwords are stored only as scrypt hashes. If you are locked out, use “Forgot your password?” on the sign-in page: if an account exists for that email, a single-use reset link (valid 60 minutes) is queued in the outbox — no email provider is connected yet, so it is queued, not sent.';
  if (t.includes('export')) return 'Exports live in Settings: full workspace JSON, plus CSV for posts and metrics. If a download is empty, import data or create a post first.';
  if (t.includes('publish')) return 'In v0.1 posts move draft → scheduled → ready, then use the copy/open hand-off. Direct API publishing is a roadmap plugin (needs a Meta developer app + review).';
  return 'Try the command bar: "schedule <text> tomorrow at 9am on instagram". Docs: docs/06-user-guide.md.';
}

module.exports = { suggestHashtags, draftCaption, suggestReply, matchAutoReply, bestTimes, keywords, diagnose };
