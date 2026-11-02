'use strict';
// Canonical public profile sheet + connections registry for Meta Free.
// Values are the owner's reconciled public details (display only — never login
// identities, never private data like DOB/EIN/personal phone).

const CANONICAL = {
  displayName: 'Awaken With Amber LLC',
  ownerName: 'Amber Lynn Patten',
  handle: '@awakenwithamber',
  website: 'https://awakenagain.com',
  linksHub: 'https://awakenagain.com/links',
  booking: 'https://koalendar.com/e/Awaken-With-Amber',
  emailDisplay: 'Amber@awakenagain.com',
  phoneDisplay: '801-819-6795',
  location: 'Salt Lake City, Utah',
  hours: 'Mon–Fri 11–7',
  tagline: 'Handcrafted herbal soaps, teas & botanical blends | Salt Lake City | Living Grimoire + free herb quiz',
  defaultLinks: [
    { title: 'All Links — Shop, Quiz + Living Grimoire', url: 'https://awakenagain.com/links' },
    { title: 'Shop Amber\u2019s Alchemy Apothecary', url: 'https://awakenagain.com' },
    { title: 'Book a consultation', url: 'https://koalendar.com/e/Awaken-With-Amber' },
    { title: 'Instagram — @awakenwithamber', url: 'https://www.instagram.com/awakenwithamber' },
    { title: 'YouTube — Awaken With Amber', url: 'https://www.youtube.com/@awakenagain' },
  ],
  defaultRules: [
    { keyword: 'hours', reply: 'We\u2019re available Mon\u2013Fri 11\u20137 (Salt Lake City). Message us here any time and we\u2019ll reply as soon as we\u2019re in.' },
    { keyword: 'order', reply: 'You can order at https://awakenagain.com — put your order number as the reference if you pay by Venmo/Cash App.' },
  ],
};

// Connection states a platform can be in, from most to least connected.
// connected_via_muse = Muse's connectors can read/write it today.
// api_ready          = official API path exists; needs the platform dev-app step (owner's hand).
// browser_only       = exists, but only reachable through the browser/app (no connector/API wired).
// action_needed      = a specific owner step is pending (named in the note).
// not_started        = no account/connection yet.
const CONNECTION_TEMPLATE = [
  { platform: 'facebook', handle: 'Awaken With Amber LLC + 5 more Pages', status: 'connected_via_muse', note: 'Pages manageable via Muse (publish/insights). Page About fields are edited in Business Suite, not via API connector.' },
  { platform: 'instagram', handle: '@awakenwithamber', status: 'connected_via_muse', note: 'Bio + bio links editable via Muse. Business contact fields (email/category) are edited in the IG app or Business Suite.' },
  { platform: 'messenger', handle: 'Awaken With Amber LLC', status: 'connected_via_muse', note: 'Messages readable via Muse.' },
  { platform: 'threads', handle: '@awakenwithamber', status: 'action_needed', note: 'Account exists but is not linked here. Owner step: open the Threads connect link and link the account in Meta Accounts Center.' },
  { platform: 'whatsapp', handle: '801-819-6795', status: 'action_needed', note: 'Owner step pending since Oct 2026: register the number in a Meta developer app (WhatsApp Cloud API), then the whatsapp-agent plugin can be built.' },
  { platform: 'youtube', handle: '@awakenagain', status: 'browser_only', note: 'Brand channel built Oct 2026 (banner, About, links). Managed via YouTube Studio in the browser; no publishing connector.' },
  { platform: 'tiktok', handle: '@awakenwithamber', status: 'browser_only', note: 'No connector. Profile fields are completed in the TikTok app/browser.' },
  { platform: 'linkedin', handle: 'linkedin.com/in/awakenwithamber', status: 'browser_only', note: 'No connector. Profile fields are completed in the browser.' },
];

function seedConnections(store, workspaceId) {
  const existing = store.all('connections', c => c.workspaceId === workspaceId);
  const have = new Set(existing.map(c => c.platform));
  const added = [];
  for (const t of CONNECTION_TEMPLATE) {
    if (!have.has(t.platform)) added.push(store.insert('connections', { workspaceId, ...t }));
  }
  return [...existing, ...added];
}

module.exports = { CANONICAL, CONNECTION_TEMPLATE, seedConnections };
