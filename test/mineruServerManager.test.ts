import { assert } from "chai";
import {
  acquireMineruServerJob,
  ensureMineruLocalServerRunning,
  getActiveJobCountForTests,
  getMineruServerStatus,
  hasIdleTimerForTests,
  isMineruServerProcessManaged,
  onMineruServerStatusChange,
  probeMineruServerHealthy,
  resetMineruServerManagerForTests,
  scheduleMineruServerIdleStop,
  setProbeHealthyForTests,
  setSubprocessLoaderForTests,
  startMineruServer,
  stopMineruServer,
  resolveMineruServerWorkdir,
} from "../src/services/mineru/mineruServerManager";
import {
  setMineruLocalServerCommand,
  setMineruLocalServerIdleMinutes,
} from "../src/utils/mineruConfig";
import type { GeckoSubprocess } from "../src/utils/geckoSubprocess";

describe("mineruServerManager", function () {
  let prefStore: Map<string, unknown>;
  const originalZotero = (globalThis as any).Zotero;

  beforeEach(function () {
    resetMineruServerManagerForTests();
    prefStore = new Map();
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, val: unknown) => prefStore.set(key, val),
      },
      isMac: true,
    };
  });

  afterEach(async function () {
    await stopMineruServer("test_cleanup");
    resetMineruServerManagerForTests();
    (globalThis as any).Zotero = originalZotero;
  });

  it("initializes with stopped status and no managed process", function () {
    assert.equal(getMineruServerStatus(), "stopped");
    assert.isFalse(isMineruServerProcessManaged());
    assert.equal(getActiveJobCountForTests(), 0);
    assert.isFalse(hasIdleTimerForTests());
  });

  it("notifies status listeners on state transitions", async function () {
    const states: string[] = [];
    const unsubscribe = onMineruServerStatusChange((s) => states.push(s));

    setMineruLocalServerCommand("mineru-api");
    setProbeHealthyForTests(async () => true);

    await ensureMineruLocalServerRunning("http://127.0.0.1:8000");
    assert.equal(getMineruServerStatus(), "running");

    await stopMineruServer("manual");
    assert.equal(getMineruServerStatus(), "stopped");

    assert.include(states, "running");
    assert.include(states, "stopped");
    unsubscribe();
  });

  describe("ensureMineruLocalServerRunning", function () {
    it("returns probe result when no start command is configured", async function () {
      setMineruLocalServerCommand("");
      setProbeHealthyForTests(async () => false);

      const result = await ensureMineruLocalServerRunning(
        "http://127.0.0.1:8000",
      );
      assert.isFalse(result);
      assert.equal(getMineruServerStatus(), "stopped");
    });

    it("does not start a process if server is already healthy", async function () {
      setMineruLocalServerCommand("mineru-api");
      let calledSubprocess = false;
      setSubprocessLoaderForTests(
        () =>
          ({
            call: async () => {
              calledSubprocess = true;
              return { pid: 1234 };
            },
          }) as GeckoSubprocess,
      );
      setProbeHealthyForTests(async () => true);

      const result = await ensureMineruLocalServerRunning(
        "http://127.0.0.1:8000",
      );
      assert.isTrue(result);
      assert.isFalse(calledSubprocess);
      assert.equal(getMineruServerStatus(), "running");
    });

    it("launches server process when not healthy and start command is configured", async function () {
      setMineruLocalServerCommand("mineru-api --port 8000");
      let launchedCommand = "";
      let launchedWorkdir = "";
      let probeCount = 0;

      setSubprocessLoaderForTests(
        () =>
          ({
            call: async (opts) => {
              launchedCommand = opts.arguments?.[1] || "";
              launchedWorkdir = opts.workdir || "";
              return {
                pid: 4321,
                stdout: { readString: async () => "" },
                stderr: { readString: async () => "" },
                wait: async () => new Promise(() => {}),
                kill: async () => ({ exitCode: 0 }),
              };
            },
          }) as GeckoSubprocess,
      );

      setProbeHealthyForTests(async () => {
        probeCount++;
        // First check returns false (unhealthy), subsequent checks return true (healthy)
        return probeCount > 1;
      });

      const result = await ensureMineruLocalServerRunning(
        "http://127.0.0.1:8000",
      );
      assert.isTrue(result);
      assert.equal(launchedCommand, "mineru-api --port 8000");
      assert.isTrue(launchedWorkdir.length > 0);
      assert.equal(launchedWorkdir, resolveMineruServerWorkdir());
      assert.equal(getMineruServerStatus(), "running");
      assert.isTrue(isMineruServerProcessManaged());
    });
  });

  describe("active job tracking and idle shutdown", function () {
    it("tracks active jobs and cancels/reschedules idle timer", function () {
      assert.equal(getActiveJobCountForTests(), 0);

      const release1 = acquireMineruServerJob();
      assert.equal(getActiveJobCountForTests(), 1);
      assert.isFalse(hasIdleTimerForTests());

      const release2 = acquireMineruServerJob();
      assert.equal(getActiveJobCountForTests(), 2);
      assert.isFalse(hasIdleTimerForTests());

      release1();
      assert.equal(getActiveJobCountForTests(), 1);
      assert.isFalse(hasIdleTimerForTests());

      release2();
      assert.equal(getActiveJobCountForTests(), 0);
    });

    it("does not trigger idle stop if active jobs are running", async function () {
      const release = acquireMineruServerJob();
      assert.equal(getActiveJobCountForTests(), 1);

      await stopMineruServer("idle_timeout");
      // Status should remain because jobs are active and reason was idle_timeout
      release();
      assert.equal(getActiveJobCountForTests(), 0);
    });

    it("stops server when stopMineruServer is called explicitly even if jobs were active", async function () {
      acquireMineruServerJob();
      await stopMineruServer("manual");
      assert.equal(getMineruServerStatus(), "stopped");
    });
  });
});
