import { assert } from "chai";
import {
  adoptContentBarButton,
  appendContentBarButton,
  appendContentCaption,
  ensureContentBar,
} from "../src/modules/contextPanel/contentChrome";
import { attachFlatCodeBlockChrome } from "../src/modules/contextPanel/renderedMarkdown";
import { renderMarkdown } from "../src/utils/markdown";
import { FakeElement, fakeDocument } from "./helpers/fakeDom";

const asEl = (el: FakeElement) => el as unknown as HTMLElement;

describe("contentChrome helper", function () {
  it("creates one hover bar per block, as a direct child", function () {
    const block = new FakeElement("div");
    const first = ensureContentBar(asEl(block), fakeDocument);
    const second = ensureContentBar(asEl(block), fakeDocument);
    assert.strictEqual(first, second);
    assert.equal(block.children.length, 1);
    assert.isTrue(block.children[0].classList.contains("llm-content-bar"));
  });

  it("keeps buttons in the order they were added and labels them", function () {
    const block = new FakeElement("div");
    const bar = asEl(ensureContentBar(asEl(block), fakeDocument) as never);
    const clicks: string[] = [];
    appendContentBarButton(
      bar,
      { className: "a", label: "Wrap long lines", pressed: true },
      fakeDocument,
    );
    appendContentBarButton(
      bar,
      {
        className: "b",
        label: "Copy code",
        icon: "url(x.svg)",
        onClick: () => clicks.push("b"),
      },
      fakeDocument,
    );
    const buttons = (bar as unknown as FakeElement).children;
    assert.deepEqual(
      buttons.map((b) => b.attributes["aria-label"]),
      ["Wrap long lines", "Copy code"],
    );
    assert.isTrue(buttons[0].classList.contains("llm-content-bar-btn"));
    assert.equal(buttons[0].attributes["aria-pressed"], "true");
    assert.isUndefined(buttons[1].attributes["aria-pressed"]);
    assert.equal(buttons[1].style["--llm-content-bar-icon"], "url(x.svg)");
    const event = buttons[1].dispatchFakeEvent("click");
    assert.deepEqual(clicks, ["b"]);
    assert.isTrue(event.defaultPrevented);
  });

  it("adopts an existing button without replacing it", function () {
    const block = new FakeElement("div");
    const bar = ensureContentBar(asEl(block), fakeDocument);
    const button = new FakeElement("button");
    adoptContentBarButton(bar, asEl(button));
    assert.strictEqual((bar as unknown as FakeElement).children[0], button);
    assert.isTrue(button.classList.contains("llm-content-bar-btn"));
  });

  it("builds a caption with kind, text and an accent link", function () {
    const block = new FakeElement("div");
    let opened = 0;
    const caption = appendContentCaption(
      asEl(block),
      {
        kind: "Table",
        text: "Results by arm",
        link: { label: "Open", onClick: () => (opened += 1) },
      },
      fakeDocument,
    ) as unknown as FakeElement;
    assert.isTrue(caption.classList.contains("llm-content-caption"));
    assert.deepEqual(
      caption.children.map((c) => c.className),
      [
        "llm-content-caption-kind",
        "llm-content-caption-text",
        "llm-content-caption-link",
      ],
    );
    assert.equal(caption.children[0].textContent, "Table");
    caption.children[2].dispatchFakeEvent("click");
    assert.equal(opened, 1);
    // A second caption replaces the first.
    appendContentCaption(asEl(block), { kind: "Figure" }, fakeDocument);
    assert.equal(
      block.children.filter((c) => c.classList.contains("llm-content-caption"))
        .length,
      1,
    );
  });
});

