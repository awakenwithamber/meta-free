'use strict';
// Post approval workflow: a post carries an `approval` state alongside its
// scheduling `status`. Flow: draft → pending_review → approved (→ scheduled /
// published via the existing status field). Any step can send a post back to
// draft. Roles match the rest of the app: owners and editors can move a post
// through the flow; viewers cannot change anything (enforced at the API too).
//
// Legacy posts created before this feature have no `approval` field; they are
// treated as approved so existing queues (including agent/apply-inserted
// scheduled posts) keep working untouched.

const APPROVAL_STATES = ['draft', 'pending_review', 'approved'];

const TRANSITIONS = {
  draft: ['pending_review'],
  pending_review: ['approved', 'draft'],
  approved: ['draft'],
};

function approvalOf(post) {
  if (!post) return 'draft';
  return APPROVAL_STATES.includes(post.approval) ? post.approval : 'approved';
}

function canTransition(from, to) {
  const f = APPROVAL_STATES.includes(from) ? from : 'approved';
  if (!APPROVAL_STATES.includes(to)) return false;
  if (f === to) return true; // no-op is not an error
  return (TRANSITIONS[f] || []).includes(to);
}

function roleCanApprove(role) { return role === 'owner' || role === 'editor'; }

// The due queue: scheduled posts whose time has arrived, split into the ones
// cleared to publish and the ones still waiting on approval.
function dueQueue(store, workspaceId, now = new Date()) {
  const due = store.all('posts', p => p.workspaceId === workspaceId
    && p.status === 'scheduled' && p.scheduledAt && new Date(p.scheduledAt) <= now)
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
  return {
    ready: due.filter(p => approvalOf(p) === 'approved'),
    awaitingApproval: due.filter(p => approvalOf(p) !== 'approved'),
  };
}

module.exports = { APPROVAL_STATES, TRANSITIONS, approvalOf, canTransition, roleCanApprove, dueQueue };
