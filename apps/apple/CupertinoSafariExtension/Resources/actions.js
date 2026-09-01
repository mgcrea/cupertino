// What a page can be asked to DO, as opposed to what it can be asked to say.
//
// ## Why this lane and not `do JavaScript`
//
// Safari offers exactly one Apple Event that reaches inside a page, and it
// needs "Allow JavaScript from Apple Events" — a developer-menu toggle that is
// global, permanent, unscoped, and whose state cannot be read. Turning it on to
// click one button leaves every tab in the browser scriptable forever.
//
// A content script is the opposite of that in every respect: Safari grants it
// one website at a time, the user can see and revoke the grant, and it reaches
// nothing on a site they have not allowed. Same capability, consented at the
// granularity a person actually thinks in.
//
// ## Elements are addressed by ID, never by selector
//
// The obvious design is `click(selector)`, and it is wrong here. It requires
// whatever is driving to already know the DOM, which means shipping it the
// page's HTML — tens to hundreds of KB — and hoping the selector it writes
// still matches by the time it arrives. A stale or over-broad selector does not
// fail; it clicks the wrong thing.
//
// So the page hands out the list: `elements` returns the interactive nodes with
// a short id apiece, and `click`/`fill` take one of those ids. An id that no
// longer resolves is an error rather than a different element, which is the
// property that matters — the failure mode of the selector design is silent and
// the failure mode of this one is loud.
//
// IDs live only as long as the page. They are handed out per enumeration and
// die with a navigation, which is correct: an id that survived a page change
// would be an id that could act on a page nobody asked about.

