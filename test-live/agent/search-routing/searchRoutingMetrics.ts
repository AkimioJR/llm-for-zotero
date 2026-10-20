/**
 * Pure helpers for the search-routing live suite
 * (searchRouting.live.workflow.test.ts): which evidence rung a tool call
 * belongs to, the per-rep routing summary, and the summary table. No Zotero
 * access here, so the rules can be read and checked on their own.
 */

/**
 * The evidence ladder's rungs, as tool families:
 * - local: the turn's papers and the user's library
 * - scholarly: outside scholarly search
 * - web: outside web search and page reads
 * - card: the paper selection (import) card
 * - shell: shell commands (for example curl to a literature API); not a rung,
 *   counted because outside sources must not be read this way
 * - other: everything else (skills, task updates, writes)
 */
export type ToolFamily =
  | "local"
  | "scholarly"
  | "web"
  | "card"
  | "shell"
  | "other";

const FAMILY_BY_TOOL: Record<string, ToolFamily> = {
  paper_read: "local",
  library_retrieve: "local",
  library_search: "local",
  library_read: "local",
  context_read: "local",
  // Reads an attachment of the turn's papers; the same rung as paper_read.
  read_attachment: "local",
  literature_search: "scholarly",
  web_search: "web",
  web_read: "web",
  literature_review: "card",
  // The plugin registry's only shell tool.
  run_command: "shell",
};

export function classifyTool(name: string): ToolFamily {
  return FAMILY_BY_TOOL[name] || "other";
}

export function isOutsideFamily(family: ToolFamily): boolean {
  return family === "scholarly" || family === "web";
}

export type RoutingCall = {
  name: string;
  family: ToolFamily;
  /** One-based model round the call was made in (agent requests so far). */
  round: number;
  args: unknown;
  ok?: boolean;
  error?: string;
  startedMs: number;
};

export type RoutingCard = {
  toolName: string;
  title: string;
  rows: number;
  resolvedAs: string;
};

export type RoutingRepSummary = {
  toolSequence: string;
  families: ToolFamily[];
  familyCounts: Record<ToolFamily, number>;
  outsideCalls: number;
  localCalls: number;
  /** Shell commands run in the rep (run_command). */
  shellCalls: number;
  literatureReviewCalls: number;
  confirmations: number;
  firstLocalRound: number | null;
  firstOutsideRound: number | null;
  /**
   * Whether a local (rung 1 or 2) call came before, or in the same round
   * as, the first outside call. null when the rep made no outside call.
   */
  localBeforeOutside: boolean | null;
};

/** One rep's routing facts, from its ordered tool calls and cards. */
export function summarizeRoutingRep(
  calls: RoutingCall[],
  cards: RoutingCard[],
): RoutingRepSummary {
  const familyCounts: Record<ToolFamily, number> = {
    local: 0,
    scholarly: 0,
    web: 0,
    card: 0,
    shell: 0,
    other: 0,
  };
  for (const call of calls) familyCounts[call.family] += 1;
  const firstLocal = calls.find((call) => call.family === "local");
  const firstOutside = calls.find((call) => isOutsideFamily(call.family));
  const firstLocalRound = firstLocal ? firstLocal.round : null;
  const firstOutsideRound = firstOutside ? firstOutside.round : null;
  return {
    toolSequence: calls.map((call) => call.name).join(" → "),
    families: (Object.keys(familyCounts) as ToolFamily[]).filter(
      (family) => familyCounts[family] > 0,
    ),
    familyCounts,
    outsideCalls: familyCounts.scholarly + familyCounts.web,
    localCalls: familyCounts.local,
    shellCalls: familyCounts.shell,
    literatureReviewCalls: calls.filter(
      (call) => call.name === "literature_review",
    ).length,
    confirmations: cards.length,
    firstLocalRound,
    firstOutsideRound,
    localBeforeOutside:
      firstOutsideRound === null
        ? null
        : firstLocalRound !== null && firstLocalRound <= firstOutsideRound,
  };
}

/** Key-shaped strings removed from anything written to a report. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === "string")
    return value
      .replace(/\bsk-[\w*-]{6,}/g, "[key]")
      .replace(/\btvly-[\w-]{6,}/g, "[key]")
      .replace(/\bAIza[\w-]{10,}/g, "[key]")
      .replace(/\bBearer\s+[\w.-]{8,}/gi, "Bearer [key]") as T;
  if (Array.isArray(value)) return value.map(redactSecrets) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = /api[-_]?key|authorization|secret|token$/i.test(key)
        ? "[redacted]"
        : redactSecrets(entry);
    }
    return out as T;
  }
  return value;
}

export type SummaryRow = {
  caseId: string;
  rep: number | string;
  status: string;
  wallSeconds?: number;
  rounds?: number;
  local?: number;
  scholarly?: number;
  web?: number;
  shell?: number;
  card?: number;
  confirmations?: number;
  localBeforeOutside?: boolean | null;
  citesPaper?: boolean;
  answerChars?: number;
  hardFailures?: string[];
  toolSequence?: string;
};

const SUMMARY_COLUMNS: Array<[string, (row: SummaryRow) => unknown]> = [
  ["case", (row) => row.caseId],
  ["rep", (row) => row.rep],
  ["status", (row) => row.status],
  ["wall s", (row) => row.wallSeconds],
  ["rounds", (row) => row.rounds],
  ["local", (row) => row.local],
  ["scholarly", (row) => row.scholarly],
  ["web", (row) => row.web],
  ["shell", (row) => row.shell],
  ["card", (row) => row.card],
  ["confirms", (row) => row.confirmations],
  [
    "local first",
    (row) =>
      row.localBeforeOutside === undefined
        ? ""
        : row.localBeforeOutside === null
          ? "n/a"
          : row.localBeforeOutside
            ? "yes"
            : "no",
  ],
  [
    "cites paper",
    (row) =>
      row.citesPaper === undefined ? "" : row.citesPaper ? "yes" : "no",
  ],
  ["answer chars", (row) => row.answerChars],
  ["hard failures", (row) => (row.hardFailures || []).join("; ")],
  ["tools", (row) => row.toolSequence],
];

/** A Markdown table of every rep, one row each. */
export function formatSummaryTable(rows: SummaryRow[]): string {
  const cell = (value: unknown) =>
    String(value ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ");
  return [
    `| ${SUMMARY_COLUMNS.map(([name]) => name).join(" | ")} |`,
    `|${"---|".repeat(SUMMARY_COLUMNS.length)}`,
    ...rows.map(
      (row) =>
        `| ${SUMMARY_COLUMNS.map(([, value]) => cell(value(row))).join(" | ")} |`,
    ),
  ].join("\n");
}
