import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';
import { ToolError, TOOLS, toolSchemas, execTool, systemPrompt } from '../src/ai/tools.js';
import { ENTITY_TYPES } from '../src/core/schema.js';

// The app keeps doc.index in sync with every drawing change; in tests we rebuild on demand.
const ctx = (d) => ({ app: null, editor: null, drawing: d, doc: { name: 'test.cad', get index() { return new SpatialIndex(d); } } });

describe('AI tools', () => {
  it('exposes the tool set for the chat request', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(['drawing_info', 'find_entities', 'add_entities', 'update_entities', 'delete_entities', 'transform_entities', 'set_layer', 'select_entities', 'zoom_to']);
    const schemas = toolSchemas();
    expect(schemas).toHaveLength(TOOLS.length);
    for (const s of schemas) expect(s).toMatchObject({ name: s.name, description: expect.any(String), parameters: expect.any(Object) });
  });

  it('unknown tool names fail with a helpful error', () => {
    const d = new Drawing();
    expect(() => execTool(ctx(d), 'no_such_tool', {})).toThrow(ToolError);
  });

  it('drawing_info summarizes layers, types and selection', () => {
    const d = new Drawing();
    d.transaction('Add', () => {
      d.add({ type: 'circle', cx: 0, cy: 0, r: 10 });
      d.add({ type: 'circle', cx: 30, cy: 0, r: 10 });
      d.add({ type: 'line', x1: 0, y1: 0, x2: 5, y2: 0 });
      d.setTable('layers', 'Walls', { name: 'Walls', color: 3 });
    });
    const info = execTool(ctx(d), 'drawing_info', {});
    expect(info.units).toBe('mm');
    expect(info.currentLayer).toBe('0');
    expect(info.entitiesByType).toEqual({ circle: 2, line: 1 });
    expect(info.totalEntities).toBe(3);
    const walls = info.layers.find((l) => l.name === 'Walls');
    expect(walls).toMatchObject({ color: 3, locked: false });
  });

  it('add_entities validates type, geometry and layers', () => {
    const d = new Drawing();
    const first = () => execTool(ctx(d), 'add_entities', { entities: [{ type: 'tree' }] });
    expect(first).toThrow(/Unknown type/);
    expect(() => execTool(ctx(d), 'add_entities', { entities: [{ type: 'circle', cx: 1, cy: 1 }] })).toThrow(/r/);
    expect(() => execTool(ctx(d), 'add_entities', { entities: [{ type: 'line', x1: 1, y1: 'x' }] })).toThrow(/number/);
    expect(() => execTool(ctx(d), 'add_entities', { entities: [{ type: 'hatch' }] })).toThrow(/polyline/i);
    expect(() => execTool(ctx(d), 'add_entities', { entities: [{ type: 'line', x1: 0, y1: 0, x2: 1, y2: 0, id: 5 }] })).toThrow(/id/);
    expect(() => execTool(ctx(d), 'add_entities', { entities: [{ type: 'line', layer: 'Nope', x1: 0, y1: 0, x2: 1, y2: 0 }] })).toThrow(/Layer "Nope"/);
    expect(() => execTool(ctx(d), 'add_entities', { entities: [] })).toThrow(/entities/);
    expect(d.entities.size).toBe(0);
  });

  it('rejects unknown fields and bad property values anywhere on an entity', () => {
    const d = new Drawing();
    const run = (ent) => execTool(ctx(d), 'add_entities', { entities: [ent] });
    expect(() => run({ type: 'line', x1: 0, y1: 0, x2: 1, y2: 0, colour: 3 })).toThrow(/Unknown field "colour"/);
    expect(() => run({ type: 'line', x1: 0, y1: 0, x2: 1, y2: 0, cx: 4 })).toThrow(/Unknown field "cx" for a line/);
    expect(() => run({ type: 'circle', cx: 0, cy: 0, r: 1, linetype: 'Dashed' })).toThrow(/Linetype "Dashed" is not loaded/);
    expect(() => run({ type: 'circle', cx: 0, cy: 0, r: 1, lineweight: 'heavy' })).toThrow(/lineweight/);
    expect(() => run({ type: 'circle', cx: 0, cy: 0, r: 1, lineweight: Number.NaN })).toThrow(/lineweight/);
    expect(() => run({ type: 'insert', name: 'NOSUCHBLOCK', x: 0, y: 0 })).toThrow(/Block "NOSUCHBLOCK" does not exist/);
    // ByLayer/ByBlock are always valid linetypes; line weights in the accepted ranges pass.
    const ok = run({ type: 'circle', cx: 0, cy: 0, r: 1, linetype: 'ByLayer', lineweight: 25 });
    expect(ok.ok).toBe(true);
    expect(d.get(ok.entities[0].id).lineweight).toBe(25);
  });

  it('polylines take points pairs, in any count, and reject flat lists', () => {
    const d = new Drawing();
    const add = (points) => execTool(ctx(d), 'add_entities', { entities: [{ type: 'polyline', points, closed: true }] });
    // 2 point
    const two = add([[0, 0], [10, 0]]);
    expect(d.get(two.entities[0].id).pts).toEqual([0, 0, 0, 10, 0, 0]);
    // 3 point (an odd pair count that the old % 3 guess misread)
    const three = add([[0, 0], [10, 0], [5, 8]]);
    expect(d.get(three.entities[0].id).pts).toEqual([0, 0, 0, 10, 0, 0, 5, 8, 0]);
    // 4 point
    const four = add([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(d.get(four.entities[0].id).pts).toEqual([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]);
    // 6 point with a bulge on one segment
    const six = add([[0, 0], [10, 0, 0.5], [20, 10], [10, 20], [0, 20], [-10, 10]]);
    expect(d.get(six.entities[0].id).pts).toEqual([0, 0, 0, 10, 0, 0.5, 20, 10, 0, 10, 20, 0, 0, 20, 0, -10, 10, 0]);
    // Flat pointers get a clear error pointing at the pair format.
    expect(() => add([0, 0, 10, 0, 10, 10])).toThrow(/pairs like \[\[x, y\]/);
    expect(() => add([0, 0, 10, 0])).toThrow(/pairs like \[\[x, y\]/);
    expect(() => add([[0, 0, 0, 0]])).toThrow(/\[x, y\] or \[x, y, bulge\]/);
  });

  it('update_entities refuses id and type changes and validates the merged entity', () => {
    const d = new Drawing();
    const drawn = d.transaction('A', () => d.add({ type: 'circle', cx: 0, cy: 0, r: 5, color: 256 }));
    const id = String(drawn.id);
    const run = (fields) => execTool(ctx(d), 'update_entities', { ids: [id], fields });
    // A circle cannot become a line.
    expect(() => run({ type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 })).toThrow(/type/);
    expect(() => run({ id: 99 })).toThrow(/id or type/);
    // Bad patch values: rejected, and the drawing is untouched.
    expect(() => run({ r: 'abc' })).toThrow(/number/);
    expect(() => run({ r: null })).toThrow(/number/);
    expect(() => run({ cx: Number.NaN })).toThrow(/number/);
    expect(() => run({ colour: 3 })).toThrow(/Unknown field "colour"/);
    expect(() => run({ linetype: 'Nonesuch' })).toThrow(/Linetype "Nonesuch"/);
    expect(() => run({ lineweight: 'heavy' })).toThrow(/lineweight/);
    const after = d.get(drawn.id);
    expect(after).toMatchObject({ type: 'circle', cx: 0, cy: 0, r: 5, color: 256 });
    // A valid geometry patch still works.
    const res = run({ cx: 2 });
    expect(res).toMatchObject({ ok: true, changed: 1 });
    expect(d.get(drawn.id).cx).toBe(2);
    // Merged-entity validation: existing geometry plus string fields still rejected.
    expect(() => run({ cy: '0' })).toThrow(/number/);
  });

  it('locked layers block edits and are reported in skipped; add_entities refuses them', () => {
    const d = new Drawing();
    d.transaction('L', () => {
      d.setTable('layers', 'Locked', { name: 'Locked', color: 3, on: true, frozen: false, locked: true });
    });
    const onLocked = d.transaction('A', () => d.add({ type: 'line', layer: 'Locked', x1: 0, y1: 0, x2: 10, y2: 0 }));
    const free = d.transaction('A', () => d.add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }));
    const c = ctx(d);
    expect(d.layerEditable('Locked')).toBe(false);
    // add_entities
    expect(() => execTool(c, 'add_entities', { entities: [{ type: 'line', layer: 'Locked', x1: 0, y1: 0, x2: 1, y2: 0 }] })).toThrow(/locked/i);
    expect(d.entities.size).toBe(2);
    // update_entities
    const upd = execTool(c, 'update_entities', { ids: [String(onLocked.id), String(free.id)], fields: { color: 1 } });
    expect(upd).toMatchObject({ ok: true, skipped: [String(onLocked.id)], changed: 1 });
    // The update was skipped, so the locked line keeps whatever it had (no color of its own).
    expect(d.get(onLocked.id).color).toBeUndefined();
    // delete_entities
    const del = execTool(c, 'delete_entities', { ids: [String(onLocked.id)] });
    expect(del).toMatchObject({ ok: true, erased: 0, skipped: [String(onLocked.id)] });
    expect(d.get(onLocked.id)).toBeTruthy();
    // transform_entities
    const tr = execTool(c, 'transform_entities', { ids: [String(onLocked.id), String(free.id)], dx: 5 });
    expect(tr).toMatchObject({ ok: true, changed: 1, skipped: [String(onLocked.id)] });
    expect(d.get(onLocked.id).x1).toBe(0);
    // Unlocking makes all four work again.
    execTool(c, 'set_layer', { name: 'Locked', locked: false });
    expect(execTool(c, 'delete_entities', { ids: [String(onLocked.id)] }).erased).toBe(1);
  });

  it('rounds to six significant digits, so small values survive', () => {
    const d = new Drawing();
    const res = execTool(ctx(d), 'add_entities', { entities: [{ type: 'circle', cx: 0, cy: 0, r: 0.0004 }, { type: 'line', x1: 1.23456789, y1: 0, x2: 1.234567891234, y2: 0 }] });
    const c = d.get(res.entities[0].id);
    expect(c.r).toBe(0.0004);
    const l = d.get(res.entities[1].id);
    expect(l.x1).toBe(1.23457);
  });

  it('find_entities truncates very long polylines and hatches', () => {
    const d = new Drawing();
    const pts = [];
    for (let i = 0; i < 500; i++) pts.push(i, 0, 0);
    const long = d.transaction('A', () => [
      d.add({ type: 'polyline', pts, closed: false }),
      d.add({ type: 'polyline', pts: [0, 0, 0, 1, 1, 0, 2, 0, 0], closed: false }),
      d.add({ type: 'hatch', loops: [Array.from({ length: 900 }, (_, i) => (i % 3 === 2 ? 0 : i))], pattern: 'SOLID' }),
    ]);
    const res = execTool(ctx(d), 'find_entities', { type: 'polyline' });
    expect(res.count).toBe(2);
    const big = res.entities.find((e) => e.id === long[0].id);
    expect(big.truncated).toBe(true);
    expect(big.pts.length).toBe(600);
    expect(res.entities.find((e) => e.id === long[1].id).truncated).toBeUndefined();
    const h = execTool(ctx(d), 'find_entities', { type: 'hatch' }).entities[0];
    expect(h.truncated).toBe(true);
    expect(h.loops.flat().length).toBeLessThanOrEqual(600);
  });

  it('add_entities validates type, geometry, colors and inserts from blocks', () => {
    const d = new Drawing();
    d.transaction('B', () => d.setBlock('Bolt', { name: 'Bolt', bx: 0, by: 0, entities: [], description: '' }));
    // Linetypes must exist, colors accept numbers or #hex, insert needs a real block.
    expect(() => execTool(ctx(d), 'add_entities', { entities: [{ type: 'circle', cx: 0, cy: 0, r: 1, linetype: 'Nope' }] })).toThrow(/Linetype "Nope"/);
    expect(() => execTool(ctx(d), 'add_entities', { entities: [{ type: 'circle', cx: 0, cy: 0, r: 1, color: 'red' }] })).toThrow(/color/);
    expect(() => execTool(ctx(d), 'add_entities', { entities: [{ type: 'insert', name: 'Nah', x: 0, y: 0 }] })).toThrow(/Block "Nah" does not exist/);
    const ok = execTool(ctx(d), 'add_entities', {
      entities: [{ type: 'insert', name: 'Bolt', x: 5, y: 5 }, { type: 'circle', cx: 0, cy: 0, r: 1, color: '#3e63dd' }],
    });
    expect(d.get(ok.entities[0].id)).toMatchObject({ type: 'insert', name: 'Bolt' });
    expect(d.get(ok.entities[1].id)).toMatchObject({ type: 'circle', color: '#3e63dd' });
  });

  it('add_entities can put things on the current layer and set colors', () => {
    const d = new Drawing();
    d.transaction('Layer', () => d.setHeader({ clayer: '0' }));
    const res = execTool(ctx(d), 'add_entities', { entities: [{ type: 'text', x: 0, y: 0, h: 2.5, value: 'Hi' }] });
    expect(d.get(res.entities[0].id)).toMatchObject({ layer: '0', type: 'text', value: 'Hi' });
    const res2 = execTool(ctx(d), 'add_entities', { entities: [{ type: 'line', layer: '0', color: 3, x1: 0, y1: 0, x2: 1, y2: 0 }] });
    expect(d.get(res2.entities[0].id).color).toBe(3);
  });

  it('find_entities filters by type, layer and window', () => {
    const d = new Drawing();
    const drawn = d.transaction('A', () => [
      d.add({ type: 'circle', cx: 10, cy: 10, r: 5 }),
      d.add({ type: 'line', x1: 100, y1: 100, x2: 200, y2: 200 }),
      d.add({ type: 'circle', cx: 110, cy: 105, r: 4 }),
    ]);
    const circles = execTool(ctx(d), 'find_entities', { type: 'circle' });
    expect(circles.count).toBe(2);
    expect(circles.entities.map((e) => +e.id)).toEqual([drawn[0].id, drawn[2].id]);
    const win = execTool(ctx(d), 'find_entities', { window: { x1: 90, y1: 90, x2: 120, y2: 120, inside: true } });
    expect(win.count).toBe(1);
    const touch = execTool(ctx(d), 'find_entities', { window: { x1: 0, y1: 0, x2: 120, y2: 120 } });
    // Both circles touch the window; the line merely touches it too but isn't inside... it touches: counted.
    expect(touch.count).toBe(3);
    const at = execTool(ctx(d), 'find_entities', { at: { x: 12, y: 12, r: 5 } });
    expect(at.entities[0].id).toBe(drawn[0].id);
    const one = execTool(ctx(d), 'find_entities', { ids: [String(drawn[1].id)] });
    expect(one.entities[0]).toMatchObject({ type: 'line', x1: 100, bounds: [100, 100, 200, 200] });
  });

  it('update_entities patches existing entities and reports missing ones', () => {
    const d = new Drawing();
    const drawn = d.transaction('A', () => d.add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }));
    const res = execTool(ctx(d), 'update_entities', { items: [{ id: String(drawn.id), fields: { x2: 1.0000000001, color: 1 } }] });
    expect(res).toMatchObject({ ok: true, changed: 1 });
    const after = d.get(drawn.id);
    expect(after.x2).toBe(1);
    expect(after.color).toBe(1);
    expect(after.x1).toBe(0);
    const bad = execTool(ctx(d), 'update_entities', { ids: [String(drawn.id), '999'], fields: { color: 2 } });
    expect(bad).toMatchObject({ changed: 1, missing: ['999'] });
    expect(() => execTool(ctx(d), 'update_entities', { ids: [String(drawn.id)], fields: { layer: 'None' } })).toThrow(/does not exist/);
    expect(() => execTool(ctx(d), 'update_entities', {})).toThrow(/items/);
  });

  it('delete_entities erases and reports missing ids', () => {
    const d = new Drawing();
    const drawn = d.transaction('A', () => [d.add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }), d.add({ type: 'line', x1: 0, y1: 10, x2: 10, y2: 10 })]);
    const res = execTool(ctx(d), 'delete_entities', { ids: [String(drawn[0].id), '777'] });
    expect(res).toMatchObject({ ok: true, erased: 1, missing: ['777'] });
    expect(d.entities.size).toBe(1);
  });

  it('transform_entities moves all shapes through their geometry', () => {
    const d = new Drawing();
    const drawn = d.transaction('A', () => [
      d.add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }),
      d.add({ type: 'polyline', pts: [0, 0, 0, 10, 0, 0], closed: true }),
      d.add({ type: 'circle', cx: 5, cy: 5, r: 2 }),
      d.add({ type: 'text', x: 0, y: 20, h: 2.5, value: 'a' }),
      d.add({ type: 'point', x: 50, y: 50 }),
    ]);
    const res = execTool(ctx(d), 'transform_entities', { ids: drawn.map((e) => String(e.id)), dx: 1.9999999999, dy: 0 });
    expect(res).toEqual({ ok: true, changed: 5 });
    expect(d.get(drawn[0].id)).toMatchObject({ x1: 2, x2: 12 });
    expect(d.get(drawn[1].id).pts[0]).toBe(2);
    expect(d.get(drawn[2].id)).toMatchObject({ cx: 7 });
    expect(d.get(drawn[3].id)).toMatchObject({ x: 2 });
    expect(d.get(drawn[4].id)).toMatchObject({ x: 52 });
  });

  it('transform_entities rotates by degrees, mirrors and copies', () => {
    const d = new Drawing();
    const drawn = d.transaction('A', () => [
      d.add({ type: 'line', x1: -10, y1: 0, x2: 10, y2: 0 }),
      d.add({ type: 'circle', cx: 0, cy: 0, r: 2 }),
    ]);
    const ids = drawn.map((e) => String(e.id));
    execTool(ctx(d), 'transform_entities', { ids, rotate_degrees: 90 });
    const l = d.get(drawn[0].id);
    expect(l.y1).toBe(-10);
    expect(l.y2).toBe(10);
    expect(l.x1).toBeCloseTo(0, 9);
    expect(l.x2).toBeCloseTo(0, 9);
    // Radians are not accepted: the parameter is rotate_degrees.
    expect(() => execTool(ctx(d), 'transform_entities', { ids, rotate: 90 })).toThrow(/rotate_degrees/);
    expect(() => execTool(ctx(d), 'transform_entities', { ids: ['vvv'], dx: 1 })).toThrow(ToolError);
    expect(() => execTool(ctx(d), 'transform_entities', { ids })).toThrow(/at least one/);
    // Mirror a fresh horizontal line across the vertical axis x=0 (y axis): x flips, y stays.
    const mir = d.transaction('M', () => d.add({ type: 'line', x1: 2, y1: 0, x2: 5, y2: 0 }));
    const mm = execTool(ctx(d), 'transform_entities', { ids: [String(mir.id)], mirror: { x1: 0, y1: 0, x2: 0, y2: 10 } });
    expect(mm).toMatchObject({ ok: true, changed: 1 });
    const after = d.get(mir.id);
    expect(after.x1).toBe(-2);
    expect(after.x2).toBe(-5);
    expect(after.y1).toBe(0);
    expect(after.y2).toBe(0);
    expect(() => execTool(ctx(d), 'transform_entities', { ids, mirror: { x1: 0, y1: 0, x2: 0, y2: 0 } })).toThrow(/two different points/);
    // copy: true adds transformed copies and keeps the originals.
    const before = d.entities.size;
    const cp = execTool(ctx(d), 'transform_entities', { ids, dx: 30, copy: true });
    expect(cp.ok).toBe(true);
    expect(cp.ids).toHaveLength(2);
    expect(d.entities.size).toBe(before + 2);
    const copyCircle = d.get(cp.ids[1]);
    // The original circle is at cx 0; the copy is 30 units right.
    expect(copyCircle).toMatchObject({ type: 'circle', cx: 30 });
    expect(d.get(drawn[1].id).cx).toBe(0);
  });

  it('set_layer creates layers, changes flags and can make them current', () => {
    const d = new Drawing();
    const res = execTool(ctx(d), 'set_layer', { name: 'Frames', color: 3, locked: true, make_current: true });
    expect(res).toMatchObject({ ok: true, created: true, layer: { name: 'Frames', color: 3, locked: true } });
    expect(d.layers.get('Frames').name).toBe('Frames');
    expect(d.header.clayer).toBe('Frames');
    // Undo the whole thing as one step (both calls in one transaction label).
    expect(d.undo()).toBe('Assistant');
    expect(d.layers.has('Frames')).toBe(false);
    expect(d.header.clayer).toBe('0');
    expect(() => execTool(ctx(d), 'set_layer', { name: '' })).toThrow(ToolError);
    expect(() => execTool(ctx(d), 'set_layer', { name: 'X', color: 999 })).toThrow(/0-256/);
    expect(() => execTool(ctx(d), 'set_layer', { name: 'Y', linetype: 'Nonesuch' })).toThrow(/Linetype "Nonesuch"/);
    expect(() => execTool(ctx(d), 'set_layer', { name: 'Y', lineweight: 'thick' })).toThrow(/lineweight/);
    expect(() => execTool(ctx(d), 'set_layer', { name: 'Y', lineweight: 500 })).toThrow(/0-211/);
    const lw = execTool(ctx(d), 'set_layer', { name: 'Thick', lineweight: 70 });
    expect(lw.layer.lineweight).toBe(70);
  });

  it('the system prompt covers every entity type, units and the radians rule', () => {
    const prompt = systemPrompt({ units: 'mm', totalEntities: 3, layers: [{ name: '0', color: 7 }], entitiesByType: {}, selection: [] }, {});
    expect(prompt).toMatch(/radians/);
    expect(prompt).toMatch(/rotate_degrees/);
    for (const t of ENTITY_TYPES) expect(prompt).toContain(t);
    expect(prompt).toMatch(/points.*\[\[x, y\]/);
    expect(prompt).toMatch(/ByLayer/);
    expect(prompt).toMatch(/hundredths of a millimetre/);
    expect(prompt).toMatch(/drawing units|Coordinates/);
    for (const t of ['line', 'circle', 'arc', 'polyline', 'text', 'dimension']) {
      expect(prompt).toMatch(new RegExp(`${t} example`));
    }
    // The add_entities description carries short examples too.
    const desc = toolSchemas().find((s) => s.name === 'add_entities').description;
    expect(desc).toMatch(/"type":"line"/);
    expect(desc).toMatch(/"type":"circle"/);
    expect(desc).toMatch(/"type":"polyline"/);
    expect(desc).toMatch(/"type":"text"/);
    expect(desc).toMatch(/"type":"dimension"/);
  });

  it('resultForModel returns the whole JSON or a refusal, never a slice', async () => {
    const { resultForModel, MAX_RESULT_CHARS } = await import('../src/ai/tools.js');
    const big = { entities: Array.from({ length: 900 }, (_, i) => ({ id: i, type: 'text', value: 'x'.repeat(50) })) };
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_RESULT_CHARS + 9000);
    const r = JSON.parse(resultForModel(big));
    expect(r).toEqual({ error: 'result too large', hint: 'use limit, a window or a layer filter' });
    const small = { ok: true, ids: [1, 2, 3] };
    expect(JSON.parse(resultForModel(small))).toEqual(small);
  });

  it('merges a whole AI turn into one undo step', () => {
    const d = new Drawing();
    const c = ctx(d);
    const mark = d.undoStack.length;
    // The panel runs several tools per turn; here: layers + adds + update + move.
    execTool(c, 'set_layer', { name: 'A' });
    execTool(c, 'set_layer', { name: 'A', make_current: true });
    const made = execTool(c, 'add_entities', { entities: [{ type: 'circle', cx: 0, cy: 0, r: 5 }, { type: 'circle', cx: 12, cy: 0, r: 5 }] });
    execTool(c, 'update_entities', { ids: made.entities.map((e) => e.id), fields: { color: 1 } });
    execTool(c, 'transform_entities', { ids: made.entities.map((e) => e.id), dy: 3 });
    execTool(c, 'delete_entities', { ids: [made.entities[0].id] });
    d.mergeSince(mark, 'AI: draw two circles');
    expect(d.undoStack).toHaveLength(1);
    expect(d.undo()).toBe('AI: draw two circles');
    expect(d.entities.size).toBe(0);
    expect(d.header.clayer).toBe('0');
  });

  it('editing tools refuse a read-only drawing', () => {
    const d = new Drawing();
    d.readOnly = true;
    for (const [name, args] of [
      ['add_entities', { entities: [{ type: 'point', x: 0, y: 0 }] }],
      ['delete_entities', { ids: ['1'] }],
      ['set_layer', { name: 'A' }],
    ]) {
      expect(() => execTool(ctx(d), name, args)).toThrow(/read-only/);
    }
    // Read-only queries still work.
    expect(execTool(ctx(d), 'drawing_info', {}).totalEntities).toBe(0);
  });
});