(function () {
  /** Every element handed out this page-lifetime, by id. */
  const handles = new Map();
  let nextId = 1;

  /**
   * Is this something a person could actually interact with?
   *
   * Visibility is checked geometrically rather than by CSS, because the
   * interesting negatives — a modal's hidden backdrop, an off-screen menu, a
   * zero-height collapsed row — are all laid out and none of them are
   * `display: none`. An element nobody can see must not be offered as clickable.
   */
  function interactive(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
      return false;
    }
    if (el.disabled === true) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    return true;
  }

  /**
   * What to call this element, in the words a person would use.
   *
   * Ordered by how much the page MEANT it: an explicit accessible name beats
   * visible text, which beats a placeholder, which beats the raw value. Falling
   * through to `tagName` is deliberate — an unnamed control is still reportable,
   * and reporting it as "button" is honest where inventing a name would not be.
   */
  function label(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target?.innerText) return target.innerText.trim().slice(0, 120);
    }
    if (el.labels?.length && el.labels[0].innerText) {
      return el.labels[0].innerText.trim().slice(0, 120);
    }
    // `value` is the visible caption on a submit/button/reset input and NOTHING
    // else. Everywhere else it is what the user typed, which is a second door to
    // the same string `enumerate` is careful about below — a password field
    // whose value leaked out as its "label" would be redacted in name only.
    const caption = CAPTION_VALUE_TYPES.has(inputType(el)) ? el.value : "";
    const text = (el.innerText || caption || "").trim();
    if (text) return text.slice(0, 120);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim().slice(0, 120);
    const title = el.getAttribute("title");
    if (title) return title.trim().slice(0, 120);
    return el.tagName.toLowerCase();
  }

  /** Where `value` really is the caption a person reads, not what they typed. */
  const CAPTION_VALUE_TYPES = new Set(["submit", "button", "reset"]);

  function inputType(el) {
    if (el.tagName.toLowerCase() !== "input") return "";
    return (el.getAttribute("type") || "text").toLowerCase();
  }

  /** `autocomplete` is a token LIST — "section-a billing cc-number" is a match. */
  function autocompleteTokens(el) {
    return (el.getAttribute("autocomplete") || "").toLowerCase().trim().split(/\s+/);
  }

  const CREDENTIAL_TOKENS = new Set([
    "current-password",
    "new-password",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
    "cc-name",
  ]);

  /**
   * Every word the page uses to name a field, in one string to match against.
   *
   * The visible `<label>` is included because plenty of forms name the input
   * `input-2` and put the only human word on the label beside it.
   */
  function fieldWords(el) {
    const parts = [
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("placeholder"),
      el.getAttribute("aria-label"),
      el.labels?.length ? el.labels[0].innerText : "",
    ];
    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  const CODE_WORDS =
    /otp|one[-_ ]?time|2fa|mfa|totp|pass ?code|security ?code|verification ?code|auth(?:entication)? ?code|code ?de ?v[eé]rification/;

  /**
   * Is this field holding something that should not be handed out by default?
   *
   * Two classes, and the difference is the whole opt-in.
   *
   * A CREDENTIAL — a password, a card number — is never returned, whatever any
   * setting says. No tool in this server has a use for one, and the flag below
   * is named for codes; widening it to credentials would make it claim more than
   * its own label does.
   *
   * A CODE is returned only when the caller asked, which is the
   * "Read one-time codes" setting the user turned on by hand.
   *
   * The last rung — a short numeric field — will also catch postal codes,
   * quantities, PINs and years. That is the intended trade and not a bug to fix:
   * with the setting ON the value comes back anyway, and with it OFF a redacted
   * quantity costs the caller one more look at the page, while a leaked one-time
   * code costs an account.
   */
  function classifyField(el) {
    if (inputType(el) === "password") return "credential";
    const tokens = autocompleteTokens(el);
    if (tokens.some((t) => CREDENTIAL_TOKENS.has(t))) return "credential";
    if (tokens.includes("one-time-code")) return "code";

    const words = fieldWords(el);
    if (words && CODE_WORDS.test(words)) return "code";

    const maxLength = Number(el.getAttribute("maxlength"));
    if (maxLength >= 4 && maxLength <= 8) {
      const mode = (el.getAttribute("inputmode") || "").toLowerCase();
      const pattern = el.getAttribute("pattern") || "";
      if (mode === "numeric" || mode === "tel" || /\\d|\[0-9\]/.test(pattern)) return "code";
    }
    return null;
  }

  /** A coarse kind, so a caller can tell a link from a text field without a selector. */
  function kind(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textfield";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (["checkbox", "radio"].includes(type)) return "checkbox";
      return "textfield";
    }
    if (tag === "button") return "button";
    if (el.getAttribute("role") === "button") return "button";
    if (el.isContentEditable) return "textfield";
    return "control";
  }

  const SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=tab]",
    "[contenteditable=true]",
    "[onclick]",
  ].join(",");

  /**
   * What to say about a field's contents.
   *
   * `hasValue` is a boolean and never a length. "Is this already filled" is the
   * only question a caller legitimately has about a withheld field, and a
   * password's length is a weak leak bought for nothing.
   */
  function describeValue(el, includeCodes) {
    if (kind(el) !== "textfield") return { value: null };
    const held = el.value || "";
    const secrecy = classifyField(el);
    if (secrecy === "credential" || (secrecy === "code" && !includeCodes)) {
      return { value: null, redacted: secrecy, hasValue: held.length > 0 };
    }
    return { value: held.slice(0, 200) };
  }

  /**
   * Enumerate what can be acted on, newest ids winning.
   *
   * Capped, and the cap is not a performance guard — it is the same argument the
   * page-capture store makes about size. A search results page has hundreds of
   * links and a caller that receives all of them cannot reason about any of
   * them; a bounded list with a `truncated` flag is more useful than a complete
   * one nobody reads.
   */
  function enumerate(limit, includeCodes) {
    handles.clear();
    const found = [];
    const all = document.querySelectorAll(SELECTOR);
    for (const el of all) {
      if (!interactive(el)) continue;
      const id = "e" + nextId++;
      handles.set(id, el);
      const rect = el.getBoundingClientRect();
      found.push({
        id,
        kind: kind(el),
        label: label(el),
        // Whether it is on screen RIGHT NOW, which is different from existing.
        // A caller choosing between two plausible matches should prefer the one
        // the user can see.
        inView:
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || 0) &&
          rect.right <= (window.innerWidth || 0),
        href: el.tagName.toLowerCase() === "a" ? el.href || null : null,
        ...describeValue(el, includeCodes),
      });
      if (found.length >= limit) break;
    }
    return { elements: found, truncated: found.length >= limit && all.length > found.length };
  }

  function resolve(id) {
    const el = handles.get(id);
    if (!el) {
      throw new Error(
        'No element "' +
          id +
          '" on this page. IDs come from an "elements" call and do not survive a navigation — ' +
          "enumerate again.",
      );
    }
    if (!el.isConnected) {
      throw new Error(
        'Element "' +
          id +
          '" is no longer in the page. It was removed after it was enumerated; enumerate again.',
      );
    }
    return el;
  }

  /**
   * Click, the way a person does.
   *
   * `el.click()` rather than a synthesised MouseEvent: it is what the DOM offers
   * for exactly this, it runs the element's default action, and it does not
   * pretend to coordinates that were never real. Scrolled into view first
   * because a click on an off-screen element is legitimate but invisible, and a
   * user watching their own browser should see what was done to it.
   */
  function click(id) {
    const el = resolve(id);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.click();
    return { clicked: id, label: label(el), kind: kind(el) };
  }

  /**
   * Type into a field.
   *
   * The events are the point. Setting `.value` alone updates the DOM and tells
   * no framework about it — React, Vue and every controlled input keep their own
   * copy and will overwrite it on the next render. `input` and `change`, bubbling,
   * are what make the page believe a person typed.
   */
  function fill(id, text) {
    const el = resolve(id);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    if (el.isContentEditable) {
      el.textContent = text;
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: id, label: label(el) };
  }

  function scroll(direction) {
    const by = direction === "up" ? -window.innerHeight * 0.8 : window.innerHeight * 0.8;
    window.scrollBy({ top: by, behavior: "instant" });
    return { scrolledTo: Math.round(window.scrollY) };
  }

  /** Half-width of the excerpt handed back around a digit run. */
  const EXCERPT_PAD = 120;
  /** How far a boundary may creep outward to avoid cutting a number in half. */
  const EXCERPT_CREEP = 32;
  /** Characters that mean "this number is still going". */
  const NUMBERISH = /[\d.,\s()+-]/;

  /**
   * Find the digit runs a page is SHOWING, with enough text around each one for
   * the server to judge them.
   *
   * ## Why this exists next to `elements`
   *
   * `enumerate` returns things you can click or type into. The ordinary 2FA
   * case is neither: the code arrives as TEXT — "Your verification code is
   * 123456" in a webmail message, an issuer dashboard, a bank's confirmation
   * panel. There is no input to enumerate, so no setting makes `elements` see
   * it.
   *
   * The capture store cannot answer it either. A capture is taken at
   * `document_idle` and again after a route change; a code that arrives by XHR
   * into an already-loaded tab was never captured. This runs at command time
   * against the live DOM, which is the only thing that sees it.
   *
   * ## Why excerpts rather than the code itself
   *
   * The judgement lives in one tested place on the server, and duplicating it
   * here would be a second copy that drifts. So this returns bounded text and
   * decides nothing: no scoring, no keyword list, no "this looks like an OTP".
   *
   * ## The boundary creep is not cosmetic
   *
   * Slicing a fixed window out of "4111 1111 1111 1111" hands the server a
   * fragment that its own card-number disqualification would have caught in
   * full. So each boundary creeps outward while it is still sitting inside a
   * number, and a card number arrives whole and is rejected whole.
   */
  function findCodes(limit) {
    // An XML document or a frameset has no body, and a null root makes
    // createTreeWalker throw. "No codes here" is the honest answer for those,
    // not an error the caller has to interpret.
    if (!document.body) {
      return {
        excerpts: [],
        truncated: false,
        scannedAt: new Date().toISOString(),
        pageAgeSeconds: Math.round(performance.now() / 1000),
      };
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") {
          return NodeFilter.FILTER_REJECT;
        }
        // A compose box holds what the USER is typing. Reading it back is the
        // same act as reading a field's value, which this lane withholds.
        if (parent.closest("[contenteditable=true]")) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
        if (!interactive(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const excerpts = [];
    let truncated = false;
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || "";
      if (!/\d{4,8}/.test(text)) continue;
      if (excerpts.length >= limit) {
        truncated = true;
        break;
      }
      let start = 0;
      let end = text.length;
      if (text.length > EXCERPT_PAD * 2) {
        const hit = text.search(/\d{4,8}/);
        start = Math.max(0, hit - EXCERPT_PAD);
        end = Math.min(text.length, hit + EXCERPT_PAD);
        let creep = 0;
        while (start > 0 && creep < EXCERPT_CREEP && NUMBERISH.test(text[start - 1])) {
          start--;
          creep++;
        }
        creep = 0;
        while (end < text.length && creep < EXCERPT_CREEP && NUMBERISH.test(text[end])) {
          end++;
          creep++;
        }
      }
      const rect = node.parentElement.getBoundingClientRect();
      excerpts.push({
        text: text.slice(start, end).trim(),
        inView: rect.top >= 0 && rect.bottom <= (window.innerHeight || 0),
      });
    }

    return {
      excerpts,
      truncated,
      scannedAt: new Date().toISOString(),
      // Time since navigation start. An UPPER bound on how old anything on this
      // page can be, and never a lower one — see the tool description.
      pageAgeSeconds: Math.round(performance.now() / 1000),
    };
  }

  /**
   * Run one command and describe what happened.
   *
   * Never throws into the caller: a command that fails comes back as
   * `{ok: false, error}` and is reported, because the server is polling for a
   * result and an exception here would leave it waiting for one that never
   * arrives. A timeout that means "the page refused" and a timeout that means
   * "nothing was listening" are indistinguishable, and only one of them is
   * actionable.
   */
  window.cupertinoRunCommand = function (command) {
    try {
      switch (command.action) {
        case "elements":
          return {
            ok: true,
            data: enumerate(Math.min(command.limit || 60, 200), command.includeCodes === true),
          };
        case "click":
          return { ok: true, data: click(command.elementId) };
        case "fill":
          return { ok: true, data: fill(command.elementId, command.text ?? "") };
        case "scroll":
          return { ok: true, data: scroll(command.direction) };
        case "codes":
          return { ok: true, data: findCodes(Math.min(command.limit || 10, 40)) };
        default:
          return { ok: false, error: `Unknown action "${command.action}".` };
      }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  };
})();
