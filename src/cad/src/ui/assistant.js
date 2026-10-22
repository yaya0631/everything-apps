/**
 * AI assistant dock panel: a chat that reads and edits the drawing with the
 * tools in ai/tools.js. The server proxies the chat to the provider picked in
 * Admin → AI; each turn streams NDJSON events and may run several tool rounds.
 * AI changes land in the ordinary undo stack and merge into a single step
 * labeled "AI: <first words of what you asked>".
 *
 * Each drawing keeps its own conversation (a Map keyed by the doc), and the
 * panel re-renders when the active drawing changes or the dock panel opens.
 * A model without tool support is retried once in the same turn, chat-only.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { ToolError, execTool, toolSchemas, systemPrompt, resultForModel } from '../ai/tools.js';

const MAX_TOOL_ROUNDS = 12;
/** Context messages kept (a turn is one user/assistant message plus its tool rows). */
const MAX_HISTORY = 40;
const MODEL_KEY = 'settings.aiModel';
/** How many drawings' conversations to remember at once. */
const MAX_CONVOS = 12;

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Markdown-lite: paragraphs, `code`, **bold** and - lists, all written pre-escaped. */
function rich(el, text) {
  clear(el);
  const ul = [];
  const flush = () => {
    if (ul.length) {
      const list = document.createElement('ul');
      for (const item of ul) {
        const li = document.createElement('li');
        li.innerHTML = item;
        list.append(li);
      }
      el.append(list);
      ul.length = 0;
    }
  };
  for (const raw of String(text).split(/\n/)) {
    const line = esc(raw).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').trim();
    if (/^[-*]\s+/.test(line)) ul.push(line.replace(/^[-*]\s+/, ''));
    else if (line.trim()) {
      flush();
      const p = document.createElement('p');
      p.innerHTML = line;
      el.append(p);
    }
  }
  flush();
}

export class AssistantPanel {
  constructor(app) {
    this.app = app;
    /** One conversation per drawing: Map<doc, {messages: [], log: []}>. */
    this.convos = new Map();
    this.busy = false;
    this.ctrl = null;
    this.el = this.build();
  }

  get doc() {
    return this.app.doc;
  }

  get drawing() {
    return this.app.doc?.drawing ?? null;
  }

  get editor() {
    return this.app.editor;
  }

