import { config } from "../../package.json";
import { getIOUtils } from "./geckoFs";
import { joinLocalPath } from "./localPath";

/**
 * Where the agent saves files it makes for the user: one folder per paper
 * under `<Zotero data dir>/llm-for-zotero-files/`, named `<item key> - <short
 * name>`, and one per library for Library chat. The folder sits next to the
 * MinerU cache, never inside it, so clearing that cache keeps these files.
 *
 * A folder is found by its key, never by its name: a renamed paper keeps its
 * old folder, and the plugin never renames or deletes one on its own.
 */

export const AGENT_FILES_DIR_NAME = "llm-for-zotero-files";
/** Helper scripts and scratch files: no file card. */
export const AGENT_FILES_WORK_FOLDER = ".work";
export const LIBRARY_FILES_FOLDER = "Library";

const AGENT_FILES_DIR_PREF_KEY = `${config.prefsPrefix}.agentFilesDirectory`;
const MAX_SHORT_NAME_LENGTH = 48;
/** Words a short title skips, so "The" or "of" never name a folder. */
const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "the",
  "to",
  "via",
  "with",
]);

type ZoteroLike = {
  DataDirectory?: { dir?: string };
  Profile?: { dir?: string };
  Prefs?: { get?: (key: string, global?: boolean) => unknown };
  Items?: { get?: (id: number) => unknown };
  Libraries?: {
    userLibraryID?: number;
    getName?: (libraryID: number) => string;
  };
};

type ItemLike = {
  key?: string;
  libraryID?: number;
  getField?: (field: string) => unknown;
  getCreators?: () => Array<{ lastName?: string; name?: string }>;
};

function getZotero(): ZoteroLike | undefined {
  return (globalThis as typeof globalThis & { Zotero?: ZoteroLike }).Zotero;
}

/** The root every agent folder lives in; a pref may move it. */
export function getAgentFilesRoot(): string | null {
  const zotero = getZotero();
  const custom = zotero?.Prefs?.get?.(AGENT_FILES_DIR_PREF_KEY, true);
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  const base =
    zotero?.DataDirectory?.dir?.trim() || zotero?.Profile?.dir?.trim();
  return base ? joinLocalPath(base, AGENT_FILES_DIR_NAME) : null;
}

/** Removes what a file name cannot hold on macOS, Windows, or Linux. */
export function sanitizeFolderNamePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
}

/** "Raghavan 2024 Engineering Flexible Machine" from author, year, title. */
export function buildShortPaperName(params: {
  firstCreator?: string;
  year?: string;
  title?: string;
}): string {
  const titleWords = (params.title || "")
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((word) => word && !TITLE_STOP_WORDS.has(word.toLowerCase()))
    .slice(0, 4);
  const parts = [params.firstCreator, params.year, ...titleWords]
    .map((part) => sanitizeFolderNamePart(part || ""))
    .filter(Boolean);
  let name = "";
  for (const part of parts) {
    const next = name ? `${name} ${part}` : part;
    if (next.length > MAX_SHORT_NAME_LENGTH) break;
    name = next;
  }
  return name || sanitizeFolderNamePart(params.title || "").slice(0, 48);
}

export function buildPaperFolderName(key: string, shortName: string): string {
  const name = sanitizeFolderNamePart(shortName);
  return name ? `${key} - ${name}` : key;
}

/** True for `KEY` and `KEY - anything`: the paper's folder whatever its name. */
export function isFolderForKey(folderName: string, key: string): boolean {
  return folderName === key || folderName.startsWith(`${key} - `);
}

