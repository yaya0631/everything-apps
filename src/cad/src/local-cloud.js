/**
 * Stand-in for the Puter SDK that talks to your own CAD Home server
 * (cad-home/server.js) instead of Puter's cloud. It provides exactly what the
 * app uses: sign-in, a private file drive per person, and a small key-value
 * store for synced settings. Everything goes to /api/ on the same server that
 * serves the app, so no request ever leaves your network.
 */
import { h } from './ui/dom.js';
import { openDialog } from './ui/dialog.js';

// The platform API's root: today's default resolves api/ against the page base
// (root serving and /s/<token>/ guest pages). When the app is served under the
// hub's /h/<name>/ path, the API lives at the SERVER root instead.
const API = new URL(/^\/h\/[a-z0-9_-]+\//.test(location.pathname) ? '/api/' : 'api/', document.baseURI);

/** A share link opens the app at /s/<token>/ on the public listener: guest mode. */
export const guest = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname)?.[1] ?? null;

class ServerError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let user = null;
let signInOpen = null;

async function request(method, route, { query, body, type, reauth = false, signal } = {}) {
  const url = new URL(route, API);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
  const headers = { 'X-CAD-Request': '1' };
  if (type) headers['Content-Type'] = type;
  let res;
  try {
    res = await fetch(url, { method, body, headers, credentials: 'same-origin', cache: 'no-store', signal });
  } catch {
    throw new ServerError('network', 'Could not reach your CAD server. Check that it is running and that this device can reach it.');
  }
  if (res.ok) return res;
  let info = {};
  try {
    info = await res.json();
  } catch {
    /* not JSON */
  }
  if (res.status === 401) {
    user = null;
    // The session ended (signed out elsewhere, password changed): sign in again and retry once.
    if (reauth) {
      await signIn();
      return request(method, route, { query, body, type });
    }
  }
  throw new ServerError(info.code || `http_${res.status}`, info.message || `The server answered ${res.status}.`, res.status);
}

const json = async (res) => res.json();

// Sign-in ---------------------------------------------------------------------------

