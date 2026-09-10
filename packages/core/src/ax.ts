import { connect, type Socket } from "node:net";

import { AppleAutomationError, type SurfaceContext } from "./errors.js";

/**
 * Borrowing the app's Accessibility driver.
 *
 * ## Why this exists at all
 *
 * `AXUIElementCopyAttributeValue` reads an attribute in **0.202 ms**. Reaching
 * the same attribute through `osascript` + JXA + System Events costs **47.4 ms**
 * — a 234x difference that is entirely transport, measured both ways on one
 * machine in `docs/desktop.md`. Every Accessibility number this repo recorded
 * before that document was taken through System Events, which is why the lane
 * was closed three times on figures that were pricing the wrong thing.
 *
 * The native call cannot be made from here. Node has no binding for it, and
 * more importantly the grant does not belong to node: TCC attaches
 * Accessibility to the **responsible GUI ancestor**, so it is Cupertino.app
 * that holds it. Hence a channel rather than a port — the app already runs the
 * driver, and `ServerHost` will lend it for one bundle id.
 *
 * ## The second grant this removes, which matters more than the speed
 *
 * Driving a UI through System Events needs Automation-to-System-Events **on top
 * of** Accessibility. Two grants, given in two different System Settings panes,
 * to reach one window. The native driver needs the first and not the second.
 *
 * ## Absence is the fallback, not an error
 *
 * `CUPERTINO_AX_SOCKET` and `CUPERTINO_AX_FOR` are set by `ServerLocator` and by
 * nothing else. A package installed from npm and run by hand has neither, and
 * that is the supported case: these are published artifacts that must work with
 * no app on the machine. `open()` returns null there, and the caller keeps
 * whatever lane it had. It never throws to say "no app".
 *
 * ## Lazy, deliberately
 *
 * Nothing connects at construction. `SurfaceCatalog` probes servers to learn
 * what they register, and a probe that opened a socket would make every capability
 * scan depend on the host being ready to answer one.
 */

/** The handshake `ServerHost` expects, and the reply it sends back. */
const PROTOCOL = "cupertino/1";
const LENT_SURFACE = "desktop";
const OK = "ok";

/**
 * How long one call may take.
 *
 * A walk carries its own five-second budget and the AX messaging timeout is two
 * seconds per element, so the ceiling that matters is the app's, not this one's.
 * This is only here so a host that stopped answering fails rather than hanging a
 * tool call forever.
 */
const CALL_TIMEOUT_MS = 30_000;

export type AxCall = {
  /** Tool name, e.g. `apple_desktop_find_elements`. */
  readonly tool: string;
  readonly args: Record<string, unknown>;
};

export type AxChannel = {
  /**
   * Call one desktop tool and return its parsed JSON body.
   *
   * Calls are serialised. The wire is one socket carrying newline-delimited
   * JSON-RPC, and the driver's handle store is shared mutable state on the other
   * end, so overlapping two walks would interleave both.
   */
  call(request: AxCall): Promise<unknown>;
  close(): void;
};

/**
 * The app is there and said no, or stopped answering.
 *
 * Distinct from the null `openAxChannel` returns, which means there is no app
 * to ask — see the note there on why those two must not collapse.
 */
export class AxChannelError extends AppleAutomationError {
  override readonly name: string = "AxChannelError";

  constructor(surface: SurfaceContext, message: string) {
    super(`${surface.appName}: ${message}`, { surface: surface.appName });
  }
}

/** What the host told us, when it refused the handshake. */
const refusal = (line: string): string =>
  line.startsWith("err ") ? line.slice(4) : `unexpected handshake reply '${line}'`;

/**
 * Open the channel, or return null when this server is not hosted by the app.
 *
 * Null and a throw are different answers and the difference is the whole
 * contract: null means "there is no app here, use your other lane", a throw
 * means "there is an app and it said no", which a caller must report rather
 * than paper over.
 */
