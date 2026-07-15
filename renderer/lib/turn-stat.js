'use strict';
// turn-stat.js — the "which turn number do we show" decision, shared by the
// statusbar and the sidebar hovercard so the two can never disagree.
//
// Two turn counts ride the proxy payload:
//   p.turns         — turns_completed, cumulative since the wire session began
//                     (spans compacts; "turn 143" after a day's work)
//   p.context.turns — turns_in_context, wire-truth count of turns in the LIVE
//                     context (main-line only, resets at compact)
// The live number is what an operator needs at a glance ("where is this
// context NOW"); the cumulative one still matters but rides the tooltip.
// Leaf: no DOM. NEW module — deliberately NOT in the leak-scanner's
// RENDERER_SCANNED_MODULES (that guard is for move-only extractions).

// { now, total } with nulls for missing halves; null when neither exists.
function turnStat(p) {
  const total = p && typeof p.turns === 'number' ? p.turns : null;
  const now = p && p.context && typeof p.context.turns === 'number' ? p.context.turns : null;
  if (now == null && total == null) return null;
  return { now, total };
}

// Statusbar segment: { text, tip }. Prefers the live count; degrades to the
// cumulative one (pre-feature proxy / context stats not fired yet) with a tip
// that says so.
function turnSeg(p) {
  const t = turnStat(p);
  if (!t) return null;
  if (t.now != null) {
    const tip = t.total != null
      ? `Turns in the live context (resets at compact) — ${t.total} completed since session start`
      : 'Turns in the live context (resets at compact)';
    return { text: `turn ${t.now}`, tip };
  }
  return { text: `turn ${t.total}`, tip: 'Turns completed since session start (live-context count unavailable)' };
}

// Hovercard line: both numbers inline — a hovercard IS the tooltip surface,
// so nothing can hide behind a title attribute there.
function turnLine(p) {
  const t = turnStat(p);
  if (!t) return null;
  if (t.now != null) {
    return t.total != null ? `turn ${t.now} (${t.total} total)` : `turn ${t.now}`;
  }
  return `turn ${t.total} total`;
}

module.exports = { turnStat, turnSeg, turnLine };
