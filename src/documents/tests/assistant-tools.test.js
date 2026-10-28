import { describe, it, expect } from 'vitest';
import {
  DOC_TOOLS, assistantPrompt, textSource, textStats, readTextRange, findTextMatches, runAssistant,
} from '../src/lib/assistant.js';

describe('assistant read tools', () => {
  it('describes the sent text without sending it back', () => {
    expect(textStats('One two\n\nThree')).toEqual({ characters: 14, words: 3, paragraphs: 3 });
    expect(textStats('')).toEqual({ characters: 0, words: 0, paragraphs: 0 });
  });

  it('reads exact ranges with absolute document offsets', () => {
    const source = textSource('Hello world\nSecond line', 100);
    expect(readTextRange(source, { start: 100, end: 105 })).toMatchObject({ start: 100, end: 105, text: 'Hello', more: true });
    expect(readTextRange(source, { start: 106, end: 123 })).toMatchObject({ text: 'world\nSecond line', more: false });
    // Omitted bounds read the next chunk, capped at 12,000 characters.
    expect(readTextRange(source, {})).toMatchObject({ start: 100, end: 123, text: 'Hello world\nSecond line' });
    expect(readTextRange(textSource('x'.repeat(20000)), { end: 99999 }, 12000)).toMatchObject({ end: 12000, length: 12000, more: true });
    expect(() => readTextRange(source, { start: 99, end: 101 })).toThrow('outside the text');
    expect(() => readTextRange(source, { start: 110, end: 109 })).toThrow('must not be before');
    expect(() => readTextRange(source, { start: 1.5 })).toThrow('whole-number');
  });

  it('finds literal text with offsets, case control and context', () => {
    const source = textSource('Alpha beta alpha BETA', 10);
    expect(findTextMatches(source, { query: 'alpha', context: 5 })).toMatchObject({
      matches: [
        { start: 10, end: 15, before: '', after: ' beta' },
        { start: 21, end: 26, before: 'beta ', after: ' BETA' },
      ],
      more: false,
    });
    expect(findTextMatches(source, { query: 'BETA', match_case: true }).matches).toHaveLength(1);
    expect(findTextMatches(source, { query: 'alpha', limit: 1 }).more).toBe(true);
    expect(findTextMatches(source, { query: 'zzz' }).matches).toEqual([]);
    expect(() => findTextMatches(source, { query: '  ' })).toThrow('needs text');
  });

  it('gives the model read, find and range-edit tools', () => {
    expect(DOC_TOOLS.map((t) => t.function.name)).toEqual(['edit_document', 'get_document', 'read_range', 'find_text']);
    const edit = DOC_TOOLS[0].function.parameters.properties;
    expect(edit.mode.enum).toContain('replace_range');
    expect(edit.start.type).toBe('integer');
    const prompt = assistantPrompt({ request: 'Rewrite this long report', text: 'Old', scope: 'document', tools: true });
    expect(prompt).toContain('get_document');
    expect(prompt).toContain('read_range');
    expect(prompt).toContain('replace_range');
  });
});

describe('assistant tool loop', () => {
  it('runs repeated read and edit rounds and collects every applied change', async () => {
    const seen = [];
    const chat = async (messages, options) => {
      seen.push({ messages: structuredClone(messages), options });
      if (seen.length === 1) {
        return {
          message: {
            content: null,
            tool_calls: [
              { id: 'read', function: { name: 'read_range', arguments: '{"start":0,"end":1}' } },
              { id: 'edit', function: { name: 'edit_document', arguments: '{"mode":"replace_range","start":0,"end":1,"text":"New"}' } },
            ],
          },
        };
      }
      return { message: { content: 'Changed the opening word.' } };
    };
    const calls = [];
    const result = await runAssistant({
      chat,
      prompt: 'Rewrite the opening word.',
      maxRounds: 4,
      runTool: async (name, args) => {
        calls.push([name, args]);
        return name === 'read_range' ? { content: '{"text":"Old"}' } : { content: 'Changed.', applied: { mode: args.mode } };
      },
    });
    expect(result.usedTools).toBe(true);
    expect(result.applied).toEqual([{ mode: 'replace_range' }]);
    expect(result.text).toBe('Changed the opening word.');
    expect(calls).toEqual([['read_range', { start: 0, end: 1 }], ['edit_document', { mode: 'replace_range', start: 0, end: 1, text: 'New' }]]);
    expect(seen).toHaveLength(2);
    expect(seen[0].options).toMatchObject({ tools: DOC_TOOLS, max_tokens: 8192, stream: true });
    // The second round receives both tool results, so the model can verify what happened.
    expect(seen[1].messages.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual(['{"text":"Old"}', 'Changed.']);
  });
});
