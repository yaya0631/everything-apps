/**
 * The other people in a live drawing: stable colours, latest presence and
 * the avatar stack for the title bar. Cursor arrows and selection outlines
 * are drawn by Overlay.drawRemote. Guests and signed-in people both get a
 * colour derived from their connection id.
 */
import { h, clear } from '../ui/dom.js';

const PEER_COLORS = ['#e5484d', '#f76b15', '#e2a336', '#46a758', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#ab6400'];

export function peerColor(cid) {
  let n = 0;
  for (const ch of String(cid)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return PEER_COLORS[n % PEER_COLORS.length];
}

export function initials(name) {
  return String(name)
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** {cid, name, color, mode, cursor, sel} for every other person in the room. */
export function decorate(peers) {
  return (peers || []).map((p) => ({ ...p, color: peerColor(p.cid) }));
}

/** The avatar stack shown next to the account control while a drawing is live. */
export function avatarStack(onPick) {
  const el = h('div.peer-avatars', { role: 'group', 'aria-label': 'People in this drawing', hidden: true });
  let shown = [];
  el.render = (peers) => {
    const list = decorate(peers).slice(0, 5);
    const extra = (peers || []).length - list.length;
    clear(el);
    shown = list.filter((p) => p.cursor);
    el.hidden = !(peers || []).length;
    for (const p of list) {
      el.append(
        h(
          'button.avatar.sm.peer',
          {
            type: 'button',
            style: { '--peer-color': p.color },
            'data-tip': p.mode === 'view' ? `${p.name} (view only)` : p.name,
            'aria-label': `${p.name}${p.mode === 'view' ? ' (view only)' : ''}`,
            onClick: () => onPick?.(p),
          },
          h('span', initials(p.name)),
        ),
      );
    }
    if (extra > 0) el.append(h('span.avatar.sm.peer.more', { 'data-tip': `${extra} more` }, `+${extra}`));
  };
  return el;
}
