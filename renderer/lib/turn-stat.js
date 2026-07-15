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

// Request count, same live-first policy. p.sinceCompact is the wirescope
// since-compact rollup (poller-shaped; null on older proxies — degrades to the
// cumulative count with a tip that says it spans compacts). `compacted:false`
// means the session has never compacted, so since-boundary === since-start —
// the tip stays honest either way.
function reqSeg(p) {
  const total = p && p.cost && typeof p.cost.requests === 'number' ? p.cost.requests : null;
  const sc = p && p.sinceCompact;
  const now = sc && typeof sc.requests === 'number' ? sc.requests : null;
  if (now != null) {
    const since = sc.compacted ? 'since the last compact' : 'since session start (never compacted)';
    const tail = total != null && sc.compacted ? ` — ${total} total since session start` : '';
    return { text: `req ${now}`, tip: `API roundtrips ${since} (tool-loop calls, not just your prompts)${tail}` };
  }
  if (total == null) return null;
  return { text: `req ${total}`, tip: 'API roundtrips since session start, spans compacts (tool-loop calls, not just your prompts)' };
}

// Hovercard req line, mirroring turnLine: both numbers inline.
function reqLine(p) {
  const total = p && p.cost && typeof p.cost.requests === 'number' ? p.cost.requests : null;
  const sc = p && p.sinceCompact;
  const now = sc && typeof sc.requests === 'number' ? sc.requests : null;
  if (now != null && sc.compacted) {
    return total != null ? `req ${now} (${total} total)` : `req ${now}`;
  }
  if (total == null) return now != null ? `req ${now}` : null;
  return `req ${total}`;
}

module.exports = { turnStat, turnSeg, turnLine, reqSeg, reqLine };
