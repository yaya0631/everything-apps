/**
 * The Assistant pane: a conversation with Puter's AI beside the pages, about
 * and for this document. Above the box the person chooses what goes with a
 * message, the selected text or the whole document, and the chip says how
 * much that is; nothing else is sent. Replies that are text for the document
 * show what they would insert or replace, and land only when the person
 * applies them, as one change Undo takes back (the reply offers Undo too).
 *
 * The pane, its button on the Home tab and the floating button beside the
 * pages are offered only where Puter's AI is available.
 */
import { el, isComposing, MOD_KEY, shortcutCode } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import * as P from '../lib/puter.js';
import { aiActionById, askAi, answerParagraphs } from '../lib/ai.js';
import { assistantPrompt, readReply, assistantError, runAssistant, DOC_TOOLS, SUGGESTIONS, MAX_ASSISTANT_CHARS, textSource, textStats, readTextRange, findTextMatches } from '../lib/assistant.js';
import { outlineEntries } from '../engine/outline.js';
import { sidePane, hint } from './review-ui.js';
import { commandIconEl } from '../ui/ribbon.js';

const words = text => (String(text).trim().match(/\S+/gu) || []).length;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// Assistant replies are Markdown. Convert headings, bold/italic runs and lists
// into the editor's own paragraph styles and character formatting before they
// touch the document, so a draft reads like a Word document rather than a text
// file full of "#" and "**". The modules load on the first edit, like the
// editor's own Markdown importer.
let richTextModules;
async function formattedText(text) {
  try {
    richTextModules ||= Promise.all([
      import('../lib/markdown-html.js'),
      import('../engine/clipboard-fragment.js'),
    ]).then(([markdown, clipboard]) => ({ markdown, clipboard }));
    const { markdown, clipboard } = await richTextModules;
    const fragment = clipboard.htmlFragment(markdown.markdownHtml(String(text ?? '')));
    return fragment ? { fragment, paste: clipboard.pasteFragment } : null;
  } catch {
    return null;
  }
}

/** Replace a range with a formatted fragment; plain text is the fallback. */
function replaceFormatted(m, text, rich, { start, end, lead = '' } = {}) {
  if (start !== undefined) m.select(start, end ?? start);
  if (lead) {
    const at = m.range[0];
    if (!m.replace(lead)) return false;
    m.select(at + lead.length, at + lead.length);
  }
  if (rich && rich.paste(m, rich.fragment)) return true;
  // Conversion is best effort: a fragment that cannot be applied must not cost
  // the person the reply. The plain-text insert is still an undoable change.
  return m.replace(text);
}

