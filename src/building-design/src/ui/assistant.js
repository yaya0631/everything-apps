/**
 * AI assistant dock panel. It reads a summary of the open project and answers
 * questions about it, but it does not edit the model: Building Design keeps
 * every model change in its own tools and undo stack, so this panel is an
 * adviser, not a second editor. The model list is the set Admin -> AI enabled
 * and the choice is remembered on this device.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { whenPuter, isSignedIn, signIn as puterSignIn, getUser } from '../platform.js';
import { KIND_LABEL } from '../core/catalog.js';
import { MODEL_KINDS } from '../core/scene.js';
import { formatLength } from '../core/units.js';

const MODEL_KEY = 'bd.assistant.model';
const MAX_HISTORY = 24;
const MAX_TOKENS = 1600;

const SUGGESTIONS = {
  project: ['Summarize this project', 'What should I detail next?', 'Which rooms are on this level?'],
  empty: ['How do I start a floor plan?', 'How do walls, doors and windows work together?', 'What does a BIM model include?'],
};

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Markdown-lite: paragraphs, headings, lists, `code` and **bold**, all escaped. */
function rich(el, text) {
  clear(el);
  const ul = [];
  const flush = () => {
    if (!ul.length) return;
    const list = document.createElement('ul');
    for (const item of ul) {
      const li = document.createElement('li');
      li.innerHTML = item;
      list.append(li);
    }
    el.append(list);
    ul.length = 0;
  };
  for (const raw of String(text).split(/\n/)) {
    const line = esc(raw)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .trim();
    if (/^[-*]\s+/.test(line)) ul.push(line.replace(/^[-*]\s+/, ''));
    else if (/^#{1,3}\s+/.test(line)) {
      flush();
      const p = document.createElement('p');
      p.innerHTML = `<b>${line.replace(/^#{1,3}\s+/, '')}</b>`;
      el.append(p);
    } else if (line) {
      flush();
      const p = document.createElement('p');
      p.innerHTML = line;
      el.append(p);
    }
  }
  flush();
}

/** Read the answer from the shapes Puter's chat has returned over time. */
export function replyText(response) {
  const content = response?.message?.content ?? response?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  if (typeof response === 'string') return response;
  if (typeof response?.text === 'string') return response.text;
  if (response && typeof response.toString === 'function') {
    const s = response.toString();
    if (s && s !== '[object Object]') return s;
  }
  return '';
}

/** A compact, factual summary of the open project for the model. */
export function projectBrief(app) {
  const doc = app.doc;
  if (!doc) return 'No project is open.';
  const units = doc.units;
  const levels = doc
    .levels()
    .slice()
    .sort((a, b) => (a.elevation || 0) - (b.elevation || 0));
  const counts = [];
  for (const kind of MODEL_KINDS) {
    const n = doc.all(kind).length;
    if (n) counts.push(`${KIND_LABEL[kind] || kind}: ${n}`);
  }
  for (const kind of ['room', 'grid', 'dimension', 'text']) {
    const n = doc.all(kind).length;
    if (n) counts.push(`${KIND_LABEL[kind] || kind}: ${n}`);
  }
  const lines = [
    `Project: ${doc.project.name || 'Untitled'}`,
    `Units: ${units.system === 'imperial' ? 'imperial (feet and inches)' : 'metric (millimetres)'}`,
    `Levels: ${levels.length ? levels.map((l) => `${l.name} at ${formatLength(l.elevation || 0, units)}`).join('; ') : 'none'}`,
    `Elements: ${counts.length ? counts.join(', ') : 'none yet'}`,
  ];
  const rooms = doc
    .all('room')
    .map((r) => r.name)
    .filter(Boolean);
  if (rooms.length) lines.push(`Rooms: ${rooms.slice(0, 30).join(', ')}${rooms.length > 30 ? `, +${rooms.length - 30} more` : ''}`);
  const view = app.activeView;
  if (view) lines.push(`Active view: ${view.name} (${view.kind})`);
  const selection = [...app.selection].map((id) => doc.get(id)).filter(Boolean);
  if (selection.length) {
    const names = selection.slice(0, 8).map((el) => `${KIND_LABEL[el.kind] || el.kind}${el.name ? ` "${el.name}"` : ''}`);
    lines.push(`Selected: ${names.join(', ')}${selection.length > 8 ? `, +${selection.length - 8} more` : ''}`);
  }
  return lines.join('\n');
}

