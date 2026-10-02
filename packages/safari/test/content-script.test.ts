import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

/**
 * The content script's pure functions, EXECUTED.
 *
 * Everything else about the extension is tested through the contract at the
 * container boundary, because the real content script only runs inside Safari
 * from a notarized build. This one file is different: `classifyField` is a pure
 * function over an element's attributes, and it is the single thing standing
 * between `page_elements` and somebody's password. A test that only asserted
 * the file parses would not have caught the bug this replaces — every text
 * field returned its value, `input[type=password]` included.
 *
 * So `actions.js` is evaluated in a `node:vm` against a hand-rolled DOM stub.
 * Not jsdom: this package depends on the MCP SDK and zod and nothing else, and
 * a DOM implementation pulled in for one file is a bad trade. The stub only has
 * to be as rich as `enumerate` actually is, which is not very.
 */

const SOURCE = readFileSync(
  fileURLToPath(
    new URL("../../../apps/apple/CupertinoSafariExtension/Resources/actions.js", import.meta.url),
  ),
  "utf8",
);

type Attrs = Record<string, string>;

/** The smallest thing `enumerate` will accept as an element. */
const el = (tag: string, attrs: Attrs = {}, extra: Record<string, unknown> = {}) => ({
  tagName: tag.toUpperCase(),
  getAttribute: (name: string) => attrs[name] ?? null,
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
  innerText: "",
  value: "",
  labels: [],
  href: null,
  ...extra,
});

/** A text node whose parent is an ordinary, visible, non-hidden element. */
const textNode = (value: string, parentAttrs: Attrs = {}) => ({
  nodeValue: value,
  parentElement: {
    ...el("span", parentAttrs),
    closest: (sel: string) =>
      (sel === "[contenteditable=true]" && parentAttrs.contenteditable === "true") ||
      (sel === '[aria-hidden="true"]' && parentAttrs["aria-hidden"] === "true")
        ? {}
        : null,
  },
});

/**
 * Evaluate actions.js against a stub DOM and return the command runner.
 *
 * The `TreeWalker` stub is the only interesting part: it applies the real
 * `acceptNode` filter the content script passes in, so the skip rules
 * (contenteditable, aria-hidden, script/style) are genuinely exercised rather
 * than assumed.
 */
