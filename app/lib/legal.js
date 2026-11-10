'use strict';
// Legal document pages — /legal/terms and /legal/privacy (Terms
// Acceptance System, owner directive 2026-11-07). This file is IDENTICAL
// in every Awaken Network platform; the platform's own name, product
// description, data practices, billing applicability, and pricing note
// come from lib/consent.js (PLATFORM_SCHEDULE), and the policy versions
// come from the same module's registry — so the served text can never
// drift from the versions consent records cite.
//
// The documents are DRAFTS. Every page carries the prominent banner
// "DRAFT — NOT YET IN EFFECT" (the visible-notices rule) and the
// registry's effectiveStatus stays 'draft' until the owner approves the
// final documents and legal review is complete (see
// muse-prime-awaken-network/legal-drafts/APPROVAL-CHECKLIST.md). The
// full master drafts live in that legal-drafts folder; these pages serve
// the same text with this platform's schedule applied.

const consent = require('./consent');
const { IDENTITY } = require('./config');

function esc(s) { return String(s ?? '').replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const STYLE = `:root{--plum:#150b26;--plum2:#1f1336;--plum3:#2a1a40;--gold:#d4af37;--gold2:#e6c766;--parch:#f4e8d0;--dim:#c9b896}
*{box-sizing:border-box}body{margin:0;background:var(--plum);color:var(--parch);font-family:'EB Garamond',Georgia,serif;font-size:19px;line-height:1.55}
main{max-width:820px;margin:0 auto;padding:1.2rem 1rem 3rem}
h1,h2{font-family:'Cinzel',Georgia,serif;color:var(--gold);letter-spacing:.03em}
h1{font-size:1.9rem}h2{font-size:1.25rem;margin-top:2rem}
a{color:var(--gold2)}
.draft-banner{background:#5a1420;border:2px solid #e67c7c;color:#ffe9e9;border-radius:10px;padding:1rem 1.2rem;margin:1rem 0;font-size:1.1rem}
.draft-banner strong{color:#ffb3b3}
.meta{color:var(--dim);font-size:.95rem}
.brandline{font-family:'Cinzel',Georgia,serif;color:var(--gold2);letter-spacing:.12em;text-transform:uppercase;font-size:.85rem}`;

function shell(title, inner) {
  const v = consent.currentVersions();
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} (DRAFT)</title><style>${STYLE}</style></head>
<body><main>
<div class="draft-banner" role="alert"><strong>DRAFT — NOT YET IN EFFECT.</strong> This document is a draft prepared for the owner's approval and legal review. It is published here so the final text can be reviewed in place; it does not yet bind ${esc(IDENTITY.businessName)} or any user, and the acceptance system that references it is switched off until approval is complete.</div>
${inner}
<div class="draft-banner"><strong>DRAFT — NOT YET IN EFFECT.</strong> Version ${esc(v.termsVersion)} · Status: ${esc(v.effectiveStatus)} · ${esc(IDENTITY.businessName)}, ${esc(IDENTITY.city)} · ${esc(IDENTITY.publicEmail)} · ${esc(IDENTITY.phone)}</div>
</main></body></html>`;
}

function termsPage() {
  const v = consent.currentVersions();
  const s = consent.PLATFORM_SCHEDULE;
  const billingSections = s.hasBilling ? `
<h2>8. Free trials</h2>
<p>Eligible paid plans offer a 30-day free trial. The trial's end date and first-charge date are shown to you before you start it and recorded on your account. No payment is taken when the trial starts. The trial lasts 30 full days and is never shortened. If you cancel during the trial, you will not be charged, and your access continues until the trial end date shown. A separate, explicit billing authorization (Section 9) is required before a trial can start — agreeing to these Terms alone does not authorize any charge.</p>
<h2>9. Subscriptions, renewals, and payment authorization</h2>
<p>Paid plans renew automatically until canceled. If a trial converts, the first charge is scheduled for about 2:00 AM America/Denver (Mountain Time) on the first billing date after the trial's completion date — the exact date is shown before you start and recorded on your trial; it is never taken before the trial ends. After the first charge, your plan renews monthly at the price shown for your tier until you cancel.</p>
<p>Charges are made only under the separate billing consent you give at trial start or checkout, which names the plan, the price, the renewal, and the first-charge date, and is recorded separately from your acceptance of these Terms.</p>
<p>Payments are processed by licensed third-party providers (currently Stripe, and invoicing through Bluevine). AwakenPay is our orchestration and dashboard layer over those providers — ${esc(IDENTITY.businessName)} is not itself a payment processor, does not hold your card details, and never stores full card or bank numbers.</p>
<p>If a charge fails, your access continues for a 3-day grace period while payment is retried. After the grace period, paid access pauses (your data is kept) and, if the balance stays unresolved, the subscription is canceled on day 14.</p>
<p>You may cancel at any time in the product or by contacting us; cancellation stops future charges and access continues to the end of the period or trial already running. Refunds: [OWNER DECISION — the proposed default is that cancellation is not itself a refund; charges made in error, duplicate charges, and charges after a timely cancellation are always refunded.] [LEGAL REVIEW: refund wording.]</p>` : `
<h2>8. Price</h2>
<p>${esc(s.name)} is free to join. There are no paid tiers, trials, or billing on this platform at this time; the subscription and billing sections of the master terms do not apply. If paid tiers are ever added, the billing authorization system described in the master terms must be enabled before the first charge.</p>`;
  const inner = `
<p class="brandline">${esc(IDENTITY.businessName)}</p>
<h1>Terms of Service and User Agreement — ${esc(s.name)}</h1>
<p class="meta">Version ${esc(v.termsVersion)} · Status: ${esc(v.effectiveStatus)} · Effective date: [set when approved and activated] · Contact: ${esc(IDENTITY.publicEmail)} · ${esc(IDENTITY.phone)} · ${esc(IDENTITY.city)}</p>
<h2>1. Agreement to these terms</h2>
<p>By creating an account on ${esc(s.name)}, you agree to these Terms of Service and User Agreement (the "Terms") and acknowledge the <a href="/legal/privacy">Privacy Policy</a>. If you do not agree, do not create an account. You must affirmatively accept these Terms — by ticking the acceptance box shown at registration — before an account is created. Acceptance is recorded with the version you accepted, the date and time, and audit metadata, and that record is the proof of agreement.</p>
<h2>2. Who may use the platform</h2>
<p>You must be at least 18 years old, or the age of majority where you live, whichever is higher, to hold a paid account. [LEGAL REVIEW: minimum age for free community accounts.] You are responsible for the accuracy of the information you provide and for all activity under your account. Keep your password private; we will never ask you to send it to us.</p>
<h2>3. The service</h2>
<p>${esc(s.productDescription)}</p>
<p>Features may change over time; we will describe material changes in the product or by notice to account holders. We work to keep the platform available and reliable, but it is not promised to be uninterrupted or error-free. [LEGAL REVIEW: availability wording.] ${esc(s.pricingNote)}</p>
<h2>4. Accounts and security</h2>
<p>One person or business per account unless the platform's team features say otherwise. Roles and permissions inside a workspace belong to that workspace's owner. Platform-owner (founder) accounts are held by ${esc(IDENTITY.businessName)} and are not transferable. Tell us promptly at ${esc(IDENTITY.publicEmail)} if you believe your account was used without your permission.</p>
<h2>5. Acceptable use</h2>
<p>You agree not to: break the law using the platform; infringe another person's rights; upload malware or attempt to breach security; scrape or bulk-harvest other users' data; send spam or deceptive messages; impersonate another person or business; or use the platform to store or transmit content you do not have the right to use. We may suspend or close accounts that violate this section, with notice where practical.</p>
<h2>6. Your content and data</h2>
<p>You keep ownership of the content and data you put into the platform ("Your Content"). You grant Awaken a limited license to host, store, process, display, and back up Your Content solely to operate the platform for you and as described in the Privacy Policy. [LEGAL REVIEW: license scope.] You are responsible for having the rights to Your Content, including any customer or client data you enter.</p>
<h2>7. Free plans and free access</h2>
<p>Free tiers are provided at $0 and may continue indefinitely at our discretion. Free accounts never require a payment method and are never converted to a paid plan automatically.</p>
${billingSections}
<h2>10. Third-party services</h2>
<p>The platform may connect to third-party services (for example payment processors, email delivery, and integrations you enable). Your use of those services is also governed by their terms. We are not responsible for third-party services we do not control.</p>
<h2>11. Our intellectual property</h2>
<p>The platform, its software, designs, names, and content we create are the property of ${esc(IDENTITY.businessName)} or its licensors. These Terms do not transfer any of that property to you. Feedback you send us may be used without obligation to you.</p>
<h2>12. Disclaimers</h2>
<p>[LEGAL REVIEW: warranty disclaimer wording.] The platform is provided "as is" and "as available." To the fullest extent permitted by law, we disclaim warranties of merchantability, fitness for a particular purpose, and non-infringement. Content on wellness and botanical topics is educational and is not medical advice, diagnosis, or treatment.</p>
<h2>13. Limitation of liability</h2>
<p>[LEGAL REVIEW: liability cap.] To the fullest extent permitted by law, ${esc(IDENTITY.businessName)}'s total liability arising from the platform will not exceed the amounts you paid us in the twelve months before the claim, and we are not liable for indirect, incidental, or consequential damages.</p>
<h2>14. Indemnification</h2>
<p>[LEGAL REVIEW.] You agree to indemnify ${esc(IDENTITY.businessName)} against claims arising from Your Content, your use of the platform in violation of these Terms, or your violation of another person's rights.</p>
<h2>15. Suspension and termination</h2>
<p>You may close your account at any time. We may suspend or terminate access for violation of these Terms, non-payment after the process in the billing section, or where required by law. Sections that by their nature should survive termination survive.</p>
<h2>16. Changes to these Terms</h2>
<p>If we make a material change to these Terms or the Privacy Policy, we will notify account holders (in the product and/or by email) and, where required, ask you to accept the new version before continuing to use gated features. The version you accepted is always recorded on your account, and prior versions remain part of your agreement history.</p>
<h2>17. Governing law and disputes</h2>
<p>[LEGAL REVIEW: governing law, venue, arbitration evaluation.] These Terms are governed by the laws of the State of Utah, USA. Disputes will be resolved in the state or federal courts located in Utah, unless applicable law requires otherwise.</p>
<h2>18. Contact</h2>
<p>${esc(IDENTITY.businessName)}, ${esc(IDENTITY.city)} · ${esc(IDENTITY.publicEmail)} · ${esc(IDENTITY.phone)}</p>`;
  return shell(`Terms of Service and User Agreement — ${s.name}`, inner);
}

function privacyPage() {
  const v = consent.currentVersions();
  const s = consent.PLATFORM_SCHEDULE;
  const practices = s.dataPractices.map(d => `<li>${esc(d)}</li>`).join('');
  const inner = `
<p class="brandline">${esc(IDENTITY.businessName)}</p>
<h1>Privacy Policy — ${esc(s.name)}</h1>
<p class="meta">Version ${esc(v.privacyVersion)} · Status: ${esc(v.effectiveStatus)} · Effective date: [set when approved and activated] · Contact: ${esc(IDENTITY.publicEmail)} · ${esc(IDENTITY.phone)} · ${esc(IDENTITY.city)}</p>
<h2>1. What we collect</h2>
<p>We collect only what the platform needs to work:</p>
<ul>
<li><strong>Account data:</strong> name, email address, and a securely hashed password (passwords are never stored in readable form).</li>
<li><strong>Platform data you create on ${esc(s.name)}:</strong></li>
</ul>
<ul>${practices}</ul>
<ul>
<li><strong>Billing records</strong> (paid plans only): plan, price, trial and subscription dates and status, provider transaction identifiers, and consent records. Full card and bank numbers are collected and held by our payment processors — never by us.</li>
<li><strong>Consent records:</strong> when you accept the Terms, authorize billing, or opt in to promotional messages, we record the version accepted, the date and time, your account identifier, and technical audit metadata (such as IP address and browser user-agent) as proof of consent.</li>
<li><strong>Technical data:</strong> session cookies needed to keep you signed in, and basic server logs needed to run and secure the platform.</li>
</ul>
<h2>2. How we use it</h2>
<p>To operate your account and workspace; to run trials, subscriptions, and billing you authorized; to send service messages (for example trial and payment notices); to provide promotional email or SMS only where you separately opted in; to secure the platform and prevent abuse; and to meet legal obligations. We do not sell personal information. [LEGAL REVIEW: confirm wording against applicable state privacy laws, including the Utah Consumer Privacy Act.]</p>
<h2>3. Promotional messages are optional</h2>
<p>Promotional email and SMS consent are separate from account registration, unchecked by default, and never inferred from any other acceptance. You may withdraw promotional consent at any time (unsubscribe links in email, STOP for SMS) without affecting your account. [LEGAL REVIEW: TCPA/CAN-SPAM wording.]</p>
<h2>4. Who we share it with</h2>
<p>Processors who run parts of the service (hosting — currently Vercel; payment processors — currently Stripe and Bluevine; delivery providers you enable) receive only what their function requires. Content you place in a shared workspace is visible to that workspace's members according to its roles. We may disclose information where required by law or to protect rights and safety. We do not share personal information with advertisers, and the platform carries no third-party advertising trackers.</p>
<h2>5. Cookies and sessions</h2>
<p>The platform uses a session cookie to keep you signed in and security measures to protect accounts. We do not use advertising cookies. [LEGAL REVIEW: revisit if analytics are added.]</p>
<h2>6. Retention</h2>
<p>Account and platform data is kept while your account is active and for a reasonable period afterward for backups, records, and legal obligations. Consent records are kept for as long as needed to prove the agreement history of an account. [OWNER DECISION: specific retention periods after account closure.] Backups are rotated on a fixed schedule (currently a 14-day rotation on platform databases).</p>
<h2>7. Security</h2>
<p>Passwords are hashed with a one-way function and never stored in plain text. Access to owner/operator functions is restricted, and sensitive operator data is stored hashed or kept out of API responses. No system is perfectly secure; we will notify affected users of a breach where the law requires. [LEGAL REVIEW: breach-notification commitments.]</p>
<h2>8. Your choices and rights</h2>
<p>You may update your profile information in the product; export data where the platform provides export; withdraw promotional consent at any time; and request access to, correction of, or deletion of your personal information by contacting ${esc(IDENTITY.publicEmail)}. We will respond within the time applicable law requires. [LEGAL REVIEW: rights wording.]</p>
<h2>9. Children</h2>
<p>The platform is not directed to children under 13, and we do not knowingly collect their information. [LEGAL REVIEW: align with the Terms' minimum-age clause.]</p>
<h2>10. Changes to this policy</h2>
<p>If we make a material change, we will notify account holders and, where required, request re-acceptance before continued use of gated features. The version you acknowledged is recorded on your account.</p>
<h2>11. Contact</h2>
<p>${esc(IDENTITY.businessName)}, ${esc(IDENTITY.city)} · ${esc(IDENTITY.publicEmail)} · ${esc(IDENTITY.phone)}</p>`;
  return shell(`Privacy Policy — ${s.name}`, inner);
}

module.exports = { termsPage, privacyPage };
