import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestStandalonePinnedPapers,
  WorkflowTestStandaloneSidePanelDiagnostics,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";

/**
 * The standalone window switches as a whole with the paper: the main chat,
 * the History pane and the side panel's tabs all belong to the paper shown.
 * Each paper keeps its side panel tabs while another is shown. A pinned
 * paper is listed under "Pinned papers" in the sidebar; clicking it shows
 * the paper again, in the window and in Zotero, as it was left. Its row
 * shows a dot while its chat answers and after, until the paper is seen.
 *
 * Everything runs in the real window; sends go through the real composers
 * and send flow, and only the network is scripted (a held fake provider).
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-standalone-pinned-papers.invalid/v1";
const GROUP_ID = "workflow-pinned-papers-group";
const ENTRY_ID = "workflow-pinned-papers-model";
const MODEL = "pinned-papers-model";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "lastUsedRuntimeMode",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "outputTokenAutoMigrationNoticePending",
  "standalonePinnedPapers",
];

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

describe("workflow: standalone pinned papers", function () {
  this.timeout(240_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];

  async function until(
    check: () => boolean | Promise<boolean>,
    describe: () => string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await Zotero.Promise.delay(50);
    }
    if (await check()) return;
    assert.fail(describe());
  }

  async function waitForSide(
    check: (state: WorkflowTestStandaloneSidePanelDiagnostics) => boolean,
    label: string,
    timeoutMs = 10_000,
  ): Promise<WorkflowTestStandaloneSidePanelDiagnostics> {
    let state = await api.getStandaloneSidePanelDiagnostics();
    await until(
      async () => {
        state = await api.getStandaloneSidePanelDiagnostics();
        return check(state);
      },
      () => `${label}: ${JSON.stringify(state)}`,
      timeoutMs,
    );
    return state;
  }

  async function waitForPins(
    check: (state: WorkflowTestStandalonePinnedPapers) => boolean,
    label: string,
    timeoutMs = 10_000,
  ): Promise<WorkflowTestStandalonePinnedPapers> {
    let state = await api.listStandalonePinnedPapers();
    await until(
      async () => {
        state = await api.listStandalonePinnedPapers();
        return check(state);
      },
      () => `${label}: ${JSON.stringify(state)}`,
      timeoutMs,
    );
    return state;
  }

  const savedPins = (): number[] =>
    JSON.parse(
      String(
        Zotero.Prefs.get(PREF_PREFIX + "standalonePinnedPapers", true) || "[]",
      ),
    );

  const selectedZoteroItemID = (): number => {
    const pane = Zotero.getActiveZoteroPane?.();
    const tabs = Zotero.getMainWindow?.()?.Zotero_Tabs;
    if (tabs && tabs.selectedID !== "zotero-pane") return 0;
    return Number(pane?.getSelectedItems?.()[0]?.id || 0);
  };

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = getWorkflowTestApi();
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    provider = installHeldChatProvider(API_BASE);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedRuntimeMode", "chat", true);
    Zotero.Prefs.set(PREF_PREFIX + "standalonePinnedPapers", "", true);
    setModelProviderGroups([
      {
        id: GROUP_ID,
        authMode: "api_key",
        apiBase: API_BASE,
        apiKey: "workflow-dummy-key",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: ENTRY_ID,
            model: MODEL,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
    ] as any);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_ID, true);
    assert.isOk(getModelEntryById(ENTRY_ID), "the fake model is configured");
  });

  after(async function () {
    provider?.restore();
    await api.closeStandalone();
    await api.reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  beforeEach(async function () {
    await api.reset();
    api.enableLiveAgentSending();
  });

  afterEach(async function () {
    provider.failOpenStreams("workflow case ended");
    await Zotero.Promise.delay(300);
    await api.closeStandalone();
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    Zotero.Prefs.set(PREF_PREFIX + "standalonePinnedPapers", "", true);
    await api.reset();
  });

  it("keeps each paper's side panel, and returns to a pinned paper as it was left", async function () {
    const paperA = await api.createPaperWithPdfFixture({
      title: "Pinned papers workflow paper A",
      pdfTitle: "Pinned papers workflow paper A PDF",
      pages: ["Pinned papers workflow paper A: one short page of text."],
    });
    fixtures.push(paperA);
    const paperB = await api.createPaperWithPdfFixture({
      title: "Pinned papers workflow paper B",
      pdfTitle: "Pinned papers workflow paper B PDF",
      pages: ["Pinned papers workflow paper B: one short page of text."],
    });
    fixtures.push(paperB);
    const A = paperA.parentItemId;
    const B = paperB.parentItemId;

    await api.openStandaloneForItem(A);
    let pins = await api.listStandalonePinnedPapers();
    assert.isTrue(pins.pinButton.visible, "a paper chat offers the pin");
    assert.isFalse(pins.pinButton.pressed);
    assert.equal(pins.pinButton.label, "Pin this paper");
    assert.isTrue(pins.regionVisible, "Pinned papers always shows");
    assert.isFalse(pins.clearVisible, "nothing pinned: no Clear");

    // Paper A: a side chat with one answer.
    await api.clickStandaloneSidePanelControl("toggle");
    let side = await api.clickStandaloneSidePanelControl("new-sidechat");
    assert.equal(side.view, "sidechat");
    const SIDE_Q = "pinned-papers-side-question";
    const SIDE_A = "pinned-papers-side-answer";
    await api.sendStandaloneSideChat(SIDE_Q);
    {
      const stream = await provider.waitForStream(SIDE_Q);
      stream.push(SIDE_A);
      stream.finish();
    }
    side = await waitForSide(
      (state) =>
        Boolean(
          state.sideChat?.messageTexts.some((text) => text.includes(SIDE_A)),
        ),
      "paper A's side chat answers",
      30_000,
    );
    const sideKeyA = side.sideChat!.conversationKey;
    const sideTabA = side.activeTab;

    // Pin paper A.
    pins = await api.clickStandalonePinButton();
    assert.isTrue(pins.pinButton.pressed);
    assert.equal(pins.pinButton.label, "Unpin this paper");
    assert.isTrue(pins.regionVisible);
    assert.isTrue(pins.clearVisible);
    assert.deepEqual(
      pins.rows.map((row) => [row.paperItemId, row.active]),
      [[A, true]],
    );
    assert.isNotEmpty(pins.rows[0].label);
    assert.deepEqual(savedPins(), [A], "the pin is saved");

    // Paper B: the whole window switches. B has no side panel of its own.
    let main = await api.notifyStandaloneItemChanged(B);
    assert.equal(main.basePaperItemId, B);
    side = await waitForSide(
      (state) => !state.open,
      "paper B starts with its own, closed side panel",
    );
    pins = await api.listStandalonePinnedPapers();
    assert.isFalse(pins.pinButton.pressed, "paper B is not pinned");
    assert.deepEqual(
      pins.rows.map((row) => [row.paperItemId, row.active]),
      [[A, false]],
    );
    side = await api.clickStandaloneSidePanelControl("toggle");
    assert.equal(side.view, "newtab");
    assert.deepEqual(side.tabs, [], "B's panel holds none of A's tabs");

    // Clicking the pinned row shows A again, as it was left: its side chat
    // on the same key with its answer, and A selected in Zotero.
    main = await api.clickStandalonePinnedPaper(A);
    assert.equal(main.basePaperItemId, A);
    side = await waitForSide(
      (state) =>
        state.open &&
        state.activeTab === sideTabA &&
        state.sideChat?.conversationKey === sideKeyA,
      "paper A's side chat comes back",
    );
    assert.lengthOf(side.tabs, 1);
    assert.isTrue(
      side.sideChat!.messageTexts.some((text) => text.includes(SIDE_A)),
      "the side chat keeps its answer",
    );
    assert.lengthOf(side.sideChat!.contextNotes, 0, "no context switch note");
    await until(
      () => selectedZoteroItemID() === A,
      () => `Zotero selects paper A: ${selectedZoteroItemID()}`,
    );

    // Paper B's own panel (open, New tab) comes back with B too.
    await api.notifyStandaloneItemChanged(B);
    side = await waitForSide(
      (state) => state.open && state.view === "newtab" && !state.tabs.length,
      "paper B's own panel comes back",
    );

    // An answer that A's main chat writes while B is shown: a dot that
    // pulses while it writes and stays until A is seen again.
    await api.clickStandalonePinnedPaper(A);
    const MAIN_Q = "pinned-papers-main-question";
    await api.askStandalone(MAIN_Q);
    const mainStream = await provider.waitForStream(MAIN_Q);
    await api.notifyStandaloneItemChanged(B);
    pins = await waitForPins(
      (state) => state.rows[0]?.dot === "writing",
      "A's row shows it is writing",
    );
    mainStream.push("pinned-papers-main-answer");
    mainStream.finish();
    pins = await waitForPins(
      (state) => state.rows[0]?.dot === "ready",
      "A's row shows the answer waits",
      30_000,
    );
    await api.clickStandalonePinnedPaper(A);
    pins = await waitForPins(
      (state) => state.rows[0]?.dot === null && state.rows[0]?.active,
      "seeing A clears its dot",
    );
    // The section lines up with the history list below it.
    pins = await waitForPins(
      (state) => state.edges.historyLabel !== null,
      "A's chat is listed in the history",
    );
    assert.equal(pins.edges.pinnedLabel, pins.edges.historyLabel);
    assert.equal(pins.edges.pinnedRow, pins.edges.historyRow);

    // Unpin from the row: the list empties (its label stays) and the pref
    // follows.
    await api.clickStandalonePinnedPaper(A, "unpin");
    pins = await waitForPins(
      (state) => state.regionVisible && !state.rows.length,
      "unpinned, the list is empty",
    );
    assert.isFalse(pins.clearVisible);
    assert.isFalse(pins.pinButton.pressed);
    assert.deepEqual(savedPins(), []);

    // "Clear" unpins every paper in one click.
    await api.clickStandalonePinButton();
    await api.notifyStandaloneItemChanged(B);
    pins = await api.clickStandalonePinButton();
    assert.deepEqual(
      pins.rows.map((row) => row.paperItemId),
      [A, B],
    );
    pins = await api.clickStandalonePinnedClear();
    assert.lengthOf(pins.rows, 0);
    assert.isFalse(pins.clearVisible);
    assert.isFalse(pins.pinButton.pressed);
    assert.deepEqual(savedPins(), []);
  });

  it("gives Library chat its own side panel", async function () {
    const paper = await api.createPaperWithPdfFixture({
      title: "Pinned papers workflow library paper",
      pdfTitle: "Pinned papers workflow library paper PDF",
      pages: ["Pinned papers workflow library paper: one short page."],
    });
    fixtures.push(paper);
    await api.openStandaloneForItem(paper.parentItemId);
    await api.clickStandaloneSidePanelControl("toggle");
    let side = await api.clickStandaloneSidePanelControl("new-sidechat");
    const paperSideKey = side.sideChat!.conversationKey;

    await api.clickStandaloneTab("open");
    side = await waitForSide((state) => !state.open, "Library chat: closed");
    const pins = await api.listStandalonePinnedPapers();
    assert.isFalse(pins.pinButton.visible, "Library chat has no pin");

    await api.clickStandaloneTab("paper");
    side = await waitForSide(
      (state) => state.open && state.sideChat?.conversationKey === paperSideKey,
      "Paper chat: the paper's side chat is back on its own key",
    );
    assert.lengthOf(side.tabs, 1);
  });
});
