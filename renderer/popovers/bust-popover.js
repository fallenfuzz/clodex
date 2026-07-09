// popovers/bust-popover.js — the cache-bust inspector (wirescope /_bust),
// opened from the bar's 💥 chip. Turn-by-turn cache-divergence forensics:
// when the prefix broke, how big the rewrite was, what changed. Self-contained
// island: DOM handles + dismiss wiring live here; data comes through
// popoverApi(name).bust(); proxyState is the live poll-payload Map (base/
// sessionId). openExternal/openWirescope are window.api shell actions.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the guarantee.

const { esc } = require('../lib/format');
const { bustRow } = require('../lib/render-html');

function initBustPopover({ popoverApi, proxyState }) {
  // ── Cache-bust inspector (wirescope /_bust) ───────────────────────────
  // Turn-by-turn cache-divergence forensics: WHEN the prefix broke, HOW big the
  // re-write was, and WHAT changed (the locus). Opened from the 💥 bar chip.
  // wirescope classifies; we render. `fault`/`fix_hint` per transition arrive in
  // v0.6.20+ — rendered when present, gracefully absent on v0.6.19 (locus.label
  // alone still answers "what changed on this turn").
  const bustPopover = document.getElementById('bust-popover');
  const bustPopoverName = document.getElementById('bust-popover-name');
  const bustPopoverBody = document.getElementById('bust-popover-body');

  function closeBustPopover() { bustPopover.classList.add('hidden'); bustPopover.dataset.name = ''; }

  function renderBustSeries(d, base, sid) {
    const busts = Array.isArray(d && d.busts) ? d.busts : [];
    const nT = d && d.count != null ? d.count : null;
    const link = (base && sid)
      ? `<span class="px-link-ext" data-url="${esc(`${base}/_session?session=${encodeURIComponent(sid)}`)}" title="Open the session in the wirescope navigator (⌘-click for browser)">Open navigator →</span>`
      : '';
    // Genuine busts (content / environment) are the investigation; the fault:self
    // microbusts are the designed per-turn strip cost — collapsed to one muted
    // line, not listed row-by-row (they're identical and expected). Matches the
    // chip, which counts genuine only.
    const genuine = busts.filter((t) => t.fault !== 'self');
    const designed = busts.filter((t) => t.fault === 'self');
    if (!genuine.length) {
      const only = designed.length
        ? `<div class="cost-note">No genuine cache busts — the ${designed.length} recorded event${designed.length === 1 ? ' is' : 's are'} the designed per-turn strip cost (thinking falling behind the boundary), not a cache problem.</div>`
        : `<div class="cost-note">No cache busts recorded${nT != null ? ` across ${nT} turn transition${nT === 1 ? '' : 's'}` : ''} — the prefix stayed warm.</div>`;
      return only + link;
    }
    const nStatic = d.n_static_prefix_busts != null ? d.n_static_prefix_busts : null;
    const head = `<div class="cost-head"><b>${genuine.length}</b> genuine cache-bust${genuine.length === 1 ? '' : 's'}`
      + (nT != null ? ` over <b>${nT}</b> transitions` : '')
      + (nStatic ? ` · <b>${nStatic}</b> touched the static prefix` : '')
      + `</div>`;
    // Newest first — the operator usually cares about what just broke.
    const rows = genuine.slice().reverse().map((t) => bustRow(t, base, sid)).join('');
    const designedNote = designed.length
      ? `<div class="cost-note">+ ${designed.length} designed strip-cost microbust${designed.length === 1 ? '' : 's'} (fault:self) — expected every turn, not shown.</div>`
      : '';
    const note = '<div class="cost-note">Amber = a real injected-prefix change worth fixing (model swap, date rollover, CLAUDE.md edit). Dim = expected (idle cold cache, or a one-time deploy tax that self-heals).</div>';
    return head + `<div class="bust-list">${rows}</div>` + designedNote + note + link;
  }

  async function openBustPopover(name, anchor) {
    const p = (proxyState.get(name) || {}).payload;
    const base = p && p.base, sid = p && p.sessionId;
    bustPopoverName.textContent = name;
    bustPopover.dataset.name = name;
    bustPopoverBody.innerHTML = '<div class="cost-note">Loading cache-bust forensics…</div>';
    bustPopover.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const w = bustPopover.offsetWidth;
    bustPopover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    bustPopover.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
    const res = await popoverApi(name).bust();
    if (bustPopover.dataset.name !== name || bustPopover.classList.contains('hidden')) return;
    if (!res || !res.ok) {
      bustPopoverBody.innerHTML = `<div class="cost-note">${esc(res && res.error ? res.error : 'Cache-bust forensics unavailable')}</div>`;
      return;
    }
    try { bustPopoverBody.innerHTML = renderBustSeries(res.data, base, sid); }
    catch (e) { bustPopoverBody.innerHTML = `<div class="cost-note">Could not render: ${esc(String((e && e.message) || e))}</div>`; }
  }

  bustPopoverBody.addEventListener('click', (e) => {
    const ext = e.target.closest('[data-url]');
    if (!ext || !ext.dataset.url) return;
    if (e.metaKey || e.ctrlKey) {
      window.api.openExternal(ext.dataset.url);
    } else {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg');
      window.api.openWirescope(ext.dataset.url, bg);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (bustPopover.classList.contains('hidden')) return;
    if (bustPopover.contains(e.target)) return;
    if (e.target.closest('[data-act="bust"]')) return; // toggle handled by the bar
    closeBustPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !bustPopover.classList.contains('hidden')) closeBustPopover();
  });
  document.getElementById('bust-popover-close').addEventListener('click', closeBustPopover);

  return { openBustPopover };
}

module.exports = { initBustPopover };
