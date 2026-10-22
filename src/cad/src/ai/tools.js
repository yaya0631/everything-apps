/**
 * Tools the AI assistant uses to look at and edit the drawing. Each tool is a
 * JSON-schema'd function; the assistant loop (ui/assistant.js) streams model
 * events and calls execTool() for every tool_call, feeding the result back to
 * the model. Everything runs through the ordinary Drawing transaction machinery,
 * so AI edits undo, sync to live co-editors and hit the spatial index like the
 * commands do.
 *
 * Entity JSON sent by the model follows core/schema.js: angles are radians,
 * polylines take `points: [[x, y], [x, y, bulge], ...]` (converted here to the
 * internal stride-3 pts list), numbers must be numbers, and unknown fields are
 * rejected so typos surface as tool errors instead of silent no-ops.
 */
import { transformEntity, translate, rotate, scale, mirror, multiply, identity, entityBounds } from '../core/geom/index.js';
import { defaultLayer, baseProps, ENTITY_TYPES } from '../core/schema.js';

/** A tool argument or drawing state problem the model can learn from and fix. */
export class ToolError extends Error {}

/** Six significant digits: plenty for reading back, tiny for transport. */
const r6 = (v) => (!Number.isFinite(v) ? v : Number(v.toPrecision(6)));

/** Round every number in a plain-data copy to six significant digits. */
function roundAll(v) {
  if (typeof v === 'number') return r6(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? r6(x) : roundAll(x)));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = roundAll(x);
    return out;
  }
  return v;
}

/** A proper finite number: strings and NaN are rejected, not coerced. */
function num(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`${what} must be a number (got ${JSON.stringify(v) ?? 'undefined'})`);
  return v;
}

function numField(e, key, label) {
  return num(e[key], `${label} field "${key}"`);
}

function optionalNum(e, key, label) {
  if (e[key] != null) numField(e, key, label);
}

/** A flat list of numbers ([x, y, ...]). Nested pairs are refused with a pointer to the right format. */
function ptsFlat(v, name, { minPoints = 2 } = {}) {
  if (!Array.isArray(v)) throw new ToolError(`"${name}" must be an array of numbers.`);
  if (v.some((x) => Array.isArray(x))) throw new ToolError(`"${name}" is a flat list of numbers ([x0, y0, x1, y1, ...]); nested [[x, y], ...] pairs are only used by polyline "points".`);
  const flat = v.map((x) => num(x, name));
  if (flat.length / 2 < minPoints) throw new ToolError(`"${name}" needs at least ${minPoints} points.`);
  return flat;
}

// Entity validation -----------------------------------------------------------------------

const DIM_TYPES = new Set(['linear', 'aligned', 'angular', 'radius', 'diameter', 'ordinate']);

/**
 * Extra (non-common) keys allowed per type, mirroring core/schema.js:
 *   required  keys that must be present (presence only — checked per type below)
 *   num       required keys that must be finite numbers (validated generically)
 * String/geometry fields (value, name, dimType, pts) get their own checks in
 * the type switch, so they are listed only under `required`.
 */
const TYPE_KEYS = {
  line: { keys: ['x1', 'y1', 'x2', 'y2'], required: ['x1', 'y1', 'x2', 'y2'], num: ['x1', 'y1', 'x2', 'y2'] },
  xline: { keys: ['x', 'y', 'dx', 'dy'], required: ['x', 'y', 'dx', 'dy'], num: ['x', 'y', 'dx', 'dy'] },
  ray: { keys: ['x', 'y', 'dx', 'dy'], required: ['x', 'y', 'dx', 'dy'], num: ['x', 'y', 'dx', 'dy'] },
  circle: { keys: ['cx', 'cy', 'r'], required: ['cx', 'cy', 'r'], num: ['cx', 'cy', 'r'] },
  arc: { keys: ['cx', 'cy', 'r', 'start', 'end'], required: ['cx', 'cy', 'r', 'start', 'end'], num: ['cx', 'cy', 'r', 'start', 'end'] },
  ellipse: { keys: ['cx', 'cy', 'mx', 'my', 'ratio', 'start', 'end'], required: ['cx', 'cy', 'mx', 'my', 'ratio'], num: ['cx', 'cy', 'mx', 'my', 'ratio'] },
  polyline: { keys: ['points', 'pts', 'closed', 'width'], required: [], num: [] },
  spline: { keys: ['degree', 'ctrl', 'knots', 'fit', 'closed'], required: [], num: [] },
  point: { keys: ['x', 'y'], required: ['x', 'y'], num: ['x', 'y'] },
  text: { keys: ['x', 'y', 'h', 'rot', 'value', 'style', 'halign', 'valign', 'widthFactor', 'oblique'], required: ['x', 'y', 'h', 'value'], num: ['x', 'y', 'h'] },
  mtext: { keys: ['x', 'y', 'h', 'rot', 'value', 'style', 'width', 'attach', 'lineSpacing'], required: ['x', 'y', 'h', 'value'], num: ['x', 'y', 'h'] },
  dimension: { keys: ['dimType', 'x1', 'y1', 'x2', 'y2', 'x3', 'y3', 'x4', 'y4', 'lx', 'ly', 'rot', 'text', 'style', 'ordAxis'], required: ['dimType', 'lx', 'ly'], num: ['lx', 'ly'] },
  leader: { keys: ['pts', 'text', 'h', 'style'], required: ['pts'], num: [] },
  hatch: { keys: ['loops', 'pattern', 'scale', 'angle'], required: [], num: [] },
  insert: { keys: ['name', 'x', 'y', 'sx', 'sy', 'rot'], required: ['name', 'x', 'y'], num: ['x', 'y'] },
};

