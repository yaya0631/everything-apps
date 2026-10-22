import { describe, it, expect, vi } from 'vitest';
import { Drawing, ReadOnlyError } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';

const line = (x1, y1, x2, y2) => ({ type: 'line', layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1, x1, y1, x2, y2 });

describe('Drawing collab hooks', () => {
  it('hands committed records to opsListener for the live session', () => {
    const d = new Drawing();
    const ops = [];
    d.opsListener = (entries) => ops.push(...entries);
    const e = d.transaction('Add', () => d.add(line(0, 0, 1, 1)));
    d.transaction('Move', () => d.update(e.id, { x2: 9 }));
    expect(ops).toHaveLength(2);
    expect(ops[0].rec).toMatchObject({ kind: 'ent', id: e.id, before: null });
    expect(ops[0].reverse).toBe(false);
    expect(ops[1].rec.kind).toBe('ent');
  });

  it('gives undo/redo ops with reverse flags', () => {
    const d = new Drawing();
    const ops = [];
    d.opsListener = (entries) => ops.push(...entries);
    const e = d.transaction('Add', () => d.add(line(0, 0, 1, 1)));
    ops.length = 0;
    d.undo();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ reverse: true, rec: { kind: 'ent', id: e.id } });
    ops.length = 0;
    d.redo();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ reverse: false, rec: { kind: 'ent', id: e.id } });
  });

  it('applyRemote changes entities without touching the undo stack', () => {
    const d = new Drawing();
    d.applyRemote([{ k: 'ent', id: '77', v: line(1, 2, 3, 4) }]);
    expect(d.get('77')).toMatchObject({ x1: 1, y1: 2, x2: 3, y2: 4 });
    expect(d.undoStack).toHaveLength(0);
    expect(d.redoStack).toHaveLength(0);
    expect(d.entities.size).toBe(1);
  });

  it('applyRemote deletes, edits tables and skips nextId in header patches', () => {
    const d = new Drawing();
    d.applyRemote([{ k: 'ent', id: '77', v: line(1, 2, 3, 4) }]);
    d.applyRemote([
      { k: 'table', table: 'layers', key: 'Walls', v: { name: 'Walls', color: 3 } },
      { k: 'header', patch: { nextId: 999, clayer: 'Walls' } },
    ]);
    expect(d.layers.get('Walls').color).toBe(3);
    expect(d.header.clayer).toBe('Walls');
    expect(d.header.nextId).not.toBe(999);
    const changes = [];
    d.on((c) => changes.push(c));
    d.applyRemote([{ k: 'ent', id: '77', v: null }]);
    expect(d.get('77')).toBeUndefined();
    expect(changes[0].remote).toBe(true);
  });

  it('setOrder adopts the server draw order with ids at the end kept', () => {
    const d = new Drawing();
    const a = d.transaction('Add', () => d.add(line(0, 0, 1, 1)));
    const b = d.transaction('Add', () => d.add(line(0, 0, 2, 2)));
    const stack = d.undoStack.length;
    d.setOrder([b.id, 'ghost', a.id]);
    expect([...d.entities.keys()]).toEqual([b.id, a.id]);
    expect(d.undoStack).toHaveLength(stack); // no undo record
  });

  it('their newer value survives an undo attempt in live mode', () => {
    const d = new Drawing();
    d.live = true;
    const e = d.transaction('Add', () => d.add(line(0, 0, 1, 1)));
    // Someone else moved the same end point while our step was on the stack.
    d.applyRemote([{ k: 'ent', id: e.id, v: { ...d.get(e.id), x2: 99 } }]);
    expect(d.undo()).toBe('Add');
    expect(d.lastSkipped).toBe(true);
    expect(d.get(e.id).x2).toBe(99); // their change is kept
    expect(d.entities.has(e.id)).toBe(true);
  });

  it('reverts an undo step nobody else touched (live)', () => {
    const d = new Drawing();
    d.live = true;
    const e = d.transaction('Add', () => d.add(line(0, 0, 1, 1)));
    expect(d.undo()).toBe('Add');
    expect(d.lastSkipped).toBe(false);
    expect(d.get(e.id)).toBeUndefined();
  });

  it('leases ids from idSource in live mode', () => {
    const d = new Drawing();
    let next = 5001;
    d.idSource = () => ++next;
    const a = d.transaction('Add', () => d.add(line(0, 0, 1, 1)));
    const b = d.transaction('Add', () => d.add(line(0, 0, 2, 2)));
    expect(a.id).toBe(5002);
    expect(b.id).toBe(5003);
    expect(d.header.nextId).toBe(1); // not advanced
  });

  it('readOnly blocks edits and undos', () => {
    const d = new Drawing();
    const e = d.transaction('Add', () => d.add(line(0, 0, 1, 1)));
    d.readOnly = true;
    expect(() => d.transaction('Add', () => d.add(line(2, 2, 3, 3)))).toThrow(ReadOnlyError);
    expect(() => d.undo()).toThrow(ReadOnlyError);
    expect(() => d.redo()).toThrow(ReadOnlyError);
    d.readOnly = false;
    expect(d.undo()).toBe('Add');
    expect(d.get(e.id)).toBeUndefined();
  });
});
