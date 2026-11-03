'use strict';
// Activity / audit log: one row per key workspace event, scoped by workspaceId.
// Rows are ordinary store records in the 'activity' collection, so they ride the
// same durable backend, export (workspace export includes them), and backups.

function logActivity(store, workspaceId, actor, action, detail) {
  if (!store || !workspaceId || !action) return null;
  return store.insert('activity', {
    workspaceId,
    actor: actor || 'system',
    action: String(action).slice(0, 60),
    detail: String(detail || '').slice(0, 500),
  });
}

function listActivity(store, workspaceId) {
  // Newest first; rows sharing a millisecond fall back to reverse insertion
  // order so same-timestamp events still list latest-first.
  return store.all('activity', a => a.workspaceId === workspaceId)
    .map((row, i) => ({ row, i }))
    .sort((a, b) => String(b.row.createdAt).localeCompare(String(a.row.createdAt)) || b.i - a.i)
    .map(x => x.row);
}

module.exports = { logActivity, listActivity };
