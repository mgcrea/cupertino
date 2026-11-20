// The toolbar popover: the tab in front, as its own content script sees it.
//
// ## Why it asks the page and not the background
//
// The popover exists for the tab whose polls stopped getting through. On
// 2026-11-20 Safari stopped the extension's background worker while a tab was
// open in front, and every page command timed out for minutes; the only places
// that said so were an agent's timeout and Safari's log. `tabs.sendMessage`
// reaches the page's content script without that worker, so the popover still
// answers when the worker is the thing that broke. Nothing here sends a runtime
// message.
//
// ## What it never shows
//
// No page text, no field's value, no cookie, no request URL or body. The list
// of what agents did is a verb and an element's label, which is all the content
// script keeps.
//
// ## No permission
//
// `tabs.query` gives the active tab's id without one, and the page reports its
// own host. `activeTab` would make the click that opens this a temporary grant
// of the tab, letting the extension onto a site the person never allowed.
(function () {
  /** How long a check-in may be old before the page counts as stalled. */
  const STALL_MS = 15_000;
  /** How long the page has to answer before it counts as not there. */
  const ANSWER_MS = 1_500;
  const CAPTION_MAX = 40;

  const VERBS = {
    elements: "listed elements",
    read: "read the page",
    click: "clicked",
    fill: "filled",
    submit: "submitted",
    scroll: "scrolled",
    find: "searched the page",
    codes: "looked for codes",
    netList: "listed requests",
    netGet: "read a request",
    cookies: "read cookies",
    cookieProbe: "checked a cookie",
  };
  const RECORD_VERBS = {
    start: "started recording",
    stop: "stopped recording",
    clear: "cleared the recording",
    status: "checked the recording",
  };

  function version() {
    try {
      return browser.runtime.getManifest().version || "";
    } catch {
      return "";
    }
  }

  /** Local HH:MM. */
  function clock(ms) {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function ago(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return seconds < 60 ? seconds + " s ago" : Math.round(seconds / 60) + " min ago";
  }

  function verbOf(entry) {
    if (entry.action === "netRecord") {
      return RECORD_VERBS[entry.op] || "used the recorder";
    }
    return VERBS[entry.action] || "ran " + String(entry.action).slice(0, CAPTION_MAX);
  }

  /** One line of "What agents did here": time, verb, label, and only those. */
  function lineOf(entry) {
    let line = clock(entry.at) + " " + verbOf(entry);
    if (typeof entry.label === "string" && entry.label) line += ' "' + entry.label + '"';
    if (Number(entry.times) > 1) line += " ×" + Math.floor(Number(entry.times));
    if (entry.ok !== true) line += " (failed)";
    return line;
  }

  function requests(n) {
    return n === 1 ? "1 request" : n + " requests";
  }

  function recordingOf(recorder) {
    if (!recorder || typeof recorder !== "object") return null;
    const records = Number(recorder.counts?.records) || 0;
    if (recorder.recording === true) {
      const stops = Date.parse(recorder.expiresAt);
      return {
        line: requests(records) + (Number.isNaN(stops) ? "" : " · stops at " + clock(stops)),
        stop: true,
        clear: true,
      };
    }
    if (records > 0) {
      return { line: "Stopped · " + requests(records) + " kept", stop: false, clear: true };
    }
    return null;
  }

  const NOT_HERE_DETAIL =
    "Safari may not allow it on this site (Safari > Settings > Extensions, or this site's " +
    "settings), the tab may have been open since before Cupertino was turned on or updated, " +
    "or this is a page Safari runs no extensions on.";

  /**
   * What to show, from the page's answer and the clock. Pure, so the tests
   * read it without a DOM.
   */
  function view({ answer, error, now }) {
    const base = {
      version: version(),
      host: null,
      detail: null,
      reload: false,
      network: null,
      recent: [],
    };
    if (error === "no-tab") {
      return { ...base, state: "no-tab", headline: "No page is open in this window." };
    }
    if (error || !answer || answer.ok !== true) {
      return {
        ...base,
        state: "not-here",
        headline: "Cupertino isn't running on this page.",
        detail: NOT_HERE_DETAIL,
        reload: true,
      };
    }
    const shown = {
      ...base,
      host: typeof answer.host === "string" ? answer.host : null,
      network: recordingOf(answer.network),
      recent: Array.isArray(answer.recent)
        ? answer.recent.filter((e) => e !== null && typeof e === "object").map(lineOf)
        : [],
    };
    const last = typeof answer.lastPollOkAt === "number" ? answer.lastPollOkAt : null;
    const started = typeof answer.startedAt === "number" ? answer.startedAt : null;
    if (last !== null && now - last <= STALL_MS) {
      return { ...shown, state: "ready", headline: "Agents can read and act on this page." };
    }
    if (last === null && started !== null && now - started < STALL_MS) {
      return { ...shown, state: "connecting", headline: "Connecting…" };
    }
    return {
      ...shown,
      state: "stalled",
      headline: "This page can't reach Cupertino.",
      detail:
        "Last check-in: " +
        (last === null ? "never" : ago(now - last)) +
        ". Reloading the tab usually brings it back.",
      reload: true,
    };
  }

  /** A message to the tab, given up on after `ANSWER_MS`. */
  function ask(tabId, message) {
    let timer;
    return Promise.race([
      browser.tabs.sendMessage(tabId, message),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("the page did not answer")), ANSWER_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  let tabId = null;
  let lastAnswer = null;

  async function load() {
    let tabs;
    try {
      tabs = await browser.tabs.query({ active: true, currentWindow: true });
    } catch {
      tabs = [];
    }
    const tab = Array.isArray(tabs) ? tabs[0] : undefined;
    if (!tab || typeof tab.id !== "number") {
      tabId = null;
      lastAnswer = null;
      return view({ answer: null, error: "no-tab", now: Date.now() });
    }
    tabId = tab.id;
    try {
      lastAnswer = await ask(tabId, { kind: "popupStatus" });
    } catch {
      lastAnswer = null;
      return view({ answer: null, error: "not-here", now: Date.now() });
    }
    return view({ answer: lastAnswer, error: null, now: Date.now() });
  }

  /** Stop or clear the tab's recording, and redraw from what the page says now. */
  async function network(op) {
    if (tabId === null) return load();
    try {
      await ask(tabId, { kind: "popupNetwork", op });
    } catch {
      lastAnswer = null;
      return view({ answer: null, error: "not-here", now: Date.now() });
    }
    // Asked again rather than redrawn from the answer the popover opened with,
    // whose check-in time is as old as the popover and whose host and list may
    // be another page's by now.
    return load();
  }

  const notHere = () => view({ answer: null, error: "not-here", now: Date.now() });

  /** `load`, but never a blank popover: anything unexpected reads as Not here. */
  function show() {
    return load().catch(notHere);
  }

  async function reload() {
    if (tabId !== null) {
      try {
        await browser.tabs.reload(tabId);
      } catch {
        // Nothing to say in a popover that is closing; the tab shows the result.
      }
    }
    window.close();
  }

  // ── Drawing ────────────────────────────────────────────────────────────────
  //
  // `textContent` only, never markup: a label is the page's own text.

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function button(text, onClick) {
    const el = node("button", null, text);
    el.type = "button";
    el.addEventListener("click", onClick);
    return el;
  }

  function render(v) {
    const root = document.getElementById("root");
    if (!root) return;
    root.replaceChildren();

    const header = node("header", null);
    header.append(node("span", "name", "Cupertino"), node("span", "version", v.version));
    root.append(header);

    const tab = node("section", "tab " + v.state);
    if (v.host) tab.append(node("div", "host", v.host));
    const status = node("div", "status");
    status.append(node("span", "dot"), node("span", "headline", v.headline));
    tab.append(status);
    if (v.detail) tab.append(node("p", "detail", v.detail));
    if (v.reload) {
      const actions = node("div", "actions");
      actions.append(button("Reload tab", () => reload()));
      tab.append(actions);
    }
    root.append(tab);

    if (v.network) {
      const section = node("section", "network");
      section.append(node("h2", null, "Network recording"), node("p", null, v.network.line));
      const actions = node("div", "actions");
      for (const op of ["stop", "clear"]) {
        if (!v.network[op]) continue;
        const text = op === "stop" ? "Stop" : "Clear";
        actions.append(button(text, () => network(op).catch(notHere).then(render)));
      }
      section.append(actions);
      root.append(section);
    }

    if (v.recent.length > 0) {
      const section = node("section", "recent");
      section.append(node("h2", null, "What agents did here"));
      const list = node("ol", null);
      for (const line of v.recent) {
        list.append(node("li", line.endsWith(" (failed)") ? "failed" : null, line));
      }
      section.append(list);
      root.append(section);
    }
  }

  window.cupertinoPopupView = view;
  window.cupertinoPopupLoad = load;
  window.cupertinoPopupNetwork = network;
  window.cupertinoPopupReload = reload;
  window.cupertinoPopupShow = show;

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      show().then(render);
    });
  }
})();