const COMMON_KEYS = ['id', 'type', 'layer', 'color', 'linetype', 'lineweight', 'ltscale'];
const ALLOWED_KEYS = new Map(ENTITY_TYPES.map((t) => [t, [...COMMON_KEYS, ...TYPE_KEYS[t].keys]]));

/**
 * Check one entity from the model (add_entities) or one merged from an
 * existing entity plus a patch (update_entities). Returns a normalized,
 * rounded copy. The options:
 *   allowId  keep an existing id through validation (update path)
 *   create   true when the entity is brand new; hatch geometry cannot be made here
 */
function checkEnt(raw, drawing, { allowId = false, create = true } = {}) {
  if (!raw || typeof raw !== 'object') throw new ToolError('Each entity must be an object.');
  const e = { ...raw };
  if (!ENTITY_TYPES.includes(e.type)) throw new ToolError(`Unknown type "${e.type}". Use one of: ${ENTITY_TYPES.join(', ')}.`);
  if ('id' in e && !allowId) throw new ToolError('Do not send id; the drawing assigns one.');
  if (allowId && (!Number.isFinite(e.id) || !Number.isInteger(e.id))) throw new ToolError('An entity id must be an integer.');
  const spec = TYPE_KEYS[e.type];
  const bad = Object.keys(e).filter((k) => !ALLOWED_KEYS.get(e.type).includes(k));
  if (bad.length) throw new ToolError(`Unknown field${bad.length > 1 ? 's' : ''} ${bad.map((b) => `"${b}"`).join(', ')} for a ${e.type}. Allowed: ${ALLOWED_KEYS.get(e.type).join(', ')}.`);
  for (const k of spec.num) numField(e, k, e.type);
  if (e.layer != null) {
    if (typeof e.layer !== 'string' || !drawing.layers.has(e.layer)) throw new ToolError(`Layer "${e.layer}" does not exist. Create it with set_layer first.`);
  }
  if (e.color != null) {
    const c = e.color;
    const okNum = typeof c === 'number' && Number.isFinite(c) && Number.isInteger(c) && c >= 0 && c <= 256;
    if (!okNum && !(typeof c === 'string' && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(c))) {
      throw new ToolError('color must be a palette number (0 ByBlock, 256 ByLayer, 1-255) or "#rrggbb".');
    }
  }
  if (e.linetype != null) {
    if (typeof e.linetype !== 'string' || (e.linetype !== 'ByLayer' && e.linetype !== 'ByBlock' && !drawing.linetypes.has(e.linetype))) {
      throw new ToolError(`Linetype "${e.linetype}" is not loaded. Use ByLayer, ByBlock, or a name from drawing_info.`);
    }
  }
  if (e.lineweight != null) {
    const lw = e.lineweight;
    const ok = typeof lw === 'number' && Number.isFinite(lw) && ((lw >= -3 && lw <= -1) || (lw >= 0 && lw <= 211));
    if (!ok) throw new ToolError('lineweight must be a number: -3 default, -2 ByBlock, -1 ByLayer, or 0-211 (hundredths of a mm).');
  }
  if (e.ltscale != null) {
    const n = num(e.ltscale, 'ltscale');
    if (n <= 0) throw new ToolError('ltscale must be greater than 0.');
  }
  switch (e.type) {
    case 'circle':
      if (e.r <= 0) throw new ToolError('circle radius must be greater than 0.');
      break;
    case 'arc':
      if (e.r <= 0) throw new ToolError('arc radius must be greater than 0.');
      break;
    case 'ellipse':
      if (e.ratio <= 0 || e.ratio >= 1) throw new ToolError('ellipse ratio must be in (0, 1).');
      break;
    case 'polyline': {
      // The model sends unambiguous pairs: points: [[x, y], [x, y, bulge], ...].
      if (e.points != null) {
        if (!Array.isArray(e.points)) throw new ToolError('polyline "points" must be a list like [[x, y], [x, y, bulge], ...].');
        if (!e.points.length) throw new ToolError('polyline needs at least 2 points.');
        if (e.points.some((p) => !Array.isArray(p))) {
          throw new ToolError('polyline.points must be pairs like [[x, y], [x, y, bulge], ...] — not a flat list of numbers.');
        }
        const flat = [];
        for (const p of e.points) {
          if (p.length < 2 || p.length > 3) throw new ToolError('Each polyline point is [x, y] or [x, y, bulge].');
          flat.push(num(p[0], 'polyline.points'), num(p[1], 'polyline.points'), p.length === 3 ? num(p[2], 'polyline.points') : 0);
        }
        if (flat.length / 3 < 2) throw new ToolError('polyline needs at least 2 points.');
        e.pts = flat;
        delete e.points;
      } else if (Array.isArray(e.pts)) {
        // An internal stride-3 list (update path, from the drawing itself).
        if (e.pts.length % 3 !== 0 || e.pts.length / 3 < 2) throw new ToolError('polyline needs at least 2 points as [[x, y], ...] pairs.');
        e.pts = e.pts.map((v) => num(v, 'polyline.pts'));
      } else {
        throw new ToolError('polyline needs geometry: send "points": [[x, y], [x, y, bulge], ...].');
      }
      e.closed = e.closed != null ? !!e.closed : false;
      optionalNum(e, 'width', 'polyline');
      break;
    }
    case 'spline': {
      const ctrl = e.ctrl != null ? ptsFlat(e.ctrl, 'spline.ctrl') : null;
      const fit = e.fit != null ? ptsFlat(e.fit, 'spline.fit') : null;
      if (!ctrl && !fit) throw new ToolError('spline needs "ctrl" control points or "fit" fit points.');
      optionalNum(e, 'degree', 'spline');
      if (e.closed != null) e.closed = !!e.closed;
      break;
    }
    case 'text':
      if (numField(e, 'h', 'text') <= 0) throw new ToolError('text height must be greater than 0.');
      if (typeof e.value !== 'string') throw new ToolError('text needs a "value" string.');
      if (e.halign != null && !['left', 'center', 'right'].includes(e.halign)) throw new ToolError('text halign is "left", "center" or "right".');
      if (e.valign != null && !['baseline', 'bottom', 'middle', 'top'].includes(e.valign)) throw new ToolError('text valign is "baseline", "bottom", "middle" or "top".');
      break;
    case 'mtext':
      if (numField(e, 'h', 'mtext') <= 0) throw new ToolError('mtext height must be greater than 0.');
      if (typeof e.value !== 'string') throw new ToolError('mtext needs a "value" string.');
      optionalNum(e, 'width', 'mtext');
      if (e.attach != null && !/^[tbm][lcr]$/.test(String(e.attach))) throw new ToolError('mtext attach must be like "tl" (first letter vertical, second horizontal).');
      break;
    case 'dimension': {
      if (!DIM_TYPES.has(e.dimType)) throw new ToolError(`dimension "dimType" must be one of: ${[...DIM_TYPES].join(', ')}.`);
      if (e.dimType !== 'ordinate') for (const k of ['x1', 'y1', 'x2', 'y2']) numField(e, k, 'dimension');
      if (e.dimType === 'angular') for (const k of ['x3', 'y3', 'x4', 'y4']) numField(e, k, 'dimension');
      if (e.dimType === 'ordinate' && e.ordAxis === undefined) e.ordAxis = 'x';
      for (const k of ['lx', 'ly']) numField(e, k, 'dimension');
      if (e.text != null && typeof e.text !== 'string') throw new ToolError('dimension "text" must be a string; "<>" is replaced by the measured value.');
      if (e.ordAxis != null && !['x', 'y'].includes(e.ordAxis)) throw new ToolError('dimension ordAxis is "x" or "y".');
      break;
    }
    case 'leader':
      e.pts = ptsFlat(e.pts, 'leader.pts');
      if (e.text != null && typeof e.text !== 'string') throw new ToolError('leader "text" must be a string.');
      optionalNum(e, 'h', 'leader');
      break;
    case 'insert':
      if (typeof e.name !== 'string' || !e.name) throw new ToolError('insert needs a block "name".');
      if (!drawing.blocks.has(e.name)) throw new ToolError(`Block "${e.name}" does not exist. Only blocks already in the drawing can be inserted.`);
      optionalNum(e, 'sx', 'insert');
      optionalNum(e, 'sy', 'insert');
      break;
    case 'hatch': {
      if (create) throw new ToolError('Send hatch geometry as a closed polyline instead; the HATCH command fills boundaries.');
      if (e.loops != null) {
        if (!Array.isArray(e.loops)) throw new ToolError('hatch "loops" must be a list of flat [x, y, bulge, ...] point lists.');
        e.loops = e.loops.map((l, i) => {
          if (!Array.isArray(l)) throw new ToolError(`Hatch loop ${i} must be a flat [x, y, bulge, ...] list.`);
          if (l.length % 3 !== 0 || !l.length) throw new ToolError(`Hatch loop ${i} must be a flat [x, y, bulge, ...] list.`);
          return l.map((v) => num(v, `hatch.loops[${i}]`));
        });
      }
      if (e.pattern != null && typeof e.pattern !== 'string') throw new ToolError('hatch "pattern" must be a string ("SOLID" or a pattern name).');
      optionalNum(e, 'scale', 'hatch');
      optionalNum(e, 'angle', 'hatch');
      break;
    }
  }
  if (e.rotation != null) throw new ToolError('Use "rot" (radians), not "rotation".');
  return roundAll(e);
}

