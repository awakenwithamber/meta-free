# Meta One — Feature Audit (Phase 1)

**Verified identity — VERIFIED 2026-11-02**
- "Meta One" is Meta Platforms' paid subscription bundle, launched **15 September 2026**.
- Official site: https://www.meta.com/meta-one-plans/ ("More with Meta One — Get more features and AI built into the apps you love")
- It sits on top of the free Facebook, Instagram, WhatsApp and Meta AI apps. Meta: "The core experience across our apps and Meta AI has always been free, and that's not changing."
- It **builds on Meta Verified**: Meta Verified = badge + impersonation protection only. Meta One includes those (in creator/business tiers) plus enhanced features and more AI usage. Current Meta Verified subscribers: "nothing changes right now."
- At launch: 50+ features, ~15 million subscriptions/trials reported by Meta (via trade coverage of Meta's announcement).
- Billing: mobile app only (Apple App Store / Google Play), auto-renewing, applies across accounts linked in Accounts Center. Availability/pricing "may vary by region, app and account"; rollout was described as limited/gradual testing.
- It does **not** include ad spend, Ads Manager access, ad credits, or reach. Ads are separate.

## Pricing — VERIFIED from Meta's official plans page + Meta's 15 Sep 2026 business announcement (via multiple trade sources quoting it directly)

### Personal / single-app
| Plan | Price/mo | Headline features (Meta official page) |
|---|---|---|
| WhatsApp Plus | $2.99 | Custom app icon, themes, pin extra chats, exclusive stickers/ringtones, upgraded chat lists |
| Facebook Plus | $3.99 | Custom app icon, super-react to Stories, preview Stories, search story viewer list, extend Story expiry, Story rewatch insights |
| Instagram Plus | $3.99 | (per coverage) custom app icon, custom bio fonts, more pinned posts, multiple Story audiences, extended Story duration |
| Meta One Core | $7.99 | WhatsApp Plus + Facebook Plus + more AI usage: generate/edit images, create/transform videos, voice & sound effects, benefits across profiles |
| Meta One Premium | $19.99 | Same bundle, expanded AI usage / more video creation |

### Creator / Business — priced **per profile**
| Plan | Price/mo per profile | Headline features |
|---|---|---|
| Essential | $14.99 | Option to apply for verified badge + impersonation protection (subject to eligibility), verified WhatsApp Business channel, enhanced profile / link page on Instagram with up to 20 links, upgraded Facebook profile links section, more access to Meta Business Agent on WhatsApp |
| Advanced | $49.99 | Everything in Essential + schedule Stories up to 30 days ahead, clickable links in organic posts & Reels, exportable analytics, deeper audience insights, competitive insights vs up to 10 public Instagram accounts, insights history beyond 90 days, team access without password sharing, more linked devices, more WhatsApp broadcast credits, more Business Agent responses |
| Expert | $149 | Highest feature levels: more links in content (reported 8 posts + 8 Reels/mo), more Business Agent capacity, human account support |
| Max | $499 | Highest levels (reported 12 posts + 12 Reels/mo), human account support |

Link allowances per tier are **reported by trade press, not published in Meta's announcement** — labelled REPORTED, not VERIFIED: free/unsubscribed Pages reportedly capped at 2 link posts/mo; Advanced 4+4, Expert 8+8, Max 12+12.

## Amber's own position — from her records, VERIFIED 2026-10-31
- Facebook **Meta One Essential $14.99/mo, kept/"parked"**, next charge Nov 11 (Google Play, dare2be4ree@gmail.com).
- WhatsApp Business Meta One Essential $14.99 — **cancelled** Oct 31, 2026 (that cancelled only the Play subscription, not her WhatsApp number/API route for 801-819-6795).
- So today she pays for Essential on one profile — the badge/protection tier — and gets **none** of Advanced's working tools (scheduling, post links, exportable analytics, team access) unless she pays $49.99/mo *per profile*.

## What Meta One actually sells, grouped
1. **Trust (Essential+):** verified badge, impersonation protection, verified WhatsApp channel.
2. **Expression (Plus/Core/Premium):** icons, themes, stickers, Story extras, pinned chats/posts, bio fonts.
3. **AI quota (Core/Premium, business tiers):** more image/video generation, voice effects, Meta Business Agent (AI customer replies on WhatsApp, free to start, metered by tier).
4. **Publishing (Advanced+):** Story scheduling 30 days, links in organic posts/Reels (metered).
5. **Measurement (Advanced+):** exportable analytics, deeper audience insights, competitor comparison (≤10), history >90 days.
6. **Team & support (Advanced+/Expert+):** delegated access without password sharing, human support at top tiers.

## Hard limits of any external alternative — stated plainly
These are **Meta-internal and cannot be recreated by any third-party app**, Meta Free included:
- The verified badge itself (it is Meta's trust signal, issued by Meta after Meta's verification).
- Impersonation protection (Meta monitoring its own platforms).
- Removing Meta's link caps *inside* Facebook/Instagram (the cap lives in their apps).
- Meta Business Agent running natively inside WhatsApp.
- Plus-tier cosmetics inside Meta's apps (icons, themes, stickers).

Everything else on the list is **workflow the user owns** — planning, scheduling prep, link pages, analytics records, reply drafting, team workflow, automations, data export — and can be done free, without per-profile metering. That is exactly what Meta Free builds.

## Open-source landscape researched (2026-11-02)
- **Postiz** (AGPL-3.0, ~34–40k GitHub stars): self-hosted scheduler/analytics; heavy stack (Postgres, Redis, Temporal) + you supply every platform's OAuth app.
- **Mixpost Lite** (MIT): single-user self-hosted scheduler, Docker/Laravel stack.
- **Postflare** (AGPL-3.0): Postiz-inspired, Cloudflare-native (Workers + D1 + R2), fits Cloudflare free plan, 36 platform integrations via official APIs.
- **Mastodon / PeerTube / Misskey** (Fediverse): fully owned social platforms — the true "no landlord" route, but they don't reach your Facebook/Instagram audience.
- **Meta's own free routes:** Meta Business Suite / Content Publishing API, Instagram Content Publishing API, WhatsApp Cloud API (free tier for service conversations) — official APIs are the legitimate integration path; they require Meta developer apps and review, which is why Meta Free's MVP is API-ready but ships with a working manual/queue workflow first.

## Improvement opportunities Meta Free targets
- **No per-profile pricing:** one workspace, all your profiles, $0.
- **No meters:** unlimited link-page links (vs 20), unlimited planned link posts (vs 2–12/mo), unlimited history (vs 90-day wall), unlimited competitor notes (vs 10).
- **Data ownership:** everything stored locally / self-hosted, exportable in one click as JSON/CSV; nothing trains a third party's model.
- **Natural-language control:** "schedule … tomorrow at 9am on instagram" instead of nested menus.
- **Local-first AI help:** rule-based assistant runs offline at $0; optional bring-your-own-model later — no quota anxiety.
