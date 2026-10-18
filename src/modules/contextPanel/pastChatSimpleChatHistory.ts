/**
 * Puts attached past chats into the history simple chat sends.
 *
 * Simple chat keeps no transcript: its history is rebuilt from the chat
 * messages every turn. So every turn, the history gets one past-chat user
 * message (never a system message) right before each user message that
 * attached chats, and the current turn's chats go last, right before the
 * prompt. Simple chat has no tools, so each chat is cut to its newest part
 * (trimmed mode) within min(24,000 characters, about 15% of the model's
 * context window), shared by the chats of one message. All attaching
 * messages together get twice that; older ones that do not fit become one
 * short line each.
 *
 * The text is memoized per conversation and user message, so a later turn
 * sends the same bytes at the same place and the provider's prompt cache
 * keeps working.
 *
 * Only the plain upstream chat gets these: Codex, Claude Code (later steps)
 * and WebChat (blocked) receive nothing here.
 */
import {
  buildPastChatMessageText,
  buildPastChatMessageTextMemoized,
  insertPastChatMessagesBeforeAttachingTurns,
  type PastConversationSource,
} from "../../services/pastConversations/pastConversationLoader";
import { resolvePastChatSimpleChatBudgetChars } from "../../services/pastConversations/pastConversationText";
import type {
  AdvancedModelParams,
  AttachedConversationRef,
} from "../../shared/types";
import type { ChatMessage } from "../../utils/llmClient";
import { resolveModelInputTokenLimit } from "../../utils/modelInputCap";
import { detectProviderPreset } from "../../utils/providerPresets";
import type { EffectiveRequestConfig } from "./requestContext";

export type SimpleChatPastChatSourceMessage = {
  role?: unknown;
  timestamp?: number;
  attachedConversations?: AttachedConversationRef[];
};

/** Memo key of simple chat's past-chat message for one user message. */
export function simpleChatPastChatMemoKey(
  conversationKey: number,
  userMessageTimestamp: number,
): string {
  return `chat:${conversationKey}:${userMessageTimestamp}`;
}

function attachesPastChats(
  message: SimpleChatPastChatSourceMessage | undefined,
): boolean {
  return Boolean(
    message?.role === "user" && message.attachedConversations?.length,
  );
}

function resolveBudgetChars(config: SimpleChatPastChatConfig): number {
  try {
    return resolvePastChatSimpleChatBudgetChars(
      resolveModelInputTokenLimit(
        config.model || "",
        config.advanced?.inputTokenCap,
        {
          provider: detectProviderPreset(config.apiBase || "").toString(),
          apiBase: config.apiBase,
          protocol: config.providerProtocol,
          authMode: config.authMode,
          profileOverride: config.advanced?.profileOverride,
        },
      ).limitTokens,
    );
  } catch {
    return resolvePastChatSimpleChatBudgetChars(undefined);
  }
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The one line that stands in for an attaching message's chats once they no
 * longer fit. It depends only on the message's own chat titles, so its bytes
 * stay the same from turn to turn.
 */
function formatLeftOutLine(
  message: SimpleChatPastChatSourceMessage | undefined,
): string {
  const titles = (message?.attachedConversations || [])
    .map((ref) => singleLine(ref.title || ""))
    .filter(Boolean)
    .join(", ");
  return `Past chats attached earlier in this conversation (${titles}) were left out to save space.`;
}

/**
 * Caps the past-chat text of the whole conversation at `maxChars`. Walks the
 * attaching messages newest first and keeps whole messages while they fit;
 * the first one that does not fit, and every older one, becomes a short
 * stable line. A kept message is never cut again, and the current turn's
 * message is always kept, so the bytes of a kept message do not change.
 */
function applyConversationBudget(
  texts: ReadonlyArray<string | null>,
  sources: ReadonlyArray<SimpleChatPastChatSourceMessage>,
  maxChars: number,
  lastIsCurrent: boolean,
): Array<string | null> {
  const out: Array<string | null> = new Array(texts.length).fill(null);
  let used = 0;
  let omitting = false;
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = texts[index];
    if (!text) continue;
    const isCurrent = lastIsCurrent && index === texts.length - 1;
    if (isCurrent || (!omitting && used + text.length <= maxChars)) {
      used += text.length;
      out[index] = text;
      continue;
    }
    omitting = true;
    out[index] = formatLeftOutLine(sources[index]);
  }
  return out;
}

type SimpleChatPastChatConfig = Pick<
  EffectiveRequestConfig,
  "model" | "apiBase" | "providerProtocol" | "authMode"
> & {
  advanced?: Pick<AdvancedModelParams, "inputTokenCap" | "profileOverride">;
};

