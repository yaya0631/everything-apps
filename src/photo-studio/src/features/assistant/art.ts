// App-native artwork building for the Assistant: vector shapes and freeform
// paths, non-destructive gradient fill layers, and raster brush strokes. These
// use the same editor commands and paint engine as the shape, pen and brush
// tools, so the Assistant never drives the UI or another program. The pure
// argument readers are exported for tests; the builders take a live Editor.
import type { Editor } from '../../editor';
import type { Layer, PhotoDocument, Rect } from '../../model/document';
import { allLayers, findLayer, layer as newLayer } from '../../model/document';
import type { Gradient, GradientType } from '../../imaging/gradient/gradient';
import type { LiveShape } from '../../model/live-shape';
import type { VectorMask } from '../../model/vector';
import { newPixelLayer } from '../../model/pixel-layer';
import { canvasRect, selectionGrid } from '../../model/selection';
import { StrokeSession, type BrushDynamics, type BrushTip, type PaintMode, type PaintTarget } from '../../engine/paint';
import { buildPaint, defaultStroke, type FillSpec, type GradientStyle, type StrokeSpec } from '../vector/paint';
import { autoSmooth, closedPath, liveKnots, type Knot } from '../vector/geometry';
import { shapeLayer } from '../vector/state';
import { insertAboveSelection } from '../layers/insert';
import { commitTarget, hexRgb, pixelTarget } from '../pixels';
import { parseColor, parseNumber } from './params';

export type ArtError = { error: string };

type Point = { x: number; y: number; smooth?: boolean; in?: [number, number]; out?: [number, number] };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const readNum = (v: unknown, fallback: number) => (finite(v) ? v : fallback);
const pair = (v: unknown): [number, number] | undefined => {
  if (Array.isArray(v) && v.length >= 2 && finite(v[0]) && finite(v[1])) return [v[0], v[1]];
  if (v && typeof v === 'object') {
    const p = v as Record<string, unknown>;
    if (finite(p.x) && finite(p.y)) return [p.x, p.y];
  }
  return undefined;
};

/** One point of a freeform path: [x,y], {x,y}, or a point with in/out handles. */
function readPoint(raw: unknown): Point | undefined {
  const p = pair(raw);
  if (!p) return undefined;
  const o = (raw && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const smooth = o.smooth === undefined ? true : o.smooth !== false;
  const inHandle = pair(o.in) ?? (finite(o.inX) && finite(o.inY) ? [o.inX, o.inY] : undefined);
  const outHandle = pair(o.out) ?? (finite(o.outX) && finite(o.outY) ? [o.outX, o.outY] : undefined);
  return { x: p[0], y: p[1], smooth, ...(inHandle ? { in: inHandle } : {}), ...(outHandle ? { out: outHandle } : {}) };
}

/** A checked subpath from the model's points. The anchors are `points`; a
 * smooth point without handles gets tangent handles from its neighbours. */
export function readPath(raw: unknown, closed = true): VectorMask | ArtError {
  if (!Array.isArray(raw)) return { error: 'Points must be an array of [x, y] or { x, y } points.' };
  const points = raw.map(readPoint);
  if (points.some((p) => !p)) return { error: 'Every point needs numeric x and y coordinates.' };
  let pts = points as Point[];
  if (pts.length > 1 && Math.hypot(pts[0].x - pts.at(-1)!.x, pts[0].y - pts.at(-1)!.y) < 0.01) pts = pts.slice(0, -1);
  if (pts.length < 2) return { error: 'A path needs at least two points.' };
  if (pts.length > 4000) return { error: 'A path can have at most 4000 points.' };
  const knots: Knot[] = pts.map((p) => {
    const explicit = !!(p.in || p.out);
    return { linked: p.smooth !== false && !explicit, points: p.in || p.out ? [p.in?.[0] ?? p.x, p.in?.[1] ?? p.y, p.x, p.y, p.out?.[0] ?? p.x, p.out?.[1] ?? p.y] : [p.x, p.y, p.x, p.y, p.x, p.y] };
  });
  const path = { open: !closed, fillRule: 'non-zero' as const, operation: 'combine' as const, knots };
  const auto = new Set(pts.flatMap((p, i) => (p.smooth !== false && !p.in && !p.out ? [i] : [])));
  if (auto.size) autoSmooth(path, auto);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.smooth === false || p.in || p.out) {
      const k = path.knots[i];
      if (!p.in) (k.points[0] = p.x), (k.points[1] = p.y);
      if (!p.out) (k.points[4] = p.x), (k.points[5] = p.y);
      k.linked = false;
    }
  }
  return { paths: [path] };
}

