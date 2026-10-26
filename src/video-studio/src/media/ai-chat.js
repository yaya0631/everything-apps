/**
 * One reply from Puter's AI to a conversation, as it arrives (the same
 * reading of puter.ai.chat's stream as the Spreadsheet app's assistant).
 * Yields { type: 'text', text }, { type: 'tool', id, name, input } (a
 * function the model calls) and last { type: 'cut' } when the reply was cut
 * off at maxTokens. A reply the SDK hands back whole, rather than streamed,
 * is yielded in the same pieces. A failure throws an Error whose message is
 * the service's own, as far as it gives one.
 */
/** The models Admin → AI turned on ({ id, label, tools }); empty where the host has no list. */
export async function aiModels(sdk = globalThis.puter) {
  const ask = sdk?.ai?.models;
  if (typeof ask !== 'function') return [];
  try {
    const list = await ask.call(sdk.ai);
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string') : [];
  } catch {
    return [];
  }
}

export async function* aiChatStream(messages, { model, tools, maxTokens } = {}, sdk = globalThis.puter) {
  if (!sdk?.ai?.chat) throw new Error('AI is not available here');
  const options = { stream: true, ...(model ? { model } : {}), ...(tools?.length ? { tools } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}) };
  let res;
  try {
    res = await sdk.ai.chat(messages, options);
  } catch (e) {
    throw aiError(e);
  }
  if (res && typeof res[Symbol.asyncIterator] === 'function') {
    try {
      for await (const part of res) {
        if (!part) continue;
        if (part.type === 'error' || (part.success === false && part.error)) throw aiError(part.error || part);
        if (part.type === 'tool_use') yield { type: 'tool', id: part.id, name: part.name, input: toolInput(part.input) };
        else if (part.type === 'reasoning') yield { type: 'reasoning' };
        // A stream says nothing of why it ended; its closing token count is how a cut-off reply shows.
        else if (part.type === 'usage') {
          if (reachedLimit(part.usage, maxTokens)) yield { type: 'cut' };
        } else if (typeof part.text === 'string' && part.text) yield { type: 'text', text: part.text };
      }
    } catch (e) {
      throw aiError(e);
    }
    return;
  }
  if (res?.success === false) throw aiError(res.error || res);
  const message = res?.message || {};
  const content = typeof res === 'string' ? res : message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text || '' : '')).join('') : '';
  if (text) yield { type: 'text', text };
  for (const call of message.tool_calls || []) yield { type: 'tool', id: call.id, name: call.function?.name, input: toolInput(call.function?.arguments) };
  if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool_use') yield { type: 'tool', id: b.id, name: b.name, input: toolInput(b.input) };
  if (res?.finish_reason === 'length' || res?.stop_reason === 'max_tokens' || message.stop_reason === 'max_tokens' || reachedLimit(res?.usage, maxTokens)) yield { type: 'cut' };
}

// Whether a reply's token count says it stopped at the limit (Anthropic's models count output_tokens, others completion_tokens).
const reachedLimit = (usage, maxTokens) => !!maxTokens && Number(usage?.output_tokens ?? usage?.completion_tokens) >= maxTokens;

/** A tool call's arguments, which may come as JSON text: what cannot be read is marked so, not taken for no arguments. */
export function toolInput(input) {
  if (typeof input !== 'string') return input ?? {};
  try {
    return input.trim() ? JSON.parse(input) : {};
  } catch {
    return { __unreadable: input };
  }
}

/** An Error for whatever the SDK threw (it often throws a plain { error: { message } } object). */
export function aiError(e) {
  if (e instanceof Error) return e;
  const inner = e?.error && typeof e.error === 'object' ? e.error : e;
  const message = inner?.message || (typeof e?.error === 'string' ? e.error : '') || (typeof e === 'string' ? e : '') || 'The AI did not answer';
  return Object.assign(new Error(message), { code: inner?.code || e?.code });
}

/** Whether a request failed for being longer than the model takes. */
export function tooLongForAi(error) {
  const said = `${String(error?.message || error || '').trim()} ${String(error?.code || '')}`;
  return /context.{0,24}(length|window|limit|size)|(?<!took )too long|too many tokens|maximum.*tokens|token limit/i.test(said);
}

/** A failed request in words that say what to do. */
export function friendlyAiError(error, { firstMessage = false } = {}) {
  const text = String(error?.message || error || '').trim();
  const code = String(error?.code || '');
  if (tooLongForAi(error)) return firstMessage ? 'This message is too long for the AI. Shorten it.' : 'This chat has grown too long for the AI. Start a new chat to carry on.';
  if (/rate.?limit|too many requests|\b429\b|overloaded|try again later/i.test(`${text} ${code}`)) return 'The AI service is busy. Wait a moment, then try again.';
  if (/insufficient.?(funds|credit|balance)|out of credit|quota|usage.?limit|allowance|billing|payment required|\b402\b/i.test(`${text} ${code}`)) return 'Your Puter AI allowance has run out for now.';
  if (/sign.?in|not signed|unauthori[sz]ed|\b401\b|auth(entication)? (required|failed)/i.test(`${text} ${code}`)) return 'Sign in to Puter to use the assistant.';
  if (/network|failed to fetch|offline|timed? ?out|took too long|deadline exceeded|context canceled|ECONN|connection/i.test(text)) return 'The AI service could not be reached. Check your connection.';
  return text ? `The AI service said: ${text.slice(0, 300)}` : 'The AI service did not answer.';
}
