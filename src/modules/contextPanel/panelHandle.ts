/**
 * The typed surface a mounted panel publishes for code outside its setup
 * closure. setupHandlers publishes one handle per setup and unpublishes it at
 * cleanup; readers look it up by panel body.
 */
export type PanelHandle = {
  /** Re-derive the auto-loaded context source for the panel's current item. */
  refreshContextSourceForCurrentItem(): void;
  /**
   * Add Zotero items as default context to the panel's current conversation
   * (no new conversation), the way Zotero's "Add as context" action does.
   */
  addItemsAsDefaultContext(items: Zotero.Item[]): Promise<void> | void;
  /**
   * Add text as a removable selected-text chip, sent with the panel's next
   * message. Returns whether a chip was added (false for empty text, a
   * duplicate, a full chip list, or a panel with no conversation).
   * `question` is set as the chip's question, also on a duplicate chip.
   */
  addTextContext(
    text: string,
    opts: {
      source: "model" | "sidechat";
      focusInput?: boolean;
      question?: string;
    },
  ): boolean;
  /** Show the reasoning effort that the Claude runtime resolved. */
  applyResolvedClaudeEffort(effort: unknown): void;
  /**
   * Move a mounted paper chat to another paper's chat in place, after Zotero
   * rebound the panel host to that paper. Returns false, changing nothing,
   * when the panel is in a state only a full remount handles; the caller then
   * rebuilds. On true the panel draws the new conversation itself, once;
   * when it cannot, it calls `rebuild` for the host's full remount.
   */
  switchToPaperItem(
    nextItem: Zotero.Item,
    nextBasePaperItem: Zotero.Item | null,
    rebuild: () => void,
  ): boolean;
};

const panelHandles = new WeakMap<Element, PanelHandle>();

export function publishPanelHandle(body: Element, handle: PanelHandle): void {
  panelHandles.set(body, handle);
}

export function getPanelHandle(body: Element): PanelHandle | undefined {
  return panelHandles.get(body);
}

/**
 * Removes the handle only if it is still the one this publisher set, so a
 * stale cleanup cannot remove the handle of a later setup on the same body.
 */
export function unpublishPanelHandle(body: Element, handle: PanelHandle): void {
  if (panelHandles.get(body) === handle) {
    panelHandles.delete(body);
  }
}
