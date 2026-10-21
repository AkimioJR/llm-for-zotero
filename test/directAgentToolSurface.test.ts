import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { renderAgentPromptEnvelope } from "../src/agent/model/messageBuilder";

describe("direct Agent model tool surface", function () {
  it("keeps the fixed ordinary tool and prompt payload within the migration targets", async function () {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    // An ordinary turn runs as the Original Agent, so task_update counts.
    const request = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "Answer a question about my library",
      libraryID: 1,
      executionContext: {
        version: 1,
        executionId: "execution-1",
        conversationKey: 1,
        conversationGeneration: 0,
        chatLibraryID: 1,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: { libraryIDs: [1], outputDirectories: [] },
      },
    });

    const tools = registry.listToolsForRequest(request);
    const serializedToolCharacters = tools
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

    // Includes concrete figure selectors, the native image-embedding contract
    // and task_update. Each cap is the next whole thousand above the measured
    // payload: 23,477 tool characters and 32,106 with the fixed prompt
    // (2026-10-03, after task_update named excluded and replaces, the
    // workflow asked for a digest part per per-paper result, submit_document
    // named excluded, and literature_search said it searches outside the
    // library and its metadata mode proposes changes). The tool cap was
    // raised to 24,100 by past_chat_read, the always-listed tool
    // that opens past chats the user attached (24,035 tool characters and
    // 32,854 with the fixed prompt, 2026-10-18), and to 24,200 by its query
    // search (24,171 tool characters, 2026-10-18), and to 25,000 by
    // past_chat_search and past_chat_attach, the always-listed tools that
    // find an earlier chat and add it (24,904 tool characters, 2026-10-19);
    // the same two tools raised the cap with the fixed prompt to 34,000
    // (33,723 characters). The search routing contract and the plugin
    // Agent's search-tool map raised that cap by exactly their measured net
    // growth, 519 characters, to 34,519 (34,300 characters, from 33,781;
    // 24,926 tool characters, 2026-10-20), and by 29 more for the rule to use
    // a source the user names, to 34,548. literature_search's required
    // reason for an outside search (the need and gap fields and one
    // sentence defining them) raised both caps by its measured 294 tool
    // characters, to 25,220 and 34,623 (2026-10-20); dropping the source list from
    // literature_search's description lowered both by 30, to 25,190 and 34,593.
    // The search routing contract's rule to read outside sources only with
    // search and web-read tools, never with shell commands, raised the cap
    // with the fixed prompt by its measured 185 characters, to 34,778
    // (2026-10-20); "or scripts" in that rule raised it by 11, to 34,789.
    // literature_search's description naming the find path
    // (workflow:'review' leads to the selection card) and that a review
    // search needs no gap, which replaced the card branch on every answer
    // result, raised both caps by its measured 62 tool characters, to
    // 25,252 and 34,851 (2026-10-20). The search routing contract's
    // nothing-attached rule (the library in its own step before any outside
    // search, then a library answer with an offer to search outside, or
    // scholarly search unasked when it holds nothing relevant; several
    // sources in one step only when something is attached) raised the cap
    // with the fixed prompt by its measured 315 characters, to 35,166
    // (2026-10-20). Rewording that rule and extending the selection-card
    // sentence to a review with no relevant library papers raised the cap by
    // a net 24 characters, to 35,190.
    assert.isAtMost(serializedToolCharacters, 25_252);
    assert.isAtMost(
      rendered.inventory.fixedPrompt.length + serializedToolCharacters,
      35_190,
    );
    assert.includeMembers(
      tools.map((tool) => tool.name),
      [
        "task_update",
        "library_search",
        "paper_read",
        "library_update",
        "note_write",
        "submit_document",
        "request_user_input",
        "load_skill",
      ],
    );
  });
});
