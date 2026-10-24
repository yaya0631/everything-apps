const KEY = 'assetdesk.assets.v1';

const state = {
  assets: [],
  query: '',
  editing: null,
};

const app = document.querySelector('#app');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

async function load() {
  const value = await window.puter.kv.get(KEY).catch(() => null);
  state.assets = Array.isArray(value) ? value : [];
}

async function save() {
  await window.puter.kv.set(KEY, state.assets);
}

function visible() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.assets;
  return state.assets.filter((item) => [item.name, item.serial, item.location, item.assignee]
    .some((value) => String(value || '').toLowerCase().includes(q)));
}

function render() {
  const rows = visible();
  app.innerHTML = `
    <main class="assetdesk">
      <header class="topbar">
        <div><p class="eyebrow">HOME SERVER</p><h1>AssetDesk</h1><p class="subtitle">Assets, equipment, and assignments in your private hub.</p></div>
        <button class="primary" data-action="new">Add asset</button>
      </header>
      <section class="toolbar">
        <input aria-label="Search assets" data-search placeholder="Search name, serial, location, or assignee" value="${esc(state.query)}">
        <button data-action="export">Export JSON</button>
        <label class="import">Import JSON<input type="file" accept="application/json" data-import hidden></label>
      </section>
      <section class="stats">
        <div><strong>${state.assets.length}</strong><span>Total assets</span></div>
        <div><strong>${state.assets.filter((x) => x.status !== 'retired').length}</strong><span>Active</span></div>
        <div><strong>${state.assets.filter((x) => x.assignee).length}</strong><span>Assigned</span></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Inventory</h2><span>${rows.length} shown</span></div>
        ${rows.length ? `<div class="table">${rows.map((item) => `
          <article class="asset-row">
            <div><strong>${esc(item.name)}</strong><small>${esc(item.serial || 'No serial')}</small></div>
            <div>${esc(item.location || 'No location')}</div>
            <div>${esc(item.assignee || 'Available')}</div>
            <span class="badge ${item.status === 'retired' ? 'retired' : ''}">${esc(item.status || 'available')}</span>
            <div class="row-actions"><button data-edit="${esc(item.id)}">Edit</button><button data-delete="${esc(item.id)}">Delete</button></div>
          </article>`).join('')}</div>` : '<p class="empty">No assets yet. Add your first item or import a JSON backup.</p>'}
      </section>
    </main>
    <dialog data-dialog>
      <form method="dialog" data-form>
        <h2>${state.editing ? 'Edit asset' : 'Add asset'}</h2>
        <label>Name<input name="name" required value="${esc(state.editing?.name)}"></label>
        <label>Serial<input name="serial" value="${esc(state.editing?.serial)}"></label>
        <label>Location<input name="location" value="${esc(state.editing?.location)}"></label>
        <label>Assignee<input name="assignee" value="${esc(state.editing?.assignee)}"></label>
        <label>Status<select name="status"><option ${state.editing?.status === 'available' ? 'selected' : ''}>available</option><option ${state.editing?.status === 'assigned' ? 'selected' : ''}>assigned</option><option ${state.editing?.status === 'maintenance' ? 'selected' : ''}>maintenance</option><option ${state.editing?.status === 'retired' ? 'selected' : ''}>retired</option></select></label>
        <div class="dialog-actions"><button value="cancel">Cancel</button><button class="primary" value="save">Save asset</button></div>
      </form>
    </dialog>`;
  wire();
}

function openEditor(item = null) {
  state.editing = item;
  render();
  const dialog = document.querySelector('[data-dialog]');
  dialog.showModal();
}

function wire() {
  document.querySelector('[data-search]').addEventListener('input', (event) => {
    state.query = event.target.value;
    render();
    event.target.focus();
    event.target.setSelectionRange(state.query.length, state.query.length);
  });
  document.querySelector('[data-action="new"]').addEventListener('click', () => openEditor());
  document.querySelector('[data-action="export"]').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.assets, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'assetdesk-backup.json'; link.click();
    URL.revokeObjectURL(url);
  });
  document.querySelector('[data-import]').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported)) throw new Error('AssetDesk backup must be an array.');
    state.assets = imported.map((item) => ({ ...item, id: item.id || crypto.randomUUID() }));
    await save(); render();
  });
  document.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => {
    openEditor(state.assets.find((item) => item.id === button.dataset.edit));
  }));
  document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => {
    state.assets = state.assets.filter((item) => item.id !== button.dataset.delete);
    await save(); render();
  }));
  const form = document.querySelector('[data-form]');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const item = { ...data, id: state.editing?.id || crypto.randomUUID(), updatedAt: new Date().toISOString() };
    const index = state.assets.findIndex((entry) => entry.id === item.id);
    if (index >= 0) state.assets[index] = item; else state.assets.unshift(item);
    await save();
    form.closest('dialog').close();
    state.editing = null;
    render();
  });
}

const style = document.createElement('style');
style.textContent = `
:root{font:16px/1.45 system-ui,sans-serif;color:#17202a;background:#f4f6f8}
*{box-sizing:border-box}body{margin:0}.assetdesk{max-width:1120px;margin:auto;padding:32px 20px}
.topbar,.toolbar,.card-head,.asset-row,.dialog-actions{display:flex;align-items:center;gap:16px}
.topbar{justify-content:space-between;margin-bottom:24px}.eyebrow{font-size:.72rem;letter-spacing:.15em;color:#587083;margin:0}
h1{font-size:2.4rem;margin:.1rem 0}.subtitle{color:#587083;margin:0}.primary{background:#1769e0;color:white;border:0}
button,.import,input,select{font:inherit}button,.import{border:1px solid #ccd5df;border-radius:8px;background:white;padding:9px 14px;cursor:pointer}
.toolbar{margin-bottom:18px}.toolbar input{flex:1;padding:11px;border:1px solid #ccd5df;border-radius:8px}.import{display:inline-block}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px}.stats div,.card{background:white;border:1px solid #dde4ea;border-radius:12px;padding:18px}.stats strong,.stats span{display:block}.stats strong{font-size:1.8rem}.stats span,.card-head span,small{color:#657889}
.card-head{justify-content:space-between;border-bottom:1px solid #e6ebef;margin:-18px -18px 0;padding:14px 18px}.card h2{margin:0}.table{margin:0 -18px}.asset-row{display:grid;grid-template-columns:2fr 1.4fr 1.2fr .8fr auto;padding:14px 18px;border-bottom:1px solid #edf0f3}.asset-row strong,.asset-row small{display:block}.row-actions{display:flex;gap:6px}.row-actions button{padding:5px 8px}.badge{background:#e4f5e9;color:#176b39;border-radius:99px;padding:4px 9px;font-size:.8rem}.badge.retired{background:#f8e4e4;color:#9b2c2c}.empty{padding:30px 0;text-align:center;color:#657889}
dialog{border:0;border-radius:12px;padding:24px;box-shadow:0 14px 60px #0003}dialog::backdrop{background:#10203066}dialog form{display:grid;gap:13px;min-width:300px}dialog label{display:grid;gap:4px}dialog input,dialog select{padding:9px;border:1px solid #ccd5df;border-radius:7px}.dialog-actions{justify-content:flex-end;margin-top:8px}
@media(max-width:760px){.asset-row{grid-template-columns:1fr 1fr}.asset-row .row-actions{grid-column:1/-1}.toolbar{flex-wrap:wrap}.toolbar input{flex-basis:100%}}
`;
document.head.append(style);

await load();
render();
