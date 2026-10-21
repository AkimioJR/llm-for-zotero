import { HTML_NS } from "../../utils/domHelpers";
import { registerAddonInPanelDialog } from "../../utils/dialogRegistry";
import { ZOOM_BUTTON_STEP, getWheelZoomScale } from "./wheelZoom";

/**
 * The large figure view. A click on a figure in the chat opens it over the
 * plugin — the chat panel in Zotero's sidebar, the whole standalone window —
 * fitted to the space. A click on the picture switches to actual size (and
 * back), a drag moves it, the wheel and + / − zoom, and ×, Esc or a click
 * beside the picture closes it.
 */

export type FigureViewSize = { width: number; height: number };
export type FigureViewTransform = { scale: number; x: number; y: number };

export const FIGURE_VIEW_MAX_SCALE = 4;
const FIGURE_VIEW_PADDING = 16;
/** Below this width the bar keeps only zoom and close. */
const FIGURE_VIEW_NARROW_WIDTH = 480;
/** A press that moves less than this is a click, not a drag. */
const FIGURE_VIEW_CLICK_SLOP = 4;
const STANDALONE_ROOT_ID = "llmforzotero-standalone-chat-root";

/** The scale that fits the whole picture in the stage, never above 100%. */
export function fitFigureScale(
  natural: FigureViewSize,
  stage: FigureViewSize,
  padding = FIGURE_VIEW_PADDING,
): number {
  if (!(natural.width > 0 && natural.height > 0)) return 1;
  const scale = Math.min(
    (stage.width - padding * 2) / natural.width,
    (stage.height - padding * 2) / natural.height,
    1,
  );
  return scale > 0 ? scale : 0.01;
}

/**
 * Keeps the picture in view: centred along a side where it is smaller than
 * the stage, and with no empty gap along a side where it is larger.
 */
export function clampFigurePan(
  view: FigureViewTransform,
  natural: FigureViewSize,
  stage: FigureViewSize,
): FigureViewTransform {
  const clampAxis = (offset: number, size: number, room: number) =>
    size <= room
      ? (room - size) / 2
      : Math.min(0, Math.max(room - size, offset));
  return {
    scale: view.scale,
    x: clampAxis(view.x, natural.width * view.scale, stage.width),
    y: clampAxis(view.y, natural.height * view.scale, stage.height),
  };
}

/** Zooms so the point under the pointer stays where it is. */
export function zoomFigureAround(
  view: FigureViewTransform,
  nextScale: number,
  point: { x: number; y: number },
  minScale: number,
  natural: FigureViewSize,
  stage: FigureViewSize,
): FigureViewTransform {
  const scale = Math.max(
    minScale,
    Math.min(FIGURE_VIEW_MAX_SCALE, Number.isFinite(nextScale) ? nextScale : 1),
  );
  const ratio = scale / view.scale;
  return clampFigurePan(
    {
      scale,
      x: point.x - (point.x - view.x) * ratio,
      y: point.y - (point.y - view.y) * ratio,
    },
    natural,
    stage,
  );
}

export type FigureViewerOptions = {
  src: string;
  alt: string;
  /** "Figure 1 · p. 3"; the bar shows it and the dialog is named by it. */
  caption: string;
  /**
   * Adds the figure box's own buttons (jump, copy, save, folder, →|) to the
   * bar. Jump and →| close the view after they run.
   */
  appendActions?: (parent: HTMLElement) => void;
};

function htmlEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  node.className = className;
  return node;
}

/**
 * Where the view goes: the standalone window's root (the view covers the
 * window), else the chat panel the figure sits in (the view covers the
 * panel), else the document.
 */
function resolveFigureViewerHost(anchor: Element): {
  host: Element;
  coversWindow: boolean;
} | null {
  const doc = anchor.ownerDocument;
  if (!doc) return null;
  const standaloneRoot = doc.getElementById(STANDALONE_ROOT_ID);
  if (standaloneRoot) return { host: standaloneRoot, coversWindow: true };
  const panel = anchor.closest(".llm-panel");
  if (panel) return { host: panel, coversWindow: false };
  const fallback = doc.body ?? doc.documentElement;
  return fallback ? { host: fallback, coversWindow: true } : null;
}