const runWith = (opts: { elements?: unknown[]; nodes?: ReturnType<typeof textNode>[] }) => {
  const window: Record<string, unknown> = { innerHeight: 800, innerWidth: 1200 };
  const context = createContext({
    crypto: webcrypto,
    window,
    performance: { now: () => 4000 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    document: {
      body: {},
      querySelectorAll: () => opts.elements ?? [],
      getElementById: () => null,
      createTreeWalker: (
        _root: unknown,
        _what: number,
        filter: { acceptNode: (n: unknown) => number },
      ) => {
        const queue = (opts.nodes ?? []).filter((n) => filter.acceptNode(n) === 1);
        let i = 0;
        return { nextNode: () => (i < queue.length ? queue[i++] : null) };
      },
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  });
  runInContext(SOURCE, context);
  return window.cupertinoRunCommand as (c: unknown) => {
    ok: boolean;
    data: Record<string, never>;
    error?: string;
  };
};

/** Evaluate actions.js over a fixed element list and return what it hands out. */
const enumerateWith = (elements: unknown[], includeCodes: boolean) => {
  const window: Record<string, unknown> = { innerHeight: 800, innerWidth: 1200 };
  const context = createContext({
    crypto: webcrypto,
    window,
    document: {
      querySelectorAll: () => elements,
      getElementById: () => null,
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  });
  runInContext(SOURCE, context);
  const run = window.cupertinoRunCommand as (c: unknown) => {
    ok: boolean;
    data: {
      elements: { label: string; value: string | null; redacted?: string; hasValue?: boolean }[];
    };
    error?: string;
  };
  const out = run({ action: "elements", limit: 50, includeCodes });
  expect(out.ok, out.error).toBe(true);
  return out.data.elements;
};

const only = (element: unknown, includeCodes = false) => enumerateWith([element], includeCodes)[0]!;

describe("credential fields", () => {
  /**
   * The flag is named for CODES. A password is not a code, and no setting turns
   * it back on — which is the property this whole table exists to pin.
   */
  it.each([
    ["type=password", el("input", { type: "password" }, { value: "hunter2" })],
    [
      "autocomplete current-password",
      el("input", { autocomplete: "current-password" }, { value: "hunter2" }),
    ],
    [
      "autocomplete new-password",
      el("input", { autocomplete: "new-password" }, { value: "hunter2" }),
    ],
    [
      "autocomplete cc-number",
      el("input", { autocomplete: "cc-number" }, { value: "4111111111111111" }),
    ],
    ["autocomplete cc-csc", el("input", { autocomplete: "cc-csc" }, { value: "737" })],
  ])("withholds %s even with codes allowed", (_name, element) => {
    for (const includeCodes of [false, true]) {
      const found = only(element, includeCodes);
      expect(found.value).toBeNull();
      expect(found.redacted).toBe("credential");
      expect(found.hasValue).toBe(true);
    }
  });

  /** `autocomplete` is a token list; a substring test would miss this one. */
  it("matches a cc token inside a multi-token autocomplete", () => {
    const found = only(
      el("input", { autocomplete: "section-a billing cc-number" }, { value: "4111" }),
    );
    expect(found.redacted).toBe("credential");
  });

  /** `autocomplete="off"` is on half the web and says nothing about secrecy. */
  it("does not treat autocomplete=off as a signal", () => {
    const found = only(el("input", { autocomplete: "off" }, { value: "tuesday" }));
    expect(found.value).toBe("tuesday");
    expect(found.redacted).toBeUndefined();
  });
});

describe("one-time-code fields", () => {
  const codeFields: [string, unknown][] = [
    [
      "autocomplete one-time-code",
      el("input", { autocomplete: "one-time-code" }, { value: "123456" }),
    ],
    ["name=otp", el("input", { name: "otp" }, { value: "123456" })],
    ["id=totp", el("input", { id: "totp" }, { value: "123456" })],
    [
      "placeholder in French",
      el("input", { placeholder: "Code de vérification" }, { value: "123456" }),
    ],
    [
      "aria-label security code",
      el("input", { "aria-label": "Security code" }, { value: "123456" }),
    ],
    ["2fa in the name", el("input", { name: "user_2fa_token" }, { value: "123456" })],
    [
      "short numeric shape",
      el("input", { maxlength: "6", inputmode: "numeric" }, { value: "123456" }),
    ],
    [
      "short field with a digit pattern",
      el("input", { maxlength: "6", pattern: "[0-9]*" }, { value: "123456" }),
    ],
  ];

  it.each(codeFields)("withholds %s when the setting is off", (_name, element) => {
    const found = only(element, false);
    expect(found.value).toBeNull();
    expect(found.redacted).toBe("code");
    expect(found.hasValue).toBe(true);
  });

  it.each(codeFields)("returns %s when the setting is on", (_name, element) => {
    const found = only(element, true);
    expect(found.value).toBe("123456");
    expect(found.redacted).toBeUndefined();
  });

  /** An empty code field is still redacted, and `hasValue` is how you tell. */
  it("reports an empty code field as unfilled rather than as absent", () => {
    const found = only(el("input", { autocomplete: "one-time-code" }, { value: "" }), false);
    expect(found.redacted).toBe("code");
    expect(found.hasValue).toBe(false);
  });
});

describe("ordinary fields", () => {
  it("returns a search box unchanged", () => {
    const found = only(el("input", { type: "search", name: "q" }, { value: "safari extension" }));
    expect(found.value).toBe("safari extension");
    expect(found.redacted).toBeUndefined();
  });

  it("returns a textarea unchanged", () => {
    const found = only(el("textarea", { name: "comment" }, { value: "looks good" }));
    expect(found.value).toBe("looks good");
  });

  /**
   * A long maxlength is not the short-numeric shape, so a phone number stays
   * readable. The rung is bounded at 8 precisely so this holds.
   */
  it("does not redact a long numeric field", () => {
    const found = only(
      el("input", { maxlength: "20", inputmode: "numeric" }, { value: "0612345678" }),
    );
    expect(found.value).toBe("0612345678");
  });
});

describe("the label path", () => {
  /**
   * `label()` used to fall through to `el.value`, which was a second door to
   * exactly the string `enumerate` withholds. It is now only consulted where
   * `value` genuinely IS the visible caption.
   */
  it("never names a field after its own secret", () => {
    const found = only(el("input", { type: "password", name: "password" }, { value: "hunter2" }));
    expect(found.label).not.toBe("hunter2");
  });

  it("still uses value as the caption of a submit button", () => {
    const found = only(el("input", { type: "submit" }, { value: "Buy now" }));
    expect(found.label).toBe("Buy now");
  });
});

/**
 * The assertion that survives someone adding a new field to the output.
 *
 * Every check above names a key; this one names none, so a future `title` or
 * `defaultValue` that happened to carry the secret would fail here and nowhere
 * else.
 */
describe("negative control", () => {
  it("puts no secret anywhere in the serialized payload", () => {
    const elements = [
      el("input", { type: "password", name: "password" }, { value: "PASSWORD-LEAKED" }),
      el("input", { autocomplete: "cc-number" }, { value: "CARDNUM-LEAKED" }),
      el("input", { autocomplete: "one-time-code" }, { value: "CODE-LEAKED" }),
    ];
    const json = JSON.stringify(enumerateWith(elements, false));
    expect(json).not.toContain("PASSWORD-LEAKED");
    expect(json).not.toContain("CARDNUM-LEAKED");
    expect(json).not.toContain("CODE-LEAKED");
  });

  /** With the setting on, the code appears and the credentials still do not. */
  it("releases only the code when the setting is on", () => {
    const elements = [
      el("input", { type: "password", name: "password" }, { value: "PASSWORD-LEAKED" }),
      el("input", { autocomplete: "one-time-code" }, { value: "CODE-LEAKED" }),
    ];
    const json = JSON.stringify(enumerateWith(elements, true));
    expect(json).not.toContain("PASSWORD-LEAKED");
    expect(json).toContain("CODE-LEAKED");
  });
});

/**
 * `findCodes` reports; it never judges.
 *
 * Every scoring decision lives in `extractCode` on the server, so what these
 * pin is the other half: that the right passages come back, that a number is
 * not sliced in half on its way out, and that the places a code must never be
 * read from are skipped.
 */
describe("findCodes", () => {
  const scan = (nodes: ReturnType<typeof textNode>[], limit?: number) => {
    const out = runWith({ nodes })({ action: "codes", limit });
    expect(out.ok, out.error).toBe(true);
    return out.data as unknown as {
      excerpts: { text: string; inView: boolean }[];
      truncated: boolean;
      scannedAt: string;
      pageAgeSeconds: number;
    };
  };

  it("returns the passage around a digit run", () => {
    const found = scan([textNode("Your verification code is 123456")]);
    expect(found.excerpts).toHaveLength(1);
    expect(found.excerpts[0]!.text).toBe("Your verification code is 123456");
  });

  it("ignores passages with no code-shaped digits", () => {
    expect(scan([textNode("Welcome back, Olivier")]).excerpts).toHaveLength(0);
    // Three digits is below the floor; nine is above it.
    expect(scan([textNode("only 123 left")]).excerpts).toHaveLength(0);
  });

  /** A compose box holds what the USER typed, which this lane does not read. */
  it("skips a contenteditable subtree", () => {
    const found = scan([textNode("my code is 123456", { contenteditable: "true" })]);
    expect(found.excerpts).toHaveLength(0);
  });

  it("skips an aria-hidden subtree", () => {
    const found = scan([textNode("code 123456", { "aria-hidden": "true" })]);
    expect(found.excerpts).toHaveLength(0);
  });

  /**
   * The boundary creep, which is the whole reason the window is not a plain
   * slice. A card number cut in half would reach the extractor as a fragment
   * its own disqualification would have caught in full.
   */
  it("does not slice a long number in half", () => {
    const padding = "x".repeat(400);
    const found = scan([textNode(`${padding} 4111 1111 1111 1111 ${padding}`)]);
    expect(found.excerpts[0]!.text).toContain("4111 1111 1111 1111");
  });

  /** The window must stay wider than the extractor's own keyword reach. */
  it("keeps a keyword 100 characters from the digits inside the excerpt", () => {
    const gap = "y".repeat(100);
    const found = scan([
      textNode(`${"x".repeat(400)} verification code ${gap} 123456 ${"x".repeat(400)}`),
    ]);
    expect(found.excerpts[0]!.text).toContain("verification code");
    expect(found.excerpts[0]!.text).toContain("123456");
  });

  it("caps the excerpt count and says so", () => {
    const nodes = Array.from({ length: 6 }, (_, i) => textNode(`code 12345${i}`));
    const found = scan(nodes, 3);
    expect(found.excerpts).toHaveLength(3);
    expect(found.truncated).toBe(true);
  });

  /** A frameset or XML document has no body; that is "nothing", not a failure. */
  it("returns an empty scan on a document with no body", () => {
    const window: Record<string, unknown> = { innerHeight: 800, innerWidth: 1200 };
    const context = createContext({
      crypto: webcrypto,
      window,
      performance: { now: () => 4000 },
      NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
      document: { body: null, querySelectorAll: () => [], getElementById: () => null },
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    });
    runInContext(SOURCE, context);
    const run = window.cupertinoRunCommand as (c: unknown) => {
      ok: boolean;
      data: { excerpts: [] };
    };
    const out = run({ action: "codes" });
    expect(out.ok).toBe(true);
    expect(out.data.excerpts).toHaveLength(0);
  });

  /** `pageAgeSeconds` bounds the age from above; the stub clock makes it 4 s. */
  it("reports when it scanned and how old the page is", () => {
    const found = scan([textNode("code 123456")]);
    expect(found.pageAgeSeconds).toBe(4);
    expect(Date.parse(found.scannedAt)).toBeGreaterThan(0);
  });
});

/** Run one command against a fixed element list, with the whole result back. */
const commandWith = (elements: unknown[], command: Record<string, unknown>) => {
  const window: Record<string, unknown> = { innerHeight: 800, innerWidth: 1200 };
  const context = createContext({
    crypto: webcrypto,
    window,
    document: { querySelectorAll: () => elements, getElementById: () => null },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  });
  runInContext(SOURCE, context);
  const run = window.cupertinoRunCommand as (c: unknown) => {
    ok: boolean;
    data: { elements: Record<string, unknown>[] };
    error?: string;
  };
  const out = run({ action: "elements", limit: 50, includeCodes: false, ...command });
  expect(out.ok, out.error).toBe(true);
  return out.data.elements;
};

/**
 * Reading a form, which is what the Shopify listing review needed and could
 * not do: every checkbox came back `value: null`, radios were reported as
 * checkboxes, and two disabled boxes were missing altogether.
 */
describe("form state", () => {
  it("reports whether a checkbox is ticked", () => {
    const [on, off] = commandWith(
      [
        el("input", { type: "checkbox" }, { checked: true }),
        el("input", { type: "checkbox" }, { checked: false }),
      ],
      {},
    );
    expect(on).toMatchObject({ kind: "checkbox", checked: true });
    expect(off).toMatchObject({ kind: "checkbox", checked: false });
  });

  it("reports a radio as a radio, with its state", () => {
    const [found] = commandWith([el("input", { type: "radio" }, { checked: true })], {});
    expect(found).toMatchObject({ kind: "radio", checked: true });
  });

  it("reports a tri-state box as mixed rather than rounding it", () => {
    const [found] = commandWith(
      [el("input", { type: "checkbox" }, { checked: false, indeterminate: true })],
      {},
    );
    expect(found?.checked).toBe("mixed");
  });

  it("reads an ARIA checkbox, switch and radio from aria-checked", () => {
    const found = commandWith(
      [
        el("div", { role: "checkbox", "aria-checked": "true" }),
        el("div", { role: "switch", "aria-checked": "false" }),
        el("div", { role: "radio", "aria-checked": "true" }),
      ],
      {},
    );
    expect(found.map((f) => [f.kind, f.checked])).toEqual([
      ["checkbox", true],
      ["checkbox", false],
      ["radio", true],
    ]);
  });

  it("lists a disabled control and marks it, instead of dropping it", () => {
    const [found] = commandWith(
      [el("input", { type: "checkbox" }, { checked: false, disabled: true })],
      {},
    );
    expect(found).toMatchObject({ kind: "checkbox", checked: false, disabled: true });
  });

  it("marks aria-disabled the same way", () => {
    const [found] = commandWith([el("button", { "aria-disabled": "true" })], {});
    expect(found?.disabled).toBe(true);
  });

  it("carries no disabled key on an ordinary control", () => {
    const [found] = commandWith([el("button")], {});
    expect(found).not.toHaveProperty("disabled");
  });

  /** Disabled is on screen; zero-size is not. Only the second is still dropped. */
  it("still drops an element nobody can see", () => {
    const hidden = el("input", { type: "checkbox" });
    hidden.getBoundingClientRect = () => ({
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
    });
    expect(commandWith([hidden], {})).toEqual([]);
  });

  it("reports the option text a select shows", () => {
    const [found] = commandWith(
      [el("select", { name: "category" }, { selectedOptions: [{ label: "Gift cards" }] })],
      {},
    );
    expect(found).toMatchObject({ kind: "select", value: "Gift cards" });
  });

  /** The redaction must not have a hole shaped like the one kind it never looked at. */
  it("withholds a card field that happens to be a select", () => {
    const [found] = commandWith(
      [
        el(
          "select",
          { autocomplete: "cc-exp-month" },
          { selectedOptions: [{ label: "SELECT-LEAKED" }] },
        ),
      ],
      {},
    );
    expect(found?.redacted).toBe("credential");
    expect(JSON.stringify(found)).not.toContain("SELECT-LEAKED");
  });
});

describe("value truncation", () => {
  const long = "x".repeat(250);

  it("says when a value was cut, and how long it really is", () => {
    const [found] = commandWith([el("textarea", {}, { value: long })], {});
    expect(found).toMatchObject({ valueTruncated: true, valueLength: 250 });
    expect(String(found?.value)).toHaveLength(200);
  });

  it("returns the whole value under a raised cap, with no flag", () => {
    const [found] = commandWith([el("textarea", {}, { value: long })], { maxValueChars: 1000 });
    expect(found?.value).toBe(long);
    expect(found).not.toHaveProperty("valueTruncated");
  });

  /** A value cut by the page's own maxlength is whole as far as we are concerned. */
  it("does not flag a value that fits", () => {
    const [found] = commandWith([el("input", {}, { value: "x".repeat(62) })], {});
    expect(found).not.toHaveProperty("valueTruncated");
  });
});

/** The live read `read_page` now tries before the capture. */
describe("read", () => {
  const readWith = (command: Record<string, unknown>) => {
    const removed: string[] = [];
    const clone = {
      innerText: "Skip to content\n\n\n\nApp name   Prepaid Credits",
      querySelectorAll: () => [{ remove: () => removed.push("script") }],
    };
    const window: Record<string, unknown> = {};
    const context = createContext({
      crypto: webcrypto,
      window,
      location: { href: "https://apps.example/form" },
      document: {
        title: "App Listing Submission",
        body: { cloneNode: () => clone },
        documentElement: { outerHTML: "<html><body>form</body></html>" },
      },
    });
    runInContext(SOURCE, context);
    const run = window.cupertinoRunCommand as (c: unknown) => {
      ok: boolean;
      data: Record<string, unknown>;
      error?: string;
    };
    const out = run({ action: "read", ...command });
    expect(out.ok, out.error).toBe(true);
    return { data: out.data, removed, shared: window.cupertinoReadableText };
  };

  it("returns the readable text, script stripped and whitespace collapsed", () => {
    const { data, removed } = readWith({ format: "text", maxChars: 1000 });
    expect(data).toMatchObject({
      url: "https://apps.example/form",
      title: "App Listing Submission",
      format: "text",
      content: "Skip to content\n\nApp name Prepaid Credits",
      truncated: false,
    });
    expect(removed).toEqual(["script"]);
    expect(typeof data.readAt).toBe("string");
  });

  it("returns the html when asked", () => {
    const { data } = readWith({ format: "html", maxChars: 1000 });
    expect(data).toMatchObject({ format: "html", content: "<html><body>form</body></html>" });
  });

  it("clips to the cap in the page, and says how much there was", () => {
    const { data } = readWith({ format: "text", maxChars: 4 });
    expect(data).toMatchObject({ content: "Skip", truncated: true, totalChars: 41 });
  });

  /** content.js stores captures through this, so the two cannot disagree. */
  it("exposes the extraction for the capture to share", () => {
    const { shared } = readWith({});
    expect(typeof shared).toBe("function");
  });
});

/**
 * `fill`, executed against the thing that broke it: React's value tracker.
 *
 * React defines its own `value` accessor on each input INSTANCE, records every
 * value written through it, and on `input` calls `onChange` only when the DOM
 * disagrees with that record. The stand-in below does exactly that, so a fill
 * that writes `el.value` directly — the first version — shows the text and
 * changes nothing React knows about.
 */
describe("fill", () => {
  class FakeEvent {
    readonly type: string;
    constructor(type: string) {
      this.type = type;
    }
  }

  /** Enumerate, then fill the first element by the id the enumeration handed out. */
  const runFill = (elements: unknown[], text: string) => {
    const window: Record<string, unknown> = { innerHeight: 800, innerWidth: 1200 };
    const context = createContext({
      crypto: webcrypto,
      window,
      Event: FakeEvent,
      document: { querySelectorAll: () => elements, getElementById: () => null },
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    });
    runInContext(SOURCE, context);
    const run = window.cupertinoRunCommand as (c: unknown) => {
      ok: boolean;
      data: Record<string, unknown>;
      error?: string;
    };
    const listed = run({ action: "elements", limit: 50 }) as {
      ok: boolean;
      data: { elements: { id: string }[] };
    };
    expect(listed.ok).toBe(true);
    return run({ action: "fill", elementId: listed.data.elements[0]!.id, text });
  };

  /** Browser-like DOM behaviour an element needs for `fill` to act on it. */
  const acting = (events: string[]) => ({
    scrollIntoView: () => {},
    focus: () => {},
    dispatchEvent: (e: FakeEvent) => void events.push(e.type),
  });

  /** An input the way React leaves it: a native prototype accessor, and its own on top. */
  const reactInput = (initial: string) => {
    const dom = { value: initial };
    const proto = {};
    Object.defineProperty(proto, "value", {
      get: () => dom.value,
      set: (v: string) => void (dom.value = String(v)),
    });
    const node: Record<string, unknown> = Object.assign(Object.create(proto) as object, {
      ...el("textarea"),
      ...acting([]),
    });
    delete node.value;

    let tracked = initial;
    const onChange: string[] = [];
    Object.defineProperty(node, "value", {
      get: () => dom.value,
      set: (v: string) => {
        tracked = String(v);
        dom.value = String(v);
      },
    });
    node.dispatchEvent = (e: FakeEvent) => {
      if (e.type === "input" && tracked !== dom.value) {
        tracked = dom.value;
        onChange.push(dom.value);
      }
    };
    return { node, dom, onChange };
  };

  it("reaches React's onChange, not just the DOM", () => {
    const input = reactInput("old details");
    const out = runFill([input.node], "new details");

    expect(out.ok, out.error).toBe(true);
    expect(input.dom.value).toBe("new details");
    expect(input.onChange).toEqual(["new details"]);
  });

  it("still fills an ordinary field that has no framework on it", () => {
    const events: string[] = [];
    const plain = { ...el("input", { name: "q" }), ...acting(events) };
    const out = runFill([plain], "hello");

    expect(out.ok, out.error).toBe(true);
    expect(plain.value).toBe("hello");
    expect(events).toEqual(["input", "change"]);
  });

  const select = (events: string[], options: Record<string, unknown>[]) => ({
    ...el("select", { name: "category" }),
    ...acting(events),
    options,
    selectedOptions: [],
    selectedIndex: -1,
  });
  const OPTIONS = [
    { label: "Choose one", value: "" },
    { label: "Gift cards", value: "gift_cards" },
    { label: "Discounts", value: "discounts" },
    { label: "Loyalty", value: "loyalty", disabled: true },
  ];

  it("chooses a select option by the text a person sees", () => {
    const events: string[] = [];
    const s = select(events, OPTIONS);
    const out = runFill([s], "Discounts");

    expect(out.ok, out.error).toBe(true);
    expect(s.selectedIndex).toBe(2);
    expect(out.data.chose).toBe("Discounts");
    expect(events).toContain("change");
  });

  it("accepts the option's hidden value too", () => {
    const s = select([], OPTIONS);
    expect(runFill([s], "gift_cards").ok).toBe(true);
    expect(s.selectedIndex).toBe(1);
  });

  it("names the real options instead of guessing at a near miss", () => {
    const s = select([], OPTIONS);
    const out = runFill([s], "Discount");

    expect(out.ok).toBe(false);
    expect(out.error).toContain('"Discounts"');
    expect(s.selectedIndex).toBe(-1);
  });

  it("refuses a disabled option", () => {
    const out = runFill([select([], OPTIONS)], "Loyalty");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("disabled");
  });

  it.each(["checkbox", "radio"])("sends a %s to click rather than typing into it", (type) => {
    const events: string[] = [];
    const box: Record<string, unknown> = {
      ...el("input", { type }, { checked: false }),
      ...acting(events),
    };
    const out = runFill([box], "true");

    expect(out.ok).toBe(false);
    expect(out.error).toContain("click");
    expect(box.checked).toBe(false);
    expect(events).toEqual([]);
  });

  /**
   * The write would SUCCEED on these, which is the problem: a link, a button or
   * a clickable div takes `el.value = text` without complaint, nothing visible
   * changes, and the old answer was `{filled}` for a field that does not exist.
   */
  it.each([
    ["link", el("a", { href: "/checkout" })],
    ["button", el("button")],
    ["role=button div", el("div", { role: "button" })],
    ["div with an onclick", el("div", { onclick: "go()" })],
  ])("refuses a %s, which has nothing to type into", (_, node) => {
    const events: string[] = [];
    const target: Record<string, unknown> = { ...node, ...acting(events) };
    const out = runFill([target], "hello");

    expect(out.ok).toBe(false);
    expect(out.error).toContain("not a field");
    expect(out.error).toContain("click it");
    expect(target.value).toBe("");
    expect(events).toEqual([]);
  });

  it("refuses a disabled field, as the page would a person", () => {
    const events: string[] = [];
    const field = { ...el("input", {}, { disabled: true }), ...acting(events) };
    const out = runFill([field], "x");

    expect(out.ok).toBe(false);
    expect(out.error).toContain("disabled");
    expect(field.value).toBe("");
  });
});

/**
 * Two tabs on the same URL, which is the case that clicked the wrong button.
 *
 * Every content script numbered its elements from 1 and a command found its
 * tab by URL, so `click e12` from tab A's enumeration could be claimed by tab B
 * and click B's own `e12` — irreversibly, with nothing in the result to say
 * which tab had acted. Each instance now draws a page token at load and puts it
 * in every id it hands out. The handler routes on that token, and these tests
 * pin the half that does not depend on routing being right: a page refuses
 * anything minted by a different load, so a misrouted command is an error and
 * never a click.
 *
 * Two `node:vm` contexts are two content-script instances — two isolated
 * worlds, each with its own element list, exactly as Safari runs them.
 */
describe("page tokens", () => {
  const CART = "https://shop.example/cart";

  type Run = (c: unknown) => { ok: boolean; data: Record<string, unknown>; error?: string };

  /** One tab: actions.js loaded over its own page, its button counting clicks. */
  const tab = (name: string, clicks: string[], href = CART) => {
    const button = {
      ...el("button", {}, { innerText: name }),
      scrollIntoView: () => {},
      click: () => void clicks.push(name),
    };
    const window: Record<string, unknown> = { innerHeight: 800, innerWidth: 1200 };
    const context = createContext({
      crypto: webcrypto,
      window,
      location: { href },
      document: { querySelectorAll: () => [button], getElementById: () => null },
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    });
    runInContext(SOURCE, context);
    const run = window.cupertinoRunCommand as Run;
    const listed = run({ action: "elements", limit: 50 });
    expect(listed.ok, listed.error).toBe(true);
    const elements = listed.data.elements as unknown as { id: string; label: string }[];
    return {
      run,
      token: window.cupertinoPageToken as string,
      page: listed.data.page as unknown as string,
      id: elements[0]!.id,
    };
  };

  it("gives each page load its own token, and puts it in every id", () => {
    const a = tab("Buy", []);
    const b = tab("Delete account", []);

    expect(a.token).toMatch(/^[0-9a-f]{8}$/);
    expect(b.token).toMatch(/^[0-9a-f]{8}$/);
    expect(a.token).not.toBe(b.token);
    // The same element number on both, which is exactly what used to collide.
    expect(a.id).toBe(`${a.token}-e1`);
    expect(b.id).toBe(`${b.token}-e1`);
    // And said once in the answer, so a caller need not parse an id for it.
    expect(a.page).toBe(a.token);
  });

  /** The bug, as the server now sends it: a click addressed to A's page load. */
  it("refuses a click minted on page A when page B is the one that receives it", () => {
    const clicks: string[] = [];
    const a = tab("Buy", clicks);
    const b = tab("Delete account", clicks);
    const command = { action: "click", url: CART, page: a.token, elementId: a.id };

    const onB = b.run(command);
    expect(onB.ok).toBe(false);
    expect(onB.error).toContain("different page load");
    expect(clicks).toEqual([]);

    const onA = a.run(command);
    expect(onA.ok, onA.error).toBe(true);
    expect(onA.data.clicked).toBe(a.id);
    expect(clicks).toEqual(["Buy"]);
  });

  /**
   * Without the command's `page` too. The id alone carries its load, so even a
   * command that lost its routing token cannot reach B's element of the same
   * number — the lookup never sees it.
   */
  it.each(["click", "fill"])("refuses A's id on B by the id alone, for a %s", (action) => {
    const clicks: string[] = [];
    const a = tab("Buy", clicks);
    const b = tab("Delete account", clicks);

    const out = b.run({ action, elementId: a.id, text: "x" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("different page load");
    expect(clicks).toEqual([]);
  });

  it("does not answer to a bare element number", () => {
    const clicks: string[] = [];
    const a = tab("Buy", clicks);

    const out = a.run({ action: "click", elementId: "e1" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("not an element id");
    expect(clicks).toEqual([]);
  });

  /**
   * The token pins the tab; the URL is what the caller believes it shows. A
   * single-page app that has moved on since the enumeration is the ordinary
   * way the two disagree, and the click is refused with the page's real URL
   * rather than landing on whatever the route now renders.
   */
  it("refuses a click when its page has moved to another URL", () => {
    const clicks: string[] = [];
    const a = tab("Buy", clicks, "https://shop.example/cart/confirm");

    const out = a.run({ action: "click", url: CART, page: a.token, elementId: a.id });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("now at https://shop.example/cart/confirm");
    expect(clicks).toEqual([]);
  });
});
