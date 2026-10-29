/**
 * The whiteboard agent: a small, inspectable tool loop over board objects.
 * The model asks for one tool per turn as JSON; every write uses the same
 * mutate() path, edit checks and undo history as the board's own controls.
 */
import { bounds, item, MAX_OBJECTS, COLORS } from "../model.js";
import { createFrame, removeItems } from "../scene.js";
import { fieldContent } from "../facilitation/authored-field.js";

export const AGENT_ROUNDS = 8;
export const AGENT_NOTES = 40;

const COLOR_NAMES = {
  yellow: COLORS[0],
  green: COLORS[1],
  blue: COLORS[2],
  purple: COLORS[3],
  pink: COLORS[4],
  orange: COLORS[4],
  white: COLORS[5],
};
export function colorFor(name) {
  const key = String(name || "").toLowerCase();
  return Object.hasOwn(COLOR_NAMES, key) ? COLOR_NAMES[key] : COLORS[0];
}

const TOOL_NAMES = new Set([
  "get_board",
  "find_objects",
  "read_object",
  "add_notes",
  "update_objects",
  "delete_objects",
  "create_frame",
  "arrange_grid",
  "finish",
]);

// Keys that describe the call itself, never tool arguments.
const META_KEYS = new Set([
  "tool",
  "type",
  "action",
  "name",
  "function",
  "args",
  "arguments",
  "message",
]);

/** Read an args/arguments field, whether the model sent an object or a JSON string. */
function toolArguments(value) {
  let args = {};
  if (!value || typeof value !== "object") return args;
  for (const candidate of [value.args, value.arguments]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate))
      args = { ...args, ...candidate };
    else if (typeof candidate === "string" && candidate.trim()) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          args = { ...args, ...parsed };
      } catch {
        /* not an arguments object */
      }
    }
  }
  return args;
}

/** Normalize one parsed value into { tool, args } or null when it is not a tool call. */
function normalizeTool(value) {
  // Some providers wrap a single call in an array.
  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = normalizeTool(entry);
      if (normalized) return normalized;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  // OpenAI-style tool_calls.
  if (Array.isArray(value.tool_calls)) {
    for (const call of value.tool_calls) {
      const fn = call?.function || call;
      if (typeof fn?.name !== "string" || !TOOL_NAMES.has(fn.name)) continue;
      return { tool: fn.name, args: toolArguments(fn) };
    }
  }
  let tool = null;
  if (typeof value.tool === "string" && value.tool.trim())
    tool = value.tool.trim();
  else if (typeof value.type === "string" && TOOL_NAMES.has(value.type))
    tool = value.type;
  else if (typeof value.action === "string" && TOOL_NAMES.has(value.action))
    tool = value.action;
  else if (typeof value.name === "string" && TOOL_NAMES.has(value.name))
    tool = value.name;
  else if (
    value.function &&
    typeof value.function === "object" &&
    typeof value.function.name === "string" &&
    TOOL_NAMES.has(value.function.name)
  )
    tool = value.function.name;
  if (!tool) return null;
  let args = toolArguments(value);
  if (value.function && typeof value.function === "object")
    args = { ...toolArguments(value.function), ...args };
  // Top-level keys that are not meta become arguments, so
  // {"type":"add_notes","notes":[...]} works as well as {"tool":"add_notes","args":{notes:[...]}}.
  for (const [key, val] of Object.entries(value)) {
    if (META_KEYS.has(key)) continue;
    if (!(key in args)) args[key] = val;
  }
  // A finish call carries its message as a meta field, not an argument.
  if (tool === "finish" && typeof args.message !== "string" && typeof value.message === "string")
    args.message = value.message;
  return { tool, args };
}

