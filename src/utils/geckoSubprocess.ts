/**
 * Minimal view of Firefox's Subprocess module, the only way a Zotero plugin
 * can start a program on the user's computer.
 */
export type GeckoSubprocessPipe = {
  readString?: () => Promise<string>;
  write?: (data: string) => Promise<number>;
  close?: (force?: boolean) => Promise<void>;
};

export type GeckoSubprocessProcess = {
  pid?: number;
  stdin?: GeckoSubprocessPipe;
  stdout?: GeckoSubprocessPipe;
  stderr?: GeckoSubprocessPipe;
  wait?: () => Promise<{ exitCode?: number }>;
  kill?: (timeoutMs?: number) => Promise<{ exitCode?: number }>;
};

export type GeckoSubprocessCallOptions = {
  command: string;
  arguments?: string[];
  environment?: Record<string, string>;
  environmentAppend?: boolean;
  workdir?: string;
  stderr?: "ignore" | "stdout" | "pipe";
};

export type GeckoSubprocess = {
  call: (
    options: GeckoSubprocessCallOptions,
  ) => Promise<GeckoSubprocessProcess>;
};

export function loadGeckoSubprocess(): GeckoSubprocess {
  const CU = (globalThis as any).ChromeUtils;
  let Subprocess: any;
  if (CU?.importESModule) {
    try {
      const mod = CU.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
      );
      Subprocess = mod.Subprocess || mod.default || mod;
    } catch {
      /* fall back to the legacy module */
    }
  }
  if (!Subprocess?.call && CU?.import) {
    try {
      const mod = CU.import("resource://gre/modules/Subprocess.jsm");
      Subprocess = mod.Subprocess || mod;
    } catch {
      /* reported below */
    }
  }
  if (!Subprocess?.call) {
    throw new Error(
      "Subprocess module not available in this Zotero environment",
    );
  }
  return Subprocess as GeckoSubprocess;
}

/** Reads a pipe to its end. Read errors end the read. */
export async function readGeckoSubprocessPipe(
  pipe: GeckoSubprocessPipe | undefined,
): Promise<string> {
  let out = "";
  try {
    while (pipe?.readString) {
      const chunk = await pipe.readString();
      if (!chunk) break;
      out += chunk;
    }
  } catch {
    /* the process went away */
  }
  return out;
}

/** Runs a short command and returns its output, or null when it fails. */
export async function runGeckoSubprocessForOutput(
  Subprocess: GeckoSubprocess,
  options: GeckoSubprocessCallOptions,
): Promise<string | null> {
  try {
    const proc = await Subprocess.call({ stderr: "stdout", ...options });
    const [output, result] = await Promise.all([
      readGeckoSubprocessPipe(proc.stdout),
      proc.wait?.() ?? Promise.resolve({ exitCode: 0 }),
    ]);
    if (typeof result?.exitCode === "number" && result.exitCode !== 0) {
      return null;
    }
    return output;
  } catch {
    return null;
  }
}
