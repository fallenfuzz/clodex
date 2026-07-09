// popovers/checklist-popovers.js — the three local config-editor popovers off
// the proxy bar's ⚙ actions: Tools, Skills, and Agents/Builtins. Each renders a
// checklist of the session's current config, and Apply persists it (optionally
// with a hard restart + terminal re-attach). Self-contained island: DOM handles,
// dismiss wiring, and bulk-toggle wiring live here; the openers are returned.
//
// NOTE these are LOCAL editors — no popoverApi and no peer variant (the bar
// suppresses them for peer tabs). They read/write settings and restart via
// window.api directly (getSettings/getSessionArgs/setSession{Tools,Skills,Agents}/
// restartSession); that is outside the popoverApi read-only data seam by design.
// The restart re-attach dance needs core sessionList/createTerminal/
// addSessionToSidebar/switchSession, injected by reference.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the guarantee.

const {
  renderToolChecklist, collectToolChecklist, renderSkillChecklist, collectSkillChecklist,
  renderInjectChecklist, collectInjectChecklist, renderAgentChecklist, collectAgentChecklist,
  renderBuiltinChecklist, collectBuiltinChecklist, wireBulkToggles,
  setClaudeToolsCache, setSkillLibCache, setAgentLibCache, getSkillLibCache,
} = require('../lib/checklists');

