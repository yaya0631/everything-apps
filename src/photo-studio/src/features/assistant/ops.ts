// Operations the Assistant can plan besides menu commands: precise edits
// with arguments (selections, crops to an aspect ratio, adjustment layers
// with settings, layer styles, text, layer properties). They run through the
// scripting host, so every argument is checked again and the whole plan stays
// one undo step. Schemas are pure data; implementations load what they need.
import type { Editor } from '../../editor';
import type { ScriptHost } from '../scripting/host';
import { blends, findLayer } from '../../model/document';
import { groupLayers } from '../../model/layers';
import { ADJUSTMENT_KINDS, ADJUSTMENT_LABELS, PHOTO_FILTER_PRESETS, defaultParams, type AdjustmentKind } from '../../imaging/adjust/model';
import { coerceArgs, compactJSON, parseColor, summarizeArgs, type Param } from './params';
import { addGradientLayer, addPath, addShape, paintStrokes, readGradient, readLiveShape, readPaintPaths, readPath, splitRefs } from './art';

export type OpContext = { e: Editor; host: ScriptHost };
export type SelectionEffect = 'needs' | 'creates' | 'clears';
export type OpSpec = {
  id: string;
  label: string;
  description: string;
  params: Param[];
  selection?: SelectionEffect;
  // The step opens a new document, so later steps need not have one first.
  document?: 'creates';
  // A readable one-line account of what the step does with these arguments.
  describe?: (args: Record<string, unknown>) => string;
  // Extra checks beyond the schema (problems in plain words).
  check?: (args: Record<string, unknown>) => string[];
  // Coerce nested settings the schema does not describe (adjustment settings).
  normalize?: (args: Record<string, unknown>) => { args: Record<string, unknown>; notes: string[]; problems: string[] };
  run: (ctx: OpContext, args: Record<string, unknown>) => Promise<void>;
};

const layerRef: Param = { key: 'layer', type: 'layer', label: 'Layer', description: 'Layer name or ID; omit for the selected layer' };
const blendParam: Param = { key: 'blendMode', type: 'enum', label: 'Blend mode', options: blends.map((b) => ({ value: b })) };
const opacityParam: Param = { key: 'opacity', type: 'number', label: 'Opacity', min: 0, max: 100, unit: '%' };
const rectParams: Param[] = [
  { key: 'x', type: 'integer', label: 'Left', unit: 'px' },
  { key: 'y', type: 'integer', label: 'Top', unit: 'px' },
  { key: 'width', type: 'integer', label: 'Width', min: 1, max: 30000, unit: 'px' },
  { key: 'height', type: 'integer', label: 'Height', min: 1, max: 30000, unit: 'px' },
];
const aspectParam: Param = { key: 'aspect', type: 'string', label: 'Aspect ratio', description: 'Width:height such as "16:9" or "1:1"; the largest such rectangle is used' };
const anchorParam: Param = {
  key: 'anchor',
  type: 'enum',
  label: 'Anchor',
  options: ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'].map((v) => ({ value: v })),
  default: 'center',
};

/** "16:9", "16/9", "16x9" or a number: width divided by height. */
export function parseAspect(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 0 && Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(v);
  if (m) return Number(m[1]) > 0 && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : undefined;
  const n = Number(v);
  return n > 0 && Number.isFinite(n) ? n : undefined;
}
type Rect = { x: number; y: number; width: number; height: number };
/** The rectangle a select/crop step describes in a W x H document: explicit
 * bounds (missing position centers it), or the largest rectangle of an
 * aspect ratio placed by `anchor`. */
export function stepRect(args: Record<string, unknown>, W: number, H: number): Rect | undefined {
  const aspect = parseAspect(args.aspect);
  const anchor = typeof args.anchor === 'string' ? args.anchor : 'center';
  let w = typeof args.width === 'number' ? args.width : undefined;
  let h = typeof args.height === 'number' ? args.height : undefined;
  if (aspect && w === undefined && h === undefined) {
    w = Math.min(W, Math.round(H * aspect));
    h = Math.min(H, Math.round(w / aspect));
  } else if (aspect && w !== undefined && h === undefined) h = Math.round(w / aspect);
  else if (aspect && h !== undefined && w === undefined) w = Math.round(h * aspect);
  if (w === undefined || h === undefined) return undefined;
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const ax = anchor.includes('left') ? 0 : anchor.includes('right') ? W - w : Math.round((W - w) / 2);
  const ay = anchor.includes('top') ? 0 : anchor.includes('bottom') ? H - h : Math.round((H - h) / 2);
  return { x: typeof args.x === 'number' ? args.x : ax, y: typeof args.y === 'number' ? args.y : ay, width: w, height: h };
}
const rectCheck = (args: Record<string, unknown>) =>
  args.aspect !== undefined && !parseAspect(args.aspect)
    ? [`The aspect ratio “${String(args.aspect)}” is not understood; use a form like 16:9.`]
    : args.aspect === undefined && (args.width === undefined || args.height === undefined)
      ? ['Give a width and height, or an aspect ratio such as 16:9.']
      : [];