/** Read a reply as one { tool, args } object, or { message } when it is prose. */
export function parseAgentReply(text) {
  const source = String(text || "").trim();
  if (!source) throw Error("The AI returned nothing.");
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    value = null;
  }
  if (value) {
    const normalized = normalizeTool(value);
    if (normalized) return normalized;
    if (typeof value.message === "string")
      return { tool: "finish", args: { message: value.message } };
  }
  // A JSON object wrapped in prose or a code fence.
  const start = source.indexOf("{"),
    end = source.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      value = JSON.parse(source.slice(start, end + 1));
      const normalized = normalizeTool(value);
      if (normalized) return normalized;
      if (value && typeof value.message === "string")
        return { tool: "finish", args: { message: value.message } };
    } catch {}
  }
  return { tool: "finish", args: { message: source.slice(0, 4000) } };
}

/** A compact object for the model, never the whole board. */
function brief(i, selected) {
  const text = String(i.text || "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    id: i.id,
    type: i.type,
    text: text.length > 300 ? `${text.slice(0, 300)}...` : text,
    x: Math.round(i.x),
    y: Math.round(i.y),
    w: Math.round(i.w),
    h: Math.round(i.h),
    ...(i.color ? { color: i.color } : {}),
    ...(i.parentId ? { parentId: i.parentId } : {}),
    ...(selected ? { selected: true } : {}),
  };
}

/** Accept either the live board context or a plain snapshot. */
function boardOf(ctx) {
  return typeof ctx.board === "function" ? ctx.board() : ctx.board;
}
function itemsOf(ctx) {
  const b = boardOf(ctx);
  return (
    (typeof ctx.view === "function" ? ctx.view()?.items : ctx.view?.items) ||
    b.items
  );
}
function selectionOf(ctx) {
  const value =
    typeof ctx.selection === "function" ? ctx.selection() : ctx.selection;
  return new Set(value || []);
}

export function boardInfo(ctx) {
  const items = itemsOf(ctx);
  const counts = {};
  for (const i of items) counts[i.type] = (counts[i.type] || 0) + 1;
  const selected = selectionOf(ctx);
  const box = bounds(items);
  return {
    title: boardOf(ctx).title || "Untitled board",
    objects: items.length,
    counts,
    selected: selected.size,
    bounds: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      w: Math.round(box.w),
      h: Math.round(box.h),
    },
  };
}

export function findObjects(ctx, args = {}) {
  const items = itemsOf(ctx);
  const selected = selectionOf(ctx);
  const query = String(args.query || "")
    .trim()
    .toLowerCase();
  const type = String(args.type || "")
    .trim()
    .toLowerCase();
  const frame = args.frame === undefined ? null : String(args.frame);
  const limit = Math.max(
    1,
    Math.min(200, Math.round(Number(args.limit) || 60)),
  );
  const found = items.filter((i) => {
    if (type && i.type !== type) return false;
    if (frame !== null && String(i.parentId || "") !== frame) return false;
    if (args.selected === true && !selected.has(i.id)) return false;
    if (
      query &&
      !`${i.text || ""}\n${i.url || ""}\n${i.fileName || ""}`
        .toLowerCase()
        .includes(query)
    )
      return false;
    return true;
  });
  return {
    total: found.length,
    items: found.slice(0, limit).map((i) => brief(i, selected.has(i.id))),
  };
}

export function readObject(ctx, id) {
  const items = itemsOf(ctx);
  const found = items.find((i) => i.id === String(id));
  if (!found) throw Error("There is no object with that id on the board.");
  return {
    ...brief(found, selectionOf(ctx).has(found.id)),
    text: String(found.text || "").slice(0, 20000),
  };
}

function editable(ctx, ids) {
  if (!ctx.canEdit(new Set(ids)))
    throw Error("Those objects cannot be changed on this board.");
}

function visibleIds(ctx) {
  return new Set(itemsOf(ctx).map((i) => i.id));
}

function itemContent(text, language) {
  const value = String(text ?? "").slice(0, 2000);
  return fieldContent(
    { value, ...(language ? { lang: language } : {}) },
    0,
    value.length,
  );
}

