'use strict';
// Meta Free — developer identity and the platform-owner claim rule.
//
// Identity rules (owner's standing instructions):
//  - Amber's PUBLIC contact email is Amber@awakenagain.com. It is the only
//    email that may appear on public pages.
//  - Her LOGIN identity (the second claim email below) is private: it lives
//    ONLY in this server-side claim rule and must never be rendered on a
//    public page, in client JS, or in any API response body sent to another
//    account. (An account holder's own authenticated responses return their
//    own email to themselves — that is not public output.)
//  - No password is ever created, stored, or set for her anywhere in this
//    codebase — she sets her own password when she registers.

const IDENTITY = {
  developerName: 'Amber Lynn Patten',
  businessName: 'Awaken With Amber LLC',
  city: 'Salt Lake City, Utah',
  publicEmail: 'Amber@awakenagain.com',
  phone: '801-819-6795',
  site: 'awakenagain.com',
};

// Server-side ONLY claim rule: these two emails identify WHO may claim the
// PLATFORM owner role — distinct from owning one workspace. Case-insensitive.
//
// HARDENED 2026-11-07: an email alone no longer grants anything. Registering
// with a claim email creates the account with claimStatus 'pending' and NO
// owner role, and issues a one-time claim code into the operator store
// (app/lib/claims.js — the code is never returned by any API). The owner
// role activates only when the account holder enters that code in the app.
// Accounts that had ALREADY claimed owner before the hardening keep it —
// their state is never revoked by this code. No other account can receive
// the platform owner role — there is no API field, form field, or setting
// that grants it; register/login ignore any role a client tries to supply.
const OWNER_CLAIM_EMAILS = ['amber@awakenagain.com', 'dare2be4ree@gmail.com'];

function isOwnerEmail(email) {
  return typeof email === 'string' && OWNER_CLAIM_EMAILS.includes(email.trim().toLowerCase());
}

module.exports = { IDENTITY, OWNER_CLAIM_EMAILS, isOwnerEmail };
