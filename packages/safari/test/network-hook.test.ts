import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

/**
 * The MAIN-world network recorder, EXECUTED.
 *
 * `network-hook.js` runs in the page's own JavaScript world and replaces
 * `fetch`, three `XMLHttpRequest` methods and two `console` methods while a tab
 * is armed. The property that matters most is not that it records — it is that
 * the page cannot tell it is there: the same Response object, the same thrown
 * error, a body the page can still read in full, and no exception of the
 * recorder's ever reaching a site. A test that only checked the records would
 * pass a hook that breaks every page it touches, so most of these assert the
 * page's side first.
 *
 * Safari ignores `"world": "MAIN"`, so the file itself lands in the isolated
 * world, where it wraps nothing and only hands its source to `network.js`,
 * which injects it into the page as a `<script>`. Both halves are run here: the
 * file as it loads in each world, and the injected source string evaluated on
 * its own, in a context that has nothing of the file around it.
 *
 * Same approach as `content-script.test.ts`: the script is evaluated in a
 * `node:vm` against hand-rolled stubs, not jsdom. The stubs are only as rich as
 * the hook's use of them — a `Response` with `clone()` and a body that can be
 * read once, an `XMLHttpRequest` that completes on the next tick, and an
 * `EventTarget` standing in for `document` so the CustomEvent protocol to the
 * isolated world is the real one.
 */

const SOURCE = readFileSync(
  fileURLToPath(
    new URL(
      "../../../apps/apple/CupertinoSafariExtension/Resources/network-hook.js",
      import.meta.url,
    ),
  ),
  "utf8",
);

const FLAG = "__cupertino_net";
const GUARD = "__cupertinoNetHook";
const ORIGIN = "https://app.example.com";

type Json = Record<string, unknown>;

interface Body {
  encoding: string;
  data: string;
  bytes: number;
  truncated?: boolean;
  totalBytes?: number | null;
}

interface NetRecord {
  kind: string;
  phase: string;
  ref: number;
  method: string;
  url: string;
  startedAt: number;
  requestHeaders: Record<string, string>;
  requestBody: Body | null;
  status: number | null;
  statusText: string | null;
  responseHeaders: Record<string, string> | null;
  contentType: string | null;
  durationMs: number | null;
  error: string | null;
  body: Body | null;
  level?: string;
  message?: string;
  stack?: string | null;
  trace?: string[];
}

const bytesOf = (s: string) => new TextEncoder().encode(s);

/**
 * A `Response` whose body can be read exactly once, like the real one.
 *
 * Stream-less on purpose: it has no `body`, so the hook takes its
 * `arrayBuffer()` path. The stream path is exercised separately with Node's own
 * `Response`, whose `clone()` is a genuine tee.
 */