export function createAssistantPane({ editor, pkg, error, available = () => P.canUseAi(), chat = (messages, options) => P.aiChat(messages, options) }) {
  let scope = 'selection', history = [], busy = false, stopped = null;
  const pane = sidePane({ title: 'Assistant', label: 'Assistant pane', className: 'as-pane', onOpen: () => { renderContext(); renderEmpty(); fab.setAttribute('aria-expanded', 'true'); titleButton.setAttribute('aria-pressed', 'true'); }, onClose: () => { fab.setAttribute('aria-expanded', 'false'); titleButton.setAttribute('aria-pressed', 'false'); editor()?.focus(); } });
  pane.heading.prepend(el('span.as-mark', { 'aria-hidden': 'true' }, commandIconEl('assistant', 16)));
  // The models Admin → AI turned on. Hidden until they arrive, or on a host without a list.
  let model = '';
  try { model = localStorage.getItem('documents:assistant:model') || ''; } catch { /* storage blocked */ }
  const modelSel = el('select.as-model', { 'aria-label': 'AI model', title: 'AI model', hidden: true });
  modelSel.addEventListener('change', () => {
    model = modelSel.value;
    try { localStorage.setItem('documents:assistant:model', model); } catch { /* storage blocked */ }
  });
  P.aiModels().then((list) => {
    const models = list.filter((m) => m.id && m.tools !== false);
    if (!models.length) return;
    if (!models.some((m) => m.id === model)) model = models[0].id;
    modelSel.replaceChildren(...models.map((m) => el('option', { value: m.id }, m.label || m.id)));
    modelSel.value = model;
    modelSel.hidden = false;
  }).catch(() => { /* keep the default model */ });
  const newChat = el('button.btn.btn-ghost.btn-sm.as-new', { type: 'button', onclick: () => { history = []; log.replaceChildren(); renderEmpty(); input.focus(); } }, 'New chat');
  pane.heading.after(modelSel, newChat);

  const log = el('div.as-log', { role: 'log', 'aria-label': 'Conversation with the assistant', tabIndex: -1 });
  const empty = el('div.as-empty');
  const scopeSelection = el('button.as-scope-option', { type: 'button', role: 'radio', onclick: () => setScope('selection') }, 'Selection');
  const scopeDocument = el('button.as-scope-option', { type: 'button', role: 'radio', onclick: () => setScope('document') }, 'Whole document');
  const scopeGroup = el('div.as-scope', { role: 'radiogroup', 'aria-label': 'Send with your message' }, scopeSelection, scopeDocument);
  const context = el('p.as-context', { 'aria-live': 'polite' });
  const input = el('textarea.input.as-input', { rows: 3, placeholder: 'Ask about this document, or ask for a draft or a rewrite…', 'aria-label': 'Message the assistant', enterKeyHint: 'send' });
  const send = el('button.btn.btn-primary.as-send', { type: 'submit', 'aria-label': 'Send', title: 'Send (Enter)' }, 'Send');
  const form = el('form.as-form', { onsubmit: e => { e.preventDefault(); submit(input.value); } }, scopeGroup, context, el('div.as-box', {}, input, send), el('p.as-disclaimer', {}, 'Only the text shown above is sent to Puter’s AI. Replies can be wrong: check them before you use them.'));
  input.addEventListener('keydown', e => {
    if (isComposing(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(input.value); }
  });
  pane.body.append(log, form);

  // A small button at the edge of the pages opens the pane (where Puter's AI is available).
  // In the title bar beside Comments, as the other apps' assistants sit in their top bars.
  const titleButton = el('button.ed-pill.as-title-button', { type: 'button', 'aria-label': 'Assistant', title: `Assistant (${MOD_KEY}+Shift+I)`, 'aria-pressed': 'false', hidden: true, onclick: () => toggle() }, commandIconEl('assistant', 16));
  titleButton.addEventListener('mousedown', e => e.preventDefault());
  const fab = el('button.as-fab', { type: 'button', 'aria-label': 'Assistant', title: `Assistant (${MOD_KEY}+Shift+I)`, 'aria-expanded': 'false', hidden: true, onclick: () => toggle() }, commandIconEl('assistant', 20));
  fab.addEventListener('mousedown', e => e.preventDefault());
  // Mod+Shift+I opens and closes the pane from anywhere in the editor.
  const keys = new AbortController();
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e) || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || shortcutCode(e) !== 'KeyI' || !editor()) return;
    e.preventDefault(); toggle();
  }, { signal: keys.signal });

  /* ---- What goes with a message ---- */
  function selection() {
    const engine = editor(); if (!engine) return null;
    if (engine.session.path !== null) return null;
    const [start, end] = engine.model.range;
    if (start === end) return null;
    return { start, end, text: engine.model.text.slice(start, end) };
  }
  function payload() {
    const engine = editor(); if (!engine) return null;
    if (scope === 'selection') { const s = selection(); return s ? { scope, ...s } : null; }
    return { scope, text: engine.session.body.text };
  }
  function setScope(next) { scope = next; renderContext(); renderEmpty(); input.focus(); }
  function renderContext() {
    const s = selection();
    if (scope === 'selection' && !s) scope = 'document';
    scopeSelection.setAttribute('aria-checked', String(scope === 'selection'));
    scopeDocument.setAttribute('aria-checked', String(scope === 'document'));
    scopeSelection.disabled = !s;
    const p = payload();
    const count = p ? words(p.text) : 0;
    context.textContent = !p ? 'Nothing selected.' : scope === 'selection' ? `Sends the ${plural(count, 'word')} you selected.` : `Sends the whole document (${plural(count, 'word')}).`;
    context.classList.toggle('is-over', !!p && p.text.length > MAX_ASSISTANT_CHARS);
  }
  function renderEmpty() {
    if (log.querySelector('.as-message')) { empty.remove(); return; }
    const list = scope === 'selection' && selection() ? SUGGESTIONS.selection : SUGGESTIONS.document;
    empty.replaceChildren(el('p.as-empty-title', {}, 'How can I help with this document?'),
      el('div.as-suggestions', {}, ...list.map(s => el('button.as-suggestion', { type: 'button', onclick: () => (s.id ? runAction(s.id, s.label) : submit(s.ask)) }, s.label))),
      hint('The assistant sees only the selection or the whole document, as you choose below.'));
    log.append(empty);
  }

  /* ---- Messages ---- */
  const message = (who, ...children) => { empty.remove(); const node = el(`div.as-message.is-${who}`, {}, ...children); log.append(node); node.scrollIntoView?.({ block: 'nearest' }); return node; };

  async function submit(text) {
    const request = String(text || '').trim();
    if (!request || busy) return;
    const p = payload();
    if (!p) { toast('Select some text, or choose Whole document.', { icon: 'info' }); return; }
    if (p.text.length > MAX_ASSISTANT_CHARS) { toast('That is more text than the assistant takes at once. Select a shorter passage.', { icon: 'alert' }); return; }
    input.value = '';
    message('me', el('p', {}, request), el('p.as-sent', {}, scope === 'selection' ? `With ${plural(words(p.text), 'selected word')}` : 'With the whole document'));
    await reply(async () => {
      const prompt = assistantPrompt({ request, text: p.text, scope: p.scope, history, tools: true });
      const result = await runAssistant({
        chat, prompt, model, tools: DOC_TOOLS,
        runTool: (name, args) => runDocTool(name, args, p),
      });
      // A reply that used a tool already changed the document: show what it
      // says, not a second copy of the text waiting to be inserted.
      if (result.usedTools) {
        let said = 'Done.';
        try {
          const parsed = readReply({ message: { content: result.text } });
          said = parsed.text.trim() || said;
        } catch { /* the tool did the work and the model sent no closing sentence */ }
        return { kind: 'answer', text: said, paragraphs: answerParagraphs(said), applied: result.applied };
      }
      return readReply({ message: { content: result.text } });
    }, p, request);
  }

  /** One of the writing assistant's actions on the selection (Improve, Shorten, …). */
  async function runAction(id, label) {
    const action = aiActionById(id); const p = payload();
    if (!action || !p || busy) return;
    message('me', el('p', {}, label), el('p.as-sent', {}, scope === 'selection' ? `With ${plural(words(p.text), 'selected word')}` : 'With the whole document'));
    await reply(async () => { const text = await askAi(action, p.text, { chat, chatOptions: model ? { model } : {} }); return { kind: 'text', text, paragraphs: answerParagraphs(text), mode: action.mode }; }, p, label);
  }

  async function reply(ask, p, request) {
    busy = true; send.disabled = true;
    const token = stopped = {};
    const waiting = message('assistant', el('p.as-thinking', {}, 'Thinking…'));
    try {
      const answer = await ask();
      if (stopped !== token) return;
      history.push({ request, reply: answer.text });
      waiting.replaceChildren(...answerView(answer, p));
    } catch (e) {
      if (stopped !== token) return;
      waiting.classList.add('is-error');
      waiting.replaceChildren(el('p', {}, e?.message && !/AI service|could not answer/i.test(e.message) && e.message.length < 140 ? e.message : assistantError(e)));
    } finally { busy = false; send.disabled = false; }
  }

  function answerView(answer, p) {
    const body = el('div.as-answer', {}, ...answer.paragraphs.map(t => el('p', {}, t)));
    if (answer.applied?.length) return [body, appliedRow(answer.applied.length)];
    if (answer.kind !== 'text') return [body, actions(answer, p, false)];
    const replacing = p.scope === 'selection' && answer.mode !== 'append';
    const original = replacing ? el('p.as-replaces', {}, `Replaces “${p.text.length > 140 ? `${p.text.slice(0, 140).trim()}…` : p.text}”`) : null;
    return [el('p.as-kind', {}, replacing ? 'Suggested replacement' : 'Suggested text'), body, original, actions(answer, p, true)];
  }

  /** What the tools did, with one Undo that takes back every change in this reply. */
  function appliedRow(count) {
    const row = el('div.as-actions');
    const note = el('span.as-applied', { role: 'status' }, count > 1 ? `Changed the document (${count} edits)` : 'Changed the document');
    const undo = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { for (let i = 0; i < count; i++) editor()?.undo(); undo.disabled = true; note.textContent = count > 1 ? 'Undone all edits' : 'Undone'; renderContext(); } }, count > 1 ? 'Undo all' : 'Undo');
    row.append(note, undo);
    return row;
  }

  function actions(answer, p, insertable) {
    const row = el('div.as-actions');
    const copy = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => navigator.clipboard?.writeText(answer.text).then(() => toast('Copied')).catch(() => error(new Error('The clipboard is not available.'))) }, 'Copy');
    const canEdit = () => { const engine = editor(); return !!engine && !pkg()?.readOnly && !engine.viewOnly; };
    const apply = (label, how) => el(`button.btn.btn-sm${how === 'replace' ? '.btn-primary' : '.btn-outline'}`, { type: 'button', disabled: !canEdit(), onclick: e => insert(answer, p, how, row, e.currentTarget) }, label);
    if (insertable) {
      if (p.scope === 'selection' && p.start !== undefined && answer.mode !== 'append') row.append(apply('Replace Selection', 'replace'), apply('Insert Below', 'below'));
      else if (p.scope === 'selection' && p.start !== undefined) row.append(apply('Insert After Selection', 'after'));
      else row.append(apply('Insert at Cursor', 'cursor'));
    } else row.append(apply('Insert at Cursor', 'cursor'));
    row.append(copy);
    return row;
  }

  /** Apply a reply as one undoable change, where the person said. */
  async function insert(answer, p, how, row, button) {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    if (engine.session.path !== null) engine.editStory(null);
    // Keep the reply's Markdown for the rich-text conversion; paragraphs were
    // normalized for display and would merge headings into the next line.
    const text = answer.text || answer.paragraphs.join('\n');
    const rich = await formattedText(text);
    const model = engine.model;
    if (p.start !== undefined && (how === 'replace' || how === 'below' || how === 'after') && model.text.slice(p.start, p.end) !== p.text) {
      error(new Error('The selected text changed since you asked. Select it again and ask once more.')); return;
    }
    const ok = engine.execute(() => {
      const m = engine.model;
      if (how === 'replace') return replaceFormatted(m, text, rich, { start: p.start, end: p.end });
      if (how === 'below' || how === 'after') {
        // After the selection's last paragraph, as new paragraphs.
        const end = how === 'after' ? p.end : (() => { const at = m.text.indexOf('\n', p.end); return at < 0 ? m.text.length : at; })();
        return replaceFormatted(m, text, rich, { start: end, end, lead: how === 'after' ? ' ' : '\n' });
      }
      return replaceFormatted(m, text, rich);
    });
    if (!ok) return;
    engine.focus();
    button.disabled = true;
    const undo = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { editor()?.undo(); undo.disabled = true; applied.textContent = 'Undone'; renderContext(); } }, 'Undo');
    const applied = el('span.as-applied', { role: 'status' }, how === 'replace' ? 'Replaced' : 'Inserted');
    row.replaceChildren(applied, undo);
    renderContext();
  }

  /**
   * The assistant's tools. Read tools see only the text the person sent:
   * the live whole document when they chose it, or the captured selection.
   * edit_document applies each change through the editor as one undo step.
   */
  function sourceFor(p) {
    const engine = editor();
    return p.scope === 'document' ? textSource(engine?.model.text || '', 0) : textSource(p.text, p.start || 0);
  }
  function documentInfo(p) {
    const source = sourceFor(p), engine = editor();
    const outline = p.scope === 'document' && engine
      ? outlineEntries(engine.model.paragraphs)
        .filter((e) => e.start >= source.base && e.end <= source.base + source.text.length)
        .map(({ start, end, level, text }) => ({ start, end, level, text }))
      : [];
    return { scope: p.scope, start: source.base, end: source.base + source.text.length, ...textStats(source.text), outline };
  }
  async function runDocTool(name, args, p) {
    const engine = editor();
    if (!engine) return { content: 'Error: the document is not open.' };
    if (name === 'get_document') return { content: JSON.stringify(documentInfo(p)) };
    if (name === 'read_range' || name === 'find_text') {
      try {
        const source = sourceFor(p);
        const result = name === 'read_range' ? readTextRange(source, args || {}) : findTextMatches(source, args || {});
        return { content: JSON.stringify(result) };
      } catch (e) {
        return { content: `Error: ${e?.message || e}` };
      }
    }
    if (name !== 'edit_document') return { content: `Error: there is no tool called ${name}.` };
    const text = String(args?.text ?? '');
    const mode = String(args?.mode || '');
    if (!text.trim()) return { content: 'Error: no text was given, so nothing was changed.' };
    if (pkg()?.readOnly || engine.readOnly || engine.viewOnly) return { content: 'Error: the document is read-only, so nothing was changed.' };
    if (mode === 'replace_selection') {
      if (p.scope !== 'selection' || p.start === undefined) return { content: 'Error: there is no selection to replace. Nothing was changed.' };
      if (engine.model.text.slice(p.start, p.end) !== p.text) return { content: 'Error: the selected text changed since the message was sent. Nothing was changed.' };
    }
    if (mode === 'replace_document' && p.scope !== 'document') return { content: 'Error: the whole document was not sent, so it was not replaced.' };
    if (mode === 'replace_range' && p.scope !== 'document') return { content: 'Error: range edits need the whole document to be sent. Nothing was changed.' };
    if (!['replace_selection', 'insert', 'append', 'replace_range', 'replace_document'].includes(mode)) return { content: `Error: ${mode || 'no mode'} is not a way to edit the document.` };
    let start, end;
    if (mode === 'replace_range') {
      start = Number(args?.start); end = Number(args?.end);
      const length = engine.model.text.length;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > length) return { content: `Error: the range must be whole offsets from 0 to ${length}. Nothing was changed.` };
    }
    const rich = await formattedText(text);
    // The model may have taken a moment; do not replace a selection that
    // changed while it was thinking.
    if (mode === 'replace_selection' && engine.model.text.slice(p.start, p.end) !== p.text) return { content: 'Error: the selected text changed while the assistant was working. Nothing was changed.' };
    engine.finishComposition();
    if (engine.session.path !== null) engine.editStory(null);
    const ok = engine.execute(() => {
      const m = engine.model;
      if (mode === 'replace_selection') return replaceFormatted(m, text, rich, { start: p.start, end: p.end });
      if (mode === 'insert') {
        const at = p.scope === 'selection' && p.end !== undefined ? p.end : m.range[0];
        return replaceFormatted(m, text, rich, { start: at, end: at });
      }
      if (mode === 'append') {
        const at = m.text.length;
        return replaceFormatted(m, text, rich, { start: at, end: at, lead: at && !m.text.endsWith('\n') ? '\n' : '' });
      }
      if (mode === 'replace_range') return replaceFormatted(m, text, rich, { start, end });
      return replaceFormatted(m, text, rich, { start: 0, end: m.text.length });
    });
    if (!ok) return { content: 'Error: the change could not be made. Nothing was changed.' };
    engine.focus();
    renderContext();
    return { content: `Changed the document (${mode.replace(/_/g, ' ')}${mode === 'replace_range' ? ` at ${start}-${end}` : ''}).`, applied: { mode } };
  }

  function toggle() { if (!available()) return; pane.toggle(); if (pane.isOpen) queueMicrotask(() => input.focus()); }

  return {
    pane, fab, titleButton,
    get available() { return available(); },
    open() { if (!available()) return; pane.open(); queueMicrotask(() => input.focus()); },
    toggle,
    /** The editor's selection moved: what goes with a message follows it. */
    refresh() {
      fab.hidden = titleButton.hidden = !available() || !editor();
      if (pane.isOpen && !busy) { renderContext(); if (!log.querySelector('.as-message')) renderEmpty(); }
    },
    commands: {
      assistant: () => toggle(),
      assistantAvailable: () => available(),
    },
    extendMenu(id) {
      if (!['tools', 'view'].includes(id) || !available()) return [];
      return [{ separator: true }, { label: 'Assistant', icon: 'assistant', shortcut: `${MOD_KEY}+Shift+I`, checked: id === 'view' ? pane.isOpen : undefined, disabled: !editor(), onSelect: () => toggle() }];
    },
    destroy() { stopped = null; keys.abort(); pane.destroy(); },
  };
}
