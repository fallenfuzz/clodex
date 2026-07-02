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

// Accumulates usage from Anthropic `message_start` / `message_delta` events.
// input_tokens + cache splits arrive on message_start; final output_tokens
// on the last message_delta.
class UsageCollector {
  constructor() {
    this.messageId = null;
    this.usage = {};
    this._has = false;
  }

  onEvent(event, data) {
    if (!data || (event !== 'message_start' && event !== 'message_delta')) return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    if (event === 'message_start' && obj.type === 'message_start') {
      const msg = obj.message || {};
      this.messageId = msg.id || null;
      const u = msg.usage || {};
      Object.assign(this.usage, u);
      if (Object.keys(u).length) this._has = true;
    } else if (event === 'message_delta' && obj.type === 'message_delta') {
      const u = obj.usage || {};
      Object.assign(this.usage, u);
      if (Object.keys(u).length) this._has = true;
    }
  }

  get record() {
    if (!this._has) return null;
    return { message_id: this.messageId || '', ...this.usage };
  }
}

module.exports = { SSEFramer, anthropicTextDelta, openaiTextDelta, UsageCollector };