/** The one-line context strip under the model picker. */
export function summaryLine(app) {
  const doc = app.doc;
  if (!doc) return 'No project open';
  const bits = [];
  const levels = doc.levels().length;
  if (levels) bits.push(`${levels} level${levels === 1 ? '' : 's'}`);
  for (const kind of ['wall', 'door', 'window', 'room']) {
    const n = doc.all(kind).length;
    if (n) bits.push(`${n} ${KIND_LABEL[kind].toLowerCase()}${n === 1 ? '' : 's'}`);
  }
  const view = app.activeView;
  if (view) bits.push(view.name);
  if (app.selection.size) bits.push(`${app.selection.size} selected`);
  return bits.join(' · ') || 'Empty project';
}

function systemPrompt(app) {
  return [
    'You are the Assistant in Building Design, a browser BIM app.',
    'You can read the project summary below, but you cannot change the model. This panel is advisory.',
    'Answer questions about the project and about building design clearly and briefly.',
    'When the person asks for a change, do not claim you made it: give exact steps using the app tools and two-letter shortcuts.',
    'Shortcuts: WA Wall, DR Door, WN Window, SB Floor, RM Room, DI Dimension, TX Text, MV Move, CO Copy, RO Rotate, ZF Zoom to Fit, PP Properties, AI Assistant.',
    'Use short paragraphs or bullets. Do not invent project details that are not in the summary.',
    '',
    'Project summary:',
    projectBrief(app),
  ].join('\n');
}

