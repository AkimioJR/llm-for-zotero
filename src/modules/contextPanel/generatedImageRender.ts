import { appLogger } from "../../core/logging";
import type {
  GeneratedChatImage,
  GeneratedChatImageFigure,
} from "../../shared/types";
import {
  isRenderableGeneratedImageSrc,
  normalizeGeneratedChatImages,
} from "../../shared/generatedImages";
import { HTML_NS } from "../../utils/domHelpers";
import { toFileUrl } from "../../utils/localPath";
import { revealLocalPath } from "../../utils/revealLocalPath";
import { copyTextToClipboard } from "./clipboard";
import { mountFigureTabZoom, openFigureViewer } from "./figureViewer";
import { openReaderForItem } from "./quoteNavigator";
import {
  SIDE_ITEM_KIND_ATTRIBUTE,
  appendMoveToSidePanelButton,
  getSidePanelItemHost,
  type SidePanelItemRequest,
} from "./sidePanelItems";
import {
  isEmbeddableGeneratedImage,
  resolveGeneratedImageAsset,
  resolveGeneratedImageLocalPath,
  saveGeneratedImageAssetToPath,
} from "../../services/images/generatedImageAssets";

function openGeneratedImageFileUrl(fileUrl: string): boolean {
  try {
    const launch = (Zotero as any).launchURL as
      | ((url: string) => void)
      | undefined;
    if (typeof launch === "function") {
      launch(fileUrl);
      return true;
    }
  } catch (_err) {
    void _err;
  }
  try {
    const win = Zotero.getMainWindow?.() as
      | (Window & { open?: (url?: string, target?: string) => unknown })
      | null;
    if (win?.open) {
      win.open(fileUrl, "_blank");
      return true;
    }
  } catch (_err) {
    void _err;
  }
  return false;
}

function resolveGeneratedChatImageSrc(image: GeneratedChatImage): string {
  const fileUrl = toFileUrl(image.path);
  if (fileUrl) return fileUrl;
  return isRenderableGeneratedImageSrc(image.src) ? image.src.trim() : "";
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export async function copyGeneratedImageToClipboard(
  body: Element,
  image: GeneratedChatImage,
): Promise<"image" | "source"> {
  let asset: Awaited<ReturnType<typeof resolveGeneratedImageAsset>> = null;
  try {
    asset = await resolveGeneratedImageAsset(image);
  } catch (err) {
    appLogger.debug("LLM: Generated image read failed, falling back:", err);
  }
  const win = body.ownerDocument?.defaultView as
    | (Window & {
        navigator?: Navigator;
        ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem;
      })
    | undefined;
  if (asset?.bytes && win?.navigator?.clipboard?.write && win.ClipboardItem) {
    try {
      const blob = new Blob([bytesToArrayBuffer(asset.bytes)], {
        type: asset.mimeType,
      });
      const item = new win.ClipboardItem({ [asset.mimeType]: blob });
      await win.navigator.clipboard.write([item]);
      return "image";
    } catch (err) {
      appLogger.debug("LLM: Image clipboard write failed, falling back:", err);
    }
  }

  const source =
    asset?.fileUrl ||
    asset?.path ||
    toFileUrl(image.path) ||
    image.path ||
    (isRenderableGeneratedImageSrc(image.src) ? image.src.trim() : "");
  if (!source) {
    throw new Error("Generated image source is unavailable");
  }
  await copyTextToClipboard(body, source);
  return "source";
}

type GeneratedImageSavePathResult =
  | { status: "selected"; path: string }
  | { status: "cancelled" }
  | { status: "unavailable" };

type GeneratedImageFilePicker = {
  init?: (parent: unknown, title: string, mode: number) => void;
  appendFilter?: (title: string, filter: string) => void;
  appendFilters?: (filterMask: number) => void;
  open?: (callback: (result: number) => void) => void;
  show?: () => number | Promise<number>;
  defaultString?: string;
  defaultExtension?: string;
  file?: string | { path?: string };
  modeSave?: number;
  returnOK?: number;
  returnReplace?: number;
  filterAll?: number;
};

type GeneratedImageFilePickerConstructor = new () => GeneratedImageFilePicker;

function getGeneratedImagePickerParentWindow(doc: Document): Window | null {
  const mainWindow = Zotero.getMainWindow?.() as Window | null | undefined;
  const candidates = [mainWindow, doc.defaultView].filter(Boolean) as Window[];
  const withBrowsingContext = candidates.find((candidate) =>
    Boolean(
      (candidate as unknown as { browsingContext?: unknown }).browsingContext,
    ),
  );
  return withBrowsingContext || candidates[0] || null;
}

function getZoteroFilePickerConstructor(): GeneratedImageFilePickerConstructor | null {
  const ZoteroFilePicker = (Zotero as any).FilePicker as
    | GeneratedImageFilePickerConstructor
    | undefined;
  if (typeof ZoteroFilePicker === "function") return ZoteroFilePicker;

  const CU = (globalThis as any).ChromeUtils;
  if (CU?.importESModule) {
    try {
      const mod = CU.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs",
      ) as { FilePicker?: GeneratedImageFilePickerConstructor };
      if (typeof mod?.FilePicker === "function") return mod.FilePicker;
    } catch (err) {
      appLogger.debug("LLM: Zotero FilePicker module import failed", err);
    }
  }
  return null;
}