// Simple adjustment kinds whose settings are flat numbers (or a few choices).
export const ADJUSTMENT_PARAMS: Partial<Record<AdjustmentKind, Param[]>> = {
  'brightness-contrast': [
    { key: 'brightness', type: 'number', min: -150, max: 150 },
    { key: 'contrast', type: 'number', min: -50, max: 100 },
  ],
  exposure: [
    { key: 'exposure', type: 'number', min: -20, max: 20, unit: 'stops' },
    { key: 'offset', type: 'number', min: -0.5, max: 0.5 },
    { key: 'gamma', type: 'number', min: 0.01, max: 9.99 },
  ],
  vibrance: [
    { key: 'vibrance', type: 'number', min: -100, max: 100 },
    { key: 'saturation', type: 'number', min: -100, max: 100 },
  ],
  'hue-saturation': [
    { key: 'hue', type: 'number', min: -180, max: 180, description: 'shifts every color (degrees)' },
    { key: 'saturation', type: 'number', min: -100, max: 100 },
    { key: 'lightness', type: 'number', min: -100, max: 100 },
    { key: 'colorize', type: 'boolean' },
    { key: 'colorizeHue', type: 'number', min: 0, max: 360 },
    { key: 'colorizeSaturation', type: 'number', min: 0, max: 100 },
  ],
  'photo-filter': [
    { key: 'preset', type: 'enum', options: [...Object.entries(PHOTO_FILTER_PRESETS).map(([value, p]) => ({ value, label: p.label })), { value: 'custom', label: 'Custom' }] },
    { key: 'color', type: 'color', description: 'a custom filter color' },
    { key: 'density', type: 'number', min: 0, max: 100 },
    { key: 'preserveLuminosity', type: 'boolean' },
  ],
  posterize: [{ key: 'levels', type: 'integer', min: 2, max: 255 }],
  threshold: [{ key: 'level', type: 'integer', min: 1, max: 255 }],
  'light-tone': [
    { key: 'exposure', type: 'number', min: -5, max: 5, unit: 'stops' },
    ...['contrast', 'highlights', 'shadows', 'whites', 'blacks'].map((key): Param => ({ key, type: 'number', min: -100, max: 100 })),
  ],
  'color-vibrance': ['temperature', 'tint', 'vibrance', 'saturation'].map((key): Param => ({ key, type: 'number', min: -100, max: 100 })),
  'clarity-dehaze': ['clarity', 'dehaze'].map((key): Param => ({ key, type: 'number', min: -100, max: 100 })),
  grain: ['amount', 'size', 'roughness', 'color'].map((key): Param => ({ key, type: 'number', min: 0, max: 100 })),
  invert: [],
};
/** Settings of an adjustment layer from the model's arguments: flat kinds are
 * checked against their schema; others take nested objects merged with the
 * defaults (see adjustmentDefaults). */
export function adjustmentParams(kind: AdjustmentKind, raw: unknown): { params: Record<string, unknown>; notes: string[]; problems: string[] } {
  const schema = ADJUSTMENT_PARAMS[kind];
  if (!schema) return { params: raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}, notes: [], problems: raw !== undefined && (typeof raw !== 'object' || raw === null) ? ['The adjustment settings must be a set of named values.'] : [] };
  const c = coerceArgs(schema, raw);
  const p: Record<string, unknown> = { ...c.value };
  if (kind === 'hue-saturation') {
    const master: Record<string, unknown> = {};
    for (const k of ['hue', 'saturation', 'lightness']) if (k in p) (master[k] = p[k]), delete p[k];
    if (Object.keys(master).length) p.master = { ...defaultParams('hue-saturation').master, ...master };
  }
  if (kind === 'photo-filter') {
    if (typeof p.color === 'string') {
      const hex = p.color as string;
      p.color = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      if (!('preset' in p)) p.preset = 'custom';
    } else if (typeof p.preset === 'string' && p.preset !== 'custom') p.color = [...PHOTO_FILTER_PRESETS[p.preset as keyof typeof PHOTO_FILTER_PRESETS].color];
  }
  return { params: p, notes: c.notes, problems: c.problems };
}
/** Default settings of a kind as compact JSON (shown to the model for nested kinds). */
export const adjustmentDefaults = (kind: AdjustmentKind) => compactJSON(defaultParams(kind), 900);

const isKind = (k: unknown): k is AdjustmentKind => typeof k === 'string' && (ADJUSTMENT_KINDS as string[]).includes(k);
const quote = (s: unknown) => `“${String(s)}”`;

