// The Puter SDK, loaded the first time the assistant needs it (the rest of the
// app works without Puter, offline included, so the page does not load it up front).

const SDK_URL = 'https://js.puter.com/v2/';

interface PuterSDK {
  env?: string;
  auth?: { isSignedIn(): boolean; signIn(opts?: Record<string, unknown>): Promise<unknown> };
  ai?: { chat: (messages: unknown, opts?: Record<string, unknown>) => Promise<unknown>; models?: () => Promise<unknown> };
}

/** A model Admin → AI turned on, as this server lists it. */
export interface AiModel {
  id: string;
  label?: string;
  title?: string;
  /** False for a model that cannot call tools; the assistant's tools need one that can. */
  tools?: boolean;
}

/** The person's models from the server; empty in the Puter desktop, which has no such list. */
export async function listAiModels(): Promise<AiModel[]> {
  const p = sdk() ?? (await loadPuter());
  const ask = p?.ai?.models;
  if (!ask) return [];
  try {
    const list = await ask.call(p?.ai);
    if (!Array.isArray(list)) return [];
    return list.filter((m): m is AiModel => !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string');
  } catch {
    return [];
  }
}

const sdk = () => (globalThis as unknown as { puter?: PuterSDK }).puter ?? null;
let loading: Promise<PuterSDK | null> | null = null;

/** The SDK, loading it once; null when it cannot be reached. */
export function loadPuter(timeoutMs = 15000): Promise<PuterSDK | null> {
  if (sdk()) return Promise.resolve(sdk());
  if (loading) return loading;
  loading = new Promise<PuterSDK | null>((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const done = () => {
      clearTimeout(timer);
      resolve(sdk());
      if (!sdk()) loading = null;
    };
    const timer = setTimeout(done, timeoutMs);
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onload = done;
    s.onerror = () => {
      s.remove();
      done();
    };
    document.head.append(s);
  });
  return loading;
}

/** Inside the Puter desktop the session belongs to the desktop. */
export const inPuterDesktop = () => sdk()?.env === 'app';

export function isSignedIn(): boolean {
  try {
    return inPuterDesktop() || !!sdk()?.auth?.isSignedIn?.();
  } catch {
    return false;
  }
}

/** Opens Puter's sign-in window (call from a click). Resolves whether the user is now signed in. */
export async function signIn(): Promise<boolean> {
  const p = sdk();
  if (!p?.auth) throw new Error('Puter is not available right now. Check your connection and try again.');
  try {
    await p.auth.signIn();
  } catch (e) {
    const code = (e as { error?: string })?.error;
    if (code === 'auth_window_closed') return false;
    if (code === 'popup_blocked') throw new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.');
    throw e;
  }
  return isSignedIn();
}
