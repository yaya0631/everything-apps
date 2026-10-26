import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assistantPrompt, readReply, assistantError, runAssistant, DOC_TOOLS } from '../src/lib/assistant.js';
import { sendMail, canEmail, EMAIL } from '../src/lib/mail-send.js';
import { saveVersion, listVersions, readVersionMeta, writeVersionMeta, metaPath, MAX_VERSIONS } from '../src/lib/versions.js';

describe('assistant prompts and replies', () => {
  it('sends only the chosen text, fenced, with the request and recent turns', () => {
    const prompt = assistantPrompt({ request: 'Make it friendlier', text: 'Dear sir.', scope: 'selection', history: [{ request: 'Shorten', reply: 'Hi.' }] });
    expect(prompt).toContain('the passage the person selected');
    expect(prompt).toContain('"""\nDear sir.\n"""');
    expect(prompt).toContain('The person asks: Make it friendlier');
    expect(prompt).toContain('Person: Shorten\nYou: Hi.');
    expect(assistantPrompt({ request: 'Summarize', text: 'All of it', scope: 'document' })).toContain('the whole document');
  });
  it('fences text that itself contains quotation marks', () => {
    const prompt = assistantPrompt({ request: 'x', text: 'He said """no"""', scope: 'selection' });
    expect(prompt).toContain('""""\nHe said """no"""\n""""');
  });
  it('reads text and answers, splitting paragraphs and list items', () => {
    expect(readReply({ message: { content: 'TEXT:\nFirst.\n\n- one\n- two' } })).toEqual({ kind: 'text', text: 'First.\n\n- one\n- two', paragraphs: ['First.', '• one', '• two'] });
    expect(readReply('ANSWER: It is about planning.').kind).toBe('answer');
    expect(readReply('No marker at all.').kind).toBe('answer');
    expect(() => readReply('TEXT:')).toThrow(/nothing/);
  });
  it('explains failures in plain words', () => {
    expect(assistantError(new Error('insufficient funds'))).toMatch(/allowance/);
    expect(assistantError(new Error('Failed to fetch'))).toMatch(/connection/);
  });
  it('offers the edit tool and runs it before the final answer', async () => {
    const calls = [];
    const chat = async (messages, options) => {
      calls.push({ messages, options });
      if (messages.some((m) => m.role === 'tool')) return { message: { content: 'ANSWER: Shortened the introduction.' } };
      return { message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'edit_document', arguments: JSON.stringify({ text: 'Hi.', mode: 'replace_selection' }) } }] } };
    };
    const result = await runAssistant({
      chat, prompt: 'Shorten the introduction', model: 'openrouter:test',
      runTool: (name, args) => { expect(name).toBe('edit_document'); return { content: 'Changed the document.', applied: { mode: args.mode } }; },
    });
    expect(calls[0].options).toMatchObject({ model: 'openrouter:test', max_tokens: 4096, tools: DOC_TOOLS });
    expect(calls[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'Changed the document.' });
    expect(result.usedTools).toBe(true);
    expect(result.applied).toEqual([{ mode: 'replace_selection' }]);
    expect(result.text).toBe('ANSWER: Shortened the introduction.');
  });
  it('keeps the applied change when the tool-only turn has no closing sentence', async () => {
    let round = 0;
    const chat = async () => {
      round++;
      if (round === 1) return { message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'edit_document', arguments: JSON.stringify({ text: 'Hi.', mode: 'replace_document' }) } }] } };
      return { message: { content: '' } };
    };
    const result = await runAssistant({
      chat, prompt: 'Insert a greeting', model: 'openrouter:test',
      runTool: () => ({ content: 'Changed the document.', applied: { mode: 'replace_document' } }),
    });
    expect(result.usedTools).toBe(true);
    expect(result.text).toBe('');
    expect(result.applied).toEqual([{ mode: 'replace_document' }]);
  });
  it('prompts for the tool only in the editing mode', () => {
    expect(assistantPrompt({ request: 'x', text: 'y', scope: 'selection', tools: true })).toContain('call the edit_document tool');
    expect(assistantPrompt({ request: 'x', text: 'y', scope: 'selection' })).toContain('reply with the line "TEXT:"');
  });
});

