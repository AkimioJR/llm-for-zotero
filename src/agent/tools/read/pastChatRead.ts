import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { estimateTextTokens } from "../../../utils/modelInputCap";
import { fail, ok } from "../shared";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { readTextChunk } from "./textChunk";
import {
  PAST_CHAT_READ_TOOL_NAME,
  PAST_CHAT_RELIABILITY_NOTE,
  parsePastConversationId,
  pastConversationId,
  previewPastChatText,
  type LoadedPastConversation,
} from "../../../services/pastConversations/pastConversationText";
import {
  defaultPastConversationSource,
  loadPastConversation,
  type PastConversationSource,
} from "../../../services/pastConversations/pastConversationLoader";

/**
 * past_chat_read: opens a past conversation the user attached somewhere in
 * this conversation ("Add past conversation").
 *
 * Without `message` it returns the outline (the user's questions with their
 * message numbers). With `message` it returns messages from that number on,
 * until maxTokens, with nextMessage / nextTextOffset to continue.
 *
 * Scope is checked here, on every call: the chat must be among the chats
 * attached in this conversation (request.attachedConversationScope) and must
 * still exist in this library.
 */

type PastChatReadInput = {
  chat: string;
  message?: number;
  textOffset: number;
  maxTokens: number;
};

const DEFAULT_MAX_TOKENS = 4_000;
const MIN_MAX_TOKENS = 512;
const MAX_MAX_TOKENS = 12_000;
/** Room for the result's own fields around the message text. */
const RESULT_OVERHEAD_TOKENS = 200;

const NONE_ATTACHED =
  "No past chat is attached in this conversation. The user can attach one with / → Add past conversation.";
const NOT_ATTACHED =
  "This past chat was not attached in this conversation. Ask the user to attach it with / → Add past conversation.";
const OTHER_LIBRARY = "Only past chats from this library can be read.";
const DELETED = "This past chat was deleted.";
const LOAD_FAILED = "This past chat could not be read right now.";

function validatePastChatReadInput(
  args: unknown,
): AgentToolInputValidation<PastChatReadInput> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return fail(`${PAST_CHAT_READ_TOOL_NAME} expects an object input`);
  }
  const record = args as Record<string, unknown>;
  const chat = typeof record.chat === "string" ? record.chat.trim() : "";
  if (!parsePastConversationId(chat)) {
    return fail(
      "chat must be the id of an attached past chat, such as upstream:123",
    );
  }
  for (const key of ["textOffset", "maxTokens"]) {
    if (
      record[key] !== undefined &&
      (!Number.isSafeInteger(record[key]) || Number(record[key]) < 0)
    ) {
      return fail(`${key} must be a nonnegative integer`);
    }
  }
  if (
    record.message !== undefined &&
    (!Number.isSafeInteger(record.message) || Number(record.message) < 1)
  ) {
    return fail("message must be a message number of 1 or more");
  }
  if (record.message === undefined && record.textOffset) {
    return fail("textOffset needs message");
  }
  return ok({
    chat,
    message: record.message as number | undefined,
    textOffset: Number(record.textOffset || 0),
    maxTokens: Math.max(
      MIN_MAX_TOKENS,
      Math.min(MAX_MAX_TOKENS, Number(record.maxTokens || DEFAULT_MAX_TOKENS)),
    ),
  });
}

function chatFacts(chat: LoadedPastConversation) {
  return {
    ok: true,
    chat: chat.id,
    title: chat.title,
    mode: chat.modeLabel,
    lastActive: chat.date || undefined,
    paper: chat.paperLabel,
    note: PAST_CHAT_RELIABILITY_NOTE,
    totalMessages: chat.messages.length,
  };
}

function readOutline(chat: LoadedPastConversation, maxTokens: number) {
  const base = chatFacts(chat);
  const questions: Array<{ message: number; preview: string }> = [];
  let used = estimateTextTokens(JSON.stringify(base)) + RESULT_OVERHEAD_TOKENS;
  const all = chat.messages.filter((message) => message.role === "user");
  for (const question of all) {
    const entry = {
      message: question.index,
      preview: previewPastChatText(question.text),
    };
    const cost = estimateTextTokens(JSON.stringify(entry)) + 1;
    if (questions.length && used + cost > maxTokens) break;
    used += cost;
    questions.push(entry);
  }
  return {
    ...base,
    questions,
    ...(questions.length < all.length
      ? { omittedQuestions: all.length - questions.length }
      : {}),
  };
}