// Shared argument helpers -----------------------------------------------------------------

/** Entity ids are numbers in the drawing tables; the model may send strings. */
const idOf = (raw) => (typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw) : raw);

/** Editing tools refuse a read-only drawing (view-only live session, etc.). */
function guardEditable(ctx) {
  if (ctx.drawing.readOnly) throw new ToolError('This drawing is open read-only (you have view access), so it cannot be edited.');
}

/** Which entity ids does a tool act on: explicit ids, window/point query, or the selection. */
function pickIds(ctx, args) {
  if (Array.isArray(args.ids)) return args.ids.map(idOf);
  if (args.window && typeof args.window === 'object') {
    const { x1, y1, x2, y2, inside = false } = args.window;
    const w = [Math.min(num(x1, 'window.x1'), num(x2, 'window.x2')), Math.min(num(y1, 'window.y1'), num(y2, 'window.y2')), Math.max(num(x1, 'window.x1'), num(x2, 'window.x2')), Math.max(num(y1, 'window.y1'), num(y2, 'window.y2'))];
    return inside ? ctx.doc.index.searchInside(w[0], w[1], w[2], w[3]) : ctx.doc.index.search(w[0], w[1], w[2], w[3]);
  }
  if (args.at && typeof args.at === 'object') {
    const x = num(args.at.x, 'at.x');
    const y = num(args.at.y, 'at.y');
    const r = args.at.r != null ? num(args.at.r, 'at.r') : pickTolerance(ctx);
    return ctx.doc.index.search(x - r, y - r, x + r, y + r);
  }
  const sel = ctx.editor ? [...ctx.editor.selection] : [];
  if (!sel.length) throw new ToolError('No ids given and nothing is selected in the drawing.');
  return sel;
}

