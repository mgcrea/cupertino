/**
 * The Apple Events lane for Messages — which exists for exactly one verb.
 *
 * Every script here is a static constant. None may contain a template
 * interpolation: `assertStaticScript` rejects any script containing a dollar
 * sign followed by a brace, including one written inside the JXA source. Use
 * string concatenation in JXA code.
 *
 * Contract, shared with every other surface:
 *   - parameters arrive as `JSON.parse(argv[0])`
 *   - success returns `JSON.stringify({ok: true, data})`
 *   - an application-level failure returns `{ok: false, error: {code, message}}`
 *     and still exits 0, so a non-zero exit always means infrastructure.
 *
 * ## There is no read.ts here, and there never can be
 *
 * Adding a send did not add a read lane, and on this surface that is not a
 * policy choice — it is the measurement in `docs/messages.md`:
 *
 * | attempt          | result                                    |
 * | ---------------- | ----------------------------------------- |
 * | `chats()`        | `Error: Application isn't running.`       |
 * | `chats.id()`     | `TypeError: M.chats.id is not a function` |
 * | `participants()` | `Error: Application isn't running.`       |
 * | `buddies()`      | `Error: Application isn't running.`       |
 * | messages of chat | `Error: Application isn't running.`       |
 *
 * Messages answers "Application isn't running" while `NSRunningApplication`
 * reports it running, because it lives as a windowless background process that
 * declines to wake for a script. `test/jxa.test.ts` asserts `read.ts` does not
 * exist, so this cannot be re-added out of helpfulness.
 *
 * The consequence for the code below is concrete: **the target resolution steps
 * that enumerate anything are expected to fail**, which is why they are a ladder
 * and why every rung reports itself. The one rung that does not enumerate —
 * `chats.byId(guid)`, with the guid handed over by the file lane — is the one
 * this design is built around.
 *
 * ## What the dictionary actually offers
 *
 * MEASURED from `sdef /System/Applications/Messages.app` on macOS 26.6. Three
 * commands, and only one of them is a write:
 *
 *     send     text (or a file) to a participant or a chat
 *     login    log in to all accounts
 *     logout   log out of all accounts
 *
 * `login`/`logout` are not exposed as tools: logging a user out of iMessage on
 * every device is not something to do behind a tool call, and there is no read
 * to justify logging in.
 *
 * `send`'s direct parameter is typed `file` OR `text`. **Both ship, in two lanes
 * with different bounds.** This paragraph used to record the file form as
 * deliberately omitted — a tool that transfers an arbitrary local path to a
 * remote person is an exfiltration primitive, and unlike the text form its blast
 * radius is not bounded by what the model can say. That reasoning is unchanged.
 * What changed is that it turned out to argue against *one* of the two things
 * a file send could mean, not both:
 *
 *   - `attachmentId` forwards a file ALREADY in this Mac's Messages store,
 *     named by the same `attachment.guid` `save_attachment` takes. The client
 *     resolves it through the same source boundary — inside `messagesRoot`,
 *     nothing else — so there is no arbitrary path and no arbitrary read. The
 *     set is bounded by construction, which is why this lane ships under
 *     `allowWrites` alone.
 *   - `filePath` names any local file, and IS the primitive above. It is
 *     registered only when `allowFileSend` is on, and defaults off.
 *
 * The script below cannot tell the two apart and must not try: it receives one
 * already-resolved `p.file` and forwards it. Every bound lives in the client,
 * because a script that composed its own path would move the boundary somewhere
 * nothing tests. `test/jxa.test.ts` pins that — one `Path(`, and its argument is
 * `p.file`.
 *
 * ## The `to` parameter, and why the file lane picks the target
 *
 * `send` takes a `participant` or a `chat`. Getting one of those normally means
 * enumerating, which is the thing that does not work here. But the `chat` class
 * carries `id` — "A guid identifier for this chat" — and the file lane already
 * holds `chat.guid` for all 1,027 chats on the measured store. So the read lane
 * chooses the target and the write lane addresses it by id, which is the only
 * arrangement where neither lane has to do the thing it cannot.
 *
 * That the two guids are the same string is NOT assumed. It is the exact class
 * of thing this project has been wrong about before — `docs/messages.md` calls
 * the id bridge "unanswerable by construction" because Messages returned no
 * identifier to bridge FROM. So `chats.byId` is rung one of a ladder, every rung
 * records why it failed, and the strategy that worked is reported back to the
 * caller in the tool result.
 */