function getGeneratedImagePickerFilePath(
  picker: GeneratedImageFilePicker,
): string {
  const file = picker.file;
  if (typeof file === "string") return file.trim();
  return typeof file?.path === "string" ? file.path.trim() : "";
}

function configureGeneratedImageFilePicker(
  picker: GeneratedImageFilePicker,
  parent: unknown,
  fileName: string,
  constants: {
    modeSave?: number;
    filterAll?: number;
  },
): void {
  picker.init?.(
    parent,
    "Save generated image",
    picker.modeSave ?? constants.modeSave ?? 0,
  );
  const defaultName = fileName || "generated-image.png";
  try {
    picker.defaultString = defaultName;
  } catch (err) {
    appLogger.debug("LLM: Failed to set generated image default filename", err);
  }
  const extMatch = defaultName.match(/\.([A-Za-z0-9]+)$/);
  if (extMatch?.[1]) {
    try {
      picker.defaultExtension = extMatch[1];
    } catch (err) {
      appLogger.debug(
        "LLM: Failed to set generated image default extension",
        err,
      );
    }
  }
  try {
    picker.appendFilter?.("Images", "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.svg");
  } catch (err) {
    appLogger.debug("LLM: Failed to add generated image file filter", err);
  }
  const filterAll = picker.filterAll ?? constants.filterAll;
  if (typeof filterAll === "number") {
    try {
      picker.appendFilters?.(filterAll);
    } catch (err) {
      appLogger.debug(
        "LLM: Failed to add generated image all-files filter",
        err,
      );
    }
  }
}

async function resolveGeneratedImageFilePickerResult(
  picker: GeneratedImageFilePicker,
  constants: {
    returnOK?: number;
    returnReplace?: number;
  },
): Promise<GeneratedImageSavePathResult> {
  const result = await new Promise<number>((resolve, reject) => {
    try {
      if (typeof picker.open === "function") {
        picker.open((value: number) => resolve(value));
        return;
      }
      if (typeof picker.show === "function") {
        void Promise.resolve(picker.show()).then(resolve, reject);
        return;
      }
      resolve(-1);
    } catch (err) {
      reject(err);
    }
  });
  const returnOK = picker.returnOK ?? constants.returnOK;
  const returnReplace = picker.returnReplace ?? constants.returnReplace;
  const ok =
    result === returnOK ||
    result === returnReplace ||
    (typeof returnOK !== "number" &&
      typeof returnReplace !== "number" &&
      result === 0);
  if (!ok) return { status: "cancelled" };
  const path = getGeneratedImagePickerFilePath(picker);
  return path ? { status: "selected", path } : { status: "unavailable" };
}