/** A pick tolerance in world units that follows the zoom level. */
function pickTolerance(ctx) {
  const cam = ctx.editor?.camera;
  if (!cam?.toWorld) return 1;
  const a = cam.toWorld(0, 0);
  const b = cam.toWorld(10, 0);
  return Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
}

function matches(e, args) {
  if (args.type && (Array.isArray(args.type) ? !args.type.includes(e.type) : args.type !== e.type)) return false;
  if (args.layer && e.layer !== args.layer) return false;
  return true;
}

/** Bounds of an entity from the spatial index (works for text, dims, blocks). */
const boundsOf = (ctx, ent) => {
  try {
    return ctx.doc.index.boundsOf(ent);
  } catch {
    return entityBounds(ent);
  }
};

// Output shaping --------------------------------------------------------------------------

/** Polylines and hatches with more points than this are cut down before reaching the model. */
const MAX_OUT_POINTS = 200;

/** A rounded copy for find_entities; huge point lists are truncated. */
function outEntity(e) {
  const o = roundAll(e);
  if (e.type === 'polyline' && Array.isArray(e.pts) && e.pts.length > MAX_OUT_POINTS * 3) {
    o.pts = e.pts.slice(0, MAX_OUT_POINTS * 3);
    o.truncated = true;
  }
  if (e.type === 'hatch' && Array.isArray(e.loops)) {
    let left = MAX_OUT_POINTS;
    const cut = [];
    let over = false;
    for (const l of e.loops) {
      const n = Math.floor(l.length / 3) || Math.floor(l.length / 2);
      if (left <= 0) {
        over = true;
        break;
      }
      if (n <= left) {
        cut.push(l);
        left -= n;
      } else {
        cut.push(l.slice(0, left * 3));
        left = 0;
        over = true;
      }
    }
    if (over) {
      o.loops = cut;
      o.truncated = true;
    }
  }
  return o;
}

const TOO_LARGE = { error: 'result too large', hint: 'use limit, a window or a layer filter' };
export const MAX_RESULT_CHARS = 20000;

/** Tool results are never sliced: either the whole JSON or a clear refusal. */
export function resultForModel(content) {
  let text;
  try {
    text = JSON.stringify(content);
  } catch {
    text = '{}';
  }
  return text.length > MAX_RESULT_CHARS ? JSON.stringify(TOO_LARGE) : text;
}

// Tools -----------------------------------------------------------------------------------

const MUTATING = ['add_entities', 'update_entities', 'delete_entities', 'transform_entities', 'set_layer'];

const tool = (name, description, parameters, run) => ({ name, description, parameters, run, mutating: MUTATING.includes(name) });