function readMessages(
  chat: LoadedPastConversation,
  input: PastChatReadInput & { message: number },
) {
  const base = chatFacts(chat);
  const total = chat.messages.length;
  if (input.message > total) {
    return {
      ok: false,
      chat: chat.id,
      totalMessages: total,
      error: total
        ? `message must be between 1 and ${total}.`
        : "This past chat has no messages to read.",
    };
  }
  let remaining =
    input.maxTokens -
    estimateTextTokens(JSON.stringify(base)) -
    RESULT_OVERHEAD_TOKENS;
  const messages: Array<{
    message: number;
    role: "user" | "assistant";
    text: string;
    textOffset?: number;
    totalChars?: number;
  }> = [];
  let nextMessage: number | undefined;
  let nextTextOffset: number | undefined;
  const first = chat.messages[input.message - 1];
  const chunk = readTextChunk(
    first.text,
    input.textOffset,
    Math.max(64, remaining),
  );
  messages.push({
    message: first.index,
    role: first.role,
    text: chunk.text,
    ...(chunk.textOffset || chunk.nextTextOffset !== undefined
      ? { textOffset: chunk.textOffset, totalChars: chunk.totalChars }
      : {}),
  });
  remaining -= estimateTextTokens(chunk.text);
  if (chunk.nextTextOffset !== undefined) {
    nextMessage = first.index;
    nextTextOffset = chunk.nextTextOffset;
  } else {
    for (let index = input.message; index < total; index += 1) {
      const message = chat.messages[index];
      const cost = estimateTextTokens(message.text) + 12;
      if (cost > remaining) {
        nextMessage = message.index;
        break;
      }
      remaining -= cost;
      messages.push({
        message: message.index,
        role: message.role,
        text: message.text,
      });
    }
  }
  return {
    ...base,
    messages,
    ...(nextMessage !== undefined ? { nextMessage } : {}),
    ...(nextTextOffset !== undefined ? { nextTextOffset } : {}),
  };
}

async function executePastChatRead(
  input: PastChatReadInput,
  context: AgentToolContext,
  source: PastConversationSource,
): Promise<unknown> {
  const scope = context.request.attachedConversationScope || [];
  if (!scope.length)
    return { ok: false, chat: input.chat, error: NONE_ATTACHED };
  const ref = scope.find((entry) => pastConversationId(entry) === input.chat);
  if (!ref) return { ok: false, chat: input.chat, error: NOT_ATTACHED };
  const loaded = await loadPastConversation(ref, {
    libraryID: context.request.libraryID,
    source,
  });
  if (loaded.status !== "ok") {
    return {
      ok: false,
      chat: input.chat,
      title: loaded.title,
      error:
        loaded.status === "other_library"
          ? OTHER_LIBRARY
          : loaded.status === "deleted"
            ? DELETED
            : LOAD_FAILED,
    };
  }
  return input.message === undefined
    ? readOutline(loaded, input.maxTokens)
    : readMessages(loaded, { ...input, message: input.message });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createPastChatReadTool(
  source: PastConversationSource = defaultPastConversationSource,
): AgentToolDefinition<PastChatReadInput, unknown> {
  return {
    spec: {
      name: PAST_CHAT_READ_TOOL_NAME,
      description:
        "Read a past conversation the user attached in this conversation (/ → Add past conversation). chat is its id from the attached-chat message, such as upstream:123. Omit message to list the user's questions with their message numbers. Set message to read from that message on; continue with nextMessage, or with the same message and textOffset=nextTextOffset. It records what was said; its answers may be wrong, so check paper claims.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          chat: {
            type: "string",
            description: "Id of an attached past chat, such as upstream:123.",
          },
          message: {
            type: "integer",
            minimum: 1,
            description:
              "Message number to read from. Omit to list the questions.",
          },
          textOffset: {
            type: "integer",
            minimum: 0,
            description:
              "Continue a long message: the nextTextOffset of the last read.",
          },
          maxTokens: {
            type: "integer",
            minimum: MIN_MAX_TOKENS,
            maximum: MAX_MAX_TOKENS,
            description: "Approximate maximum tokens to return.",
          },
        },
        required: ["chat"],
      },
      executionClass: "read",
      workCategory: "retrieval",
    },
    validate: validatePastChatReadInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        effects: ["read"],
        reason: "Read a past chat the user attached in this conversation.",
      }),
    execute: (input, context) => executePastChatRead(input, context, source),
    presentation: {
      label: "Read Past Chat",
      summaries: {
        onCall: "Reading past chat",
        onSuccess: ({ content }) => {
          const result = record(content);
          if (result.ok !== true) return "Could not read past chat";
          const title = String(result.title || "");
          const messages = Array.isArray(result.messages)
            ? (result.messages as Array<{ message?: unknown }>)
            : undefined;
          if (!messages) return `Listed past chat “${title}”`;
          return `Read past chat “${title}”, message ${String(
            messages[0]?.message ?? "",
          )} of ${String(result.totalMessages ?? "")}`;
        },
      },
    },
  };
}