async function pickGeneratedImageSavePath(
  doc: Document,
  fileName: string,
): Promise<GeneratedImageSavePathResult> {
  const parentWindow = getGeneratedImagePickerParentWindow(doc);
  const ZoteroFilePicker = getZoteroFilePickerConstructor();
  if (ZoteroFilePicker) {
    try {
      const picker = new ZoteroFilePicker();
      if (!parentWindow) {
        return { status: "unavailable" };
      }
      configureGeneratedImageFilePicker(picker, parentWindow, fileName, {});
      return await resolveGeneratedImageFilePickerResult(picker, {});
    } catch (err) {
      appLogger.warn("LLM: Zotero file picker failed", err);
    }
  }

  const components = (globalThis as any).Components;
  const Cc = components?.classes;
  const Ci = components?.interfaces;
  const filePickerFactory = Cc?.["@mozilla.org/filepicker;1"];
  const nsIFilePicker = Ci?.nsIFilePicker;
  if (!filePickerFactory?.createInstance || !nsIFilePicker) {
    return { status: "unavailable" };
  }

  try {
    const picker = filePickerFactory.createInstance(
      nsIFilePicker,
    ) as GeneratedImageFilePicker;
    const parentBrowsingContext = (
      parentWindow as unknown as { browsingContext?: unknown } | null
    )?.browsingContext;
    configureGeneratedImageFilePicker(
      picker,
      parentBrowsingContext || null,
      fileName,
      {
        modeSave: nsIFilePicker.modeSave,
        filterAll: nsIFilePicker.filterAll,
      },
    );
    return await resolveGeneratedImageFilePickerResult(picker, {
      returnOK: nsIFilePicker.returnOK,
      returnReplace: nsIFilePicker.returnReplace,
    });
  } catch (err) {
    appLogger.warn("LLM: XPCOM file picker failed", err);
    return { status: "unavailable" };
  }
}

export type GeneratedImageRenderOptions = {
  onImageLoaded?: () => void;
  onImageActionStatus?: (
    message: string,
    level: "ready" | "warning" | "error",
  ) => void;
  wrapClassName?: string;
  frameClassName?: string;
  /** Opens a figure's source page; defaults to the Zotero reader. */
  openFigurePage?: (figure: GeneratedChatImageFigure) => Promise<void>;
  /**
   * A paper figure gets a "Move to side panel" button where the document has
   * a side panel. The side panel tab turns it off for its own copy.
   */
  allowMoveToSidePanel?: boolean;
  /**
   * A click on the picture opens the large view. The side panel tab turns it
   * off: there a click toggles actual size in place.
   */
  zoomOnClick?: boolean;
};

/** A figure box can reopen its page only when it knows the paper and a page. */
export function canJumpToFigurePage(
  figure: GeneratedChatImageFigure | undefined,
): boolean {
  return Boolean(
    figure?.paper &&
    figure.paper.contextItemId > 0 &&
    Number.isFinite(figure.pageIndex) &&
    (figure.pageIndex as number) >= 0,
  );
}

/** "p. N" for a figure's page label, or "" when the label is unknown. */
export function formatFigurePageLabel(
  figure: GeneratedChatImageFigure | undefined,
): string {
  const label = figure?.pageLabel?.trim();
  return label ? `p. ${label}` : "";
}

function buildGeneratedImageCaption(image: GeneratedChatImage): string {
  const label = image.label || "";
  const page = formatFigurePageLabel(image.figure);
  if (!page) return label;
  // A rendered-page title such as "Paper - page 3" already names its page.
  const pageLabel = image.figure?.pageLabel?.trim() || "";
  const escaped = pageLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (label && new RegExp(`\\bpage\\s*${escaped}\\b`, "i").test(label))
    return label;
  return label ? `${label} \u00b7 ${page}` : page;
}

async function openFigurePageInReader(
  figure: GeneratedChatImageFigure,
): Promise<void> {
  const contextItemId = figure.paper?.contextItemId;
  if (!contextItemId || !Number.isFinite(figure.pageIndex)) {
    throw new Error("This figure has no page to open");
  }
  // A crop's pageLabel is its physical page number, not the PDF's own label,
  // so the reader is sent by index only.
  const reader = await openReaderForItem(contextItemId, {
    pageIndex: figure.pageIndex as number,
  });
  if (!reader) throw new Error("Could not open the paper");
  Zotero.getMainWindow?.()?.focus?.();
}