/** Bounds of the points, used to lay a gradient or fill paint over the path. */
export function pathBounds(raw: unknown): Rect | undefined {
  if (!Array.isArray(raw)) return;
  const pts = raw.map(pair).filter((p): p is [number, number] => !!p);
  if (!pts.length) return;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) };
}

const DEFAULT_STOPS = ['#101820', '#f3b25b'];

/** Parse gradient stops: [{ position, color, opacity }] or [position, color]
 * pairs. Positions are 0..1 (0..100 also accepted), opacity is 0..100. */
export function readGradientStops(raw: unknown): { stops: { location: number; color: [number, number, number]; opacity: number }[] } | ArtError {
  if (!Array.isArray(raw) || raw.length < 2) return { error: 'A gradient needs at least two color stops.' };
  const stops: { location: number; color: [number, number, number]; opacity: number }[] = [];
  for (const item of raw.slice(0, 32)) {
    let position = 0, color: unknown = item, opacity = 100;
    if (Array.isArray(item)) {
      if (item.length < 2) return { error: 'A stop is [position, color] or { position, color, opacity }.' };
      position = parseNumber(item[0]) ?? NaN;
      color = item[1];
      if (item[2] !== undefined) opacity = parseNumber(item[2]) ?? 100;
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      position = parseNumber(o.position ?? o.location ?? o.offset) ?? NaN;
      color = o.color;
      if (o.opacity !== undefined) opacity = parseNumber(o.opacity) ?? 100;
    }
    const hex = parseColor(color);
    if (!finite(position) || !hex) return { error: 'Every stop needs a position and a color such as #101820.' };
    if (position > 1) position /= 100;
    const [r, g, b] = hexRgb(hex);
    stops.push({ location: clamp(position, 0, 1), color: [r, g, b], opacity: clamp(opacity, 0, 100) / 100 });
  }
  stops.sort((a, b) => a.location - b.location);
  return { stops };
}

export function readGradient(raw: unknown): { gradient: Gradient; style: GradientType; angle: number; reverse: boolean; scale: number } | ArtError {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const stops = readGradientStops(o.stops);
  if ('error' in stops) return stops;
  const styleName = String(o.style ?? 'linear').toLowerCase();
  const style = ['linear', 'radial', 'angle', 'reflected', 'diamond'].includes(styleName) ? (styleName as GradientType) : 'linear';
  const colorStops = stops.stops.map((s) => ({ location: s.location, color: s.color }));
  // Keep opacity stops only when they vary; all-opaque is the common case.
  const opacityStops = stops.stops.some((s) => s.opacity < 1) ? stops.stops.map((s) => ({ location: s.location, opacity: s.opacity })) : [{ location: 0, opacity: 1 }, { location: 1, opacity: 1 }];
  return {
    gradient: { kind: 'solid', name: typeof o.name === 'string' ? o.name.slice(0, 80) : 'Assistant gradient', colorStops, opacityStops },
    style,
    angle: clamp(readNum(o.angle, 90), -360, 360),
    reverse: o.reverse === true,
    scale: clamp(readNum(o.scale, 1), 0.01, 10),
  };
}

function fillFrom(args: Record<string, unknown>): FillSpec {
  const gradient = args.gradient && typeof args.gradient === 'object' ? args.gradient : undefined;
  if (gradient) {
    const g = readGradient(gradient);
    if (!('error' in g)) {
      const stops = g.gradient.kind === 'solid' ? g.gradient.colorStops : [];
      const from = parseColor((stops[0]?.color as [number, number, number] | undefined) ?? DEFAULT_STOPS[0]) ?? DEFAULT_STOPS[0];
      const to = parseColor((stops.at(-1)?.color as [number, number, number] | undefined) ?? DEFAULT_STOPS[1]) ?? DEFAULT_STOPS[1];
      return { type: 'gradient', from, to, style: g.style as GradientStyle, angle: g.angle, reverse: g.reverse };
    }
  }
  const color = parseColor(args.fill);
  return color ? { type: 'color', color } : { type: 'none' };
}