class FakeResponse {
  bodyUsed = false;
  readonly headers: Headers;
  readonly status: number;
  readonly statusText: string;
  constructor(
    readonly bytes: Uint8Array,
    readonly init: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
    readonly stats = { clones: 0 },
  ) {
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "OK";
    this.headers = new Headers(init.headers);
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  clone() {
    if (this.bodyUsed) throw new TypeError("Body has already been used");
    this.stats.clones++;
    return new FakeResponse(this.bytes, this.init, this.stats);
  }
  private consume() {
    if (this.bodyUsed) throw new TypeError("Body has already been used");
    this.bodyUsed = true;
    return this.bytes;
  }
  async arrayBuffer() {
    const b = this.consume();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  async text() {
    return new TextDecoder().decode(this.consume());
  }
  async json() {
    return JSON.parse(await this.text()) as unknown;
  }
}

interface XhrReply {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body: Uint8Array;
  /** A network error: DONE with status 0, then `error` and `loadend`, never `load`. */
  fail?: boolean;
}

/**
 * An `XMLHttpRequest` that completes on the next macrotask with whatever
 * `FakeXHR.next` says, materialising `response` per `responseType` the way a
 * browser does — and, like a browser, refusing `responseText` for any type but
 * text. It fires what a browser fires, in order: `readystatechange` at DONE,
 * then `load` (or `error`), then `loadend`.
 *
 * `abort()` only models the call that matters here, the one after DONE: per
 * the XHR spec it resets the state to UNSENT and the response to a network
 * error — status 0, no headers, no body — and fires NO event, so the
 * `loadend` still to come sees a request that looks like it never answered.
 */
class FakeXHR extends EventTarget {
  static next: XhrReply = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: bytesOf('{"a":1}'),
  };
  responseType = "";
  readyState = 0;
  status = 0;
  statusText = "";
  response: unknown = null;
  opened: unknown[] = [];
  sentBody: unknown = undefined;
  sentHeaders: [string, string][] = [];
  private text = "";
  private replyHeaders: Record<string, string> = {};
  open(...args: unknown[]) {
    // As the spec's open() does: OPENED, and the previous response gone.
    this.opened = args;
    this.readyState = 1;
    this.status = 0;
    this.statusText = "";
    this.response = null;
    this.text = "";
    this.replyHeaders = {};
  }
  setRequestHeader(name: string, value: string) {
    this.sentHeaders.push([name, value]);
  }
  send(body?: unknown) {
    this.sentBody = body;
    const reply = FakeXHR.next;
    setTimeout(() => {
      if (reply.fail) {
        this.readyState = 4;
        this.status = 0;
        this.dispatchEvent(new Event("readystatechange"));
        this.dispatchEvent(new Event("error"));
        this.dispatchEvent(new Event("loadend"));
        return;
      }
      this.status = reply.status;
      this.statusText = reply.statusText ?? "OK";
      this.replyHeaders = reply.headers;
      const text = new TextDecoder().decode(reply.body);
      this.text = text;
      switch (this.responseType) {
        case "":
        case "text":
          this.response = text;
          break;
        case "json":
          this.response = JSON.parse(text);
          break;
        case "arraybuffer":
          this.response = reply.body.slice().buffer;
          break;
        case "blob":
          this.response = new Blob([reply.body], { type: reply.headers["content-type"] });
          break;
      }
      this.readyState = 4;
      this.dispatchEvent(new Event("readystatechange"));
      this.dispatchEvent(new Event("load"));
      this.dispatchEvent(new Event("loadend"));
    }, 0);
  }
  abort() {
    if (this.readyState !== 4) throw new Error("FakeXHR models only the abort after DONE");
    this.readyState = 0;
    this.status = 0;
    this.statusText = "";
    this.response = null;
    this.text = "";
    this.replyHeaders = {};
  }
  get responseText() {
    if (this.responseType !== "" && this.responseType !== "text") {
      throw new Error("InvalidStateError");
    }
    return this.text;
  }
  getAllResponseHeaders() {
    return Object.entries(this.replyHeaders)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
  }
  getResponseHeader(name: string) {
    return this.replyHeaders[name.toLowerCase()] ?? null;
  }
}

const XHR_OPEN = FakeXHR.prototype.open;
const XHR_SEND = FakeXHR.prototype.send;
const XHR_SET_HEADER = FakeXHR.prototype.setRequestHeader;

type Responder = (input: unknown, init?: unknown) => Promise<unknown>;

const jsonReply: Responder = async () =>
  new FakeResponse(bytesOf('{"ok":true}'), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Evaluate the hook against a fresh stub page.
 *
 * `window` is the sandbox itself, so `window.fetch = …` inside the script and a
 * bare `fetch(…)` both reach the same slot, as they do in a page.
 */
const load = (
  opts: {
    flag?: Json | string;
    /** `true` is the extension's own `browser`; any other value is a page global of that name. */
    browser?: boolean | Json;
    respond?: Responder;
    /** What is evaluated: the file by default, or the source an isolated copy exposed. */
    source?: string;
  } = {},
) => {
  const store = new Map<string, string>();
  if (opts.flag !== undefined) {
    store.set(FLAG, typeof opts.flag === "string" ? opts.flag : JSON.stringify(opts.flag));
  }
  const sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };

  const document = new EventTarget();
  const records: NetRecord[] = [];
  const ready: { installed: boolean; world?: string }[] = [];
  document.addEventListener("cupertino:net-record", (e) =>
    records.push(JSON.parse((e as CustomEvent<string>).detail) as NetRecord),
  );
  document.addEventListener("cupertino:net-ready", (e) =>
    ready.push(
      JSON.parse((e as CustomEvent<string>).detail) as { installed: boolean; world?: string },
    ),
  );

  const consoleCalls: { level: string; args: unknown[] }[] = [];
  const fakeConsole = {
    error: (...args: unknown[]) => void consoleCalls.push({ level: "error", args }),
    warn: (...args: unknown[]) => void consoleCalls.push({ level: "warn", args }),
    log: (...args: unknown[]) => void consoleCalls.push({ level: "log", args }),
  };
  const originalConsoleError = fakeConsole.error;
  const originalConsoleWarn = fakeConsole.warn;

  const respond = { fn: opts.respond ?? jsonReply };
  const fetchCalls: { input: unknown; init: unknown }[] = [];
  let lastPromise: Promise<unknown> | null = null;
  const originalFetch = function fetch(input: unknown, init?: unknown) {
    fetchCalls.push({ input, init });
    lastPromise = respond.fn(input, init);
    return lastPromise;
  };

  // Each load gets its own prototype methods back, since an earlier test's
  // hook may have left them wrapped.
  FakeXHR.prototype.open = XHR_OPEN;
  FakeXHR.prototype.send = XHR_SEND;
  FakeXHR.prototype.setRequestHeader = XHR_SET_HEADER;

  const windowEvents = new EventTarget();
  const sandbox: Record<string, unknown> = {
    fetch: originalFetch,
    XMLHttpRequest: FakeXHR,
    console: fakeConsole,
    sessionStorage,
    document,
    location: { href: `${ORIGIN}/page` },
    CustomEvent,
    Event,
    EventTarget,
    URL,
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    Blob,
    File,
    FormData,
    URLSearchParams,
    performance,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
  };
  if (opts.browser === true) sandbox.browser = { runtime: {} };
  else if (opts.browser) sandbox.browser = opts.browser;
  sandbox.window = sandbox;
  const context = createContext(sandbox);
  runInContext(opts.source ?? SOURCE, context);

  const send = (name: string, detail?: Json) =>
    document.dispatchEvent(
      new CustomEvent(name, { detail: detail === undefined ? undefined : JSON.stringify(detail) }),
    );

  return {
    sandbox,
    context,
    store,
    records,
    ready,
    consoleCalls,
    windowEvents,
    respond,
    fetchCalls,
    originalFetch,
    originalConsoleError,
    originalConsoleWarn,
    lastPromise: () => lastPromise,
    fetch: (input: unknown, init?: unknown) =>
      (sandbox.fetch as (i: unknown, n?: unknown) => Promise<FakeResponse>)(input, init),
    install: (detail: Json = {}) =>
      send("cupertino:net-install", {
        kinds: ["fetch", "xhr", "console"],
        captureBodies: true,
        bodyFilter: null,
        maxBodyBytes: 10485760,
        ...detail,
      }),
    uninstall: () => send("cupertino:net-uninstall"),
    ping: () => send("cupertino:net-ping"),
    ends: () => records.filter((r) => r.phase === "end"),
    starts: () => records.filter((r) => r.phase === "start"),
  };
};

type Page = ReturnType<typeof load>;

const endOf = async (page: Page, count = 1) => {
  await vi.waitFor(() => expect(page.ends()).toHaveLength(count));
  return page.ends()[count - 1]!;
};

const decode64 = (data: string) => new Uint8Array(Buffer.from(data, "base64"));

describe("arming", () => {
  it("does nothing until installed", () => {
    const page = load();
    expect(page.sandbox.fetch).toBe(page.originalFetch);
    expect(FakeXHR.prototype.open).toBe(XHR_OPEN);
    expect(FakeXHR.prototype.send).toBe(XHR_SEND);
    expect((page.sandbox.console as { error: unknown }).error).toBe(page.originalConsoleError);
    expect(page.ready).toEqual([{ installed: false }]);
  });

  it("installs at load from an unexpired flag", async () => {
    const page = load({
      flag: {
        expiresAt: Date.now() + 60_000,
        kinds: ["fetch"],
        captureBodies: true,
        bodyFilter: null,
        maxBodyBytes: 1024,
      },
    });
    expect(page.sandbox.fetch).not.toBe(page.originalFetch);
    expect(page.ready).toEqual([{ installed: true }]);
    // Only the armed kinds are wrapped.
    expect(FakeXHR.prototype.open).toBe(XHR_OPEN);
    expect((page.sandbox.console as { error: unknown }).error).toBe(page.originalConsoleError);
    await page.fetch("/api");
    expect((await endOf(page)).status).toBe(200);
    expect(page.store.has(FLAG)).toBe(true);
  });

  it("removes an expired flag and stays dormant", () => {
    const page = load({
      flag: { expiresAt: Date.now() - 1, kinds: ["fetch"], captureBodies: true },
    });
    expect(page.store.has(FLAG)).toBe(false);
    expect(page.sandbox.fetch).toBe(page.originalFetch);
    expect(page.ready).toEqual([{ installed: false }]);
  });

  it("removes an unreadable flag and stays dormant", () => {
    const page = load({ flag: "{not json" });
    expect(page.store.has(FLAG)).toBe(false);
    expect(page.sandbox.fetch).toBe(page.originalFetch);
  });

  it("a second install only updates the options", async () => {
    const page = load();
    page.install({ maxBodyBytes: 1024 });
    const wrapped = page.sandbox.fetch;
    page.install({ maxBodyBytes: 4 });
    expect(page.sandbox.fetch).toBe(wrapped);
    expect(page.ready).toEqual([{ installed: false }, { installed: true }, { installed: true }]);
    await page.fetch("/api");
    const end = await endOf(page);
    expect(page.starts()).toHaveLength(1);
    expect(end.body).toMatchObject({ truncated: true, bytes: 4, data: '{"ok' });
  });

  it("a missing or null maxBodyBytes means the default, not zero", async () => {
    const page = load();
    page.install({ maxBodyBytes: null });
    await page.fetch("/api");
    expect((await endOf(page)).body).toMatchObject({ data: '{"ok":true}', truncated: false });
  });

  it("a double injection is a no-op", async () => {
    const page = load();
    runInContext(SOURCE, page.context);
    page.install();
    await page.fetch("/api");
    await endOf(page);
    expect(page.starts()).toHaveLength(1);
    expect(page.ready).toEqual([{ installed: false }, { installed: true }]);
  });

  it("answers a ping from the MAIN world with its install state", () => {
    const page = load();
    page.ready.length = 0;
    page.ping();
    expect(page.ready).toEqual([{ installed: false, world: "main" }]);
    page.install();
    page.ready.length = 0;
    page.ping();
    expect(page.ready).toEqual([{ installed: true, world: "main" }]);
  });

  it("a duplicate MAIN copy does not answer a ping twice", () => {
    const page = load();
    runInContext(SOURCE, page.context);
    page.ready.length = 0;
    page.ping();
    expect(page.ready).toHaveLength(1);
  });

  it("an isolated-world copy answers a ping as isolated and wraps nothing", () => {
    const page = load({ browser: true, flag: { expiresAt: Date.now() + 60_000 } });
    page.ping();
    expect(page.ready).toEqual([{ installed: false, world: "isolated" }]);
    // An install event must not arm it, and it still never answers as MAIN.
    page.install();
    expect(page.sandbox.fetch).toBe(page.originalFetch);
    expect(page.ready).toEqual([{ installed: false, world: "isolated" }]);
  });

  it("isolated-world copy bails", () => {
    const page = load({ browser: true, flag: { expiresAt: Date.now() + 60_000 } });
    page.install();
    expect(page.sandbox.fetch).toBe(page.originalFetch);
    expect(FakeXHR.prototype.open).toBe(XHR_OPEN);
    expect((page.sandbox.console as { error: unknown }).error).toBe(page.originalConsoleError);
    expect(page.ready).toEqual([]);
    // Bailing means not claiming the guard either: the page-world copy that
    // network.js injects from this one's source must still be able to run.
    expect(page.sandbox[GUARD]).toBeUndefined();
  });

  it("uninstall restores the originals", () => {
    const page = load();
    page.install();
    expect(page.sandbox.fetch).not.toBe(page.originalFetch);
    expect(FakeXHR.prototype.open).not.toBe(XHR_OPEN);
    page.uninstall();
    expect(page.sandbox.fetch).toBe(page.originalFetch);
    expect(FakeXHR.prototype.open).toBe(XHR_OPEN);
    expect(FakeXHR.prototype.send).toBe(XHR_SEND);
    expect(FakeXHR.prototype.setRequestHeader).toBe(XHR_SET_HEADER);
    expect((page.sandbox.console as { error: unknown }).error).toBe(page.originalConsoleError);
    expect((page.sandbox.console as { warn: unknown }).warn).toBe(page.originalConsoleWarn);
    expect(page.ready.at(-1)).toEqual({ installed: false });
  });

  it("uninstall leaves a page's later wrapper in place and goes quiet", async () => {
    const page = load();
    page.install();
    const ours = page.sandbox.fetch as (...a: unknown[]) => Promise<unknown>;
    let pageSaw = 0;
    // A library (an error tracker, say) wraps fetch after the hook did.
    page.sandbox.fetch = function (...args: unknown[]) {
      pageSaw++;
      return ours(...args);
    };
    const theirs = page.sandbox.fetch;
    page.uninstall();
    expect(page.sandbox.fetch).toBe(theirs);
    await page.fetch("/api");
    expect(pageSaw).toBe(1);
    expect(page.records).toHaveLength(0);
  });
});

describe("fetch", () => {
  it("fetch transparency", async () => {
    const response = new FakeResponse(bytesOf('{"items":[1,2,3]}'), {
      headers: { "content-type": "application/json" },
    });
    const page = load({ respond: async () => response });
    page.install();
    const promise = page.fetch("/api/items");
    // The very promise the original returned: nothing chained in front of the
    // page's own `.then`.
    expect(promise).toBe(page.lastPromise());
    const res = await promise;
    expect(res).toBe(response);
    await endOf(page);
    expect(await res.json()).toEqual({ items: [1, 2, 3] });
  });

  it("a rejected fetch rejects with the same error and records it", async () => {
    const failure = new TypeError("Load failed");
    const page = load({ respond: () => Promise.reject(failure) });
    page.install();
    await expect(page.fetch("/api")).rejects.toBe(failure);
    const end = await endOf(page);
    expect(end.error).toBe("TypeError: Load failed");
    expect(end.status).toBeNull();
    expect(end.body).toBeNull();
  });

  it("fetch records request and response", async () => {
    const page = load({
      respond: async () =>
        new FakeResponse(bytesOf('{"ok":true}'), {
          status: 201,
          statusText: "Created",
          headers: { "content-type": "application/json; charset=utf-8", "x-request-id": "r1" },
        }),
    });
    page.install();
    await page.fetch("/api/items?x=1", {
      method: "post",
      body: '{"q":1}',
      headers: { "Content-Type": "application/json", "X-Trace": "abc" },
    });
    const end = await endOf(page);
    const [start] = page.starts();
    expect(start).toMatchObject({
      kind: "fetch",
      phase: "start",
      method: "POST",
      url: `${ORIGIN}/api/items?x=1`,
      requestHeaders: { "content-type": "application/json", "x-trace": "abc" },
      requestBody: { encoding: "text", data: '{"q":1}', bytes: 7 },
      status: null,
      body: null,
    });
    expect(typeof start!.startedAt).toBe("number");
    expect(end).toMatchObject({
      kind: "fetch",
      phase: "end",
      ref: start!.ref,
      method: "POST",
      url: `${ORIGIN}/api/items?x=1`,
      startedAt: start!.startedAt,
      status: 201,
      statusText: "Created",
      contentType: "application/json; charset=utf-8",
      responseHeaders: { "content-type": "application/json; charset=utf-8", "x-request-id": "r1" },
      error: null,
      body: {
        encoding: "text",
        data: '{"ok":true}',
        bytes: 11,
        truncated: false,
        totalBytes: 11,
      },
    });
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("refs are distinct per request", async () => {
    const page = load();
    page.install();
    await Promise.all([page.fetch("/a"), page.fetch("/b")]);
    await endOf(page, 2);
    const refs = page.starts().map((r) => r.ref);
    expect(new Set(refs).size).toBe(2);
  });

  it("takes method, url and headers from a Request-like input", async () => {
    const page = load();
    page.install();
    await page.fetch(new Request(`${ORIGIN}/r`, { method: "PUT", headers: { "X-A": "1" } }));
    const [start] = page.starts();
    expect(start).toMatchObject({
      method: "PUT",
      url: `${ORIGIN}/r`,
      requestHeaders: { "x-a": "1" },
    });
  });

  /**
   * Text or base64 is decided by the media type alone. The words matter only
   * as a whole subtype or a structured suffix: an .xlsx is
   * `…spreadsheetml.sheet`, which CONTAINS "xml", and decoding a zip as UTF-8
   * destroys it.
   */
  it.each([
    ["application/json; charset=utf-8", "text"],
    ["application/problem+json", "text"],
    ["image/svg+xml", "text"],
    ["text/html", "text"],
    ["application/javascript", "text"],
    ["application/x-javascript", "text"],
    ["application/ecmascript", "text"],
    ["application/xml", "text"],
    ["application/x-www-form-urlencoded", "text"],
    ["APPLICATION/JSON", "text"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "base64"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "base64"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "base64"],
    ["application/jsonl-but-not-really", "base64"],
    ["application/octet-stream; name=json.txt", "base64"],
    ["", "base64"],
  ])("content type %j is %s", async (contentType, encoding) => {
    const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
    const page = load({
      respond: async () =>
        new FakeResponse(payload, contentType ? { headers: { "content-type": contentType } } : {}),
    });
    page.install();
    await page.fetch("/file");
    const end = await endOf(page);
    expect(end.body!.encoding).toBe(encoding);
    if (encoding === "base64") expect(decode64(end.body!.data)).toEqual(payload);
  });

  it("binary body is base64", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00, 0x80]);
    const page = load({
      respond: async () =>
        new FakeResponse(pdf, { headers: { "content-type": "application/pdf" } }),
    });
    page.install();
    await page.fetch("/doc.pdf");
    const end = await endOf(page);
    expect(end.body).toMatchObject({ encoding: "base64", bytes: 8, truncated: false });
    expect(decode64(end.body!.data)).toEqual(pdf);
  });

  it("body cap without Content-Length", async () => {
    const page = load({
      respond: async () =>
        new FakeResponse(bytesOf("hello world!"), { headers: { "content-type": "text/plain" } }),
    });
    page.install({ maxBodyBytes: 8 });
    const res = await page.fetch("/big");
    const end = await endOf(page);
    expect(end.body).toMatchObject({
      encoding: "text",
      data: "hello wo",
      bytes: 8,
      truncated: true,
    });
    expect(await res.text()).toBe("hello world!");
  });

  it("body cap through a real stream tee", async () => {
    let response: Response | null = null;
    const page = load({
      respond: async () => {
        response = new Response("hello world!", { headers: { "content-type": "text/plain" } });
        return response;
      },
    });
    page.install({ maxBodyBytes: 8 });
    const res = (await page.fetch("/big")) as unknown as Response;
    expect(res).toBe(response);
    const end = await endOf(page);
    expect(end.body).toMatchObject({
      encoding: "text",
      data: "hello wo",
      bytes: 8,
      truncated: true,
    });
    expect(await res.text()).toBe("hello world!");
  });

  it("Content-Length over cap skips the clone", async () => {
    const stats = { clones: 0 };
    const page = load({
      respond: async () =>
        new FakeResponse(
          bytesOf("0123456789abcdefghij"),
          { headers: { "content-type": "text/plain", "content-length": "20" } },
          stats,
        ),
    });
    page.install({ maxBodyBytes: 8 });
    const res = await page.fetch("/big");
    const end = await endOf(page);
    expect(stats.clones).toBe(0);
    expect(end.body).toMatchObject({ truncated: true, totalBytes: 20, bytes: 0 });
    expect(await res.text()).toBe("0123456789abcdefghij");
  });

  it("bodyFilter", async () => {
    const page = load();
    page.install({ bodyFilter: "/api/" });
    await page.fetch("/static/app.json", { method: "POST", body: "x=1" });
    await page.fetch("/api/items");
    const [skipped, kept] = [await endOf(page, 1), await endOf(page, 2)];
    expect(skipped).toMatchObject({ status: 200, contentType: "application/json", body: null });
    expect(skipped.requestBody).toBeNull();
    expect(skipped.responseHeaders).toEqual({ "content-type": "application/json" });
    expect(kept.body).toMatchObject({ encoding: "text", data: '{"ok":true}' });
  });

  it("captureBodies false keeps metadata only", async () => {
    const page = load();
    page.install({ captureBodies: false });
    await page.fetch("/api", { method: "POST", body: "x=1" });
    const end = await endOf(page);
    expect(end).toMatchObject({ status: 200, body: null, requestBody: null });
  });

  it("request bodies", async () => {
    const page = load();
    page.install({ maxBodyBytes: 16 });
    const form = new FormData();
    form.append("title", "Lease");
    form.append("doc", new File([new Uint8Array([1, 2, 3])], "a.pdf", { type: "application/pdf" }));
    await page.fetch("/a", { method: "POST", body: new URLSearchParams({ a: "1", b: "2" }) });
    await page.fetch("/b", { method: "POST", body: form });
    await page.fetch("/c", { method: "POST", body: new Uint8Array([0, 1, 255]) });
    await page.fetch("/d", { method: "POST", body: new Uint8Array([0, 1, 255]).buffer });
    await page.fetch("/e", { method: "POST", body: new Blob([new Uint8Array([7, 8])]) });
    await page.fetch("/f", { method: "POST", body: new Uint8Array(32) });
    await page.fetch("/g", { method: "POST", body: "x".repeat(17) });
    await endOf(page, 7);
    const byUrl = (path: string) => page.ends().find((r) => r.url === `${ORIGIN}${path}`)!;

    expect(byUrl("/a").requestBody).toEqual({ encoding: "text", data: "a=1&b=2", bytes: 7 });
    expect(byUrl("/b").requestBody!.encoding).toBe("summary");
    expect(JSON.parse(byUrl("/b").requestBody!.data)).toEqual([
      { name: "title" },
      { name: "doc", file: { name: "a.pdf", size: 3, type: "application/pdf" } },
    ]);
    for (const path of ["/c", "/d"]) {
      expect(byUrl(path).requestBody).toMatchObject({ encoding: "base64", bytes: 3 });
      expect(decode64(byUrl(path).requestBody!.data)).toEqual(new Uint8Array([0, 1, 255]));
    }
    expect(byUrl("/e").requestBody).toMatchObject({ encoding: "base64", bytes: 2 });
    expect(decode64(byUrl("/e").requestBody!.data)).toEqual(new Uint8Array([7, 8]));
    expect(byUrl("/f").requestBody).toMatchObject({ encoding: "summary", bytes: 32 });
    expect(byUrl("/g").requestBody).toMatchObject({ encoding: "summary", bytes: 17 });
  });

  it("an exception inside the recorder never reaches the page", async () => {
    const page = load();
    page.install();
    runInContext(
      `(() => {
        const real = JSON.stringify;
        let once = true;
        JSON.stringify = function () {
          if (once) { once = false; throw new Error("recorder blew up"); }
          return real.apply(this, arguments);
        };
      })()`,
      page.context,
    );
    const res = await page.fetch("/api");
    expect(await res.json()).toEqual({ ok: true });
  });

  /**
   * The end record is sent from inside promise callbacks, where a throw does
   * not reach the page synchronously — it becomes an unhandled rejection, which
   * a browser reports to the page's own `unhandledrejection` listeners. Vitest
   * fails the run on one, so this pins the asynchronous path as well.
   */
  it("a recorder that throws on the end record leaks no rejection either", async () => {
    const page = load();
    page.install();
    runInContext(
      `(() => {
        const real = JSON.stringify;
        JSON.stringify = function (value) {
          if (value && value.phase === "end") throw new Error("recorder blew up");
          return real.apply(this, arguments);
        };
      })()`,
      page.context,
    );
    const leaked: unknown[] = [];
    const onLeak = (reason: unknown) => void leaked.push(reason);
    process.on("unhandledRejection", onLeak);
    try {
      // Both asynchronous routes to the end record: a response body read, and
      // a Blob request body read.
      const res = await page.fetch("/api", { method: "POST", body: new Blob(["x"]) });
      await new Promise((r) => setTimeout(r, 20));
      expect(await res.json()).toEqual({ ok: true });
      expect(page.starts()).toHaveLength(1);
      expect(page.ends()).toHaveLength(0);
      expect(leaked).toEqual([]);
    } finally {
      process.off("unhandledRejection", onLeak);
    }
  });

  it("a recorder that cannot clone still hands the page its response", async () => {
    const response = new FakeResponse(bytesOf("{}"), {
      headers: { "content-type": "application/json" },
    });
    response.clone = () => {
      throw new Error("no clone for you");
    };
    const page = load({ respond: async () => response });
    page.install();
    expect(await page.fetch("/api")).toBe(response);
    const end = await endOf(page);
    expect(end).toMatchObject({ status: 200, body: null });
  });
});

