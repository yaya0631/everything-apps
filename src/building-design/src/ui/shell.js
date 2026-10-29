/**
 * Application chrome: title bar with the application menu and quick access
 * toolbar, ribbon slot, options bar, docked Properties and Project Browser,
 * view tabs, the canvas with navigation bar and orientation cube, the view
 * control bar, the status bar and the phone toolbar.
 */
import { h, MOD } from './dom.js';
import { icon } from './icons.js';
import { commandTip } from './ribbon.js';

export const REPO_URL = 'https://github.com/HeyPuter/everything';

export function buildShell(app) {
  const qat = (cmd, size = 17) => {
    const d = app.commandDef(cmd);
    return h('button.icon-btn.qat-btn', { type: 'button', 'aria-label': d.label, ...commandTip(d), onClick: () => app.run(cmd) }, icon(d.icon, size));
  };
  const undoBtn = qat('undo');
  const redoBtn = qat('redo');
  const appBtn = h('button.app-btn', { type: 'button', 'aria-label': 'File menu', 'aria-haspopup': 'menu', 'data-tip': 'File', onClick: (e) => app.appMenu(e.currentTarget) }, icon('logo', 16), h('span', 'File'));
  const title = h('div.title', { 'aria-live': 'polite' });
  const search = h(
    'button.search-btn',
    { type: 'button', 'aria-haspopup': 'dialog', 'aria-keyshortcuts': `${MOD === 'Cmd' ? 'Meta' : 'Control'}+K`, 'data-tip': 'Search commands', 'data-tip-keys': `${MOD}+K`, onClick: () => app.run('search') },
    icon('search', 15),
    h('span.search-text', 'Search commands'),
    h('kbd', `${MOD} K`),
  );
  const themeBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Theme', 'aria-haspopup': 'menu', 'data-tip': 'Theme', onClick: (e) => app.themeMenu(e.currentTarget) }, icon('monitor', 17));
  const assistantBtn = h(
    'button.btn.sm.assistant-btn',
    { type: 'button', 'aria-label': 'Assistant', 'aria-pressed': 'false', 'data-tip': 'AI assistant', onClick: () => app.togglePane('assistant') },
    icon('sparkles', 15),
    h('span.hide-phone', 'Assistant'),
  );
  const helpBtn = h('button.icon-btn.hide-phone', { type: 'button', 'aria-label': 'Help', 'data-tip': 'Help', 'data-tip-keys': 'F1', onClick: () => app.run('help') }, icon('help', 17));
  const code = h('a.icon-btn.hide-phone', { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Source code (opens in a new tab)', 'data-tip': 'Source code' }, icon('code', 17));
  const account = h('div.account');
  const titlebar = h(
    'header.titlebar',
    h(
      'div.tb-left',
      appBtn,
      h(
        'div.qat',
        { role: 'toolbar', 'aria-label': 'Quick access' },
        h('span.hide-phone', { style: { display: 'contents' } }, qat('open'), qat('save')),
        undoBtn,
        redoBtn,
        h('span.qat-sep.hide-phone'),
        h('span.hide-phone', { style: { display: 'contents' } }, qat('measure'), qat('dimension'), qat('text'), h('span.qat-sep'), qat('view3d'), qat('section'), qat('thinLines'), qat('closeInactive')),
      ),
    ),
    title,
    h('div.tb-right', search, assistantBtn, themeBtn, helpBtn, code, account),
  );

  const optionsbar = h('div.optionsbar', { role: 'toolbar', 'aria-label': 'Options' });

  // Docked panes
  const propsTitle = h('h2.pane-title', { id: 'props-title' }, 'Properties');
  const propsClose = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Hide Properties', 'data-tip': 'Hide Properties', onClick: () => app.togglePane('props') }, icon('x', 15));
  const propsBody = h('div.pane-body');
  const paneProps = h('section.pane.pane-props', { 'aria-labelledby': 'props-title' }, h('div.pane-head', propsTitle, propsClose), propsBody);

  const browserTitle = h('h2.pane-title.sr-only', { id: 'browser-title' }, 'Project Browser');
  const browserBody = h('div.pane-body');
  const browserSearch = h('input.input', { type: 'search', placeholder: 'Search views, sheets and types', 'aria-label': 'Search the project browser' });
  const browserPanel = h('div.tab-panel.browser-panel', { id: 'browser-panel', role: 'tabpanel', 'aria-labelledby': 'tab-browser' }, browserTitle, h('div.browser-search', browserSearch), browserBody);
  const tabBrowser = h(
    'button.dock-tab',
    { type: 'button', role: 'tab', id: 'tab-browser', 'aria-selected': 'true', 'aria-controls': 'browser-panel', tabindex: '0', 'data-tip': 'Project Browser', onClick: () => app.selectDockTab('browser') },
    icon('layers', 14),
    h('span', 'Browser'),
  );
  const tabAssistant = h(
    'button.dock-tab',
    { type: 'button', role: 'tab', id: 'tab-assistant', 'aria-selected': 'false', 'aria-controls': 'assistant-panel', tabindex: '-1', 'data-tip': 'Assistant', onClick: () => app.selectDockTab('assistant') },
    icon('sparkles', 14),
    h('span', 'Assistant'),
  );
  const tablist = h('div.dock-tabs', { role: 'tablist', 'aria-label': 'Project panels', onKeydown: (e) => app.dockTabKey(e) }, tabBrowser, tabAssistant);
  const lowerClose = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Hide project panels', 'data-tip': 'Hide project panels', onClick: () => app.togglePane('browser') }, icon('x', 15));
  const assistantHost = h('div.tab-panel.assistant-host', { id: 'assistant-panel', role: 'tabpanel', 'aria-labelledby': 'tab-assistant', hidden: true });
  const paneLower = h('section.pane.pane-lower', { 'aria-label': 'Project panels' }, h('div.pane-head', tablist, h('span.grow'), lowerClose), browserPanel, assistantHost);
  const dockSplit = h('div.dock-split', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize Properties and project panels', 'aria-valuemin': '15', 'aria-valuemax': '85', 'aria-valuenow': '52', tabindex: '0' });
  const dock = h('aside.dock', { 'aria-label': 'Properties and project panels' }, paneProps, dockSplit, paneLower);
  const dockResize = h('div.dock-resize', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize side panel', 'aria-valuemin': '200', 'aria-valuemax': '560', 'aria-valuenow': '290', tabindex: '0' });

  // Views
  const vtabs = h('div.vtabs', { role: 'tablist', 'aria-label': 'Open views' });
  const glCanvas = h('canvas.gl-canvas', { 'aria-hidden': 'true' });
  const overlay = h('canvas.overlay-canvas', {
    tabindex: '0',
    role: 'application',
    'aria-label': 'Model view. Use the ribbon or two-letter shortcuts to start tools. Press F1 for help.',
    'aria-describedby': 'canvas-help',
  });
  const canvasHelp = h('p.sr-only#canvas-help', 'Click to select elements; drag to select several. Arrow keys nudge the selection. Middle mouse button or two fingers pan; the wheel or a pinch zooms. In 3D views drag with the right mouse button or one finger to orbit.');
  const domView = h('div.dom-view', { hidden: true });
  const nav = h('div.navbar', { role: 'toolbar', 'aria-label': 'Navigation', 'aria-orientation': 'vertical' });
  const cubeInner = h('div.vc-cube');
  const viewcube = h('div.viewcube', { hidden: true, role: 'group', 'aria-label': 'View orientation' }, h('div.vc-ring'), cubeInner);
  const banner = h('div.view-banner', { hidden: true, role: 'status' });
  const canvasWrap = h('div.canvas-wrap', glCanvas, overlay, canvasHelp, domView, nav, viewcube, banner);
  const viewbar = h('div.viewbar', { role: 'toolbar', 'aria-label': 'View controls' });
  const viewarea = h('div.viewarea', vtabs, canvasWrap, viewbar);
  const main = h('div.main', dock, dockResize, viewarea);

  // Status bar
  const prompt = h('div.sb-prompt', { role: 'status', 'aria-live': 'polite' });
  const selInfo = h('span.sb-item', { 'aria-live': 'polite' });
  const snapBtn = h('button.sb-item', { type: 'button', 'aria-pressed': 'true', 'data-tip': 'Snaps', 'data-tip-desc': 'Snap to endpoints, midpoints, intersections and angles', onClick: () => app.toggleSnaps() }, icon('magnet', 14), h('span', 'Snaps'));
  const coords = h('span.sb-item.sb-coords', { 'aria-hidden': 'true' });
  const statusbar = h('footer.statusbar', prompt, selInfo, snapBtn, coords);

  const phonebar = h('nav.phonebar', { 'aria-label': 'Tools' });
  const root = h('div.app-root', titlebar, h('div.ribbon-slot', { style: { display: 'contents' } }), optionsbar, main, statusbar, phonebar);
  return {
    root,
    titlebar,
    title,
    account,
    assistantBtn,
    themeBtn,
    undoBtn,
    redoBtn,
    optionsbar,
    dock,
    dockSplit,
    dockResize,
    main,
    propsBody,
    propsTitle,
    browserBody,
    browserSearch,
    browserPanel,
    tabBrowser,
    tabAssistant,
    assistantHost,
    vtabs,
    glCanvas,
    overlay,
    domView,
    nav,
    viewcube,
    cubeInner,
    banner,
    canvasWrap,
    viewbar,
    prompt,
    selInfo,
    snapBtn,
    coords,
    phonebar,
  };
}

/** Faces of the orientation cube (original layout): world axes per face. */
export const CUBE_FACES = [
  { id: 'top', label: 'TOP', u: [1, 0, 0], v: [0, -1, 0], c: [0, 0, 1], yaw: -Math.PI / 2, pitch: Math.PI / 2 - 0.0001 },
  { id: 'bottom', label: 'BOTTOM', u: [1, 0, 0], v: [0, 1, 0], c: [0, 0, -1], yaw: -Math.PI / 2, pitch: -Math.PI / 2 + 0.0001 },
  { id: 'south', label: 'SOUTH', u: [1, 0, 0], v: [0, 0, -1], c: [0, -1, 0], yaw: -Math.PI / 2, pitch: 0 },
  { id: 'north', label: 'NORTH', u: [-1, 0, 0], v: [0, 0, -1], c: [0, 1, 0], yaw: Math.PI / 2, pitch: 0 },
  { id: 'east', label: 'EAST', u: [0, 1, 0], v: [0, 0, -1], c: [1, 0, 0], yaw: 0, pitch: 0 },
  { id: 'west', label: 'WEST', u: [0, -1, 0], v: [0, 0, -1], c: [-1, 0, 0], yaw: Math.PI, pitch: 0 },
];

export function buildCube(app, inner, viewcube) {
  const half = 20;
  for (const f of CUBE_FACES) {
    const n = [f.v[1] * f.u[2] - f.v[2] * f.u[1], f.v[2] * f.u[0] - f.v[0] * f.u[2], f.v[0] * f.u[1] - f.v[1] * f.u[0]];
    const m = [f.u[0], f.u[1], f.u[2], 0, f.v[0], f.v[1], f.v[2], 0, n[0], n[1], n[2], 0, f.c[0] * half, f.c[1] * half, f.c[2] * half, 1];
    const btn = h('button.vc-face', { type: 'button', 'aria-label': `View from ${f.label.toLowerCase()}`, onClick: () => app.orient3D(f.yaw, f.pitch) }, f.label);
    btn.style.transform = `matrix3d(${m.join(',')})`;
    inner.append(btn);
  }
  viewcube.append(
    h('button.icon-btn.vc-home', { type: 'button', 'aria-label': 'Home view', 'data-tip': 'Home view', onClick: () => app.orient3D(-0.85, 0.55, true) }, icon('home', 15)),
  );
}
