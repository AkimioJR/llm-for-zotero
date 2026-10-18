import type {
  PastConversationCatalogEntry,
  PastConversationSource,
} from "../../src/services/pastConversations/pastConversationLoader";
import type { ConversationSystem } from "../../src/shared/types";

export type FakePastChat = {
  system?: ConversationSystem;
  conversationKey: number;
  entry: Partial<PastConversationCatalogEntry> | null;
  messages: Array<Record<string, unknown>>;
};

/** An in-memory conversation store for past-chat tests. */
export function createFakePastConversationSource(
  chats: FakePastChat[],
  options: {
    pendingDeletion?: number[];
    paperTitles?: Record<number, string>;
    failLoads?: boolean;
  } = {},
): PastConversationSource & { loads: string[] } {
  const find = (system: ConversationSystem, conversationKey: number) =>
    chats.find(
      (chat) =>
        (chat.system || "upstream") === system &&
        chat.conversationKey === conversationKey,
    );
  const loads: string[] = [];
  return {
    loads,
    async getCatalogEntry(target) {
      if (options.failLoads) throw new Error("database unavailable");
      const chat = find(target.system, target.conversationKey);
      if (!chat?.entry) return null;
      return {
        conversationID: `conv-${target.conversationKey}`,
        libraryID: 1,
        kind: "global",
        lastActivityAt: Date.UTC(2026, 9, 1),
        createdAt: Date.UTC(2026, 8, 1),
        ...chat.entry,
      };
    },
    async loadMessages(target) {
      loads.push(`${target.system}:${target.conversationKey}`);
      return find(target.system, target.conversationKey)?.messages || [];
    },
    isPendingDeletion(conversationKey) {
      return (options.pendingDeletion || []).includes(conversationKey);
    },
    resolvePaperTitle(paperItemID) {
      return options.paperTitles?.[paperItemID];
    },
  };
}

/** Alternating user / assistant rows, oldest first. */
export function pastChatRows(
  count: number,
  textFor: (n: number) => string = (n) => `text ${n}`,
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: textFor(index + 1),
    timestamp: 1_000 + index,
  }));
}
