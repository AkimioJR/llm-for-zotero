/**
 * Puts attached past chats back into the history handed to the built-in
 * agent.
 *
 * On the turn a user message attaches past chats, the agent runtime renders
 * them once into the transcript, right before that turn's request. When the
 * transcript is rebuilt from chat history (first turn after an edit, a retry,
 * a fork, or a temporary side chat), that message would be lost. So the
 * history gets one past-chat user message before each user message that
 * attached chats, and the rebuilt transcript keeps it at the same place.
 *
 * Only the built-in agent ("upstream" conversations) receives these: Claude
 * Code and Codex read past chats in later steps.
 */
import { LocalDocumentPathStreamRedactor } from "../../../agent/privacy/localDocumentPathRedaction";
import { resolveAgentPromptBudgetLimits } from "../../../agent/context/promptBudget";
import {
  agentPastChatMemoKey,
  buildPastChatMessageText,
  buildPastChatMessageTextMemoized,
  insertPastChatMessagesBeforeAttachingTurns,
  type PastConversationSource,
} from "../../../services/pastConversations/pastConversationLoader";
import { resolvePastChatFullTextBudget } from "../../../services/pastConversations/pastConversationText";
import type { AttachedConversationRef } from "../../../shared/types";
import type { ChatMessage } from "../../../utils/llmClient";
import type { EffectiveRequestConfig } from "../requestContext";

type HistorySourceMessage = {
  role?: unknown;
  timestamp?: number;
  attachedConversations?: AttachedConversationRef[];
};

export async function injectAttachedPastChatsIntoAgentHistory(params: {
  conversationKey: number;
  /** The turn's conversation system; only "upstream" gets past chats. */
  conversationSystem: string;
  libraryID: number | undefined;
  /** The chat messages `history` was built from, one to one. */
  messages: readonly HistorySourceMessage[];
  history: ChatMessage[];
  effectiveRequestConfig: Pick<
    EffectiveRequestConfig,
    "model" | "apiBase" | "providerProtocol" | "authMode" | "advanced"
  >;
  source?: PastConversationSource;
}): Promise<ChatMessage[]> {
  if (params.conversationSystem !== "upstream") return params.history;
  if (
    !params.messages.some(
      (message) =>
        message.role === "user" && message.attachedConversations?.length,
    )
  ) {
    return params.history;
  }
  const config = params.effectiveRequestConfig;
  let fullTextBudgetTokens: number;
  try {
    fullTextBudgetTokens = resolvePastChatFullTextBudget(
      resolveAgentPromptBudgetLimits({
        model: config.model,
        inputTokenCap: config.advanced?.inputTokenCap,
        apiBase: config.apiBase,
        providerProtocol: config.providerProtocol,
        authMode: config.authMode,
        profileOverride: config.advanced?.profileOverride,
        outputTokenLimit: config.advanced?.outputTokenLimit,
      }).contextWindow,
    );
  } catch {
    fullTextBudgetTokens = resolvePastChatFullTextBudget(undefined);
  }
  // The attach turn stores the redacted text; a rebuild applies the same
  // redaction so both hold the same bytes.
  const redactor = new LocalDocumentPathStreamRedactor(params.conversationKey);
  try {
    return await insertPastChatMessagesBeforeAttachingTurns<ChatMessage>(
      params.messages,
      params.history,
      async (message) => {
        const typed = message as HistorySourceMessage;
        const renderParams = {
          refs: typed.attachedConversations,
          libraryID: params.libraryID,
          mode: { kind: "agent" as const, fullTextBudgetTokens },
          source: params.source,
        };
        const timestamp = Number(typed.timestamp);
        const text = Number.isFinite(timestamp)
          ? await buildPastChatMessageTextMemoized(
              agentPastChatMemoKey(params.conversationKey, timestamp),
              renderParams,
            )
          : await buildPastChatMessageText(renderParams);
        return text
          ? { role: "user", content: redactor.redactTerminalText(text) }
          : null;
      },
    );
  } catch {
    // A past chat that cannot be loaded never blocks the turn.
    return params.history;
  }
}
