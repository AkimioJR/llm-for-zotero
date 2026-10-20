import { assert } from "chai";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAllSkills, setUserSkills } from "../src/agent/skills/catalog";
import { parseSkill } from "../src/agent/skills/skillLoader";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import {
  renderAgentPromptEnvelope,
  stringifyMessageContent,
} from "../src/agent/model/messageBuilder";

/**
 * Per-turn prompt budget: serialized tools + fixed system prompt + the
 * per-turn user message (dynamic guidance, resource context and request), for
 * the three common turn shapes, with the bundled skill inventory installed. The
 * caps are what this same measurement gives at ff8eaf7e (the commit before the
 * agent tool consolidation), so moving always-on rules into per-turn guidance
 * cannot silently grow a turn. The global and collection caps were raised on
 * purpose by the workflow sentence that asks for a digest part when the work
 * needs one result per paper (274 characters, 2026-10-02), and again by
 * submit_document's excluded list, which records the papers a document
 * leaves out (214 tool characters, 2026-10-02), and again by literature_search
 * saying that its metadata mode proposes changes for the user to approve, so
 * a review never asks to change an item it only reads, and that it searches
 * outside the library only on request (324 tool characters, 2026-10-03),
 * and again by the citation contract saying how to quote a passage that has
 * no ID instead of constructing one, and to copy quoted text with its
 * extraction artifacts (190 characters, 2026-10-09), and again by the
 * agent stop rules' lookup-first route: library_search says to look a named
 * paper up by title or author first, and the library_retrieve guidance tells
 * a candidate from a found paper and a paper's passage absence from its
 * absence from the library (249 characters, 2026-10-13), and again when
 * that guidance said to check a candidate's title and authors against what
 * was asked and to name it with what matches and what does not, after a
 * benchmark run where the shorter rule led to a false "not in your
 * library" for a paper the agent had read (100 characters, 2026-10-13).
 * All three caps were raised again by past_chat_read, the always-listed tool
 * that opens past chats the user attached to the conversation (510 tool
 * characters, 2026-10-18); a turn with nothing attached is otherwise
 * unchanged. Raised again by its query search (the query field and one
 * sentence of description: 133, 99 and 133 characters, 2026-10-18). Raised
 * again by past_chat_search and past_chat_attach, the always-listed tools
 * that find an earlier chat and add it to the user's message (733
 * characters each, 2026-10-19). Raised again by note_write's removeEmbeds field
 * (58 characters, 2026-10-19). Raised again by the search routing contract,
 * the one owner of when to search which source, and the plugin Agent's map
 * from source families to its tools with the selection-card rule: 555 fixed
 * prompt characters after removing the persona and capability-context
 * routing copies they replace, less 36 tool characters (literature_search,
 * paper_read) and 22 or 6 turn characters (paper_read guidance, single-paper
 * line), for net growth of 497, 513 and 497 characters (2026-10-20). Raised by 30
 * each (29 fixed prompt characters for the rule to use a source the user
 * names, and one turn character), to 37,974, 36,707 and 38,072. Raised by
 * 294 tool characters each for literature_search's required reason for an
 * outside search: the need and gap fields and one sentence defining them
 * (2026-10-20), to 38,268, 37,001 and 38,366. Lowered by 30 each by dropping the source
 * list from literature_search's description (2026-10-20), to 38,238, 36,971
 * and 38,336. Raised by 185 fixed prompt characters each for the search
 * routing contract's rule to read outside sources only with search and
 * web-read tools, never with shell commands (2026-10-20), to 38,423, 37,156
 * and 38,521. Raised by 11 fixed prompt characters each for "or scripts"
 * in that rule (2026-10-20), to 38,434, 37,167 and 38,532.
 */
const TURN_BUDGETS: Record<string, number> = {
  global: 38_434,
  paper: 37_167,
  collection: 38_532,
};

const TURNS: Record<string, Record<string, unknown>> = {
  global: {
    conversationKey: 1,
    mode: "agent",
    userText: "Which papers in my library discuss grid cells?",
    libraryID: 1,
    conversationKind: "global",
  },
  paper: {
    conversationKey: 2,
    mode: "agent",
    userText: "Summarize this paper.",
    libraryID: 1,
    conversationKind: "paper",
    activeItemId: 5,
    selectedPaperContexts: [{ itemId: 5, contextItemId: 6, title: "P" }],
  },
  collection: {
    conversationKey: 3,
    mode: "agent",
    userText: "What methods do the papers in this collection use?",
    libraryID: 1,
    conversationKind: "global",
    selectedCollectionContexts: [
      { collectionId: 9, libraryID: 1, name: "Grid cells" },
    ],
  },
};

async function measureTurn(input: Record<string, unknown>) {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  const request = resolveAgentRuntimeRequest(input as never);
  const tools = registry.listToolsForRequest(request);
  const toolCharacters = tools
    .map((tool) =>
      [tool.name, tool.description, JSON.stringify(tool.inputSchema)].join(
        "\n",
      ),
    )
    .join("\n\n").length;
  const rendered = await renderAgentPromptEnvelope(
    request,
    registry.listToolDefinitionsForRequest(request),
    [],
  );
  const fixedPrompt = rendered.inventory.fixedPrompt.length;
  // The whole per-turn user message: dynamic tool guidance, permission-mode
  // guidance, resource context and the request itself.
  const turnMessage = stringifyMessageContent(
    rendered.envelope.turnMessage.content,
  ).length;
  return {
    toolCharacters,
    fixedPrompt,
    dynamicGuidance: (rendered.inventory.dynamicGuidance || "").length,
    turnMessage,
    total: toolCharacters + fixedPrompt + turnMessage,
  };
}

/** The bundled skills, as a fresh profile installs them. */
function loadBundledSkills() {
  const dir = join(__dirname, "../src/agent/skills");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseSkill(readFileSync(join(dir, name), "utf8")));
}

describe("per-turn prompt budget", function () {
  let previousSkills: ReturnType<typeof getAllSkills>;
  let previousZotero: unknown;
  before(function () {
    previousSkills = getAllSkills();
    previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
    // TURN_BUDGETS are pinned against the macOS runtime platform guidance;
    // pin Zotero.isMac so Linux CI (+12 chars) and Windows (+63 chars) measure
    // the same platform string as macOS.
    (globalThis as { Zotero?: unknown }).Zotero = {
      ...((previousZotero as Record<string, unknown>) || {}),
      isMac: true,
      isWin: false,
    };
    // Measure with the installed skill inventory a real profile renders.
    setUserSkills(loadBundledSkills());
  });
  after(function () {
    setUserSkills(previousSkills);
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
  });

  for (const [name, input] of Object.entries(TURNS)) {
    it(`keeps a ${name} turn within its pre-consolidation size`, async function () {
      const measured = await measureTurn(input);
      if (process.env.PROMPT_TURN_BUDGET_REPORT) {
        console.log(`PROMPT_TURN_BUDGET ${name} ${JSON.stringify(measured)}`);
      }
      assert.isAtMost(measured.total, TURN_BUDGETS[name], name);
    });
  }
});