export const TOOLS = [
  tool(
    'drawing_info',
    'Summary of the open drawing: units, current layer, layers with entity counts, entity counts by type and the selection. Call this first to ground yourself.',
    { type: 'object', properties: {} },
    (ctx) => {
      const d = ctx.drawing;
      const perType = {};
      const perLayer = new Map([...d.layers.keys()].map((n) => [n, 0]));
      for (const e of d.entities.values()) {
        perType[e.type] = (perType[e.type] || 0) + 1;
        if (perLayer.has(e.layer)) perLayer.set(e.layer, perLayer.get(e.layer) + 1);
      }
      return {
        name: ctx.doc.name,
        units: d.header.units,
        currentLayer: d.header.clayer,
        textStyle: d.header.textStyle,
        dimStyle: d.header.dimStyle,
        textHeight: r6(d.header.textHeight),
        readOnly: !!d.readOnly,
        layers: [...d.layers.values()].map((l) => ({ name: l.name, color: l.color, linetype: l.linetype, lineweight: l.lineweight, on: !!l.on, frozen: !!l.frozen, locked: !!l.locked, entities: perLayer.get(l.name) || 0 })),
        blocks: [...d.blocks.keys()],
        entitiesByType: perType,
        totalEntities: d.entities.size,
        selection: [...(ctx.editor?.selection ?? [])].slice(0, 200),
      };
    },
  ),

  tool(
    'find_entities',
    'Look up entities by ids, a window or a point, optionally filtered by type/layer. Returns entity data (rounded) and bounds so later calls can update or recreate them. Very long polylines and hatches are truncated, with truncated: true.',
    {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Entity ids to look up.' },
        type: { type: 'string', description: 'Only match this entity type, e.g. "circle".' },
        layer: { type: 'string', description: 'Only match entities on this layer.' },
        window: {
          type: 'object',
          description: 'World-space window.',
          properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, inside: { type: 'boolean', description: 'True: only entities fully inside; false (default): touching.' } },
          required: ['x1', 'y1', 'x2', 'y2'],
        },
        at: { type: 'object', description: 'Point query.', properties: { x: { type: 'number' }, y: { type: 'number' }, r: { type: 'number', description: 'Radius in drawing units; defaults to the pick tolerance at the current zoom.' } }, required: ['x', 'y'] },
        limit: { type: 'integer', description: 'Default 50, maximum 200.' },
      },
    },
    (ctx, args) => {
      const limit = Math.min(Math.max(1, Number(args.limit) || 50), 200);
      const scoped = args.type || args.layer;
      // With a type/layer filter the whole drawing is fair game (scan, capped by limit).
      const ids = Array.isArray(args.ids) || args.window || args.at ? pickIds(ctx, args) : scoped ? [...ctx.drawing.entities.keys()] : ctx.editor ? [...ctx.editor.selection] : [];
      if (!ids.length) throw new ToolError('No ids given and nothing is selected in the drawing. Give "ids", a "window", an "at" point, or a type/layer filter.');
      const out = [];
      for (const id of ids) {
        if (out.length >= limit) break;
        const e = ctx.drawing.get(id);
        if (!e || !matches(e, args)) continue;
        const b = boundsOf(ctx, e);
        out.push({ ...outEntity(e), bounds: b ? b.map(r6) : null });
      }
      return { count: out.length, matched: ids.length, entities: out };
    },
  ),

  tool(
    'add_entities',
    'Create entities. Send complete geometry per entity as "points" pairs for polylines. layer is optional (default: the current layer); color defaults to ByLayer, linetype to ByLayer, lineweight to ByLayer. '
      + 'Examples: line {"type":"line","x1":0,"y1":0,"x2":100,"y2":0} · circle {"type":"circle","cx":50,"cy":50,"r":25} · arc {"type":"arc","cx":0,"cy":0,"r":10,"start":0,"end":1.5708} (radians) · '
      + 'polyline {"type":"polyline","points":[[0,0],[100,0],[100,40]],"closed":false} · text {"type":"text","x":10,"y":10,"h":2.5,"value":"Label"} · '
      + 'dimension {"type":"dimension","dimType":"linear","x1":0,"y1":0,"x2":100,"y2":0,"lx":50,"ly":-12,"rot":0}.',
    {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          description: 'One object per entity with its full geometry. e.g. {"type":"line","x1":0,"y1":0,"x2":100,"y2":0}, {"type":"circle","cx":50,"cy":50,"r":25}, {"type":"polyline","points":[[0,0],[100,0],[100,40]]}.',
          items: { type: 'object' },
        },
      },
      required: ['entities'],
    },
    (ctx, args) => {
      guardEditable(ctx);
      if (!Array.isArray(args.entities) || !args.entities.length) throw new ToolError('Send a non-empty "entities" list.');
      // Validate everything first, so one bad row never leaves half a batch behind.
      const checked = args.entities.map((raw) => {
        const e = checkEnt(raw, ctx.drawing, { create: true });
        const layer = e.layer ?? ctx.drawing.header.clayer;
        if (!ctx.drawing.layerEditable(layer)) {
          throw new ToolError(`Layer "${layer}" is locked (off, frozen or locked), so nothing can be added to it. Ask to unlock it with set_layer first.`);
        }
        return e;
      });
      const made = ctx.drawing.transaction('Assistant', () =>
        checked.map((e) => {
          const stored = ctx.drawing.add({ ...baseProps(ctx.drawing.header), ...e });
          return { id: stored.id, type: stored.type };
        }),
      );
      return { ok: true, count: made.length, entities: made };
    },
  ),

  tool(
    'update_entities',
    'Patch fields of existing entities: either "items" (one {id, fields} each) or "ids" plus shared "fields". Geometry values are absolute, not relative. id and type cannot be changed; the merged entity is re-validated exactly like add_entities.',
    {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        fields: { type: 'object', description: 'Applied to every sent id.' },
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, fields: { type: 'object' } }, required: ['id', 'fields'] } },
      },
    },
    (ctx, args) => {
      guardEditable(ctx);
      const items = Array.isArray(args.items)
        ? args.items
        : Array.isArray(args.ids) && args.fields && typeof args.fields === 'object'
          ? args.ids.map((id) => ({ id, fields: args.fields }))
          : null;
      if (!items || !items.length) throw new ToolError('Send "items" ([{"id": "..", "fields": {..}}]) or "ids" plus "fields".');
      let changed = 0;
      const missing = [];
      const skipped = [];
      ctx.drawing.transaction('Assistant', () => {
        for (const it of items) {
          const raw = it?.id ?? '';
          const id = idOf(raw);
          const fields = it?.fields;
          const before = ctx.drawing.get(id);
          if (!before) {
            missing.push(String(raw));
            continue;
          }
          if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
          if ('id' in fields || 'type' in fields) {
            throw new ToolError('update_entities cannot change an entity\'s id or type. Delete it and add a new entity of the right type instead.');
          }
          if (!ctx.drawing.layerEditable(before.layer)) {
            skipped.push(String(raw));
            continue;
          }
          // Validate the whole merged entity, exactly as if the model had re-sent it.
          const merged = checkEnt({ ...before, ...fields }, ctx.drawing, { allowId: true, create: false });
          ctx.drawing.replace(id, { ...merged, id });
          changed++;
        }
      });
      const out = { ok: true, changed };
      if (missing.length) out.missing = missing;
      if (skipped.length) out.skipped = skipped;
      return out;
    },
  ),

  tool(
    'delete_entities',
    'Erase entities by ids. Entities on locked (off, frozen or locked) layers are skipped, and they come back in the "skipped" list.',
    { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
    (ctx, args) => {
      guardEditable(ctx);
      if (!Array.isArray(args.ids) || !args.ids.length) throw new ToolError('Send the entity "ids" to erase.');
      let erased = 0;
      const missing = [];
      const skipped = [];
      ctx.drawing.transaction('Assistant', () => {
        for (const raw of args.ids) {
          const id = idOf(raw);
          const before = ctx.drawing.get(id);
          if (!before) {
            missing.push(String(raw));
            continue;
          }
          if (!ctx.drawing.layerEditable(before.layer)) {
            skipped.push(String(raw));
            continue;
          }
          ctx.drawing.remove(id);
          erased++;
        }
      });
      const out = { ok: true, erased };
      if (missing.length) out.missing = missing;
      if (skipped.length) out.skipped = skipped;
      return out;
    },
  ),

  tool(
    'transform_entities',
    'Move, copy, scale, rotate and/or mirror entities. rotate_degrees takes degrees counter-clockwise (the drawing itself stores radians; this tool converts). "mirror" reflects across an axis through two points. '
      + 'copy: true transforms copies and leaves the originals where they are. The centre for scale/rotate defaults to the middle of the selection bounds.',
    {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        dx: { type: 'number', description: 'Move right.' },
        dy: { type: 'number', description: 'Move up.' },
        scale: { type: 'number', description: 'Uniform scale factor.' },
        rotate_degrees: { type: 'number', description: 'Rotation in degrees, counter-clockwise. Use this, not radians.' },
        mirror: {
          type: 'object',
          description: 'Mirror across the axis through these two points: {"x1": 0, "y1": 0, "x2": 0, "y2": 10}.',
          properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } },
          required: ['x1', 'y1', 'x2', 'y2'],
        },
        copy: { type: 'boolean', description: 'True: transform copies and keep the originals.' },
        cx: { type: 'number', description: 'Centre x for scale/rotate (default: centre of the bounds).' },
        cy: { type: 'number', description: 'Centre y for scale/rotate.' },
      },
      required: ['ids'],
    },
    (ctx, args) => {
      guardEditable(ctx);
      if (!Array.isArray(args.ids) || !args.ids.length) throw new ToolError('Send the entity "ids" to transform.');
      if (args.rotate != null) throw new ToolError('Use "rotate_degrees" (a number of degrees); the drawing stores radians internally and this tool converts.');
      if (args.dx == null && args.dy == null && args.scale == null && args.rotate_degrees == null && args.mirror == null) {
        throw new ToolError('Give at least one of dx, dy, scale, rotate_degrees or mirror.');
      }
      const ents = args.ids.map((raw) => ctx.drawing.get(idOf(raw))).filter(Boolean);
      if (!ents.length) throw new ToolError('None of those ids exist.');
      let cx = args.cx != null ? num(args.cx, 'cx') : null;
      let cy = args.cy != null ? num(args.cy, 'cy') : null;
      if ((cx == null || cy == null) && (args.scale != null || args.rotate_degrees != null)) {
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (const e of ents) {
          const b = boundsOf(ctx, e);
          if (!b) continue;
          minX = Math.min(minX, b[0]);
          minY = Math.min(minY, b[1]);
          maxX = Math.max(maxX, b[2]);
          maxY = Math.max(maxY, b[3]);
        }
        if (minX === Infinity) throw new ToolError('Those entities have no bounds to centre on; give cx and cy.');
        cx ??= r6((minX + maxX) / 2);
        cy ??= r6((minY + maxY) / 2);
      }
      // Applied in this order: scale, then rotate, then mirror, then move.
      let m = identity();
      if (args.scale != null) {
        const s = num(args.scale, 'scale');
        if (s === 0) throw new ToolError('scale must be a non-zero number.');
        m = multiply(scale(s, cx, cy), m);
      }
      if (args.rotate_degrees != null) {
        const a = num(args.rotate_degrees, 'rotate_degrees');
        m = multiply(rotate((a * Math.PI) / 180, cx, cy), m);
      }
      if (args.mirror != null) {
        const ax = Array.isArray(args.mirror) ? args.mirror : [args.mirror.x1, args.mirror.y1, args.mirror.x2, args.mirror.y2];
        const [x1, y1, x2, y2] = ax.map((v, i) => num(v, `mirror${i < 2 ? '.x1/y1' : '.x2/y2'}`));
        if (!(Math.hypot(x2 - x1, y2 - y1) > 0)) throw new ToolError('mirror needs two different points to define the axis.');
        m = multiply(mirror(x1, y1, x2, y2), m);
      }
      if (args.dx != null || args.dy != null) m = multiply(translate(num(args.dx ?? 0, 'dx'), num(args.dy ?? 0, 'dy')), m);

      const copy = !!args.copy;
      let changed = 0;
      const skipped = [];
      const newIds = [];
      ctx.drawing.transaction('Assistant', () => {
        for (const raw of args.ids) {
          const id = idOf(raw);
          const before = ctx.drawing.get(id);
          if (!before) {
            skipped.push(String(raw));
            continue;
          }
          if (!ctx.drawing.layerEditable(before.layer)) {
            skipped.push(String(raw));
            continue;
          }
          const next = roundAll(transformEntity(before, m));
          if (copy) {
            const { id: _keep, ...body } = next;
            const stored = ctx.drawing.add(body);
            newIds.push(stored.id);
          } else {
            ctx.drawing.replace(id, next);
          }
          changed++;
        }
      });
      const out = { ok: true, changed };
      if (copy) out.ids = newIds;
      if (skipped.length) out.skipped = skipped;
      return out;
    },
  ),

  tool(
    'set_layer',
    'Create or change a layer: color, linetype, lineweight, on/frozen/locked/plot flags, and optionally make it the current layer.',
    {
      type: 'object',
      properties: {
        name: { type: 'string' },
        color: { type: 'integer', description: 'Palette index 0-256 (0 ByBlock, 256 ByLayer, 1-255).' },
        linetype: { type: 'string', description: 'A loaded linetype name (ByLayer, ByBlock or from drawing_info).' },
        lineweight: { type: 'number', description: '-3 default, -2 ByBlock, -1 ByLayer, or 0-211 (hundredths of a mm).' },
        on: { type: 'boolean' },
        frozen: { type: 'boolean' },
        locked: { type: 'boolean' },
        plot: { type: 'boolean' },
        make_current: { type: 'boolean', description: 'Make it the current layer for new entities.' },
      },
      required: ['name'],
    },
    (ctx, args) => {
      guardEditable(ctx);
      const name = String(args.name ?? '').trim();
      if (!name) throw new ToolError('Layer "name" is required.');
      if (name.length > 255) throw new ToolError('Layer names are at most 255 characters.');
      const d = ctx.drawing;
      const existing = d.layers.get(name);
      const next = existing ? { ...existing } : { ...defaultLayer(name), color: 7 };
      if (args.color != null) {
        const c = num(args.color, 'color');
        if (!Number.isInteger(c) || c < 0 || c > 256) throw new ToolError('color must be an integer 0-256.');
        next.color = c;
      }
      if (args.linetype != null) {
        if (typeof args.linetype !== 'string' || (args.linetype !== 'ByLayer' && args.linetype !== 'ByBlock' && !d.linetypes.has(args.linetype))) {
          throw new ToolError(`Linetype "${args.linetype}" is not loaded.`);
        }
        next.linetype = args.linetype;
      }
      if (args.lineweight != null) {
        const lw = num(args.lineweight, 'lineweight');
        if (!Number.isInteger(lw) || !((lw >= -3 && lw <= -1) || (lw >= 0 && lw <= 211))) {
          throw new ToolError('lineweight must be -3 (default), -2 (ByBlock), -1 (ByLayer) or an integer 0-211 (hundredths of a mm).');
        }
        next.lineweight = lw;
      }
      for (const k of ['on', 'frozen', 'locked', 'plot']) if (args[k] != null) next[k] = !!args[k];
      d.transaction('Assistant', () => {
        d.setTable('layers', name, next);
        if (args.make_current) d.setHeader({ clayer: name });
      });
      return { ok: true, layer: next, created: !existing, current: args.make_current ? name : d.header.clayer };
    },
  ),

  tool(
    'select_entities',
    'Change the selection the user sees: replace or add to it by ids, window or point. The user can then undo your work or inspect the found objects.',
    {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        window: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, inside: { type: 'boolean' } }, required: ['x1', 'y1', 'x2', 'y2'] },
        at: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, r: { type: 'number' } }, required: ['x', 'y'] },
        add: { type: 'boolean', description: 'True: add to the selection; false (default): replace it.' },
      },
    },
    (ctx, args) => {
      const ids = pickIds(ctx, { ids: args.ids, window: args.window, at: args.at }).filter((id) => {
        const e = ctx.drawing.get(id);
        return e && ctx.drawing.layerEditable(e.layer);
      });
      if (!ids.length) return { ok: true, selected: 0 };
      if (args.add) ctx.editor.addToSelection(ids);
      else ctx.editor.setSelection(ids);
      return { ok: true, selected: ctx.editor.selection.size };
    },
  ),

  tool(
    'zoom_to',
    'Point the view at entities (by ids), an explicit world-space rectangle, or the whole drawing.',
    {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        bounds: { type: 'array', items: { type: 'number' }, description: '[x1, y1, x2, y2] in world coordinates.' },
      },
    },
    (ctx, args) => {
      let b = null;
      if (Array.isArray(args.bounds) && args.bounds.length === 4 && args.bounds.every((v) => Number.isFinite(Number(v)))) b = args.bounds.map(Number);
      else if (Array.isArray(args.ids) && args.ids.length) {
        for (const raw of args.ids) {
          const e = ctx.drawing.get(idOf(raw));
          if (!e) continue;
          const eb = boundsOf(ctx, e);
          if (!eb) continue;
          b = b ? [Math.min(b[0], eb[0]), Math.min(b[1], eb[1]), Math.max(b[2], eb[2]), Math.max(b[3], eb[3])] : eb;
        }
        if (!b && args.ids.length === 1) {
          // A single unbounded entity (point): fit tightly on a small patch around it.
          const e = ctx.drawing.get(idOf(args.ids[0]));
          if (e) b = [e.x - 5, e.y - 5, e.x + 5, e.y + 5];
        }
      } else {
        ctx.editor.zoomExtents();
        return { ok: true, what: 'extents' };
      }
      if (!b) throw new ToolError('Nothing to zoom to. Send "ids", "bounds", or neither for the whole drawing.');
      const pad = Math.max(1e-9, Math.max(b[2] - b[0], b[3] - b[1])) * 0.02;
      ctx.editor.camera.fit(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad, 24);
      ctx.editor.viewChanged();
      return { ok: true, bounds: b.map(r6) };
    },
  ),
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Run one tool_call; ToolError text goes back to the model as the tool result. */
export function execTool(ctx, name, args) {
  const t = TOOLS_BY_NAME.get(String(name));
  if (!t) throw new ToolError(`Unknown tool "${name}".`);
  return t.run(ctx, args && typeof args === 'object' ? args : {});
}

