import { appLogger } from "../../core/logging";
import { registerAppQuitBlocker } from "../../utils/appQuitBlocker";
import {
  loadGeckoSubprocess,
  runGeckoSubprocessForOutput,
  type GeckoSubprocess,
  type GeckoSubprocessProcess,
  type GeckoSubprocessPipe,
} from "../../utils/geckoSubprocess";
import { getRuntimePlatformInfo } from "../../utils/runtimePlatform";
import {
  getMineruLocalApiBase,
  getMineruLocalServerCommand,
  getMineruLocalServerIdleMinutes,
} from "../../utils/mineruConfig";
import { t } from "../../utils/i18n";

export type MineruServerState = "stopped" | "starting" | "running" | "stopping";

export function resolveMineruServerWorkdir(): string {
  const zotero = (globalThis as any).Zotero;
  const zoteroTemp = zotero?.getTempDirectory?.()?.path?.trim();
  if (zoteroTemp) return zoteroTemp;

  const pathUtils = (globalThis as any).PathUtils;
  const tempDir = pathUtils?.tempDir?.trim();
  if (tempDir) return tempDir;

  const homeDir = pathUtils?.homeDir?.trim();
  if (homeDir) return homeDir;

  if (typeof process !== "undefined" && process.env) {
    const tmp = process.env.TMPDIR || process.env.TEMP || process.env.TMP;
    if (tmp) return tmp;
  }

  const platform = getRuntimePlatformInfo().platform;
  return platform === "windows" ? "C:\\Windows\\Temp" : "/tmp";
}

/** Extract the TCP port from a base URL like http://127.0.0.1:8000. */
export function extractPortFromBaseUrl(baseUrl: string): number | null {
  try {
    const port = new URL(baseUrl).port;
    if (port) return Number.parseInt(port, 10);
    const protocol = new URL(baseUrl).protocol;
    if (protocol === "https:") return 443;
    if (protocol === "http:") return 80;
  } catch {
    /* invalid URL */
  }
  return null;
}

/**
 * List PIDs listening on a TCP port. Returns empty on failure — callers must
 * treat "unknown" as "do not kill".
 */
export async function listListenerPidsOnPort(
  port: number,
  Subprocess: GeckoSubprocess,
): Promise<number[]> {
  const platform = getRuntimePlatformInfo();
  const command =
    platform.platform === "windows"
      ? `netstat -ano | findstr "LISTENING" | findstr ":${port}"`
      : `lsof -ti tcp:${port} -sTCP:LISTEN`;
  const output = await runGeckoSubprocessForOutput(
    Subprocess,
    {
      command: platform.shellPath,
      arguments: [platform.shellFlag, command],
    },
    5000,
  );
  if (!output) return [];
  return output
    .split(/\s+/)
    .map((token) => Number.parseInt(token, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
}

/** Kill the given PIDs, ignoring individual failures. */
async function killPids(
  pids: number[],
  Subprocess: GeckoSubprocess,
): Promise<void> {
  if (!pids.length) return;
  const platform = getRuntimePlatformInfo();
  const command =
    platform.platform === "windows"
      ? `taskkill /F ${pids.map((pid) => `/PID ${pid}`).join(" ")}`
      : `kill -9 ${pids.join(" ")}`;
  await runGeckoSubprocessForOutput(
    Subprocess,
    {
      command: platform.shellPath,
      arguments: [platform.shellFlag, command],
    },
    5000,
  );
  appLogger.debug(`[MinerU server] killed listener PIDs: ${pids.join(", ")}`);
}

type StatusListener = (state: MineruServerState) => void;

const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_PROBE_INTERVAL_MS = 500;

let managedProcess: GeckoSubprocessProcess | null = null;
let managedListenerPort: number | null = null;
let currentStatus: MineruServerState = "stopped";
let activeJobCount = 0;
let idleTimer: any = null;
let inFlightStartPromise: Promise<boolean> | null = null;
const statusListeners = new Set<StatusListener>();

// Test overrides
let subprocessLoaderOverride: (() => GeckoSubprocess) | null = null;
let probeHealthyOverride:
  | ((baseUrl: string, timeoutMs?: number) => Promise<boolean>)
  | null = null;

function getSubprocess(): GeckoSubprocess {
  if (subprocessLoaderOverride) return subprocessLoaderOverride();
  return loadGeckoSubprocess();
}

function notifyStatusChange(): void {
  for (const listener of statusListeners) {
    try {
      listener(currentStatus);
    } catch (err) {
      appLogger.debug("MinerU server status listener error", err);
    }
  }
}

function setServerStatus(newStatus: MineruServerState): void {
  if (currentStatus !== newStatus) {
    currentStatus = newStatus;
    notifyStatusChange();
  }
}

/** Check if a local MinerU server is healthy and responding. */
export async function probeMineruServerHealthy(
  baseUrl = getMineruLocalApiBase(),
  timeoutMs = 2000,
): Promise<boolean> {
  if (probeHealthyOverride) {
    return probeHealthyOverride(baseUrl, timeoutMs);
  }
  try {
    const fetchFn =
      (globalThis as any).fetch ??
      (globalThis as any).ztoolkit?.getGlobal("fetch");
    if (!fetchFn) return false;
    const base = baseUrl.replace(/\/+$/, "");
    const AbortCtrl =
      (globalThis as any).AbortController ??
      (globalThis as any).ztoolkit?.getGlobal("AbortController");
    const ctrl = AbortCtrl ? new AbortCtrl() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const resp = await fetchFn(`${base}/v1/health`, {
        method: "GET",
        signal: ctrl?.signal,
      });
      if (timer) clearTimeout(timer);
      if (resp.status >= 200 && resp.status < 300) return true;
      if (resp.status === 404 || resp.status === 405) {
        // Probe legacy health endpoint
        const legacyResp = await fetchFn(`${base}/health`, {
          method: "GET",
        }).catch(() => null);
        if (legacyResp && legacyResp.status >= 200 && legacyResp.status < 300) {
          return true;
        }
      }
    } catch {
      if (timer) clearTimeout(timer);
      return false;
    }
  } catch {
    return false;
  }
  return false;
}

export function getMineruServerStatus(): MineruServerState {
  return currentStatus;
}

export function isMineruServerProcessManaged(): boolean {
  return managedProcess !== null;
}

export function onMineruServerStatusChange(
  listener: StatusListener,
): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/**
 * Schedule stopping the server after `idleMinutes` of inactivity.
 */
export function scheduleMineruServerIdleStop(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!managedProcess || currentStatus !== "running" || activeJobCount > 0) {
    return;
  }
  const idleMinutes = getMineruLocalServerIdleMinutes();
  if (idleMinutes <= 0) return;

  const timeoutMs = idleMinutes * 60 * 1000;
  appLogger.debug(
    `[MinerU server] scheduling idle shutdown in ${idleMinutes} minutes (${timeoutMs}ms)`,
  );
  idleTimer = setTimeout(() => {
    appLogger.info(
      `[MinerU server] idle timeout (${idleMinutes}m) reached; stopping server to free memory/VRAM`,
    );
    void stopMineruServer("idle_timeout");
  }, timeoutMs);
}