export function addNotes(ctx, args = {}) {
  const list = (Array.isArray(args.notes) ? args.notes : [])
    .filter((n) => n && String(n.text ?? "").trim())
    .slice(0, AGENT_NOTES);
  if (!list.length) throw Error("Give at least one sticky note with text.");
  const b = ctx.board();
  if (b.items.length + list.length > MAX_OBJECTS)
    throw Error(`This would exceed the board limit of ${MAX_OBJECTS} objects.`);
  if (!ctx.canEdit(new Set())) throw Error("This board is read-only.");
  const c = ctx.center(),
    columns = Math.max(1, Math.min(8, Math.round(Number(args.columns) || 4)));
  const origin = {
    x: Number.isFinite(Number(args.x))
      ? Number(args.x)
      : c.x - (columns * 230) / 2,
    y: Number.isFinite(Number(args.y)) ? Number(args.y) : c.y - 200,
  };
  const created = list.map((n, index) =>
    item(
      "note",
      origin.x + (index % columns) * 230,
      origin.y + Math.floor(index / columns) * 210,
      {
        ...itemContent(n.text, n.lang || ctx.language),
        color: colorFor(n.color),
        w: 210,
        h: 190,
      },
    ),
  );
  ctx.mutate(() => b.items.push(...created));
  const ids = created.map((i) => i.id);
  if (!ids.every((id) => b.items.some((i) => i.id === id)))
    throw Error("The board refused the new notes.");
  ctx.select(new Set(ids));
  return { added: ids.length, ids };
}

export function updateObjects(ctx, args = {}) {
  const patches = (Array.isArray(args.objects) ? args.objects : [])
    .filter((p) => p && p.id)
    .slice(0, 50);
  if (!patches.length)
    throw Error("Give at least one object with an id to update.");
  const b = ctx.board();
  const ids = patches.map((p) => String(p.id));
  const visible = visibleIds(ctx);
  if (ids.some((id) => !visible.has(id)))
    throw Error("One of those object ids is not on the board.");
  const found = ids.map((id) => b.items.find((i) => i.id === id));
  if (found.some((i) => !i))
    throw Error("One of those object ids is not on the board.");
  editable(ctx, ids);
  ctx.mutate(() => {
    for (const [index, patch] of patches.entries()) {
      const i = found[index];
      if (
        patch.text !== undefined &&
        ["note", "text", "frame"].includes(i.type)
      ) {
        const content = itemContent(patch.text, patch.lang || ctx.language);
        delete i.textRuns;
        delete i.fieldLanguage;
        Object.assign(i, content);
      }
      if (
        patch.color !== undefined &&
        ["note", "text", "rect", "ellipse", "frame"].includes(i.type)
      )
        i.color = colorFor(patch.color);
      if (i.type !== "frame") {
        if (Number.isFinite(Number(patch.x))) i.x = Number(patch.x);
        if (Number.isFinite(Number(patch.y))) i.y = Number(patch.y);
        if (Number.isFinite(Number(patch.w)) && Number(patch.w) > 0)
          i.w = Number(patch.w);
        if (Number.isFinite(Number(patch.h)) && Number(patch.h) > 0)
          i.h = Number(patch.h);
      }
    }
  });
  return { changed: found.map((i) => i.id) };
}

export function deleteObjects(ctx, args = {}) {
  const ids = (Array.isArray(args.ids) ? args.ids : [])
    .map(String)
    .slice(0, 100);
  if (!ids.length) throw Error("Give at least one object id to delete.");
  const b = ctx.board();
  if (ids.some((id) => !visibleIds(ctx).has(id)))
    throw Error("One of those object ids is not on the board.");
  editable(ctx, ids);
  ctx.mutate(() => (b.items = removeItems(b.items, new Set(ids))));
  return { deleted: ids.length };
}

