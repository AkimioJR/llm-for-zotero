/**
 * File cards: the files an agent turn saved to disk, shown under its answer.
 *
 * A turn's files are found two ways, both on the finished answer, so every
 * runtime (plugin agent, Codex, Claude Code) is covered the same way:
 * - paths the answer names (the agent is told to give each saved file's full
 *   path), kept when the file sits in the chat's folder or was changed while
 *   the turn ran;
 * - files in the chat's folder (see agentFilesDirectory) changed while the
 *   turn ran, so a file the answer forgot to name still gets a card.
 *
 * The first finished render records what it found in `.llm-files.json` in the
 * chat's folder. Later renders read that record, so a file deleted or moved
 * afterwards keeps its card, which then says the file is no longer there. A
 * card is never shown for a path that never existed.
 */

import { t } from "../../utils/i18n";
import { getIOUtils } from "../../utils/geckoFs";
import {
  fileUrlToPath,
  isAbsoluteLocalPath,
  joinLocalPath,
  toFileUrl,
} from "../../utils/localPath";
import { revealLocalPath } from "../../utils/revealLocalPath";
import {
  AGENT_FILES_WORK_FOLDER,
  getAgentFilesRoot,
  resolveAgentFilesFolder,
  type AgentFilesTarget,
} from "../../utils/agentFilesDirectory";
import {
  appendMoveToSidePanelButton,
  fenceAround,
  isOutsideAnswerContent,
  SIDE_ITEM_KIND_ATTRIBUTE,
} from "./sidePanelItems";
import { createSandboxedHtmlFrame } from "./htmlPreviewFrame";
import {
  isGlobalPortalItem,
  resolvePaperPortalBaseItem,
} from "../../services/context/portalItems";

export const SAVED_FILES_MANIFEST = ".llm-files.json";
/** A page bigger than this opens only from Finder, not in the chat. */
export const SAVED_FILE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
/** A turn rarely runs longer; the window keeps later files off old answers. */
const TURN_WINDOW_MAX_MS = 2 * 60 * 60 * 1000;
/** File times can trail the clock the message time came from. */
const TURN_WINDOW_SLACK_MS = 5 * 1000;

export type SavedFilePreview = "html" | "markdown" | "text" | "image" | "none";

const PREVIEW_BY_EXTENSION: Record<string, SavedFilePreview> = {
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  py: "text",
  r: "text",
  tex: "text",
  bib: "text",
  svg: "image",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
};

/** Files a person opens; other writes (caches, logs, lock files) get no card. */
const USER_FILE_EXTENSIONS = new Set([
  ...Object.keys(PREVIEW_BY_EXTENSION),
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "ipynb",
  "zip",
]);