function strokeFrom(args: Record<string, unknown>): StrokeSpec {
  const color = parseColor(args.stroke);
  if (!color) return defaultStroke();
  const align = args.strokeAlign === 'center' || args.strokeAlign === 'outside' ? args.strokeAlign : 'inside';
  return {
    ...defaultStroke(),
    type: 'color',
    color,
    width: clamp(readNum(args.strokeWidth, 3), 0.1, 1000),
    align,
    cap: 'butt',
    join: 'miter',
    dash: 'solid',
    custom: '4 2',
    opacity: clamp(readNum(args.strokeOpacity, 100), 0, 100) / 100,
  };
}

export function readLiveShape(args: Record<string, unknown>): { live: LiveShape; rect: Rect; open: boolean } | ArtError {
  const kindName = String(args.kind ?? 'rect').toLowerCase();
  const kind = kindName === 'ellipse' || kindName === 'triangle' || kindName === 'polygon' || kindName === 'line' ? kindName : kindName === 'rect' ? 'rect' : undefined;
  if (!kind) return { error: 'Shape kind must be rect, ellipse, triangle, polygon or line.' };
  if (kind === 'line') {
    const x1 = readNum(args.x1, readNum(args.x, 0)), y1 = readNum(args.y1, readNum(args.y, 0));
    const x2 = readNum(args.x2, x1 + readNum(args.width, 100)), y2 = readNum(args.y2, y1);
    if (Math.hypot(x2 - x1, y2 - y1) < 0.5) return { error: 'A line needs two distinct points.' };
    const weight = readNum(args.strokeWidth, 3);
    const live: LiveShape = { kind: 'line', x1, y1, x2, y2, weight, arrowStart: args.arrowStart === true, arrowEnd: args.arrowEnd === true, arrowWidth: Math.max(1, readNum(args.arrowWidth, 12)), arrowLength: Math.max(0.1, readNum(args.arrowLength, 1.6)), concavity: clamp(readNum(args.concavity, 0), -50, 50) / 100 };
    return { live, rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.max(1, Math.abs(x2 - x1)), height: Math.max(1, Math.abs(y2 - y1)) }, open: true };
  }
  const width = readNum(args.width, NaN), height = readNum(args.height, NaN);
  if (!(width > 0) || !(height > 0)) return { error: 'Give the shape a width and height in pixels.' };
  const r = { x: readNum(args.x, 0), y: readNum(args.y, 0), width, height };
  const radius = clamp(readNum(args.radius, 0), 0, Math.min(width, height) / 2);
  let live: LiveShape;
  if (kind === 'rect') live = { kind: 'rect', ...r, radii: [radius, radius, radius, radius] };
  else if (kind === 'ellipse') live = { kind: 'ellipse', ...r };
  else if (kind === 'triangle') live = { kind: 'triangle', ...r, radius };
  else live = { kind: 'polygon', ...r, sides: clamp(Math.round(readNum(args.sides, 6)), 3, 100), star: clamp(readNum(args.star, 0), 0, 0.99), radius, smoothIndents: args.smoothIndents === true };
  return { live, rect: r, open: false };
}

/** A readable layer name that is deterministic: the requested name when it is
 * free, otherwise the same name with the first free number. */
export function assistantLayerName(doc: PhotoDocument, base: string) {
  const name = base.trim().slice(0, 200) || 'Layer';
  const names = new Set(allLayers(doc.layers).map((l) => l.name));
  if (!names.has(name)) return name;
  for (let n = 2; n < 10000; n++) if (!names.has(`${name} ${n}`)) return `${name} ${n}`;
  return `${name} copy`;
}