function abortError() {
  const error = new Error('Stopped.');
  error.name = 'AbortError';
  return error;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function errorText(error) {
  const message = error?.message || error?.error?.message || (typeof error === 'string' ? error : '');
  if (!message) return 'The assistant request failed. Try again.';
  if (/sign.?in|unauthor|401|403/i.test(message)) return 'Sign in to use the assistant, then try again.';
  if (/bad_model|no model|model.*(unavailable|not found)/i.test(message)) return 'That AI model is unavailable. Choose another model above.';
  return message;
}

export class AssistantPanel {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.messages = [];
    this.models = [];
    this.busy = false;
    this.ctrl = null;
    this.puterReady = false;
    this.signedIn = false;
    this.chatAvailable = false;
    this.modelsLoaded = false;
    this.root = this.build();
    host.append(this.root);
    this.renderEmpty();
    this.checkAccess();
  }

  get doc() {
    return this.app.doc;
  }

  build() {
    this.model = h('select.input.sm.assistant-model', {
      'aria-label': 'AI model',
      hidden: true,
      onChange: () => {
        try {
          localStorage.setItem(MODEL_KEY, this.model.value);
        } catch {
          /* ignore quota */
        }
      },
    });
    this.model.addEventListener('keydown', (e) => e.stopPropagation());

    this.newBtn = h(
      'button.icon-btn.sm',
      { type: 'button', 'aria-label': 'New conversation', 'data-tip': 'New conversation', onClick: () => this.reset() },
      icon('plus', 16),
    );

    this.contextName = h('strong.assistant-project', 'No project open');
    this.contextLine = h('span.assistant-context-line', '');
    this.context = h(
      'div.assistant-context',
      icon('sparkles', 15),
      h('div.assistant-context-text', this.contextName, this.contextLine),
    );

    this.logEl = h('div.assistant-log', {
      role: 'log',
      tabindex: '0',
      'aria-label': 'Assistant conversation',
      'aria-live': 'polite',
      'aria-relevant': 'additions',
    });
    this.logEl.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.suggestEl = h('div.assistant-suggestions', { 'aria-label': 'Suggested questions' });

    this.input = h('textarea.input.assistant-input', {
      rows: '2',
      placeholder: 'Ask about this project…',
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

    this.sendBtn = h('button.btn.primary.sm', { type: 'submit', 'aria-label': 'Send' }, 'Send');
    this.stopBtn = h('button.btn.sm', { type: 'button', 'aria-label': 'Stop', hidden: true, onClick: () => this.stop() }, 'Stop');

    this.composer = h(
      'form.assistant-composer',
      {
        onSubmit: (e) => {
          e.preventDefault();
          this.send();
        },
      },
      this.input,
      h('div.assistant-composer-row', this.sendBtn, this.stopBtn),
    );

    return h('div.assistant', h('div.assistant-toolbar', this.model, h('span.grow'), this.newBtn), this.context, this.logEl, this.suggestEl, this.composer);
  }

  autoSize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
    this.input.scrollTop = this.input.scrollHeight;
  }

  scrollToEnd() {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  focus() {
    if (!this.input.disabled) this.input.focus();
  }

  async checkAccess() {
    const ok = await whenPuter();
    this.puterReady = true;
    this.p = ok ? globalThis.puter : null;
    if (this.p) {
      this.signedIn = await isSignedIn();
      this.user = this.signedIn ? await getUser() : null;
      this.chatAvailable = typeof this.p.ai?.chat === 'function';
    } else {
      this.signedIn = false;
      this.chatAvailable = false;
    }
    this.updateEnabled();
    if (!this.messages.length) this.renderEmpty();
    if (this.signedIn && this.chatAvailable && !this.modelsLoaded) this.loadModels();
  }

  async signIn() {
    try {
      await puterSignIn();
      await this.checkAccess();
      this.refresh();
      this.focus();
    } catch {
      this.note('Sign-in was cancelled.');
    }
  }

  async loadModels() {
    this.modelsLoaded = true;
    if (!this.p?.ai?.models) {
      this.updateEnabled();
      return;
    }
    try {
      const list = await this.p.ai.models();
      const models = (Array.isArray(list) ? list : []).filter((m) => m && typeof m.id === 'string' && m.id.trim());
      this.models = models;
      if (!models.length) {
        this.model.hidden = true;
        this.updateEnabled();
        return;
      }
      let saved = '';
      try {
        saved = localStorage.getItem(MODEL_KEY) || '';
      } catch {
        /* ignore */
      }
      if (!models.some((m) => m.id === saved)) saved = models[0].id;
      this.model.replaceChildren(
        ...models.map((m) => {
          const option = document.createElement('option');
          option.value = m.id;
          option.textContent = m.label || m.id;
          return option;
        }),
      );
      this.model.value = saved;
      this.model.hidden = false;
    } catch {
      this.models = [];
      this.model.hidden = true;
    }
    this.updateEnabled();
  }

  updateEnabled() {
    const ready = this.signedIn && this.chatAvailable && !this.busy;
    this.input.disabled = !ready;
    this.sendBtn.disabled = !ready;
    this.sendBtn.hidden = this.busy;
    this.stopBtn.hidden = !this.busy;
    this.newBtn.disabled = this.busy;
    this.model.disabled = this.busy;
    this.root.setAttribute('aria-busy', String(this.busy));
    this.suggestEl.hidden = this.busy || this.messages.length > 0 || !ready;
  }

  /** The project changed: start a new conversation for the new document. */
  setProject() {
    if (this.busy) this.stop();
    this.messages = [];
    clear(this.logEl);
    this.renderEmpty();
    this.refresh();
  }

  /** Project, selection or view changed: update the context strip. */
  refresh() {
    const doc = this.doc;
    this.contextName.textContent = doc ? doc.project.name || 'Untitled' : 'No project open';
    this.contextLine.textContent = summaryLine(this.app);
    this.context.title = doc ? projectBrief(this.app) : '';
    this.renderSuggestions();
  }

  reset() {
    if (this.busy) return;
    this.messages = [];
    clear(this.logEl);
    this.renderEmpty();
    this.input.focus();
  }

  renderEmpty() {
    clear(this.logEl);
    const box = h('div.assistant-empty', h('span.assistant-empty-mark', icon('sparkles', 22)));
    if (!this.puterReady) box.append(h('p', 'Connecting to Puter…'));
    else if (!this.p) box.append(h('p', 'The assistant needs the Puter connection. Open Building Design from the hub or the Puter desktop to use it.'));
    else if (!this.signedIn) {
      box.append(h('p', 'Sign in to ask about this project with Puter AI.'));
      box.append(h('button.btn.sm', { type: 'button', onClick: () => this.signIn() }, icon('log-in', 14), 'Sign in'));
    } else if (!this.chatAvailable) box.append(h('p', 'AI is not available in this build.'));
    else if (!this.doc) box.append(h('p', 'Ask about building design, or open a project to ask about its contents.'));
    else box.append(h('p', `Ask about ${this.doc.project.name || 'this project'}, its levels, rooms and views — or about what to model next.`));
    this.logEl.append(box);
    this.renderSuggestions();
    this.updateEnabled();
  }

  renderSuggestions() {
    clear(this.suggestEl);
    const chips = this.messages.length ? [] : this.doc ? SUGGESTIONS.project : SUGGESTIONS.empty;
    for (const text of chips) {
      this.suggestEl.append(
        h(
          'button.assistant-chip',
          {
            type: 'button',
            onClick: () => {
              if (this.input.disabled) return;
              this.input.value = text;
              this.send();
            },
          },
          text,
        ),
      );
    }
    this.suggestEl.hidden = this.busy || !chips.length || !this.signedIn || !this.chatAvailable;
  }

  addMessage(kind, who, text) {
    const body = h('div.assistant-text');
    if (text != null) rich(body, text);
    const el = h(`div.assistant-msg.${kind}`, h('div.assistant-who', who), body);
    this.logEl.append(el);
    this.scrollToEnd();
    return { el, body };
  }

  note(text, kind = 'note') {
    this.addMessage(kind, 'Assistant', text);
  }

  stop() {
    this.ctrl?.abort();
  }

  trimHistory() {
    if (this.messages.length <= MAX_HISTORY + 8) return;
    this.messages = this.messages.slice(-MAX_HISTORY);
    while (this.messages.length && this.messages[0].role !== 'user') this.messages.shift();
  }

  async send() {
    if (this.busy) return;
    if (!this.signedIn || !this.chatAvailable) {
      this.renderEmpty();
      return;
    }
    const text = this.input.value.trim();
    if (!text) {
      this.input.focus();
      return;
    }
    const model = this.model.hidden ? '' : this.model.value;
    const who = this.model.selectedOptions?.[0]?.textContent || 'Assistant';
    this.input.value = '';
    this.autoSize();
    this.messages.push({ role: 'user', content: text });
    this.addMessage('user', this.user?.username || 'You', text);
    this.busy = true;
    this.ctrl = new AbortController();
    this.updateEnabled();
    const bot = this.addMessage('bot', who, null);
    bot.body.append(h('span.assistant-thinking', 'Thinking…'));
    this.scrollToEnd();
    try {
      const messages = [{ role: 'system', content: systemPrompt(this.app) }, ...this.messages.slice(-MAX_HISTORY)];
      const reply = await abortable(this.p.ai.chat(messages, false, { model: model || undefined, max_tokens: MAX_TOKENS }), this.ctrl.signal);
      if (this.ctrl.signal.aborted) throw abortError();
      const answer = replyText(reply).trim();
      if (!answer) throw new Error('The model returned no answer. Try again or choose another model.');
      rich(bot.body, answer);
      this.messages.push({ role: 'assistant', content: answer });
      this.trimHistory();
    } catch (error) {
      if (this.ctrl?.signal.aborted || error?.name === 'AbortError') {
        bot.el.classList.add('note');
        rich(bot.body, 'Stopped.');
      } else {
        bot.el.classList.add('error');
        rich(bot.body, errorText(error));
      }
    } finally {
      this.busy = false;
      this.ctrl = null;
      this.updateEnabled();
      this.scrollToEnd();
      this.input.focus();
    }
  }
}