/**
 * The figure box's buttons: jump to page, copy, save, show in folder and →|.
 * The box and its large view both carry them. Returns false when the image
 * gets none.
 */
function appendGeneratedImageActions(
  parent: HTMLElement,
  container: HTMLElement,
  image: GeneratedChatImage,
  figure: HTMLElement,
  doc: Document,
  options: GeneratedImageRenderOptions,
): boolean {
  const report = (
    message: string,
    level: "ready" | "warning" | "error" = "ready",
  ) => {
    options.onImageActionStatus?.(message, level);
  };
  const createActionButton = (
    className: string,
    title: string,
    onClick: () => Promise<void> | void,
  ): HTMLButtonElement => {
    const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
    button.className = `llm-generated-image-action ${className}`;
    button.type = "button";
    // The label shows on hover from CSS (zoteroPane.css reads aria-label): the
    // standalone window has no native tooltip, and a title would show twice
    // in the main window.
    button.setAttribute("aria-label", title);
    button.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      return Promise.resolve(onClick()).catch((error) => {
        appLogger.warn("LLM: Generated image action failed:", error);
        report(
          error instanceof Error
            ? error.message
            : "Generated image action failed",
          "error",
        );
      });
    });
    return button;
  };

  const embeddable = isEmbeddableGeneratedImage(image);
  const jumpFigure = canJumpToFigurePage(image.figure)
    ? image.figure
    : undefined;
  const canMoveToSidePanel =
    options.allowMoveToSidePanel !== false &&
    Boolean(image.figure) &&
    Boolean(getSidePanelItemHost(doc));
  if (!embeddable && !jumpFigure && !canMoveToSidePanel) return false;
  if (jumpFigure) {
    const title = jumpFigure.pageLabel
      ? `Jump to page ${jumpFigure.pageLabel}`
      : "Jump to page";
    parent.appendChild(
      createActionButton("llm-generated-image-action-jump", title, async () => {
        await (options.openFigurePage || openFigurePageInReader)(jumpFigure);
        report("Opened the paper page", "ready");
      }),
    );
  }
  if (embeddable) {
    parent.appendChild(
      createActionButton(
        "llm-generated-image-action-copy",
        "Copy image",
        async () => {
          const result = await copyGeneratedImageToClipboard(container, image);
          report(result === "image" ? "Copied image" : "Copied image source");
        },
      ),
    );
    parent.appendChild(
      createActionButton(
        "llm-generated-image-action-save",
        "Save image as...",
        async () => {
          const asset = await resolveGeneratedImageAsset(image);
          if (!asset) {
            report("Generated image file is unavailable", "error");
            return;
          }
          const saveTarget = await pickGeneratedImageSavePath(
            doc,
            asset.fileName,
          );
          if (saveTarget.status === "cancelled") {
            report("Image save cancelled", "ready");
            return;
          }
          if (saveTarget.status === "unavailable") {
            report("Save dialog unavailable", "warning");
            return;
          }
          await saveGeneratedImageAssetToPath(asset, saveTarget.path);
          report("Saved image", "ready");
        },
      ),
    );
    const localPath = resolveGeneratedImageLocalPath(image);
    const fileUrl = toFileUrl(localPath);
    const openButton = createActionButton(
      "llm-generated-image-action-open",
      "Show image in folder",
      () => {
        if (localPath && revealLocalPath(localPath)) {
          report("Showed image in folder", "ready");
        } else if (fileUrl && openGeneratedImageFileUrl(fileUrl)) {
          report("Opened image", "ready");
        } else {
          report("Generated image file is unavailable", "error");
        }
      },
    );
    if (!localPath && !fileUrl) {
      openButton.disabled = true;
      openButton.setAttribute("aria-label", "Show image in folder unavailable");
    }
    parent.appendChild(openButton);
  }
  if (canMoveToSidePanel) {
    figure.setAttribute(SIDE_ITEM_KIND_ATTRIBUTE, "figure");
    appendMoveToSidePanelButton({
      doc,
      parent,
      className: "llm-generated-image-action llm-side-move-glyph",
      buildRequest: () => buildFigureSidePanelRequest(image, figure, options),
    })?.removeAttribute("title");
  }
  return true;
}