  /** The conversation of the active drawing (created on first use). */
  #convo() {
    const doc = this.doc;
    if (!doc) return { messages: [], log: [] };
    if (!this.convos.has(doc)) {
      this.convos.set(doc, { messages: [], log: [] });
      while (this.convos.size > MAX_CONVOS) this.convos.delete(this.convos.keys().next().value);
    }
    return this.convos.get(doc);
  }

  /** One conversation per drawing: this.messages is the active drawing's history. */
  get messages() {
    return this.#convo().messages;
  }

  build() {
    this.model = h('select.input.sm', {
      'aria-label': 'AI model',
      onChange: () => {
        puter.kv.set(MODEL_KEY, this.model.value).catch(() => {});
        this.render();
      },
    });
    this.model.addEventListener('keydown', (e) => e.stopPropagation());
    this.loadModels();

    this.newBtn = h(
      'button.icon-btn.sm',
      { type: 'button', 'data-tip': 'New conversation', 'aria-label': 'New conversation', onClick: () => this.reset() },
      icon('plus', 16),
    );

    this.log = h('div.as-log', { 'aria-live': 'polite' });
    this.log.addEventListener('keydown', (e) => e.stopPropagation());
    this.log.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.input = h('textarea.as-input', {
      placeholder: 'Ask about the drawing, or say what to draw…',
      rows: '2',
      'aria-label': 'Message for the assistant',
      onInput: () => this.autoSize(),
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.send();
        } else if (e.key === 'Escape' && this.busy) {
          e.preventDefault();
          this.stop();
        }
      },
    });

    this.sendBtn = h('button.btn.primary.sm', { type: 'button', 'aria-label': 'Send', onClick: () => this.send() }, 'Send');
    this.stopBtn = h('button.btn.sm', { type: 'button', 'aria-label': 'Stop', hidden: true, onClick: () => this.stop() }, 'Stop');

    return h('div.as', h('div.lm-toolbar', h('span.as-title', 'Assistant'), h('div.grow'), this.model, this.newBtn), this.log, h('div.as-composer', this.input, this.sendBtn, this.stopBtn));
  }

  autoSize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(140, this.input.scrollHeight)}px`;
    this.input.scrollTop = this.input.scrollHeight;
  }

  async loadModels() {
    try {
      const list = await puter.ai.models();
      clear(this.model);
      const models = (list || []).filter((m) => m && m.id);
      if (!models.length) {
        this.model.append(h('option', { value: '' }, this.#noModelsText()));
        this.render();
        return;
      }
      const saved = await puter.kv.get(MODEL_KEY).catch(() => null);
      for (const m of models) this.model.append(h('option', { value: m.id }, m.label || m.id));
      const editable = models.some((m) => m.tools !== false);
      const preferred = models.find((m) => m.id === saved) ?? (editable ? models.find((m) => m.tools !== false) : models[0]);
      if (preferred) this.model.value = preferred.id;
      this.render();
    } catch (err) {
      clear(this.model);
      this.model.append(h('option', { value: '' }, err?.code === 'network' ? 'No connection' : this.#noModelsText()));
      this.render();
    }
  }

  #noModelsText() {
    return this.app.user?.isAdmin ? 'Set up AI in Admin → AI' : 'No AI model set up yet';
  }

  reset() {
    if (this.busy) return;
    const c = this.#convo();
    c.messages = [];
    c.log = [];
    this.convos.delete(this.doc);
    clear(this.log);
    this.render();
    this.input.focus();
  }

  note(text, kind = '') {
    const el = h(`p.as-note${kind ? `.${kind}` : ''}`, text);
    this.log.append(el);
    this.#convo().log.push(el);
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** The active drawing changed: show its conversation and recheck the input. */
  docChanged() {
    if (this.busy) this.stop();
    clear(this.log);
    const c = this.#convo();
    for (const el of c.log) this.log.append(el);
    if (c.log.length) this.log.scrollTop = this.log.scrollHeight;
    this.render();
  }

  // Rendering -------------------------------------------------------------------

  render() {
    this.#placeholder();
    this.readOnly = !!this.drawing?.readOnly;
    this.input.disabled = this.busy || !this.#ctx();
    this.sendBtn.disabled = this.busy || !this.model.value || !this.#ctx();
    this.sendBtn.hidden = this.busy;
    this.stopBtn.hidden = !this.busy;
  }

  #placeholder() {
    if (this.log.children.length) return;
    const c = this.#convo();
    let el;
    if (!this.drawing) el = h('p.as-note', 'Open or create a drawing, then ask here. For example: "draw three circles in a row" or "how many circles are there?"');
    else if (this.drawing.readOnly) el = h('p.as-note.warn', 'This drawing is open read-only, so the assistant can answer questions about it but not edit it.');
    else el = h('p.as-note', 'Ask about the drawing or say what to change. For example: "draw three circles in a row", "how many circles are there?" or "new layer Frames, then label it".');
    this.log.append(el);
    if (this.doc) c.log.push(el);
  }

  /** Context for one turn; null when there is no open drawing. */
  #ctx() {
    const doc = this.doc;
    if (!doc) return null;
    return { app: this.app, editor: this.editor, drawing: doc.drawing, doc };
  }

  // Chat ----------------------------------------------------------------------------

  async send() {
    if (this.busy) return;
    const ctx = this.#ctx();
    if (!ctx) {
      this.note('Open or create a drawing first.', 'warn');
      return;
    }
    if (!this.model.value) {
      this.note(this.app.user?.isAdmin ? 'No AI model is set up yet. Enable one in Admin → AI.' : 'No AI model is set up yet. The server admin can enable one in Admin → AI.', 'warn');
      return;
    }
    const model = this.model.value;
    const text = this.input.value.trim();
    if (!text) {
      this.input.focus();
      return;
    }
    this.input.value = '';
    this.autoSize();
    this.messages.push({ role: 'user', content: text });
    this.#addMsg('user', 'You').body.append(text);
    this.busy = true;
    this.ctrl = new AbortController();
    this.render();

    // All drawing edits of this turn merge into one undo step.
    const mark = ctx.drawing.undoStack.length;
    try {
      let useTools = true;
      let rounds = 0;
      for (;;) {
        let answer;
        let toolCalls;
        try {
          ({ text: answer, toolCalls } = await this.#turn(model, ctx, useTools));
        } catch (err) {
          if (err?.code === 'tools_unsupported' && useTools) {
            // Same turn, same messages, without tools: some models can't edit.
            useTools = false;
            this.note("This model can't edit the drawing, chat only.", 'warn');
            continue;
          }
          throw err;
        }
        this.messages.push({ role: 'assistant', content: answer, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
        if (!toolCalls.length) break;
        for (const tc of toolCalls) {
          const result = this.#runTool(ctx, tc);
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: resultForModel(result) });
        }
        if (++rounds >= MAX_TOOL_ROUNDS) {
          this.note(`Stopped after ${MAX_TOOL_ROUNDS} rounds of drawing changes — say "continue" if there is more to do.`, 'warn');
          break;
        }
      }
      this.#trim();
    } catch (err) {
      if (this.ctrl?.signal.aborted || err?.name === 'AbortError') this.note('Stopped.', 'warn');
      else this.note(err?.message || 'The assistant request failed.', 'warn');
    } finally {
      this.busy = false;
      this.ctrl = null;
      this.#mergeUndo(ctx, mark, text);
      this.render();
      this.input.focus();
    }
  }

  stop() {
    this.ctrl?.abort();
  }

  /** One streamed model round. Returns {text, toolCalls}. */
  async #turn(model, ctx, useTools) {
    const { body } = this.#addMsg('ai', this.model.selectedOptions[0]?.textContent || 'Assistant');
    const messages = [{ role: 'system', content: systemPrompt(execTool(ctx, 'drawing_info', {}), { readOnly: !!ctx.drawing.readOnly }) }, ...this.#history()];
    let text = '';
    const calls = [];
    const paint = (stop) => {
      if (text) rich(body, stop ? `${text}\n(stopped)` : text);
      else clear(body).append(h('span.as-thinking', '…'));
      this.log.scrollTop = this.log.scrollHeight;
    };
    paint(false);
    const res = await puter.ai.chat({ model, messages, tools: useTools ? toolSchemas() : undefined }, this.ctrl.signal);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const line = (raw) => {
      if (!raw) return;
      let ev;
      try {
        ev = JSON.parse(raw);
      } catch {
        return;
      }
      if (ev.type === 'text') {
        text += ev.delta;
        paint(false);
      } else if (ev.type === 'tool_call') calls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
      else if (ev.type === 'error') {
        const e = new Error(ev.message || 'The AI request failed.');
        e.code = ev.code;
        throw e;
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          line(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      }
      line(buf.trim());
    } catch (err) {
      if (this.ctrl?.signal.aborted || err?.name === 'AbortError') {
        // Stop now: partial changes mid-turn would half-finish the user's request.
        paint(true);
        return { text, toolCalls: [] };
      }
      throw err;
    }
    paint(false);
    return { text, toolCalls: calls };
  }

  /** Execute one tool_call, show the outcome, and return a JSON-able result. */
  #runTool(ctx, tc) {
    const row = h('div.as-tool', icon('sparkle', 13), h('span.as-tool-name', tc.name.replace(/_/g, ' ')), h('span.as-tool-out', '…'));
    this.log.append(row);
    this.#convo().log.push(row);
    try {
      const out = execTool(ctx, tc.name, tc.arguments);
      const blob = JSON.stringify(out) || '{}';
      row.querySelector('.as-tool-out').textContent = blob.length > 120 ? `${blob.slice(0, 117)}…` : blob;
      this.log.scrollTop = this.log.scrollHeight;
      return out;
    } catch (err) {
      const msg = err instanceof ToolError ? err.message : `${err?.message || err}`;
      row.querySelector('.as-tool-out').textContent = `failed: ${msg}`;
      this.log.scrollTop = this.log.scrollHeight;
      return { error: msg };
    }
  }

  #history() {
    let msgs = this.messages;
    if (msgs.length > MAX_HISTORY) msgs = msgs.slice(-MAX_HISTORY);
    while (msgs.length && (msgs[0].role === 'tool' || (msgs[0].role === 'assistant' && msgs[0].tool_calls))) msgs = msgs.slice(1);
    return msgs;
  }

  #trim() {
    if (this.messages.length <= MAX_HISTORY + 10) return;
    const c = this.#convo();
    c.messages = c.messages.slice(-MAX_HISTORY);
  }

  #mergeUndo(ctx, mark, from) {
    if (this.app.doc?.drawing !== ctx.drawing) return;
    const label = `AI: ${String(from).trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 40)}`;
    try {
      ctx.drawing.mergeSince(mark, label);
    } catch {
      /* the drawing may be gone */
    }
  }

  #addMsg(kind, who) {
    const body = h('div.as-body');
    const el = h(`div.as-msg.${kind}`, h('div.as-who', who), body);
    this.log.append(el);
    const c = this.#convo();
    if (this.doc) c.log.push(el);
    this.log.scrollTop = this.log.scrollHeight;
    return { el, body };
  }
}
