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
        let message: { result?: { content?: { text?: string }[] }; error?: { message?: string } };
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
        // put one JSON document in the first text part. A tool that refused
        // reports it inside that document rather than as a JSON-RPC error, so
        // the caller reads the body either way.
        const text = message.result?.content?.[0]?.text;
        if (text === undefined) {
          reject(new AxChannelError(surface, `empty reply to ${payload.tool}`));
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