describe("xhr", () => {
  const cases: [string, string, Uint8Array, string, (r: unknown) => void][] = [
    [
      "arraybuffer",
      "application/octet-stream",
      new Uint8Array([1, 2, 3, 250]),
      "base64",
      (r) => expect(new Uint8Array(r as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 250])),
    ],
    [
      "blob",
      "image/png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "base64",
      (r) => expect((r as Blob).size).toBe(4),
    ],
    ["json", "application/json", bytesOf('{"a":1}'), "text", (r) => expect(r).toEqual({ a: 1 })],
    ["text", "text/plain", bytesOf("plain words"), "text", (r) => expect(r).toBe("plain words")],
  ];

  it.each(cases)(
    "xhr responseType %s",
    async (responseType, contentType, payload, encoding, check) => {
      const page = load();
      page.install();
      FakeXHR.next = { status: 200, headers: { "content-type": contentType }, body: payload };
      const XHR = page.sandbox.XMLHttpRequest as typeof FakeXHR;
      const xhr = new XHR();
      xhr.responseType = responseType;
      let seenByPage: unknown;
      xhr.addEventListener("loadend", () => (seenByPage = xhr.response));
      xhr.open("post", "/x", true);
      xhr.setRequestHeader("X-Trace", "t1");
      xhr.send("payload");
      const end = await endOf(page);

      // The page's view first: arguments passed through, and the very response
      // object the browser made.
      expect(xhr.opened).toEqual(["post", "/x", true]);
      expect(xhr.sentBody).toBe("payload");
      expect(xhr.sentHeaders).toEqual([["X-Trace", "t1"]]);
      expect(xhr.response).toBe(seenByPage);
      check(xhr.response);

      const [start] = page.starts();
      expect(start).toMatchObject({
        kind: "xhr",
        method: "POST",
        url: `${ORIGIN}/x`,
        requestHeaders: { "x-trace": "t1" },
        requestBody: { encoding: "text", data: "payload", bytes: 7 },
      });
      expect(end).toMatchObject({
        kind: "xhr",
        ref: start!.ref,
        status: 200,
        contentType,
        responseHeaders: { "content-type": contentType },
        error: null,
        body: { encoding, bytes: payload.length, truncated: false },
      });
      if (encoding === "base64") expect(decode64(end.body!.data)).toEqual(payload);
      else expect(end.body!.data).toBe(new TextDecoder().decode(payload));
    },
  );

  it("open passes its exact arguments through", () => {
    const page = load();
    page.install();
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    // Two arguments, not three: an explicit `undefined` async flag would turn
    // a real XHR synchronous.
    xhr.open("GET", "/two");
    expect(xhr.opened).toEqual(["GET", "/two"]);
  });

  it("caps an xhr body", async () => {
    const page = load();
    page.install({ maxBodyBytes: 3 });
    FakeXHR.next = {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    };
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    xhr.responseType = "arraybuffer";
    xhr.open("GET", "/bin");
    xhr.send();
    const end = await endOf(page);
    expect(end.body).toMatchObject({ bytes: 3, truncated: true, totalBytes: 5 });
    expect(decode64(end.body!.data)).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(xhr.response as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("reopening an in-flight request closes its record as aborted", async () => {
    const page = load();
    page.install();
    FakeXHR.next = { status: 200, headers: { "content-type": "text/plain" }, body: bytesOf("2nd") };
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    xhr.open("GET", "/first");
    xhr.send();
    // `open` on a request in flight aborts it, without a `loadend` of its own.
    xhr.open("GET", "/second");
    xhr.send();
    await endOf(page, 2);
    const [first, second] = page.ends();
    expect(first).toMatchObject({ url: `${ORIGIN}/first`, error: "Aborted", body: null });
    expect(second).toMatchObject({ url: `${ORIGIN}/second`, error: null, body: { data: "2nd" } });
    expect(first!.ref).not.toBe(second!.ref);
  });

  /**
   * The live bug on an Angular 18 + zone.js site: every XHR recorded as
   * `status: 0, "Network error"` while the page got all its data. Something
   * calls `abort()` after DONE, which wipes status and response without an
   * abort event, before `loadend`. So the response is taken at `load`.
   */
  it("an abort after DONE does not erase what load saw", async () => {
    const page = load();
    page.install();
    FakeXHR.next = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: bytesOf('{"rows":[1]}'),
    };
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    xhr.open("GET", "/api/rows");
    let seen: unknown;
    // The page's own listener, added after `open` the way HttpClient does.
    xhr.addEventListener("load", () => {
      seen = xhr.responseText;
      xhr.abort();
    });
    xhr.send();
    const end = await endOf(page);
    expect(seen).toBe('{"rows":[1]}');
    expect(xhr.status).toBe(0);
    expect(end).toMatchObject({
      status: 200,
      error: null,
      contentType: "application/json",
      responseHeaders: { "content-type": "application/json" },
      body: { encoding: "text", data: '{"rows":[1]}', truncated: false },
    });
    expect(end.trace).toEqual(["readystatechange 4/200", "load 4/200", "loadend 0/0"]);
  });

  it("an abort after DONE from a load listener added before open is caught at readystatechange", async () => {
    const page = load();
    page.install();
    FakeXHR.next = { status: 200, headers: { "content-type": "text/plain" }, body: bytesOf("ok") };
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    xhr.addEventListener("load", () => xhr.abort());
    xhr.open("GET", "/early-listener");
    xhr.send();
    const end = await endOf(page);
    expect(end).toMatchObject({ status: 200, error: null, body: { data: "ok" } });
    expect(end.trace).toEqual(["readystatechange 4/200", "load 0/0", "loadend 0/0"]);
  });

  /**
   * `open()` after DONE is the other spec reset: OPENED, response gone, and the
   * first request's own `loadend` still to come — now at readyState 1, where
   * no request's `loadend` ever legitimately fires.
   */
  it("open() inside a load listener after DONE keeps the first record's 200 and body", async () => {
    const page = load();
    page.install();
    FakeXHR.next = { status: 200, headers: { "content-type": "text/plain" }, body: bytesOf("one") };
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    xhr.open("GET", "/one");
    xhr.addEventListener("load", () => xhr.open("GET", "/later"));
    xhr.send();
    const end = await endOf(page);
    await new Promise((r) => setTimeout(r, 10));
    expect(page.ends()).toHaveLength(1);
    expect(end).toMatchObject({
      url: `${ORIGIN}/one`,
      status: 200,
      error: null,
      body: { data: "one" },
    });
  });

  it("reusing one object, open and send from its load, gives two records, each its own", async () => {
    const page = load();
    page.install();
    FakeXHR.next = { status: 200, headers: { "content-type": "text/plain" }, body: bytesOf("one") };
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    xhr.open("GET", "/one");
    let reused = false;
    xhr.addEventListener("load", () => {
      if (reused) return;
      reused = true;
      FakeXHR.next = {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/plain" },
        body: bytesOf("two"),
      };
      xhr.open("GET", "/two");
      xhr.send();
    });
    xhr.send();
    await endOf(page, 2);
    const [first, second] = page.ends();
    expect(first).toMatchObject({ url: `${ORIGIN}/one`, status: 200, body: { data: "one" } });
    expect(second).toMatchObject({
      url: `${ORIGIN}/two`,
      status: 404,
      error: null,
      body: { data: "two" },
    });
    // The first request's late loadend, at OPENED, was not taken as the second's.
    expect(second!.trace).toEqual(["readystatechange 4/404", "load 4/404", "loadend 4/404"]);
  });

  /**
   * The legacy poll: `onreadystatechange` set once, before the first `open`,
   * reopening the same object at DONE. A handler set before `open` runs before
   * the hook's listener, so `open` arrives before any snapshot was taken.
   */
  it("reopening from a readystatechange listener added before open keeps each answer", async () => {
    const page = load();
    page.install();
    FakeXHR.next = { status: 200, headers: { "content-type": "text/plain" }, body: bytesOf("one") };
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    let polls = 0;
    xhr.addEventListener("readystatechange", () => {
      if (xhr.readyState !== 4 || polls >= 1) return;
      polls += 1;
      FakeXHR.next = {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: bytesOf("two"),
      };
      xhr.open("GET", "/poll?1");
      xhr.send();
    });
    xhr.open("GET", "/poll?0");
    xhr.send();
    await endOf(page, 2);
    const [first, second] = page.ends();
    expect(first).toMatchObject({
      url: `${ORIGIN}/poll?0`,
      status: 200,
      error: null,
      body: { data: "one" },
    });
    expect(second).toMatchObject({ url: `${ORIGIN}/poll?1`, status: 200, body: { data: "two" } });
  });

  it("a Blob body read at snapshot time that fails, closed through open, leaks no rejection", async () => {
    const page = load();
    page.install();
    FakeXHR.next = { status: 200, headers: { "content-type": "image/png" }, body: bytesOf("png") };
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    xhr.responseType = "blob";
    // Before `open`, so it runs before the hook's listener: the Blob the hook
    // reads cannot be read.
    xhr.addEventListener("readystatechange", () => {
      if (xhr.readyState === 4) {
        xhr.response = {
          size: 3,
          type: "image/png",
          slice: () => ({ arrayBuffer: () => Promise.reject(new Error("read failed")) }),
        };
      }
    });
    xhr.open("GET", "/img");
    // The record closes through this `open`, from the snapshot whose body is
    // the failing read; vitest fails the run on an unhandled rejection.
    xhr.addEventListener("load", () => xhr.open("GET", "/next"));
    xhr.send();
    const end = await endOf(page);
    expect(end).toMatchObject({ url: `${ORIGIN}/img`, status: 200, body: null, error: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(page.ends()).toHaveLength(1);
  });

  it("registers its listeners with the native addEventListener, not the page's patch", async () => {
    const page = load();
    page.install();
    const patched = vi.fn(function (
      this: EventTarget,
      ...args: Parameters<EventTarget["addEventListener"]>
    ) {
      return EventTarget.prototype.addEventListener.apply(this, args);
    });
    // zone.js-style: the page patches addEventListener after the hook loaded.
    (FakeXHR.prototype as unknown as Record<string, unknown>).addEventListener = patched;
    try {
      FakeXHR.next = {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: bytesOf("ok"),
      };
      const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
      xhr.open("GET", "/zoned");
      xhr.send();
      const end = await endOf(page);
      expect(patched).not.toHaveBeenCalled();
      expect(end).toMatchObject({ status: 200, body: { data: "ok" } });
    } finally {
      delete (FakeXHR.prototype as unknown as Record<string, unknown>).addEventListener;
    }
  });

  it("a genuine network error is still a network error", async () => {
    const page = load();
    page.install();
    FakeXHR.next = { status: 0, headers: {}, body: new Uint8Array(), fail: true };
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    xhr.open("GET", "/down");
    xhr.send();
    const end = await endOf(page);
    expect(end).toMatchObject({ status: 0, error: "Network error", body: null });
    expect(end.trace).toEqual(["readystatechange 4/0", "error 4/0", "loadend 4/0"]);
  });

  it("keeps the trace to eight entries", async () => {
    const page = load();
    page.install();
    FakeXHR.next = { status: 200, headers: { "content-type": "text/plain" }, body: bytesOf("x") };
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    xhr.open("GET", "/chatty");
    xhr.send();
    for (let i = 0; i < 20; i++) xhr.dispatchEvent(new Event("timeout"));
    const end = await endOf(page);
    expect(end.trace).toHaveLength(8);
    expect(end.trace![0]).toBe("timeout 1/0");
  });

  it("a fetch record carries no trace", async () => {
    const page = load();
    page.install();
    await page.fetch("/api");
    expect((await endOf(page)).trace).toBeUndefined();
  });

  it("a request opened before install is not recorded", async () => {
    const page = load();
    const xhr = new (page.sandbox.XMLHttpRequest as typeof FakeXHR)();
    xhr.open("GET", "/early");
    page.install();
    xhr.send();
    await new Promise((r) => setTimeout(r, 10));
    expect(page.records).toHaveLength(0);
  });
});

describe("console", () => {
  it("console.error emits a record and still calls the original with the same arguments", () => {
    const page = load();
    page.install();
    const detail = { a: 1 };
    const failure = new Error("kaput");
    const con = page.sandbox.console as Record<"error" | "warn", (...a: unknown[]) => void>;
    con.error("bad thing", detail, failure);
    con.warn("careful");
    expect(page.consoleCalls).toHaveLength(2);
    expect(page.consoleCalls[0]!.args[1]).toBe(detail);
    expect(page.consoleCalls[0]!.args[2]).toBe(failure);
    expect(page.consoleCalls[1]).toEqual({ level: "warn", args: ["careful"] });
    expect(page.records).toHaveLength(2);
    expect(page.records[0]).toMatchObject({
      kind: "console",
      level: "error",
      message: 'bad thing {"a":1} Error: kaput',
    });
    expect(page.records[0]!.stack).toContain("kaput");
    expect(typeof page.records[0]!.startedAt).toBe("number");
    expect(page.records[1]).toMatchObject({ kind: "console", level: "warn", message: "careful" });
  });

  it("records error and unhandledrejection events", () => {
    const page = load();
    page.install();
    const failure = new Error("uncaught");
    page.windowEvents.dispatchEvent(
      Object.assign(new Event("error"), { message: "Uncaught Error: uncaught", error: failure }),
    );
    page.windowEvents.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: new Error("nobody caught me") }),
    );
    expect(page.records).toHaveLength(2);
    expect(page.records[0]).toMatchObject({
      kind: "console",
      level: "error",
      message: "Uncaught Error: uncaught",
    });
    expect(page.records[0]!.stack).toContain("uncaught");
    expect(page.records[1]).toMatchObject({ kind: "console", level: "error" });
    expect(page.records[1]!.message).toContain("nobody caught me");
  });

  it("stops listening for page errors after uninstall", () => {
    const page = load();
    page.install();
    page.uninstall();
    page.windowEvents.dispatchEvent(Object.assign(new Event("error"), { message: "late" }));
    expect(page.records).toHaveLength(0);
  });

  it("a page listener that logs while a record is in flight does not loop", () => {
    const page = load();
    page.install();
    const con = page.sandbox.console as Record<"error", (...a: unknown[]) => void>;
    (page.sandbox.document as EventTarget).addEventListener("cupertino:net-record", () =>
      con.error("echo"),
    );
    con.error("first");
    expect(page.records).toHaveLength(1);
    expect(page.consoleCalls.map((c) => c.args[0])).toEqual(["first", "echo"]);
  });
});

