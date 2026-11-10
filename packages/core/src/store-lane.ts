import { connect, type Socket } from "node:net";

import { AppleAutomationError, type SurfaceContext } from "./errors.js";

/**
 * The store lane: writes the app saves into an Apple app's own Core Data store.
 *
 * A server Cupertino.app spawned connects back to its `cupertino.sock`, says
 * `cupertino/1 store for=<surface>`, and then sends newline-delimited JSON-RPC
 * lane methods (`voiceMemos.rename`, …). The app opens the store, saves once and
 * answers with the lane's own JSON object — not MCP's content envelope, which is
 * the one wire difference from the desktop lend in `ax.ts`.
 *
 * It mirrors `openAxChannel` deliberately rather than sharing code with it:
 * `ax.ts` carries hard-won comments and three consumers, and a second small file
 * is cheaper than an abstraction over two wires that differ in their replies.
 *
 * - **Null without the host's env.** `CUPERTINO_AX_SOCKET` and `CUPERTINO_AX_FOR`
 *   are set by `ServerLocator` and nothing else. A package run from npm with no
 *   app has neither, and that is supported: null means "no app here", never an
 *   error.
 * - **Lazy.** Nothing connects until the first call, so probing what a server
 *   registers never depends on the host answering.
 * - **One connection, reused.** Each connection costs the app a handshake and a
 *   log line, so calls share one and reconnect only after it closes.
 * - **Serialised.** One call is on the wire at a time, on a chain that survives a
 *   failure.
 */

const PROTOCOL = "cupertino/1";
const VERB = "store";
const OK = "ok";

/**
 * How long one call may take, handshake included.
 *
 * The app saves once per call into a local SQLite store; fifteen seconds is far
 * past any honest save and only bounds a host that stopped answering.
 */
const CALL_TIMEOUT_MS = 15_000;

export type StoreLane = {
  /** Call one lane method and return the result object the app answered with. */
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
};

export type StoreLaneOptions = {
  /** Per-call budget, handshake included. Defaults to 15 s. */
  timeoutMs?: number;
};

/**
 * The app is there and said no, or the conversation with it broke.
 *
 * `reason` is `"refused"` (the handshake was refused), `"unreachable"` (nothing
 * answered on the socket), `"timeout"`, `"closed"` (the connection dropped
 * mid-call), `"protocol"` (a reply this side cannot read), or else the app's own
 * `data.reason`: `invalid`, `notFound`, `incompatible`, `writesOff`, `failed`.
 *
 * The message is the app's text as it sent it, which may name a filesystem
 * path; what reaches tool output is the caller's decision.
 */
export class StoreLaneError extends AppleAutomationError {
  override readonly name: string = "StoreLaneError";
  readonly reason: string;

  constructor(
    surface: SurfaceContext,
    reason: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(`${surface.appName}: ${message}`, { surface: surface.appName, reason, ...details });
    this.reason = reason;
  }
}

/** What the host told us, when it refused the handshake. */
const refusal = (line: string): string =>
  line.startsWith("err ") ? line.slice(4) : `unexpected handshake reply '${line}'`;

type Reply = {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: { reason?: unknown } };
};

type Waiter = {
  readonly id: number;
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: StoreLaneError): void;
};

/** One socket, and the call waiting on it, if any. */
type Connection = {
  readonly socket: Socket;
  waiter: Waiter | null;
};

/**
 * Open the lane, or return null when this server is not hosted by the app.
 *
 * Null and a throw are different answers: null means "no app, use your other
 * lane"; a `StoreLaneError` from `call` means "there is an app and this is what
 * it said", which a caller must report.
 */