/** Schemas and names for the AI server's `tools` request field. */
export const toolSchemas = () =>
  TOOLS.map((t) => ({
    name: t.name,
    description: `${t.description}${t.mutating ? ' (Changes the drawing.)' : ''}`,
    parameters: t.parameters,
  }));

// System prompt ---------------------------------------------------------------------------

/**
 * The entity reference, built from the field docs of core/schema.js (see the
 * ALLOWED_KEYS/TYPE_KEYS tables above, which mirror it). Kept as plain text so
 * tests can assert the model never misses a rule.
 */
export function entityReference() {
  const lines = [
    'ENTITY REFERENCE (angles are in radians unless a tool says otherwise; coordinates are in drawing units):',
    '- color: 256 = ByLayer, 0 = ByBlock, 1-255 = palette index, or "#rrggbb" true color.',
    '- linetype: "ByLayer", "ByBlock", or a linetype name from drawing_info.',
    '- lineweight: -3 = default, -2 = ByBlock, -1 = ByLayer, or 0-211 in hundredths of a millimetre.',
    '- polyline geometry: "points": [[x, y], [x, y, bulge], ...] where each point is a pair and bulge (optional, '
      + 'tan(sweep/4), positive counter-clockwise) belongs to the segment starting at that point. Do NOT send a flat number list.',
    'Types and fields:',
  ];
  for (const t of ENTITY_TYPES) lines.push(`  ${t}: ${TYPE_KEYS[t].keys.filter((k) => !COMMON_KEYS.includes(k)).join(', ')}${TYPE_KEYS[t].required.length ? ` (required: ${TYPE_KEYS[t].required.join(', ')})` : ''}`);
  lines.push(
    '  line example: {"type":"line","x1":0,"y1":0,"x2":100,"y2":0}',
    '  circle example: {"type":"circle","cx":50,"cy":50,"r":25}',
    '  arc example: {"type":"arc","cx":0,"cy":0,"r":10,"start":0,"end":1.5708}  (start/end in radians, counter-clockwise)',
    '  polyline example: {"type":"polyline","points":[[0,0],[100,0],[100,40]],"closed":false}',
    '  text example: {"type":"text","x":10,"y":10,"h":2.5,"value":"Label"}',
    '  dimension example: {"type":"dimension","dimType":"linear","x1":0,"y1":0,"x2":100,"y2":0,"lx":50,"ly":-12,"rot":0}',
  );
  return lines.join('\n');
}

