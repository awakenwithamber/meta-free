'use strict';
// Natural-language command parser.
// Example: schedule New soap drop https://awakenagain.com tomorrow at 9am on instagram #handmade #utah
// Also: post ... now on facebook | draft ...

const PLATFORMS = ['facebook','instagram','whatsapp','threads','tiktok','youtube','linkedin','pinterest'];

function parseCommand(input, now = new Date()) {
  if (typeof input !== 'string' || !input.trim()) return { error: 'Empty command' };
  let text = input.trim();

  let intent = 'draft';
  const lower = text.toLowerCase();
  if (/^schedule\b/.test(lower)) { intent = 'scheduled'; text = text.replace(/^schedule\b/i, '').trim(); }
  else if (/^post\b/.test(lower)) { intent = 'ready'; text = text.replace(/^post\b/i, '').trim(); }
  else if (/^draft\b/.test(lower)) { intent = 'draft'; text = text.replace(/^draft\b/i, '').trim(); }

  // platform: "on instagram" / "for facebook"
  let platform = 'facebook';
  const pm = text.match(/\b(?:on|for)\s+(facebook|instagram|whatsapp|threads|tiktok|youtube|linkedin|pinterest)\b/i);
  if (pm) { platform = pm[1].toLowerCase(); text = text.replace(pm[0], '').trim(); }

  // hashtags + links are extracted but KEPT in the caption too (they belong to the post)
  const hashtags = (text.match(/#[\p{L}\p{N}_]+/gu) || []).map(h => h.slice(1));
  const links = text.match(/https?:\/\/[^\s]+/g) || [];

  // date/time
  let when = null;
  const date = new Date(now);
  let consumed = null;
  const rel = text.match(/\b(today|tomorrow)\b/i);
  const inDays = text.match(/\bin\s+(\d+)\s+days?\b/i);
  const weekday = text.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (rel) { if (rel[1].toLowerCase() === 'tomorrow') date.setDate(date.getDate() + 1); consumed = rel[0]; }
  else if (inDays) { date.setDate(date.getDate() + parseInt(inDays[1], 10)); consumed = inDays[0]; }
  else if (weekday) {
    const names = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const target = names.indexOf(weekday[1].toLowerCase());
    let add = (target - date.getDay() + 7) % 7; if (add === 0) add = 7;
    date.setDate(date.getDate() + add); consumed = weekday[0];
  }
  const time = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (time) {
    let h = parseInt(time[1], 10); const m = time[2] ? parseInt(time[2], 10) : 0;
    const ap = (time[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    date.setHours(h, m, 0, 0);
    consumed = (consumed ? consumed + ' ' : '') + time[0];
  } else if (intent === 'scheduled') { date.setHours(9, 0, 0, 0); }
  if (consumed) {
    for (const part of consumed.split(' ')) { /* removal below uses regexes */ }
    text = text
      .replace(/\b(today|tomorrow)\b/i, '')
      .replace(/\bin\s+\d+\s+days?\b/i, '')
      .replace(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, '')
      .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/i, '')
      .replace(/\s{2,}/g, ' ').trim();
  }
  if (intent === 'scheduled') when = date.toISOString();

  const caption = text.trim();
  if (!caption) return { error: 'Command has no post text' };
  return { intent, platform, caption, hashtags, links, scheduledAt: when, status: intent === 'scheduled' ? 'scheduled' : intent };
}

module.exports = { parseCommand, PLATFORMS };