function signInDialog() {
  const username = h('input.input', { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', 'aria-required': 'true' });
  const password = h('input.input', { type: 'password', name: 'password', autocomplete: 'current-password', 'aria-required': 'true' });
  const err = h('p.field-error', { role: 'alert' });
  const field = (label, control, id) => {
    control.id = id;
    return h('div.field', h('label.field-label', { for: id }, label), control);
  };
  const body = h(
    'form',
    { onSubmit: (e) => e.preventDefault() },
    h('p.dialog-text', { style: { marginBottom: '14px' } }, 'Use the account the owner of this CAD server created for you.'),
    field('Username', username, 'signin-user'),
    field('Password', password, 'signin-pass'),
    err,
  );
  let busy = false;
  return openDialog({
    title: 'Sign in to your CAD server',
    body,
    size: 'sm',
    initialFocus: 'input[name="username"]',
    actions: [
      { label: 'Cancel' },
      {
        label: 'Sign in',
        primary: true,
        onClick: async () => {
          if (busy) return false;
          err.textContent = '';
          if (!username.value.trim() || !password.value) {
            err.textContent = 'Enter your username and password.';
            return false;
          }
          busy = true;
          try {
            const res = await request('POST', 'auth/login', {
              type: 'application/json',
              body: JSON.stringify({ username: username.value.trim(), password: password.value }),
            });
            return await json(res);
          } catch (e) {
            err.textContent = e.message;
            password.select();
            return false;
          } finally {
            busy = false;
          }
        },
      },
    ],
  });
}

async function signIn() {
  // One dialog at a time, even when several saves need a fresh session.
  signInOpen ??= signInDialog().finally(() => (signInOpen = null));
  const me = await signInOpen;
  if (!me) throw Object.assign(new Error('Sign-in cancelled'), { error: 'auth_window_closed' });
  user = me;
  return me;
}

async function getUser() {
  if (user) return user;
  try {
    user = await json(await request('GET', 'auth/me'));
  } catch (err) {
    if (err.status !== 401) console.warn('CAD server:', err.message);
    user = null;
  }
  return user;
}

// Sharing between accounts (private listener only; the browser session is the identity).

const share = {
  /** Items others shared with this account. */
  incoming: async () => json(await request('GET', 'share/incoming')),
  /** { people, links, canManagePeople, isCad } for one file or folder. */
  list: async (path) => json(await request('GET', 'share/list', { query: { path } })),
  directory: async () => json(await request('GET', 'users/directory')),
  people: async (path, user, mode) => json(await postJSON('POST', 'share/people', { path, user, mode })),
  removePeople: async (path, user) => json(await postJSON('DELETE', 'share/people', { path, user })),
  createLink: async (path, mode, expiresDays = null) => json(await postJSON('POST', 'share/links', { path, mode, expiresDays })),
  removeLink: async (token) => json(await postJSON('DELETE', `share/links/${token}`)),
  emailLink: async (token, to) => json(await postJSON('POST', `share/links/${token}/email`, { to })),
};

async function postJSON(method, route, body) {
  return request(method, route, { type: 'application/json', body: JSON.stringify(body) });
}

// Safety snapshots ("Version history").

const history = {
  list: async (path) => json(await request('GET', 'history', { query: { path } })),
  restore: async (path, id) => json(await postJSON('POST', 'history/restore', { path, id })),
  /** The saved bytes of one version (for "open as copy"). */
  file: async (path, id) => (await request('GET', 'history/file', { query: { path, id }, reauth: true })).blob(),
};

// Guest mode -------------------------------------------------------------------------

/** Settings a link guest keeps in this browser instead of the account. */
const guestKey = `cad.guest.${guest}.kv`;
const guestStore = () => {
  try {
    return JSON.parse(localStorage.getItem(guestKey) || '{}');
  } catch {
    return {};
  }
};
const guestKv = {
  async get(key) {
    return guestStore()[key] ?? null;
  },
  async set(key, value) {
    try {
      const s = guestStore();
      s[key] = value;
      localStorage.setItem(guestKey, JSON.stringify(s));
    } catch {
      /* ignore quota */
    }
    return true;
  },
};

// AI assistant: models are picked in Admin → AI on the server -----------------------

const ai = {
  /** Models people can use: [{ id, label, provider, providerLabel, tools }] */
  models: async () => json(await request('GET', 'ai/models', { reauth: true })),
  /** POST { model, messages, tools }; the Response body streams NDJSON events. */
  chat: (body, signal) => request('POST', 'ai/chat', { type: 'application/json', body: JSON.stringify(body), reauth: true, signal }),
};

/** {name, mode, ownerName} for the link this page was opened from. */
export function guestShareInfo() {
  if (!guest) return null;
  return fetch(new URL(`/s/${guest}/api/share`, location.origin))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

/** ws(s) endpoint for this same host (behind tailscale serve on https). */
function wsBase() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

export function liveUrl(path) {
  if (guest) return `${wsBase()}/s/${guest}/api/live`;
  return `${wsBase()}/api/live?path=${encodeURIComponent(path)}`;
}

// Puter-compatible surface ----------------------------------------------------------

globalThis.puter = {
  env: guest ? 'guest' : 'web',
  ui: {},
  auth: {
    isSignedIn: async () => !guest && !!(await getUser()),
    getUser: async () => (guest ? null : getUser()),
    signIn: guest ? async () => null : signIn,
    signOut() {
      if (guest) return;
      user = null;
      request('POST', 'auth/logout').catch(() => {});
    },
  },
  fs: guest
    ? {
        async readdir() {
          return { items: [] };
        },
        async read() {
          throw new ServerError('not_signed_in', 'Signed-in files are not available through a share link.');
        },
        async write() {
          throw new ServerError('not_signed_in', 'Signed-in files are not available through a share link.');
        },
        async delete() {
          throw new ServerError('not_signed_in', 'Signed-in files are not available through a share link.');
        },
      }
    : {
        async readdir({ path, sortBy, sortOrder, cursor, limit } = {}) {
          return json(await request('GET', 'fs/readdir', { query: { path, sortBy, sortOrder, cursor, limit }, reauth: true }));
        },
        async read(path) {
          return (await request('GET', 'fs/read', { query: { path }, reauth: true })).blob();
        },
        async write(path, blob, { overwrite = true } = {}) {
          return json(await request('PUT', 'fs/write', { query: { path, overwrite: overwrite ? 1 : 0 }, body: blob, type: 'application/octet-stream', reauth: true }));
        },
        async delete(path) {
          await request('DELETE', 'fs/delete', { query: { path }, reauth: true });
        },
      },
  kv: guest
    ? guestKv
    : {
        async get(key) {
          return (await json(await request('GET', `kv/${encodeURIComponent(key)}`))).value ?? null;
        },
        async set(key, value) {
          await request('PUT', `kv/${encodeURIComponent(key)}`, { type: 'application/json', body: JSON.stringify({ value }) });
          return true;
        },
      },
  share: guest
    ? {
        async incoming() {
          return [];
        },
        async list() {
          return { people: [], links: [] };
        },
        async directory() {
          return [];
        },
      }
    : share,
  history: guest
    ? {
        async list() {
          return [];
        },
      }
    : history,
  ai: guest
    ? {
        async models() {
          return [];
        },
        async chat() {
          throw new ServerError('not_signed_in', 'The AI assistant is not available through a share link.');
        },
      }
    : ai,
};
