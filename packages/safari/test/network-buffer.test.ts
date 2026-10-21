import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { REDACTED_HEADER } from "../src/client/network.js";

/**
 * The isolated-world network buffer, EXECUTED.
 *
 * `network.js` sits between the MAIN-world hook and the server: it takes the
 * records the hook dispatches on `document`, keeps them for this page load, and
 * answers `netRecord`, `netList` and `netGet` through `cupertinoRunCommand`.
 * Safari loads it and `actions.js` into ONE isolated world, so these tests do
 * the same — both scripts evaluated into a single `node:vm` context — and drive
 * the buffer through the real command entry point and the real event protocol.
 *
 * Same stub approach as `content-script.test.ts` and `network-hook.test.ts`:
 * no jsdom. `document` is an `EventTarget` (the cross-world channel), `Date` is
 * a clock the test moves, and timers are a queue the test runs by hand, so
 * "after the answer" and "once the flag has expired" are things a test can
 * actually say.
 */

const resource = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../apps/apple/CupertinoSafariExtension/Resources/${name}`, import.meta.url),
    ),
    "utf8",
  );

const NETWORK = resource("network.js");
const ACTIONS = resource("actions.js");

const FLAG = "__cupertino_net";
const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const ORIGIN = "https://app.example.com";

type Json = Record<string, unknown>;

interface Result<T = Json> {
  ok: boolean;
  data: T;
  error?: string;
}

interface Entry {
  id: string;
  seq: number;
  kind: string;
  method?: string | null;
  url?: string;
  status?: number | null;
  statusText?: string | null;
  ok?: boolean | null;
  error?: string | null;
  startedAt: string;
  durationMs?: number | null;
  requestBytes?: number | null;
  responseBytes?: number | null;
  contentType?: string | null;
  bodyAvailable?: boolean;
  bodyTruncated?: boolean;
  bodyEvicted?: boolean;
  level?: string;
  message?: string;
  stack?: string | null;
}

interface State {
  recording: boolean;
  page: string;
  expiresAt: string | null;
  options: Json;
  counts: { records: number; bodies: number; bodyBytes: number };
  dropped: { records: number; bodies: number };
  hook: { installed: boolean };
  resourceStatusSupported: boolean;
}

interface ListData {
  recording: boolean;
  page: string;
  entries: Entry[];
  next: string | null;
  dropped: { records: number; bodies: number };
}

interface GetData {
  entry: Entry;
  headers?: Record<string, string>;
  encoding: string | null;
  totalChars: number;
  offset: number;
  slice: string;
  done: boolean;
}

/** A resource-timing entry as `performance.getEntriesByType("resource")` hands it out. */
interface Timing {
  name: string;
  initiatorType: string;
  startTime: number;
  duration: number;
  decodedBodySize?: number;
  responseStatus?: number;
}

/**
 * One tab: network.js then actions.js, over a stub page.
 *
 * `flag` pre-seeds `sessionStorage` the way a reload under an armed tab finds
 * it. `timings` is the live resource-timing list, which the test may push to
 * later, as the browser does.
 */
const tab = (opts: { flag?: Json; timings?: Timing[]; token?: string } = {}) => {
  const clock = { now: T0 };
  class FakeDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock.now);
      else super(...(args as [number]));
    }
    static override now() {
      return clock.now;
    }
  }

  const store = new Map<string, string>();
  if (opts.flag) store.set(FLAG, JSON.stringify(opts.flag));
  const sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };

  const timers: { fn: () => void; ms: number }[] = [];
  const runTimers = () => {
    while (timers.length) timers.shift()!.fn();
  };

  const reloads: number[] = [];
  const timings = opts.timings ?? [];

  const document = Object.assign(new EventTarget(), {
    querySelectorAll: () => [button],
    getElementById: () => null,
  });
  const button = {
    tagName: "BUTTON",
    getAttribute: () => null,
    getBoundingClientRect: () => ({
      width: 100,
      height: 20,
      top: 0,
      left: 0,
      bottom: 20,
      right: 100,
    }),
    isContentEditable: false,
    isConnected: true,
    innerText: "Buy",
    value: "",
    labels: [],
    href: null,
  };

  // What the hook would hear: every install/uninstall network.js dispatches.
  const control: { name: string; detail: unknown }[] = [];
  for (const name of ["cupertino:net-install", "cupertino:net-uninstall"]) {
    document.addEventListener(name, (e) => {
      const detail = (e as CustomEvent<string>).detail;
      control.push({ name, detail: typeof detail === "string" ? JSON.parse(detail) : detail });
    });
  }

  const window: Record<string, unknown> = { innerHeight: 800, innerWidth: 1200 };
  if (opts.token) window.cupertinoPageToken = opts.token;
  const context = createContext({
    crypto: webcrypto,
    window,
    document,
    sessionStorage,
    Date: FakeDate,
    CustomEvent,
    location: { href: `${ORIGIN}/page`, reload: () => void reloads.push(clock.now) },
    setTimeout: (fn: () => void, ms = 0) => void timers.push({ fn, ms }),
    performance: {
      now: () => clock.now - T0,
      timeOrigin: T0,
      getEntriesByType: (type: string) => (type === "resource" ? timings.slice() : []),
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  });
  runInContext(NETWORK, context);
  runInContext(ACTIONS, context);

  const run = window.cupertinoRunCommand as <T = Json>(c: unknown) => Result<T>;
  const emit = (name: string, payload: unknown) =>
    document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload) }));

  let ref = 1;
  /** A fetch/xhr as the hook reports it: a start, then an end with the same `ref`. */
  const request = (r: Partial<Json> = {}, end: Partial<Json> | null = {}) => {
    const rec: Json = {
      kind: "fetch",
      phase: "start",
      ref: ref++,
      method: "GET",
      url: `${ORIGIN}/api/items`,
      startedAt: clock.now,
      requestHeaders: {},
      requestBody: null,
      status: null,
      statusText: null,
      responseHeaders: null,
      contentType: null,
      durationMs: null,
      error: null,
      body: null,
      ...r,
    };
    emit("cupertino:net-record", rec);
    if (end) {
      emit("cupertino:net-record", {
        ...rec,
        phase: "end",
        status: 200,
        statusText: "OK",
        responseHeaders: { "content-type": "application/json" },
        contentType: "application/json",
        durationMs: 12,
        body: {
          encoding: "text",
          data: '{"ok":true}',
          bytes: 11,
          truncated: false,
          totalBytes: 11,
        },
        ...end,
      });
    }
    return rec.ref as number;
  };

  const consoleError = (message: string, level = "error") =>
    emit("cupertino:net-record", {
      kind: "console",
      level,
      message,
      stack: `Error: ${message}\n    at app.js:1:1\n    at app.js:2:2`,
      startedAt: clock.now,
    });

  return {
    run,
    window,
    store,
    clock,
    timers,
    runTimers,
    reloads,
    control,
    timings,
    emit,
    request,
    consoleError,
    token: () => window.cupertinoPageToken as string,
    start: (extra: Json = {}) => run<State>({ action: "netRecord", op: "start", ...extra }),
    stop: () => run<State>({ action: "netRecord", op: "stop" }),
    status: () => run<State>({ action: "netRecord", op: "status" }),
    list: (extra: Json = {}) => run<ListData>({ action: "netList", limit: 50, ...extra }),
    get: (id: string, extra: Json = {}) =>
      run<GetData>({
        action: "netGet",
        id,
        part: "response",
        headers: false,
        offset: 0,
        length: 1000,
        ...extra,
      }),
  };
};

type Tab = ReturnType<typeof tab>;

const listed = (t: Tab, extra: Json = {}) => {
  const out = t.list(extra);
  expect(out.ok, out.error).toBe(true);
  return out.data;
};

describe("arming", () => {
  it("drops records while disarmed, then accepts them once started", () => {
    const t = tab();
    t.request({ url: `${ORIGIN}/before` });
    t.consoleError("before");
    expect(listed(t).entries).toEqual([]);

    const started = t.start();
    expect(started.ok, started.error).toBe(true);
    expect(started.data.recording).toBe(true);

    t.request({ url: `${ORIGIN}/after` });
    const entries = listed(t).entries;
    expect(entries.map((e) => e.url)).toEqual([`${ORIGIN}/after`]);
  });

  it("start writes an expiring flag and tells the hook to install", () => {
    const t = tab();
    const out = t.start({ armMinutes: 15, kinds: ["fetch"], bodyFilter: "/api/" });
    expect(out.ok, out.error).toBe(true);

    const flag = JSON.parse(t.store.get(FLAG)!) as Json;
    expect(flag.expiresAt).toBe(T0 + 15 * 60_000);
    expect(flag.kinds).toEqual(["fetch"]);
    expect(flag.bodyFilter).toBe("/api/");
    expect(out.data.expiresAt).toBe(new Date(T0 + 15 * 60_000).toISOString());
    expect(out.data.page).toBe(t.token());

    expect(t.control).toHaveLength(1);
    expect(t.control[0]!.name).toBe("cupertino:net-install");
    expect(t.control[0]!.detail).toMatchObject({ kinds: ["fetch"], bodyFilter: "/api/" });
  });

  it("caps armMinutes at 120", () => {
    const t = tab();
    t.start({ armMinutes: 10_000 });
    expect((JSON.parse(t.store.get(FLAG)!) as Json).expiresAt).toBe(T0 + 120 * 60_000);
  });

  it("is recording at load under an unexpired flag, and not under an expired one", () => {
    const live = tab({ flag: { expiresAt: T0 + 60_000, kinds: ["fetch", "xhr", "console"] } });
    expect(live.status().data.recording).toBe(true);
    live.request();
    expect(listed(live).entries).toHaveLength(1);

    const dead = tab({ flag: { expiresAt: T0 - 1, kinds: ["fetch", "xhr", "console"] } });
    expect(dead.status().data.recording).toBe(false);
    expect(dead.status().data.expiresAt).toBeNull();
    dead.request();
    expect(listed(dead).entries).toEqual([]);
  });

  it("stops accepting records once the flag's expiry passes, checked on every event", () => {
    const t = tab();
    t.start({ armMinutes: 1 });
    t.request({ url: `${ORIGIN}/in-time` });
    t.clock.now += 61_000;
    t.request({ url: `${ORIGIN}/too-late` });

    expect(listed(t).entries.map((e) => e.url)).toEqual([`${ORIGIN}/in-time`]);
    expect(t.status().data.recording).toBe(false);
    // Expiring is a stop: the flag goes, and the hook is told to unwrap — on
    // the next tick, since this ran inside the hook's own dispatch.
    expect(t.store.has(FLAG)).toBe(false);
    expect(t.control.at(-1)!.name).toBe("cupertino:net-install");
    t.runTimers();
    expect(t.control.at(-1)!.name).toBe("cupertino:net-uninstall");
  });

  it("stop removes the flag, uninstalls the hook, and keeps the buffer", () => {
    const t = tab();
    t.start();
    t.request();
    const out = t.stop();
    expect(out.data.recording).toBe(false);
    expect(t.store.has(FLAG)).toBe(false);
    expect(t.control.at(-1)!.name).toBe("cupertino:net-uninstall");
    expect(listed(t).entries).toHaveLength(1);

    t.request({ url: `${ORIGIN}/after-stop` });
    expect(listed(t).entries).toHaveLength(1);
  });

  it("clear empties the buffer and never reuses an id", () => {
    const t = tab();
    t.start();
    t.request();
    const first = listed(t).entries[0]!.id;
    const cleared = t.run<State>({ action: "netRecord", op: "clear" });
    expect(cleared.ok, cleared.error).toBe(true);
    expect(cleared.data.counts.records).toBe(0);
    expect(listed(t).entries).toEqual([]);

    t.request();
    const second = listed(t).entries[0]!.id;
    expect(second).not.toBe(first);
  });

  it("reports the hook's own word on whether it installed, including the extra ready after an uninstall", () => {
    const t = tab();
    expect(t.status().data.hook.installed).toBe(false);
    t.emit("cupertino:net-ready", { installed: true });
    expect(t.status().data.hook.installed).toBe(true);
    t.emit("cupertino:net-ready", { installed: false });
    expect(t.status().data.hook.installed).toBe(false);
  });

  it("refuses an unknown op", () => {
    const out = tab().run({ action: "netRecord", op: "pause" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("pause");
  });
});

describe("ids", () => {
  it("carry the page token, the same one actions.js hands out", () => {
    const t = tab();
    t.start();
    t.request();
    t.consoleError("boom");
    const [req, log] = listed(t).entries;
    expect(req!.id).toMatch(/^[0-9a-f]{8}-r1$/);
    expect(log!.id).toBe(`${t.token()}-c1`);

    const elements = t.run({ action: "elements", limit: 10 }) as Result<{
      page: string;
      elements: { id: string }[];
    }>;
    expect(elements.ok, elements.error).toBe(true);
    expect(elements.data.elements[0]!.id).toBe(`${t.token()}-e1`);
    expect(req!.id.split("-")[0]).toBe(t.token());
    expect(elements.data.page).toBe(t.token());
  });

  /** network.js loads first at `document_start`, so it is the one that mints. */
  it("actions.js reuses a token already on the window", () => {
    const t = tab({ token: "0badf00d" });
    expect(t.token()).toBe("0badf00d");
    const elements = t.run({ action: "elements", limit: 10 }) as Result<{
      elements: { id: string }[];
    }>;
    expect(elements.data.elements[0]!.id).toBe("0badf00d-e1");
  });

  it("refuses a stale id with network wording", () => {
    const t = tab();
    const out = t.run({ action: "netGet", page: "deadbeef", id: "deadbeef-r1" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("since gone");
  });

  it("answers an unknown id from this page plainly", () => {
    const t = tab();
    t.start();
    const id = `${t.token()}-r9`;
    const out = t.get(id);
    expect(out.ok).toBe(false);
    expect(out.error).toContain(`no request ${id} on this page`);
  });
});

describe("entries", () => {
  it("correlates a start and its end on ref, as one entry with a duration", () => {
    const t = tab();
    t.start();
    t.request(
      { method: "POST", requestBody: { encoding: "text", data: '{"q":1}', bytes: 7 } },
      { status: 201, statusText: "Created", durationMs: 34 },
    );
    const entries = listed(t).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "fetch",
      method: "POST",
      status: 201,
      statusText: "Created",
      ok: true,
      error: null,
      durationMs: 34,
      requestBytes: 7,
      responseBytes: 11,
      contentType: "application/json",
      bodyAvailable: true,
      bodyTruncated: false,
      bodyEvicted: false,
      startedAt: new Date(T0).toISOString(),
    });
  });

  it("lists a request still in flight, without a duration", () => {
    const t = tab();
    t.start();
    t.request({}, null);
    const [entry] = listed(t).entries;
    expect(entry).toMatchObject({ status: null, durationMs: null, bodyAvailable: false });
  });

  it("gives console entries the first line of their stack", () => {
    const t = tab();
    t.start();
    t.consoleError("boom");
    expect(listed(t).entries[0]).toEqual({
      id: `${t.token()}-c1`,
      seq: 1,
      kind: "console",
      level: "error",
      message: "boom",
      stack: "Error: boom",
      startedAt: new Date(T0).toISOString(),
    });
  });
});

describe("list filters", () => {
  const seeded = () => {
    const t = tab();
    t.start();
    t.request({ url: `${ORIGIN}/api/ok` });
    t.request({ url: `${ORIGIN}/api/missing` }, { status: 404, statusText: "Not Found" });
    t.request(
      { url: `${ORIGIN}/api/broken`, method: "POST" },
      { status: 500, statusText: "Server Error" },
    );
    t.request({ url: `${ORIGIN}/offline`, kind: "xhr" }, { status: 0, error: "Network error" });
    t.consoleError("boom");
    t.consoleError("careful", "warn");
    return t;
  };

  it("failed: network errors, status >= 400 and console errors", () => {
    const urls = listed(seeded(), { filter: { failed: true } }).entries.map(
      (e) => e.url ?? e.message,
    );
    expect(urls).toEqual([
      `${ORIGIN}/api/missing`,
      `${ORIGIN}/api/broken`,
      `${ORIGIN}/offline`,
      "boom",
    ]);
  });

  it("statusMin and statusMax", () => {
    const t = seeded();
    expect(
      listed(t, { filter: { statusMin: 400, statusMax: 499 } }).entries.map((e) => e.url),
    ).toEqual([`${ORIGIN}/api/missing`]);
    expect(listed(t, { filter: { statusMin: 500 } }).entries.map((e) => e.url)).toEqual([
      `${ORIGIN}/api/broken`,
    ]);
  });

  it("method, case-insensitively", () => {
    expect(listed(seeded(), { filter: { method: "post" } }).entries.map((e) => e.url)).toEqual([
      `${ORIGIN}/api/broken`,
    ]);
  });

  it("urlContains", () => {
    expect(listed(seeded(), { filter: { urlContains: "/api/" } }).entries).toHaveLength(3);
  });

  it("kind", () => {
    const t = seeded();
    expect(listed(t, { filter: { kind: "console" } }).entries.map((e) => e.message)).toEqual([
      "boom",
      "careful",
    ]);
    expect(listed(t, { filter: { kind: "xhr" } }).entries.map((e) => e.url)).toEqual([
      `${ORIGIN}/offline`,
    ]);
  });
});

describe("list cursor", () => {
  it("returns only newer entries after a cursor, and next is null at the end", () => {
    const t = tab();
    t.start();
    for (let i = 1; i <= 5; i++) t.request({ url: `${ORIGIN}/n${i}` });

    const page1 = listed(t, { limit: 2 });
    expect(page1.entries.map((e) => e.url)).toEqual([`${ORIGIN}/n1`, `${ORIGIN}/n2`]);
    expect(page1.next).toBe(page1.entries[1]!.id);

    const page2 = listed(t, { limit: 2, after: page1.next });
    expect(page2.entries.map((e) => e.url)).toEqual([`${ORIGIN}/n3`, `${ORIGIN}/n4`]);

    const page3 = listed(t, { limit: 2, after: page2.next });
    expect(page3.entries.map((e) => e.url)).toEqual([`${ORIGIN}/n5`]);
    expect(page3.next).toBeNull();

    t.request({ url: `${ORIGIN}/n6` });
    const later = listed(t, { after: page3.entries[0]!.id });
    expect(later.entries.map((e) => e.url)).toEqual([`${ORIGIN}/n6`]);
    expect(later.next).toBeNull();
  });

  it("refuses a cursor from another page load", () => {
    const t = tab();
    const out = t.list({ after: "deadbeef-r1" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("since gone");
  });
});

describe("get", () => {
  it("pages a body in slices until done, and the slices rebuild it", () => {
    const t = tab();
    t.start();
    t.request(
      {},
      {
        contentType: "text/plain",
        body: { encoding: "text", data: "0123456789", bytes: 10, truncated: false, totalBytes: 10 },
      },
    );
    const id = listed(t).entries[0]!.id;

    const slices: GetData[] = [];
    let offset = 0;
    for (;;) {
      const out = t.get(id, { offset, length: 4 });
      expect(out.ok, out.error).toBe(true);
      slices.push(out.data);
      if (out.data.done) break;
      offset += out.data.slice.length;
    }
    expect(slices).toHaveLength(3);
    expect(slices.map((s) => s.done)).toEqual([false, false, true]);
    expect(slices.map((s) => s.slice).join("")).toBe("0123456789");
    expect(slices[0]).toMatchObject({ encoding: "text", totalChars: 10, offset: 0 });
    expect(slices[2]!.offset).toBe(8);
  });

  it("serves the request part, summary bodies included", () => {
    const t = tab();
    t.start();
    t.request({
      method: "POST",
      requestHeaders: { "content-type": "multipart/form-data" },
      requestBody: { encoding: "summary", data: '[{"name":"file"}]', bytes: null },
    });
    const id = listed(t).entries[0]!.id;
    const out = t.get(id, { part: "request", headers: true });
    expect(out.ok, out.error).toBe(true);
    expect(out.data).toMatchObject({
      encoding: "summary",
      slice: '[{"name":"file"}]',
      done: true,
      headers: { "content-type": "multipart/form-data" },
    });
  });

  it("redacts sensitive headers on the way out", () => {
    const t = tab();
    t.start();
    t.request(
      {
        requestHeaders: {
          authorization: "Bearer abc.def",
          "x-api-key": "k-123",
          "x-csrf-token": "t",
          accept: "application/json",
        },
      },
      {
        responseHeaders: { "set-cookie": "sid=1; HttpOnly", "content-type": "application/json" },
      },
    );
    const id = listed(t).entries[0]!.id;

    const request = t.get(id, { part: "request", headers: true });
    expect(request.data.headers).toEqual({
      authorization: "<redacted: 14 chars>",
      "x-api-key": "<redacted: 5 chars>",
      "x-csrf-token": "<redacted: 1 chars>",
      accept: "application/json",
    });
    const response = t.get(id, { headers: true });
    expect(response.data.headers).toEqual({
      "set-cookie": "<redacted: 15 chars>",
      "content-type": "application/json",
    });
    expect(t.get(id, { headers: false }).data.headers).toBeUndefined();
  });

  /** The content-script copy cannot import the server's; this keeps them one rule. */
  it("uses the same redaction pattern as the server", () => {
    const m = /const REDACTED_HEADER =\s*(\/.+\/[a-z]*);/.exec(NETWORK);
    expect(m, "REDACTED_HEADER literal in network.js").not.toBeNull();
    const copy = runInContext(m![1]!, createContext({})) as RegExp;
    expect(copy.source).toBe(REDACTED_HEADER.source);
    expect(copy.flags).toBe(REDACTED_HEADER.flags);
  });
});

describe("eviction", () => {
  it("drops bodies oldest-first past 50 MiB, keeping the entry and marking it", () => {
    const t = tab();
    t.start();
    const big = "x".repeat(20 * 1024 * 1024);
    const body = {
      encoding: "text",
      data: big,
      bytes: big.length,
      truncated: false,
      totalBytes: big.length,
    };
    t.request({ url: `${ORIGIN}/a` }, { body });
    t.request({ url: `${ORIGIN}/b` }, { body });
    t.request({ url: `${ORIGIN}/c` }, { body });

    const out = listed(t);
    expect(out.entries.map((e) => [e.url, e.bodyAvailable, e.bodyEvicted])).toEqual([
      [`${ORIGIN}/a`, false, true],
      [`${ORIGIN}/b`, true, false],
      [`${ORIGIN}/c`, true, false],
    ]);
    expect(out.dropped).toEqual({ records: 0, bodies: 1 });

    const evicted = t.get(out.entries[0]!.id);
    expect(evicted.ok, evicted.error).toBe(true);
    expect(evicted.data).toMatchObject({ encoding: null, totalChars: 0, slice: "", done: true });
    expect(evicted.data.entry.bodyEvicted).toBe(true);
  });

  it("drops records oldest-first past 1,000, and counts them", () => {
    const t = tab();
    t.start();
    for (let i = 1; i <= 1003; i++) t.consoleError(`m${i}`);
    const out = listed(t, { limit: 500 });
    expect(out.dropped).toEqual({ records: 3, bodies: 0 });
    expect(out.entries[0]!.message).toBe("m4");
    expect(t.status().data.counts.records).toBe(1000);

    const gone = t.get(`${t.token()}-c1`);
    expect(gone.ok).toBe(false);
    expect(gone.error).toContain(`no request ${t.token()}-c1 on this page`);
  });
});

describe("resource timing", () => {
  it("lists resource entries while disarmed, and dedupes them against hooked requests", () => {
    const t = tab({
      timings: [
        {
          name: `${ORIGIN}/logo.png`,
          initiatorType: "img",
          startTime: 100,
          duration: 20.4,
          decodedBodySize: 512,
          responseStatus: 200,
        },
      ],
    });

    // Disarmed: the image is listed anyway.
    const first = listed(t).entries;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: `${t.token()}-t1`,
      kind: "resource",
      url: `${ORIGIN}/logo.png`,
      status: 200,
      durationMs: 20,
      responseBytes: 512,
      startedAt: new Date(T0 + 100).toISOString(),
    });

    // Armed: a hooked fetch, then the browser's timing entry for the same URL.
    t.start();
    t.request({ url: `${ORIGIN}/api/data` });
    t.timings.push({
      name: `${ORIGIN}/api/data`,
      initiatorType: "fetch",
      startTime: 200,
      duration: 5,
    });
    t.timings.push({
      name: `${ORIGIN}/style.css`,
      initiatorType: "link",
      startTime: 210,
      duration: 3,
    });

    const all = listed(t).entries;
    expect(all.map((e) => [e.kind, e.url])).toEqual([
      ["resource", `${ORIGIN}/logo.png`],
      ["fetch", `${ORIGIN}/api/data`],
      ["resource", `${ORIGIN}/style.css`],
    ]);
    // No responseStatus property: unknown, not zero.
    expect(all[2]!.status).toBeNull();
    expect(t.status().data.resourceStatusSupported).toBe(true);
  });

  it("says so when the browser does not report responseStatus", () => {
    const t = tab({
      timings: [{ name: `${ORIGIN}/a.js`, initiatorType: "script", startTime: 1, duration: 1 }],
    });
    expect(t.status().data.resourceStatusSupported).toBe(false);
  });
});

describe("reload", () => {
  it("reloads only after the answer has left", () => {
    const t = tab();
    const out = t.start({ reload: true });
    expect(out.ok, out.error).toBe(true);
    expect(t.reloads).toEqual([]);
    t.runTimers();
    expect(t.reloads).toHaveLength(1);
  });

  it("does not reload when it was not asked to", () => {
    const t = tab();
    t.start();
    t.runTimers();
    expect(t.reloads).toEqual([]);
  });
});

describe("without the recorder", () => {
  it("says the recorder did not load, rather than an unknown action", () => {
    const window: Record<string, unknown> = {};
    const context = createContext({
      crypto: webcrypto,
      window,
      document: { querySelectorAll: () => [], getElementById: () => null },
      location: { href: ORIGIN },
    });
    runInContext(ACTIONS, context);
    const run = window.cupertinoRunCommand as (c: unknown) => Result;
    for (const action of ["netRecord", "netList", "netGet"]) {
      const out = run({ action });
      expect(out.ok).toBe(false);
      expect(out.error).toBe("The network recorder did not load on this page.");
    }
  });
});
