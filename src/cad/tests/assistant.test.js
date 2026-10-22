// @vitest-environment jsdom
/**
 * The assistant's streaming loop over the server's NDJSON tool protocol, with a
 * fake puter.ai.chat: one turn may call tools, feed results back and answer
 * again; models that can't edit (tools_unsupported) are retried chat-only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';
import { AssistantPanel } from '../src/ui/assistant.js';

let puter;
const originalPuter = globalThis.puter;
const originalChat = globalThis.puter?.ai?.chat;

/** A streamable body that hands out the NDJSON in two uneven chunks (split mid-line). */
function streamOf(events) {
  const enc = new TextEncoder();
  const full = events.map((e) => JSON.stringify(e) + '\n').join('');
  const chunks = [full.slice(0, 31), full.slice(31)];
  let i = 0;
  return {
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }),
      }),
    },
  };
}

const makeApp = () => {
  const d = new Drawing();
  return {
    user: { isAdmin: true, id: 'u1' },
    doc: { name: 'test.cad', drawing: d, get index() { return new SpatialIndex(d); } },
    editor: null,
  };
};

const textsOf = (panel) => [...panel.log.querySelectorAll('.as-msg.ai .as-body')].map((b) => b.textContent);
const notesOf = (panel) => [...panel.log.querySelectorAll('.as-note')].map((b) => b.textContent);

describe('assistant over NDJSON', () => {
  /** Every real puter.ai.chat request, in order. */
  let chatCalls;
  /** NDJSON events queued per upcoming chat call. */
  let script;
  let panels;

  beforeEach(() => {
    panels = [];
    chatCalls = [];
    script = [];
    globalThis.puter = {
      kv: { get: async () => null, set: async () => {} },
      ai: {
        models: async () => [{ id: 'm1', label: 'Test model', tools: true }],
        chat: async (params, signal) => {
          chatCalls.push(JSON.parse(JSON.stringify(params)));
          return streamOf(script.length ? script.shift() : [{ type: 'text', delta: '' }]);
        },
      },
    };
  });

  afterEach(() => {
    for (const p of panels) p.log.remove?.();
    if (originalChat) globalThis.puter.ai.chat = originalChat;
    else if (originalPuter) globalThis.puter = originalPuter;
    else delete globalThis.puter;
  });

  it('runs a tool loop: calls tools, feeds results back and answers from them', async () => {
    const app = makeApp();
    const d = app.doc.drawing;
    const panel = new AssistantPanel(app);
    panels.push(panel);
    await panel.loadModels();

    // Round 1: a text opener and a bad add (invalid line geometry) — the whole
    // batch is refused. Round 2: the model fixes it (one circle). Round 3: done.
    script.push([
      { type: 'text', delta: 'On it — adding shapes.' },
      { type: 'tool_call', id: '1', name: 'add_entities', arguments: { entities: [{ type: 'circle', cx: 0, cy: 0, r: 5 }, { type: 'line', x1: 1, y1: 'x' }] } },
    ]);
    script.push([{ type: 'tool_call', id: '2', name: 'add_entities', arguments: { entities: [{ type: 'circle', cx: 12, cy: 0, r: 5 }] } }]);
    script.push([{ type: 'text', delta: 'Done: one circle now sits at 12, 0.' }]);

    panel.input.value = 'draw two circles';
    await panel.send();

    expect(chatCalls).toHaveLength(3);
    for (const call of chatCalls) {
      expect(call.model).toBe('m1');
      expect(Array.isArray(call.tools)).toBe(true);
    }
    // Round 2's context holds the whole exchange so far (system, user, …, tool).
    expect(chatCalls[1].messages.some((m) => m.role === 'tool' && m.tool_call_id === '1')).toBe(true);

    expect(d.entities.size).toBe(1);
    const msgs = panel.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    expect(msgs[1].tool_calls).toEqual([{ id: '1', name: 'add_entities', arguments: expect.any(Object) }]);
    // The refused batch comes back to the model as an error string, not sliced.
    expect(msgs[2]).toMatchObject({ role: 'tool', tool_call_id: '1' });
    expect(JSON.parse(msgs[2].content).error).toMatch(/number/);
    expect(JSON.parse(msgs[4].content)).toMatchObject({ ok: true, count: 1 });
    expect(msgs[5].content).toBe('Done: one circle now sits at 12, 0.');
    expect(textsOf(panel).at(-1)).toContain('Done: one circle');
    // Tool rows are visible in the log, with their outcome.
    const toolRows = [...panel.log.querySelectorAll('.as-tool-out')].map((el) => el.textContent);
    expect(toolRows).toHaveLength(2);
    expect(toolRows[0]).toMatch(/^failed:/);
    expect(toolRows[1]).toMatch(/"ok":true/);
    expect(panel.busy).toBe(false);
    expect(panel.input.value).toBe('');
  });

  it('retries once without tools when the model reports tools_unsupported', async () => {
    const app = makeApp();
    const d = app.doc.drawing;
    const panel = new AssistantPanel(app);
    panels.push(panel);
    await panel.loadModels();

    script.push([{ type: 'error', code: 'tools_unsupported', message: "This model can't edit the drawing, chat only." }]);
    script.push([{ type: 'text', delta: 'There are 0 entities right now.' }]);

    panel.input.value = 'how many circles?';
    await panel.send();

    // First request went out with the tool schemas; the retry dropped them.
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0].tools).toBeTruthy();
    expect(chatCalls[1].tools).toBeUndefined();
    expect(textsOf(panel).at(-1)).toContain('There are 0 entities');
    expect(notesOf(panel)).toContain("This model can't edit the drawing, chat only.");
    expect(d.entities.size).toBe(0);
    expect(panel.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('tells admins and users differently when no model is set up', async () => {
    const admin = new AssistantPanel(makeApp());
    panels.push(admin);
    globalThis.puter.ai.models = async () => [];
    await admin.loadModels();
    expect(admin.model.selectedOptions[0]?.textContent).toBe('Set up AI in Admin → AI');

    const userApp = makeApp();
    userApp.user = { id: 'u2' };
    const user = new AssistantPanel(userApp);
    panels.push(user);
    await user.loadModels();
    expect(user.model.selectedOptions[0]?.textContent).toBe('No AI model set up yet');

    // Without a model, send() explains the situation instead of silently failing.
    user.input.value = 'hi';
    await user.send();
    expect(notesOf(user).some((n) => n.startsWith('No AI model is set up yet'))).toBe(true);
  });
});
