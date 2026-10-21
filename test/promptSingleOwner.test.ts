import { assert } from "chai";
import { readFileSync } from "node:fs";
import {
  AGENT_PERSONA_INSTRUCTIONS,
  AGENT_SEARCH_TOOL_ROUTES,
} from "../src/agent/model/agentPersona";
import { WHOLE_LIBRARY_SCOPE_RULE } from "../src/agent/context/turnContextEnvelope";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { CLAUDE_BRIDGE_SEARCH_TOOL_ROUTES } from "../src/agent/externalBackendBridge";
import { CODEX_SEARCH_TOOL_ROUTES } from "../src/codexAppServer/nativeClient";

/**
 * Every behavioral prompt rule has one owner. An owner is one tool (its
 * description, model-facing description, and guidance together), the
 * persona (all its sections, the shared contracts it carries and the plugin
 * Agent's search-tool map), one shipped skill file, the message
 * builder's hard-coded prompt sections, the whole-library turn line, or
 * the Claude Code bridge's or Codex's search-tool line. A marker phrase
 * distinctive for a rule must appear in exactly the expected owners.
 */
function stubDependency(): never {
  const stub: unknown = new Proxy(function () {}, {
    get: (_target, property) =>
      property === "then" ? undefined : stubDependency(),
    apply: () => undefined,
  });
  return stub as never;
}

function collectOwnerTexts(): Map<string, string> {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: stubDependency(),
    pdfService: stubDependency(),
    pdfPageService: stubDependency(),
    retrievalService: stubDependency(),
  });
  const modelDescriptions = new Map(
    registry.listTools().map((spec) => [spec.name, spec.description]),
  );
  const owners = new Map<string, string>();
  owners.set(
    "persona",
    [...AGENT_PERSONA_INSTRUCTIONS, AGENT_SEARCH_TOOL_ROUTES].join("\n"),
  );
  for (const tool of registry.listToolDefinitions()) {
    owners.set(
      `tool:${tool.spec.name}`,
      [
        tool.spec.description,
        modelDescriptions.get(tool.spec.name) || "",
        tool.guidance?.instruction || "",
      ].join("\n"),
    );
  }
  for (const [filename, content] of Object.entries(BUILTIN_SKILL_FILES)) {
    owners.set(`skill:${filename}`, content);
  }
  // The nothing-attached turn line states the scope; routing stays in the
  // persona's search routing contract.
  owners.set("turnContext:wholeLibrary", WHOLE_LIBRARY_SCOPE_RULE);
  // Each external runtime maps the search families to its own tools.
  owners.set("runtime:claudeBridge", CLAUDE_BRIDGE_SEARCH_TOOL_ROUTES);
  owners.set("runtime:codex", CODEX_SEARCH_TOOL_ROUTES);
  owners.set(
    "messageBuilder",
    readFileSync(
      new URL("../src/agent/model/messageBuilder.ts", import.meta.url),
      "utf8",
    ),
  );
  return owners;
}

function ownersOf(owners: Map<string, string>, marker: string): string[] {
  return Array.from(owners.entries())
    .filter(([, text]) => text.includes(marker))
    .map(([owner]) => owner)
    .sort();
}

describe("prompt rules have a single owner", function () {
  const rules: Array<{
    rule: string;
    marker: string;
    owner: string | string[];
  }> = [
    {
      rule: "paper_read mode selection",
      marker: "mode:'overview'",
      owner: "tool:paper_read",
    },
    {
      rule: "paper_read evidence-progress handling",
      marker: "paperEvidenceProgress",
      owner: "tool:paper_read",
    },
    {
      rule: "paper_read single-fact topK default",
      marker: "topK:3",
      owner: "tool:paper_read",
    },
    {
      rule: "collection scope never reads the active paper implicitly",
      marker: "implicit target",
      owner: "tool:paper_read",
    },
    {
      rule: "library_retrieve body-evidence floor",
      marker: "papersBodyRead",
      owner: "tool:library_retrieve",
    },
    {
      rule: "literature discovery never imports",
      marker: "discovery never imports",
      owner: "tool:literature_search",
    },
    {
      rule: "search names an action, not a source",
      marker: "name an action, not a source",
      owner: "persona",
    },
    {
      rule: "a source the user names is used",
      marker: "use a source the user names",
      owner: "persona",
    },
    {
      rule: "the nearest source that can hold a need comes first",
      marker: "nearest source that can hold it",
      owner: "persona",
    },
    {
      rule: "scholarly and public-fact needs map to search families",
      marker: "distinct needs use both",
      owner: "persona",
    },
    {
      rule: "outside sources are never read with shell commands",
      marker: "never with shell commands",
      owner: "persona",
    },
    {
      rule: "an unreadable outside text is named, not worked around",
      marker: "say what was not read",
      owner: "persona",
    },
    {
      rule: "the selection card answers only a find or recommend request",
      marker: "only when the user asks you to find or recommend papers",
      owner: "persona",
    },
    {
      rule: "with nothing attached, the library is searched in its own step",
      marker: "search the library first, in a step of its own",
      owner: "persona",
    },
    {
      rule: "with nothing attached, relevant library papers answer, with an offer",
      marker: "offer to search outside",
      owner: "persona",
    },
    {
      rule: "with nothing attached and none relevant, scholarly search runs unasked",
      marker: "search outside without asking",
      owner: "persona",
    },
    {
      rule: "a review is never written from outside abstracts",
      marker: "outside abstracts",
      owner: "skill:literature-review.md",
    },
    {
      rule: "the Claude Code bridge searches the web with its own tools",
      marker: "Claude Code's WebSearch and WebFetch",
      owner: "runtime:claudeBridge",
    },
    {
      rule: "Codex web search follows the user's Codex configuration",
      marker: "when it is in your tool list",
      owner: "runtime:codex",
    },
    {
      rule: "native web search queries default to the user's language",
      marker: "web search queries in the user's language",
      owner: ["runtime:claudeBridge", "runtime:codex"],
    },
    {
      rule: "figure crops come only from paper_read figures mode",
      marker: "figure_crops",
      owner: "skill:analyze-figures.md",
    },
    {
      rule: "failed figure extraction falls back to text",
      marker: "MinerU source images, or placeholders",
      owner: "skill:analyze-figures.md",
    },
  ];

  const owners = collectOwnerTexts();

  it("collects the persona, every tool, every shipped skill, and the message builder", function () {
    assert.isAtLeast(
      Array.from(owners.keys()).filter((key) => key.startsWith("tool:")).length,
      27,
    );
    assert.isAtLeast(
      Array.from(owners.keys()).filter((key) => key.startsWith("skill:"))
        .length,
      7,
    );
    assert.isTrue(owners.has("persona"));
    assert.isTrue(owners.has("messageBuilder"));
    assert.isTrue(owners.has("turnContext:wholeLibrary"));
    assert.isTrue(owners.has("runtime:claudeBridge"));
    assert.isTrue(owners.has("runtime:codex"));
  });

  it("keeps no routing copy outside the search routing contract", function () {
    for (const marker of [
      "Use external search",
      "both source families",
      "for scholarly discovery",
      "A mixed request may also use",
      "only when the user asks to find, recommend",
      "current or general public evidence",
    ])
      assert.deepEqual(ownersOf(owners, marker), [], marker);
  });

  for (const { rule, marker, owner } of rules) {
    const expected = (Array.isArray(owner) ? [...owner] : [owner]).sort();
    it(`${rule} lives only in ${expected.join(" and ")}`, function () {
      assert.deepEqual(ownersOf(owners, marker), expected, marker);
    });
  }
});
