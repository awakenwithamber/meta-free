'use strict';
// Plugin registry: a plugin is a manifest {id, name, description, version, hooks}.
// Hooks today: 'dashboardWidget' (adds a widget key), 'assistantIntent' (reserved),
// 'publisher' (reserved for roadmap API publishers). Enabling is per-workspace and stored
// on the workspace record (workspace.plugins = {id: true/false}).

const BUILTIN = [
  { id: 'link-page', name: 'Link Page', version: '1.0.0', description: 'Unlimited public link-in-bio page at /p/:slug with click counts.', hooks: ['dashboardWidget'] },
  { id: 'competitor-watch', name: 'Competitor Watch', version: '1.0.0', description: 'Track unlimited competitor profiles with notes.', hooks: ['dashboardWidget'] },
  { id: 'impersonation-watchlist', name: 'Impersonation Watchlist', version: '1.0.0', description: 'Log impersonator accounts and report status — a record-keeping aid, not Meta-internal protection.', hooks: [] },
  { id: 'meta-publisher', name: 'Meta Publisher (roadmap)', version: '0.0.1', description: 'Direct publishing via Meta Content Publishing API. Requires a Meta developer app + app review (user-held step). Not active in v0.1.', hooks: ['publisher'], roadmap: true },
  { id: 'whatsapp-agent', name: 'WhatsApp Agent (roadmap)', version: '0.0.1', description: 'Auto-replies inside WhatsApp via the official Cloud API. Requires WhatsApp Business API setup. Not active in v0.1.', hooks: ['publisher'], roadmap: true },
  { id: 'ollama-assistant', name: 'Local LLM Assistant (roadmap)', version: '0.0.1', description: 'Point the assistant at a local Ollama model for richer drafts — still free and offline.', hooks: ['assistantIntent'], roadmap: true },
];

function listPlugins(workspace) {
  const enabled = (workspace && workspace.plugins) || {};
  return BUILTIN.map(p => ({ ...p, enabled: enabled[p.id] !== false && !p.roadmap ? true : !!enabled[p.id] && !p.roadmap }));
}

module.exports = { BUILTIN, listPlugins };