function initChecklistPopovers({ sessionList, createTerminal, addSessionToSidebar, switchSession }) {
  // --- Tools quick-access popover ------------------------------------------
  // Opened from the status-bar "tools" icon. Reads the session's current
  // disabled set + the known-tool catalog, lets the user toggle, and persists
  // via session:setTools (optionally restarting to apply immediately). The disabled
  // set drives permissions.deny at spawn — see CLAUDE_TOOLS in main.js.
  const toolsPopover = document.getElementById('tools-popover');
  const toolsPopoverName = document.getElementById('tools-popover-name');
  const popoverToolsList = document.getElementById('popover-tools-list');
  const toolsPopoverRestart = document.getElementById('tools-popover-restart');

  function closeToolsPopover() {
    toolsPopover.classList.add('hidden');
    toolsPopover.dataset.name = '';
  }

  async function openToolsPopover(name, anchorBtn) {
    const [settings, res] = await Promise.all([
      window.api.getSettings(),
      window.api.getSessionArgs(name),
    ]);
    if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
    setClaudeToolsCache(settings?.claudeTools || []);
    renderToolChecklist(popoverToolsList, new Set(res.disabledTools || []), res.effectiveTools || {});
    toolsPopoverRestart.checked = false;
    toolsPopoverName.textContent = name;
    toolsPopover.dataset.name = name;
    toolsPopover.classList.remove('hidden');
    // Anchor above the button, clamped to the viewport.
    const r = anchorBtn.getBoundingClientRect();
    const w = toolsPopover.offsetWidth;
    toolsPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    toolsPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }

  document.getElementById('tools-popover-cancel').addEventListener('click', closeToolsPopover);
  document.getElementById('tools-popover-apply').addEventListener('click', async () => {
    const name = toolsPopover.dataset.name;
    if (!name) return closeToolsPopover();
    const disabledTools = collectToolChecklist(popoverToolsList);
    const restart = toolsPopoverRestart.checked;
    closeToolsPopover();
    const r = await window.api.setSessionTools(name, disabledTools);
    if (!r || !r.ok) { alert(`Failed to update tools: ${r && r.error ? r.error : 'unknown error'}`); return; }
    if (!restart) return;
    // Same re-attach dance as the context-menu restart path.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.querySelector('.session-type')?.textContent : null;
    const snapCwd = item ? item.dataset.cwd : null;
    const rr = await window.api.restartSession(name);
    if (!rr || !rr.ok) { alert(`Restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
    if (snapType) {
      createTerminal(name);
      addSessionToSidebar(name, snapType, snapCwd, null);
      switchSession(name);
    }
  });
  // Dismiss on outside click / Escape.
  document.addEventListener('mousedown', (e) => {
    if (toolsPopover.classList.contains('hidden')) return;
    if (toolsPopover.contains(e.target)) return;
    if (e.target.closest('.px-action')) return; // the toggle button handles itself
    closeToolsPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !toolsPopover.classList.contains('hidden')) closeToolsPopover();
  });

  // --- Per-session Skills popover ------------------------------------------
  // Mirrors the tools popover, but writes skillOverrides:{name:"off"} (which
  // reclaims the per-turn roster tokens) instead of permissions.deny. The
  // catalog is the live transcript roster unioned with the disabled set
  // (session:skillCatalog), so a turned-off skill stays re-enable-able.
  const skillsPopover = document.getElementById('skills-popover');
  const skillsPopoverName = document.getElementById('skills-popover-name');
  const popoverSkillsList = document.getElementById('popover-skills-list');
  const popoverInjectSkillsSection = document.getElementById('popover-inject-skills-section');
  const popoverInjectSkillsList = document.getElementById('popover-inject-skills-list');
  const skillsPopoverRestart = document.getElementById('skills-popover-restart');

  function closeSkillsPopover() {
    skillsPopover.classList.add('hidden');
    skillsPopover.dataset.name = '';
  }

  async function openSkillsPopover(name, anchorBtn) {
    const res = await window.api.getSkillCatalog(name);
    if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
    renderSkillChecklist(popoverSkillsList, res.names || [], new Set(res.disabledSkills || []),
      res.effective || {}, { skillsLocked: res.skillsLocked, canReenable: res.canReenable });
    // Library-injection section: only shown when the library is non-empty.
    setSkillLibCache(res.skillLib || []);
    if (getSkillLibCache().length) {
      renderInjectChecklist(popoverInjectSkillsList, new Set(res.injectSkills || []));
      popoverInjectSkillsSection.style.display = '';
    } else {
      popoverInjectSkillsSection.style.display = 'none';
    }
    skillsPopoverRestart.checked = false;
    skillsPopoverName.textContent = name;
    skillsPopover.dataset.name = name;
    skillsPopover.classList.remove('hidden');
    const r = anchorBtn.getBoundingClientRect();
    const w = skillsPopover.offsetWidth;
    skillsPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    skillsPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }

  document.getElementById('skills-popover-cancel').addEventListener('click', closeSkillsPopover);
  document.getElementById('skills-popover-apply').addEventListener('click', async () => {
    const name = skillsPopover.dataset.name;
    if (!name) return closeSkillsPopover();
    const disabledSkills = collectSkillChecklist(popoverSkillsList);
    // Only send injectSkills when the library section is shown; otherwise pass
    // undefined so the handler preserves the persisted set (empty library != none).
    const injectSkills = popoverInjectSkillsSection.style.display === 'none'
      ? undefined : collectInjectChecklist(popoverInjectSkillsList);
    const restart = skillsPopoverRestart.checked;
    // Skill changes (trim or inject) only land in a NEW conversation (the roster
    // is fixed at creation; --resume replays the old one), so confirm the
    // history-clearing fresh restart before doing it.
    if (restart && !confirm(`Apply skill changes to "${name}" now?\n\nThis starts a NEW conversation — the current session's history will be cleared. (Leave "Restart fresh" unchecked to apply on the next fresh start instead.)`)) return;
    closeSkillsPopover();
    const r = await window.api.setSessionSkills(name, disabledSkills, injectSkills);
    if (!r || !r.ok) { alert(`Failed to update skills: ${r && r.error ? r.error : 'unknown error'}`); return; }
    if (!restart) return;
    // Fresh (non-resume) restart — the only way a skill change takes effect.
    // Same re-attach dance as the tools popover restart path.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.querySelector('.session-type')?.textContent : null;
    const snapCwd = item ? item.dataset.cwd : null;
    const rr = await window.api.restartSession(name, { fresh: true });
    if (!rr || !rr.ok) { alert(`Restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
    if (snapType) {
      createTerminal(name);
      addSessionToSidebar(name, snapType, snapCwd, null);
      switchSession(name);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (skillsPopover.classList.contains('hidden')) return;
    if (skillsPopover.contains(e.target)) return;
    if (e.target.closest('.px-action')) return;
    if (e.target.closest('[data-act="manage-skills"]')) return; // ctx cross-link opens it
    closeSkillsPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !skillsPopover.classList.contains('hidden')) closeSkillsPopover();
  });

  // --- Per-session Agents popover ------------------------------------------
  // A shortcut for composing the custom-subagent library into a running session
  // (--agents) + toggling the built-in agents, instead of right-click → Edit
  // settings → check/uncheck. Denying a built-in (Agent(Explore) etc.) filters it
  // out of the injected roster — reclaiming its per-turn description tokens — and
  // stops delegation to it, so this IS a (capability-costing) trim lever. Like
  // skills, the roster is frozen at conversation creation, so applying needs a
  // FRESH (non-resume) restart.
  const agentsPopover = document.getElementById('agents-popover');
  const agentsPopoverName = document.getElementById('agents-popover-name');
  const popoverAgentsList = document.getElementById('popover-agents-list');
  const popoverBuiltinsList = document.getElementById('popover-builtins-list');
  const agentsPopoverRestart = document.getElementById('agents-popover-restart');

  function closeAgentsPopover() {
    agentsPopover.classList.add('hidden');
    agentsPopover.dataset.name = '';
  }

  async function openAgentsPopover(name, anchorBtn) {
    const res = await window.api.getAgentCatalog(name);
    if (!res || !res.ok) { alert('Session not found in persistence.'); return; }
    setAgentLibCache(res.agents || []);
    renderAgentChecklist(popoverAgentsList, new Set(res.enabled || []));
    renderBuiltinChecklist(popoverBuiltinsList, new Set(res.denyBuiltins || []));
    agentsPopoverRestart.checked = false;
    agentsPopoverName.textContent = name;
    agentsPopover.dataset.name = name;
    agentsPopover.classList.remove('hidden');
    const r = anchorBtn.getBoundingClientRect();
    const w = agentsPopover.offsetWidth;
    agentsPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    agentsPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }

  document.getElementById('agents-popover-cancel').addEventListener('click', closeAgentsPopover);
  document.getElementById('agents-popover-close').addEventListener('click', closeAgentsPopover);
  document.getElementById('agents-popover-apply').addEventListener('click', async () => {
    const name = agentsPopover.dataset.name;
    if (!name) return closeAgentsPopover();
    const agents = collectAgentChecklist(popoverAgentsList);
    const denyBuiltins = collectBuiltinChecklist(popoverBuiltinsList);
    const restart = agentsPopoverRestart.checked;
    // The agent roster is fixed at conversation creation (--resume replays the
    // old one), so a restart that applies it must be the fresh, history-clearing
    // kind — confirm before doing it.
    if (restart && !confirm(`Apply agent changes to "${name}" now?\n\nThis starts a NEW conversation — the current session's history will be cleared. (Leave "Restart fresh" unchecked to apply on the next fresh start instead.)`)) return;
    closeAgentsPopover();
    const r = await window.api.setSessionAgents(name, agents, denyBuiltins);
    if (!r || !r.ok) { alert(`Failed to update agents: ${r && r.error ? r.error : 'unknown error'}`); return; }
    if (!restart) return;
    // Fresh (non-resume) restart — same re-attach dance as the skills popover.
    const item = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    const snapType = item ? item.querySelector('.session-type')?.textContent : null;
    const snapCwd = item ? item.dataset.cwd : null;
    const rr = await window.api.restartSession(name, { fresh: true });
    if (!rr || !rr.ok) { alert(`Restart failed: ${rr && rr.error ? rr.error : 'unknown error'}`); return; }
    if (snapType) {
      createTerminal(name);
      addSessionToSidebar(name, snapType, snapCwd, null);
      switchSession(name);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (agentsPopover.classList.contains('hidden')) return;
    if (agentsPopover.contains(e.target)) return;
    if (e.target.closest('.px-action')) return;
    closeAgentsPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !agentsPopover.classList.contains('hidden')) closeAgentsPopover();
  });

  // Bulk "Check all / Uncheck all" controls for the three checklist popovers.
  wireBulkToggles(toolsPopover, popoverToolsList);
  wireBulkToggles(skillsPopover, popoverSkillsList);
  wireBulkToggles(agentsPopover, popoverAgentsList);

  // Always-reachable ✕ close buttons (tools/skills; agents' is wired in-section
  // above). A tall popover can push outside-click/Escape out of reach.
  document.getElementById('tools-popover-close').addEventListener('click', closeToolsPopover);
  document.getElementById('skills-popover-close').addEventListener('click', closeSkillsPopover);

  return { openToolsPopover, openSkillsPopover, openAgentsPopover };
}

module.exports = { initChecklistPopovers };