export function createSection(ctx, args = {}) {
  const b = ctx.board();
  const ids = new Set(
    (Array.isArray(args.ids) ? args.ids : [...(ctx.selection() || [])]).map(
      String,
    ),
  );
  if (!ids.size) throw Error("Choose the objects that belong in the frame.");
  if ([...ids].some((id) => !visibleIds(ctx).has(id)))
    throw Error("One of those object ids is not on the board.");
  editable(ctx, [...ids]);
  const title =
    String(args.title || "Section")
      .trim()
      .slice(0, 120) || "Section";
  let frame;
  ctx.mutate(() => (frame = createFrame(b.items, ids, title)));
  if (!frame) throw Error("The frame could not be created.");
  ctx.select(new Set([frame.id]));
  return { id: frame.id, title: frame.text, attached: ids.size };
}

export function arrangeGrid(ctx, args = {}) {
  const b = ctx.board();
  const ids = new Set(
    (Array.isArray(args.ids) ? args.ids : [...(ctx.selection() || [])]).map(
      String,
    ),
  );
  if (!ids.size) throw Error("Choose the objects to arrange.");
  const visible = visibleIds(ctx);
  const chosen = b.items.filter(
    (i) =>
      ids.has(i.id) && visible.has(i.id) && i.type !== "frame" && !i.locked,
  );
  if (!chosen.length)
    throw Error("There are no movable objects in that selection.");
  editable(
    ctx,
    chosen.map((i) => i.id),
  );
  const box = bounds(chosen),
    columns = Math.max(
      1,
      Math.min(
        8,
        Math.round(Number(args.columns) || Math.ceil(Math.sqrt(chosen.length))),
      ),
    );
  const gap = Math.max(20, Math.min(200, Math.round(Number(args.gap) || 40)));
  const x0 = Number.isFinite(Number(args.x)) ? Number(args.x) : box.x,
    y0 = Number.isFinite(Number(args.y)) ? Number(args.y) : box.y;
  const cellW = Math.max(...chosen.map((i) => i.w)) + gap,
    cellH = Math.max(...chosen.map((i) => i.h)) + gap;
  ctx.mutate(() =>
    chosen.forEach((i, index) => {
      i.x = x0 + (index % columns) * cellW;
      i.y = y0 + Math.floor(index / columns) * cellH;
    }),
  );
  return { arranged: chosen.length, columns };
}

/** Run one tool call; every failure is a readable result so the model can correct it. */
export function executeBoardTool(name, args, ctx) {
  try {
    switch (name) {
      case "get_board":
        return { ok: true, result: boardInfo(ctx) };
      case "find_objects":
        return { ok: true, result: findObjects(ctx, args) };
      case "read_object":
        return { ok: true, result: readObject(ctx, args.id) };
      case "add_notes":
        return { ok: true, result: addNotes(ctx, args) };
      case "update_objects":
        return { ok: true, result: updateObjects(ctx, args) };
      case "delete_objects":
        return { ok: true, result: deleteObjects(ctx, args) };
      case "create_frame":
        return { ok: true, result: createSection(ctx, args) };
      case "arrange_grid":
        return { ok: true, result: arrangeGrid(ctx, args) };
      default:
        return { ok: false, error: `There is no tool called ${name}.` };
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export const AGENT_TOOLS = `Tools, one per reply:
- get_board {} - title, object counts and bounds.
- find_objects {query?, type?, selected?, limit?} - ids and short text; type is note, text, frame, image, shape, arrow...
- read_object {id} - the full text of one object.
- add_notes {notes:[{text, color?}], columns?, x?, y?} - up to ${AGENT_NOTES} sticky notes; colors: yellow, green, blue, purple, pink, orange, white.
- update_objects {objects:[{id, text?, color?, x?, y?, w?, h?}]} - change up to 50 objects.
- delete_objects {ids:[...]} - delete up to 100 objects.
- create_frame {ids:[...], title} - put objects in a titled frame.
- arrange_grid {ids:[...], columns?, gap?} - lay objects out in a grid.
- finish {message} - stop and tell the person what changed.`;
