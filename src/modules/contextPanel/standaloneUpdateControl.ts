import { HTML_NS } from "../../utils/domHelpers";
import { isChineseLocale } from "../../utils/i18n";
import type {
  PluginUpdateController,
  PluginUpdateState,
} from "../pluginUpdate";
import { renderRenderedMarkdownInto } from "./renderedMarkdown";
import { openStandaloneViewerWindow } from "./standaloneMermaidWindow";

const SVG_NS = "http://www.w3.org/2000/svg";

type PopoverKind = "notes" | "confirm";

export type StandaloneUpdateControl = {
  button: HTMLButtonElement;
  dispose: () => void;
};

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function downloadIcon(doc: Document): SVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M8 2.5v7.5M4.8 7.2 8 10.4l3.2-3.2M3 13h10");
  svg.append(path);
  return svg;
}

function strokeIcon(doc: Document, d: string): SVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

const EXTERNAL_ICON_PATH = "M6 3H3.5v9.5H13V10M9 3h4v4M13 3 7.5 8.5";
const CLOSE_ICON_PATH = "M4 4l8 8M12 4l-8 8";

/**
 * The headings the section chips jump to: the top heading level that appears
 * at least twice, so a release with one title and many `##` sections gets
 * chips for the sections. Fewer than two headings means no chips.
 */
function sectionHeadings(root: HTMLElement): HTMLElement[] {
  for (const level of ["h1", "h2", "h3"]) {
    const found = Array.from(root.querySelectorAll(level)) as HTMLElement[];
    if (found.length >= 2) return found;
  }
  return [];
}

function fill(template: string, version: string): string {
  return template.replace("{version}", version);
}

function formatDate(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  try {
    return new Date(time).toLocaleDateString(
      isChineseLocale() ? "zh-CN" : "en-US",
      { year: "numeric", month: "short", day: "numeric" },
    );
  } catch {
    return "";
  }
}

/**
 * The update button at the right end of the sidebar footer row, and the
 * release notes panel and confirm popover it opens. State decisions live in
 * the controller; this file only draws and routes clicks.
 */