export const openAxChannel = (
  surface: SurfaceContext,
  env: NodeJS.ProcessEnv = process.env,
): AxChannel | null => {
  const socketPath = env.CUPERTINO_AX_SOCKET?.trim();
  const identity = env.CUPERTINO_AX_FOR?.trim();
  if (!socketPath || !identity) return null;

  let socket: Socket | null = null;
  let pending = Promise.resolve();
  let nextId = 1;

  const connectOnce = (): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const s = connect(socketPath);
      let buffer = "";
      const onError = (error: Error) => {
        s.destroy();
        reject(new AxChannelError(surface, `cannot reach Cupertino: ${error.message}`));
      };
      s.once("error", onError);
      s.setEncoding("utf8");
      // The handshake reply is one line; everything after it is JSON-RPC, so
      // this listener has to come off before the first call reads anything.
      const onData = (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        s.off("data", onData);
        s.off("error", onError);
        if (line !== OK) {
          s.destroy();
          reject(new AxChannelError(surface, refusal(line)));
          return;
        }
        resolve(s);
      };
      s.on("data", onData);
      s.write(`${PROTOCOL} ${LENT_SURFACE} for=${identity}\n`);
    });

  const request = async (payload: AxCall): Promise<unknown> => {
    socket ??= await connectOnce();
    const live = socket;
    const id = nextId++;
    const line = `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: payload.tool, arguments: payload.args },
    })}\n`;

    return new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new AxChannelError(surface, `${payload.tool} did not answer in ${CALL_TIMEOUT_MS}ms`),
        );
      }, CALL_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        live.off("data", onData);
        live.off("error", onError);
        live.off("close", onClose);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new AxChannelError(surface, `${payload.tool} failed: ${error.message}`));
      };
      const onClose = () => {
        cleanup();
        socket = null;
        reject(
          new AxChannelError(surface, `Cupertino closed the connection during ${payload.tool}`),
        );
      };
      const onData = (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const raw = buffer.slice(0, newline);
        cleanup();
        let message: {
          result?: { content?: { text?: string }[]; isError?: boolean };
          error?: { message?: string };
        };
        try {
          message = JSON.parse(raw);
        } catch {
          reject(new AxChannelError(surface, `unparseable reply to ${payload.tool}`));
          return;
        }
        if (message.error) {
          reject(new AxChannelError(surface, message.error.message ?? "unknown error"));
          return;
        }
        // The desktop server answers in MCP's content envelope, and its tools
        // put one JSON document in the first text part.
        const text = message.result?.content?.[0]?.text;
        if (text === undefined) {
          reject(new AxChannelError(surface, `empty reply to ${payload.tool}`));
          return;
        }
        // A REFUSED tool is not a JSON-RPC error. It comes back as a normal
        // result carrying `isError: true` and the reason as PLAIN TEXT, so a
        // caller that only checks `message.error` reads a refusal as a success
        // value and carries on. That shipped, and it cost an afternoon: every
        // press through this channel was being refused for want of a write gate
        // and the lane above reported "the sheet did not appear", which is a
        // sentence about Maps rather than about permission.
        if (message.result?.isError === true) {
          reject(new AxChannelError(surface, `${payload.tool}: ${text}`));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      };

      live.on("data", onData);
      live.once("error", onError);
      live.once("close", onClose);
      live.write(line);
    });
  };

  return {
    call(payload) {
      // Serialised onto one chain. `pending` is replaced with a promise that
      // settles either way, so one failed call does not wedge the queue.
      const result = pending.then(() => request(payload));
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    close() {
      socket?.destroy();
      socket = null;
    },
  };
};

/**
 * Whether a person touched the machine while a sequence was running.
 *
 * Driving an interface is the one capability here that COMPETES with whoever is
 * using the Mac: a keystroke goes to whatever is frontmost and a click goes to a
 * screen point, so somebody typing during a paste does not slow it down, it
 * corrupts it.
 *
 * The comparison is what makes this work. `secondsSinceInput` on its own cannot
 * tell "they typed just before we started" from "they typed into the middle of
 * it" — but a sequence that ran for five seconds and ends with two seconds since
 * the last input knows the input landed inside it.
 *
 * **This exists because of a misdiagnosis, not a theory.** Two runs of the Maps
 * lane were blamed on interference and turned out to be bugs in the lane; one
 * was blamed on the lane and turned out to be interference. Neither could be
 * told apart from the outside, and a failure that names the wrong cause sends
 * the next hour in the wrong direction.
 */
export type Interference = {
  /** True when input arrived after the sequence began. */
  disturbed: boolean;
  secondsSinceInput: number;
  elapsedSeconds: number;
};

export type InterferenceWatch = { check(): Promise<Interference | null> };

/**
 * How much newer than Cupertino's own last posted event an input has to be
 * before it is somebody else's. The host stamps its post just after the events
 * go out, so the two readings of one keystroke differ by the posting alone.
 */
const OWN_INPUT_TOLERANCE_S = 0.25;

/**
 * Start watching. `check()` answers for the span since this call.
 *
 * Returns null from `check()` when the question could not be asked at all,
 * which is not the same as "undisturbed" and must not be reported as it.
 *
 * **The host's idle reading counts Cupertino's own events.** It has to — input
 * from any other software disturbs a sequence exactly as a person does — so a
 * sequence that posts a key finds "input" a moment ago on every run. A native
 * Mail reply reported "Someone used this Mac 0.2s ago" for its own ⌘V. The
 * host now also says when it last posted, and input no newer than that is
 * taken as ours. What that cannot see is a person whose input lands BEFORE our
 * last post in the same sequence: masked, the ambiguity hover's idle guard
 * already accepts. A host too old to report it keeps the bare comparison.
 */
export const watchInterference = (channel: AxChannel): InterferenceWatch => {
  const started = Date.now();
  return {
    async check() {
      const elapsedSeconds = (Date.now() - started) / 1000;
      try {
        const answer = (await channel.call({
          tool: "apple_desktop_user_activity",
          args: {},
        })) as { secondsSinceInput?: number; secondsSinceOwnInput?: number | null };
        const secondsSinceInput = answer.secondsSinceInput;
        if (typeof secondsSinceInput !== "number") return null;
        const own = answer.secondsSinceOwnInput;
        const ours = typeof own === "number" && secondsSinceInput >= own - OWN_INPUT_TOLERANCE_S;
        return {
          disturbed: secondsSinceInput < elapsedSeconds && !ours,
          secondsSinceInput,
          elapsedSeconds,
        };
      } catch {
        return null;
      }
    },
  };
};

/**
 * The sentence to append to a failure, or "" when nothing useful can be said.
 *
 * Deliberately says nothing when the machine was quiet: a failure that reads
 * "nobody touched it" invites the reader to stop looking, and the point of this
 * is to send them to the RIGHT place rather than to reassure them.
 */
export const interferenceNote = (found: Interference | null): string => {
  if (!found?.disturbed) return "";
  return (
    ` Someone used this Mac ${found.secondsSinceInput.toFixed(1)}s ago, during the ` +
    `${found.elapsedSeconds.toFixed(1)}s this took — a keystroke or click lands wherever the ` +
    `focus is, so that alone can explain this. Retry with the machine idle before looking further.`
  );
};