/** Opens the large view of a figure; returns a function that closes it. */
export function openFigureViewer(
  anchor: Element,
  options: FigureViewerOptions,
): () => void {
  const resolved = resolveFigureViewerHost(anchor);
  const doc = anchor.ownerDocument;
  const win = doc?.defaultView;
  if (!resolved || !doc || !win) return () => {};
  const { host, coversWindow } = resolved;
  const previousActiveElement = doc.activeElement as HTMLElement | null;

  const overlay = htmlEl(doc, "div", "llm-figure-viewer");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", options.caption || options.alt);
  overlay.tabIndex = -1;

  const bar = htmlEl(doc, "div", "llm-figure-viewer-bar");
  const title = htmlEl(doc, "span", "llm-figure-viewer-title");
  title.textContent = options.caption;
  title.title = options.caption;

  const barButton = (className: string, label: string) => {
    const button = htmlEl(
      doc,
      "button",
      `llm-generated-image-action llm-figure-viewer-button ${className}`,
    );
    button.type = "button";
    button.setAttribute("aria-label", label);
    return button;
  };
  const zoomGroup = htmlEl(doc, "span", "llm-figure-viewer-group");
  const zoomOut = barButton("llm-figure-viewer-zoom-out", "Zoom out");
  const percent = htmlEl(doc, "span", "llm-figure-viewer-percent");
  const zoomIn = barButton("llm-figure-viewer-zoom-in", "Zoom in");
  const fitButton = barButton("llm-figure-viewer-fit", "Fit to window");
  zoomGroup.append(zoomOut, percent, zoomIn, fitButton);

  const actionGroup = htmlEl(
    doc,
    "span",
    "llm-figure-viewer-group llm-figure-viewer-actions",
  );
  options.appendActions?.(actionGroup);
  const closeButton = barButton("llm-figure-viewer-close", "Close (Esc)");
  bar.append(title, zoomGroup);
  if (actionGroup.childElementCount) bar.append(actionGroup);
  bar.append(closeButton);

  const stage = htmlEl(doc, "div", "llm-figure-viewer-stage");
  const image = htmlEl(doc, "img", "llm-figure-viewer-image");
  image.alt = options.alt;
  image.draggable = false;
  stage.appendChild(image);

  const hint = htmlEl(doc, "div", "llm-figure-viewer-hint");
  hint.textContent =
    "Click the figure for actual size · Scroll to zoom · Drag to move · Esc or click outside to close";
  overlay.append(bar, stage, hint);

  let natural: FigureViewSize = { width: 0, height: 0 };
  let view: FigureViewTransform = { scale: 1, x: 0, y: 0 };
  let minScale = 1;
  let closed = false;

  const stageSize = (): FigureViewSize => ({
    width: stage.clientWidth,
    height: stage.clientHeight,
  });
  const paint = () => {
    image.style.width = `${natural.width}px`;
    image.style.height = `${natural.height}px`;
    image.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    percent.textContent = `${Math.round(view.scale * 100)}%`;
    overlay.classList.toggle(
      "llm-figure-viewer-zoomed",
      view.scale > minScale + 0.001,
    );
  };
  const fit = () => {
    if (!natural.width) return;
    minScale = fitFigureScale(natural, stageSize());
    view = clampFigurePan(
      { scale: minScale, x: 0, y: 0 },
      natural,
      stageSize(),
    );
    paint();
  };
  const zoomTo = (scale: number, clientX?: number, clientY?: number) => {
    if (!natural.width) return;
    const rect = stage.getBoundingClientRect();
    const point = {
      x: clientX === undefined ? rect.width / 2 : clientX - rect.left,
      y: clientY === undefined ? rect.height / 2 : clientY - rect.top,
    };
    view = zoomFigureAround(view, scale, point, minScale, natural, stageSize());
    paint();
  };

  // The panel can move or resize (the sidebar is dragged) while the view is
  // open, so its box is read again on every resize.
  const placeOverlay = () => {
    if (coversWindow) return;
    const rect = host.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  };
  const relayout = () => {
    placeOverlay();
    overlay.classList.toggle(
      "llm-figure-viewer-narrow",
      overlay.getBoundingClientRect().width < FIGURE_VIEW_NARROW_WIDTH,
    );
    fit();
  };

  const onImageReady = () => {
    natural = {
      width: image.naturalWidth || 800,
      height: image.naturalHeight || 600,
    };
    fit();
  };
  image.addEventListener("load", onImageReady);

  let press: {
    x: number;
    y: number;
    viewX: number;
    viewY: number;
    onImage: boolean;
    moved: boolean;
  } | null = null;
  stage.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    press = {
      x: event.clientX,
      y: event.clientY,
      viewX: view.x,
      viewY: view.y,
      onImage: event.target === image,
      moved: false,
    };
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // Capture only keeps a drag alive outside the stage.
    }
  });
  stage.addEventListener("pointermove", (event: PointerEvent) => {
    if (!press) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (Math.abs(dx) + Math.abs(dy) > FIGURE_VIEW_CLICK_SLOP)
      press.moved = true;
    if (!press.moved || view.scale <= minScale + 0.001) return;
    overlay.classList.add("llm-figure-viewer-dragging");
    view = clampFigurePan(
      { scale: view.scale, x: press.viewX + dx, y: press.viewY + dy },
      natural,
      stageSize(),
    );
    paint();
  });
  const endPress = (event: PointerEvent) => {
    const current = press;
    press = null;
    overlay.classList.remove("llm-figure-viewer-dragging");
    if (!current || current.moved || event.type !== "pointerup") return;
    if (!current.onImage) close();
    else if (view.scale > minScale + 0.001) fit();
    else zoomTo(1, event.clientX, event.clientY);
  };
  stage.addEventListener("pointerup", endPress);
  stage.addEventListener("pointercancel", endPress);
  stage.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      event.preventDefault();
      zoomTo(
        getWheelZoomScale(view.scale, event.deltaY),
        event.clientX,
        event.clientY,
      );
    },
    { passive: false },
  );

  const stopButtonEvent = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  zoomIn.addEventListener("click", (event: Event) => {
    stopButtonEvent(event);
    zoomTo(view.scale + ZOOM_BUTTON_STEP);
  });
  zoomOut.addEventListener("click", (event: Event) => {
    stopButtonEvent(event);
    zoomTo(view.scale - ZOOM_BUTTON_STEP);
  });
  fitButton.addEventListener("click", (event: Event) => {
    stopButtonEvent(event);
    fit();
  });
  closeButton.addEventListener("click", (event: Event) => {
    stopButtonEvent(event);
    close();
  });
  // Jump opens the paper and →| opens the side panel: the view gets out of
  // the way once they have run (capture sees the click before the button).
  actionGroup.addEventListener(
    "click",
    (event: Event) => {
      const target = event.target as Element | null;
      if (
        target?.closest?.(
          ".llm-generated-image-action-jump, .llm-side-move-btn",
        )
      ) {
        win.setTimeout(() => close(), 0);
      }
    },
    true,
  );
  // Clicks inside the view never reach the chat underneath.
  overlay.addEventListener("click", (event: Event) => event.stopPropagation());

  const onKeydown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    let handled = true;
    if (event.key === "Escape") close();
    else if (event.key === "+" || event.key === "=")
      zoomTo(view.scale + ZOOM_BUTTON_STEP);
    else if (event.key === "-") zoomTo(view.scale - ZOOM_BUTTON_STEP);
    else if (event.key === "0") fit();
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  doc.addEventListener("keydown", onKeydown, true);

  const ResizeObserverCtor = (
    win as unknown as {
      ResizeObserver?: typeof ResizeObserver;
    }
  ).ResizeObserver;
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(() => relayout())
    : null;
  const onWindowResize = () => relayout();

  let unregisterDialog = () => {};
  function close(): void {
    if (closed) return;
    closed = true;
    unregisterDialog();
    doc!.removeEventListener("keydown", onKeydown, true);
    win!.removeEventListener("resize", onWindowResize);
    resizeObserver?.disconnect();
    overlay.remove();
    try {
      previousActiveElement?.focus?.({ preventScroll: true });
    } catch {
      // The element that had focus may be gone after a re-render.
    }
  }
  unregisterDialog = registerAddonInPanelDialog(doc, close);

  if (coversWindow) overlay.classList.add("llm-figure-viewer-window");
  host.appendChild(overlay);
  placeOverlay();
  resizeObserver?.observe(host);
  win.addEventListener("resize", onWindowResize);
  image.src = options.src;
  if (image.complete && image.naturalWidth) onImageReady();
  relayout();
  // The view itself takes focus (for Esc and the zoom keys); focusing the
  // close button would show its ring and label before anything is pressed.
  try {
    overlay.focus({ preventScroll: true });
  } catch {
    overlay.focus();
  }
  return close;
}