function addVector(e: Editor, name: string, mask: VectorMask, bounds: Rect, args: Record<string, unknown>, live: LiveShape | undefined, open: boolean, label: string) {
  const fill = fillFrom(args);
  const stroke = strokeFrom(args);
  if (fill.type === 'none' && stroke.type === 'none') {
    stroke.type = 'color';
    stroke.color = parseColor(args.stroke) ?? '#000000';
    stroke.width = clamp(readNum(args.strokeWidth, 3), 0.1, 1000);
  }
  const paint = buildPaint(e, fill, stroke, bounds, open);
  const l = shapeLayer(e.doc, assistantLayerName(e.doc, name), mask, paint.fill, paint.stroke, live, paint.color);
  l.opacity = clamp(readNum(args.opacity, 100), 0, 100) / 100;
  if (typeof args.blendMode === 'string') l.blend = args.blendMode as Layer['blend'];
  insertAboveSelection(e, l, label);
  e.selectLayers([l.id]);
  e.update();
  return l;
}

/** Add a live rectangle, ellipse, triangle, polygon or line as a shape layer. */
export function addShape(e: Editor, args: Record<string, unknown>): Layer | ArtError {
  const g = readLiveShape(args);
  if ('error' in g) return g;
  const bounds = g.rect;
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 200) : g.live.kind === 'rect' ? 'Rectangle' : g.live.kind === 'ellipse' ? 'Ellipse' : g.live.kind === 'triangle' ? 'Triangle' : g.live.kind === 'polygon' ? 'Polygon' : 'Line';
  const mask: VectorMask = { paths: [closedPath(liveKnots(g.live))] };
  if (g.open) mask.paths[0].open = true;
  const paintArgs = g.live.kind === 'line' && args.stroke === undefined ? { ...args, fill: undefined, stroke: typeof args.fill === 'string' ? args.fill : '#000000' } : args;
  return addVector(e, name, mask, bounds, paintArgs, g.live, g.open, 'Add Shape');
}

/** Add a freeform pen path, closed (filled) by default. */
export function addPath(e: Editor, args: Record<string, unknown>): Layer | ArtError {
  const mask = readPath(args.points, args.closed !== false);
  if ('error' in mask) return mask;
  const bounds = pathBounds(args.points) ?? canvasRect(e.doc);
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 200) : 'Path';
  return addVector(e, name, mask, bounds, args, undefined, args.closed === false, 'Add Path');
}

/** Add a non-destructive gradient fill layer. An active selection becomes its
 * mask and is dropped, exactly as with an adjustment layer. */