/**
 * Acquire a lease for an active parse job. Prevents idle shutdown while jobs run.
 * Returns a release callback to call when the job completes.
 */
export function acquireMineruServerJob(): () => void {
  activeJobCount++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeJobCount = Math.max(0, activeJobCount - 1);
    if (activeJobCount === 0) {
      scheduleMineruServerIdleStop();
    }
  };
}

/**
 * Start the local MinerU server using the configured start command.
 */
export async function startMineruServer(
  baseUrl = getMineruLocalApiBase(),
  report?: (stage: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (currentStatus === "running") return true;
  if (inFlightStartPromise) return inFlightStartPromise;

  const command = getMineruLocalServerCommand();
  if (!command) {
    throw new Error(t("No MinerU server start command configured."));
  }

  inFlightStartPromise = (async () => {
    try {
      // 1. Check if an external or previously launched instance is already healthy
      report?.(t("Checking local MinerU server…"));
      const isAlreadyHealthy = await probeMineruServerHealthy(baseUrl, 1500);
      if (isAlreadyHealthy) {
        setServerStatus("running");
        scheduleMineruServerIdleStop();
        return true;
      }

      if (signal?.aborted) return false;

      // 2. Launch process through system shell
      setServerStatus("starting");
      report?.(t("Starting local MinerU server…"));
      const Subprocess = getSubprocess();
      const platform = getRuntimePlatformInfo();
      const workdir = resolveMineruServerWorkdir();

      let proc: GeckoSubprocessProcess;
      try {
        proc = await Subprocess.call({
          command: platform.shellPath,
          arguments: [platform.shellFlag, command],
          workdir,
          stderr: "pipe",
        });
      } catch (launchError) {
        setServerStatus("stopped");
        throw new Error(
          `Failed to launch MinerU server: ${(launchError as Error).message}`,
        );
      }

      managedProcess = proc;
      managedListenerPort = extractPortFromBaseUrl(baseUrl);
      let processExited = false;
      const recentStderr: string[] = [];

      const drain = async (pipe?: GeckoSubprocessPipe, isStderr = false) => {
        if (!pipe?.readString) return;
        try {
          while (true) {
            const chunk = await pipe.readString();
            if (!chunk) break;
            if (isStderr) {
              const lines = chunk.split("\n").filter(Boolean);
              recentStderr.push(...lines);
              if (recentStderr.length > 30) {
                recentStderr.splice(0, recentStderr.length - 30);
              }
            }
            appLogger.debug(
              `[MinerU server ${isStderr ? "stderr" : "stdout"}] ${chunk.trim()}`,
            );
          }
        } catch {
          /* pipe closed */
        }
      };

      void drain(proc.stdout, false);
      void drain(proc.stderr, true);

      proc
        .wait?.()
        .then(() => {
          processExited = true;
          if (managedProcess === proc) {
            managedProcess = null;
            managedListenerPort = null;
            if (currentStatus === "starting" || currentStatus === "running") {
              setServerStatus("stopped");
            }
          }
        })
        .catch(() => undefined);

      // 3. Poll for readiness
      const startTime = Date.now();
      while (Date.now() - startTime < SERVER_STARTUP_TIMEOUT_MS) {
        if (signal?.aborted) {
          await stopMineruServer("cancelled");
          return false;
        }
        if (processExited) {
          managedProcess = null;
          managedListenerPort = null;
          setServerStatus("stopped");
          let errorMsg =
            recentStderr.slice(-5).join("; ") || "Process exited immediately";
          if (/address already in use|errno 48/i.test(errorMsg)) {
            errorMsg = `${t("Port 8000 is already in use by another process. Stop the existing process first.")} (${errorMsg})`;
          }
          throw new Error(`Local MinerU server failed to start: ${errorMsg}`);
        }
        await new Promise((resolve) =>
          setTimeout(resolve, SERVER_PROBE_INTERVAL_MS),
        );
        const ready = await probeMineruServerHealthy(baseUrl, 1000);
        if (ready) {
          setServerStatus("running");
          report?.(t("Local MinerU server is ready."));
          scheduleMineruServerIdleStop();
          return true;
        }
      }

      // 4. Timed out
      await stopMineruServer("startup_timeout");
      const errorMsg =
        recentStderr.slice(-5).join("; ") ||
        "Timed out waiting for server health check";
      throw new Error(`Local MinerU server startup timed out: ${errorMsg}`);
    } finally {
      inFlightStartPromise = null;
    }
  })();

  return inFlightStartPromise;
}

/**
 * Ensure the server is running if a start command is configured.
 */
export async function ensureMineruLocalServerRunning(
  baseUrl = getMineruLocalApiBase(),
  report?: (stage: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const command = getMineruLocalServerCommand();
  if (!command) {
    // No command provided; check if external server is reachable
    return probeMineruServerHealthy(baseUrl, 1500);
  }
  return startMineruServer(baseUrl, report, signal);
}

/**
 * Stop the managed server process, including every descendant that survived
 * the shell wrapper (uv tool run spawns uv -> python; Gecko's kill only
 * reaches the shell). The real listener is found via the port we started and
 * killed last, after a graceful shell kill.
 */
export async function stopMineruServer(reason = "manual"): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (reason === "idle_timeout" && activeJobCount > 0) {
    return;
  }
  if (!managedProcess && !managedListenerPort && currentStatus === "stopped") {
    return;
  }
  setServerStatus("stopping");
  const proc = managedProcess;
  const port = managedListenerPort;
  managedProcess = null;
  managedListenerPort = null;
  if (proc) {
    try {
      await proc.kill?.(2000);
    } catch (err) {
      appLogger.debug("[MinerU server] shell kill error (can be ignored)", err);
    }
  }
  // Kill whatever still listens on the port we launched — this is the actual
  // python/uv descendant the shell kill cannot reach.
  if (port !== null) {
    try {
      const Subprocess = getSubprocess();
      const survivors = await listListenerPidsOnPort(port, Subprocess);
      if (survivors.length) {
        await killPids(survivors, Subprocess);
      }
    } catch (err) {
      appLogger.debug(
        "[MinerU server] port cleanup error (can be ignored)",
        err,
      );
    }
  }
  setServerStatus("stopped");
  appLogger.info(`[MinerU server] stopped (${reason})`);
}

// Register application quit blocker to cleanly terminate spawned process
registerAppQuitBlocker("mineru-local-server", async () => {
  if (managedProcess) {
    await stopMineruServer("app_quit");
  }
});

/** Test helpers */
export function resetMineruServerManagerForTests(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  managedProcess = null;
  managedListenerPort = null;
  currentStatus = "stopped";
  activeJobCount = 0;
  inFlightStartPromise = null;
  statusListeners.clear();
  subprocessLoaderOverride = null;
  probeHealthyOverride = null;
}

export function setSubprocessLoaderForTests(
  loader: (() => GeckoSubprocess) | null,
): void {
  subprocessLoaderOverride = loader;
}

export function setProbeHealthyForTests(
  fn: ((baseUrl: string, timeoutMs?: number) => Promise<boolean>) | null,
): void {
  probeHealthyOverride = fn;
}

export function getActiveJobCountForTests(): number {
  return activeJobCount;
}

export function hasIdleTimerForTests(): boolean {
  return idleTimer !== null;
}
