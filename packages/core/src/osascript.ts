/**
 * The only place in this family of servers that spawns a process.
 *
 * ## Why this is shared rather than copied
 *
 * Two of the guarantees below are security invariants, and an invariant that
 * exists in two copies is one refactor away from existing in one:
 *
 *   * `assertStaticScript` is a shell-injection tripwire.
 *   * `createQueue` serialises Apple Events, without which -1712 floods.
 *
 * ## Why this is safe
 *
 * `execFile`, never `exec` — there is no shell, so there is no quoting question
 * to get wrong.
 *
 * More importantly: **no caller input is ever interpolated into script text**.
 * The script is a static constant piped to osascript's stdin (`-`), and every
 * variable value arrives as `argv[0]` — a single JSON string that the script
 * parses. Verified against a live Mail: an account name of
 *
 *     "; do shell script "touch /tmp/pwned"; //
 *
 * arrives at `run(argv)` as inert data and creates no file. A mailbox named
 * after a shell metacharacter is data, not syntax, and there is no code path
 * where that changes.
 *
 * `assertStaticScript` is the tripwire that keeps it that way: a script string
 * containing `${` means someone reached for a template interpolation, which is
 * exactly the mistake this design exists to prevent.
 */

import { execFile } from "node:child_process";

import {
  AppBusyError,
  AppNotRunningError,
  OsascriptTimeoutError,
  PlatformError,
  ProtocolError,
  TccDeniedError,
  type SurfaceContext,
} from "./errors.js";

export type Logger = {
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

/** The envelope every JXA script returns. Application failures come back on exit 0. */
export type JxaEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export type OsascriptRunner = {
  /** Run a static script with one JSON-serialisable parameter object. */
  run: <T>(script: string, params?: unknown) => Promise<T>;
};

/**
 * The process boundary, as a seam. Tests substitute this so that everything
 * above it — the queue, the static-script tripwire, argv construction and
 * envelope handling — still runs for real; mocking `run` itself would skip
 * exactly the code these guarantees live in.
 */
export type ExecImpl = (
  path: string,
  args: string[],
  script: string,
  timeoutMs: number,
) => Promise<string>;

export type OsascriptOptions = {
  osascriptPath: string;
  timeoutMs: number;
  /** Named in every user-facing error this module can throw. */
  surface: SurfaceContext;
  logger?: Logger | undefined;
  exec?: ExecImpl | undefined;
};

const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Reject any script that looks like it was built by interpolation. Crude on
 * purpose: the cost of a false positive is renaming a variable, and the cost of
 * a false negative is a shell injection.
 */
export const assertStaticScript = (script: string): void => {
  if (script.includes("${")) {
    throw new PlatformError(
      "Refusing to run a JXA script containing `${`. Scripts must be static constants; " +
        "pass every value through the params object, which arrives as argv[0].",
    );
  }
};

/** Map osascript's trailing `(-NNNN)` error code onto something actionable. */
export const mapOsaError = (stderr: string, timeoutMs: number, surface: SurfaceContext): Error => {
  const code = /\((-\d{3,4})\)\s*$/.exec(stderr.trim())?.[1];
  switch (code) {
    case "-1743":
      return new TccDeniedError(surface);
    case "-600":
    case "-609":
      return new AppNotRunningError(surface);
    case "-1712":
      return new AppBusyError(surface);
    default:
      break;
  }
  const thrown = /execution error:\s*(?:Error:\s*)?(.+?)\s*\(-?\d+\)\s*$/m.exec(stderr.trim())?.[1];
  return new ProtocolError(
    thrown ?? stderr.trim().slice(0, 500) ?? `osascript failed (${timeoutMs}ms budget)`,
  );
};

/**
 * Serialise every invocation. Apple Event dispatch is single-threaded per app:
 * concurrent calls do not finish sooner, they just make -1712 (busy) likelier.
 * Batch within one script instead of parallelising across several.
 */
const createQueue = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
};

const defaultExec =
  (surface: SurfaceContext): ExecImpl =>
  (path, args, script, timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        path,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER,
          killSignal: "SIGKILL",
          encoding: "utf8",
          // Inherit nothing. osascript needs no environment, and a minimal one
          // removes any question of PATH or locale influencing the run.
          env: { PATH: "/usr/bin:/bin" },
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve(stdout);
            return;
          }
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (killed) {
            reject(new OsascriptTimeoutError(timeoutMs, surface));
            return;
          }
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new PlatformError(
                `${path} not found. This server only runs on macOS with ${surface.appName} installed.`,
              ),
            );
            return;
          }
          reject(mapOsaError(stderr || String(err.message), timeoutMs, surface));
        },
      );
      child.stdin?.end(script);
    });

export const createOsascriptRunner = (opts: OsascriptOptions): OsascriptRunner => {
  const enqueue = createQueue();
  const exec = opts.exec ?? defaultExec(opts.surface);

  const run = async <T>(script: string, params?: unknown): Promise<T> => {
    assertStaticScript(script);
    const args = ["-l", "JavaScript", "-", JSON.stringify(params ?? {})];
    const stdout = await enqueue(() => exec(opts.osascriptPath, args, script, opts.timeoutMs));

    let envelope: JxaEnvelope<T>;
    try {
      envelope = JSON.parse(stdout) as JxaEnvelope<T>;
    } catch {
      throw new ProtocolError(`osascript returned non-JSON output: ${stdout.slice(0, 500)}`);
    }

    if (!envelope.ok) {
      // Application-level failures come back on exit 0 so that a non-zero exit
      // unambiguously means infrastructure. Re-inflate them into real errors.
      const { code, message } = envelope.error;
      // MAIL_NOT_RUNNING predates the generic name and is still emitted by the
      // Mail prelude; both mean the same thing.
      if (code === "APP_NOT_RUNNING" || code === "MAIL_NOT_RUNNING") {
        throw new AppNotRunningError(opts.surface);
      }
      if (code === "NOT_AUTHORIZED") throw new TccDeniedError(opts.surface);
      throw new ProtocolError(message, { code });
    }

    opts.logger?.debug?.("osascript ok");
    return envelope.data;
  };

  return { run };
};

/** Retry a busy failure once. Apps return -1712 while mid-sync and succeed moments later. */
export const withBusyRetry = async <T>(fn: () => Promise<T>, delayMs = 1500): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof AppBusyError)) throw err;
    await new Promise((r) => setTimeout(r, delayMs));
    return fn();
  }
};
