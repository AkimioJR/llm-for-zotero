import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { createPastChatReadTool } from "../src/agent/tools/read/pastChatRead";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { PAST_CHAT_RELIABILITY_NOTE } from "../src/services/pastConversations/pastConversationText";
import type {
  AgentRuntimeRequest,
  AgentToolContext,
  AgentToolDefinition,
} from "../src/agent/types";
import type { AttachedConversationRef } from "../src/shared/types";
import {
  createFakePastConversationSource,
  pastChatRows,
} from "./helpers/fakePastConversationSource";

function ref(
  conversationKey: number,
  overrides: Partial<AttachedConversationRef> = {},
): AttachedConversationRef {
  return {
    system: "upstream",
    conversationKey,
    conversationID: `conv-${conversationKey}`,
    title: `Chat ${conversationKey}`,
    libraryID: 1,
    ...overrides,
  };
}

describe("past_chat_read", function () {
  const source = createFakePastConversationSource([
    {
      conversationKey: 10,
      entry: { title: "Grid cells chat" },
      messages: pastChatRows(30, (n) =>
        n === 5 ? `long ${"q".repeat(30_000)} tail` : `message ${n} body`,
      ),
    },
    { conversationKey: 11, entry: null, messages: [] },
    { conversationKey: 12, entry: { libraryID: 2 }, messages: [] },
  ]);
  const tool = createPastChatReadTool(source) as AgentToolDefinition<
    unknown,
    unknown
  >;
  const context = (
    scope: AttachedConversationRef[] | undefined,
    libraryID = 1,
  ): AgentToolContext => ({
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "what did we say before?",
      libraryID,
      ...(scope ? { attachedConversationScope: scope } : {}),
    } as AgentRuntimeRequest,
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  });
  const run = async (args: unknown, toolContext: AgentToolContext) => {
    const input = tool.validate(args);
    if (!input.ok) throw new Error(input.error);
    return (await tool.execute(input.value, toolContext)) as Record<
      string,
      any
    >;
  };

  it("is always listed, even when nothing is attached", function () {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    const request = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "hello",
      libraryID: 1,
    });
    const spec = registry
      .listToolsForRequest(request)
      .find((entry) => entry.name === "past_chat_read");
    assert.exists(spec);
    assert.equal(
      registry.getTool("past_chat_read")?.spec.executionClass,
      "read",
    );
    assert.isAtMost(spec!.description.length, 300);
    assert.isAtMost(
      registry.getTool("past_chat_read")!.spec.description.length,
      1_200,
    );
    assert.notMatch(
      JSON.stringify(registry.getTool("past_chat_read")!.spec),
      /conversation_read|\bcontract|obligation|frozen workflow/i,
    );
  });

  it("validates the chat id and the paging fields", function () {
    assert.isFalse(tool.validate({}).ok);
    assert.isFalse(tool.validate({ chat: "Grid cells chat" }).ok);
    assert.isFalse(tool.validate({ chat: "upstream:10", message: 0 }).ok);
    assert.isFalse(tool.validate({ chat: "upstream:10", textOffset: 5 }).ok);
    assert.isFalse(tool.validate({ chat: "upstream:10", maxTokens: -1 }).ok);
    const input = tool.validate({ chat: "upstream:10", maxTokens: 99_999 });
    assert.isTrue(input.ok);
    if (input.ok) assert.equal((input.value as any).maxTokens, 12_000);
  });

  it("says how to attach a chat when none is attached", async function () {
    const result = await run({ chat: "upstream:10" }, context(undefined));
    assert.isFalse(result.ok);
    assert.equal(
      result.error,
      "No past chat is attached in this conversation. The user can attach one with / → Add past conversation.",
    );
    assert.deepEqual(source.loads, []);
  });

  it("refuses a chat that is not attached, even while others are", async function () {
    const result = await run(
      { chat: "upstream:99" },
      context([ref(10), ref(11)]),
    );
    assert.isFalse(result.ok);
    assert.equal(
      result.error,
      "This past chat was not attached in this conversation. Ask the user to attach it with / → Add past conversation.",
    );
  });

  it("refuses a chat from another library and a deleted chat", async function () {
    const otherLibrary = await run({ chat: "upstream:12" }, context([ref(12)]));
    assert.equal(
      otherLibrary.error,
      "Only past chats from this library can be read.",
    );
    const fromOtherRequestLibrary = await run(
      { chat: "upstream:10" },
      context([ref(10)], 2),
    );
    assert.equal(
      fromOtherRequestLibrary.error,
      "Only past chats from this library can be read.",
    );
    const deleted = await run({ chat: "upstream:11" }, context([ref(11)]));
    assert.equal(deleted.error, "This past chat was deleted.");
  });

  it("returns the outline without message", async function () {
    const result = await run({ chat: "upstream:10" }, context([ref(10)]));
    assert.isTrue(result.ok);
    assert.equal(result.title, "Grid cells chat");
    assert.equal(result.mode, "Chat");
    assert.equal(result.note, PAST_CHAT_RELIABILITY_NOTE);
    assert.equal(result.totalMessages, 30);
    assert.deepEqual(result.questions[0], {
      message: 1,
      preview: "message 1 body",
    });
    assert.lengthOf(result.questions, 15);
    assert.notProperty(result, "messages");
    assert.equal(tool.presentation?.summaries?.onCall, "Reading past chat");
    const onSuccess = tool.presentation?.summaries?.onSuccess as (input: {
      label: string;
      content: unknown;
    }) => string;
    assert.equal(
      onSuccess({ label: "Read Past Chat", content: result }),
      "Listed past chat “Grid cells chat”",
    );
  });

  it("reads from a message on and says where to continue", async function () {
    const result = await run(
      { chat: "upstream:10", message: 1, maxTokens: 512 },
      context([ref(10)]),
    );
    assert.isTrue(result.ok);
    assert.deepEqual(
      result.messages.map((message: any) => message.message),
      [1, 2, 3, 4],
    );
    assert.equal(result.messages[0].text, "message 1 body");
    assert.equal(result.messages[1].role, "assistant");
    assert.equal(
      result.nextMessage,
      5,
      "message 5 does not fit, so it is next",
    );
    assert.notProperty(result, "nextTextOffset");
    const onSuccess = tool.presentation?.summaries?.onSuccess as (input: {
      label: string;
      content: unknown;
    }) => string;
    assert.equal(
      onSuccess({ label: "Read Past Chat", content: result }),
      "Read past chat “Grid cells chat”, message 1 of 30",
    );
  });

  it("pages a long message with textOffset until it ends", async function () {
    const first = await run(
      { chat: "upstream:10", message: 5, maxTokens: 2_000 },
      context([ref(10)]),
    );
    assert.equal(first.messages.length, 1);
    assert.equal(first.nextMessage, 5);
    assert.isNumber(first.nextTextOffset);
    assert.isTrue(first.messages[0].text.startsWith("long "));
    let text = first.messages[0].text as string;
    let next: Record<string, any> = first;
    for (
      let guard = 0;
      next.nextTextOffset !== undefined && guard < 20;
      guard++
    ) {
      next = await run(
        {
          chat: "upstream:10",
          message: 5,
          textOffset: next.nextTextOffset,
          maxTokens: 12_000,
        },
        context([ref(10)]),
      );
      text += next.messages[0].text;
    }
    assert.isTrue(text.endsWith(" tail"));
    assert.equal(text.length, `long ${"q".repeat(30_000)} tail`.length);
    assert.equal(next.messages[1]?.message, 6, "the next message follows");
  });

  it("refuses a message number past the end", async function () {
    const result = await run(
      { chat: "upstream:10", message: 31 },
      context([ref(10)]),
    );
    assert.isFalse(result.ok);
    assert.equal(result.error, "message must be between 1 and 30.");
  });
});