export function addGradientLayer(e: Editor, args: Record<string, unknown>): Layer | ArtError {
  const g = readGradient(args.gradient);
  if ('error' in g) return g;
  const doc = e.doc;
  const l = newLayer('solid', assistantLayerName(doc, typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Gradient Fill'), doc.width, doc.height);
  const fill = {
    type: 'gradient' as const,
    gradient: g.gradient,
    style: g.style,
    angle: g.angle,
    scale: g.scale,
    reverse: g.reverse,
    dither: true,
    alignWithLayer: true,
    method: 'perceptual' as const,
  };
  l.fill = fill;
  const sel = selectionGrid(doc, e.assets.tiles);
  if (sel) l.maskGrid = sel;
  l.opacity = clamp(readNum(args.opacity, 100), 0, 100) / 100;
  if (typeof args.blendMode === 'string') l.blend = args.blendMode as Layer['blend'];
  insertAboveSelection(e, l, 'Add Gradient Fill');
  if (sel) {
    e.command('Deselect', (d) => {
      d.selection = null;
      d.selectionMask = null;
    });
  }
  e.selectLayers([l.id]);
  e.update();
  return l;
}

/** Read a polyline path: [[x,y], ...] or [{x,y}, ...]. */
function readPolyline(raw: unknown): [number, number][] | undefined {
  if (!Array.isArray(raw)) return;
  const out = raw.map(pair).filter((p): p is [number, number] => !!p);
  return out.length === raw.length ? out : undefined;
}

/** Points to paint: `paths` (an array of polylines), `points` (one polyline),
 * or a single [x,y] point for a particle stamp. */
export function readPaintPaths(args: Record<string, unknown>): { paths: [number, number][][] } | ArtError {
  const raw = args.paths ?? args.points;
  if (!Array.isArray(raw)) return { error: 'Give points or paths to paint.' };
  if (!raw.length) return { error: 'There are no points to paint.' };
  const single = pair(raw);
  if (single) return { paths: [[single]] };
  const first = raw[0];
  const nested = Array.isArray(first) && Array.isArray(first[0]);
  const paths = nested ? (raw as unknown[]).map(readPolyline) : [readPolyline(raw)];
  if (paths.some((p) => !p)) return { error: 'Paint points must be [x, y] points.' };
  return { paths: paths as [number, number][][] };
}

function selectedOrNamed(e: Editor, ref: unknown): Layer | undefined {
  if (ref !== undefined && ref !== null && ref !== '' && ref !== 'selected' && ref !== 'current') {
    const s = String(ref);
    return allLayers(e.doc.layers).find((l) => l.id === s) ?? allLayers(e.doc.layers).find((l) => l.name === s) ?? allLayers(e.doc.layers).find((l) => l.name.toLowerCase() === s.toLowerCase());
  }
  return e.selected ? findLayer(e.doc.layers, e.selected) : undefined;
}

/** Paint one or more strokes with the app's paint engine. Non-pixel targets
 * get a new pixel layer, so the artwork stays editable layer by layer. */
export async function paintStrokes(e: Editor, args: Record<string, unknown>): Promise<void | ArtError> {
  const read = readPaintPaths(args);
  if ('error' in read) return read;
  let l = selectedOrNamed(e, args.layer);
  if (!l || l.kind !== 'pixel') {
    l = newPixelLayer(assistantLayerName(e.doc, typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Paint'), e.doc);
    insertAboveSelection(e, l, 'New Paint Layer');
    e.selectLayers([l.id]);
  } else {
    e.selectLayers([l.id]);
  }
  const target = await pixelTarget(e, { allowMask: false, create: false });
  if (!target || target.kind !== 'pixels') return { error: 'The paint layer has no editable pixels.' };
  const color = parseColor(args.color) ?? e.color;
  const [r, g, b] = hexRgb(color);
  const erase = args.erase === true;
  const blend = typeof args.blendMode === 'string' ? args.blendMode : 'normal';
  const paintTarget: PaintTarget = { kind: 'color', rgb: [r, g, b], mode: erase ? 'normal' : (blend as PaintMode), ...(erase ? { erase: true } : {}) };
  const tip: BrushTip = {
    size: clamp(readNum(args.size, 30), 0.5, 2500),
    hardness: clamp(readNum(args.hardness, 0.7), 0, 1),
    spacing: clamp(readNum(args.spacing, 0.12), 0.01, 4),
    roundness: clamp(readNum(args.roundness, 1), 0.01, 1),
    angle: readNum(args.angle, 0),
  };
  const dynamics: BrushDynamics = {
    scatter: Math.max(0, readNum(args.scatter, 0)),
    count: Math.max(1, Math.round(readNum(args.count, 1))),
    sizeJitter: clamp(readNum(args.sizeJitter, 0), 0, 1),
    opacityJitter: clamp(readNum(args.opacityJitter, 0), 0, 1),
    angleJitter: clamp(readNum(args.angleJitter, 0), 0, 1),
    flowJitter: clamp(readNum(args.flowJitter, 0), 0, 1),
    roundnessJitter: clamp(readNum(args.roundnessJitter, 0), 0, 1),
    pressureSize: args.pressureSize === true,
    pressureOpacity: args.pressureOpacity === true,
  };
  const selection = selectionGrid(e.doc, e.assets.tiles);
  const session = new StrokeSession(e.assets.tiles, target.grid, {
    tip,
    dynamics,
    opacity: clamp(readNum(args.opacity, 100), 0, 100) / 100,
    flow: clamp(readNum(args.flow, 100), 0, 100) / 100,
    target: paintTarget,
    selection,
    clip: canvasRect(e.doc),
    seed: Math.max(1, Math.round(readNum(args.seed, 7))),
  });
  for (const path of read.paths) {
    if (!path.length) continue;
    for (const [x, y] of path) session.addPoint(x, y, 1);
    session.lift();
  }
  if (!session.dabs) return { error: 'The stroke did not reach any pixels.' };
  commitTarget(e, target, session.grid, 'Paint');
  e.update();
}

/** Names in a comma/line separated layer reference list. */
export function splitRefs(v: unknown): string[] {
  return typeof v === 'string' ? v.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean) : [];
}