/**
 * One image box: the image, its caption (with the page of a paper figure),
 * and the copy / save / show-in-folder / jump-to-page actions. The chat's
 * generated images, the figure strip and inline figures all use it.
 */
export function createGeneratedImageFrame(
  container: HTMLElement,
  image: GeneratedChatImage,
  doc: Document,
  options: GeneratedImageRenderOptions = {},
): HTMLElement | null {
  const src = resolveGeneratedChatImageSrc(image);
  if (!src) return null;
  const figure = doc.createElement("figure") as HTMLElement;
  figure.className = [
    "llm-assistant-generated-image-frame",
    options.frameClassName || "",
  ]
    .filter(Boolean)
    .join(" ");

  const img = doc.createElement("img") as HTMLImageElement;
  img.className = "llm-assistant-generated-image";
  img.src = src;
  img.alt = image.label || "Generated image";
  img.title = image.revisedPrompt || image.label || "";
  img.loading = "lazy";
  if (options.onImageLoaded) {
    img.addEventListener("load", options.onImageLoaded);
    img.addEventListener("error", options.onImageLoaded);
  }
  figure.appendChild(img);

  const actions = doc.createElement("div") as HTMLDivElement;
  actions.className = "llm-assistant-generated-image-actions";
  if (
    appendGeneratedImageActions(actions, container, image, figure, doc, options)
  ) {
    figure.appendChild(actions);
  }
  if (options.zoomOnClick !== false) {
    img.className += " llm-assistant-generated-image-zoomable";
    img.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      openFigureViewer(figure, {
        src,
        alt: img.alt,
        caption: buildGeneratedImageCaption(image),
        appendActions: (parent) => {
          appendGeneratedImageActions(
            parent,
            container,
            image,
            figure,
            doc,
            options,
          );
        },
      });
    });
  }

  const captionText = buildGeneratedImageCaption(image);
  if (captionText) {
    const caption = doc.createElement("figcaption") as HTMLElement;
    caption.className = "llm-assistant-generated-image-caption";
    caption.textContent = captionText;
    caption.title = captionText;
    figure.appendChild(caption);
  }
  return figure;
}

/**
 * What the figure box's →| button hands to the side panel. The tab draws the
 * same figure box (caption, page, copy / save / show-in-folder / jump), fitted
 * to the tab; scroll or pinch zooms and a drag moves it.
 */
export function buildFigureSidePanelRequest(
  image: GeneratedChatImage,
  element: Element,
  options: GeneratedImageRenderOptions = {},
): SidePanelItemRequest {
  const caption = buildGeneratedImageCaption(image);
  const localPath = resolveGeneratedImageLocalPath(image);
  const source =
    toFileUrl(localPath) || localPath || resolveGeneratedChatImageSrc(image);
  return {
    kind: "figure",
    title: caption || undefined,
    source,
    element,
    renderBody: (targetDoc, root) => {
      const frame = createGeneratedImageFrame(root, image, targetDoc, {
        ...options,
        allowMoveToSidePanel: false,
        zoomOnClick: false,
      });
      if (!frame) return;
      root.appendChild(frame);
      const img = frame.querySelector("img") as HTMLImageElement | null;
      if (img) mountFigureTabZoom(frame, img);
    },
  };
}

export function renderAssistantGeneratedImagesInto(
  container: HTMLElement,
  images: GeneratedChatImage[] | undefined,
  doc: Document,
  options: GeneratedImageRenderOptions = {},
): boolean {
  const normalized = normalizeGeneratedChatImages(images);
  const frames = normalized
    .map((image) => createGeneratedImageFrame(container, image, doc, options))
    .filter((frame): frame is HTMLElement => Boolean(frame));
  if (!frames.length) return false;

  const wrap = doc.createElement("div") as HTMLDivElement;
  wrap.className = [
    "llm-assistant-generated-images",
    options.wrapClassName || "",
  ]
    .filter(Boolean)
    .join(" ");
  for (const frame of frames) wrap.appendChild(frame);
  container.appendChild(wrap);
  return true;
}