/**
 * The history to send, with past-chat messages added; `history` itself when
 * nothing is attached or the turn is not a plain upstream chat. Never
 * throws: a past chat that cannot be rendered leaves the history as it was.
 */
export async function addAttachedPastChatsToSimpleChatHistory(params: {
  conversationKey: number;
  /** The turn's conversation system; only "upstream" gets past chats. */
  conversationSystem: string;
  libraryID: number | undefined;
  /** The chat messages `rawHistory` was built from, one to one. */
  messages: readonly SimpleChatPastChatSourceMessage[];
  /** The model messages built from `messages`. */
  rawHistory: ChatMessage[];
  /**
   * The history the request sends: `rawHistory`, or its compressed form (a
   * summary, then the newest messages of `rawHistory` as the same objects).
   * Defaults to `rawHistory`.
   */
  history?: ChatMessage[];
  /** The user message whose question is the request's prompt. */
  currentMessage?: SimpleChatPastChatSourceMessage;
  effectiveRequestConfig: SimpleChatPastChatConfig;
  source?: PastConversationSource;
}): Promise<ChatMessage[]> {
  const history = params.history || params.rawHistory;
  const config = params.effectiveRequestConfig;
  if (params.conversationSystem !== "upstream") return history;
  if (config.authMode === "webchat" || config.providerProtocol === "web_sync")
    return history;
  const mapsOneToOne = params.messages.length === params.rawHistory.length;
  const historySources = mapsOneToOne ? params.messages : [];
  if (
    !historySources.some(attachesPastChats) &&
    !attachesPastChats(params.currentMessage)
  ) {
    return history;
  }
  const totalMaxChars = resolveBudgetChars(config);
  const render = async (
    message: SimpleChatPastChatSourceMessage,
  ): Promise<string | null> => {
    if (!attachesPastChats(message)) return null;
    const renderParams = {
      refs: message.attachedConversations,
      libraryID: params.libraryID,
      mode: {
        kind: "trimmed" as const,
        totalMaxChars,
      },
      source: params.source,
    };
    const timestamp = Number(message.timestamp);
    return Number.isFinite(timestamp) && timestamp > 0
      ? buildPastChatMessageTextMemoized(
          simpleChatPastChatMemoKey(params.conversationKey, timestamp),
          renderParams,
        )
      : buildPastChatMessageText(renderParams);
  };
  try {
    const sources = params.currentMessage
      ? [...historySources, params.currentMessage]
      : [...historySources];
    const rendered = await Promise.all(sources.map(render));
    // The budget runs first. A copy is then dropped only when an older KEPT
    // copy has the same text, so earlier history keeps its bytes and a chat
    // attached again after its first copy was left out still reaches the model.
    const budgeted = applyConversationBudget(
      rendered,
      sources,
      totalMaxChars * 2,
      Boolean(params.currentMessage),
    );
    const keptFull = new Set<string>();
    const texts = budgeted.map((text, index) => {
      if (!text) return null;
      if (text !== rendered[index]) return text;
      if (keptFull.has(text)) return null;
      keptFull.add(text);
      return text;
    });
    const toMessage = (text: string | null): ChatMessage | null =>
      text ? { role: "user", content: text } : null;

    // The newest messages of a compressed history are the same objects as
    // the end of rawHistory; the rest was summarized.
    let kept = 0;
    while (
      kept < history.length &&
      kept < params.rawHistory.length &&
      history[history.length - 1 - kept] ===
        params.rawHistory[params.rawHistory.length - 1 - kept]
    ) {
      kept += 1;
    }
    const summarizedCount = mapsOneToOne ? params.rawHistory.length - kept : 0;
    const out: ChatMessage[] = history.slice(0, history.length - kept);
    // A summarized turn's past chat stays, right after the summary: the
    // summary keeps only the questions, and simple chat cannot reopen it.
    for (let index = 0; index < summarizedCount; index += 1) {
      const message = toMessage(texts[index]);
      if (message) out.push(message);
    }
    out.push(
      ...(mapsOneToOne
        ? await insertPastChatMessagesBeforeAttachingTurns<ChatMessage>(
            historySources.slice(summarizedCount),
            history.slice(history.length - kept),
            async (_message, index) =>
              toMessage(texts[summarizedCount + index]),
          )
        : history.slice(history.length - kept)),
    );
    if (params.currentMessage) {
      const current = toMessage(texts[texts.length - 1]);
      if (current) out.push(current);
    }
    return out;
  } catch {
    // A past chat that cannot be loaded never blocks the turn.
    return history;
  }
}
