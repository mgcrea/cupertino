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
