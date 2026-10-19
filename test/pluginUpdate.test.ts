import { assert } from "chai";
import {
  createPluginUpdateController,
  resetPluginUpdateNotesCache,
  type AvailableUpdate,
  type PluginUpdateDeps,
  type PluginUpdateState,
  type ReleaseNotes,
  decidePluginUpdateKind,
  parseRepoSlug,
  releaseNotesApiUrl,
  releasePageUrl,
} from "../src/modules/pluginUpdate";

describe("pluginUpdate", function () {
  const base = {
    runningVersion: "3.9.12",
    lastSeenVersion: "3.9.12",
    availableVersion: null,
    updating: false,
  };

  it("decides the indicator state", function () {
    assert.equal(decidePluginUpdateKind(base), "current");
    assert.equal(
      decidePluginUpdateKind({ ...base, availableVersion: "3.9.13" }),
      "available",
    );
    assert.equal(
      decidePluginUpdateKind({
        ...base,
        availableVersion: "3.9.13",
        updating: true,
      }),
      "updating",
    );
    assert.equal(
      decidePluginUpdateKind({ ...base, lastSeenVersion: "3.9.11" }),
      "updated",
    );
    assert.equal(
      decidePluginUpdateKind({
        ...base,
        lastSeenVersion: "3.9.11",
        availableVersion: "3.9.13",
      }),
      "available",
    );
    // An offered version equal to the running one is not an update.
    assert.equal(
      decidePluginUpdateKind({ ...base, availableVersion: "3.9.12" }),
      "current",
    );
  });

  it("builds release URLs from the repository URL", function () {
    const slug = parseRepoSlug(
      "git+https://github.com/yilewang/llm-for-zotero.git",
    );
    assert.deepEqual(slug, { owner: "yilewang", repo: "llm-for-zotero" });
    assert.equal(
      releaseNotesApiUrl(slug!, "3.9.12"),
      "https://api.github.com/repos/yilewang/llm-for-zotero/releases/tags/v3.9.12",
    );
    assert.equal(
      releasePageUrl(slug!, "3.9.12"),
      "https://github.com/yilewang/llm-for-zotero/releases/tag/v3.9.12",
    );
    assert.isNull(parseRepoSlug("https://example.com/x/y"));
  });

  describe("controller", function () {
    const RUNNING = "3.9.12";
    const NEXT = "3.9.13";

    function notes(version: string): ReleaseNotes {
      return { version, body: "body", publishedAt: "", htmlUrl: "u" };
    }

    function setup(overrides: Partial<PluginUpdateDeps> = {}) {
      resetPluginUpdateNotesCache();
      const calls = { check: 0, install: 0, notes: 0 };
      const onFailedHandlers: Array<() => void> = [];
      let removed = 0;
      let checkResult: () => Promise<AvailableUpdate | null> = async () => null;
      const deps: PluginUpdateDeps = {
        checkForUpdate: () => {
          calls.check++;
          return checkResult();
        },
        installUpdate: (_update, onFailed) => {
          calls.install++;
          onFailedHandlers.push(onFailed);
          return () => {
            removed++;
          };
        },
        fetchReleaseNotes: async (version) => {
          calls.notes++;
          return notes(version);
        },
        ...overrides,
      };
      const timers = { set: 0, cleared: 0 };
      const controller = createPluginUpdateController({
        getDeps: () => deps,
        readLastSeen: () => RUNNING,
        writeLastSeen: () => {},
        isReplyInFlight: () => false,
        setInterval: () => {
          timers.set++;
          return "timer";
        },
        clearInterval: () => {
          timers.cleared++;
        },
        runningVersion: RUNNING,
      });
      return {
        controller,
        calls,
        timers,
        onFailedHandlers,
        removed: () => removed,
        setCheck: (fn: () => Promise<AvailableUpdate | null>) => {
          checkResult = fn;
        },
      };
    }

    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

    it("caches release notes per version and never caches a failure", async function () {
      let fail = true;
      const t = setup({
        fetchReleaseNotes: async (version) => {
          t.calls.notes++;
          if (fail) throw new Error("offline");
          return notes(version);
        },
      });
      assert.equal((await t.controller.loadNotes("1.0.0")).status, "failed");
      fail = false;
      assert.equal((await t.controller.loadNotes("1.0.0")).status, "ready");
      assert.equal((await t.controller.loadNotes("1.0.0")).status, "ready");
      assert.equal(t.calls.notes, 2, "the failure was not cached");
      await t.controller.loadNotes("2.0.0");
      assert.equal(t.calls.notes, 3, "another version is fetched separately");
    });

    it("runs one check at a time", async function () {
      const t = setup();
      let release: (value: AvailableUpdate | null) => void = () => {};
      t.setCheck(
        () =>
          new Promise<AvailableUpdate | null>((resolve) => {
            release = resolve;
          }),
      );
      const first = t.controller.check();
      const second = t.controller.check();
      assert.equal(t.calls.check, 1);
      release({ version: NEXT });
      await Promise.all([first, second]);
      assert.equal(t.controller.getState().kind, "available");
      t.setCheck(async () => null);
      await t.controller.check();
      assert.equal(t.calls.check, 2, "a finished check lets the next one run");
    });

    it("dispose clears the timer and the listeners", async function () {
      const t = setup();
      const states: PluginUpdateState[] = [];
      t.controller.subscribe((state) => states.push(state));
      t.setCheck(async () => ({ version: NEXT }));
      t.controller.start();
      await flush();
      assert.equal(t.timers.set, 1);
      t.controller.applyUpdate();
      const seen = states.length;
      t.controller.dispose();
      assert.equal(t.timers.cleared, 1);
      assert.equal(t.removed(), 1, "the install listeners were removed");
      t.onFailedHandlers[0]();
      await t.controller.check();
      assert.equal(states.length, seen, "no listener fires after dispose");
    });

    it("a failed install clears the update, checks again, and offers a retry", async function () {
      const t = setup();
      t.setCheck(async () => ({ version: NEXT, handle: "install-1" }));
      await t.controller.check();
      t.controller.applyUpdate();
      assert.equal(t.controller.getState().kind, "updating");
      assert.equal(t.calls.install, 1);

      t.setCheck(async () => ({ version: NEXT, handle: "install-2" }));
      t.onFailedHandlers[0]();
      assert.equal(t.removed(), 1);
      await flush();
      assert.equal(t.calls.check, 2, "the failure triggers a fresh check");
      const state = t.controller.getState();
      assert.equal(state.kind, "available");
      assert.isTrue(state.installFailed);

      t.controller.applyUpdate();
      assert.equal(t.calls.install, 2);
      assert.isFalse(t.controller.getState().installFailed);
    });

    it("drops the failed flag when the re-check finds no update", async function () {
      const t = setup();
      t.setCheck(async () => ({ version: NEXT }));
      await t.controller.check();
      t.controller.applyUpdate();
      t.setCheck(async () => null);
      t.onFailedHandlers[0]();
      await flush();
      const state = t.controller.getState();
      assert.equal(state.kind, "current");
      assert.isFalse(state.installFailed);
    });
  });
});
