// session-args.js — the pure field-resolution core of Edit Session, split out of
// main.js's applySessionArgs so it can be unit-tested without loading the
// electron-heavy main process. `resolveSessionArgsPatch(patch, prev)` applies the
// "undefined means untouched" rule: a field left undefined in the patch keeps the
// session's persisted value; any explicit value (including [] or null) overwrites.
// prev is the persisted entry (or null/undefined for a not-yet-persisted name).
//
// applySessionArgs owns the side effects (persist calls, kill+respawn, stripLevel
// re-assert, catch-and-upsert); this owns only the value decisions, which is the
// part worth pinning against drift. Both the local session:setArgs path and the
// peer session-args POST endpoint route through applySessionArgs, so they share
// this resolver transitively.

'use strict';

function resolveSessionArgsPatch(patch = {}, prev = null) {
  const {
    agents, denyBuiltins, disabledTools, disabledSkills, injectSkills,
    systemPrompt, systemPromptFile, appendPromptFiles, intents, execCommands,
  } = patch;
  return {
    agents: agents !== undefined ? (agents || []) : (prev?.agents || []),
    denyBuiltins: denyBuiltins !== undefined ? (denyBuiltins || []) : (prev?.denyBuiltins || []),
    disabledTools: disabledTools !== undefined ? (disabledTools || []) : (prev?.disabledTools || []),
    disabledSkills: disabledSkills !== undefined ? (disabledSkills || []) : (prev?.disabledSkills || []),
    injectSkills: injectSkills !== undefined ? (injectSkills || []) : (prev?.injectSkills || []),
    // Exec-command GRANT allowlist — array-shaped like agents/disabledTools above
    // (undefined = untouched keeps the persisted grants; an explicit value, incl []
    // = revoke all, overwrites). The Edit dialog OWNS it as a Claude-only section
    // and sends the checked grants; a peer patch NEVER carries it (exec is local-
    // only — stripped at the wire in both directions, see withoutExecGrants), so
    // over-the-wire this always resolves to undefined = the box's grants preserved.
    execCommands: execCommands !== undefined
      ? (Array.isArray(execCommands) ? execCommands.map(String) : [])
      : (Array.isArray(prev?.execCommands) ? prev.execCommands : []),
    // undefined = "untouched": keep the persisted value. The edit dialog no longer
    // surfaces the legacy inline body, so it passes systemPrompt undefined and a
    // legacy inline prompt survives editing other settings.
    systemPrompt: systemPrompt !== undefined ? (systemPrompt || null) : (prev?.systemPrompt || null),
    systemPromptFile: systemPromptFile !== undefined ? (systemPromptFile || null) : (prev?.systemPromptFile || null),
    appendPromptFiles: appendPromptFiles !== undefined ? (appendPromptFiles || []) : (prev?.appendPromptFiles || []),
    // Intents gate allowlist. Unlike the fields above (empty = a real clear), the
    // gate's shapes are: an array (incl [] = everything gated, a real value) or null
    // (all-enabled — the absent/default state). The Edit dialog now OWNS it and sends
    // an explicit value (null when all boxes checked, else the subset); undefined =
    // untouched keeps the persisted gate for any patch that omits intents.
    intents: intents !== undefined
      ? (Array.isArray(intents) ? intents.map(String) : null)
      : (Array.isArray(prev?.intents) ? prev.intents : null),
  };
}

// Exec grants are a LOCAL-ONLY capability — they must never cross the peer wire
// in either direction (a viewer editing a box session can't read the box's grants
// nor set them; grants ride operator-authored spawn templates on the owning box).
// This returns a shallow clone with `execCommands` removed, used to sanitize BOTH
// the readSessionArgs result the box hands out AND the patch a peer POSTs back
// (belt and suspenders — the renderer already hides the section on a peer row).
// A nullish input passes through unchanged.
function withoutExecGrants(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { execCommands, ...rest } = obj;
  return rest;
}

module.exports = { resolveSessionArgsPatch, withoutExecGrants };
