// The Assistant and Generation History in the running app, with Puter's AI
// replaced by a scripted stub: plans from tool-calling replies, running them
// as one undo step, step-by-step runs and edits, answers with "Show me", the
// start screen's describe-an-edit box, and recording and placing AI results.
import { test, expect, type Download, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { boot, historyLabels, idle, openImage, start, undo } from './helpers';

// puter.ai.chat answers from window.__chatScript (one reply per call, in
// order) and records every call; txt2img returns flat images.
const PUTER = `window.__chatCalls=[];window.__chatScript=[];
window.puter={env:"app",auth:{isSignedIn:()=>true},ai:{
chat:async(messages,test,options)=>{window.__chatCalls.push({messages:JSON.parse(JSON.stringify(messages)),options:JSON.parse(JSON.stringify({...options,signal:undefined}))});const r=window.__chatScript.shift();return r??{message:{role:"assistant",content:"Nothing more to do."}};},
txt2img:async(prompt,opts)=>{const c=document.createElement('canvas');c.width=128;c.height=96;const g=c.getContext('2d');g.fillStyle='#d03030';g.fillRect(0,0,128,96);return {src:c.toDataURL()};}}};`;

type Call = { name: string; args: unknown };
/** Queue model replies: each is text and/or tool calls. */
async function script(page: Page, ...replies: { text?: string; calls?: Call[] }[]) {
  await page.evaluate((replies) => {
    const w = window as unknown as { __chatScript: unknown[] };
    w.__chatScript.push(
      ...replies.map((r, i) => ({
        message: { role: 'assistant', content: r.text ?? '', tool_calls: (r.calls ?? []).map((c, k) => ({ id: `call_${i}_${k}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
      })),
    );
  }, replies);
}
const chatCalls = (page: Page) => page.evaluate(() => (window as unknown as { __chatCalls: { messages: { role: string; content: unknown; tool_call_id?: string }[]; options: { model?: string; tools?: { function: { name: string } }[] } }[] }).__chatCalls);

async function openAssistant(page: Page) {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click();
  await page.locator('.menubar-entry.open .menu-item[data-command="window.panel.assistant"]').click();
  await expect(page.locator('.assistant-panel .ast-input')).toBeVisible();
}
async function send(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: 'Describe an edit or ask a question' });
  await input.fill(text);
  await input.press('Enter');
}

test('a described edit becomes a checked plan that runs as one undo step', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 200, 150, '#808080', 'photo.png');
  await openAssistant(page);
  await expect(page.locator('.ast-intro')).toBeVisible();
  await script(
    page,
    { calls: [{ name: 'search_catalog', args: { query: 'crop' } }] },
    {
      text: 'Here is a plan.',
      calls: [
        {
          name: 'propose_plan',
          args: {
            title: 'Brighter, 16:9',
            summary: 'Brightens the photo with an adjustment layer and crops it to 16:9.',
            steps: [
              { action: 'op.crop', args: { aspect: '16:9' }, note: 'Wide frame' },
              { action: 'op.add_adjustment_layer', args: { kind: 'brightness-contrast', params: { brightness: '40', contrast: 500 } } },
            ],
          },
        },
      ],
    },
  );
  const before = (await historyLabels(page)).length;
  await send(page, 'brighten it and crop to 16:9');
  const plan = page.locator('.ast-plan');
  await expect(plan).toBeVisible();
  await expect(plan.locator('.ast-plan-title')).toHaveText('Brighter, 16:9');
  await expect(plan.locator('.ast-step')).toHaveCount(2);
  await expect(plan.locator('.ast-step').nth(0)).toContainText('To 16:9, centered');
  // Coerced and clamped settings, with a note about the clamp.
  await expect(plan.locator('.ast-step').nth(1)).toContainText('brightness 40, contrast 100');
  await expect(plan.locator('.ast-step').nth(1)).toContainText('above the maximum');
  // The model saw the document, the tools and (by default) a preview image; the search ran.
  const calls = await chatCalls(page);
  expect(calls).toHaveLength(2);
  expect(calls[0].options.model).toBe('claude-fable-5-1');
  expect(calls[0].options.tools!.map((t) => t.function.name)).toEqual(['search_catalog', 'get_details', 'propose_plan', 'answer']);
  const user = calls[0].messages.find((m) => m.role === 'user')!;
  expect(JSON.stringify(user.content)).toContain('200 × 150 px');
  expect(JSON.stringify(user.content)).toContain('image_url');
  const toolResult = calls[1].messages.find((m) => m.role === 'tool')!;
  expect(String(toolResult.content)).toContain('image.crop | Crop | Image');
  // Nothing changed before Run.
  expect((await historyLabels(page)).length).toBe(before);
  await plan.getByRole('button', { name: 'Run All' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Done: 2 steps applied as one undo step.');
  await idle(page);
  const after = await page.evaluate(() => ({ w: window.photoStudio.doc.width, h: window.photoStudio.doc.height, layers: window.photoStudio.doc.layers.map((l) => l.kind), adj: window.photoStudio.doc.layers.at(-1)?.adjustment }));
  expect(after).toMatchObject({ w: 200, h: 113, layers: ['pixel', 'adjustment'] });
  expect(after.adj).toMatchObject({ kind: 'brightness-contrast', params: { brightness: 40, contrast: 100 } });
  const labels = await historyLabels(page);
  expect(labels.length).toBe(before + 1);
  expect(labels.at(-1)).toBe('Assistant: brighten it and crop to 16:9');
  await undo(page);
  expect(await page.evaluate(() => [window.photoStudio.doc.height, window.photoStudio.doc.layers.length])).toEqual([150, 1]);
  // The next request carries the plan and its outcome as conversation history.
  await script(page, { text: 'You are welcome.' });
  await send(page, 'thanks');
  await expect(page.locator('.ast-bot').last()).toContainText('You are welcome.');
  const last = (await chatCalls(page)).at(-1)!;
  expect(JSON.stringify(last.messages)).toContain('Outcome: Done: 2 steps applied');
});

test('a long plan scrolls its steps while the run controls stay in view', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 200, 150, '#808080', 'photo.png');
  await openAssistant(page);
  const steps = Array.from({ length: 24 }, (_, i) => ({
    action: 'op.add_text',
    args: { text: `Line ${i + 1}`, size: 20, color: 'white' },
  }));
  await script(page, { calls: [{ name: 'propose_plan', args: { title: 'Long plan', steps } }] });
  await send(page, 'add a lot of text');
  const plan = page.locator('.ast-plan');
  await expect(plan.locator('.ast-step')).toHaveCount(24);
  const metrics = await plan.evaluate((el) => {
    const stepsEl = el.querySelector<HTMLElement>('.ast-steps')!;
    const foot = el.querySelector<HTMLElement>('.ast-plan-foot')!;
    const log = el.closest<HTMLElement>('.ast-log')!;
    const planBox = el.getBoundingClientRect();
    const stepsBox = stepsEl.getBoundingClientRect();
    const footBox = foot.getBoundingClientRect();
    const logBox = log.getBoundingClientRect();
    return {
      stepsScroll: stepsEl.scrollHeight > stepsEl.clientHeight,
      stepsBottom: stepsBox.bottom,
      footTop: footBox.top,
      footBottom: footBox.bottom,
      planTop: planBox.top,
      planBottom: planBox.bottom,
      logTop: logBox.top,
      logBottom: logBox.bottom,
    };
  });
  expect(metrics.stepsScroll, 'only the steps scroll').toBe(true);
  expect(metrics.footTop).toBeGreaterThanOrEqual(metrics.stepsBottom - 1);
  expect(metrics.footTop).toBeGreaterThanOrEqual(metrics.planTop);
  expect(metrics.footBottom).toBeLessThanOrEqual(metrics.planBottom + 1);
  expect(metrics.planTop).toBeGreaterThanOrEqual(metrics.logTop - 1);
  expect(metrics.footBottom, 'the footer is inside the visible log').toBeLessThanOrEqual(metrics.logBottom + 1);
  // The steps move under a fixed header and footer.
  await plan.locator('.ast-steps').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(plan.locator('.ast-step').last()).toBeInViewport();
  await expect(plan.getByRole('button', { name: 'Run All' })).toBeInViewport();
});

test('plans are validated, edited, run step by step and stopped', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 160, 120, '#406080', 'photo.png');
  await openAssistant(page);
  await script(page, {
    calls: [
      {
        name: 'propose_plan',
        args: {
          title: 'Test plan',
          steps: [
            { action: 'image.crop' },
            { action: 'filter.apply.not-a-filter' },
            { action: 'filter.apply.gaussian-blur', args: { radius: 'four' } },
            { action: 'op.set_layer', args: { opacity: 50 } },
            { action: 'op.add_text', args: { text: 'Hello', size: 20, color: 'white' } },
            { action: 'op.add_fill_layer', args: { color: '#ff8800', opacity: 30, blendMode: 'Soft Light' } },
          ],
        },
      },
    ],
  });
  await send(page, 'do things');
  const plan = page.locator('.ast-plan');
  const steps = plan.locator('.ast-step');
  // Each step names a different command, and the plan only renders after the
  // Assistant has loaded every command's settings. A dev server transforms
  // those modules one at a time, so the first plan can take longer than the
  // default assertion budget; a production build ships them pre-bundled.
  await expect(steps).toHaveCount(6, { timeout: 90_000 });
  await expect(steps.nth(0)).toContainText('needs a selection, and there is none at this point');
  await expect(steps.nth(1)).toContainText('There is no command “filter.apply.not-a-filter”');
  await expect(steps.nth(2)).toContainText('must be a number');
  await expect(plan.getByRole('button', { name: 'Run All' })).toBeDisabled();
  // Remove two bad steps from the keyboard and fix the third in its settings form.
  await steps.nth(0).getByRole('button', { name: 'Remove step 1' }).press('Enter');
  await steps.nth(0).getByRole('button', { name: 'Remove step 1' }).press('Enter');
  await expect(steps).toHaveCount(4);
  await steps.nth(0).getByRole('button', { name: 'Edit' }).click();
  const radius = steps.nth(0).getByRole('spinbutton', { name: /Radius/ });
  await radius.fill('2.5');
  await steps.nth(0).getByRole('button', { name: 'Apply' }).click();
  await expect(steps.nth(0)).toContainText('Radius 2.5');
  await expect(plan.getByRole('button', { name: 'Run All' })).toBeEnabled();
  // Step by step: the first step runs, then the rest is stopped.
  const before = (await historyLabels(page)).length;
  await plan.getByRole('button', { name: 'Step', exact: true }).click();
  await expect(plan.getByRole('button', { name: 'Next Step' })).toBeVisible();
  await expect(steps.nth(0)).toHaveClass(/status-done/);
  await plan.getByRole('button', { name: 'Next Step' }).click();
  await expect(steps.nth(1)).toHaveClass(/status-done/);
  await plan.getByRole('button', { name: 'Stop' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Stopped after 2 of 4 steps.');
  await expect(steps.nth(2)).toHaveClass(/status-skipped/);
  const labels = await historyLabels(page);
  expect(labels.length).toBe(before + 1);
  expect(labels.at(-1)).toBe('Assistant: do things');
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].opacity)).toBe(0.5);
  // A new plan with the remaining edits runs all at once; text and fill layers appear.
  await script(page, { calls: [{ name: 'propose_plan', args: { title: 'Text', steps: [{ action: 'op.add_text', args: { text: 'Hello', size: 20, color: 'white' } }, { action: 'op.add_fill_layer', args: { color: '#ff8800', opacity: 30, blendMode: 'Soft Light' } }] } }] });
  await send(page, 'add the text');
  const second = page.locator('.ast-plan').last();
  await second.getByRole('button', { name: 'Run All' }).click();
  await expect(second.locator('.ast-outcome')).toContainText('Done');
  const layers = await page.evaluate(() => window.photoStudio.doc.layers.map((l) => [l.kind, l.blend, Math.round(l.opacity * 100)]));
  expect(layers).toEqual([['pixel', 'normal', 50], ['text', 'normal', 100], ['solid', 'soft light', 30]]);
  expect((await historyLabels(page)).length).toBe(before + 2);
});

test('answers point at commands, tools and panels with Show me', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 120, 90, '#808080', 'photo.png');
  await openAssistant(page);
  await script(page, {
    calls: [{ name: 'answer', args: { text: 'Use **Image > Image Rotation > 90° Clockwise**, or the ruler to straighten.', pointers: ['image.rotate-cw', 'tool.ruler', 'panel.history', 'nonsense'] } }],
  });
  await send(page, 'how do I rotate a photo?');
  const answer = page.locator('.ast-bot').last();
  await expect(answer.locator('strong').first()).toHaveText('Image > Image Rotation > 90° Clockwise');
  await expect(answer.locator('.ast-pointers li')).toHaveCount(3);
  await answer.getByRole('button', { name: /Show me 90° Clockwise/ }).click();
  const item = page.locator('.menubar-entry.open .menu-item[data-command="image.rotate-cw"]');
  await expect(item).toBeVisible();
  await expect(item).toHaveClass(/menu-reveal/);
  await expect(item).toBeFocused();
  await page.keyboard.press('Escape');
  await answer.getByRole('button', { name: /Show me Ruler/ }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('ruler');
  // The model never ran a command: nothing changed.
  expect(await historyLabels(page)).not.toContain('Assistant');
});

test('the start screen hands a described edit to the Assistant', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await script(page, { calls: [{ name: 'propose_plan', args: { title: 'Square', steps: [{ action: 'op.crop', args: { aspect: '1:1' } }] } }] });
  const box = page.getByRole('region', { name: 'Describe an edit' });
  await expect(box).toBeVisible();
  // It says what is sent, image preview included, as the panel does.
  await expect(box.locator('.start-describe-note')).toContainText('Sends your request, the document’s size and layer list and a small preview to Puter’s AI service');
  await box.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('#status')).toHaveText('Describe the edit first.');
  await box.getByRole('textbox', { name: 'Describe an edit' }).fill('crop it to a square');
  await box.getByRole('textbox', { name: 'Describe an edit' }).press('Enter');
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(true);
  const plan = page.locator('.assistant-panel .ast-plan');
  await expect(plan).toBeVisible();
  await expect(page.locator('.assistant-panel .ast-user')).toContainText('crop it to a square');
  await plan.getByRole('button', { name: 'Run All' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Done');
  const d = await page.evaluate(() => [window.photoStudio.doc.width, window.photoStudio.doc.height]);
  expect(d[0]).toBe(d[1]);
});

test('AI results are recorded in Generation History and placed again', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 200, 150, '#808080', 'photo.png');
  await page.evaluate(async () => {
    const { generationStore } = await import('/src/features/generations/record.ts');
    await generationStore().clear();
  });
  // An Assistant plan opens Generate Image prefilled; nothing is generated until Generate.
  await openAssistant(page);
  await script(page, { calls: [{ name: 'propose_plan', args: { title: 'A kite', summary: 'Generates a kite (uses AI credits).', steps: [{ action: 'edit.generate-image', args: { prompt: 'a red kite', style: 'Watercolor', count: 1 } }] } }] });
  await send(page, 'add a red kite');
  const plan = page.locator('.ast-plan');
  await expect(plan.locator('.ast-tag.ai')).toHaveText('AI credits');
  await expect(plan.locator('.ast-ai-note')).toContainText('Nothing is generated or charged until you press Generate');
  const before = (await historyLabels(page)).length;
  await plan.getByRole('button', { name: 'Run All' }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.locator('#as-prompt')).toHaveValue('a red kite');
  await expect(dialog.locator('#as-style')).toHaveValue('watercolor');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await dialog.getByRole('button', { name: 'Add Layer' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Done');
  const labels = await historyLabels(page);
  expect(labels.length).toBe(before + 1);
  expect(labels.at(-1)).toBe('Assistant: add a red kite');
  // Generate Image from the menu records its variations too.
  await start(page, 'edit.generate-image');
  await expect(dialog.locator('#as-prompt')).toBeVisible();
  await dialog.locator('#as-prompt').fill('blue sky');
  await dialog.locator('#as-count').selectOption('2');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await dialog.getByRole('button', { name: 'Add Layer' }).click();
  await idle(page);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click();
  await page.locator('.menubar-entry.open .menu-item[data-command="window.panel.generations"]').click();
  const panel = page.locator('.generations-panel');
  await expect(panel.locator('.gen-row')).toHaveCount(3);
  await expect(panel.locator('.gen-row').first()).toContainText('blue sky');
  await expect(panel.locator('.gen-row').last()).toContainText('a red kite');
  await expect(panel.locator('.gen-row').last()).toContainText('Assistant');
  // Filter by kind and search prompts.
  await panel.getByRole('combobox', { name: 'Show results of' }).selectOption('assistant');
  await expect(panel.locator('.gen-row')).toHaveCount(1);
  await panel.getByRole('combobox', { name: 'Show results of' }).selectOption('all');
  await panel.getByRole('searchbox', { name: 'Search prompts' }).fill('kite');
  await expect(panel.locator('.gen-row')).toHaveCount(1);
  // Place it again as a new layer.
  const count = await page.evaluate(() => window.photoStudio.doc.layers.length);
  await panel.getByRole('button', { name: 'Place as a new layer: a red kite' }).last().click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(count + 1);
  const placed = await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!);
  expect(placed.generated).toMatchObject({ kind: 'generate', prompt: 'a red kite', style: 'watercolor' });
  expect((await historyLabels(page)).at(-1)).toBe('Place Generated Image');
  // Reuse settings opens the dialog prefilled.
  await panel.getByRole('button', { name: 'Reuse settings: a red kite' }).click();
  await expect(dialog.locator('#as-prompt')).toHaveValue('a red kite');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // Delete removes the entry.
  await panel.getByRole('button', { name: 'Delete: a red kite' }).click();
  await expect(panel.locator('.gen-row')).toHaveCount(0);
});

test('AI Fill run by a plan is recorded as an AI result in provenance', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 160, 120, '#808080', 'photo.png');
  await page.evaluate(() => {
    window.photoStudio.preferences.provenancePrompts = true;
  });
  await openAssistant(page);
  await script(page, { calls: [{ name: 'propose_plan', args: { title: 'Bench', steps: [{ action: 'op.select', args: { x: 20, y: 20, width: 60, height: 40 } }, { action: 'edit.ai-fill', args: { prompt: 'a wooden bench' } }] } }] });
  await send(page, 'put a bench here');
  const plan = page.locator('.ast-plan');
  await plan.getByRole('button', { name: 'Run All' }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.locator('#ai-prompt')).toHaveValue('a wooden bench');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Done');
  const layer = await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!);
  expect(layer.generated).toEqual({ kind: 'fill', prompt: 'a wooden bench' });
  const ai = await page.evaluate(async () => {
    const { recordOf } = await import('/src/features/provenance/recorder.ts');
    return recordOf(window.photoStudio.session).ai;
  });
  expect(ai).toHaveLength(1);
  expect(ai[0]).toMatchObject({ command: 'edit.ai-fill', kind: 'fill', prompt: 'a wooden bench' });
});

test('Generation History places a Generate Image result as the dialog fitted it', async ({ page }) => {
  await boot(page, 'default', PUTER);
  // The stub returns 128 × 96 images; this canvas is wider, so fitting leaves margins.
  await openImage(page, 200, 100, '#808080', 'wide.png');
  await page.evaluate(async () => {
    const { generationStore } = await import('/src/features/generations/record.ts');
    await generationStore().clear();
  });
  await start(page, 'edit.generate-image');
  const dialog = page.locator('dialog[open]');
  await dialog.locator('#as-prompt').fill('a lighthouse');
  await dialog.locator('#as-count').selectOption('1');
  await dialog.locator('#as-fit').selectOption('fit');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await dialog.getByRole('button', { name: 'Add Layer' }).click();
  await idle(page);
  const alpha = (index: number) =>
    page.evaluate(async (index) => {
      const { readRGBA } = await import('/src/model/tiles.ts');
      const e = window.photoStudio;
      const l = e.doc.layers.at(index)!;
      const at = (x: number, y: number) => readRGBA(e.assets.tiles, l.pixels!, { x, y, width: 1, height: 1 }).data[3];
      return [at(4, 50), at(100, 50), at(195, 50)];
    }, index);
  expect(await alpha(-1)).toEqual([0, 255, 0]);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click();
  await page.locator('.menubar-entry.open .menu-item[data-command="window.panel.generations"]').click();
  const panel = page.locator('.generations-panel');
  await panel.getByRole('button', { name: 'Place as a new layer: a lighthouse' }).first().click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(3);
  await idle(page);
  expect(await alpha(-1)).toEqual([0, 255, 0]);
});

test('a staged native artwork plan pauses between stages and builds real layers', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openAssistant(page);
  await script(page, {
    calls: [
      {
        name: 'propose_plan',
        args: {
          title: 'Bottle at dusk',
          summary: 'Paints a small study with the shape, pen, gradient, brush and adjustment engines.',
          stages: [
            { title: 'Canvas', narration: 'Start a 300 ppi canvas and lay in the night sky.' },
            { title: 'Bottle', narration: 'Draw the glass silhouette and the moon.' },
            { title: 'Light', narration: 'Add mist and a gentle curve.' },
          ],
          steps: [
            { action: 'op.new_document', args: { width: 600, height: 800, resolution: 300, background: '#0b1a17', name: 'Bottle at dusk' }, stage: 'Canvas', note: '300 ppi RGB canvas' },
            {
              action: 'op.add_gradient_layer',
              args: { name: 'Night sky', gradient: { stops: [[0, '#06131f'], [55, '#17494b'], [100, '#7e9c79']], style: 'linear', angle: 90 } },
              stage: 'Canvas',
              note: 'The sky and the ground glow',
            },
            {
              action: 'op.add_path',
              args: {
                name: 'Glass bottle',
                points: [[300, 120], [238, 180], [226, 330], [252, 620], [348, 620], [374, 330], [362, 180]],
                closed: true,
                gradient: { stops: [[0, '#9fe0d5'], [48, '#2f7776'], [100, '#0b3038']], style: 'linear', angle: 80 },
                stroke: '#9fe0d5',
                strokeWidth: 3,
              },
              stage: 'Bottle',
              note: 'Pen path with a glass gradient',
            },
            { action: 'op.add_shape', args: { kind: 'ellipse', x: 420, y: 110, width: 90, height: 90, fill: '#ffe6a8', opacity: 85, name: 'Moon' }, stage: 'Bottle', note: 'A warm moon' },
            {
              action: 'op.paint',
              args: { name: 'Mist', paths: [[[120, 520], [250, 500], [380, 520], [500, 490]], [[150, 570], [300, 545], [470, 575]]], color: '#d8fff1', size: 80, hardness: 0, opacity: 22, flow: 18, scatter: 0.6, count: 5, seed: 41 },
              stage: 'Light',
              note: 'Soft fog across the glass',
            },
            { action: 'op.add_adjustment_layer', args: { kind: 'curves', params: { rgb: { points: [[0, 0], [128, 142], [255, 255]] } } }, stage: 'Light', note: 'Lift the midtones' },
          ],
        },
      },
    ],
  });
  await send(page, 'paint a small bottle study');
  const plan = page.locator('.ast-plan');
  await expect(plan.locator('.ast-stage')).toHaveCount(3);
  await expect(plan.locator('.ast-stage').first()).toContainText('Canvas');
  await expect(plan.locator('.ast-stage').first()).toContainText('300 ppi canvas');
  await expect(plan.getByRole('button', { name: 'Run by Stage' })).toBeVisible();
  await plan.getByRole('button', { name: 'Run by Stage' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Paused before the “Bottle” stage');
  await expect(plan.locator('.ast-step').nth(0)).toHaveClass(/status-done/);
  await expect(plan.locator('.ast-step').nth(2)).toHaveClass(/status-pending/);
  await plan.getByRole('button', { name: 'Next Stage' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Paused before the “Light” stage');
  await plan.getByRole('button', { name: 'Run the Rest' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Done: 6 steps applied');
  await idle(page);
  const state = await page.evaluate(() => {
    const e = window.photoStudio;
    const layers = e.doc.layers.map((l) => ({ name: l.name, kind: l.kind, blend: l.blend, opacity: l.opacity, vector: l.vector?.fill?.type, stops: l.vector?.fill?.colorStops?.length, adjustment: l.adjustment?.kind }));
    const paint = e.doc.layers.find((l) => l.name === 'Mist');
    return { width: e.doc.width, height: e.doc.height, ppi: e.doc.resolution?.horizontalResolution, layers, paint: !!paint?.pixels };
  });
  expect(state.width).toBe(600);
  expect(state.height).toBe(800);
  expect(state.ppi).toBe(300);
  expect(state.layers.some((l) => l.name.startsWith('Glass bottle') && l.kind === 'vector' && l.vector === 'solid' && l.stops === 2)).toBe(true);
  expect(state.layers.some((l) => l.name.startsWith('Moon') && l.kind === 'vector')).toBe(true);
  expect(state.layers.some((l) => l.name === 'Mist' && l.kind === 'pixel')).toBe(true);
  expect(state.layers.some((l) => l.kind === 'adjustment' && l.adjustment === 'curves')).toBe(true);
  const labels = await historyLabels(page);
  expect(labels.at(-1)).toBe('Assistant: paint a small bottle study');
  const alpha = await page.evaluate(async () => {
    const e = window.photoStudio;
    const l = e.doc.layers.find((x) => x.name === 'Mist');
    if (!l?.pixels) return -1;
    const { readRGBA } = await import('/src/model/tiles.ts');
    return readRGBA(e.assets.tiles, l.pixels, { x: 250, y: 520, width: 1, height: 1 }).data[3];
  });
  expect(alpha).toBeGreaterThan(0);
});

test('the assistant downloads the layered project and a flattened PNG directly', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openAssistant(page);
  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await script(page, {
    calls: [
      {
        name: 'propose_plan',
        args: {
          title: 'Poster files',
          steps: [
            { action: 'op.new_document', args: { width: 1200, height: 1600, resolution: 300, background: '#101820', name: 'Forest bottle poster' } },
            { action: 'op.add_gradient_layer', args: { name: 'Sky', gradient: { stops: [[0, '#07131f'], [100, '#4f7462']], angle: 90 } } },
            { action: 'op.add_shape', args: { kind: 'ellipse', x: 1200, y: 500, width: 600, height: 600, fill: '#f4d58d', name: 'Moon' } },
            { action: 'op.download_project' },
            { action: 'op.export', args: { format: 'png', name: 'forest-bottle-poster.png' } },
          ],
        },
      },
    ],
  });
  await send(page, 'make the poster files');
  const plan = page.locator('.ast-plan');
  await plan.getByRole('button', { name: 'Run All' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Done: 5 steps applied', { timeout: 90_000 });
  await expect.poll(() => downloads.length, { timeout: 90_000 }).toBe(2);
  const files = await Promise.all(
    downloads.map(async (d) => ({
      name: d.suggestedFilename(),
      bytes: await readFile((await d.path())!),
    })),
  );
  const photo = files.find((f) => f.name === 'Forest bottle poster.photo');
  const png = files.find((f) => f.name === 'forest-bottle-poster.png');
  expect(photo?.bytes.subarray(0, 8).toString('latin1')).toBe('PHOTO001');
  expect(png?.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png?.bytes.readUInt32BE(16)).toBe(1200);
  expect(png?.bytes.readUInt32BE(20)).toBe(1600);
  const doc = await page.evaluate(() => [window.photoStudio.doc.width, window.photoStudio.doc.height, window.photoStudio.doc.resolution?.horizontalResolution]);
  expect(doc).toEqual([1200, 1600, 300]);
});

test('the assistant groups, masks, clips and makes a Smart Object', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openAssistant(page);
  await script(page, {
    calls: [
      {
        name: 'propose_plan',
        args: {
          title: 'Smart assembly',
          steps: [
            { action: 'op.new_document', args: { width: 320, height: 320, resolution: 72, background: 'white', name: 'Assembly' } },
            { action: 'op.add_shape', args: { kind: 'rect', x: 30, y: 30, width: 120, height: 120, fill: '#c34a3a', name: 'Card' } },
            { action: 'op.add_shape', args: { kind: 'ellipse', x: 150, y: 150, width: 100, height: 100, fill: '#3a8f72', name: 'Seal' } },
            { action: 'op.group_layers', args: { layers: 'Card, Seal', name: 'Card and Seal' } },
            { action: 'op.smart_object', args: { layers: 'Card and Seal' } },
            { action: 'op.select', args: { x: 165, y: 165, width: 40, height: 40 } },
            { action: 'layer.mask-reveal-selection' },
            { action: 'op.add_shape', args: { kind: 'rect', x: 0, y: 0, width: 320, height: 320, fill: '#1c2b33', opacity: 30, name: 'Tint' } },
            { action: 'layer.clipping-mask' },
          ],
        },
      },
    ],
  });
  await send(page, 'assemble the smart object');
  const plan = page.locator('.ast-plan');
  await plan.getByRole('button', { name: 'Run All' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Done: 9 steps applied', { timeout: 90_000 });
  await idle(page);
  const state = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { hasMask } = await import('/src/model/masks.ts');
    const smart = e.doc.layers.find((l) => l.kind === 'image');
    const tint = e.doc.layers.find((l) => l.name === 'Tint');
    return {
      names: e.doc.layers.map((l) => l.name),
      kinds: e.doc.layers.map((l) => l.kind),
      hasGroup: e.doc.layers.some((l) => l.kind === 'group'),
      smart: smart ? { kind: smart.kind, masked: hasMask(smart) || !!smart.maskGrid, embedded: !!smart.embed } : null,
      tint: tint ? { clipped: !!tint.clipped, fill: tint.kind } : null,
    };
  });
  expect(state.hasGroup).toBe(false);
  expect(state.smart).toMatchObject({ kind: 'image', masked: true, embedded: true });
  expect(state.tint).toMatchObject({ clipped: true, fill: 'vector' });
});

test('Generation History shows a result as soon as it is stored', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 120, 90, '#808080', 'photo.png');
  await page.evaluate(async () => {
    const { generationStore } = await import('/src/features/generations/record.ts');
    await generationStore().clear();
  });
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click();
  await page.locator('.menubar-entry.open .menu-item[data-command="window.panel.generations"]').click();
  const panel = page.locator('.generations-panel');
  await expect(panel.locator('.gen-empty')).toContainText('No AI results yet');
  // Stored without any other change to the workspace (as when a dialog records after closing).
  await page.evaluate(async () => {
    const { recordGeneration } = await import('/src/features/generations/record.ts');
    await recordGeneration(window.photoStudio, { kind: 'generate', prompt: 'stored later' }, { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) });
  });
  await expect(panel.locator('.gen-row')).toHaveCount(1);
  await expect(panel.locator('.gen-row')).toContainText('stored later');
});