/**
 * The source the isolated copy hands to `network.js`, as `network.js` would
 * read it off the window. Taken once, from a real isolated-world load.
 */
const injectedSource = () => {
  const isolated = load({ browser: true });
  const source = isolated.sandbox.cupertinoNetHookSource;
  expect(typeof source).toBe("string");
  return source as string;
};

describe("injected as a page script", () => {
  it("an isolated copy wraps nothing, even when armed, and exposes its source", () => {
    const page = load({ browser: true, flag: { expiresAt: Date.now() + 60_000 } });
    expect(page.sandbox.fetch).toBe(page.originalFetch);
    expect(FakeXHR.prototype.open).toBe(XHR_OPEN);
    expect((page.sandbox.console as { error: unknown }).error).toBe(page.originalConsoleError);
    expect(page.sandbox[GUARD]).toBeUndefined();
    const source = page.sandbox.cupertinoNetHookSource as string;
    expect(source).toMatch(/^\(function cupertinoNetHookMain\(\)/);
    expect(source.trimEnd()).toMatch(/\)\(\);$/);
  });

  it("a page copy exposes no source and leaves no global behind but the guard", () => {
    const page = load();
    expect(page.sandbox.cupertinoNetHookSource).toBeUndefined();
    expect(page.sandbox.cupertinoNetHookMain).toBeUndefined();
  });

  it("a page global named browser that is not the extension's does not make the page copy bail", () => {
    // `<div id="browser">` is a `window.browser` in every engine.
    const page = load({ browser: { tagName: "DIV" } });
    page.install();
    expect(page.sandbox.fetch).not.toBe(page.originalFetch);
  });

  it("evaluated alone, the source arms from the flag at load and answers as main", async () => {
    const page = load({ source: injectedSource(), flag: { expiresAt: Date.now() + 60_000 } });
    expect(page.sandbox.fetch).not.toBe(page.originalFetch);
    expect(page.ready).toEqual([{ installed: true }]);
    page.ready.length = 0;
    page.ping();
    expect(page.ready).toEqual([{ installed: true, world: "main" }]);
    await page.fetch("/api");
    expect((await endOf(page)).status).toBe(200);
  });

  it("evaluated alone, the source stays dormant until installed", () => {
    const page = load({ source: injectedSource() });
    expect(page.sandbox.fetch).toBe(page.originalFetch);
    expect(page.ready).toEqual([{ installed: false }]);
  });

  it("injected fetch transparency", async () => {
    const response = new FakeResponse(bytesOf('{"items":[1,2,3]}'), {
      headers: { "content-type": "application/json" },
    });
    const page = load({ source: injectedSource(), respond: async () => response });
    page.install();
    const promise = page.fetch("/api/items");
    expect(promise).toBe(page.lastPromise());
    const res = await promise;
    expect(res).toBe(response);
    const end = await endOf(page);
    expect(await res.json()).toEqual({ items: [1, 2, 3] });
    expect(end).toMatchObject({
      kind: "fetch",
      url: `${ORIGIN}/api/items`,
      status: 200,
      body: { encoding: "text", data: '{"items":[1,2,3]}', truncated: false },
    });
  });

  it("injected xhr records request and response and hands the page its own response", async () => {
    const page = load({ source: injectedSource() });
    page.install();
    FakeXHR.next = {
      status: 201,
      headers: { "content-type": "application/json" },
      body: bytesOf('{"a":1}'),
    };
    const XHR = page.sandbox.XMLHttpRequest as typeof FakeXHR;
    const xhr = new XHR();
    xhr.responseType = "json";
    xhr.open("post", "/x", true);
    xhr.send("payload");
    const end = await endOf(page);
    expect(xhr.opened).toEqual(["post", "/x", true]);
    expect(xhr.response).toEqual({ a: 1 });
    expect(end).toMatchObject({
      kind: "xhr",
      method: "POST",
      url: `${ORIGIN}/x`,
      status: 201,
      requestBody: { encoding: "text", data: "payload" },
      body: { encoding: "text", data: '{"a":1}' },
    });
  });

  it("injected console.error records and still calls the original", () => {
    const page = load({ source: injectedSource() });
    page.install();
    const con = page.sandbox.console as Record<"error", (...a: unknown[]) => void>;
    con.error("bad thing", { a: 1 });
    expect(page.consoleCalls).toEqual([{ level: "error", args: ["bad thing", { a: 1 }] }]);
    expect(page.records).toEqual([
      expect.objectContaining({ kind: "console", level: "error", message: 'bad thing {"a":1}' }),
    ]);
  });

  it("an injected copy after a page copy is a no-op, and the reverse too", async () => {
    const source = injectedSource();
    for (const [first, second] of [
      [SOURCE, source],
      [source, SOURCE],
    ] as const) {
      const page = load({ source: first });
      runInContext(second, page.context);
      page.ready.length = 0;
      page.ping();
      expect(page.ready).toHaveLength(1);
      page.install();
      await page.fetch("/api");
      await endOf(page);
      expect(page.starts()).toHaveLength(1);
    }
  });
});