export const openStoreLane = (
  surface: SurfaceContext,
  env: NodeJS.ProcessEnv = process.env,
  opts: StoreLaneOptions = {},
): StoreLane | null => {
  const socketPath = env.CUPERTINO_AX_SOCKET?.trim();
  const identity = env.CUPERTINO_AX_FOR?.trim();
  if (!socketPath || !identity) return null;
  const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;

  const fail = (reason: string, message: string, details?: Record<string, unknown>) =>
    new StoreLaneError(surface, reason, message, details);

  /** The live connection, or the one being handshaken; null when there is none. */
  let current: Connection | null = null;
  let ready: Promise<Connection> | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  let nextId = 1;

  /** Stop handing out this connection, synchronously, so a queued call never reuses it. */
  const forget = (conn: Connection) => {
    if (current !== conn) return;
    current = null;
    ready = null;
  };

  /** Drop the connection: the next call opens a fresh one. */
  const drop = () => {
    const conn = current;
    if (!conn) return;
    forget(conn);
    conn.socket.destroy();
  };

  const settle = (conn: Connection, line: string) => {
    const waiter = conn.waiter;
    conn.waiter = null;
    // A line with no call waiting can only be a stray: nothing to give it to.
    if (!waiter) return;
    let reply: Reply;
    try {
      reply = JSON.parse(line) as Reply;
    } catch {
      waiter.reject(fail("protocol", `unparseable reply to ${waiter.method}`));
      return;
    }
    if (reply === null || typeof reply !== "object" || reply.id !== waiter.id) {
      // Not the answer to this call. Whatever the socket carries now cannot be
      // trusted to line up, so the next call starts on a fresh one.
      forget(conn);
      conn.socket.destroy();
      waiter.reject(fail("protocol", `reply to ${waiter.method} did not carry its id`));
      return;
    }
    if (reply.error) {
      const { code, message, data } = reply.error;
      const reason = typeof data?.reason === "string" ? data.reason : "protocol";
      waiter.reject(
        fail(
          reason,
          typeof message === "string" ? message : `${waiter.method} failed`,
          typeof code === "number" ? { code } : undefined,
        ),
      );
      return;
    }
    if (!("result" in reply)) {
      waiter.reject(fail("protocol", `reply to ${waiter.method} had neither result nor error`));
      return;
    }
    waiter.resolve(reply.result);
  };

  const connectOnce = (): Promise<Connection> =>
    new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const conn: Connection = { socket, waiter: null };
      current = conn;
      let buffer = "";
      let greeted = false;
      let reached = false;

      socket.setEncoding("utf8");
      socket.once("connect", () => {
        reached = true;
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!greeted) {
            greeted = true;
            if (line === OK) {
              resolve(conn);
            } else {
              forget(conn);
              reject(fail("refused", refusal(line)));
              socket.destroy();
            }
            continue;
          }
          settle(conn, line);
        }
      });
      socket.on("error", (error: Error) => {
        // `close` follows every `error`; it is the one place that cleans up.
        // Before the handshake, though, the error is the better explanation.
        if (!greeted) {
          forget(conn);
          reject(
            reached
              ? fail("closed", `Cupertino dropped the connection: ${error.message}`)
              : fail("unreachable", `cannot reach Cupertino: ${error.message}`),
          );
        }
      });
      socket.on("close", () => {
        forget(conn);
        if (!greeted) {
          reject(fail("closed", "Cupertino closed the connection before answering the handshake"));
        }
        const waiter = conn.waiter;
        conn.waiter = null;
        waiter?.reject(fail("closed", `Cupertino closed the connection during ${waiter.method}`));
      });
      socket.write(`${PROTOCOL} ${VERB} for=${identity}\n`);
    });

  const exchange = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    ready ??= connectOnce();
    const conn = await ready;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      conn.waiter = { id, method, resolve, reject };
      conn.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // The unanswered call may still be answered later. Dropping the socket
        // keeps that late line from being read as the next call's reply.
        drop();
        reject(fail("timeout", `${method} did not answer in ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([exchange(method, params), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    call(method, params) {
      // `pending` is replaced with a promise that settles either way, so one
      // failed call does not wedge the queue.
      const result = pending.then(() => request(method, params));
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    close() {
      drop();
    },
  };
};
