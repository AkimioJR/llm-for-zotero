import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function diagnosticsMessage(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Add past conversation. The past chat is seeded in the upstream system:
 * seeding a Codex or Claude Code chat needs that system's panel, which the
 * harness cannot mount without a live bridge.
 */
describe("workflow: add past conversation", function () {
  this.timeout(60000);

  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    while (fixtures.length) {
      const fixture = fixtures.pop();
      if (fixture) await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("lists other chats, attaches one as a chip, sends it, clears the composer, and keeps it after reload", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Workflow Past Conversation Paper",
      pdfTitle: "Workflow Past Conversation PDF",
    });
    fixtures.push(fixture);
    const panel = await api.renderPanelForItem(fixture.parentItemId);

    // A past chat (it has one user turn), then a new current chat that also
    // has a turn: only the past chat may be offered.
    const past = await api.seedPanelStoredUserMessage(
      panel.panelId,
      "workflow past conversation marker",
    );
    const pastKey = past.conversationKey;
    assert.isOk(pastKey, diagnosticsMessage(past));
    const current = await api.startNewPanelConversation(panel.panelId);
    assert.notEqual(current.conversationKey, pastKey);
    await api.seedPanelStoredUserMessage(
      panel.panelId,
      "workflow current conversation marker",
    );

    const picker = await api.pickPastConversationInPanel(panel.panelId, {
      rowIndex: 0,
    });
    assert.isTrue(picker.slashItemVisible, diagnosticsMessage(picker));
    assert.lengthOf(
      picker.rowTitles,
      1,
      `only the past chat is listed, not the current one: ${diagnosticsMessage(picker)}`,
    );
    assert.deepEqual(picker.rowLabels, ["Chat"], diagnosticsMessage(picker));
    assert.isTrue(picker.picked, diagnosticsMessage(picker));

    const attached = await api.getDiagnostics(panel.panelId);
    assert.lengthOf(
      attached.composerAttachedConversationLabels,
      1,
      diagnosticsMessage(attached),
    );
    assert.match(
      attached.composerAttachedConversationLabels[0]!,
      / · Chat$/,
      diagnosticsMessage(attached),
    );

    // The send hands the reference to sendQuestion and empties the composer.
    const sent = await api.ask(panel.panelId, "question with a past chat");
    assert.lengthOf(
      sent.attachedConversations || [],
      1,
      diagnosticsMessage(sent),
    );
    assert.equal(sent.attachedConversations![0]!.conversationKey, pastKey);
    assert.equal(sent.attachedConversations![0]!.system, "upstream");
    const afterSend = await api.getDiagnostics(panel.panelId);
    assert.deepEqual(
      afterSend.composerAttachedConversationLabels,
      [],
      diagnosticsMessage(afterSend),
    );

    // The intercepted send stores nothing, so store the user message the
    // real send would have stored, with the field from the send options.
    await api.seedPanelStoredUserMessage(
      panel.panelId,
      "question with a past chat",
      { attachedConversations: sent.attachedConversations },
    );
    const shown = await api.getDiagnostics(panel.panelId);
    assert.include(
      shown.sentContextBadgeLabels,
      "Past chat",
      diagnosticsMessage(shown),
    );
    assert.lengthOf(shown.sentContextItemLabels, 1, diagnosticsMessage(shown));
    assert.match(shown.sentContextItemLabels[0]!, / · Chat$/);

    // After a reload the stored message still carries the chip.
    const startup = await api.renderStartupPanelForItem(fixture.parentItemId);
    const reloaded = await api.getDiagnostics(startup.panelId);
    assert.include(
      reloaded.sentContextBadgeLabels,
      "Past chat",
      diagnosticsMessage(reloaded),
    );
    assert.deepEqual(
      reloaded.composerAttachedConversationLabels,
      [],
      "loading a chat must not put past chat chips in the composer",
    );
  });
});
