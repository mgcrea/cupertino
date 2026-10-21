// Records a page's own network traffic and console errors, from inside the page.
//
// ## Why this runs in the page's world
//
// Safari gives a Web Extension no `webRequest` body access and no debugger
// protocol: the only place a response body is visible is the JavaScript that
// asked for it. So the recorder runs in the page's own world — the page's own
// globals, not the isolated world `actions.js` and `content.js` live in — where
// `fetch` and `XMLHttpRequest` are the very functions the page calls. It wraps
// them, and hands what it sees to `network.js` in the isolated world, which
// owns the buffer and answers the server. See docs/superpowers/specs/
// 2026-10-20-safari-network-design.md.
//
// ## How it gets there
//
// Not through the manifest. Safari ignores `"world": "MAIN"` there and in
// `scripting.registerContentScripts`: on the notarized build of 385bb73 both
// copies ran in the isolated world, `window.__cupertinoNetHook` was undefined
// in the page and `fetch` was native. So this file is a content script for a
// different reason — it is the SOURCE PROVIDER. Loaded into the isolated world,
// it wraps nothing and leaves `window.cupertinoNetHookSource`, the recorder as
// a string, which `network.js` puts into the page as an inline `<script>` once
// the tab is armed (or, when the page's Content-Security-Policy refuses inline
// scripts, loads this same file by URL, where it finds itself in the page and
// runs). The recorder is `cupertinoNetHookMain` below, and it must stand
// alone; see the comment on it.
//
// ## The one rule: the page must never notice
//
// Being in the page's world means sharing its fate. A wrapper that returned a
// different object, added an `await` in front of the page's `.then`, consumed a
// body the page was about to read, or let one of its own exceptions escape
// would break the site the user is looking at — and a recorder that breaks what
// it records is worse than none. So every wrapper below has the same shape:
// call the original exactly as the page did, return exactly what it returned,
// rethrow exactly what it threw, and do all recording off to the side inside a
// `try` whose `catch` gives up on that one record and nothing else.
//
// ## Dormant until armed
//
// Nothing is wrapped on a tab nobody armed, and since the injection moved to
// `network.js`, nothing is even put into its page: that happens only under an
// unexpired arm flag at load, or on `netRecord start`. Once in the page this
// still only listens for `cupertino:net-install`, unless this tab's
// `sessionStorage` carries the arm flag — the one `start` writes so a reload
// can be recorded from its first request. An inline injection at load runs
// inside `network.js`'s `document_start`, before any page script, so a
// reference a page takes to `fetch` is the wrapped one; arming later only sees
// calls that look `fetch` up after the fact, and so does the `src` fallback,
// which arrives whenever the browser gets round to loading it.
//
// ## Talking to the isolated world
//
// The two worlds share the DOM and nothing else, so records cross as
// CustomEvents on `document` whose `detail` is a JSON STRING. A string, because
// whether Safari carries a structured object across worlds intact is exactly
// the kind of thing that changes between releases, and a string has only one
// way to arrive. Measured on Safari 26: a string `detail` crosses both ways.
// The page can see and forge these events; that is acceptable, since
// everything they carry is the page's own traffic, and `network.js` drops
// records while it is not armed whatever the page dispatches.