/** Resolve a layer reference (name, ID or nothing for the selected layer) to an ID. */
async function layerId(host: ScriptHost, ref: unknown): Promise<string> {
  if (ref === undefined || ref === '' || ref === 'selected' || ref === 'current') {
    const sel = (await host.call('layers.selected', [])) as { id: string }[];
    if (!sel.length) throw new Error('Select a layer first.');
    return sel[0].id;
  }
  const list = (await host.call('layers.list', [])) as { id: string; name: string }[];
  const s = String(ref);
  const found = list.find((l) => l.id === s) ?? list.find((l) => l.name === s) ?? list.find((l) => l.name.toLowerCase() === s.toLowerCase());
  if (!found) throw new Error(`There is no layer named ${quote(s)}.`);
  return found.id;
}
/** Resolve comma/line separated names or an array of names to layer IDs. */
async function layerIds(host: ScriptHost, ref: unknown): Promise<string[]> {
  if (ref === undefined || ref === null || ref === '' || ref === 'selected' || ref === 'current') {
    const sel = (await host.call('layers.selected', [])) as { id: string }[];
    if (!sel.length) throw new Error('Select the layers first.');
    return sel.map((l) => l.id);
  }
  const refs = Array.isArray(ref) ? ref.map((v) => String(v)).filter(Boolean) : splitRefs(ref);
  if (!refs.length) throw new Error('Name at least one layer.');
  return Promise.all(refs.map((r) => layerId(host, r)));
}
const pick = (args: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

export const OPS: OpSpec[] = [
  {
    id: 'op.new_document',
    label: 'New Document',
    description:
      'Create a new RGB document (closing nothing) with a white, black, transparent or custom-color background and a resolution in pixels per inch. Use this first for requests that start from a blank canvas.',
    params: [
      { key: 'width', type: 'integer', label: 'Width', min: 1, max: 8192, unit: 'px', default: 3000, required: true },
      { key: 'height', type: 'integer', label: 'Height', min: 1, max: 8192, unit: 'px', default: 4000, required: true },
      { key: 'resolution', type: 'number', label: 'Resolution', min: 1, max: 10000, unit: 'ppi', default: 300 },
      { key: 'background', type: 'string', label: 'Background', default: 'white', description: 'white, black, transparent, or a color such as #101820' },
      { key: 'name', type: 'string', label: 'Name' },
    ],
    selection: 'clears',
    document: 'creates',
    check: (a) => {
      if (!(typeof a.width === 'number' && a.width > 0 && typeof a.height === 'number' && a.height > 0)) return ['Give a width and height in pixels.'];
      if (typeof a.width === 'number' && typeof a.height === 'number' && a.width * a.height > 24_000_000) return ['The document exceeds 24 megapixels.'];
      return [];
    },
    describe: (a) => `${a.width ?? '?'} × ${a.height ?? '?'} px at ${a.resolution ?? 300} ppi, ${a.background ?? 'white'} background`,
    async run({ e, host }, a) {
      const bg = typeof a.background === 'string' && a.background.trim() ? a.background.trim() : 'white';
      const named = ['white', 'black', 'transparent'].includes(bg.toLowerCase());
      await host.call('documents.create', [
        {
          name: typeof a.name === 'string' ? a.name : 'Assistant Artwork',
          width: a.width,
          height: a.height,
          resolution: a.resolution ?? 300,
          background: named ? bg.toLowerCase() : bg,
        },
      ]);
      e.fit();
    },
  },
  {
    id: 'op.select_layers',
    label: 'Select Layers',
    description: 'Select several layers by name or ID (comma or line separated), so a group, smart object, clipping mask or other multi-layer step can use them.',
    params: [{ key: 'layers', type: 'text', label: 'Layers', required: true, description: 'Layer names or IDs, separated by commas or lines' }],
    describe: (a) => String(a.layers ?? ''),
    async run({ host }, a) {
      await host.call('layers.select', [null, await layerIds(host, a.layers)]);
    },
  },
  {
    id: 'op.group_layers',
    label: 'Group Layers',
    description: 'Put the named layers (or the selected layers) into a new group, in one undoable step. The group is selected afterwards.',
    params: [{ key: 'layers', type: 'text', label: 'Layers', description: 'Names or IDs separated by commas; omit for the selected layers' }, { key: 'name', type: 'string', label: 'Group name' }],
    describe: (a) => `${a.name ? quote(a.name) : 'A group'}${a.layers ? ` from ${String(a.layers)}` : ' from the selected layers'}`,
    async run({ e, host }, a) {
      const ids = await layerIds(host, a.layers);
      let gid: string | undefined;
      e.command('Group Layers', (d) => {
        gid = groupLayers(d, new Set(ids));
        if (gid && typeof a.name === 'string' && a.name.trim()) {
          const g = findLayer(d.layers, gid);
          if (g) g.name = a.name.trim().slice(0, 200);
        }
      });
      if (gid) e.selectLayers([gid]);
      e.update();
    },
  },
  {
    id: 'op.smart_object',
    label: 'Convert to Smart Object',
    description: 'Convert the named layers (or the selected layers) into one embedded Smart Object. The object keeps its contents editable with Edit Contents.',
    params: [{ key: 'layers', type: 'text', label: 'Layers', description: 'Names or IDs separated by commas; omit for the selected layers' }],
    describe: (a) => (a.layers ? `From ${String(a.layers)}` : 'From the selected layers'),
    async run({ host }, a) {
      await host.call('layers.select', [null, await layerIds(host, a.layers)]);
      await host.call('commands.run', ['layer.embed-convert']);
    },
  },
  {
    id: 'op.select',
    label: 'Select Area',
    description: 'Select a rectangle or ellipse: give x, y, width, height in document pixels, or an aspect ratio for the largest centered area of that shape.',
    params: [{ key: 'shape', type: 'enum', label: 'Shape', options: [{ value: 'rect', label: 'Rectangle' }, { value: 'ellipse', label: 'Ellipse' }], default: 'rect' }, ...rectParams, aspectParam, anchorParam, { key: 'mode', type: 'enum', label: 'Mode', options: ['replace', 'add', 'subtract', 'intersect'].map((v) => ({ value: v })), default: 'replace' }],
    selection: 'creates',
    check: rectCheck,
    describe: (a) => `${a.shape === 'ellipse' ? 'Ellipse' : 'Rectangle'} ${a.aspect ? `at ${String(a.aspect)}` : `${a.width ?? '?'} × ${a.height ?? '?'} px`}${a.mode && a.mode !== 'replace' ? ` (${String(a.mode)})` : ''}`,
    async run({ e, host }, a) {
      const r = stepRect(a, e.doc.width, e.doc.height);
      if (!r) throw new Error('The area to select has no size.');
      await host.call('selection.set', [null, { type: a.shape === 'ellipse' ? 'ellipse' : 'rect', ...r }, a.mode ?? 'replace']);
      if (!e.doc.selection) throw new Error('The area to select lies outside the canvas.');
    },
  },
  {
    id: 'op.crop',
    label: 'Crop',
    description: 'Crop the canvas to a rectangle (x, y, width, height) or to the largest area of an aspect ratio such as 16:9, placed by anchor.',
    params: [...rectParams, aspectParam, anchorParam],
    selection: 'clears',
    check: rectCheck,
    describe: (a) => (a.aspect ? `To ${String(a.aspect)}${a.anchor && a.anchor !== 'center' ? `, keeping the ${String(a.anchor)}` : ', centered'}` : `To ${a.width} × ${a.height} px`),
    async run({ e, host }, a) {
      const r = stepRect(a, e.doc.width, e.doc.height);
      if (!r) throw new Error('The crop has no size.');
      await host.call('selection.set', [null, { type: 'rect', ...r }, 'replace']);
      if (!e.doc.selection) throw new Error('The crop area lies outside the canvas.');
      await host.call('commands.run', ['image.crop']);
    },
  },
  {
    id: 'op.resize_image',
    label: 'Resize Image',
    description: 'Resample the whole image to a width and/or height in pixels (the other keeps the proportions) or a percentage.',
    params: [
      { key: 'width', type: 'integer', label: 'Width', min: 1, max: 8192, unit: 'px' },
      { key: 'height', type: 'integer', label: 'Height', min: 1, max: 8192, unit: 'px' },
      { key: 'percent', type: 'number', label: 'Scale', min: 1, max: 800, unit: '%' },
      { key: 'method', type: 'enum', label: 'Resampling', options: [{ value: 'bicubic', label: 'Bicubic' }, { value: 'bicubic-sharper', label: 'Bicubic sharper' }, { value: 'bicubic-smoother', label: 'Bicubic smoother' }, { value: 'lanczos', label: 'Lanczos' }, { value: 'preserve-details', label: 'Preserve details' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'nearest', label: 'Nearest neighbor' }], default: 'bicubic' },
    ],
    check: (a) => (a.width === undefined && a.height === undefined && a.percent === undefined ? ['Give a width, a height or a percentage.'] : []),
    describe: (a) => (a.percent !== undefined ? `To ${a.percent}%` : `To ${a.width ?? 'auto'} × ${a.height ?? 'auto'} px`),
    async run({ e, host }, a) {
      await host.call('documents.activate', []);
      const W = e.doc.width, H = e.doc.height;
      let w = a.width as number | undefined, h = a.height as number | undefined;
      if (a.percent !== undefined) (w = Math.round((W * (a.percent as number)) / 100)), (h = Math.round((H * (a.percent as number)) / 100));
      else if (w === undefined) w = Math.round((W * h!) / H);
      else if (h === undefined) h = Math.round((H * w) / W);
      w = Math.max(1, w!);
      h = Math.max(1, h!);
      if (w > 8192 || h > 8192 || w * h > 24_000_000) throw new Error(`${w} × ${h} px exceeds the document limits (8192 pixels per side, 24 megapixels).`);
      const { resampleDocument } = await import('../transform/image-size');
      resampleDocument(e, w, h, (a.method as never) ?? 'bicubic');
      e.fit();
    },
  },
  {
    id: 'op.add_adjustment_layer',
    label: 'Add Adjustment Layer',
    description: 'Add a non-destructive adjustment layer above the selected layer with settings; when there is a selection it becomes the layer mask (and the selection is dropped).',
    params: [
      { key: 'kind', type: 'enum', label: 'Kind', required: true, options: ADJUSTMENT_KINDS.map((k) => ({ value: k, label: ADJUSTMENT_LABELS[k] })) },
      { key: 'params', type: 'object', label: 'Settings', description: 'see get_details for each kind' },
      { key: 'name', type: 'string', label: 'Name' },
      opacityParam,
      blendParam,
    ],
    selection: 'clears',
    normalize: (a) => {
      const schema = isKind(a.kind) ? ADJUSTMENT_PARAMS[a.kind] : undefined;
      if (!schema || a.params === undefined) return { args: a, notes: [], problems: [] };
      const c = coerceArgs(schema, a.params);
      return { args: { ...a, params: c.value }, notes: c.notes, problems: c.problems };
    },
    describe: (a) => {
      if (!isKind(a.kind)) return '';
      const schema = ADJUSTMENT_PARAMS[a.kind];
      const settings = schema ? summarizeArgs(schema, (a.params ?? {}) as Record<string, unknown>) : a.params ? compactJSON(a.params, 80) : 'default settings';
      return `${ADJUSTMENT_LABELS[a.kind]}${settings ? `: ${settings}` : ''}`;
    },
    async run({ e, host }, a) {
      if (!isKind(a.kind)) throw new Error(`Unknown adjustment ${quote(a.kind)}.`);
      await host.call('documents.activate', []);
      const [{ addAdjustmentLayer }, { specAdjustment }] = await Promise.all([import('../adjust/layers'), import('../adjust/spec')]);
      const adj = specAdjustment({ kind: a.kind, params: adjustmentParams(a.kind, a.params).params });
      if (!adj) throw new Error(`Unknown adjustment ${quote(a.kind)}.`);
      const id = addAdjustmentLayer(e, a.kind, adj);
      const props = pick(a, ['name', 'opacity', 'blendMode']);
      if (Object.keys(props).length) await host.call('layers.set', [null, id, props]);
    },
  },
  {
    id: 'op.layer_style',
    label: 'Layer Style',
    description:
      'Set layer effects on a layer (replacing its style): an object with any of dropShadow, innerShadow, outerGlow, innerGlow, bevel, satin, colorOverlay, stroke. Each holds the settings to change from defaults, e.g. { dropShadow: { distance: 12, size: 24, opacity: 45, angle: 120, color: "#000000" }, stroke: { size: 3, color: "#ffffff", position: "outside" } }; true uses the defaults; null removes the style.',
    params: [layerRef, { key: 'style', type: 'object', label: 'Effects', required: true }],
    check: (a) => {
      const keys = ['dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'bevel', 'satin', 'colorOverlay', 'stroke'];
      const bad = a.style && typeof a.style === 'object' ? Object.keys(a.style).filter((k) => !keys.includes(k)) : [];
      return bad.length ? [`Unknown effect ${bad.map(quote).join(', ')}; use ${keys.join(', ')}.`] : [];
    },
    describe: (a) => {
      const style = a.style && typeof a.style === 'object' ? (a.style as Record<string, unknown>) : undefined;
      const effects = style
        ? Object.entries(style).map(([k, v]) => {
            const name = k.replace(/([A-Z])/g, ' $1').toLowerCase();
            const settings = v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([sk, sv]) => `${sk} ${typeof sv === 'object' ? compactJSON(sv, 20) : String(sv)}`).join(', ') : '';
            return settings ? `${name} (${settings})` : name;
          })
        : [];
      return `${effects.length ? effects.join('; ') : 'No effects'}${a.layer ? ` on ${quote(a.layer)}` : ''}`;
    },
    async run({ host }, a) {
      await host.call('layers.setStyle', [null, await layerId(host, a.layer), a.style ?? null]);
    },
  },
  {
    id: 'op.set_layer',
    label: 'Layer Properties',
    description: 'Change a layer’s name, visibility, opacity, fill opacity or blend mode.',
    params: [layerRef, { key: 'name', type: 'string', label: 'Name' }, { key: 'visible', type: 'boolean', label: 'Visible' }, opacityParam, { key: 'fillOpacity', type: 'number', label: 'Fill', min: 0, max: 100, unit: '%' }, blendParam],
    describe: (a) => summarizeArgs(OPS.find((o) => o.id === 'op.set_layer')!.params, a),
    async run({ host }, a) {
      await host.call('layers.set', [null, await layerId(host, a.layer), pick(a, ['name', 'visible', 'opacity', 'fillOpacity', 'blendMode'])]);
    },
  },
  {
    id: 'op.add_text',
    label: 'Add Text',
    description: 'Add a text layer. size is in pixels; x, y place the top-left corner of the text (centered when omitted).',
    params: [
      { key: 'text', type: 'text', label: 'Text', required: true },
      { key: 'size', type: 'number', label: 'Size', min: 1, max: 5000, unit: 'px' },
      { key: 'color', type: 'color', label: 'Color' },
      { key: 'font', type: 'string', label: 'Font' },
      { key: 'bold', type: 'boolean', label: 'Bold' },
      { key: 'italic', type: 'boolean', label: 'Italic' },
      { key: 'align', type: 'enum', label: 'Align', options: ['left', 'center', 'right'].map((v) => ({ value: v })) },
      { key: 'x', type: 'integer', label: 'Left', unit: 'px' },
      { key: 'y', type: 'integer', label: 'Top', unit: 'px' },
      { key: 'name', type: 'string', label: 'Name' },
    ],
    describe: (a) => `${quote(a.text)}${a.size ? `, ${a.size} px` : ''}${a.color ? `, ${a.color}` : ''}`,
    async run({ host }, a) {
      await host.call('layers.create', [null, { kind: 'text', ...pick(a, ['text', 'size', 'color', 'font', 'bold', 'italic', 'align', 'x', 'y', 'name']) }]);
    },
  },
  {
    id: 'op.add_fill_layer',
    label: 'Add Color Fill Layer',
    description: 'Add a solid color fill layer (for tints use a blend mode and opacity).',
    params: [{ key: 'color', type: 'color', label: 'Color', required: true }, { key: 'name', type: 'string', label: 'Name' }, opacityParam, blendParam],
    describe: (a) => `${a.color}${a.blendMode ? `, ${a.blendMode}` : ''}${a.opacity !== undefined ? `, ${a.opacity}%` : ''}`,
    async run({ host }, a) {
      await host.call('layers.create', [null, { kind: 'fill', ...pick(a, ['color', 'name', 'opacity', 'blendMode']) }]);
    },
  },
  {
    id: 'op.add_shape',
    label: 'Add Shape',
    description:
      'Add a live shape layer: rect, ellipse, triangle, polygon or line. Give x, y, width, height in document pixels. Fill can be a color or a gradient object; a line uses stroke only. Shapes stay editable with the shape tools.',
    params: [
      { key: 'kind', type: 'enum', label: 'Shape', required: true, default: 'rect', options: ['rect', 'ellipse', 'triangle', 'polygon', 'line'].map((value) => ({ value })) },
      { key: 'x', type: 'number', label: 'Left', unit: 'px' },
      { key: 'y', type: 'number', label: 'Top', unit: 'px' },
      { key: 'width', type: 'number', label: 'Width', min: 1, max: 8192, unit: 'px' },
      { key: 'height', type: 'number', label: 'Height', min: 1, max: 8192, unit: 'px' },
      { key: 'x1', type: 'number', label: 'Line start X', unit: 'px' },
      { key: 'y1', type: 'number', label: 'Line start Y', unit: 'px' },
      { key: 'x2', type: 'number', label: 'Line end X', unit: 'px' },
      { key: 'y2', type: 'number', label: 'Line end Y', unit: 'px' },
      { key: 'radius', type: 'number', label: 'Corner radius', min: 0, max: 4096, unit: 'px' },
      { key: 'sides', type: 'integer', label: 'Sides', min: 3, max: 100 },
      { key: 'star', type: 'number', label: 'Star inset', min: 0, max: 0.99 },
      { key: 'smoothIndents', type: 'boolean', label: 'Smooth indents' },
      { key: 'arrowStart', type: 'boolean', label: 'Start arrow' },
      { key: 'arrowEnd', type: 'boolean', label: 'End arrow' },
      { key: 'arrowWidth', type: 'number', label: 'Arrow width', min: 1, unit: 'px' },
      { key: 'arrowLength', type: 'number', label: 'Arrow length', min: 0.1 },
      { key: 'concavity', type: 'number', label: 'Arrow concavity', min: -50, max: 50 },
      { key: 'fill', type: 'color', label: 'Fill' },
      { key: 'gradient', type: 'object', label: 'Gradient fill', description: '{ stops: [{ position: 0, color: "#101820" }, { position: 1, color: "#f3b25b" }], style: "linear", angle: 90 }' },
      { key: 'stroke', type: 'color', label: 'Stroke' },
      { key: 'strokeWidth', type: 'number', label: 'Stroke width', min: 0.1, max: 1000, unit: 'px' },
      { key: 'strokeAlign', type: 'enum', label: 'Stroke alignment', options: ['inside', 'center', 'outside'].map((value) => ({ value })) },
      { key: 'strokeOpacity', type: 'number', label: 'Stroke opacity', min: 0, max: 100, unit: '%' },
      { key: 'name', type: 'string', label: 'Layer name' },
      opacityParam,
      blendParam,
    ],
    check: (a) => {
      const s = readLiveShape(a);
      if ('error' in s) return [s.error];
      const g = a.gradient === undefined ? undefined : readGradient(a.gradient);
      return g && 'error' in g ? [g.error] : [];
    },
    describe: (a) => `${String(a.kind ?? 'shape')}${a.width || a.height ? ` ${a.width ?? '?'} × ${a.height ?? '?'} px` : ''}${a.fill ? `, ${String(a.fill)}` : ''}${a.stroke ? `, stroke ${String(a.stroke)}` : ''}`,
    async run({ e }, a) {
      const r = addShape(e, a);
      if ('error' in r) throw new Error(r.error);
    },
  },
  {
    id: 'op.add_path',
    label: 'Add Path',
    description:
      'Add a freeform pen path as a vector shape: points are [x, y] pairs or { x, y, smooth, in, out } in document pixels. Closed paths can be filled; open paths use a stroke. Use this for a bottle silhouette or other drawn artwork.',
    params: [
      { key: 'points', type: 'object', label: 'Points', required: true, description: 'An array of [x,y] or {x,y,smooth,in,out} points' },
      { key: 'closed', type: 'boolean', label: 'Closed', default: true },
      { key: 'fill', type: 'color', label: 'Fill' },
      { key: 'gradient', type: 'object', label: 'Gradient fill', description: '{ stops, style, angle } like Add Shape' },
      { key: 'stroke', type: 'color', label: 'Stroke' },
      { key: 'strokeWidth', type: 'number', label: 'Stroke width', min: 0.1, max: 1000, unit: 'px' },
      { key: 'strokeAlign', type: 'enum', label: 'Stroke alignment', options: ['inside', 'center', 'outside'].map((value) => ({ value })) },
      { key: 'strokeOpacity', type: 'number', label: 'Stroke opacity', min: 0, max: 100, unit: '%' },
      { key: 'name', type: 'string', label: 'Layer name' },
      opacityParam,
      blendParam,
    ],
    check: (a) => {
      const p = readPath(a.points, a.closed !== false);
      if ('error' in p) return [p.error];
      const g = a.gradient === undefined ? undefined : readGradient(a.gradient);
      return g && 'error' in g ? [g.error] : [];
    },
    describe: (a) => `${a.closed === false ? 'Open' : 'Closed'} path${Array.isArray(a.points) ? `, ${a.points.length} points` : ''}${a.name ? `: ${quote(a.name)}` : ''}`,
    async run({ e }, a) {
      const r = addPath(e, a);
      if ('error' in r) throw new Error(r.error);
    },
  },
  {
    id: 'op.add_gradient_layer',
    label: 'Add Gradient Fill Layer',
    description:
      'Add a non-destructive gradient fill layer over the whole canvas (or mask it to the active selection). Stops are { position, color, opacity }; position 0..1 (0..100 also works), opacity 0..100. Use for skies, fog, glow and color grading.',
    params: [
      { key: 'gradient', type: 'object', label: 'Gradient', required: true, description: '{ stops: [...], style: "linear"|"radial"|"angle"|"reflected"|"diamond", angle, reverse, scale }' },
      { key: 'name', type: 'string', label: 'Layer name' },
      opacityParam,
      blendParam,
    ],
    selection: 'clears',
    check: (a) => {
      const g = readGradient(a.gradient);
      return 'error' in g ? [g.error] : [];
    },
    describe: (a) => {
      const g = a.gradient && typeof a.gradient === 'object' ? (a.gradient as Record<string, unknown>) : {};
      return `${String(g.style ?? 'linear')} gradient${Array.isArray(g.stops) ? `, ${g.stops.length} stops` : ''}${a.blendMode ? `, ${String(a.blendMode)}` : ''}${a.opacity !== undefined ? `, ${String(a.opacity)}%` : ''}`;
    },
    async run({ e }, a) {
      const r = addGradientLayer(e, a);
      if ('error' in r) throw new Error(r.error);
    },
  },
  {
    id: 'op.paint',
    label: 'Paint Strokes',
    description:
      'Paint one or more raster brush strokes with the app’s paint engine on the selected pixel layer (a new pixel layer is added when the selected layer is not paintable). points is one polyline, paths is several; each point is [x,y]. Soft large brushes with scatter and jitter make fog, glow and particle fields; small hard brushes make details.',
    params: [
      layerRef,
      { key: 'points', type: 'object', label: 'Points', description: 'One polyline: [[x,y], ...]' },
      { key: 'paths', type: 'object', label: 'Several strokes', description: 'Several polylines: [[[x,y], ...], ...]' },
      { key: 'color', type: 'color', label: 'Color' },
      { key: 'size', type: 'number', label: 'Brush size', min: 0.5, max: 2500, unit: 'px' },
      { key: 'hardness', type: 'number', label: 'Hardness', min: 0, max: 1 },
      { key: 'opacity', type: 'number', label: 'Opacity', min: 0, max: 100, unit: '%' },
      { key: 'flow', type: 'number', label: 'Flow', min: 0, max: 100, unit: '%' },
      { key: 'spacing', type: 'number', label: 'Spacing', min: 0.01, max: 4 },
      { key: 'roundness', type: 'number', label: 'Roundness', min: 0.01, max: 1 },
      { key: 'angle', type: 'number', label: 'Angle', unit: '°' },
      blendParam,
      { key: 'erase', type: 'boolean', label: 'Erase' },
      { key: 'scatter', type: 'number', label: 'Scatter', min: 0, max: 10 },
      { key: 'count', type: 'integer', label: 'Dabs per stamp', min: 1, max: 200 },
      { key: 'sizeJitter', type: 'number', label: 'Size jitter', min: 0, max: 1 },
      { key: 'opacityJitter', type: 'number', label: 'Opacity jitter', min: 0, max: 1 },
      { key: 'angleJitter', type: 'number', label: 'Angle jitter', min: 0, max: 1 },
      { key: 'flowJitter', type: 'number', label: 'Flow jitter', min: 0, max: 1 },
      { key: 'roundnessJitter', type: 'number', label: 'Roundness jitter', min: 0, max: 1 },
      { key: 'pressureSize', type: 'boolean', label: 'Pressure controls size' },
      { key: 'pressureOpacity', type: 'boolean', label: 'Pressure controls opacity' },
      { key: 'seed', type: 'integer', label: 'Random seed', min: 1 },
      { key: 'name', type: 'string', label: 'New layer name' },
    ],
    check: (a) => {
      const p = readPaintPaths(a);
      return 'error' in p ? [p.error] : [];
    },
    describe: (a) => {
      const paths = Array.isArray(a.paths) ? a.paths.length : Array.isArray(a.points) ? 1 : 0;
      return `${paths ? `${paths} stroke${paths === 1 ? '' : 's'}` : 'Strokes'}${a.size ? `, ${String(a.size)} px` : ''}${a.color ? `, ${String(a.color)}` : ''}${a.erase ? ', erasing' : ''}`;
    },
    async run({ e }, a) {
      const r = await paintStrokes(e, a);
      if (r && 'error' in r) throw new Error(r.error);
    },
  },
  {
    id: 'op.add_layer',
    label: 'Add Layer',
    description: 'Add an empty pixel layer (or one filled with a color) above the selected layer.',
    params: [{ key: 'name', type: 'string', label: 'Name' }, { key: 'fill', type: 'color', label: 'Fill' }, opacityParam, blendParam],
    describe: (a) => `${a.name ? quote(a.name) : 'New layer'}${a.fill ? `, filled ${a.fill}` : ''}`,
    async run({ host }, a) {
      await host.call('layers.create', [null, { kind: 'pixel', ...pick(a, ['name', 'fill', 'opacity', 'blendMode']) }]);
    },
  },
  {
    id: 'op.select_layer',
    label: 'Select Layer',
    description: 'Make a layer the selected layer, so the next steps act on it.',
    params: [{ ...layerRef, required: true, description: 'Layer name or ID' }],
    describe: (a) => quote(a.layer),
    async run({ host }, a) {
      await host.call('layers.select', [null, [await layerId(host, a.layer)]]);
    },
  },
  {
    id: 'op.move_layer',
    label: 'Move Layer',
    description: 'Move a layer by dx, dy pixels.',
    params: [layerRef, { key: 'dx', type: 'number', label: 'Horizontal', unit: 'px' }, { key: 'dy', type: 'number', label: 'Vertical', unit: 'px' }],
    describe: (a) => `By ${a.dx ?? 0}, ${a.dy ?? 0} px`,
    async run({ host }, a) {
      await host.call('layers.translate', [null, await layerId(host, a.layer), a.dx ?? 0, a.dy ?? 0]);
    },
  },
  {
    id: 'op.arrange_layer',
    label: 'Arrange Layer',
    description: 'Move a layer in the stack: top, bottom, up or down.',
    params: [layerRef, { key: 'where', type: 'enum', label: 'To', required: true, options: ['top', 'bottom', 'up', 'down'].map((v) => ({ value: v })) }],
    describe: (a) => `${a.layer ? `${quote(a.layer)} ` : ''}to the ${String(a.where)}`.replace('to the up', 'up').replace('to the down', 'down'),
    async run({ host }, a) {
      await host.call('layers.arrange', [null, await layerId(host, a.layer), a.where]);
    },
  },
  {
    id: 'op.duplicate_layer',
    label: 'Duplicate Layer',
    description: 'Duplicate a layer (the copy goes above it).',
    params: [layerRef],
    describe: (a) => (a.layer ? quote(a.layer) : 'The selected layer'),
    async run({ host }, a) {
      const info = (await host.call('layers.duplicate', [null, await layerId(host, a.layer)])) as { id: string };
      await host.call('layers.select', [null, [info.id]]);
    },
  },
  {
    id: 'op.delete_layer',
    label: 'Delete Layer',
    description: 'Delete a layer.',
    params: [{ ...layerRef, required: true, description: 'Layer name or ID' }],
    describe: (a) => quote(a.layer),
    async run({ host }, a) {
      await host.call('layers.remove', [null, await layerId(host, a.layer)]);
    },
  },
  {
    id: 'op.export',
    label: 'Export Flattened Image',
    description:
      'Download a flattened image of the document directly, without a save dialog. Use png for lossless artwork; quality applies to jpeg/webp, scale or width/height resizes the export. This is the flattened companion to Download Project.',
    params: [
      { key: 'format', type: 'enum', label: 'Format', default: 'png', options: ['png', 'jpeg', 'webp'].map((value) => ({ value })) },
      { key: 'quality', type: 'integer', label: 'Quality', min: 1, max: 100 },
      { key: 'scale', type: 'number', label: 'Scale', min: 0.01, max: 8 },
      { key: 'width', type: 'integer', label: 'Width', min: 1, max: 8192, unit: 'px' },
      { key: 'height', type: 'integer', label: 'Height', min: 1, max: 8192, unit: 'px' },
      { key: 'name', type: 'string', label: 'File name' },
    ],
    describe: (a) => `${String(a.format ?? 'png').toUpperCase()}${a.scale ? ` at ${String(a.scale)}×` : a.width || a.height ? ` at ${a.width ?? 'auto'} × ${a.height ?? 'auto'} px` : ''}${a.name ? `: ${quote(a.name)}` : ''}`,
    async run({ host }, a) {
      const out = (await host.call('documents.export', [null, { format: a.format ?? 'png', ...pick(a, ['quality', 'scale', 'width', 'height', 'name']) }])) as { data: Uint8Array; type: string; name: string };
      const { download } = await import('../../persistence/puter');
      const bytes = out.data instanceof Uint8Array ? out.data : new Uint8Array(out.data);
      download(new Blob([bytes.buffer as ArrayBuffer], { type: out.type }), out.name);
      await host.call('app.message', [`Exported ${out.name}`]);
    },
  },
  {
    id: 'op.download_project',
    label: 'Download Layered Project',
    description: 'Download the layered .photo project file directly, without a save dialog. Every layer, group, mask, Smart Object and adjustment stays editable when it is opened again.',
    params: [],
    describe: () => 'Layered .photo project',
    async run({ e }) {
      const { downloadProject } = await import('../files/save');
      await downloadProject(e);
    },
  },
  {
    id: 'op.set_colors',
    label: 'Set Colors',
    description: 'Set the foreground and/or background color used by painting and fill commands.',
    params: [{ key: 'foreground', type: 'color', label: 'Foreground' }, { key: 'background', type: 'color', label: 'Background' }],
    check: (a) => (a.foreground === undefined && a.background === undefined ? ['Give a foreground or background color.'] : []),
    describe: (a) => [a.foreground && `foreground ${a.foreground}`, a.background && `background ${a.background}`].filter(Boolean).join(', '),
    async run({ e }, a) {
      if (typeof a.foreground === 'string') e.setForeground(parseColor(a.foreground)!);
      if (typeof a.background === 'string') e.setBackground(parseColor(a.background)!);
    },
  },
];
export const opById = new Map(OPS.map((o) => [o.id, o]));
