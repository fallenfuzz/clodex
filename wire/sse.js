'use strict';

// SSE event framing + per-provider text-delta extraction + usage capture.
// Seeded from clodex2 lib/sse.js (port of agent-workbench proxy.py's
// _parse_sse_event, _anthropic_text_delta, _openai_text_delta,
// _UsageCollector).

// Events are separated by a blank line: \n\n or \r\n\r\n. Boundaries are
// ASCII, so slicing at them never splits a multibyte character.
class SSEFramer {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this._buf = Buffer.alloc(0);
  }

  feed(chunk) {
    if (!chunk || !chunk.length) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const iLf = this._buf.indexOf('\n\n');
      const iCrlf = this._buf.indexOf('\r\n\r\n');
      let boundary, blen;
      if (iCrlf !== -1 && (iLf === -1 || iCrlf < iLf)) { boundary = iCrlf; blen = 4; }
      else if (iLf !== -1) { boundary = iLf; blen = 2; }
      else break;
      const raw = this._buf.slice(0, boundary).toString('utf8');
      this._buf = this._buf.slice(boundary + blen);
      this._emit(raw);
    }
  }

  _emit(raw) {
    let event = null;
    const data = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    this.onEvent(event, data.length ? data.join('\n') : null);
  }
}

function anthropicTextDelta(event, data) {
  if (!data) return null;
  let obj;
  try { obj = JSON.parse(data); } catch { return null; }
  if (obj.type !== 'content_block_delta') return null;
  const d = obj.delta || {};
  // thinking_delta / input_json_delta intentionally ignored — turn text is
  // visible assistant text only.
  return d.type === 'text_delta' ? (d.text || '') : null;
}

function openaiTextDelta(event, data) {
  if (!data || data.trim() === '[DONE]') return null;
  let obj;
  try { obj = JSON.parse(data); } catch { return null; }
  // Responses API
  if (obj.type === 'response.output_text.delta') return obj.delta || '';
  // Chat Completions
  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length) {
    const delta = choices[0].delta || {};
    if (typeof delta.content === 'string') return delta.content;
  }
  return null;
}

// Accumulates usage + response meta from an Anthropic stream. The merged
// `record` (message_delta usage assigned over message_start's) is the
// back-compat telemetry view; billing consumes `meta` instead, which keeps
// usage_start and usage_final SEPARATE because the Python contract's
// fallbacks are asymmetric (output_tokens from final ONLY, service_tier
// from start ONLY — proxylab/billing.py _billing / _parse_response_meta).
// usage_final is the LAST message_delta's usage object verbatim, replaced
// not merged, per the cumulative-usage_final billing contract.
const _INTERESTING = new Set([
  'message_start', 'message_delta', 'content_block_start', 'error', 'rate_limit_error',
]);

class UsageCollector {
  constructor() {
    this.messageId = null;
    this.usage = {};
    this._has = false;
    this.resolvedModel = null;
    this.role = null;
    this.usageStart = null;
    this.usageFinal = null;
    this.stopReason = null;
    this.stopSequence = null;
    this.stopDetails = null;
    this.contentBlockTypes = [];
    this.toolUses = [];
    this.error = null;
  }

  onEvent(event, data) {
    if (!data) return;
    // Gate by SSE event name when present (skips the hot content_block_delta
    // path); an unnamed event falls through to the type check, matching the
    // Python parser which never reads event names.
    if (event != null && !_INTERESTING.has(event)) return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    const t = obj.type;
    if (t === 'message_start') {
      const msg = obj.message || {};
      this.messageId = msg.id || null;
      this.resolvedModel = msg.model !== undefined ? msg.model : null;
      this.role = msg.role !== undefined ? msg.role : null;
      this.usageStart = msg.usage !== undefined ? msg.usage : null;
      const u = msg.usage || {};
      Object.assign(this.usage, u);
      if (Object.keys(u).length) this._has = true;
    } else if (t === 'content_block_start') {
      const cb = obj.content_block || {};
      this.contentBlockTypes.push(cb.type !== undefined ? cb.type : null);
      if (cb.type === 'tool_use') this.toolUses.push(cb.name);
    } else if (t === 'message_delta') {
      if (obj.usage != null) this.usageFinal = obj.usage; // last delta wins, verbatim
      const d = obj.delta || {};
      this.stopReason = d.stop_reason || this.stopReason;
      if (d.stop_sequence != null) this.stopSequence = d.stop_sequence;
      this.stopDetails = d.stop_details || this.stopDetails;
      const u = obj.usage || {};
      Object.assign(this.usage, u);
      if (Object.keys(u).length) this._has = true;
    } else if (t === 'error' || t === 'rate_limit_error') {
      this.error = obj.error || obj;
    }
  }

  get record() {
    if (!this._has) return null;
    return { message_id: this.messageId || '', ...this.usage };
  }

  // Mirrors proxylab billing._parse_response_meta's dict (minus `text`,
  // which the tee accumulates uncapped).
  get meta() {
    return {
      message_id: this.messageId,
      resolved_model: this.resolvedModel,
      role: this.role,
      stop_reason: this.stopReason,
      stop_sequence: this.stopSequence,
      stop_details: this.stopDetails,
      usage_start: this.usageStart,
      usage_final: this.usageFinal,
      content_block_types: this.contentBlockTypes,
      tool_uses: this.toolUses,
      error: this.error,
    };
  }
}

// Codex/openai Responses-API stream: response.completed (or incomplete /
// failed) carries the FULL response object incl. usage. Port of
// proxylab codex._parse_openai_response minus the unframed-JSON error
// branch — a 4xx body isn't SSE, so no tee runs on it.
class OpenAIUsageCollector {
  constructor() {
    this.usage = null;
    this.resolvedModel = null;
    this.responseId = null;
    this.status = null;
    this.error = null;
  }

  onEvent(event, data) {
    if (!data || data.trim() === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    const t = obj.type;
    if (t === 'response.completed' || t === 'response.incomplete' || t === 'response.failed') {
      const r = obj.response || {};
      this.usage = r.usage !== undefined ? r.usage : null;
      this.resolvedModel = r.model !== undefined ? r.model : null;
      this.responseId = r.id !== undefined ? r.id : null;
      this.status = r.status !== undefined ? r.status : null;
      if (t === 'response.failed' && r.error) this.error = r.error;
    } else if (t === 'error') {
      this.error = obj;
    }
  }

  get meta() {
    return {
      usage: this.usage,
      resolved_model: this.resolvedModel,
      response_id: this.responseId,
      status: this.status,
      error: this.error,
    };
  }
}

module.exports = { SSEFramer, anthropicTextDelta, openaiTextDelta, UsageCollector, OpenAIUsageCollector };
