// Holds what the page's network hook records, and answers the server about it.
//
// ## Where this sits
//
// `network-hook.js` runs in the page's own world, where `fetch` and
// `XMLHttpRequest` are the functions the page calls, and dispatches one
// CustomEvent per thing it sees. This file runs in the ISOLATED world, beside
// `actions.js` and `content.js`, where the page cannot reach: it decides
// whether a record is wanted at all, keeps the ones that are for this page
// load, and answers three commands through `cupertinoRunCommand` —
// `netRecord` (arm, disarm, clear, status), `netList` (metadata, filtered and
// paged by cursor) and `netGet` (one record's headers and one slice of a
// body). See docs/superpowers/specs/2026-10-20-safari-network-design.md.
//
// ## Why the armed state lives here and not in the hook
//
// The hook's events travel on `document`, which the page shares. A page can
// dispatch `cupertino:net-record` itself, or `cupertino:net-install`, and the
// hook would obey the second. So the hook's state is not the one that decides
// what is kept: this script keeps its own `recording`, and a record that
// arrives while it is false is dropped, whoever sent it. What a page can still
// do through events is lie about its own traffic while armed, which tells
// nobody anything the page could not already say.
//
// The arm flag is a different door, and it is open. It lives in the page's own
// `sessionStorage`, so a page can write one, and the next load of its tab is
// then armed as if `start` had been called. What that buys the page is a copy
// of its OWN traffic, in its own tab's memory, which leaves only when an agent
// asks that tab for it. The one thing it could otherwise take is time: a flag
// written to expire in the year 2255 would keep the tab wrapped indefinitely.
// So an expiry is never honoured past `MAX_ARM_MINUTES` from the load that
// reads it — the longest `start` itself can arm for — and the flag is written
// back capped, so the hook and this buffer agree on when it ends. Shutting the
// door entirely would take a nonce the page cannot read, held in extension
// storage and checked here; that is deferred, not forgotten.
//
// ## Why it loads at `document_start`, before `actions.js`
//
// An armed reload records from the page's first request, and the first request
// can leave before `document_idle`. So this script is its own `content_scripts`
// entry at `document_start`, and that makes it the first of the three to run —
// which is why it, not `actions.js`, mints the page token when there is none.
// `actions.js` reuses whatever it finds, so the `-r` ids here and the `-e` ids
// there name the same page load.
//
// ## Everything answers synchronously
//
// `cupertinoRunCommand` is synchronous and must never throw, because the
// server is polling for a result and an exception would leave it waiting for
// one that never comes. Nothing here awaits: every command is answered from
// what is already in the buffer.

