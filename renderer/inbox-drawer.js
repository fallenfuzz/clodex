// inbox-drawer.js — the operator inbox: a left-side drawer listing notes agents
// raised via [agent:notify-user] when blocked on Bogdan's decision, plus the
// always-visible unread badge in the sidebar footer. Newest-first; a note is
// marked read when its row is clicked; a "Mark all read" button clears the lot.
//
// FACTORY (matches ipc-log's genus, not the CRUD library drawers): live counter
// + event-driven list, fed by the single `notify` ipc broadcast the main-side
// handler emits per arrival. Self-contained — the only cross-boundary reach is
// window.api, so no core state is injected (the "click a live row to focus its
// session" nice-to-have was deliberately dropped to keep it so; the store,
// unread count, and workspace-name resolution are all pulled over ipc).
//
// The badge shows the GLOBAL unread count (store-derived via unreadCount()), not
// per-window traffic — every window's badge agrees. Workspace names resolve at
// RENDER time from the live workspaces list, so a rename stays correct and a
// since-deleted workspace falls back to a label rather than crashing the row.
//
// DOM-bound, so no unit tests per the R1 rule — leak-scanned like every island.

const { esc, fmtAgo } = require('./lib/format');

function createInboxDrawer() {
  const drawer = document.getElementById('inbox-drawer');
  const listEl = document.getElementById('inbox-list');
  const emptyEl = document.getElementById('inbox-empty');
  const markAllBtn = document.getElementById('inbox-mark-all');
  const closeBtn = document.getElementById('inbox-close');
  const openBtn = document.getElementById('inbox-open');
  const countEl = document.getElementById('inbox-count');

  async function refreshBadge() {
    let n = 0;
    try { n = await window.api.notificationUnreadCount(); } catch { n = 0; }
    countEl.textContent = String(n);
    countEl.classList.toggle('zero', !n);
  }

  // Resolve workspaceId -> display name at render time (renames stay correct;
  // a deleted workspace falls back to a label, never a crash).
  async function workspaceNames() {
    const map = new Map();
    try {
      for (const w of (await window.api.listWorkspaces()) || []) map.set(w.id, w.name);
    } catch { /* empty map → every row uses the fallback */ }
    return map;
  }

  async function renderList() {
    const [items, wsNames] = await Promise.all([
      window.api.listNotifications().catch(() => []),
      workspaceNames(),
    ]);
    listEl.innerHTML = '';
    if (!items || items.length === 0) {
      emptyEl.style.display = '';
      return;
    }
    emptyEl.style.display = 'none';
    // The store keeps append (chronological) order; the inbox reads newest-first.
    for (const note of items.slice().reverse()) {
      const wsLabel = note.workspaceId == null
        ? ''
        : (wsNames.get(note.workspaceId) || (note.workspaceId ? '(deleted workspace)' : ''));
      const el = document.createElement('div');
      el.className = 'inbox-item' + (note.readAt == null ? ' unread' : '');
      el.innerHTML = `
        <div class="inbox-item-head">
          <span class="inbox-from">${esc(note.from)}</span>
          ${wsLabel ? `<span class="inbox-ws">${esc(wsLabel)}</span>` : ''}
          <span class="inbox-ago">${esc(fmtAgo(note.createdAt))}</span>
        </div>
        <div class="inbox-body">${esc(note.body)}</div>
      `;
      // Click a row to mark it read (idempotent main-side). Repaint + rebadge so
      // the unread styling and the footer count both settle.
      el.addEventListener('click', async () => {
        if (note.readAt == null) {
          try { await window.api.markNotificationRead(note.id); } catch { /* leave unread */ }
          await renderList();
          await refreshBadge();
        }
      });
      listEl.appendChild(el);
    }
  }

  function openDrawer() {
    drawer.classList.remove('hidden');
    renderList();
    refreshBadge();
  }
  function closeDrawer() {
    drawer.classList.add('hidden');
  }
  const isOpen = () => !drawer.classList.contains('hidden');

  openBtn.addEventListener('click', openDrawer);
  closeBtn.addEventListener('click', closeDrawer);
  markAllBtn.addEventListener('click', async () => {
    try { await window.api.markAllNotificationsRead(); } catch { /* no-op */ }
    await renderList();
    await refreshBadge();
  });

  // The single `notify` ipc broadcast (audit line + live signal) drives both the
  // badge and, when the drawer is open, a full refetch-repaint so a note arriving
  // live inserts its row rather than only bumping the count.
  window.api.onIpcMessage((msg) => {
    if (!msg || msg.type !== 'notify') return;
    refreshBadge();
    if (isOpen()) renderList();
  });

  window.api.onRequestOpenInboxDrawer(() => openDrawer());

  refreshBadge();
  return { openDrawer, closeDrawer };
}

module.exports = { createInboxDrawer };