export function createStandaloneUpdateControl(args: {
  doc: Document;
  win: Window;
  slot: HTMLElement;
  anchorRow: HTMLElement;
  controller: PluginUpdateController;
  translate: (value: string) => string;
  openUrl: (url: string) => void;
}): StandaloneUpdateControl {
  const { doc, win, slot, anchorRow, controller, translate, openUrl } = args;
  const button = el(doc, "button", "llm-standalone-update-btn");
  button.type = "button";
  button.id = "llm-standalone-update-btn";
  slot.append(button);

  let popover: HTMLDivElement | null = null;
  let popoverKind: PopoverKind | null = null;
  let renderedKey = "";
  let notesToken = 0;

  const closePopover = () => {
    notesToken++;
    const hadNotes = popoverKind === "notes";
    popover?.remove();
    popover = null;
    popoverKind = null;
    button.setAttribute("aria-expanded", "false");
    if (hadNotes && button.isConnected) button.focus();
  };

  const render = (state: PluginUpdateState) => {
    const next = state.nextVersion || "";
    const key = `${state.kind}|${state.runningVersion}|${next}|${state.installFailed}`;
    if (key === renderedKey) return;
    renderedKey = key;
    button.dataset.state = state.kind;
    button.replaceChildren();
    button.disabled = state.kind === "updating";
    let title: string;
    if (state.kind === "available") {
      button.append(downloadIcon(doc));
      title = state.installFailed
        ? translate("Update failed. Try again.")
        : fill(translate("Update to v{version}"), next);
    } else if (state.kind === "updating") {
      button.append(el(doc, "span", "llm-standalone-update-spinner"));
      title = fill(translate("Updating to v{version}…"), next);
    } else if (state.kind === "updated") {
      button.append(
        el(doc, "span", "llm-standalone-update-dot"),
        el(
          doc,
          "span",
          "llm-standalone-update-long",
          fill(translate("Updated to v{version}"), state.runningVersion),
        ),
        el(
          doc,
          "span",
          "llm-standalone-update-short",
          `v${state.runningVersion}`,
        ),
      );
      title = fill(
        translate("See what's new in v{version}"),
        state.runningVersion,
      );
    } else {
      button.append(
        el(
          doc,
          "span",
          "llm-standalone-update-version",
          `v${state.runningVersion}`,
        ),
      );
      title = fill(translate("What's new in v{version}"), state.runningVersion);
    }
    button.title = title;
    button.setAttribute("aria-label", title);
    // A popover for a state that no longer exists would mislead.
    if (
      (popoverKind === "confirm" && state.kind !== "available") ||
      (popoverKind === "notes" && state.kind === "updating")
    ) {
      closePopover();
    }
  };

  const openPopover = (kind: PopoverKind): HTMLDivElement => {
    closePopover();
    const card = el(
      doc,
      "div",
      `llm-standalone-update-popover llm-standalone-update-${kind}`,
    );
    card.setAttribute("role", "dialog");
    const rect = anchorRow.getBoundingClientRect();
    const viewportWidth = win.innerWidth || 600;
    const viewportHeight = win.innerHeight || 600;
    card.style.left = `${Math.max(8, Math.round(rect.left))}px`;
    card.style.bottom = `${Math.max(8, Math.round(viewportHeight - rect.top + 6))}px`;
    card.style.width = `${Math.min(300, viewportWidth - 48)}px`;
    // The font-scale variables live on the standalone root, not the window.
    (
      doc.getElementById("llmforzotero-standalone-chat-root") ||
      doc.documentElement
    )?.append(card);
    popover = card;
    popoverKind = kind;
    button.setAttribute("aria-expanded", "true");
    return card;
  };

  /**
   * The release notes, as a large panel over the whole window with the chat
   * dimmed behind it. Esc, the close button, or a click on the dimmed area
   * closes it.
   */
  const openNotes = (version: string) => {
    closePopover();
    const scrim = el(doc, "div", "llm-standalone-release-notes");
    const panel = el(doc, "div", "llm-standalone-release-notes-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    scrim.append(panel);

    const header = el(doc, "div", "llm-standalone-release-notes-header");
    const titleText = fill(translate("What's new in v{version}"), version);
    const title = el(
      doc,
      "div",
      "llm-standalone-release-notes-title",
      titleText,
    );
    panel.setAttribute("aria-label", titleText);
    const date = el(doc, "div", "llm-standalone-release-notes-date");
    const tools = el(doc, "div", "llm-standalone-release-notes-tools");
    const iconButton = (label: string, iconPath: string) => {
      const iconBtn = el(doc, "button", "llm-standalone-release-notes-btn");
      iconBtn.type = "button";
      iconBtn.setAttribute("aria-label", label);
      iconBtn.append(strokeIcon(doc, iconPath));
      return iconBtn;
    };
    const githubButton = iconButton(
      translate("Open on GitHub"),
      EXTERNAL_ICON_PATH,
    );
    githubButton.dataset.releaseNotesAction = "github";
    const closeButton = iconButton(translate("Close (Esc)"), CLOSE_ICON_PATH);
    closeButton.dataset.releaseNotesAction = "close";
    tools.append(githubButton, closeButton);
    header.append(title, date, tools);

    const scroller = el(doc, "div", "llm-standalone-release-notes-scroll");
    const article = el(doc, "div", "llm-standalone-release-notes-article");
    article.append(
      el(doc, "div", "llm-standalone-update-muted", translate("Loading…")),
    );
    const footer = el(doc, "div", "llm-standalone-release-notes-footer");
    const source = el(
      doc,
      "span",
      "llm-standalone-update-muted",
      translate("From GitHub releases"),
    );
    const link = el(
      doc,
      "button",
      "llm-standalone-update-link",
      `${translate("Open on GitHub")} ↗`,
    );
    link.type = "button";
    footer.append(source, link);
    scroller.append(article);
    panel.append(header, scroller);

    let linkUrl = "";
    const openGithub = () => {
      if (/^https?:\/\//i.test(linkUrl)) openUrl(linkUrl);
    };
    githubButton.addEventListener("click", openGithub);
    link.addEventListener("click", openGithub);
    closeButton.addEventListener("click", closePopover);
    scrim.addEventListener("mousedown", (event: Event) => {
      if (event.target === scrim) closePopover();
    });
    article.addEventListener("click", (event: Event) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href]");
      if (anchor) {
        event.preventDefault();
        const href = anchor.getAttribute("href") || "";
        if (/^https?:\/\//i.test(href)) openUrl(href);
        return;
      }
      const img = target?.closest?.("img") as HTMLImageElement | null;
      if (img?.src) {
        const alt = img.getAttribute("alt") || "";
        openStandaloneViewerWindow(doc, {
          kind: "image",
          src: img.src,
          alt,
          caption: alt,
        });
      }
    });

    // The font-scale variables live on the standalone root, not the window.
    (
      doc.getElementById("llmforzotero-standalone-chat-root") ||
      doc.documentElement
    )?.append(scrim);
    popover = scrim;
    popoverKind = "notes";
    button.setAttribute("aria-expanded", "true");
    closeButton.focus();

    const token = notesToken;
    void controller.loadNotes(version).then((result) => {
      if (token !== notesToken || popover !== scrim) return;
      article.replaceChildren();
      if (result.status === "ready") {
        linkUrl = result.notes.htmlUrl;
        date.textContent = formatDate(result.notes.publishedAt);
        const rendered = el(doc, "div", "llm-standalone-update-notes");
        renderRenderedMarkdownInto(rendered, result.notes.body, doc, {
          deferEnrichment: true,
        });
        const headings = sectionHeadings(rendered);
        if (headings.length) {
          const chips = el(doc, "nav", "llm-standalone-release-notes-chips");
          for (const heading of headings) {
            const chip = el(
              doc,
              "button",
              "llm-standalone-release-notes-chip",
              heading.textContent?.trim() || "",
            );
            chip.type = "button";
            chip.addEventListener("click", () => {
              scroller.scrollTo({
                top: Math.max(0, heading.offsetTop - chips.offsetHeight - 8),
                behavior: "smooth",
              });
            });
            chips.append(chip);
          }
          article.append(chips);
        }
        article.append(rendered, footer);
      } else {
        linkUrl = result.htmlUrl;
        article.append(
          el(
            doc,
            "div",
            "llm-standalone-update-muted",
            translate(
              "Could not load the release notes. Check your connection, or open them on GitHub.",
            ),
          ),
          footer,
        );
      }
      if (!linkUrl) {
        link.disabled = true;
        githubButton.disabled = true;
      }
    });
  };

  const openConfirm = (state: PluginUpdateState) => {
    const card = openPopover("confirm");
    card.append(
      el(
        doc,
        "div",
        "llm-standalone-update-card-title",
        fill(translate("Update to v{version}?"), state.nextVersion || ""),
      ),
      el(
        doc,
        "div",
        "llm-standalone-update-text",
        translate(
          "The plugin reloads. This window closes and opens again on the same chat.",
        ),
      ),
    );
    if (controller.isReplyInFlight()) {
      card.append(
        el(
          doc,
          "div",
          "llm-standalone-update-muted",
          translate("The reply being written now will stop."),
        ),
      );
    }
    const actions = el(doc, "div", "llm-standalone-update-actions");
    const notNow = el(
      doc,
      "button",
      "llm-standalone-update-secondary",
      translate("Not now"),
    );
    notNow.type = "button";
    notNow.dataset.updateAction = "cancel";
    notNow.addEventListener("click", closePopover);
    const confirm = el(
      doc,
      "button",
      "llm-standalone-update-primary",
      translate("Update"),
    );
    confirm.type = "button";
    confirm.dataset.updateAction = "confirm";
    confirm.addEventListener("click", () => {
      closePopover();
      controller.applyUpdate();
    });
    actions.append(notNow, confirm);
    card.append(actions);
  };

  button.addEventListener("click", (event: Event) => {
    // In the collapsed-sidebar flyout a click that reaches the panel closes
    // the flyout and leaves the card floating alone.
    event.stopPropagation();
    const state = controller.getState();
    if (state.kind === "updating") return;
    if (popover) {
      // The button toggles whatever it opened.
      closePopover();
      return;
    }
    if (state.kind === "available") {
      openConfirm(state);
      return;
    }
    const version = state.runningVersion;
    if (state.kind === "updated") controller.acknowledgeUpdated();
    openNotes(version);
  });

  const onPointerDown = (event: Event) => {
    // The release notes close on a click on their own dimmed area.
    if (!popover || popoverKind === "notes") return;
    const target = event.target as Node | null;
    if (target && (popover.contains(target) || button.contains(target))) return;
    closePopover();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!popover) return;
    if (event.key === "Tab" && popoverKind === "notes") {
      // Keep keyboard focus inside the release notes while they are open.
      const focusable = Array.from(
        popover.querySelectorAll("button:not(:disabled), a[href]"),
      ) as HTMLElement[];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = doc.activeElement;
      if (event.shiftKey && (active === first || !popover.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !popover.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closePopover();
  };
  doc.addEventListener("mousedown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);

  const unsubscribe = controller.subscribe(render);
  render(controller.getState());

  return {
    button,
    dispose() {
      unsubscribe();
      doc.removeEventListener("mousedown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      closePopover();
      button.remove();
    },
  };
}