function readItemShortName(item: ItemLike): string {
  const field = (name: string) => {
    try {
      const value = item.getField?.(name);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };
  let firstCreator = "";
  try {
    const creator = item.getCreators?.()[0];
    firstCreator = creator?.lastName || creator?.name || "";
  } catch {
    /* no creators */
  }
  const year = (field("date").match(/\b(\d{4})\b/) || [])[1] || "";
  return buildShortPaperName({ firstCreator, year, title: field("title") });
}

export type AgentFilesTarget =
  | { kind: "paper"; itemId: number }
  | { kind: "library"; libraryID: number };

/** The folder name for a target, before any existing folder is looked up. */
function describeTarget(
  target: AgentFilesTarget,
): { key: string; name: string } | null {
  const zotero = getZotero();
  if (target.kind === "library") {
    const userLibraryID = zotero?.Libraries?.userLibraryID;
    if (!target.libraryID || target.libraryID === userLibraryID) {
      return { key: LIBRARY_FILES_FOLDER, name: LIBRARY_FILES_FOLDER };
    }
    let libraryName = "";
    try {
      libraryName = zotero?.Libraries?.getName?.(target.libraryID) || "";
    } catch {
      /* unnamed */
    }
    const key = `${LIBRARY_FILES_FOLDER} ${target.libraryID}`;
    return { key, name: buildPaperFolderName(key, libraryName) };
  }
  const item = zotero?.Items?.get?.(target.itemId) as ItemLike | undefined;
  const key = typeof item?.key === "string" ? item.key.trim() : "";
  if (!item || !key) return null;
  return { key, name: buildPaperFolderName(key, readItemShortName(item)) };
}

/**
 * The folder files for this target go in: the existing folder for its key
 * when there is one (even under an old name), else a new name. Nothing is
 * created here; a write creates the folder.
 */
export async function resolveAgentFilesFolder(
  target: AgentFilesTarget,
): Promise<string | null> {
  const root = getAgentFilesRoot();
  const described = describeTarget(target);
  if (!root || !described) return null;
  const IOUtils = getIOUtils();
  try {
    if (IOUtils?.getChildren && (await IOUtils.exists?.(root))) {
      const children = await IOUtils.getChildren(root);
      const existing = children
        .map((child) => child.split(/[\\/]/).pop() || "")
        .filter((name) => isFolderForKey(name, described.key))
        .sort()[0];
      if (existing) return joinLocalPath(root, existing);
    }
  } catch {
    /* fall back to the new name */
  }
  return joinLocalPath(root, described.name);
}

/** The folder for a turn: the paper's in a paper chat, else the library's. */
export function agentFilesTargetForScope(scope: {
  conversationKind?: "global" | "paper";
  libraryID?: number;
  paperItemId?: number;
}): AgentFilesTarget {
  return scope.conversationKind === "paper" && scope.paperItemId
    ? { kind: "paper", itemId: scope.paperItemId }
    : { kind: "library", libraryID: scope.libraryID || 0 };
}

/** The instructions every runtime gets about pages and saved files. */
export function buildAgentFilesInstruction(folder: string | null): string {
  const lines = [
    "Pages and files you make:",
    '- A web page, interactive explainer, or "HTML file" to read: put the whole page in the answer as one ```html block (the chat previews it safely). Do not also save it.',
    "- Save to disk only when the user wants the file itself (save, export, download, a named place) or it cannot be shown in an answer (data, binaries, many files).",
  ];
  if (folder) {
    lines.push(
      `- Save files for this chat in: ${folder} (create it if missing), unless the user names another place. Never overwrite a file there; pick a new name (name-2.html).`,
      `- Helper scripts and scratch files go in ${joinLocalPath(folder, AGENT_FILES_WORK_FOLDER)}.`,
    );
  }
  lines.push("- Give each saved file's full path in the answer.");
  return lines.join("\n");
}

/** The instructions for a turn, with its folder looked up. */
export async function buildAgentFilesInstructionForScope(scope: {
  conversationKind?: "global" | "paper";
  libraryID?: number;
  paperItemId?: number;
}): Promise<string> {
  let folder: string | null = null;
  try {
    folder = await resolveAgentFilesFolder(agentFilesTargetForScope(scope));
  } catch {
    folder = null;
  }
  return buildAgentFilesInstruction(folder);
}
