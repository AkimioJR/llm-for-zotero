/**
 * Shared chrome for rich content in chat answers (the "flat" style): the
 * content sits directly in the answer, with one floating hover bar and an
 * optional caption line under it. Code blocks use the bar today; tables,
 * figures and previews use the same helpers later.
 */

export const CONTENT_BAR_CLASS = "llm-content-bar";
export const CONTENT_BAR_BUTTON_CLASS = "llm-content-bar-btn";
export const CONTENT_CAPTION_CLASS = "llm-content-caption";
/** Marks the root of rendered answer text that uses the flat style. */
export const CONTENT_FLAT_SCOPE_CLASS = "llm-content-flat";

export type ContentBarButtonSpec = {
  className: string;
  label: string;
  /** A CSS `url(...)` for the button's mask icon; classes may supply it instead. */
  icon?: string;
  onClick?: (event: Event) => void;
  pressed?: boolean;
};

export type ContentCaptionSpec = {
  /** Short kind label, such as "Table" or "Figure". */
  kind: string;
  text?: string;
  link?: { label: string; onClick: (event: Event) => void };
};

function findDirectChild(parent: Element, className: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.classList.contains(className)) return child;
  }
  return null;
}

/** True when `element` sits inside answer text that uses the flat style. */
export function isInFlatContentScope(element: Element): boolean {
  return Boolean(element.closest?.(`.${CONTENT_FLAT_SCOPE_CLASS}`));
}

/** The block's hover bar, created as a direct child on first use. */
export function ensureContentBar(block: Element, doc: Document): HTMLElement {
  const existing = findDirectChild(block, CONTENT_BAR_CLASS);
  if (existing) return existing as HTMLElement;
  const bar = doc.createElement("div") as HTMLElement;
  bar.className = CONTENT_BAR_CLASS;
  block.appendChild(bar);
  return bar;
}

/** Puts a button that already exists (and keeps its listeners) into the bar. */
export function adoptContentBarButton(
  bar: Element,
  button: HTMLElement,
): HTMLElement {
  button.classList.add(CONTENT_BAR_BUTTON_CLASS);
  bar.appendChild(button);
  return button;
}

/** Adds a new button at the end of the bar. */
export function appendContentBarButton(
  bar: Element,
  spec: ContentBarButtonSpec,
  doc: Document = bar.ownerDocument as Document,
): HTMLButtonElement {
  const button = doc.createElement("button") as HTMLButtonElement;
  button.type = "button";
  button.className = `${CONTENT_BAR_BUTTON_CLASS} ${spec.className}`;
  button.title = spec.label;
  button.setAttribute("aria-label", spec.label);
  if (spec.pressed !== undefined) {
    button.setAttribute("aria-pressed", spec.pressed ? "true" : "false");
  }
  if (spec.icon) button.style.setProperty("--llm-content-bar-icon", spec.icon);
  if (spec.onClick) {
    const onClick = spec.onClick;
    button.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(event);
    });
  }
  bar.appendChild(button);
  return button;
}

/**
 * The caption line under a block: kind label, optional text, optional accent
 * link. Replaces an earlier caption on the same block.
 */
export function appendContentCaption(
  block: Element,
  spec: ContentCaptionSpec,
  doc: Document = block.ownerDocument as Document,
): HTMLElement {
  const existing = findDirectChild(block, CONTENT_CAPTION_CLASS);
  if (existing) existing.remove();
  const caption = doc.createElement("div") as HTMLElement;
  caption.className = CONTENT_CAPTION_CLASS;
  const kind = doc.createElement("span") as HTMLElement;
  kind.className = "llm-content-caption-kind";
  kind.textContent = spec.kind;
  caption.appendChild(kind);
  if (spec.text) {
    const text = doc.createElement("span") as HTMLElement;
    text.className = "llm-content-caption-text";
    text.textContent = spec.text;
    caption.appendChild(text);
  }
  if (spec.link) {
    const link = doc.createElement("button") as HTMLButtonElement;
    link.type = "button";
    link.className = "llm-content-caption-link";
    link.textContent = spec.link.label;
    const onClick = spec.link.onClick;
    link.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(event);
    });
    caption.appendChild(link);
  }
  block.appendChild(caption);
  return caption;
}