(function () {
  /**
   * The whole recorder, as one function whose source IS the page script.
   *
   * Safari ignores `"world": "MAIN"` — in the manifest and in
   * `scripting.registerContentScripts` alike, measured on the notarized build
   * of 385bb73 — so no extension API puts this file in the page. `network.js`
   * does it instead, as a `<script>` element whose text is this function's
   * `toString()`. That only works if the function stands alone: everything it
   * uses is declared inside it, and nothing it touches lives in the file
   * around it, because the copy that runs in the page has no file around it.
   * A file-level constant would be a ReferenceError there, and only on the
   * path that reads it.
   *
   * The same reason switches off the lint rule that would hoist its pure
   * helpers out to the file: hoisted, they would be missing from the source.
   */
  // oxlint-disable unicorn/consistent-function-scoping -- the injected source must be self-contained.
  function cupertinoNetHookMain() {
    // A second copy in the page would wrap the wrappers and record every
    // request twice. That happens when the inline injection ran and a `src`
    // load arrives too, or when a future Safari honours MAIN for the manifest
    // copy as well. The first one wins. Non-enumerable so it stays out of the
    // page's way.
    const GUARD = "__cupertinoNetHook";
    try {
      if (window[GUARD]) return;
      Object.defineProperty(window, GUARD, { value: true });
    } catch {
      return;
    }

    // Every copy answers `cupertino:net-ping`, so `network.js` can tell a hook
    // that is in the page from one that never arrived: its own load-time
    // `net-ready` may fire before anything is listening. Claimed above, so a
    // second copy returned before this line and never answers twice.
    const EVENT_PING = "cupertino:net-ping";
    try {
      document.addEventListener(EVENT_PING, () => {
        try {
          document.dispatchEvent(
            new CustomEvent("cupertino:net-ready", {
              detail: JSON.stringify({ installed, world: "main" }),
            }),
          );
        } catch {
          // A reply that cannot be sent is a ping unanswered, never a page error.
        }
      });
    } catch {
      // No document to listen on: nothing can ask, which is the safe way to fail.
    }

    const FLAG_KEY = "__cupertino_net";
    const EVENT_INSTALL = "cupertino:net-install";
    const EVENT_UNINSTALL = "cupertino:net-uninstall";
    const EVENT_READY = "cupertino:net-ready";
    const EVENT_RECORD = "cupertino:net-record";
    const KINDS = ["fetch", "xhr", "console"];
    const DEFAULT_MAX_BODY = 10 * 1024 * 1024;
    const MAX_MAX_BODY = 50 * 1024 * 1024;

    /**
     * How much of one console message to keep.
     *
     * A page that logs a 2 MB state tree on every warning would otherwise put
     * 2 MB into the buffer per warning, and a console record has no body cap of
     * its own. Ten thousand characters is far past any message a person reads.
     */
    const MAX_MESSAGE = 10000;

    /**
     * The native XHR prototype, taken before any page script can replace
     * `window.XMLHttpRequest`. Libraries that wrap XHR do it with a class that
     * still calls the native methods underneath, so patching these three is what
     * sees their requests too — patching whatever `window.XMLHttpRequest` is at
     * arm time would miss them.
     */
    const XHR_PROTO =
      typeof XMLHttpRequest === "function" && XMLHttpRequest.prototype
        ? XMLHttpRequest.prototype
        : null;

    let installed = false;
    let options = normalize({});

    /** Per-request counter, the `ref` that lets `network.js` pair a start with its end. */
    let nextRef = 1;

    /**
     * True while a record is being handed over. Anything that dispatches
     * synchronously can run code inside the dispatch — a page listener on our
     * event, an error reported out of a listener — and if that code logs or
     * fetches, recording it would dispatch again, inside itself, forever. So
     * nothing is recorded while a record is in flight. What is lost is only what
     * happens during our own dispatch.
     */
    let emitting = false;

    function emit(name, payload) {
      if (emitting) return;
      emitting = true;
      try {
        document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload) }));
      } catch {
        // A record that cannot be serialised or dispatched is a record lost,
        // never an error in the page.
      } finally {
        emitting = false;
      }
    }

    function wants(kind) {
      return installed && !emitting && options.kinds.indexOf(kind) !== -1;
    }

    /** Clamp whatever arrived — from a flag the page can edit, or an event it can forge. */
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

    /** Bodies are kept only for URLs the filter matches; metadata for every request. */
    function wantsBody(url) {
      return (
        options.captureBodies && (!options.bodyFilter || url.indexOf(options.bodyFilter) !== -1)
      );
    }

    const now =
      typeof performance !== "undefined" && performance && typeof performance.now === "function"
        ? () => performance.now()
        : () => Date.now();

    // ── Small pure helpers ─────────────────────────────────────────────────────

    /**
     * `[object Blob]` and friends, rather than `instanceof`. A body made in
     * another frame has another frame's constructors, and `instanceof` answers
     * false for it; the tag does not care which realm built the object.
     */
    function tag(value) {
      return Object.prototype.toString.call(value).slice(8, -1);
    }

    function absolute(url) {
      try {
        return new URL(String(url), location.href).href;
      } catch {
        return String(url);
      }
    }

    /**
     * Any of the shapes `fetch` accepts for headers, as a plain object with
     * lowercased names. Repeated names are joined the way `Headers.get` joins
     * them. No prototype, so a header named `constructor` is just a header.
     */
    function headerObject(h) {
      const out = Object.create(null);
      if (!h) return out;
      const add = (name, value) => {
        const key = String(name).toLowerCase();
        out[key] = key in out ? out[key] + ", " + String(value) : String(value);
      };
      if (Array.isArray(h)) {
        for (const pair of h) if (pair && pair.length >= 2) add(pair[0], pair[1]);
      } else if (typeof h.forEach === "function") {
        h.forEach((value, name) => add(name, value));
      } else if (typeof h === "object") {
        for (const name of Object.keys(h)) add(name, h[name]);
      }
      return out;
    }

    /** `getAllResponseHeaders()`'s CRLF block, as the same kind of object. */
    function parseRawHeaders(raw) {
      const out = Object.create(null);
      for (const line of String(raw || "").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i <= 0) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        const value = line.slice(i + 1).trim();
        out[key] = key in out ? out[key] + ", " + value : value;
      }
      return out;
    }

    /**
     * Text-like content types become text; everything else stays bytes and
     * travels as base64. Getting this wrong in the text direction is the costly
     * one — a PDF decoded as UTF-8 cannot be turned back into the PDF — so
     * anything unrecognised, including a missing type, is treated as binary. The
     * server sniffs base64 bodies anyway.
     *
     * Matched on the media type's parts, never on words anywhere in the header.
     * The first version tested for "xml" as a substring, and every Office file
     * is `application/vnd.openxmlformats-officedocument.…`: an .xlsx is a zip,
     * and a zip decoded as UTF-8 cannot be put back together. So parameters are
     * dropped, and text means a `text/*` type, a subtype that IS one of the
     * text formats (with the legacy `x-` prefix allowed), or a structured
     * `+json`/`+xml` suffix such as `application/problem+json`.
     */
    const TEXT_SUBTYPE = /^(?:(?:x-)?(?:json|xml|javascript|ecmascript)|x-www-form-urlencoded)$/;
    const TEXT_SUFFIX = /\+(?:json|xml)$/;

    function textLike(contentType) {
      const essence = String(contentType || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const slash = essence.indexOf("/");
      if (slash <= 0) return false;
      const type = essence.slice(0, slash);
      const subtype = essence.slice(slash + 1);
      return type === "text" || TEXT_SUBTYPE.test(subtype) || TEXT_SUFFIX.test(subtype);
    }

    function charsetOf(contentType) {
      const m = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType || "");
      return m ? m[1] : "utf-8";
    }

    /**
     * Decode with the response's declared charset, falling back to UTF-8 for a
     * label the browser does not know. `stream: true` makes a decoder hold back a
     * multi-byte character cut in half at the cap rather than emitting a
     * replacement character for it, which is what a truncated body wants.
     */
    function decodeText(bytes, contentType, cut) {
      let decoder;
      try {
        decoder = new TextDecoder(charsetOf(contentType));
      } catch {
        decoder = new TextDecoder();
      }
      return decoder.decode(bytes, { stream: !!cut });
    }

    function utf8(text) {
      return new TextEncoder().encode(text);
    }

    /**
     * Bytes to base64 without one `String.fromCharCode` call per byte, and
     * without spreading a 10 MB array into one call's arguments either, which
     * overflows the stack. 32 KB at a time sits comfortably under every engine's
     * argument limit.
     */
    function base64(bytes) {
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(binary);
    }

    /**
     * One response body, from however many of its bytes were read.
     *
     * `bytes` may be longer than the cap — a stream-less read gets everything —
     * and is cut here. `totalBytes` is the full size when anything knows it: the
     * whole read when it was not cut, otherwise whatever the caller learned
     * (Content-Length, a Blob's size), or null.
     */
    function bodyFromBytes(bytes, contentType, cap, cutAlready, totalBytes) {
      const cut = cutAlready || bytes.length > cap;
      const kept = bytes.length > cap ? bytes.subarray(0, cap) : bytes;
      const total = cut
        ? totalBytes != null && totalBytes > kept.length
          ? totalBytes
          : null
        : kept.length;
      return textLike(contentType)
        ? {
            encoding: "text",
            data: decodeText(kept, contentType, cut),
            bytes: kept.length,
            truncated: cut,
            totalBytes: total,
          }
        : {
            encoding: "base64",
            data: base64(kept),
            bytes: kept.length,
            truncated: cut,
            totalBytes: total,
          };
    }

    /** A body that is already a string (XHR text, JSON re-serialised). Always text. */
    function bodyFromString(text, cap) {
      const encoded = utf8(text);
      if (encoded.length <= cap) {
        return {
          encoding: "text",
          data: text,
          bytes: encoded.length,
          truncated: false,
          totalBytes: encoded.length,
        };
      }
      const kept = encoded.subarray(0, cap);
      return {
        encoding: "text",
        data: new TextDecoder().decode(kept, { stream: true }),
        bytes: kept.length,
        truncated: true,
        totalBytes: encoded.length,
      };
    }

    /**
     * The request body as it was handed to `fetch` or `send`, best-effort.
     *
     * Returns `{now, later}`: `now` goes in the start record, and `later`, when
     * set, is a promise for a better answer the end record carries instead. Only
     * a Blob needs one, because reading a Blob is asynchronous and the start
     * record must not wait for it.
     *
     * Every shape follows one rule: content when it fits under the body cap, a
     * summary when it does not or cannot be read without consuming something the
     * page still needs (a ReadableStream). `data` is always a string — a summary
     * is JSON text — so the isolated world can page through any body the same
     * way. FormData is summarised by field names and file metadata, never its
     * values, as the design says.
     */
    function requestBody(body, cap) {
      if (body == null) return { now: null, later: null };
      if (typeof body === "string") {
        const n = utf8(body).length;
        return {
          now:
            n <= cap
              ? { encoding: "text", data: body, bytes: n }
              : summary({ type: "text", size: n }, n),
          later: null,
        };
      }
      const kind = tag(body);
      if (kind === "URLSearchParams") {
        const text = String(body);
        const n = utf8(text).length;
        return {
          now:
            n <= cap
              ? { encoding: "text", data: text, bytes: n }
              : summary({ type: "text", size: n }, n),
          later: null,
        };
      }
      if (kind === "FormData") {
        const fields = [];
        body.forEach((value, name) => {
          const t = tag(value);
          fields.push(
            t === "File" || t === "Blob"
              ? {
                  name,
                  file: { name: value.name || null, size: value.size, type: value.type || "" },
                }
              : { name },
          );
        });
        return { now: summary(fields, null), later: null };
      }
      if (kind === "ArrayBuffer" || ArrayBuffer.isView(body)) {
        const bytes =
          kind === "ArrayBuffer"
            ? new Uint8Array(body)
            : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        return {
          now:
            bytes.length <= cap
              ? { encoding: "base64", data: base64(bytes), bytes: bytes.length }
              : summary({ type: kind, size: bytes.length }, bytes.length),
          later: null,
        };
      }
      if (kind === "Blob" || kind === "File") {
        const described = summary({ type: body.type || "", size: body.size }, body.size);
        if (body.size > cap || typeof body.arrayBuffer !== "function") {
          return { now: described, later: null };
        }
        // Reading a Blob consumes nothing: the page's Blob is still whole for
        // the request it is about to make.
        const later = body.arrayBuffer().then(
          (buf) => {
            const bytes = new Uint8Array(buf);
            return { encoding: "base64", data: base64(bytes), bytes: bytes.length };
          },
          () => described,
        );
        return { now: described, later };
      }
      return { now: summary({ type: kind }, null), later: null };
    }

    /** A request body described rather than carried. `data` is JSON text, like every other body's string. */
    function summary(value, bytes) {
      return {
        encoding: "summary",
        data: JSON.stringify(value),
        bytes: bytes == null ? null : bytes,
      };
    }

    function errorText(err) {
      try {
        if (err && typeof err === "object" && "message" in err) {
          return (err.name ? err.name + ": " : "") + String(err.message);
        }
        return String(err);
      } catch {
        return "Unknown error";
      }
    }

    function newRecord(kind, method, url) {
      return {
        kind,
        phase: "start",
        ref: nextRef++,
        method,
        url,
        startedAt: Date.now(),
        requestHeaders: Object.create(null),
        requestBody: null,
        status: null,
        statusText: null,
        responseHeaders: null,
        contentType: null,
        durationMs: null,
        error: null,
        body: null,
      };
    }

    /**
     * Send the end record once the request body (if it was a Blob still being
     * read) has caught up. `t0` is `now()` at the start, so the duration is
     * monotonic even if the clock is changed mid-request.
     */
    function finish(rec, t0, pendingRequestBody) {
      rec.phase = "end";
      rec.durationMs = Math.max(0, Math.round(now() - t0));
      const send = () => emit(EVENT_RECORD, rec);
      if (!pendingRequestBody) return send();
      pendingRequestBody.then((body) => {
        rec.requestBody = body;
        send();
      }, send);
    }

    // ── fetch ──────────────────────────────────────────────────────────────────

    /**
     * Read a body from a CLONE of the response, up to the cap.
     *
     * A clone is a tee: the page reads its branch, this reads the other, and
     * neither starves the other. With a stream, reading stops at one chunk past
     * the cap and the clone's branch is cancelled, which releases it without
     * touching the page's branch. Without one (older engines, or a stub), the
     * whole body is read and cut afterwards.
     */
    function readCapped(clone, cap) {
      const body = clone.body;
      if (body && typeof body.getReader === "function") {
        const reader = body.getReader();
        const chunks = [];
        let size = 0;
        const pump = () =>
          reader.read().then((step) => {
            if (step.done) return { bytes: concat(chunks, size), cut: false };
            chunks.push(step.value);
            size += step.value.length;
            if (size > cap) {
              try {
                reader.cancel().catch(() => {});
              } catch {
                // Already released; nothing to give back.
              }
              return { bytes: concat(chunks, size), cut: true };
            }
            return pump();
          });
        return pump();
      }
      return clone.arrayBuffer().then((buf) => ({ bytes: new Uint8Array(buf), cut: false }));
    }

    function concat(chunks, size) {
      const out = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    }

    /** Everything recorded once a fetch has its response. Never throws out of here. */
    function fetchSettled(rec, t0, pending, res) {
      try {
        rec.status = res.status;
        rec.statusText = res.statusText;
        rec.responseHeaders = headerObject(res.headers);
        rec.contentType = res.headers && res.headers.get ? res.headers.get("content-type") : null;
        if (!wantsBody(rec.url)) return finish(rec, t0, pending);

        const cap = options.maxBodyBytes;
        const declared = res.headers.get("content-length");
        const length = declared == null ? null : Number(declared);
        if (length != null && Number.isFinite(length) && length > cap) {
          // Too big to keep, and Content-Length already says so. Taking a clone
          // would make the browser hold the tee'd copy for as long as the page
          // takes to read its own, so a 1 GB download would cost 2 GB. Record
          // the size and nothing else.
          rec.body = {
            encoding: textLike(rec.contentType) ? "text" : "base64",
            data: "",
            bytes: 0,
            truncated: true,
            totalBytes: length,
          };
          return finish(rec, t0, pending);
        }

        // The clone is taken in the first `.then` on the fetch's own promise,
        // which this wrapper registered before the page ever saw that promise,
        // so it always runs before the page can start reading.
        const clone = res.clone();
        readCapped(clone, cap).then(
          (read) => {
            try {
              rec.body = bodyFromBytes(read.bytes, rec.contentType, cap, read.cut, length);
            } catch {
              rec.body = null;
            }
            finish(rec, t0, pending);
          },
          () => finish(rec, t0, pending),
        );
      } catch {
        // Whatever failed, the request still happened: send what is known.
        try {
          finish(rec, t0, pending);
        } catch {
          // Nothing left to do.
        }
      }
    }

    /**
     * The `fetch` that replaces the page's.
     *
     * It returns the original's promise ITSELF, not a promise chained from it:
     * a `.then` in between would add a microtask to every request the page
     * makes, and code that races two fetches or counts ticks would see it. The
     * recorder hangs its own `.then` off the side of that promise instead.
     *
     * `fetch.length` is 1 and so is this one's, for the scripts that check.
     */
    function makeFetch(inner) {
      return function fetch(input) {
        let rec = null;
        let t0 = 0;
        let pending = null;
        if (wants("fetch")) {
          try {
            const init = arguments.length > 1 && arguments[1] ? arguments[1] : null;
            const isRequest = tag(input) === "Request";
            const method = String(
              (init && init.method) || (isRequest ? input.method : "") || "GET",
            ).toUpperCase();
            rec = newRecord("fetch", method, absolute(isRequest ? input.url : input));
            rec.requestHeaders = headerObject(
              init && init.headers != null ? init.headers : isRequest ? input.headers : null,
            );
            // A Request's own body is a stream the page is about to send;
            // reading it here would need a clone of the REQUEST and an await
            // before the call. Only a body passed in `init` is recorded.
            if (init && init.body != null && wantsBody(rec.url)) {
              const body = requestBody(init.body, options.maxBodyBytes);
              rec.requestBody = body.now;
              pending = body.later;
            }
            t0 = now();
            emit(EVENT_RECORD, rec);
          } catch {
            rec = null;
          }
        }

        let promise;
        try {
          promise = inner.apply(this, arguments);
        } catch (err) {
          if (rec) {
            try {
              rec.error = errorText(err);
              finish(rec, t0, pending);
            } catch {
              // Recording failed too; the page still gets its error.
            }
          }
          throw err;
        }

        if (rec) {
          try {
            promise.then(
              (res) => fetchSettled(rec, t0, pending, res),
              (err) => {
                try {
                  rec.error = errorText(err);
                  finish(rec, t0, pending);
                } catch {
                  // The page's rejection is the page's; ours is swallowed.
                }
              },
            );
          } catch {
            // `inner` returned something without a usable `.then`. Not ours to fix.
          }
        }
        return promise;
      };
    }

    // ── XMLHttpRequest ─────────────────────────────────────────────────────────

    /**
     * What `open` and `setRequestHeader` learned, per request object, until
     * `send` turns it into a start record. Weak, so a request the page drops is
     * forgotten with it. A request opened while not armed has no entry and is
     * never recorded, even if `send` comes after arming: half a request is a
     * misleading record.
     */
    const xhrState = new WeakMap();

    /** The response as the page will see it, turned into a body. May return a promise (Blob). */
    function xhrBody(xhr, contentType, cap) {
      const type = xhr.responseType;
      if (type === "" || type === "text") return bodyFromString(String(xhr.responseText), cap);
      // `response` is a getter that hands back the same object on every read;
      // reading it changes nothing for the page.
      const response = xhr.response;
      if (response == null) return null;
      if (type === "json") return bodyFromString(JSON.stringify(response), cap);
      if (type === "arraybuffer") {
        const all = new Uint8Array(response);
        return bodyFromBytes(
          all.subarray(0, Math.min(all.length, cap)),
          contentType,
          cap,
          all.length > cap,
          all.length,
        );
      }
      if (type === "blob") {
        const size = response.size;
        // `slice` first, so a 1 GB Blob costs the cap and not a second gigabyte.
        return response
          .slice(0, cap)
          .arrayBuffer()
          .then((buf) =>
            bodyFromBytes(new Uint8Array(buf), contentType || response.type, cap, size > cap, size),
          );
      }
      if (type === "document") {
        const root = response.documentElement;
        return root && typeof root.outerHTML === "string"
          ? bodyFromString(root.outerHTML, cap)
          : null;
      }
      return null;
    }

    /**
     * The response, taken while it is guaranteed to be whole.
     *
     * Not at `loadend`. On an Angular 18 + zone.js site every XHR was recorded
     * as `status: 0, "Network error"` while the page rendered all its data,
     * and the XHR spec says how: `abort()` (or `open()`) on a request that is
     * already DONE resets it to UNSENT with a network-error response — status
     * 0, no headers, no body — and fires no event, and if that happens in a
     * `load` listener it happens before `loadend` is dispatched. So the
     * status, headers and body are read at `readystatechange` to DONE and at
     * `load`, whichever comes first with a real status, and `loadend` only
     * finalises.
     *
     * A status of 0 here is not a response, so nothing is kept and `loadend`
     * decides as it always has. The body is read now too, from `response` or
     * `responseText` per `responseType`, because after such an abort there is
     * no body left to read; a Blob body stays a promise, since the Blob itself
     * survives the abort.
     */
    function xhrSnapshot(xhr, st) {
      if (st.snap) return;
      const status = xhr.status;
      if (!status) return;
      const contentType = xhr.getResponseHeader("content-type");
      const snap = {
        status,
        statusText: xhr.statusText,
        responseHeaders: parseRawHeaders(xhr.getAllResponseHeaders()),
        contentType,
        body: null,
      };
      if (wantsBody(st.rec.url)) {
        try {
          snap.body = xhrBody(xhr, contentType, options.maxBodyBytes);
          // A Blob read is a promise that may fail before anything closes the
          // record and attaches its own handler; a rejection nobody handled
          // yet is reported to the PAGE's `unhandledrejection`. This one
          // handler marks it handled, and the real one still sees the result.
          if (snap.body && typeof snap.body.then === "function") {
            snap.body.then(null, () => {});
          }
        } catch {
          snap.body = null;
        }
      }
      st.snap = snap;
    }

    /** Fill the end record with a body that may still be a promise (a Blob), then send it. */
    function finishWithBody(rec, st, body) {
      if (body && typeof body.then === "function") {
        body.then(
          (b) => {
            rec.body = b;
            finish(rec, st.t0, st.pending);
          },
          () => finish(rec, st.t0, st.pending),
        );
        return;
      }
      rec.body = body;
      finish(rec, st.t0, st.pending);
    }

    function xhrDone(xhr, st) {
      if (st.done) return;
      st.done = true;
      const rec = st.rec;
      try {
        const snap = st.snap;
        if (snap) {
          // What `load` saw wins over whatever is left by now, failure flags
          // included: a request that loaded was answered.
          rec.status = snap.status;
          rec.statusText = snap.statusText;
          rec.responseHeaders = snap.responseHeaders;
          rec.contentType = snap.contentType;
          return finishWithBody(rec, st, snap.body);
        }
        rec.status = xhr.status;
        rec.statusText = xhr.statusText;
        rec.responseHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
        rec.contentType = xhr.getResponseHeader("content-type");
        // Status 0 at loadend, with no response seen before it, is the XHR way
        // of saying the request never got an answer. Which of
        // error/abort/timeout it was is only on the earlier event, so that is
        // remembered as it happens.
        if (st.failure || xhr.status === 0) {
          rec.error = st.failure || "Network error";
          return finish(rec, st.t0, st.pending);
        }
        if (!wantsBody(rec.url)) return finish(rec, st.t0, st.pending);
        finishWithBody(rec, st, xhrBody(xhr, rec.contentType, options.maxBodyBytes));
      } catch {
        try {
          finish(rec, st.t0, st.pending);
        } catch {
          // Nothing left to do.
        }
      }
    }

    const XHR_FAILURES = { error: "Network error", abort: "Aborted", timeout: "Timed out" };

    /**
     * What happened to a request, as the events saw it: `"load 4/200"` is the
     * event, then readyState/status at that moment. Kept on XHR records only
     * and only eight long, because its one job is to tell the next live run
     * what the page did to a request that came out wrong, as the
     * `status: 0` records did — "load 4/200" then "loadend 0/0" is an abort
     * after DONE, and "error 4/0" a real failure.
     */
    const XHR_TRACE_MAX = 8;
    const XHR_TRACED = ["readystatechange", "load", "error", "abort", "timeout", "loadend"];

    /** Request objects that already carry the listener below; it is added once per object. */
    const xhrListening = new WeakSet();

    /**
     * One listener per request OBJECT, added at `open` rather than `send`, and
     * reading the object's current state when an event arrives.
     *
     * At `open` because listeners run in the order they were added, and a
     * page (Angular's HttpClient among them) adds its own `load` listener
     * between `open` and `send`. Ours must run first, while the response is
     * still there to read, in case the page's empties it. Per object, because
     * a request reopened for another call is the same object, and a listener
     * per `open` would answer every event once per reuse.
     */
    function onXhrEvent(event) {
      try {
        const xhr = event.target || event.currentTarget;
        const st = xhrState.get(xhr);
        if (!st || !st.started || st.done) return;
        const type = event.type;
        const readyState = xhr.readyState;
        if (type === "readystatechange" && readyState !== 4) return;
        // A request's own `loadend` comes at DONE, or at UNSENT after a page
        // reset it in `load`; never at OPENED. One at OPENED is the PREVIOUS
        // request's, still being dispatched after a page reopened this object
        // from its `load` listener, and must not end the new one.
        if (type === "loadend" && readyState !== 4 && readyState !== 0) return;
        if (st.rec.trace.length < XHR_TRACE_MAX) {
          st.rec.trace.push(type + " " + readyState + "/" + xhr.status);
        }
        if (type === "readystatechange" || type === "load") xhrSnapshot(xhr, st);
        else if (type === "loadend") xhrDone(xhr, st);
        else st.failure = XHR_FAILURES[type] || st.failure;
      } catch {
        // Unrecorded, not broken.
      }
    }

    /**
     * `EventTarget.prototype.addEventListener` as it was when the hook loaded.
     *
     * A page can patch it, and zone.js does: through the patch, every one of
     * our listeners becomes a zone task, and each `readystatechange` in
     * LOADING a change-detection pass the page never asked for. Calling the
     * native one directly keeps the recorder out of the page's bookkeeping.
     * Injected inline at `document_start`, this is the browser's own; the
     * late `src` fallback may find a page's patch already in place, and then
     * gets the same behaviour as before, no worse.
     */
    const nativeAddListener = (function () {
      try {
        const f =
          typeof EventTarget === "function" && EventTarget.prototype
            ? EventTarget.prototype.addEventListener
            : null;
        return typeof f === "function" ? f : null;
      } catch {
        return null;
      }
    })();

    function listenTo(xhr) {
      if (xhrListening.has(xhr)) return;
      xhrListening.add(xhr);
      for (const type of XHR_TRACED) {
        if (nativeAddListener) nativeAddListener.call(xhr, type, onXhrEvent);
        else xhr.addEventListener(type, onXhrEvent);
      }
    }

    /**
     * The three prototype methods. Each passes `arguments` through untouched —
     * not named parameters — because XHR reads its argument COUNT: `open(m, u)`
     * is asynchronous, and `open(m, u, undefined)` is synchronous.
     */
    function makeOpen(inner) {
      return function open(method, url) {
        const result = inner.apply(this, arguments);
        try {
          // `open` on a request that has not ended closes its record here,
          // because no `loadend` of its own will reach it (one that is still
          // being dispatched arrives at OPENED and is ignored; see
          // `onXhrEvent`). If its response was already seen — `open` called
          // from a `load` listener, after DONE — it was answered, and is
          // closed from that snapshot exactly as `loadend` would have.
          // Otherwise `open` aborted it in flight.
          const previous = xhrState.get(this);
          if (previous && previous.started && !previous.done) {
            if (previous.rec.trace.length < XHR_TRACE_MAX) {
              previous.rec.trace.push("open " + this.readyState + "/" + this.status);
            }
            if (previous.snap) {
              xhrDone(this, previous);
            } else {
              previous.done = true;
              previous.rec.error = "Aborted";
              finish(previous.rec, previous.t0, previous.pending);
            }
          }
          if (wants("xhr")) {
            const rec = newRecord("xhr", String(method).toUpperCase(), absolute(url));
            rec.trace = [];
            xhrState.set(this, {
              rec,
              t0: 0,
              pending: null,
              failure: null,
              snap: null,
              done: false,
            });
            listenTo(this);
          } else {
            // A reopened request starts over; a stale entry from an earlier
            // armed `open` must not attach to this one.
            xhrState.delete(this);
          }
        } catch {
          // Unrecorded, not broken.
        }
        return result;
      };
    }

    function makeSetRequestHeader(inner) {
      return function setRequestHeader(name, value) {
        // The original first: if it throws (bad state, forbidden name) the page
        // gets that error and the header was never set, so it is not recorded.
        const result = inner.apply(this, arguments);
        try {
          const st = xhrState.get(this);
          if (st) {
            const key = String(name).toLowerCase();
            const headers = st.rec.requestHeaders;
            headers[key] = key in headers ? headers[key] + ", " + String(value) : String(value);
          }
        } catch {
          // Unrecorded, not broken.
        }
        return result;
      };
    }

    function makeSend(inner) {
      return function send() {
        const xhr = this;
        let st = null;
        try {
          st = wants("xhr") ? xhrState.get(xhr) || null : null;
          if (st && !st.started) {
            st.started = true;
            if (arguments.length > 0 && wantsBody(st.rec.url)) {
              const body = requestBody(arguments[0], options.maxBodyBytes);
              st.rec.requestBody = body.now;
              st.pending = body.later;
            }
            // Its listener has been there since `open`; see `onXhrEvent`.
            st.t0 = now();
            emit(EVENT_RECORD, st.rec);
          } else {
            st = null;
          }
        } catch {
          st = null;
        }
        try {
          return inner.apply(this, arguments);
        } catch (err) {
          // A synchronous throw (wrong state, or a sync request that failed)
          // may never reach `loadend`; close the record here so it does not hang
          // as a start forever, then give the page its error unchanged.
          if (st && !st.done) {
            try {
              st.done = true;
              st.rec.error = errorText(err);
              finish(st.rec, st.t0, st.pending);
            } catch {
              // Recording failed too; the page still gets its error.
            }
          }
          throw err;
        }
      };
    }

    // ── console ────────────────────────────────────────────────────────────────

    /** One argument as a person would read it in the console. */
    function describe(arg) {
      try {
        if (typeof arg === "string") return arg;
        if (arg && typeof arg === "object" && "message" in arg && "stack" in arg) {
          return (arg.name ? arg.name + ": " : "") + String(arg.message);
        }
        if (arg === undefined || typeof arg === "function" || typeof arg === "symbol") {
          return String(arg);
        }
        if (typeof arg === "object" && arg !== null) {
          const json = JSON.stringify(arg);
          return json === undefined ? String(arg) : json;
        }
        return String(arg);
      } catch {
        // Circular, or a getter that throws. The type is still something.
        return Object.prototype.toString.call(arg);
      }
    }

    function stackOf(value) {
      try {
        return value && typeof value === "object" && typeof value.stack === "string"
          ? value.stack
          : null;
      } catch {
        return null;
      }
    }

    function recordConsole(level, args, stack) {
      let message = Array.prototype.map.call(args, describe).join(" ");
      if (message.length > MAX_MESSAGE) message = message.slice(0, MAX_MESSAGE) + "…";
      if (stack == null) {
        for (const a of args) {
          stack = stackOf(a);
          if (stack) break;
        }
      }
      emit(EVENT_RECORD, {
        kind: "console",
        level,
        message,
        stack: stack || null,
        startedAt: Date.now(),
      });
    }

    /**
     * The console wrapper calls the original FIRST, so what the page logs reaches
     * the real console before anything of ours runs, and records afterwards in a
     * `finally` — a console that throws is still a call worth recording.
     */
    function makeConsole(level, inner) {
      return function () {
        const args = arguments;
        try {
          return inner.apply(this, args);
        } finally {
          try {
            if (wants("console")) recordConsole(level, args, null);
          } catch {
            // Unrecorded, not broken.
          }
        }
      };
    }

    function onPageError(event) {
      try {
        if (!wants("console")) return;
        const stack = stackOf(event.error);
        let message = event.message;
        if (!message) message = event.error ? describe(event.error) : "Script error";
        recordConsole("error", [String(message)], stack);
      } catch {
        // Unrecorded, not broken.
      }
    }

    function onUnhandledRejection(event) {
      try {
        if (!wants("console")) return;
        const reason = event.reason;
        recordConsole(
          "error",
          ["Unhandled promise rejection: " + describe(reason)],
          stackOf(reason),
        );
      } catch {
        // Unrecorded, not broken.
      }
    }

    // ── Installing and removing ────────────────────────────────────────────────

    /**
     * Every function this file replaces, as a slot.
     *
     * `inner` is what the slot held when it was wrapped — the original, when the
     * flag armed this at `document_start`, but possibly a library's own wrapper
     * when it was armed later. Wrapping what is THERE rather than the pristine
     * original keeps that library working: an error tracker that wrapped `fetch`
     * before arming still sees every request after it.
     *
     * Removing is the mirror image, and only when the slot still holds ours. If
     * something wrapped on top of us since, putting the old value back would
     * silently unwrap THEIR wrapper too. Then ours stays in their chain, dormant —
     * it records only while armed, and costs one check per call otherwise — and
     * a later install reuses it instead of wrapping a second time.
     */
    const slots = [
      { kind: "fetch", owner: () => window, key: "fetch", make: makeFetch },
      { kind: "xhr", owner: () => XHR_PROTO, key: "open", make: makeOpen },
      { kind: "xhr", owner: () => XHR_PROTO, key: "setRequestHeader", make: makeSetRequestHeader },
      { kind: "xhr", owner: () => XHR_PROTO, key: "send", make: makeSend },
      { kind: "console", owner: () => console, key: "error", make: (f) => makeConsole("error", f) },
      { kind: "console", owner: () => console, key: "warn", make: (f) => makeConsole("warn", f) },
    ].map((s) => Object.assign(s, { inner: null, wrapper: null }));

    function wrap(slot) {
      if (slot.wrapper) return;
      const owner = slot.owner();
      if (!owner || typeof owner[slot.key] !== "function") return;
      slot.inner = owner[slot.key];
      slot.wrapper = slot.make(slot.inner);
      owner[slot.key] = slot.wrapper;
    }

    function unwrap(slot) {
      if (!slot.wrapper) return;
      const owner = slot.owner();
      if (owner && owner[slot.key] === slot.wrapper) {
        owner[slot.key] = slot.inner;
        slot.wrapper = null;
        slot.inner = null;
      }
    }

    let listening = false;

    function setPageErrorListeners(on) {
      if (on === listening) return;
      if (on) {
        window.addEventListener("error", onPageError);
        window.addEventListener("unhandledrejection", onUnhandledRejection);
      } else {
        window.removeEventListener("error", onPageError);
        window.removeEventListener("unhandledrejection", onUnhandledRejection);
      }
      listening = on;
    }

    /** Arm, or re-arm with new options. Only the kinds asked for are wrapped. */
    function install(raw) {
      options = normalize(raw);
      installed = true;
      for (const slot of slots) {
        try {
          if (options.kinds.indexOf(slot.kind) !== -1) wrap(slot);
          else unwrap(slot);
        } catch {
          // One slot that cannot be replaced (a frozen console, say) does not
          // stop the others.
        }
      }
      try {
        setPageErrorListeners(options.kinds.indexOf("console") !== -1);
      } catch {
        // As above.
      }
      emit(EVENT_READY, { installed: true });
    }

    function uninstall() {
      installed = false;
      for (const slot of slots) {
        try {
          unwrap(slot);
        } catch {
          // A slot that cannot be put back stays wrapped and, with `installed`
          // false, records nothing.
        }
      }
      try {
        setPageErrorListeners(false);
      } catch {
        // As above.
      }
      emit(EVENT_READY, { installed: false });
    }

    try {
      document.addEventListener(EVENT_INSTALL, (event) => {
        try {
          const detail = event.detail;
          install(typeof detail === "string" ? JSON.parse(detail) : {});
        } catch {
          // A malformed install is ignored rather than half-applied.
        }
      });
      document.addEventListener(EVENT_UNINSTALL, () => {
        try {
          uninstall();
        } catch {
          // Nothing to undo that the loop above has not already tried.
        }
      });
    } catch {
      // No document to listen on: nothing can arm this page, which is the safe
      // way to fail.
      return;
    }

    // ── At load: the arm flag ──────────────────────────────────────────────────
    //
    // Written by `network.js` on `netRecord start`, read here so a reload is
    // recorded from its first request. It expires: an agent that never said
    // `stop` must not leave a site wrapped for the rest of the day, and Safari
    // may copy `sessionStorage` into a tab opened from this one.
    //
    // The `else` that removes an expired or unreadable flag is, today, all
    // but unreachable, and is kept on purpose. `network.js` deletes a stale
    // flag at load itself, and only injects this copy under a valid one, so
    // a page copy normally never sees a stale flag. The two ways one still
    // could are worth the four lines: a `src` copy that loads after the flag
    // ran out on its way in, and a future Safari that honours
    // `"world": "MAIN"` for a manifest entry, where this copy would run at
    // `document_start` on every load, armed or not, and be the first to read
    // the flag. Either way it must not wrap under it, and deleting it is the
    // same thing `network.js` would have done.
    let armedAtLoad = false;
    try {
      const raw = sessionStorage.getItem(FLAG_KEY);
      if (raw != null) {
        let flag = null;
        try {
          flag = JSON.parse(raw);
        } catch {
          flag = null;
        }
        if (flag && typeof flag === "object" && Number(flag.expiresAt) > Date.now()) {
          install(flag);
          armedAtLoad = true;
        } else {
          sessionStorage.removeItem(FLAG_KEY);
        }
      }
    } catch {
      // Storage disabled or sandboxed away. Arming by event still works.
    }

    // `install` already announced itself; otherwise say once that this page has a
    // hook and it is dormant, so `network.js` can tell "not armed" from "the hook
    // never loaded".
    if (!armedAtLoad) emit(EVENT_READY, { installed: false });
  }
  // oxlint-enable unicorn/consistent-function-scoping

  // ── Which world is this? ───────────────────────────────────────────────────
  //
  // `browser` (and Chrome's `chrome.runtime.id`) exist only in an extension
  // world. In Safari that is where this file always lands, since it ignores
  // `"world": "MAIN"`: there it wraps nothing — `fetch` in the isolated world
  // is the extension's own, and wrapping it would record nothing the page did
  // — and only leaves its source on the isolated window for `network.js`,
  // which injects it into the page when, and only when, the tab is armed.
  //
  // A copy WITHOUT those globals is in the page: the `src` fallback that
  // `network.js` uses when a Content-Security-Policy refuses the inline script,
  // or a future Safari that honours MAIN. That copy runs the recorder.
  //
  // `browser` must also have a `runtime`, because a page's own global can be
  // called `browser`: an element with `id="browser"` is `window.browser` in
  // every engine, and a page copy that took it for the extension would bail
  // and record nothing.
  //
  // The isolated copy still answers the ping, as `world: "isolated"`. It is
  // the only thing it does besides leaving the source, and it reads and writes
  // nothing but that one reply.
  let isolated = false;
  try {
    if (typeof browser !== "undefined" && browser && browser.runtime) isolated = true;
    else if (
      typeof chrome !== "undefined" &&
      chrome &&
      chrome.runtime &&
      typeof chrome.runtime.id === "string"
    ) {
      isolated = true;
    }
  } catch {
    isolated = true;
  }

  if (!isolated) {
    cupertinoNetHookMain();
    return;
  }

  try {
    document.addEventListener("cupertino:net-ping", () => {
      try {
        document.dispatchEvent(
          new CustomEvent("cupertino:net-ready", {
            detail: JSON.stringify({ installed: false, world: "isolated" }),
          }),
        );
      } catch {
        // A reply that cannot be sent is a ping unanswered.
      }
    });
  } catch {
    // No document to listen on: nothing can ask.
  }
  try {
    // An expression statement, so it runs as written whatever comes before it
    // in the page, and a named function expression, so it adds no global.
    window.cupertinoNetHookSource = "(" + cupertinoNetHookMain.toString() + ")();";
  } catch {
    // No source: `network.js` reports the injection as unavailable.
  }
})();