function buildCodeBlock(options: { flat: boolean; lines: number }) {
  const root = new FakeElement("div");
  if (options.flat) root.className = "llm-content-flat";
  const copyable = new FakeElement("div");
  copyable.className = "llm-copyable llm-copyable-code";
  const shell = new FakeElement("div");
  shell.className = "llm-codeblock-shell";
  shell.dataset.codeLang = "python";
  shell.dataset.wordWrap = "false";
  const header = new FakeElement("div");
  header.className = "llm-codeblock-header";
  const wrap = new FakeElement("button");
  wrap.className = "llm-codeblock-wrap-toggle";
  const copy = new FakeElement("button");
  copy.className = "llm-render-copy-btn llm-render-code-copy-btn";
  copy.textContent = "⧉";
  const move = new FakeElement("button");
  move.className = "llm-side-move-btn";
  header.append(wrap, copy, move);
  const body = new FakeElement("div");
  body.className = "llm-codeblock-body";
  body.textContent = Array.from(
    { length: options.lines },
    (_, i) => `line ${i}`,
  ).join("\n");
  shell.append(header, body);
  copyable.appendChild(shell);
  root.appendChild(copyable);
  return { root, copyable, shell, header, wrap, copy, move };
}

describe("flat code block chrome", function () {
  it("moves wrap, copy and move buttons into the bar in order", function () {
    const { root, copyable, header, wrap, copy, move } = buildCodeBlock({
      flat: true,
      lines: 3,
    });
    attachFlatCodeBlockChrome(root as unknown as ParentNode, fakeDocument);
    const bar = copyable.children.find((c) =>
      c.classList.contains("llm-content-bar"),
    );
    assert.exists(bar);
    assert.deepEqual(bar?.children, [wrap, copy, move]);
    assert.notInclude(header.children, wrap);
    assert.equal(copy.textContent, "");
    assert.equal(copy.attributes["aria-label"], "Copy code");
    assert.equal(wrap.attributes["aria-label"], "Wrap long lines");
    assert.equal(wrap.attributes["aria-pressed"], "false");
    // No fold under 16 lines.
    assert.isUndefined(
      copyable.children.find((c) =>
        c.classList.contains("llm-content-fold-btn"),
      ),
    );
    // Running again does not duplicate anything.
    attachFlatCodeBlockChrome(root as unknown as ParentNode, fakeDocument);
    assert.equal(bar?.children.length, 3);
  });

  it("folds a long block behind a Show all N lines button", function () {
    const { root, copyable, shell } = buildCodeBlock({ flat: true, lines: 40 });
    attachFlatCodeBlockChrome(root as unknown as ParentNode, fakeDocument);
    const fold = copyable.children.find((c) =>
      c.classList.contains("llm-content-fold-btn"),
    );
    assert.exists(fold);
    assert.equal(fold?.textContent, "Show all 40 lines");
    assert.equal(shell.dataset.fold, "folded");
    fold?.dispatchFakeEvent("click");
    assert.equal(shell.dataset.fold, "expanded");
    assert.equal(fold?.textContent, "Show fewer lines");
    fold?.dispatchFakeEvent("click");
    assert.equal(shell.dataset.fold, "folded");
  });

  it("leaves a block outside the flat scope with its header buttons", function () {
    const { root, copyable, header, wrap, copy, move } = buildCodeBlock({
      flat: false,
      lines: 40,
    });
    attachFlatCodeBlockChrome(root as unknown as ParentNode, fakeDocument);
    assert.deepEqual(header.children, [wrap, copy, move]);
    assert.isUndefined(
      copyable.children.find((c) => c.classList.contains("llm-content-bar")),
    );
    assert.isUndefined(
      copyable.children.find((c) =>
        c.classList.contains("llm-content-fold-btn"),
      ),
    );
  });

  it("marks plain fences, and only plain fences, for the flat style", function () {
    const plain = renderMarkdown("```python\nprint(1)\n```");
    assert.include(plain, "llm-codeblock-plain");
    assert.include(plain, "llm-copyable-plain-code");
    const svg = renderMarkdown(
      '```svg\n<svg width="10" height="10"></svg>\n```',
    );
    assert.notInclude(svg, "llm-codeblock-plain");
  });
});