/** The bundle id, which does not match the display name: Messages.app is still MobileSMS. */
export const PRELUDE = `
ObjC.import("AppKit");

function ok(data) { return JSON.stringify({ ok: true, data: data }); }
function err(code, message, extra) {
  var e = { code: code, message: String(message) };
  if (extra) e.detail = extra;
  return JSON.stringify({ ok: false, error: e });
}

/** Read one property defensively — every read on this surface is allowed to fail. */
function prop(fn, fallback) {
  try {
    var v = fn();
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function isMessagesRunning() {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.MobileSMS");
  return apps.count > 0;
}

/** The dictionary's service type enumeration: SMS, iMessage, RCS. */
function serviceEnum(name) {
  var s = String(name || "").toLowerCase();
  if (s === "sms") return "SMS";
  if (s === "rcs") return "RCS";
  return "iMessage";
}

/**
 * Find something \`send\` will accept as its \`to\`.
 *
 * Ordered cheapest and most-likely-to-work first. Every rung is wrapped, every
 * failure is recorded, and the caller is told which one answered — on a surface
 * whose whole read half is known broken, "it worked" without "how" is not a
 * result anyone can act on later.
 */
function resolveTarget(M, p, tried) {
  var i;

  // 1. The chat guid the file lane read out of chat.db. No enumeration.
  if (p.chatGuid) {
    try {
      var chat = M.chats.byId(p.chatGuid);
      chat.id();
      return { target: chat, strategy: "chat-guid", kind: "chat" };
    } catch (e) {
      tried.push("chat-guid: " + (e.message || e));
    }
  }

  if (!p.handle) return null;

  // 2. The guid Messages composes for a one-to-one chat, spelled the way the
  //    store spells it: "iMessage;-;+15551234567". Constructed rather than read,
  //    so it is below the real one and above everything that enumerates.
  var services = p.service ? [serviceEnum(p.service)] : ["iMessage", "SMS", "RCS"];
  for (i = 0; i < services.length; i++) {
    var guess = services[i] + ";-;" + p.handle;
    try {
      var guessed = M.chats.byId(guess);
      guessed.id();
      return { target: guessed, strategy: "chat-guid-guess", kind: "chat", guid: guess };
    } catch (e2) {
      tried.push("chat-guid-guess(" + guess + "): " + (e2.message || e2));
    }
  }

  // 3. A participant reached through its account. This enumerates, so it is
  //    expected to fail with "Application isn't running" — kept because it is
  //    the form every AppleScript example on the internet uses, and because if
  //    launching the app does wake the scripting interface, this is what works.
  for (i = 0; i < services.length; i++) {
    try {
      var accounts = M.accounts.whose({ serviceType: services[i] })();
      for (var j = 0; j < accounts.length; j++) {
        try {
          var buddy = accounts[j].participants.whose({ handle: p.handle })()[0];
          if (buddy) {
            buddy.id();
            return { target: buddy, strategy: "account-participant", kind: "participant" };
          }
        } catch (e4) {
          tried.push("account-participant(" + services[i] + "): " + (e4.message || e4));
        }
      }
    } catch (e3) {
      tried.push("accounts(" + services[i] + "): " + (e3.message || e3));
    }
  }

  // 4. The flat participant list, last because it is the widest enumeration.
  try {
    var flat = M.participants.whose({ handle: p.handle })()[0];
    if (flat) {
      flat.id();
      return { target: flat, strategy: "participant", kind: "participant" };
    }
    tried.push("participant: no participant with that handle");
  } catch (e5) {
    tried.push("participant: " + (e5.message || e5));
  }

  return null;
}
`;
