/**
 * Turning drawing undo records into the ops sent to the live server, and the
 * small helpers both sides agree on. No DOM here, so tests and the server's
 * test suite can use it.
 *
 * Ops are absolute values, last writer wins:
 *   { k: 'ent', id, v: ent | null }
 *   { k: 'table', table, key, v: obj | null }
 *   { k: 'block', key, v: block | null }
 *   { k: 'header', patch }            (nextId is never sent)
 *   { k: 'order', ids, front }        move ids to the front (drawn last) or back
 */

/** entries: [{ rec, reverse }] from Drawing.opsListener */
export function recordsToOps(entries) {
  const ops = [];
  for (const { rec, reverse } of entries) {
    switch (rec.kind) {
      case 'ent':
        ops.push({ k: 'ent', id: rec.id, v: (reverse ? rec.before : rec.after) ?? null });
        break;
      case 'table':
        ops.push({ k: 'table', table: rec.table, key: rec.key, v: (reverse ? rec.before : rec.after) ?? null });
        break;
      case 'block':
        ops.push({ k: 'block', key: rec.key, v: (reverse ? rec.before : rec.after) ?? null });
        break;
      case 'header': {
        const from = reverse ? rec.after : rec.before;
        const to = reverse ? rec.before : rec.after;
        const patch = {};
        for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) {
          if (k === 'nextId' || from[k] === to[k]) continue;
          patch[k] = to[k] === undefined ? null : to[k];
        }
        if (Object.keys(patch).length) ops.push({ k: 'header', patch });
        break;
      }
      case 'order':
        if (rec.ids) ops.push({ k: 'order', ids: rec.ids, front: reverse ? !rec.toFront : !!rec.toFront });
        break;
    }
  }
  return ops;
}

/** Keys an op writes, for "is this still waiting for the server?" checks. */
export function opKeys(op) {
  switch (op.k) {
    case 'ent':
      return [`e:${op.id}`];
    case 'table':
      return [`t:${op.table}:${op.key}`];
    case 'block':
      return [`b:${op.key}`];
    case 'header':
      return Object.keys(op.patch).map((k) => `h:${k}`);
    default:
      return [];
  }
}

/**
 * Drop the parts of remote ops that touch keys we changed and the server has
 * not confirmed yet: the server applies our later change after theirs.
 */
export function filterPending(ops, pending) {
  if (!pending.size) return ops;
  const out = [];
  for (const op of ops) {
    if (op.k === 'header') {
      const patch = {};
      let any = false;
      for (const [k, v] of Object.entries(op.patch)) {
        if (pending.has(`h:${k}`)) continue;
        patch[k] = v;
        any = true;
      }
      if (any) out.push({ k: 'header', patch });
      continue;
    }
    if (opKeys(op).some((key) => pending.has(key))) continue;
    out.push(op);
  }
  return out;
}

/** FNV-1a over the entity id order; lib/cadfile.js on the server computes the same. */
export function orderDigest(ids) {
  let h = 0x811c9dc5;
  for (const id of ids) {
    const s = `${id},`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16);
}
