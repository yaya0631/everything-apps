import { cleanName, MIME, validateImportSize } from "./model.js";
export const FOLDER = "Presentations";
const sdk = () => {
  if (!globalThis.puter)
    throw new Error(
      "Puter is unavailable. Check your connection and try again.",
    );
  return globalThis.puter;
};
export const isApp = () => globalThis.puter?.env === "app";
export const canSignOut = () => !isApp();
export async function user() {
  try {
    if (await sdk().auth.isSignedIn()) return await sdk().auth.getUser();
  } catch {}
  return null;
}
export async function profilePicture() {
  try {
    return (await sdk().auth.getProfilePicture?.()) || null;
  } catch {
    return null;
  }
}
// The SDK rejects with plain `{ error, msg }` objects rather than Errors. A
// sign-in window the person closed is a decision, not a failure, and a
// blocked pop-up needs advice they can act on.
export async function signIn() {
  try {
    await sdk().auth.signIn();
  } catch (error) {
    if (error?.error === "auth_window_closed")
      throw Object.assign(new Error("Sign-in was cancelled."), {
        code: "cancelled",
      });
    if (error?.error === "popup_blocked")
      throw new Error(
        "The browser blocked the Puter sign-in window. Allow pop-ups for this site and try again.",
        { cause: error },
      );
    if (error instanceof Error) throw error;
    throw new Error(
      error?.msg || error?.message || "Puter sign-in failed. Please try again.",
      { cause: error },
    );
  }
  return sdk().auth.getUser();
}
export async function signOut() {
  if (!canSignOut()) return;
  await sdk().auth.signOut();
}
// On the open web the SDK opens Puter's sign-in before any cloud call made
// without a session, then reports the user here.
export function onAuth(handler) {
  if (globalThis.puter) globalThis.puter.onAuth = handler;
}
export async function listFiles() {
  try {
    return (await sdk().fs.readdir(FOLDER))
      .filter((f) => !f.is_dir && /\.pptx$/i.test(f.name))
      .map((f) => ({ ...f, path: f.path || `${FOLDER}/${f.name}` }));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}
// The SDK reports a missing file through a code, or only through its words.
export function isNotFound(error) {
  const code = error?.code || error?.error?.code || "";
  const message = String(
    error?.message || error?.error?.message || error?.msg || "",
  ).toLowerCase();
  return (
    code === "subject_does_not_exist" ||
    code === "ENOENT" ||
    message.includes("not found") ||
    message.includes("does not exist") ||
    message.includes("no such")
  );
}
export const displayName = (path) =>
  String(path || "")
    .split("/")
    .pop();
export const isPptxName = (name) => /\.pptx$/i.test(String(name || ""));
// The desktop keeps a deleted file in ~/Trash (or /<user>/Trash) under its id.
export const inTrash = (path) =>
  typeof path === "string" && /^(?:\/[^/]+|~)\/Trash(?:\/|$)/.test(path);
// A launch item, a drop from the desktop, or a listing entry naming a folder.
export const isDirItem = (item) =>
  !!(item?.is_dir || item?.isDirectory || item?.isDir || item?.fsentry_is_dir);
// The folder a file sits in, by its last path segment ("Desktop").
export function folderName(path) {
  const parts = String(path || "").split("/");
  return parts.length > 2 ? parts.at(-2) : "";
}
// Is this file directly in the app's own Presentations folder, whichever
// spelling of the folder the path uses?
export function inAppFolder(path) {
  const parts = String(path || "").split("/");
  return parts.length >= 2 && parts.at(-2) === FOLDER;
}
// A file's modification time in milliseconds (Puter reports seconds), or
// null when it is not reported.
export function modifiedMs(item) {
  const m = item?.modified ?? item?.created;
  if (m == null || m === "") return null;
  const n = typeof m === "number" ? m : Number(m) || new Date(m).getTime();
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}
// A file's size in bytes, or null when it is not reported (a PPTX file is
// never empty).
export function sizeOf(item) {
  const size = Number(item?.size);
  return Number.isFinite(size) && size > 0 ? size : null;
}
// Looking a file up is what tells a save whether the file changed, moved, or
// went away since it was opened. An SDK without it saves as before.
export const canStat = () => typeof globalThis.puter?.fs?.stat === "function";
// The file at `path` (null when there is none).
export async function stat(path) {
  try {
    return await sdk().fs.stat(path);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}
// The file with this id, wherever it is now: a file keeps its id when it is
// moved or renamed, here or on the desktop. Null when it is gone.
export async function statByUid(uid) {
  if (!uid || !canStat()) return null;
  try {
    return await sdk().fs.stat({ uid });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}
export async function readFile(path, { importing = false } = {}) {
  const blob = await sdk().fs.read(path);
  if (importing) validateImportSize(blob.size);
  return new Uint8Array(await blob.arrayBuffer());
}
export async function saveFile(bytes, name, path = null) {
  return sdk().fs.write(
    path ||
      `${FOLDER}/${cleanName(name, { stripExtension: false, maxLength: Infinity })}.pptx`,
    new Blob([bytes], { type: MIME }),
    { overwrite: !!path, dedupeName: !path, createMissingParents: true },
  );
}
// A rename never replaces another file: the drive would refuse it, in words
// meant for developers, or worse, take it.
export async function renameFile(path, name) {
  const fileName = `${cleanName(name)}.pptx`;
  const target = path.slice(0, path.lastIndexOf("/") + 1) + fileName;
  if (
    canStat() &&
    target.toLowerCase() !== path.toLowerCase() &&
    (await stat(target))
  )
    throw Object.assign(
      new Error(
        `A file named “${fileName}” is already in that folder. Choose another name.`,
      ),
      { code: "exists" },
    );
  return sdk().fs.rename(path, fileName);
}
export async function deleteFile(path) {
  return sdk().fs.delete(path);
}
export const canPickFiles = () =>
  typeof globalThis.puter?.ui?.showOpenFilePicker === "function";
export const canSaveFiles = () =>
  typeof globalThis.puter?.ui?.showSaveFilePicker === "function";
// Puter's pickers never settle when they are cancelled; the SDK hangs a
// promise on them that does, with undefined, and older SDKs leave the
// original to wait.
const settleOnCancel = (pending) => pending?.undefinedOnCancel ?? pending;
// Puter's Open dialog: the chosen file, or null when it was cancelled.
export async function pickFile({ accept = [".pptx"] } = {}) {
  const item = await settleOnCancel(
    sdk().ui.showOpenFilePicker({ multiple: false, accept }),
  );
  return (Array.isArray(item) ? item[0] : item) || null;
}
// Puter's Save dialog, which writes `blob` where the person chooses: the file
// it wrote, or null when it was cancelled.
export async function saveFileAs(blob, suggestedName) {
  const item = await settleOnCancel(
    sdk().ui.showSaveFilePicker(blob, suggestedName),
  );
  return item || null;
}
// What the app was launched with ("Open with", a double-click on the
// desktop) arrives through this, as soon as it is registered. Every item is
// handed on, so a folder or another kind of file can be explained.
export function onLaunch(handler) {
  try {
    globalThis.puter?.ui?.onLaunchedWithItems?.((items) => {
      const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
      if (list.length) handler(list);
    });
  } catch {}
}
// The Puter desktop window's title follows the open presentation.
export function setWindowTitle(title) {
  if (!isApp()) return;
  try {
    globalThis.puter?.ui?.setWindowTitle?.(title)?.catch?.(() => {});
  } catch {}
}
// Take over the Puter window's close button: the window stays open until
// exitApp(). False where the window could then never close.
export function onWindowClose(handler) {
  const ui = globalThis.puter?.ui;
  if (
    !isApp() ||
    typeof ui?.onWindowClose !== "function" ||
    typeof globalThis.puter?.exit !== "function"
  )
    return false;
  try {
    ui.onWindowClose(handler);
    return true;
  } catch {
    return false;
  }
}
export function exitApp() {
  try {
    globalThis.puter?.exit?.();
  } catch {}
}
export async function download(bytes, name) {
  return downloadBlob(
    new Blob([bytes], { type: MIME }),
    `${cleanName(name, { stripExtension: false, maxLength: Infinity })}.pptx`,
  );
}
// Any file the app produces goes through Puter's Save dialog in the app
// environment and through the browser's download elsewhere. Resolves to
// { saved: file } for the former, { cancelled: true } when its dialog was
// closed, and { downloaded: true } for a download.
export async function downloadBlob(blob, filename) {
  if (isApp() && canSaveFiles()) {
    const saved = await saveFileAs(blob, filename);
    return saved ? { saved } : { cancelled: true };
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { downloaded: true };
}
// Serialize writes so a slow request cannot overwrite a newer revision.
export class SaveQueue {
  constructor() {
    this.tail = Promise.resolve();
  }
  run(work) {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }
}
// Puter's AI answers the assistant. It is there wherever the SDK loaded; the
// SDK asks for a sign-in itself on the first request made without one.
export const canAI = () => !!globalThis.puter?.ai?.chat;
/** The models Admin → AI turned on ({ id, label, tools }); empty where the host has no list. */
export async function aiModels() {
  const ai = globalThis.puter?.ai;
  const ask = ai?.models;
  if (typeof ask !== "function") return [];
  try {
    const list = await ask.call(ai);
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === "string") : [];
  } catch {
    return [];
  }
}
// One reply from Puter's AI to a conversation, as it arrives: yields
// { type: "text", text } and { type: "tool", id, name, input } for each
// function the model calls. `messages` take the OpenAI shape Puter accepts
// (system, user, assistant with tool_calls, tool). A reply the SDK hands back
// whole rather than streamed is yielded in the same pieces. A failure throws
// an Error carrying the service's own message and code where it gives them.
export async function* aiChatStream(
  messages,
  { model, tools, maxTokens } = {},
) {
  const ai = globalThis.puter?.ai;
  if (!ai?.chat) throw new Error("AI is not available here.");
  const options = {
    stream: true,
    ...(model ? { model } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  };
  let res;
  try {
    res = await ai.chat(messages, options);
  } catch (e) {
    throw aiError(e);
  }
  if (res && typeof res[Symbol.asyncIterator] === "function") {
    try {
      for await (const part of res) {
        if (!part) continue;
        if (part.type === "error" || (part.success === false && part.error))
          throw aiError(part.error || part);
        if (part.type === "tool_use")
          yield {
            type: "tool",
            id: part.id,
            name: part.name,
            input: part.input ?? {},
          };
        else if (
          typeof part.text === "string" &&
          part.text &&
          part.type !== "reasoning"
        )
          yield { type: "text", text: part.text };
      }
    } catch (e) {
      throw aiError(e);
    }
    return;
  }
  if (res?.success === false) throw aiError(res.error || res);
  const message = res?.message || {};
  const content = typeof res === "string" ? res : message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((c) => (typeof c === "string" ? c : c?.text || ""))
            .join("")
        : "";
  if (text) yield { type: "text", text };
  for (const call of message.tool_calls || []) {
    let input = call.function?.arguments ?? {};
    if (typeof input === "string") {
      try {
        input = input.trim() ? JSON.parse(input) : {};
      } catch {
        input = { __unreadable: input };
      }
    }
    yield { type: "tool", id: call.id, name: call.function?.name, input };
  }
}
// The SDK often rejects with a plain { error: { message } } object.
function aiError(e) {
  if (e instanceof Error) return e;
  const inner = e?.error && typeof e.error === "object" ? e.error : e;
  const message =
    inner?.message ||
    (typeof e?.error === "string" ? e.error : "") ||
    (typeof e === "string" ? e : "") ||
    "The AI did not answer.";
  return Object.assign(new Error(message), { code: inner?.code || e?.code });
}