/**
 * The system prompt for one assistant turn. info is drawing_info's result;
 * the caller adds nothing else — everything the model needs is here.
 */
export function systemPrompt(info, { readOnly = false } = {}) {
  const summary = info ? { ...info, layers: ((info.layers || []).length > 40 ? (info.layers || []).slice(-40) : info.layers) || [] } : null;
  return [
    'You help people draw and edit a 2D CAD drawing by calling tools.',
    summary ? `Drawing: ${JSON.stringify(summary)}` : '',
    `All angles in the drawing format are radians (counter-clockwise from +X); only transform_entities.rotate_degrees takes degrees. The schema also uses radians for rot, arc start/end, hatch angle and ellipse angles.`,
    entityReference(),
    'Prefer update_entities on existing objects before deleting and redrawing. Locked layers are protected: tools report skipped ids instead of changing them.',
    'Keep prose short; one or two sentences. Mention ids only when the user may need them, and offer zoom_to or select_entities after changes so the user sees the result.',
    'If a tool reports an error, read it, fix the arguments, and try again; never invent ids.',
    readOnly ? 'The drawing is read-only: answer questions only and do not attempt edits.' : 'Edits apply to the real drawing; a single Undo reverts your whole turn.',
  ]
    .filter(Boolean)
    .join('\n');
}