/** The folder target of the chat a panel shows: its paper, or its library. */
export function resolveAgentFilesTargetForPanelItem(
  item: unknown,
): AgentFilesTarget | null {
  if (!item || typeof item !== "object") return null;
  if (isGlobalPortalItem(item)) {
    return { kind: "library", libraryID: item.libraryID };
  }
  const base =
    resolvePaperPortalBaseItem(item as Zotero.Item) || (item as Zotero.Item);
  const id = Number(base?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const parentID = Number(base.parentID);
  return base.isAttachment?.() && Number.isInteger(parentID) && parentID > 0
    ? { kind: "paper", itemId: parentID }
    : { kind: "paper", itemId: id };
}

/** The user's home folder, for "~/" paths; empty when Gecko gives none. */
export function resolveHomeDir(): string {
  const scope = globalThis as typeof globalThis & {
    PathUtils?: { homeDir?: string };
    Services?: {
      dirsvc?: { get?: (key: string, iface: unknown) => { path?: string } };
    };
    Ci?: { nsIFile?: unknown };
  };
  try {
    const fromPathUtils = scope.PathUtils?.homeDir?.trim();
    if (fromPathUtils) return fromPathUtils;
    return (
      scope.Services?.dirsvc?.get?.("Home", scope.Ci?.nsIFile)?.path?.trim() ||
      ""
    );
  } catch {
    return "";
  }
}

export function fileExtension(path: string): string {
  const name = fileBaseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function savedFilePreviewKind(path: string): SavedFilePreview {
  return PREVIEW_BY_EXTENSION[fileExtension(path)] || "none";
}

function isInside(path: string, directory: string): boolean {
  const dir = directory.replace(/[\\/]+$/, "");
  return (
    path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCandidate(raw: string, homeDir: string): string | null {
  let value = raw.trim().replace(/^<|>$/g, "");
  value = value.replace(/[.,;:!?'"]+$/, "");
  if (/^file:\/\//i.test(value)) value = fileUrlToPath(value) || "";
  else if (/%[0-9A-Fa-f]{2}/.test(value)) {
    try {
      value = decodeURI(value);
    } catch {
      /* keep as written */
    }
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    if (!homeDir) return null;
    value = joinLocalPath(homeDir, value.slice(2));
  }
  if (!value || !isAbsoluteLocalPath(value)) return null;
  if (!USER_FILE_EXTENSIONS.has(fileExtension(value))) return null;
  return value;
}

/**
 * Local file paths an answer names, in the order it names them: file links,
 * Markdown link targets, `code` spans, bare paths, and paths inside the chat's
 * folder (whose name has spaces, so a bare match would stop short).
 */
export function extractLocalFilePaths(
  text: string,
  options: { homeDir?: string; folder?: string | null } = {},
): string[] {
  const homeDir = options.homeDir || "";
  const found: Array<{ at: number; path: string }> = [];
  const add = (at: number, raw: string | undefined) => {
    const path = raw ? normalizeCandidate(raw, homeDir) : null;
    if (path) found.push({ at, path });
  };
  const source = String(text || "");
  for (const match of source.matchAll(/file:\/\/[^\s)<>"'`\]]+/gi)) {
    add(match.index ?? 0, match[0]);
  }
  for (const match of source.matchAll(
    /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))\s*\)/g,
  )) {
    add(match.index ?? 0, match[1] || match[2]);
  }
  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    add(match.index ?? 0, match[1]);
  }
  for (const match of source.matchAll(
    /(?:^|[\s("'])((?:~[\\/]|\/|[A-Za-z]:\\)[^\s)"'`<>\]]*)/g,
  )) {
    add((match.index ?? 0) + 1, match[1]);
  }
  for (const folder of [options.folder, homeDir ? "~" : ""]) {
    if (!folder) continue;
    const pattern = new RegExp(
      `${escapeRegExp(folder)}[\\\\/][^\\n"'\`<>)\\]]+?\\.([A-Za-z0-9]{1,8})(?=$|[\\s"'\`<>)\\],;:!?]|\\.(?:\\s|$))`,
      "g",
    );
    for (const match of source.matchAll(pattern)) {
      add(match.index ?? 0, match[0]);
    }
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.path)
    .filter((path) => (seen.has(path) ? false : (seen.add(path), true)));
}

type FileStat = {
  exists: boolean;
  isDirectory?: boolean;
  lastModified?: number;
  size?: number;
};

type StatIOUtils = {
  stat?: (path: string) => Promise<{
    type?: string;
    size?: number;
    lastModified?: number;
  }>;
  getChildren?: (path: string) => Promise<string[]>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  readUTF8?: (path: string) => Promise<string>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
};

function io(): StatIOUtils | undefined {
  return getIOUtils() as StatIOUtils | undefined;
}

export async function statLocalPath(path: string): Promise<FileStat> {
  try {
    const stat = await io()?.stat?.(path);
    if (!stat) return { exists: false };
    return {
      exists: true,
      isDirectory: stat.type === "directory",
      lastModified: Number(stat.lastModified) || undefined,
      size: Number(stat.size) || 0,
    };
  } catch {
    return { exists: false };
  }
}

export type TurnWindow = { start: number; end: number };

/** From the question's time to the next question (at most two hours on). */
export function buildTurnWindow(params: {
  userTimestamp: number;
  assistantTimestamp: number;
  nextUserTimestamp?: number;
}): TurnWindow {
  const start =
    (params.userTimestamp || params.assistantTimestamp) - TURN_WINDOW_SLACK_MS;
  const cap =
    Math.max(params.userTimestamp, params.assistantTimestamp) +
    TURN_WINDOW_MAX_MS;
  const end = params.nextUserTimestamp
    ? Math.min(params.nextUserTimestamp, cap)
    : cap;
  return { start, end: end + TURN_WINDOW_SLACK_MS };
}

function inWindow(stat: FileStat, window: TurnWindow): boolean {
  const time = stat.lastModified || 0;
  return time >= window.start && time <= window.end;
}

async function listChildren(directory: string): Promise<string[]> {
  try {
    return (await io()?.getChildren?.(directory)) || [];
  } catch {
    return [];
  }
}

/** Files in the folder (and one level of subfolders) changed in the window. */
async function scanFolder(
  folder: string,
  window: TurnWindow,
): Promise<Array<{ path: string; time: number }>> {
  const found: Array<{ path: string; time: number }> = [];
  const visit = async (directory: string, depth: number) => {
    for (const child of await listChildren(directory)) {
      const name = fileBaseName(child);
      // Hidden entries, the scratch folder and the record itself.
      if (name.startsWith(".") || name === AGENT_FILES_WORK_FOLDER) continue;
      const stat = await statLocalPath(child);
      if (!stat.exists) continue;
      if (stat.isDirectory) {
        if (depth < 1) await visit(child, depth + 1);
        continue;
      }
      if (!USER_FILE_EXTENSIONS.has(fileExtension(child))) continue;
      if (inWindow(stat, window))
        found.push({ path: child, time: stat.lastModified || 0 });
    }
  };
  await visit(folder, 0);
  return found.sort((a, b) => a.time - b.time);
}

/** Zotero's own files (storage, MinerU cache) are papers, not saved files. */
function isZoteroManagedPath(path: string): boolean {
  const zotero = (
    globalThis as typeof globalThis & {
      Zotero?: { DataDirectory?: { dir?: string } };
    }
  ).Zotero;
  const dataDir = zotero?.DataDirectory?.dir;
  const root = getAgentFilesRoot();
  if (root && isInside(path, root)) return false;
  return Boolean(dataDir && isInside(path, dataDir));
}

/** The files a finished turn saved. */
export async function detectSavedFiles(params: {
  text: string;
  folder: string | null;
  homeDir?: string;
  window: TurnWindow;
}): Promise<string[]> {
  const result: string[] = [];
  const named = extractLocalFilePaths(params.text, {
    homeDir: params.homeDir,
    folder: params.folder,
  });
  for (const path of named) {
    if (isZoteroManagedPath(path)) continue;
    if (fileBaseName(path).startsWith(".")) continue;
    if (
      params.folder &&
      isInside(path, joinLocalPath(params.folder, AGENT_FILES_WORK_FOLDER))
    )
      continue;
    const stat = await statLocalPath(path);
    if (!stat.exists || stat.isDirectory) continue;
    const ours = Boolean(params.folder && isInside(path, params.folder));
    if (ours || inWindow(stat, params.window)) result.push(path);
  }
  if (params.folder && (await statLocalPath(params.folder)).isDirectory) {
    for (const { path } of await scanFolder(params.folder, params.window)) {
      if (!result.includes(path)) result.push(path);
    }
  }
  return result;
}

type SavedFilesManifest = {
  version: 1;
  /** `<conversationKey>:<assistant timestamp>` → the paths that turn saved. */
  messages: Record<string, string[]>;
};

export function savedFilesMessageKey(
  conversationKey: number,
  assistantTimestamp: number,
): string {
  return `${conversationKey}:${Math.floor(assistantTimestamp)}`;
}

const manifestCache = new Map<string, Promise<SavedFilesManifest>>();
const manifestWrites = new Map<string, Promise<void>>();

async function readManifest(folder: string): Promise<SavedFilesManifest> {
  const empty: SavedFilesManifest = { version: 1, messages: {} };
  const path = joinLocalPath(folder, SAVED_FILES_MANIFEST);
  try {
    const stat = await statLocalPath(path);
    if (!stat.exists) return empty;
    const bytes = await io()?.read?.(path);
    if (!bytes) return empty;
    const parsed = JSON.parse(
      new TextDecoder().decode(
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      ),
    ) as Partial<SavedFilesManifest>;
    const messages: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed?.messages || {})) {
      if (Array.isArray(value)) {
        messages[key] = value.filter(
          (entry): entry is string => typeof entry === "string",
        );
      }
    }
    return { version: 1, messages };
  } catch {
    return empty;
  }
}

function loadManifest(folder: string): Promise<SavedFilesManifest> {
  let pending = manifestCache.get(folder);
  if (!pending) {
    pending = readManifest(folder);
    manifestCache.set(folder, pending);
  }
  return pending;
}

async function recordInManifest(
  folder: string,
  messageKey: string,
  paths: string[],
): Promise<void> {
  const previous = manifestWrites.get(folder) || Promise.resolve();
  const next = previous.then(async () => {
    const manifest = await loadManifest(folder);
    manifest.messages[messageKey] = paths;
    const fs = io();
    if (!fs?.write) return;
    await fs.makeDirectory?.(folder, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await fs.write(
      joinLocalPath(folder, SAVED_FILES_MANIFEST),
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    );
  });
  manifestWrites.set(
    folder,
    next.catch(() => undefined),
  );
  await next;
}

const FOLDER_CACHE_MS = 30 * 1000;
const folderCache = new Map<
  string,
  { at: number; folder: Promise<string | null> }
>();

/** One folder lookup for a burst of renders (a chat draws many answers). */
function resolveFolderCached(target: AgentFilesTarget): Promise<string | null> {
  const key =
    target.kind === "paper" ? `p:${target.itemId}` : `l:${target.libraryID}`;
  const now = Date.now();
  const cached = folderCache.get(key);
  if (cached && now - cached.at < FOLDER_CACHE_MS) return cached.folder;
  const folder = resolveAgentFilesFolder(target).catch(() => null);
  folderCache.set(key, { at: now, folder });
  return folder;
}

/** Turns found with no files this session; they are not written down. */
const emptyTurns = new Set<string>();
const pendingTurns = new Map<string, Promise<string[]>>();

/**
 * The files of one finished turn: the record when there is one, else a fresh
 * look, which is recorded when it finds files.
 */
export async function resolveTurnSavedFiles(params: {
  target: AgentFilesTarget | null;
  conversationKey: number;
  assistantTimestamp: number;
  text: string;
  window: TurnWindow;
  homeDir?: string;
}): Promise<string[]> {
  const messageKey = savedFilesMessageKey(
    params.conversationKey,
    params.assistantTimestamp,
  );
  if (emptyTurns.has(messageKey)) return [];
  const running = pendingTurns.get(messageKey);
  if (running) return running;
  const work = (async () => {
    const folder = params.target
      ? await resolveFolderCached(params.target)
      : null;
    if (folder) {
      const recorded = (await loadManifest(folder)).messages[messageKey];
      if (recorded) return recorded;
    }
    const found = await detectSavedFiles({
      text: params.text,
      folder,
      homeDir: params.homeDir,
      window: params.window,
    });
    if (!found.length) {
      emptyTurns.add(messageKey);
      return found;
    }
    if (folder) {
      try {
        await recordInManifest(folder, messageKey, found);
      } catch {
        /* the cards still show this session */
      }
    }
    return found;
  })();
  pendingTurns.set(messageKey, work);
  try {
    return await work;
  } finally {
    pendingTurns.delete(messageKey);
  }
}

/** "~/Desktop/x.html" for a path in the home folder. */
export function displayLocalPath(path: string, homeDir?: string): string {
  if (homeDir && isInside(path, homeDir)) {
    return `~${path.slice(homeDir.replace(/[\\/]+$/, "").length)}`;
  }
  return path;
}

export type SavedFileCardOptions = {
  homeDir?: string;
  /** Opens an HTML page in the full-window viewer (the ⛶ button). */
  openViewer?: (source: string, anchor: HTMLElement) => void;
};

function createButton(
  doc: Document,
  className: string,
  label: string,
  glyph: string,
): HTMLButtonElement {
  const button = doc.createElement("button") as HTMLButtonElement;
  button.type = "button";
  button.className = `llm-saved-file-btn ${className}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = glyph;
  return button;
}

async function readText(path: string): Promise<string | null> {
  try {
    const bytes = await io()?.read?.(path);
    if (!bytes) return null;
    return new TextDecoder().decode(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
  } catch {
    return null;
  }
}

/** One card: icon, name, where it is, and its buttons. */
export async function createSavedFileCard(
  doc: Document,
  path: string,
  options: SavedFileCardOptions = {},
): Promise<HTMLElement> {
  const stat = await statLocalPath(path);
  const missing = !stat.exists || Boolean(stat.isDirectory);
  const preview = savedFilePreviewKind(path);
  const card = doc.createElement("div");
  card.className = `llm-saved-file-card${missing ? " is-missing" : ""}`;
  card.dataset.savedFilePath = path;
  card.dataset.savedFilePreview = preview;

  const icon = doc.createElement("span");
  icon.className = "llm-saved-file-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = missing
    ? "!"
    : preview === "html"
      ? "</>"
      : preview === "image"
        ? "◩"
        : "≡";

  const text = doc.createElement("div");
  text.className = "llm-saved-file-text";
  const name = doc.createElement("div");
  name.className = "llm-saved-file-name";
  name.textContent = fileBaseName(path);
  const where = doc.createElement("div");
  where.className = "llm-saved-file-path";
  where.textContent = missing
    ? t("This file is no longer there")
    : `${t("Saved to")} ${displayLocalPath(path, options.homeDir)}`;
  where.title = path;
  text.append(name, where);

  const actions = doc.createElement("div");
  actions.className = "llm-saved-file-actions";
  if (!missing) {
    const reveal = createButton(
      doc,
      "llm-saved-file-reveal",
      t("Show in folder"),
      "⌕",
    );
    reveal.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      revealLocalPath(path);
    });
    actions.appendChild(reveal);
    const previewable =
      preview === "html" &&
      (stat.size || 0) <= SAVED_FILE_PREVIEW_MAX_BYTES &&
      Boolean(options.openViewer);
    if (previewable) {
      const open = createButton(
        doc,
        "llm-saved-file-open",
        t("Open HTML preview viewer"),
        "⛶",
      );
      open.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void readText(path).then((source) => {
          if (source !== null) options.openViewer?.(source, card);
        });
      });
      actions.appendChild(open);
    }
  }
  card.append(icon, text, actions);
  return card;
}

/**
 * Draws the turn's file cards into `host` once they are known. Each card is
 * marked as a "file" item, so it gets a →| button in the standalone window and
 * a row in Miscellaneous, like the other things the answer made.
 */
export async function mountSavedFileCards(
  host: HTMLElement,
  params: Parameters<typeof resolveTurnSavedFiles>[0] &
    SavedFileCardOptions & {
      /** Called once the cards are in, so the chat can keep its scroll. */
      onMounted?: () => void;
    },
): Promise<void> {
  const paths = await resolveTurnSavedFiles(params);
  if (!paths.length || !host.isConnected) return;
  const doc = host.ownerDocument;
  const cards = await Promise.all(
    paths.map((path) => createSavedFileCard(doc, path, params)),
  );
  host.replaceChildren(...cards);
  host.hidden = false;
  params.onMounted?.();
  if (isOutsideAnswerContent(host)) return;
  for (const card of cards) {
    const path = card.dataset.savedFilePath || "";
    card.setAttribute(SIDE_ITEM_KIND_ATTRIBUTE, "file");
    appendMoveToSidePanelButton({
      doc,
      parent: card.querySelector(".llm-saved-file-actions") || card,
      className: "llm-saved-file-btn llm-side-move-glyph",
      buildRequest: () => ({
        kind: "file",
        title: fileBaseName(path),
        source: path,
        filePath: path,
        element: card,
      }),
    });
  }
}

/**
 * A saved file in a side panel tab, read from disk each time: a page in the
 * safe box, Markdown rendered, text as code, a picture as itself. A file that
 * is gone, too big, or of another type says so.
 */
export async function renderSavedFileInto(
  doc: Document,
  root: HTMLElement,
  path: string,
  render: {
    markdown: (target: HTMLElement, markdown: string) => void;
  },
): Promise<void> {
  const note = (text: string) => {
    const box = doc.createElement("div");
    box.className = "llm-saved-file-note";
    box.textContent = text;
    root.replaceChildren(box);
  };
  const stat = await statLocalPath(path);
  if (!stat.exists || stat.isDirectory) {
    note(
      t(
        "This file is no longer there. It may have been moved, renamed, or deleted.",
      ),
    );
    return;
  }
  const preview = savedFilePreviewKind(path);
  if (preview === "none") {
    note(t("This kind of file can't be shown here. Use Show in folder."));
    return;
  }
  if ((stat.size || 0) > SAVED_FILE_PREVIEW_MAX_BYTES) {
    note(t("This file is too big to show here. Use Show in folder."));
    return;
  }
  if (preview === "image") {
    const img = doc.createElement("img") as HTMLImageElement;
    img.className = "llm-saved-file-image";
    img.alt = fileBaseName(path);
    img.src = toFileUrl(path) || path;
    root.replaceChildren(img);
    return;
  }
  const source = await readText(path);
  if (source === null) {
    note(t("This file could not be read."));
    return;
  }
  if (preview === "html") {
    root.replaceChildren(
      createSandboxedHtmlFrame(doc, source, "llm-side-panel-item-frame"),
    );
    return;
  }
  const box = doc.createElement("div");
  box.className = "llm-standalone-side-panel-item-rendered";
  root.replaceChildren(box);
  render.markdown(
    box,
    preview === "markdown" ? source : fenceAround(fileExtension(path), source),
  );
}
