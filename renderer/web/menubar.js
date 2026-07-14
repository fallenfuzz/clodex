'use strict';
// menubar.js — the browser frontend's in-page replacement for the native app menu
// (web-frontend Phase 3b, v1 degradation surfaced honestly). The Electron app
// reaches its drawers/dialogs through the OS menu bar, which fires request-* IPC
// events; the browser has no native menu, so those drawers would otherwise be
// unreachable. This mounts a single floating "☰" button that opens a dropdown of
// exactly those actions, each firing the SAME request-* event locally into the
// renderer's own subscribers via the shim's emit(). The session-scoped drawers
// (agents/skills/exec) fire with a null name — the identical path the app menu's
// generic (non-session) entries use, which the renderer already handles.
//
// It is deliberately a corner button, not a top bar: inserting a full-height-
// shifting bar would break xterm's fit measurements. New Session already has the
// sidebar "+"; the rest live here.

// [label, channel, ...args] — a separator is the literal '-'.
const ITEMS = [
  ['New session', 'request-open-new-dialog'],
  '-',
  ['Agents…', 'request-open-agents-drawer', null],
  ['Skills…', 'request-open-skills-drawer', null],
  ['Exec commands…', 'request-open-exec-drawer', null],
  ['Prompts…', 'request-open-prompts-drawer'],
  ['Templates…', 'request-open-templates-drawer'],
  '-',
  ['Inbox…', 'request-open-inbox-drawer'],
  ['Peers…', 'request-open-peers-dialog'],
  ['Preferences…', 'request-open-preferences'],
  ['IPC log…', 'request-open-ipc-log'],
  '-',
  ['Rename workspace…', 'request-rename-workspace'],
];

const STYLE = `
.clx-menubtn{position:fixed;top:8px;right:10px;z-index:99999;width:30px;height:26px;
  border:1px solid #4a4a4a;border-radius:6px;background:#2b2b2b;color:#ddd;cursor:pointer;
  font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;opacity:.85}
.clx-menbar-menu{position:fixed;top:38px;right:10px;z-index:99999;background:#2b2b2b;border:1px solid #444;
  border-radius:6px;padding:4px 0;min-width:190px;box-shadow:0 6px 24px rgba(0,0,0,.5);
  font:400 13px/1 -apple-system,system-ui,sans-serif;color:#eee}
.clx-menbar-item{padding:7px 16px;white-space:nowrap;cursor:pointer}
.clx-menbar-item:hover{background:#3a6ea5;color:#fff}
.clx-menbar-sep{height:1px;margin:4px 0;background:#444}
`;

function mount(emit) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.className = 'clx-menubtn';
  btn.title = 'Menu';
  btn.textContent = '☰';
  document.body.appendChild(btn);

  let menu = null;
  const close = () => {
    if (!menu) return;
    menu.remove(); menu = null;
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDoc = (e) => { if (menu && !menu.contains(e.target) && e.target !== btn) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const open = () => {
    menu = document.createElement('div');
    menu.className = 'clx-menbar-menu';
    for (const it of ITEMS) {
      if (it === '-') { const s = document.createElement('div'); s.className = 'clx-menbar-sep'; menu.appendChild(s); continue; }
      const [label, channel, ...args] = it;
      const row = document.createElement('div');
      row.className = 'clx-menbar-item';
      row.textContent = label;
      row.addEventListener('mouseup', () => { close(); try { emit(channel, ...args); } catch (err) { console.error('menubar emit', channel, err); } });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  };

  btn.addEventListener('click', () => { if (menu) close(); else open(); });
}

module.exports = { mount, ITEMS };
