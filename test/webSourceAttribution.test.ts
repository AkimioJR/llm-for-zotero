import { assert } from "chai";
import {
  assessWebAttribution,
  getWebSourceAnchorsFromTrace,
  stripWebSourceMarkersForDisplay,
  type WebToolExecutionRecord,
} from "../src/webAccess/attribution";
import { injectWebSourceAnchorTokens } from "../src/modules/contextPanel/webSourceIndicators";

describe("web source attribution", function () {
  const source = {
    sourceId: "web_abc1234",
    url: "https://example.com/report",
    hostname: "example.com",
    organization: "Example Organization",
    title: "Annual report",
    faviconUrl: "https://example.com/favicon.ico",
    snippet: "Result snippet",
  };
  const records: WebToolExecutionRecord[] = [
    {
      name: "web_search",
      ok: true,
      content: { results: [source] },
    },
  ];

  it("removes markers and records clean paragraph insertion offsets", function () {
    const first = "The reported value is current.";
    const second = "A second paragraph repeats that source.";
    const text =
      `${first}<!--llm-web-source:web_abc1234,web_abc1234-->\n\n` +
      `${second}<!--llm-web-source:web_abc1234-->`;
    const assessment = assessWebAttribution(text, records);
    assert.equal(assessment.status, "valid");
    if (assessment.status !== "valid") return;
    assert.equal(assessment.cleanText, `${first}\n\n${second}`);
    assert.lengthOf(assessment.anchors, 2);
    assert.equal(assessment.anchors[0].offset, first.length);
    assert.equal(assessment.anchors[1].offset, `${first}\n\n${second}`.length);
    assert.lengthOf(assessment.anchors[0].sources, 1);
    assert.deepInclude(assessment.anchors[0].sources[0], {
      sourceId: "web_abc1234",
      organization: "Example Organization",
      title: "Annual report",
      faviconUrl: "https://example.com/favicon.ico",
    });
  });

  it("allows an explicit no-web-use marker without creating a chip", function () {
    const assessment = assessWebAttribution(
      "The answer does not rely on the search.\n\n<!--llm-web-source:none-->",
      records,
    );
    assert.equal(assessment.status, "valid");
    if (assessment.status === "valid") {
      assert.deepEqual(assessment.anchors, []);
      assert.equal(
        assessment.cleanText,
        "The answer does not rely on the search.",
      );
    }
  });

  it("preserves a paragraph break declared by a source marker", function () {
    const first = "A web-supported paragraph.";
    const second = "**A separate paragraph.** More text.";
    const assessment = assessWebAttribution(
      `${first}<!--llm-web-source:web_abc1234-->\n${second}`,
      records,
    );
    assert.equal(assessment.status, "valid");
    if (assessment.status !== "valid") return;
    assert.equal(assessment.cleanText, `${first}\n\n${second}`);
    assert.equal(assessment.anchors[0].offset, first.length);
  });

  it("keeps a compact list compact while anchoring the preceding item", function () {
    const first = "- First sourced item.";
    const second = "- Second item.";
    const assessment = assessWebAttribution(
      `${first}<!--llm-web-source:web_abc1234-->\n${second}`,
      records,
    );
    assert.equal(assessment.status, "valid");
    if (assessment.status !== "valid") return;
    assert.equal(assessment.cleanText, `${first}\n${second}`);
    assert.equal(assessment.anchors[0].offset, first.length);
  });

  it("rejects missing, unknown, failed, and unsafe sources", function () {
    assert.equal(
      assessWebAttribution("Unattributed claim.", records).status,
      "invalid",
    );
    assert.equal(
      assessWebAttribution("Claim.<!--llm-web-source:web_unknown-->", records)
        .status,
      "invalid",
    );
    assert.equal(
      assessWebAttribution("Claim.<!--llm-web-source:web_abc1234-->", [
        { name: "web_search", ok: false, content: { results: [source] } },
      ]).status,
      "invalid",
    );
    assert.equal(
      assessWebAttribution("Claim.<!--llm-web-source:web_abc1234-->", [
        {
          name: "web_search",
          ok: true,
          content: {
            results: [{ ...source, url: "http://127.0.0.1/private" }],
          },
        },
      ]).status,
      "invalid",
    );
  });

  it("rejects residual partial markers and merges adjacent markers on one line", function () {
    assert.equal(
      assessWebAttribution(
        "First.<!--llm-web-source:web_abc1234-->\n\nSecond.<!--llm-web-source:web_",
        records,
      ).status,
      "invalid",
    );
    const merged = assessWebAttribution(
      "Claim.<!--llm-web-source:web_abc1234--><!--llm-web-source:web_abc1234-->",
      records,
    );
    assert.equal(merged.status, "valid");
    if (merged.status !== "valid") return;
    assert.lengthOf(merged.anchors, 1);
    assert.lengthOf(merged.anchors[0].sources, 1);
  });

  describe("mid-line markers", function () {
    const sourceB = {
      ...source,
      sourceId: "web_def5678",
      url: "https://example.org/releases",
      hostname: "example.org",
      organization: "Example Org",
      title: "Release list",
    };
    const two: WebToolExecutionRecord[] = [
      { name: "web_search", ok: true, content: { results: [source, sourceB] } },
    ];
    const M = (ids: string) => `<!--llm-web-source:${ids}-->`;

    it("merges mid-line markers into one end-of-line anchor", function () {
      const text = `Intro defaults.${M("web_abc1234")} The release list...${M("web_def5678")} So: done.`;
      const clean = "Intro defaults. The release list... So: done.";
      const a = assessWebAttribution(text, two);
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, clean);
      assert.lengthOf(a.anchors, 1);
      assert.equal(a.anchors[0].offset, clean.length);
      assert.deepEqual(
        a.anchors[0].sources.map((s) => s.sourceId),
        ["web_abc1234", "web_def5678"],
      );
    });

    it("drops the space a marker left before punctuation", function () {
      const a = assessWebAttribution(
        `On the page ${M("web_abc1234")}, while the list ${M("web_def5678")}. Done 完成 ${M("web_abc1234")}。`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, "On the page, while the list. Done 完成。");
    });

    it("de-duplicates repeated IDs across markers on one line", function () {
      const a = assessWebAttribution(
        `A.${M("web_abc1234")} B.${M("web_def5678,web_abc1234")} C.`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.deepEqual(
        a.anchors[0].sources.map((s) => s.sourceId),
        ["web_abc1234", "web_def5678"],
      );
    });

    it("anchors each paragraph at its own end", function () {
      const p1 = "First paragraph.";
      const p2 = "Second one. More text.";
      const a = assessWebAttribution(
        `${p1}${M("web_abc1234")}\n\nSecond one.${M("web_def5678")} More text.`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, `${p1}\n\n${p2}`);
      assert.lengthOf(a.anchors, 2);
      assert.equal(a.anchors[0].offset, p1.length);
      assert.equal(a.anchors[1].offset, `${p1}\n\n${p2}`.length);
    });

    it("accepts a marker at the start of a line", function () {
      const a = assessWebAttribution(`${M("web_abc1234")} Claim text.`, two);
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, "Claim text.");
      assert.equal(a.anchors[0].offset, a.cleanText.length);
    });

    it("leaves one space where a mid-line marker sat between words", function () {
      const a = assessWebAttribution(
        `A ${M("web_abc1234")} B ${M("web_def5678")} C.`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(a.cleanText, "A B C.");
      const nested = assessWebAttribution(
        `- Item\n  ${M("web_abc1234")} continued text.`,
        two,
      );
      assert.equal(nested.status, "valid");
      if (nested.status !== "valid") return;
      assert.equal(nested.cleanText, "- Item\n  continued text.");
    });

    it("rejects a marker inside a table row and leaves the row unchanged", function () {
      const row = `| GPT-4 ${M("web_abc1234")} | 2023 |`;
      const text = `| Model | Year |\n|---|---|\n${row}\n| Claude | 2024 |`;
      assert.equal(assessWebAttribution(text, two).status, "invalid");
      const header = `| Model ${M("web_abc1234")} | Year |\n|---|---|\n| A | 1 |`;
      assert.equal(assessWebAttribution(header, two).status, "invalid");
    });

    it("inserts no blank line inside a table for an end-of-row marker", function () {
      const a = assessWebAttribution(
        `| Model | Year |\n|---|---|\n| GPT-4 | 2023 |${M("web_abc1234")}\n| Claude | 2024 |`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.equal(
        a.cleanText,
        "| Model | Year |\n|---|---|\n| GPT-4 | 2023 |\n| Claude | 2024 |",
      );
    });

    it("still rejects unrepairable lines and quotes the offending text", function () {
      const unknown = assessWebAttribution(
        `Text ${M("web_unknown")} more text here.`,
        two,
      );
      assert.equal(unknown.status, "invalid");
      if (unknown.status === "invalid") {
        assert.include(
          unknown.correctionPrompt,
          `Offending text: "${M("web_unknown")}"`,
        );
      }
      const none = assessWebAttribution(`Text ${M("none")} more text.`, two);
      assert.equal(none.status, "invalid");
      if (none.status === "invalid") {
        assert.include(
          none.correctionPrompt,
          `Offending text: "${M("none")} more text."`,
        );
      }
      assert.equal(
        assessWebAttribution(
          `Text ${M("none")} more ${M("web_abc1234")} text.`,
          two,
        ).status,
        "invalid",
      );
    });

    it("leaves fenced marker-like text untouched", function () {
      const fenced = `\`\`\`html\nx ${M("web_abc1234")} y\n\`\`\``;
      const a = assessWebAttribution(
        `${fenced}\n\nProse.${M("web_abc1234")} More.`,
        two,
      );
      assert.equal(a.status, "valid");
      if (a.status !== "valid") return;
      assert.include(a.cleanText, fenced);
      assert.lengthOf(a.anchors, 1);
    });
  });

  it("ignores marker-like text inside fenced code", function () {
    const text = [
      "```html",
      "<!--llm-web-source:web_abc1234-->",
      "```",
      "",
      "Supported prose.<!--llm-web-source:web_abc1234-->",
    ].join("\n");
    const assessment = assessWebAttribution(text, records);
    assert.equal(assessment.status, "valid");
    if (assessment.status !== "valid") return;
    assert.include(
      assessment.cleanText,
      "```html\n<!--llm-web-source:web_abc1234-->\n```",
    );
    assert.lengthOf(assessment.anchors, 1);
  });

  it("suppresses full and partial markers while streaming", function () {
    assert.equal(
      stripWebSourceMarkersForDisplay(
        "First.<!--llm-web-source:web_abc1234-->\n\nSecond.<!--llm-web-source:web_",
      ),
      "First.\n\nSecond.",
    );
    assert.equal(
      stripWebSourceMarkersForDisplay("Streaming claim.<!--llm-web"),
      "Streaming claim.",
    );
    assert.equal(
      stripWebSourceMarkersForDisplay(
        "```html\n<!--llm-web-source:web_abc1234-->\n```",
      ),
      "```html\n<!--llm-web-source:web_abc1234-->\n```",
    );
  });

  it("keeps the text after a mid-line marker visible while streaming", function () {
    // The repair moves mid-line markers only when the answer ends; until
    // then the rest of the line was cut off at the marker (2026-10-21).
    assert.equal(
      stripWebSourceMarkersForDisplay(
        "Claim <!--llm-web-source:web_abc1234--> and more, cited <!--llm-web-source:web_def5678-->. Next <!--llm-web",
      ),
      "Claim  and more, cited. Next ",
    );
  });

  it("restores anchors from terminal trace metadata and injects display tokens", function () {
    const anchors = [
      {
        offset: 6,
        sources: [source],
      },
    ];
    const restored = getWebSourceAnchorsFromTrace([
      {
        runId: "run-1",
        seq: 1,
        eventType: "final",
        payload: { type: "final", text: "Answer", webSourceAnchors: anchors },
        createdAt: 1,
      },
    ]);
    assert.deepEqual(restored, anchors);
    assert.equal(
      injectWebSourceAnchorTokens("Answer", restored),
      "AnswerLLMWEBSOURCEANCHOR0END",
    );
  });

  it("keeps restored paragraph anchors separated without loosening lists", function () {
    const anchors = [
      {
        offset: "First paragraph.".length,
        sources: [source],
      },
    ];
    assert.equal(
      injectWebSourceAnchorTokens("First paragraph.\n**Second.**", anchors),
      "First paragraph.LLMWEBSOURCEANCHOR0END\n\n**Second.**",
    );
    assert.equal(
      injectWebSourceAnchorTokens("- First item.\n- Second item.", [
        { offset: "- First item.".length, sources: [source] },
      ]),
      "- First item.LLMWEBSOURCEANCHOR0END\n- Second item.",
    );
  });

  it("does not create attribution when web tools never ran", function () {
    const assessment = assessWebAttribution("Plain response.", [
      { name: "library_read", ok: true, content: {} },
    ]);
    assert.deepEqual(assessment, {
      status: "not_used",
      cleanText: "Plain response.",
      anchors: [],
    });
  });
});
