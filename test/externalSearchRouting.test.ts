import { assert } from "chai";
import {
  AGENT_PERSONA_INSTRUCTIONS,
  AGENT_SEARCH_TOOL_ROUTES,
} from "../src/agent/model/agentPersona";
import {
  renderAgentPromptEnvelope,
  stringifyMessageContent,
} from "../src/agent/model/messageBuilder";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { buildZoteroEnvironmentManifest } from "../src/codexAppServer/nativeClient";
import {
  CORE_RESEARCH_CONTRACT,
  RUNTIME_CAPABILITY_CONTEXT,
  SEARCH_ROUTING_CONTRACT,
} from "../src/shared/instructionContracts";
import type {
  AgentRuntimeRequest,
  AgentToolDefinition,
} from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function registry() {
  return createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
}

function request(userText: string): AgentRuntimeRequest {
  return resolvedAgentRequest({
    conversationKey: Math.floor(Math.random() * 1_000_000),
    mode: "agent",
    userText,
    libraryID: 1,
  });
}

function guidanceTools(): {
  web: AgentToolDefinition<any, any>;
  literature: AgentToolDefinition<any, any>;
} {
  const tools = registry();
  const web = tools.getTool("web_search");
  const literature = tools.getTool("literature_search");
  assert.exists(web);
  assert.exists(literature);
  return { web: web!, literature: literature! };
}

function guidanceMatches(
  tool: AgentToolDefinition<any, any>,
  value: AgentRuntimeRequest,
): boolean {
  return tool.guidance?.matches(value) || false;
}

/** Outside sources are read with search and web-read tools, not shell. */
const NO_SHELL_RULE =
  "Read outside sources only with search and web-read tools, never with shell commands or scripts unless the user asks; if a text cannot be read, answer from what you have and say what was not read.";

describe("external search guidance routing", function () {
  it("does not route absent semantic intent from English or multilingual words", function () {
    const { web, literature } = guidanceTools();
    for (const text of [
      "Search the web for release notes",
      "查找最新论文",
      "find papers online",
    ]) {
      assert.isFalse(guidanceMatches(web, request(text)));
      assert.isFalse(guidanceMatches(literature, request(text)));
    }
  });
  it("keeps search routing in the one contract the persona carries", function () {
    const persona = AGENT_PERSONA_INSTRUCTIONS.join("\n");
    assert.include(persona, SEARCH_ROUTING_CONTRACT);
    for (const rule of [
      "name an action, not a source",
      "use a source the user names",
      "use the nearest source that can hold it",
      "Skip a source that cannot hold the need",
      "distinct needs use both",
      "With nothing attached, look in the library first",
      "If a needed source is unavailable, say so",
      NO_SHELL_RULE,
    ])
      assert.include(SEARCH_ROUTING_CONTRACT, rule);
    // The capability context's escape hatch stays for explicit or
    // unsupported work; outside reading has its own rule above.
    assert.include(
      RUNTIME_CAPABILITY_CONTEXT,
      "use shell, file, or script escape hatches only for explicit or unsupported work",
    );
    // The language rule is owned by the core research contract.
    assert.include(CORE_RESEARCH_CONTRACT, "use the user's language");
    assert.notInclude(persona, "Preserve the user's language");
    // The earlier routing copies that told the model to search outside
    // sources whenever a request said "search" are gone.
    assert.notInclude(persona, "External evidence routing");
    assert.notInclude(persona, "both source families");
    assert.notInclude(RUNTIME_CAPABILITY_CONTEXT, "external search");
    assert.include(
      RUNTIME_CAPABILITY_CONTEXT,
      "look up any other named target",
    );
    assert.notInclude(persona, "Start with basic depth");
    assert.notInclude(persona, "focused lookup");
    assert.notInclude(persona, "exploratory or ambiguous discovery");
  });

  it("delivers the contract once to every runtime and the card rule only to the plugin Agent", async function () {
    const count = (text: string, needle: string) =>
      text.split(needle).length - 1;
    const cardRule = "only when the user asks you to find or recommend papers";
    assert.include(AGENT_SEARCH_TOOL_ROUTES, cardRule);

    // Plugin Agent: the fixed system prompt (cached prefix), not the turn.
    const tools = registry();
    const value = request("Search whether other studies found the same result");
    const rendered = await renderAgentPromptEnvelope(
      value,
      tools.listToolDefinitionsForRequest(value),
      [],
    );
    const fixedPrompt = rendered.inventory.fixedPrompt;
    assert.equal(count(fixedPrompt, SEARCH_ROUTING_CONTRACT), 1);
    assert.equal(count(fixedPrompt, NO_SHELL_RULE), 1);
    assert.equal(count(fixedPrompt, AGENT_SEARCH_TOOL_ROUTES), 1);
    const turn = stringifyMessageContent(rendered.envelope.turnMessage.content);
    assert.notInclude(turn, "## Search routing");
    assert.notInclude(turn, NO_SHELL_RULE);
    assert.notInclude(turn, cardRule);

    // Claude Code bridge: it sends the persona as its Agent-mode block.
    const bridgeBlock = AGENT_PERSONA_INSTRUCTIONS.join("\n\n");
    assert.equal(count(bridgeBlock, SEARCH_ROUTING_CONTRACT), 1);
    assert.equal(count(bridgeBlock, NO_SHELL_RULE), 1);
    assert.notInclude(bridgeBlock, cardRule);
    assert.notInclude(bridgeBlock, "literature_review");

    // Codex app-server: the Zotero environment manifest.
    for (const mcpReady of [true, false]) {
      const manifest = buildZoteroEnvironmentManifest({
        scope: {
          conversationKey: 1,
          libraryID: 1,
          kind: "paper",
          paperItemID: 11,
          activeItemId: 11,
          activeContextItemId: 12,
          paperTitle: "Prompt Paper",
        },
        mcpEnabled: true,
        mcpReady,
      });
      assert.equal(count(manifest, SEARCH_ROUTING_CONTRACT), 1);
      assert.equal(count(manifest, NO_SHELL_RULE), 1);
      assert.notInclude(manifest, cardRule);
      assert.notInclude(manifest, "literature_review");
    }
  });

  it("keeps routing out of the external search tool descriptions", function () {
    const { web, literature } = guidanceTools();
    const modelDescriptions = new Map(
      registry()
        .listTools()
        .map((spec) => [spec.name, spec.description]),
    );
    for (const text of [
      web.spec.description,
      web.guidance?.instruction || "",
      literature.spec.description,
      modelDescriptions.get("literature_search") || "",
    ]) {
      assert.notMatch(text, /only when the user asks to find/);
      assert.notMatch(text, /Use (literature|web)_search (for|when)/);
      assert.notInclude(text, "never for work on papers already");
    }
    assert.include(
      web.spec.description,
      "write the query in the user's language by default",
    );
    assert.match(
      modelDescriptions.get("paper_read") || "",
      /^Read or search the turn's papers; mode:targeted with query finds passages\./,
    );
  });
});
