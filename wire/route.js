'use strict';

// Route extraction for the per-agent proxy paths. Seeded from clodex2
// lib/route.js (itself a port of agent-workbench/components/proxy/proxy.py).
//
// Agent name charset matches clodex session names ([a-zA-Z0-9._-], first
// char alphanumeric, max 64) so names embed cleanly in URL paths and intent
// fields without escaping.

const AGENT_RE = /^\/agent\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})(\/.*)?$/;
const PROVIDERS = new Set(['anthropic', 'openai']);

// `/agent/<name>[/...]` → { agent, rest } or null. Agent name is mandatory
// so every observed turn carries an identity.
function parseAgentPath(pathname) {
  const m = AGENT_RE.exec(pathname);
  if (!m) return null;
  return { agent: m[1], rest: m[2] || '/' };
}

// Provider selection priority: explicit segment > path suffix > anthropic.
//   /anthropic/v1/...          → anthropic, /v1/...
//   /openai/v1/...             → openai, /v1/...
//   /v1/chat/completions       → openai (suffix inference)
//   /v1/responses              → openai (suffix inference)
//   anything else              → anthropic (default)
function inferProvider(rest) {
  const tail = rest.startsWith('/') ? rest.slice(1) : rest;
  const slash = tail.indexOf('/');
  const head = slash === -1 ? tail : tail.slice(0, slash);
  if (PROVIDERS.has(head)) {
    const after = slash === -1 ? '' : tail.slice(slash + 1);
    return { provider: head, upstreamPath: after ? '/' + after : '/' };
  }
  if (
    rest === '/v1/chat/completions' || rest === '/v1/responses' ||
    rest.startsWith('/v1/chat/completions/') || rest.startsWith('/v1/responses/')
  ) {
    return { provider: 'openai', upstreamPath: rest };
  }
  return { provider: 'anthropic', upstreamPath: rest };
}

module.exports = { parseAgentPath, inferProvider, PROVIDERS };