describe('sending mail', () => {
  afterEach(() => { delete globalThis.puter; });
  it('sends an attachment from the user address and asks for permission once when refused', async () => {
    const sent = [], asked = [];
    let refuse = true;
    globalThis.puter = {
      email: { async send(message) { sent.push(message); if (refuse) { refuse = false; return { code: 'forbidden' }; } return { delivered: [message.to] }; } },
      perms: { async request(kind, options) { asked.push(options.permission); } },
    };
    expect(canEmail()).toBe(true);
    const result = await sendMail({ to: 'a@example.com', subject: 'Doc', text: 'Here', username: 'ada', attachments: [{ filename: 'Doc.docx', bytes: new Uint8Array([80, 75]), contentType: 'application/x' }] });
    expect(result).toEqual({ ok: true });
    expect(asked).toEqual(['fs:/ada/.mail:write']);
    expect(sent[1].attachments).toEqual([{ filename: 'Doc.docx', content: 'UEs=', contentType: 'application/x' }]);
  });
  it('reports a daily limit and a missing service', async () => {
    globalThis.puter = { email: { send: async () => ({ code: 'too_many_requests' }) } };
    expect((await sendMail({ to: 'a@example.com', subject: 's', text: 't' })).message).toMatch(/limit/);
    globalThis.puter = {};
    expect((await sendMail({ to: 'a@example.com', subject: 's', text: 't' })).ok).toBe(false);
    expect(EMAIL.test('someone@example.com')).toBe(true);
    expect(EMAIL.test('ada')).toBe(false);
  });
});

describe('version details', () => {
  let files;
  beforeEach(() => {
    files = new Map();
    globalThis.puter = { env: 'web', fs: {
      async readdir(p) { return [...files.entries()].filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')).map(([k, v]) => ({ name: k.split('/').pop(), path: k, size: v.size, modified: 1 })); },
      async write(p, blob, { overwrite = true } = {}) { if (files.has(p) && !overwrite) throw new Error('exists'); files.set(p, blob); return { path: p, name: p.split('/').pop() }; },
      async read(p) { if (!files.has(p)) throw Object.assign(new Error('does not exist'), { code: 'subject_does_not_exist' }); return files.get(p); },
      async delete(p) { files.delete(p); },
      async stat(p) { if (files.has(p)) return { path: p }; throw Object.assign(new Error('does not exist'), { code: 'subject_does_not_exist' }); },
      async mkdir() {},
    } };
  });
  afterEach(() => { delete globalThis.puter; });
  it('keeps who saved a version and its name beside it, and trims both', async () => {
    const v = await saveVersion('Documents/Plan.docx', new Blob(['x']), { now: Date.UTC(2026, 0, 1), meta: { author: 'ada', label: 'Draft' } });
    expect(await readVersionMeta(v)).toEqual({ author: 'ada', label: 'Draft' });
    await writeVersionMeta(v, { author: 'ada', label: 'Final' });
    expect((await readVersionMeta(v)).label).toBe('Final');
    // Details never count as versions.
    expect((await listVersions('Documents/Plan.docx')).length).toBe(1);
    for (let i = 1; i <= MAX_VERSIONS; i++) await saveVersion('Documents/Plan.docx', new Blob(['x']), { now: Date.UTC(2026, 0, 1) + i * 1000, meta: { author: 'bob' } });
    expect(files.has(v.path)).toBe(false);
    expect(files.has(metaPath(v.path))).toBe(false);
    expect(await readVersionMeta({ path: 'Documents/.versions/Plan/missing.docx' })).toEqual({});
  });
});