(function () {
  // One copy per isolated world. A second one would keep a second buffer fed
  // by the same events and then answer for only one of them.
  if (window.cupertinoNetwork) return;

  /**
   * This page load's token: the one `actions.js` would otherwise mint, minted
   * here first because this file runs first. Same shape and the same 32 random
   * bits as there — see the comment on `PAGE` in `actions.js` for why that is
   * enough. A value that is not that shape is not trusted and is replaced.
   */
  const TOKEN_SHAPE = /^[0-9a-f]{8}$/;
  const PAGE = (function () {
    const existing = window.cupertinoPageToken;
    if (typeof existing === "string" && TOKEN_SHAPE.test(existing)) return existing;
    const minted = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    window.cupertinoPageToken = minted;
    return minted;
  })();

  /**
   * `<page>-r<n>` for a hooked fetch or XHR, `-t<n>` for a resource-timing
   * entry, `-c<n>` for a console record. Each prefix counts on its own and
   * never restarts within a page load — not even after `clear` — so an id
   * handed out once can never later name a different record.
   */
  const ID_SHAPE = /^([0-9a-f]{8})-([rtc])(\d+)$/;

  const FLAG_KEY = "__cupertino_net";
  const EVENT_INSTALL = "cupertino:net-install";
  const EVENT_UNINSTALL = "cupertino:net-uninstall";
  const EVENT_READY = "cupertino:net-ready";
  const EVENT_RECORD = "cupertino:net-record";

  const KINDS = ["fetch", "xhr", "console"];
  const DEFAULT_MAX_BODY = 10 * 1024 * 1024;
  const MAX_MAX_BODY = 50 * 1024 * 1024;
  const DEFAULT_ARM_MINUTES = 15;
  const MAX_ARM_MINUTES = 120;
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 500;

  /**
   * How much the buffer holds before it lets go of the oldest.
   *
   * Bodies are counted in CHARACTERS of what is stored — text as text, binary
   * as base64 — because that is what occupies memory here and what the server
   * pulls. Bodies go first, and their entries stay behind marked
   * `bodyEvicted`, because the record that a request happened (and its status)
   * is worth far more per byte than its body. Records go only past the count.
   */
  const MAX_RECORDS = 1000;
  const MAX_BODY_CHARS = 50 * 1024 * 1024;

  /**
   * Headers whose values never leave the page as they are.
   *
   * A plain copy of `REDACTED_HEADER` in packages/safari/src/client/network.ts
   * — a content script cannot import the server's module — and
   * test/network-buffer.test.ts asserts the two sources are identical, so they
   * cannot drift apart unnoticed. Applied here, at the point headers leave in
   * `netGet`, rather than when they arrive: the raw values cross from the hook
   * in the record, and the one place to stop them is the one door out.
   */
  const REDACTED_HEADER =
    /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api-key|apikey/i;

  // ── State, for this page load only ──────────────────────────────────────────

  let recording = false;
  /** Epoch ms after which `recording` turns itself off. Set whenever it is on. */
  let expiresAt = null;
  let options = normalize({});
  /** The hook's last word on itself, from `cupertino:net-ready`. */
  let hookInstalled = false;

  /** Oldest first, which is also seq order. */
  const entries = [];
  const byId = new Map();
  /**
   * The hook's `ref` → the entry its start record made, until the end arrives.
   * Only requests in flight live here, so it stays as small as the number of
   * requests the page has open at once.
   */
  const inFlight = new Map();
  const counters = { r: 0, t: 0, c: 0 };
  let seq = 0;
  let bodyChars = 0;
  const dropped = { records: 0, bodies: 0 };

  /** How far into `performance.getEntriesByType("resource")` has been read. */
  let timingIndex = 0;
  let timingStatusSeen = false;
  /**
   * URLs of hooked requests not yet matched by a resource-timing entry, with a
   * count each. See `ingestTiming`. Bounded, oldest URL first, because a page
   * whose timing buffer has filled (the browser keeps 250 by default) would
   * otherwise add a URL here for every request and never take one away.
   */
  const unmatched = new Map();

  // ── Small helpers ──────────────────────────────────────────────────────────

  function text(value) {
    return typeof value === "string" ? value : null;
  }

  function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  /** Null for anything `Date` cannot hold, rather than the RangeError it throws. */
  function iso(ms) {
    if (!Number.isFinite(ms)) return null;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function firstLine(value) {
    return typeof value === "string" ? value.split("\n")[0] : null;
  }

  /** Same clamp as the hook's, so the options reported are the options in force. */
  function normalize(raw) {
    const o = raw && typeof raw === "object" ? raw : {};
    const kinds = Array.isArray(o.kinds) ? o.kinds.filter((k) => KINDS.indexOf(k) !== -1) : KINDS;
    // `Number(null)` is 0, which would quietly record every body as empty.
    const max = o.maxBodyBytes == null ? NaN : Number(o.maxBodyBytes);
    return {
      kinds: kinds.slice(),
      captureBodies: o.captureBodies !== false,
      bodyFilter: typeof o.bodyFilter === "string" && o.bodyFilter !== "" ? o.bodyFilter : null,
      maxBodyBytes:
        Number.isFinite(max) && max >= 0 ? Math.min(max, MAX_MAX_BODY) : DEFAULT_MAX_BODY,
    };
  }

  function armMinutes(raw) {
    const m = Number(raw);
    return raw != null && Number.isFinite(m) && m > 0
      ? Math.min(m, MAX_ARM_MINUTES)
      : DEFAULT_ARM_MINUTES;
  }

  /**
   * Strings in, strings out, and no prototype — a header the page named
   * `__proto__` is then just a header, here and in the redacted copy.
   */
  function headerMap(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out = Object.create(null);
    for (const name of Object.keys(raw)) {
      if (typeof raw[name] === "string") out[name] = raw[name];
    }
    return out;
  }

  function redact(headers) {
    const out = Object.create(null);
    for (const name of Object.keys(headers)) {
      const value = headers[name];
      out[name] = REDACTED_HEADER.test(name) ? "<redacted: " + value.length + " chars>" : value;
    }
    return out;
  }

  /** A body from the hook, kept only if it has the shape the hook sends. */
  function bodyOf(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.data !== "string") return null;
    const encoding = raw.encoding;
    if (encoding !== "text" && encoding !== "base64" && encoding !== "summary") return null;
    return {
      encoding,
      data: raw.data,
      bytes: number(raw.bytes),
      truncated: raw.truncated === true,
      totalBytes: number(raw.totalBytes),
    };
  }

  /** The URL as two records of the same request would both spell it. */
  function urlKey(url) {
    const hash = url.indexOf("#");
    return hash === -1 ? url : url.slice(0, hash);
  }

  function dispatch(name, payload) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload) }));
    } catch {
      // No hook to tell is the same as a hook that did not hear.
    }
  }

  function staleError(id) {
    return (
      (id ? "Request " + id + " was" : "That was") +
      " recorded by a page load that has since gone (reloaded, navigated or closed); list again."
    );
  }

  // ── Armed or not ───────────────────────────────────────────────────────────

  /**
   * Is a record wanted right now? Asked on EVERY event, not on a timer, so the
   * expiry is exact and costs nothing while nothing happens.
   *
   * Expiring is the same as `stop`, minus clearing anything: the flag goes, so
   * the next load is not armed, and the hook is told to unwrap, so a tab left
   * armed by an agent that never came back stops recording on its own. The
   * uninstall is dispatched on the next tick because this usually runs inside
   * the hook's own dispatch of a record, and the hook ignores anything it is
   * asked while it is emitting.
   */
  function armed() {
    if (recording && expiresAt != null && Date.now() >= expiresAt) {
      recording = false;
      expiresAt = null;
      try {
        sessionStorage.removeItem(FLAG_KEY);
      } catch {
        // Storage gone; the flag carries its own expiry anyway.
      }
      setTimeout(() => dispatch(EVENT_UNINSTALL, {}), 0);
    }
    return recording;
  }

  // ── The buffer ─────────────────────────────────────────────────────────────

  function charsOf(entry) {
    if (entry.kind !== "fetch" && entry.kind !== "xhr") return 0;
    const r = entry.rec;
    return (r.requestBody ? r.requestBody.data.length : 0) + (r.body ? r.body.data.length : 0);
  }

  function recount(entry) {
    const chars = charsOf(entry);
    bodyChars += chars - entry.chars;
    entry.chars = chars;
  }

  function add(prefix, kind, rec) {
    counters[prefix]++;
    seq++;
    const entry = {
      id: PAGE + "-" + prefix + counters[prefix],
      seq,
      kind,
      rec,
      chars: 0,
      evicted: false,
      gone: false,
    };
    entries.push(entry);
    byId.set(entry.id, entry);
    recount(entry);
    while (entries.length > MAX_RECORDS) {
      const oldest = entries.shift();
      byId.delete(oldest.id);
      bodyChars -= oldest.chars;
      // Marked rather than forgotten, so a late end record for it is
      // recognised and dropped instead of coming back as a new entry.
      oldest.gone = true;
      dropped.records++;
    }
    return entry;
  }

  /**
   * Let go of bodies, oldest first, until the total fits.
   *
   * `keep` is the entry that just grew, and it is never the one let go. With
   * the 50 MiB cap and a 50 MiB `maxBodyBytes`, one binary body is 67 M
   * characters of base64 on its own, and evicting it on arrival would make the
   * largest download the one that can never be read — the exact file someone
   * raised the cap for. So the newest body may overshoot the cap alone, and
   * everything older makes room for it.
   *
   * The body's text goes, its size and truncation stay: the entry still says
   * how big it was, just not what it said.
   */
  function evictBodies(keep) {
    while (bodyChars > MAX_BODY_CHARS) {
      const victim = entries.find((e) => e.chars > 0 && e !== keep);
      if (!victim) return;
      const r = victim.rec;
      if (r.requestBody) r.requestBody = Object.assign({}, r.requestBody, { data: "" });
      if (r.body) r.body = Object.assign({}, r.body, { data: "" });
      bodyChars -= victim.chars;
      victim.chars = 0;
      victim.evicted = true;
      dropped.bodies++;
    }
  }

  function requestRecord(raw) {
    const method = text(raw.method);
    return {
      method: method ? method.toUpperCase() : null,
      url: text(raw.url) || "",
      startedAt: number(raw.startedAt) ?? Date.now(),
      requestHeaders: headerMap(raw.requestHeaders),
      requestBody: bodyOf(raw.requestBody),
      status: number(raw.status),
      statusText: text(raw.statusText),
      responseHeaders: headerMap(raw.responseHeaders),
      contentType: text(raw.contentType),
      durationMs: number(raw.durationMs),
      error: text(raw.error),
      body: bodyOf(raw.body),
      ended: raw.phase === "end",
    };
  }

  /**
   * A fetch or XHR record: a start makes the entry, the end with the same
   * `ref` replaces its contents. The hook sends the end as the whole record,
   * request side included, so replacing loses nothing.
   *
   * An end with no start on file still makes an entry — the start may have
   * been dropped by a page listener, or arrived before this was armed — since
   * the end alone says everything the start did and more. An end for an entry
   * that was dropped from the buffer is dropped too: it would otherwise
   * reappear as the newest entry under a new id.
   *
   * An entry whose bodies were evicted while it was still in flight takes no
   * bodies from its end either. `bodyEvicted` then keeps meaning one thing.
   */
  function addRequest(raw) {
    const rec = requestRecord(raw);
    const ref = number(raw.ref);
    const open = ref == null ? undefined : inFlight.get(ref);
    if (open) {
      if (rec.ended) inFlight.delete(ref);
      if (open.gone) return;
      if (open.evicted) {
        rec.requestBody = open.rec.requestBody;
        rec.body = rec.body ? Object.assign({}, rec.body, { data: "" }) : null;
      }
      open.rec = rec;
      recount(open);
      evictBodies(open);
      return;
    }
    const entry = add("r", raw.kind, rec);
    if (!rec.ended && ref != null) inFlight.set(ref, entry);
    const key = urlKey(rec.url);
    unmatched.set(key, (unmatched.get(key) || 0) + 1);
    if (unmatched.size > MAX_RECORDS) unmatched.delete(unmatched.keys().next().value);
    evictBodies(entry);
  }

  function addConsole(raw) {
    add("c", "console", {
      level: text(raw.level) || "error",
      message: text(raw.message) || "",
      stack: text(raw.stack),
      startedAt: number(raw.startedAt) ?? Date.now(),
    });
  }

  function onRecord(event) {
    try {
      if (!armed()) return;
      const raw = typeof event.detail === "string" ? JSON.parse(event.detail) : null;
      if (!raw || typeof raw !== "object") return;
      // Only the kinds asked for, whatever the page dispatches.
      if (options.kinds.indexOf(raw.kind) === -1) return;
      if (raw.kind === "console") addConsole(raw);
      else addRequest(raw);
    } catch {
      // A record that cannot be read is a record lost, never an error here.
    }
  }

  function onReady(event) {
    try {
      const detail = typeof event.detail === "string" ? JSON.parse(event.detail) : null;
      // The hook says this after an install AND after an uninstall, so the
      // last one heard is simply the truth.
      hookInstalled = !!(detail && detail.installed === true);
    } catch {
      // Unreadable: keep the last word.
    }
  }

  // ── Resource timing ────────────────────────────────────────────────────────

  function timeOrigin() {
    return typeof performance.timeOrigin === "number"
      ? performance.timeOrigin
      : Date.now() - performance.now();
  }

  /**
   * One `PerformanceResourceTiming` entry, unless a hooked record already
   * covers it.
   *
   * The browser makes a timing entry for every request, the page's own
   * fetches included, so without this a hooked fetch would be listed twice:
   * once with its body and once without. A timing entry for a fetch or XHR
   * whose URL a hooked record had is that same request, and it consumes one
   * count from `unmatched`; the count rather than the URL alone, so a URL
   * fetched once while armed and once not is listed once, not zero times.
   *
   * `responseStatus` is new (Safari support unmeasured until Task 7), so a
   * missing property is `null` — unknown — and never 0. A 0 from a browser
   * that has it means a cross-origin response it will not describe, which is
   * unknown too.
   */
  function ingestTiming(t) {
    const url = String(t.name);
    const hasStatus = "responseStatus" in t;
    if (hasStatus) timingStatusSeen = true;
    if (t.initiatorType === "fetch" || t.initiatorType === "xmlhttprequest") {
      const key = urlKey(url);
      const n = unmatched.get(key);
      if (n) {
        if (n > 1) unmatched.set(key, n - 1);
        else unmatched.delete(key);
        return;
      }
    }
    const status = hasStatus ? number(t.responseStatus) : null;
    const decoded = number(t.decodedBodySize);
    add("t", "resource", {
      url,
      status: status ? status : null,
      startedAt: timeOrigin() + Number(t.startTime),
      durationMs: number(t.duration) == null ? null : Math.round(t.duration),
      // 0 is also what a cross-origin entry without Timing-Allow-Origin
      // reports, so it says nothing about the body.
      responseBytes: decoded ? decoded : null,
    });
  }

  /**
   * Read the timing entries this script has not seen yet, whether or not
   * recording is armed: they cost nothing to collect, the browser keeps them
   * anyway, and they are the answer to "what did this page load" on a tab
   * nobody armed.
   *
   * A list SHORTER than the index means the page called
   * `performance.clearResourceTimings()`, and everything in it is new.
   */
  function ingestTimings() {
    let list;
    try {
      list = performance.getEntriesByType("resource");
    } catch {
      return;
    }
    if (!list || typeof list.length !== "number") return;
    if (list.length < timingIndex) timingIndex = 0;
    for (; timingIndex < list.length; timingIndex++) {
      try {
        ingestTiming(list[timingIndex]);
      } catch {
        // One odd entry is skipped, not the rest.
      }
    }
  }

  function timingStatusSupported() {
    if (timingStatusSeen) return true;
    try {
      return (
        typeof PerformanceResourceTiming === "function" &&
        "responseStatus" in PerformanceResourceTiming.prototype
      );
    } catch {
      return false;
    }
  }

  // ── What leaves ────────────────────────────────────────────────────────────

  /**
   * The size of a response body, as best it is known: the full size when the
   * hook knew it, what was kept when nothing was cut, and Content-Length when
   * no body was captured at all.
   */
  function responseBytes(r) {
    if (r.body) return r.body.totalBytes ?? (r.body.truncated ? null : r.body.bytes);
    const declared = r.responseHeaders ? Number(r.responseHeaders["content-length"]) : NaN;
    return Number.isFinite(declared) && r.responseHeaders["content-length"] !== ""
      ? declared
      : null;
  }

  /** The list's view of an entry. Metadata only, never a body. */
  function view(e) {
    const r = e.rec;
    if (e.kind === "console") {
      return {
        id: e.id,
        seq: e.seq,
        kind: "console",
        level: r.level,
        message: r.message,
        stack: firstLine(r.stack),
        startedAt: iso(r.startedAt),
      };
    }
    if (e.kind === "resource") {
      return {
        id: e.id,
        seq: e.seq,
        kind: "resource",
        method: null,
        url: r.url,
        status: r.status,
        statusText: null,
        ok: r.status == null ? null : r.status >= 200 && r.status < 300,
        error: null,
        startedAt: iso(r.startedAt),
        durationMs: r.durationMs,
        requestBytes: null,
        responseBytes: r.responseBytes,
        contentType: null,
        bodyAvailable: false,
        bodyTruncated: false,
        bodyEvicted: false,
      };
    }
    return {
      id: e.id,
      seq: e.seq,
      kind: e.kind,
      method: r.method,
      url: r.url,
      status: r.status,
      statusText: r.statusText,
      // `Response.ok`'s meaning. Null while in flight: not yet either.
      ok: r.ended ? r.error == null && r.status != null && r.status >= 200 && r.status < 300 : null,
      error: r.error,
      startedAt: iso(r.startedAt),
      durationMs: r.durationMs,
      requestBytes: r.requestBody ? r.requestBody.bytes : null,
      responseBytes: responseBytes(r),
      contentType: r.contentType,
      bodyAvailable: !!r.body && !e.evicted,
      bodyTruncated: !!r.body && r.body.truncated,
      bodyEvicted: e.evicted,
    };
  }

  function failed(v) {
    return (
      v.error != null ||
      (v.status != null && v.status >= 400) ||
      (v.kind === "console" && v.level === "error")
    );
  }

  /**
   * Every filter narrows. A filter on something an entry does not have — a
   * status on a console line, a method on a resource-timing entry — leaves
   * that entry out rather than letting it through by default.
   */
  function matches(v, f) {
    if (typeof f.kind === "string" && f.kind && v.kind !== f.kind) return false;
    if (typeof f.urlContains === "string" && f.urlContains) {
      if (typeof v.url !== "string" || v.url.indexOf(f.urlContains) === -1) return false;
    }
    if (typeof f.method === "string" && f.method) {
      if (v.method !== f.method.toUpperCase()) return false;
    }
    const min = number(f.statusMin);
    const max = number(f.statusMax);
    if (min != null && !(v.status != null && v.status >= min)) return false;
    if (max != null && !(v.status != null && v.status <= max)) return false;
    if (f.failed === true && !failed(v)) return false;
    if (f.failed === false && failed(v)) return false;
    return true;
  }

  /**
   * An id from this page's buffer, or the reason it is not one.
   *
   * Three different misses, three different answers: an id from another page
   * load (gone with it), an id this load handed out and has since let go of
   * (evicted or cleared), and an id it never handed out at all.
   */
  function lookup(id) {
    const m = ID_SHAPE.exec(id);
    if (!m) return { error: '"' + id + '" is not a request id from network_list.' };
    if (m[1] !== PAGE) return { error: staleError(id) };
    const entry = byId.get(id);
    if (entry) return { entry };
    if (Number(m[3]) <= counters[m[2]]) {
      return {
        error:
          "no request " +
          id +
          " on this page any more: it was dropped from the buffer to make room, or cleared. List again.",
        issued: true,
      };
    }
    return { error: "no request " + id + " on this page." };
  }

  function state() {
    armed();
    let bodies = 0;
    let bytes = 0;
    for (const e of entries) {
      if (e.chars === 0) continue;
      bodies++;
      const r = e.rec;
      bytes += (r.requestBody && r.requestBody.bytes) || 0;
      bytes += (r.body && r.body.bytes) || 0;
    }
    return {
      recording,
      page: PAGE,
      expiresAt: recording ? iso(expiresAt) : null,
      options: normalize(options),
      counts: { records: entries.length, bodies, bodyBytes: bytes },
      dropped: { records: dropped.records, bodies: dropped.bodies },
      hook: { installed: hookInstalled },
      resourceStatusSupported: timingStatusSupported(),
    };
  }

  // ── The three commands ─────────────────────────────────────────────────────

  /**
   * `start` arms this page AND the next loads of this tab, until the expiry.
   *
   * The flag in `sessionStorage` is what carries arming across a reload: the
   * hook reads it at `document_start` and wraps before any page script runs,
   * and this script reads it to know it should be keeping what arrives. It is
   * per tab and per origin, so it re-arms every load of the same site in the
   * window — the reload → redirect → login → app flow — and nothing elsewhere.
   *
   * A reload is scheduled, never done in place. `location.reload()` ends this
   * script's world, and the answer to `start` would end with it: the server
   * would time out on a command that worked. Fifty milliseconds is long enough
   * for `content.js` to post the result and short enough that nobody notices.
   * And when the flag could not be written there is no reload at all, because
   * the page would come back unarmed and the caller would see an empty list
   * with no reason for it.
   */
  function start(command) {
    options = normalize(command);
    expiresAt = Date.now() + armMinutes(command.armMinutes) * 60000;
    recording = true;
    let flagWritten = true;
    try {
      sessionStorage.setItem(FLAG_KEY, JSON.stringify(Object.assign({ expiresAt }, options)));
    } catch {
      flagWritten = false;
    }
    dispatch(EVENT_INSTALL, options);
    if (command.reload === true && !flagWritten) {
      return {
        ok: false,
        error:
          "Recording is on for this page as it is, but this tab's sessionStorage refused the arm " +
          "flag, so a reload would come back unrecorded. It was not reloaded.",
      };
    }
    const result = { ok: true, data: state() };
    if (command.reload === true) {
      setTimeout(() => {
        try {
          location.reload();
        } catch {
          // The page refused; the answer has already said "armed".
        }
      }, 50);
    }
    return result;
  }

  /** Disarm this page and the next loads. What was recorded stays readable. */
  function stop() {
    recording = false;
    expiresAt = null;
    try {
      sessionStorage.removeItem(FLAG_KEY);
    } catch {
      // Nothing to remove, or no storage to remove it from.
    }
    dispatch(EVENT_UNINSTALL, {});
  }

  /**
   * Empty the buffer. The id counters do NOT restart: `-r1` after a clear
   * would name a different request than the `-r1` a caller may still hold.
   *
   * In-flight requests are forgotten too, so their ends make fresh entries:
   * they finished after the clear, and that is when the caller asked to start
   * looking. Timing entries already read stay read, so a clear is a clean
   * slate rather than a replay of everything the page loaded so far.
   */
  function clear() {
    entries.length = 0;
    byId.clear();
    inFlight.clear();
    bodyChars = 0;
    dropped.records = 0;
    dropped.bodies = 0;
  }

  function netRecord(command) {
    ingestTimings();
    switch (command.op) {
      case "start":
        return start(command);
      case "stop":
        stop();
        return { ok: true, data: state() };
      case "clear":
        clear();
        return { ok: true, data: state() };
      case "status":
        return { ok: true, data: state() };
      default:
        return {
          ok: false,
          error:
            'Unknown netRecord op "' + command.op + '"; expected start, stop, clear or status.',
        };
    }
  }

  /**
   * Metadata, oldest first, after a cursor.
   *
   * The cursor is an entry id rather than an offset, because the buffer drops
   * from the front and an offset would skip whatever slid under it. A cursor
   * whose entry has since been dropped or cleared still works: everything
   * left is newer than it, since nothing is ever dropped from the middle.
   *
   * An entry is listed where it STARTED. A request still in flight at one list
   * is not listed again after the cursor once it ends; get it by id.
   */
  function netList(command) {
    ingestTimings();
    const filter = command.filter && typeof command.filter === "object" ? command.filter : {};
    const limit = Math.min(
      Math.max(1, Math.floor(Number(command.limit)) || DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    let after = 0;
    if (command.after != null && command.after !== "") {
      const found = lookup(String(command.after));
      if (found.entry) after = found.entry.seq;
      else if (!found.issued) return { ok: false, error: found.error };
    }
    const out = [];
    let next = null;
    for (const e of entries) {
      if (e.seq <= after) continue;
      const v = view(e);
      if (!matches(v, filter)) continue;
      if (out.length === limit) {
        next = out[out.length - 1].id;
        break;
      }
      out.push(v);
    }
    return {
      ok: true,
      data: {
        recording: armed(),
        page: PAGE,
        entries: out,
        next,
        dropped: { records: dropped.records, bodies: dropped.bodies },
      },
    };
  }

  /**
   * One slice of one body, and the headers when asked.
   *
   * A slice rather than the body, because a 10 MB response does not fit in one
   * native message; the server asks for `length` characters at a time and
   * stops at `done`. Offsets are in characters of the stored string — text, or
   * base64 for binary — which is what the server reassembles. A summary body
   * (FormData, an oversized request body) is JSON text and pages the same way.
   */
  function netGet(command) {
    const found = lookup(String(command.id ?? ""));
    if (!found.entry) return { ok: false, error: found.error };
    const entry = found.entry;
    const request = command.part === "request";
    let body = null;
    let headers = null;
    if (entry.kind === "fetch" || entry.kind === "xhr") {
      body = entry.evicted ? null : request ? entry.rec.requestBody : entry.rec.body;
      headers = request ? entry.rec.requestHeaders : entry.rec.responseHeaders;
    }
    const data = body ? body.data : "";
    const total = data.length;
    const offset = Math.min(Math.max(0, Math.floor(Number(command.offset)) || 0), total);
    const asked = Math.floor(Number(command.length));
    const length = asked > 0 ? asked : total - offset;
    const slice = data.slice(offset, offset + length);
    const out = {
      entry: view(entry),
      encoding: body ? body.encoding : null,
      totalChars: total,
      offset,
      slice,
      done: offset + slice.length >= total,
    };
    if (command.headers !== false && headers) out.headers = redact(headers);
    return { ok: true, data: out };
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  window.cupertinoNetwork = {
    /** Never throws; see the header. */
    run(command) {
      try {
        if (!command || typeof command !== "object") {
          return { ok: false, error: "No command." };
        }
        switch (command.action) {
          case "netRecord":
            return netRecord(command);
          case "netList":
            return netList(command);
          case "netGet":
            return netGet(command);
          default:
            return { ok: false, error: 'Unknown network action "' + command.action + '".' };
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
  };

  try {
    document.addEventListener(EVENT_RECORD, onRecord);
    document.addEventListener(EVENT_READY, onReady);
  } catch {
    // No document: nothing will arrive, and every answer says so by being empty.
  }

  // ── At load: the arm flag ──────────────────────────────────────────────────
  //
  // The hook reads the same flag and wraps on its own; this only decides that
  // what it sends is wanted. The flag is left for the hook to delete when it
  // has expired, since it is the one that must not act on it.
  //
  // The install event re-sent here is for the hook's `ready` answer. Both
  // scripts run at `document_start` in two worlds, in no promised order: if
  // the hook ran first, its "installed" went out before anything here was
  // listening, and `status` would report a hook that is not there. Installing
  // an installed hook only re-applies the same options and answers again; if
  // the hook has not run yet, nobody hears this and it arms itself from the
  // flag when it does.
  //
  // The page can write this flag too (see the header), so its expiry is capped
  // at `MAX_ARM_MINUTES` from now, and a capped flag is stored back capped:
  // the hook never re-reads it on this load, but the next load must not find
  // the uncapped one and start the clock over from there.
  try {
    const raw = sessionStorage.getItem(FLAG_KEY);
    if (raw != null) {
      const flag = JSON.parse(raw);
      if (flag && typeof flag === "object" && Number(flag.expiresAt) > Date.now()) {
        const latest = Date.now() + MAX_ARM_MINUTES * 60000;
        options = normalize(flag);
        expiresAt = Math.min(Number(flag.expiresAt), latest);
        recording = true;
        if (Number(flag.expiresAt) > latest) {
          try {
            sessionStorage.setItem(
              FLAG_KEY,
              JSON.stringify(Object.assign({}, flag, { expiresAt })),
            );
          } catch {
            // Unwritable: this load still stops at the cap; the next caps again.
          }
        }
        dispatch(EVENT_INSTALL, options);
      }
    }
  } catch {
    // Storage disabled, or a flag that does not parse: not armed.
  }
})();
