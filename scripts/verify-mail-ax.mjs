#!/usr/bin/env node
/**
 * Verify the native composer lane, by hand, against a live Mail.
 *
 * Everything in `packages/mail/test/{ax,compose,open-composer}.test.ts` runs
 * against stubs — they pin the sequence and the refusals, and they cannot tell
 * you whether macOS honours any of it. This does, and it is the check the
 * agent that wrote the lane could not run: it needs a real Mail, a real
 * message, and the Accessibility grant on the running Cupertino bundle.
 *
 * Read-only by default. It walks the composer path WITHOUT opening a composer,
 * so it can be run on a working machine at any time. `--compose` goes further
 * and is opt-in.
 *
 *   node scripts/verify-mail-ax.mjs
 *   node scripts/verify-mail-ax.mjs --compose
 *
 * ## `--compose` runs the check; it used to print one
 *
 * It printed a three-line checklist for a person to carry out by hand, and the
 * cost of that is on the record: `apple_desktop_focus` shipped in 1.16.0
 * returning the composer web area's own `AXFocused`, which is FALSE while the
 * element holds the keyboard, so every reply and forward refused to paste a
 * body that would have gone in. The unit tests stub `focus` and assert both
 * branches happily. Nothing but a live compose could have caught it, and the
 * checklist that would have was never run.
 *
 * So it forwards a real message and asserts the body arrived. **Forward rather
 * than reply, deliberately**: a forward names its own recipients, so the draft
 * is addressed to the user's own account and cannot reach a third party even if
 * something goes wrong. A reply is addressed by Mail, to whoever wrote.
 *
 * It sends nothing — `sendNow` is false, and the tool needs `confirm: true` on
 * top of that to send at all. It LEAVES the draft and its window in Mail rather
 * than tidying up, which is not laziness: the draft is the evidence, and a
 * person can look at it and see the words really are in there. The last lines
 * of output say exactly what to delete.
 *
 * ## It then REWRITES that draft, which needs the window it just left open
 *
 * The composer still being there is the state every revision starts from
 * ("draft a reply, now change this line"), so `--compose` goes on to rewrite the
 * draft in place and asserts `method: "inPlace"` — not merely that it worked.
 * Recreating would also report success while quietly refusing a forward, which
 * is the whole failure the in-place lane exists to remove.
 *
 * And the keystrokes are the part no stub can vouch for: command-up, shift-down
 * and shift-command-right have to still mean what they meant when the selection
 * was measured, and the selection has to still be legible off the pasteboard —
 * `AXSelectedText` reads null on Mail's composer, so a copy is the only way to
 * read it. If Apple changes any of that, this is what notices.
 *
 * ## Then the native edit, the rebuild and the handles (2026-10-26)
 *
 * The composer moved into the app (docs/mail-compose.md, "The composer moved
 * into the app"), and `--compose` goes on to check what only a live Mail can:
 *
 *   1. `update_draft` with `edits` on the open forward: only the matched word
 *      changes, the forward's files and quote survive, and the SAVED source says so.
 *   2. Two composers under ONE subject: `list_open_drafts` gives each a handle,
 *      `update_draft` with `composer` edits the right one and leaves the other
 *      alone, and an edit that names no target refuses while several are open.
 *   3. Route B: the forward's window is closed, a self-sent message is reply-drafted,
 *      that window is closed too, and `update_draft` by `ref` REBUILDS it as a
 *      reply. The saved source must keep `In-Reply-To`, and exactly one draft may
 *      remain under the subject.
 *   4. (Manual, printed at the end.) A rebuild refuses when the quote was edited
 *      by hand. It needs a person, so it is not automated.
 *
 * ## Composers in tabs (2026-10-26, task 11)
 *
 * With "Prefer tabs when opening documents: Always", Mail opens every composer
 * as a TAB of one window, and only the selected tab can be read. Case 2 then
 * finds its two composers as tabs and checks what tabs add: the background one
 * is listed with no text; by handle it refuses (its title is shared) with no
 * tab switched; by ref it is selected, checked, edited, saved, and the tab
 * that was shown is selected again. Saved drafts are looked for in every
 * account's Drafts, and a prompt to close a composer that is a tab says
 * "(tab)": closing a window closes its SELECTED tab, so select that one first.
 *
 * Every draft these make goes to the user's own address and none is sent. Cases
 * 2 and 3 are CLEANED UP, even on failure: their saved drafts are deleted, and
 * the script can only ask for their windows to be closed, not close them (the
 * app's driver is not lent to a terminal, which is the point of the peer check
 * above). So it WAITS, up to two minutes per window, polling `list_open_drafts`,
 * and says which window it is waiting for. Close each with command-W; a saved
 * composer closes without a sheet. The forward and new-message drafts of the
 * older cases are still left as evidence, as described above.
 *
 * What a failure means, in order of likelihood:
 *
 *   * `no socket`      — Cupertino is not running, or this shell is not one of
 *                        its servers. This script talks to the app directly, so
 *                        it sets the two variables itself; if it still cannot
 *                        connect, the app is not up.
 *   * `err ... not a mail server` — expected, and the point. The peer check
 *                        refuses anything the app did not spawn. See below.
 *   * `not granted`    — Accessibility is not on the RUNNING bundle. Toggle it
 *                        off and on: the grant goes stale after an in-place
 *                        install, and diagnostics rather than the checkbox is
 *                        the proof.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DEBUG = process.argv.includes("--debug");
const COMPOSE = process.argv.includes("--compose");
const BUNDLE = DEBUG ? "io.mgcrea.cupertino.debug" : "io.mgcrea.cupertino";
const SOCKET = join(homedir(), "Library/Application Support", BUNDLE, "cupertino.sock");

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

// Helpers for the --compose cases. Consts, so they must precede the top-level
// `await composeCheck()` below: a function declaration hoists, a const does not.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `fn` until it returns something truthy, `tries` times, `ms` apart. */
const until = async (fn, tries = 10, ms = 1000) => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (attempt > 0) await sleep(ms);
    const value = await fn();
    if (value) return value;
  }
  return null;
};

/**
 * Saved drafts with exactly this subject, newest first, in EVERY account's
 * Drafts. LIVE RUN 3 looked in the first account's only, and called a new
 * message unsaved that Mail had saved in another (the Magenta account): a new
 * message is saved under the account it is sent from.
 */
const draftsBySubject = async (mail, subject) => {
  let accounts = [];
  try {
    accounts = ((await mail.call("apple_mail_list_accounts")) ?? []).filter(
      (a) => a?.enabled !== false,
    );
  } catch {
    // Listed below without an account: the first one's, as this used to.
  }
  const found = [];
  for (const account of accounts.length > 0 ? accounts : [null]) {
    try {
      const listed = await mail.call("apple_mail_list_messages", {
        ...(account ? { account: account.id } : {}),
        mailbox: "Drafts",
        limit: 50,
      });
      found.push(...(listed?.messages ?? []).filter((m) => m.subject === subject));
    } catch {
      // An account with no Drafts mailbox has nothing to find.
    }
  }
  const when = (m) => Date.parse(m.dateReceived ?? m.dateSent ?? "") || 0;
  return found.sort((a, b) => when(b) - when(a));
};

/** The compose windows open now, or null when Mail could not be asked. */
const openComposers = async (mail, quoteChars = 0) => {
  const listed = await mail.call("apple_mail_list_open_drafts", { quoteChars });
  return listed?.degraded === true ? null : (listed?.drafts ?? []);
};

/**
 * Wait for a person (or the controller) to close the window titled `subject`.
 * The script cannot close it: the app's driver is not lent to a terminal.
 */
const waitForClose = async (mail, subject, seconds = 120) => {
  // With "Prefer tabs: Always" the composer is a TAB, and closing the window's
  // selected tab could close another draft: the line says "(tab)", so whoever
  // closes it selects that tab first.
  const open = ((await openComposers(mail)) ?? []).filter((c) => c.subject === subject);
  const tabs = open.filter((c) => c.tab != null).length;
  const kind =
    tabs > 0
      ? open.length > 1
        ? ` (${open.length} tabs)`
        : " (tab)"
      : open.length > 1
        ? ` (${open.length} windows)`
        : "";
  console.log(
    `  ...  close the Mail window "${subject}"${kind} (command-W); waiting up to ${seconds}s`,
  );
  const gone = await until(
    async () => {
      const composers = await openComposers(mail);
      return composers !== null && !composers.some((c) => c.subject === subject);
    },
    seconds,
    1000,
  );
  return gone !== null;
};

/**
 * Delete the drafts of one subject that THIS run made. The caller owns that
 * subject: it is stamped, or it was checked absent before the run made one.
 */
const deleteDrafts = async (mail, subject) => {
  try {
    const found = await draftsBySubject(mail, subject);
    if (found.length === 0) return;
    await mail.call("apple_mail_delete_messages", { refs: found.map((m) => m.ref), confirm: true });
    console.log(`  ok   cleaned up ${found.length} draft(s) titled "${subject}"`);
  } catch (error) {
    console.log(`  FAIL could not delete drafts titled "${subject}": ${error.message}`);
    failed += 1;
  }
};

/** The addresses in a header value, lower-cased. */
const addressesIn = (value) =>
  (String(value ?? "").match(/[\w.+'-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []).map((a) => a.toLowerCase());

/**
 * Speak the lent handshake, as `packages/core/src/ax.ts` does.
 *
 * NOTE: this will be REFUSED, and that refusal is itself the most important
 * thing this script proves. `ServerHost` checks the peer pid against the
 * servers it spawned, and a script run from a terminal is not one of them —
 * which is exactly what stops any same-user process borrowing the app's
 * Accessibility grant. To exercise the lane for real, run it through Mail:
 * `--compose` does that, via the mail server the app already hosts.
 */
const rpc = (handshake) =>
  new Promise((resolve, reject) => {
    const socket = connect(SOCKET);
    let buffer = "";
    let greeted = false;
    let nextId = 1;
    const waiting = new Map();
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!greeted) {
          greeted = true;
          if (line.trim() !== "ok") {
            socket.destroy();
            reject(new Error(line.trim()));
            return;
          }
          const request = (method, params) =>
            new Promise((ok, no) => {
              const id = nextId++;
              waiting.set(id, { ok, no });
              socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
            });
          resolve({
            request,
            call: (tool, args = {}) => request("tools/call", { name: tool, arguments: args }),
            notify: (method, params = {}) =>
              socket.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
            close: () => socket.destroy(),
          });
          continue;
        }
        const message = JSON.parse(line);
        const pending = waiting.get(message.id);
        if (!pending) continue;
        waiting.delete(message.id);
        if (message.error) {
          pending.no(new Error(message.error.message));
          continue;
        }
        // `initialize` answers with a plain result; a tool call answers with a
        // content envelope. Anything without content is handed back as it came.
        if (!message.result?.content) {
          pending.ok(message.result);
          continue;
        }
        const text = message.result.content[0]?.text ?? "";
        // `isError` is a REFUSAL wearing a result's clothes, and reading past it
        // is how `packages/core/src/ax.ts` spent an afternoon treating "no" as
        // "yes". The text is prose in that case, not JSON, so parsing is not a
        // way to notice either.
        if (message.result?.isError === true) {
          pending.no(new Error(text || "refused, with no reason given"));
          continue;
        }
        try {
          pending.ok(JSON.parse(text));
        } catch {
          pending.ok({ text });
        }
      }
    });
    socket.write(`${handshake}\n`);
  });

console.log(`\nmail accessibility lane (${BUNDLE})\n`);

// ─── the peer check, which is the security property ────────────────────────
let refusedFromTerminal = false;
let refusal = "";
try {
  const channel = await rpc(`cupertino/1 desktop for=mail`);
  channel.close();
} catch (error) {
  refusedFromTerminal = true;
  refusal = error.message;
}
// THREE outcomes look like a refusal and only one of them proves anything.
// Both of the others made an earlier version of this script report a pass:
//
//   * ENOENT / ECONNREFUSED — the app is not running, so nothing answered. The
//     --debug run hit this and "passed".
//   * "unsupported protocol" — the app is running but predates the lent
//     handshake, so it rejected the ARITY and the peer check was never reached.
//     The installed 1.15.0 hit this and "passed".
//   * anything else — the app understood the handshake and refused it, which is
//     the peer check doing its job. Only this one is evidence.
const notRunning = /ENOENT|ECONNREFUSED/.test(refusal);
const staleApp = /unsupported protocol/.test(refusal);
const reachedPeerCheck = refusedFromTerminal && !notRunning && !staleApp;

check(
  "a Cupertino is running and answered",
  !notRunning,
  notRunning ? `nothing is listening on ${SOCKET} — start the app` : "",
);
check(
  "the running app knows the lent handshake",
  !notRunning && !staleApp,
  staleApp
    ? `this Cupertino predates it (${refusal}) — install the build under test, or ` +
        "re-run with --debug against a local one"
    : notRunning
      ? "not reached"
      : "",
);
check(
  "a terminal cannot borrow the driver by claiming to be the mail server",
  reachedPeerCheck,
  reachedPeerCheck
    ? refusal
    : notRunning || staleApp
      ? "NOT PROVEN — see above"
      : "IT WAS SERVED — the peer check is not working",
);

if (!refusedFromTerminal && !notRunning && !staleApp) {
  console.log(
    "\nThis is the one result that must not be explained away. `LOCAL_PEERPID` is\n" +
      "what stops any same-user process borrowing Cupertino's Accessibility grant,\n" +
      "and it just served one. Stop and look at ServerHost.serve.\n",
  );
}

// ─── the rest goes through the mail server, which IS a spawned peer ────────
//
// A plain client handshake, the one `cupertino-bridge` sends. This script may
// not borrow the driver — the check above exists to prove it cannot — but it
// may talk to the mail server the same way any wired client does, and that
// server holds the lend.
console.log("");

if (!COMPOSE) {
  console.log(
    "The write side is not checked. Re-run with --compose to forward a real\n" +
      "message to your own address and assert the body arrived. It sends nothing.\n",
  );
} else if (notRunning) {
  check("the compose check ran", false, "no app to run it against");
} else {
  await composeCheck();
}

async function composeCheck() {
  let mail;
  try {
    mail = await rpc(`cupertino/1 mail`);
  } catch (error) {
    check("the mail server answered", false, error.message);
    return;
  }
  try {
    // MCP wants a handshake before a tool call, and a node server behind the
    // socket is stricter about it than the in-process surfaces are.
    await mail.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "verify-mail-ax", version: "0" },
    });
    mail.notify("notifications/initialized");

    const diagnostics = await mail.call("apple_mail_diagnostics");
    const lane = diagnostics?.permissions?.composerLane ?? null;
    check(
      "the mail server drives the composer through Accessibility",
      lane === "accessibility",
      lane === null ? "diagnostics reported no composerLane" : `composerLane: ${lane}`,
    );

    // The point of the whole lane: the SECOND grant is not needed. Reported
    // rather than asserted — a machine that still has it granted is not broken,
    // it just is not evidence.
    const se = diagnostics?.permissions?.automationSystemEvents ?? "unknown";
    console.log(
      se === "granted"
        ? `  note Automation to System Events is still granted, so this run does not\n` +
            `       prove the second grant is unnecessary. Revoke it and run again.`
        : `  ok   Automation to System Events is ${se}, so this run is the proof that\n` +
            `       the second grant is gone and the composer still works`,
    );

    const address = diagnostics?.accounts?.find((a) => a.emailAddresses?.length)
      ?.emailAddresses?.[0];
    if (!address) {
      check("an account with an address to forward to", false, "none reported");
      return;
    }

    await newMessageCheck(mail, address);

    const listed = await mail.call("apple_mail_list_messages", { limit: 1 });
    const target = listed?.messages?.[0];
    if (!target?.ref) {
      check("a message to forward", false, "the newest mailbox listing came back empty");
      return;
    }

    // Long enough that a truncated or partial paste cannot pass by accident,
    // and stamped so a leftover draft can be told from any other.
    const stamp = new Date().toISOString();
    const body =
      `Cupertino verify-mail-ax ${stamp}. This draft was made by a check and was ` +
      `never sent. Every word of this sentence had to arrive through the clipboard ` +
      `and a synthetic command-V for the check to pass, which is the only way to ` +
      `know the Accessibility lane still reaches Mail's composer.`;

    console.log(`\n  forwarding "${target.subject ?? "(no subject)"}" to ${address}\n`);

    let result;
    try {
      result = await mail.call("apple_mail_forward_message", {
        ref: target.ref,
        to: [address],
        body,
        sendNow: false,
      });
    } catch (error) {
      // A refusal arrives here, including "this tool does not exist" when
      // writes are off — which is a configuration, not a failure of the lane.
      check(
        "the forward was accepted",
        false,
        /unknown tool|not found/i.test(error.message)
          ? `${error.message} — turn writes on for Mail in Cupertino`
          : error.message,
      );
      return;
    }

    check("the forward composed without error", result?.ok === true, result?.note ?? "");
    check(
      "the body was read back OUT of the composer and matched",
      result?.bodyVerified === true,
      result?.bodyVerified === true
        ? `${result.verifiedChars} characters verified`
        : "this is the failure 1.16.0 shipped — apple_desktop_focus answering " +
            "the element's own AXFocused instead of the app's AXFocusedUIElement",
    );
    check("nothing was sent", result?.sent === false, `sent: ${result?.sent}`);

    // The forward left a saved draft and its composer window, which is exactly
    // the state a revision starts from — so the rewrite is checked here rather
    // than in a run of its own.
    if (result?.ok === true) {
      await reviseCheck(mail, result.subject);
      await editsCheck(mail, result.subject);
      await handlesCheck(mail, address);
      await rebuildCheck(mail, address, result.subject);
      console.log(
        "\n  MANUAL (needs a person, not run): a rebuild refuses when the quote was edited\n" +
          "  by hand. Reply to any message to yourself, type a word INSIDE the quoted\n" +
          "  original, save (command-S), close the window, then ask update_draft by ref\n" +
          "  for an edit. Expect replaced: false, a reason saying the quote is not the\n" +
          "  one Mail would write, the original draft untouched and no second draft.",
      );
    }

    // What is actually on screen differs by outcome. After a failure the compose
    // path never pressed command-S, but Mail autosaves an open composer on its
    // own (live run 2 found one in Drafts), so the window may hold unverified
    // text and Drafts a copy of it.
    console.log(
      result?.ok === true
        ? `\n  Left in Mail, on purpose, as the evidence:\n` +
            `    a saved draft "${result.subject}" addressed to ${address}\n` +
            `    (its window is closed by the rebuild case when that ran),\n` +
            `    a new-message draft "Cupertino verify-mail-ax new …" beside it,\n` +
            `    and its composer window. Its note now reads REVISED, two files\n` +
            `    (verify-note.txt, verify-dot.png) follow it, and the forwarded\n` +
            `    message below should be untouched — that is what the in-place\n` +
            `    rewrite and attach are claiming.\n` +
            `  Open it, read it, then delete both. Nothing here will.\n`
        : `\n  Left in Mail: the composer window "${result?.subject ?? "Fwd: …"}", empty or\n` +
            `  holding text this could not verify.\n` +
            `  The compose path stops before command-S when it cannot verify the\n` +
            `  body, but Mail autosaves an open composer on its own (run 2 found\n` +
            `  one in Drafts with X-Apple-Auto-Saved: 1). Close the window in Mail\n` +
            `  WITHOUT saving, then check Drafts for a copy and delete it.\n`,
    );
  } finally {
    mail.close();
  }
}

/**
 * Compose a NEW message to the user's own address, and read what Mail stored.
 *
 * The check that would have caught the 2026-10-21 incident, and 22 messages
 * before it: a new message's body used to be ASSIGNED, Mail wrapped it in a
 * `<blockquote type="cite">` inside an `Apple-Mail-URLShareWrapperClass` div
 * styled with no border, and every recipient outside Mail read the mail as one
 * long quote. Mail's own window showed nothing wrong, so this reads the saved
 * draft's raw SOURCE rather than the window. It sends nothing, and the draft is
 * left beside the forward's for the same reason the forward's is.
 */
async function newMessageCheck(mail, address) {
  const subject = `Cupertino verify-mail-ax new ${new Date().toISOString()}`;
  let result;
  try {
    result = await mail.call("apple_mail_send_message", {
      to: [address],
      subject,
      body: "A new message made by a check, never sent. Its body must not be quoted.",
      sendNow: false,
    });
  } catch (error) {
    check("the new message was accepted", false, error.message);
    return;
  }
  check(
    "the new message's body was pasted and read back",
    result?.ok === true && result?.bodyVerified === true,
    result?.note ?? JSON.stringify(result),
  );
  if (result?.ok !== true) return;

  const draft = await until(async () => (await draftsBySubject(mail, subject))[0] ?? null);
  if (!draft?.ref) {
    check(
      "the new message was saved to Drafts",
      false,
      `no draft "${subject}" in any account's Drafts after 10s`,
    );
    return;
  }
  const source = await mail.call("apple_mail_get_message_source", {
    ref: draft.ref,
    maxBytes: 1_000_000,
  });
  const raw = String(source?.source ?? "");
  const quoted = /URLShareWrapperClass|blockquote/i.test(raw);
  check(
    "the new message is NOT wrapped in a quotation",
    raw.length > 0 && !quoted,
    raw.length === 0
      ? "its source could not be read"
      : quoted
        ? "found a blockquote in its source"
        : "no blockquote in its saved source",
  );
}

/**
 * Rewrite the draft the forward just left, in its own composer window.
 *
 * The one thing no unit test can tell you: whether macOS still lets a selection
 * be walked over a composer's own text and read back off the pasteboard. Every
 * refusal in `revise.ts` is reachable from a fake; none of them proves the
 * keystrokes still mean what they meant when they were measured.
 *
 * `method: "inPlace"` is therefore the assertion that matters. A pass on
 * `replaced` alone would be satisfied by the fallback recreating the draft —
 * which is precisely the outcome this lane exists to avoid, and which would
 * have REFUSED here anyway, a forward carrying threading headers.
 */
async function reviseCheck(mail, subject) {
  /*
   * Listed, not searched. The AppleScript lane sees a draft the moment Mail
   * saves it; the index lane does not, and MEASURED here it was still missing
   * three minutes later. That is a property of Mail's Envelope Index, not a
   * problem to wait out.
   *
   * This listing is also what found the off-by-one in `LIST_RECENT`: it used to
   * come back with a null subject and a `#null` ref for every row of any mailbox
   * holding fewer messages than the limit, which is nearly every Drafts mailbox.
   * A short poll remains because the save is a keystroke, not a transaction.
   */
  const draft = await until(async () => (await draftsBySubject(mail, subject))[0] ?? null);
  if (!draft?.ref) {
    check(
      "the draft could be addressed, to rewrite it",
      false,
      `no draft titled "${subject}" in Drafts after 10s`,
    );
    return;
  }

  const stamp = new Date().toISOString();
  const revised =
    `Cupertino verify-mail-ax REVISED ${stamp}. This replaced the note above the ` +
    `forwarded message, in the composer window that was already open, without ` +
    `recreating the draft — which is the only way the forwarded message below it ` +
    `and this draft's threading headers can still be here.`;

  let result;
  try {
    result = await mail.call("apple_mail_update_draft", {
      ref: draft.ref,
      body: revised,
      confirm: true,
    });
  } catch (error) {
    check("the rewrite was accepted", false, error.message);
    return;
  }

  check(
    "the draft was rewritten IN ITS COMPOSER, not recreated",
    result?.method === "inPlace" && result?.replaced === true,
    result?.method === "inPlace"
      ? (result?.reason ?? "")
      : `method: ${result?.method} — ${result?.reason ?? "no reason given"}`,
  );
  check(
    "the quoted original was left alone",
    result?.quoteKept === true,
    `quoteKept: ${result?.quoteKept}`,
  );
  check("it was saved", result?.saved === true, result?.note ?? "");
  if (result?.saved === true) await attachCheck(mail, subject);
}

/**
 * Add two files to the same draft, in the same window, with no new body.
 *
 * A file goes in by pasting its URL, the way a file copied in Finder does, and
 * is confirmed by reading its name back out of the sender's own text. MEASURED
 * by hand on macOS 27.0 one file at a time, in a new message; this is the
 * check for two at once, in a composer that quotes something, which the stubs
 * cannot vouch for. One is an image and one is not, because Mail shows the two
 * differently: an AXImage named with the file, and an AXButton named with the
 * file and its size.
 */
async function attachCheck(mail, subject) {
  const dir = mkdtempSync(join(tmpdir(), "verify-mail-ax-"));
  const files = [join(dir, "verify-note.txt"), join(dir, "verify-dot.png")];
  writeFileSync(files[0], "Cupertino verify-mail-ax attachment\n");
  // A 1x1 PNG.
  writeFileSync(
    files[1],
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  try {
    const draft = (await draftsBySubject(mail, subject))[0] ?? null;
    if (!draft?.ref) {
      check("the draft could be addressed, to attach to it", false, `no draft "${subject}"`);
      return;
    }
    let result;
    try {
      result = await mail.call("apple_mail_update_draft", {
        ref: draft.ref,
        attachments: files,
        confirm: true,
      });
    } catch (error) {
      check("the files were accepted", false, error.message);
      return;
    }
    check(
      "both files went in IN ITS COMPOSER and read back",
      result?.method === "inPlace" && result?.replaced === true && result?.attachmentsAdded === 2,
      result?.replaced === true
        ? `attachmentsAdded: ${JSON.stringify(result?.attachmentsAdded)}`
        : `method: ${result?.method} — ${result?.reason ?? "no reason given"}`,
    );
    check(
      "the quoted original was left alone",
      result?.quoteKept === true,
      `quoteKept: ${result?.quoteKept}`,
    );
    check("it was saved", result?.saved === true, result?.note ?? "");
  } finally {
    // Mail copies a file into the draft when it saves, so the originals can go.
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── the native edit, the handles and the rebuild ───────────────────────────

/**
 * Case 1: `edits` on the open forward. Only the matched word may change, and
 * what the forward already carries (its files, its quote) must survive, as the
 * SAVED source says, not the window.
 */
async function editsCheck(mail, subject) {
  const composers = await openComposers(mail);
  const mine = (composers ?? []).filter((c) => c.subject === subject);
  if (mine.length !== 1) {
    check(
      "the forward's window could be addressed by a handle",
      false,
      composers === null
        ? "open drafts could not be read"
        : `${mine.length} windows titled "${subject}"`,
    );
    return;
  }
  let result;
  try {
    result = await mail.call("apple_mail_update_draft", {
      composer: mine[0].composer,
      edits: [{ find: "REVISED", replace: "EDITED" }],
      confirm: true,
    });
  } catch (error) {
    check("the find/replace edit was accepted", false, error.message);
    return;
  }
  check(
    "edits changed only the matched text, in the composer",
    result?.method === "inPlace" && result?.replaced === true && result?.quoteKept === true,
    result?.replaced === true
      ? `method: ${result.method}, quoteKept: ${result.quoteKept}`
      : `method: ${result?.method} — ${result?.reason ?? "no reason given"}`,
  );
  check("the edit was saved", result?.saved === true, result?.note ?? "");

  const draft = await until(async () => (await draftsBySubject(mail, subject))[0] ?? null);
  if (!draft?.ref) {
    check("the edited draft was found in Drafts", false, `no draft "${subject}"`);
    return;
  }
  const raw = String(
    (await mail.call("apple_mail_get_message_source", { ref: draft.ref, maxBytes: 1_000_000 }))
      ?.source ?? "",
  );
  check(
    "the saved draft holds the edit and kept its file",
    /EDITED/.test(raw) && !/REVISED/.test(raw) && /verify-note\.txt/.test(raw),
    `EDITED: ${/EDITED/.test(raw)}, REVISED gone: ${!/REVISED/.test(raw)}, verify-note.txt: ${/verify-note\.txt/.test(raw)}`,
  );
}

/**
 * Case 2: two composers under one subject. Each has its own handle, the right
 * one is edited, and an edit naming no target refuses while several are open.
 */
async function handlesCheck(mail, address) {
  const subject = `Cupertino verify-mail-ax dup ${new Date().toISOString()}`;
  let owned = false;
  try {
    for (const word of ["VERIFYALPHA", "VERIFYBETA"]) {
      let made;
      try {
        made = await mail.call("apple_mail_send_message", {
          to: [address],
          subject,
          body: `${word} first line.\nA check made this, never sent.`,
          sendNow: false,
        });
      } catch (error) {
        check(`the ${word} composer was made under the shared subject`, false, error.message);
        return;
      }
      owned = true;
      check(
        `the ${word} composer was made under the shared subject`,
        made?.ok === true,
        made?.note ?? "",
      );
      if (made?.ok !== true) return;
    }

    const composers = (await openComposers(mail)) ?? [];
    const same = composers.filter((c) => c.subject === subject);
    const handles = new Set(same.map((c) => c.composer));
    check(
      "list_open_drafts gives each of the two windows its own handle",
      same.length === 2 && handles.size === 2,
      `${same.length} windows, handles: ${[...handles].join(", ")}` +
        (same.some((c) => c.tab != null)
          ? ` (tabs: ${same.map((c) => c.tab ?? "none").join(", ")})`
          : ""),
    );
    // Mail with "Prefer tabs: Always" opens both as tabs of one window, and the
    // one it is not showing cannot be read: checked differently, below.
    if (same.some((c) => c.tab != null)) {
      await tabbedHandlesCheck(mail, subject, same);
      return;
    }
    const beta = same.find((c) => /VERIFYBETA/.test(c.text ?? ""));
    const alpha = same.find((c) => /VERIFYALPHA/.test(c.text ?? ""));
    if (!beta || !alpha) {
      check("each window could be told apart by what it holds", false, "texts did not match");
      return;
    }

    // No target, several windows open: it must refuse and change nothing.
    let untargeted = null;
    try {
      untargeted = await mail.call("apple_mail_update_draft", {
        edits: [{ find: "VERIFYBETA", replace: "VERIFYWRONG" }],
        confirm: true,
      });
    } catch (error) {
      untargeted = { replaced: false, reason: error.message };
    }
    check(
      "an edit that names no draft refuses while several are open",
      untargeted?.replaced === false,
      untargeted?.replaced === false
        ? (untargeted.reason ?? "").slice(0, 120)
        : "IT EDITED SOMETHING",
    );

    let result;
    try {
      result = await mail.call("apple_mail_update_draft", {
        composer: beta.composer,
        edits: [{ find: "VERIFYBETA", replace: "VERIFYGAMMA" }],
        confirm: true,
      });
    } catch (error) {
      check("the edit by handle was accepted", false, error.message);
      return;
    }
    check(
      "the edit by handle went in",
      result?.method === "inPlace" && result?.replaced === true,
      result?.replaced === true ? "" : `${result?.method} — ${result?.reason ?? "no reason given"}`,
    );

    const after = ((await openComposers(mail)) ?? []).filter((c) => c.subject === subject);
    const edited = after.find((c) => c.composer === beta.composer);
    const other = after.find((c) => c.composer === alpha.composer);
    check(
      "the right window was edited and the other left alone",
      !!edited &&
        !!other &&
        /VERIFYGAMMA/.test(edited.text ?? "") &&
        !/VERIFYBETA/.test(edited.text ?? "") &&
        /VERIFYALPHA/.test(other.text ?? "") &&
        !/VERIFYGAMMA/.test(other.text ?? ""),
      `edited: ${JSON.stringify(edited?.text)}, other: ${JSON.stringify(other?.text)}`,
    );
  } finally {
    if (owned) {
      // Windows first: deleting the saved copy under an open composer can leave it asking to save.
      const closed = await waitForClose(mail, subject);
      if (!closed)
        console.log(`  note a window titled "${subject}" is still open; close it by hand`);
      await deleteDrafts(mail, subject);
    }
  }
}

/**
 * Case 2 when the two composers are TABS of one window (LIVE RUN 3: Mail with
 * "Prefer tabs: Always"). The tab shown reads as a window does; the other is
 * listed with its subject and no text. By handle, the shown one is edited as
 * before, and the background one, whose title the other shares, is refused
 * with no tab switched. By ref, the background one IS edited: its saved text
 * is known, so the app selects its tab, checks that text against what the
 * window then shows, edits, saves, and selects the shown tab again.
 */
async function tabbedHandlesCheck(mail, subject, same) {
  const shown = same.find((c) => c.tab === "selected");
  const hidden = same.find((c) => c.tab === "background");
  const word = (c) => /VERIFY(ALPHA|BETA)/.exec(c?.text ?? "")?.[0] ?? null;
  const shownWord = word(shown);
  check(
    "the tab shown reads its text, the other is listed by subject with no text",
    !!shown && !!hidden && shownWord !== null && hidden.text === null && hidden.quote === null,
    `shown: ${shown?.composer} ${JSON.stringify(shown?.text)}, ` +
      `background: ${hidden?.composer} ${JSON.stringify(hidden?.text)}`,
  );
  if (!shown || !hidden || shownWord === null) return;
  const hiddenWord = shownWord === "VERIFYALPHA" ? "VERIFYBETA" : "VERIFYALPHA";
  const tabsNow = async () =>
    ((await openComposers(mail)) ?? []).filter((c) => c.subject === subject);
  const stillShown = async () =>
    (await tabsNow()).find((c) => c.composer === shown.composer)?.tab === "selected";

  // No target, several open: refused, nothing changed.
  let untargeted = null;
  try {
    untargeted = await mail.call("apple_mail_update_draft", {
      edits: [{ find: shownWord, replace: "VERIFYWRONG" }],
      confirm: true,
    });
  } catch (error) {
    untargeted = { replaced: false, reason: error.message };
  }
  check(
    "an edit that names no draft refuses while several are open",
    untargeted?.replaced === false,
    untargeted?.replaced === false
      ? (untargeted.reason ?? "").slice(0, 120)
      : "IT EDITED SOMETHING",
  );

  // The background tab by handle: its title is shared, nothing could prove it.
  let byHandle = null;
  try {
    byHandle = await mail.call("apple_mail_update_draft", {
      composer: hidden.composer,
      edits: [{ find: hiddenWord, replace: "VERIFYWRONG" }],
      confirm: true,
    });
  } catch (error) {
    byHandle = { replaced: false, reason: error.message };
  }
  check(
    "a background tab sharing its title, by handle, refuses as identity and switches nothing",
    byHandle?.replaced === false && byHandle?.capability === "identity" && (await stillShown()),
    byHandle?.replaced === false
      ? `${byHandle.capability}: ${(byHandle.reason ?? "").slice(0, 120)}`
      : "IT EDITED SOMETHING",
  );

  // The shown tab by handle, as an untabbed window is.
  let result = null;
  try {
    result = await mail.call("apple_mail_update_draft", {
      composer: shown.composer,
      edits: [{ find: shownWord, replace: "VERIFYGAMMA" }],
      confirm: true,
    });
  } catch (error) {
    result = { replaced: false, reason: error.message };
  }
  check(
    "the shown tab, by handle, is edited in place",
    result?.method === "inPlace" && result?.replaced === true && result?.saved === true,
    result?.replaced === true ? "" : `${result?.method} — ${result?.reason ?? "no reason given"}`,
  );

  // The background tab by ref: selected, checked against its saved text, edited, handed back.
  const sources = async () => {
    const out = [];
    for (const draft of await draftsBySubject(mail, subject)) {
      try {
        const raw = (
          await mail.call("apple_mail_get_message_source", { ref: draft.ref, maxBytes: 1_000_000 })
        )?.source;
        out.push({ ref: draft.ref, raw: String(raw ?? "") });
      } catch {
        // Renumbered under us: the next poll finds it again.
      }
    }
    return out;
  };
  const saved = await until(async () => (await sources()).find((d) => d.raw.includes(hiddenWord)));
  if (!saved) {
    check("the background tab's saved draft was found", false, `no draft holding ${hiddenWord}`);
    return;
  }
  let byRef = null;
  try {
    byRef = await mail.call("apple_mail_update_draft", {
      ref: saved.ref,
      edits: [{ find: hiddenWord, replace: "VERIFYDELTA" }],
      confirm: true,
    });
  } catch (error) {
    byRef = { replaced: false, reason: error.message };
  }
  check(
    "a background tab, by ref, is selected, checked, edited and saved in place",
    byRef?.method === "inPlace" && byRef?.replaced === true && byRef?.saved === true,
    byRef?.replaced === true
      ? `quoteKept: ${byRef.quoteKept}`
      : `${byRef?.method} — ${byRef?.capability}: ${byRef?.reason ?? "no reason given"}`,
  );
  const after = await tabsNow();
  check(
    "and the tab that was shown before is shown again",
    after.find((c) => c.composer === shown.composer)?.tab === "selected" &&
      after.find((c) => c.composer === hidden.composer)?.tab === "background",
    after.map((c) => `${c.composer}: ${c.tab}`).join(", "),
  );
  const settled = await until(async () => {
    const all = await sources();
    const ok =
      all.some((d) => d.raw.includes("VERIFYDELTA")) &&
      all.some((d) => d.raw.includes("VERIFYGAMMA")) &&
      !all.some((d) => /VERIFY(ALPHA|BETA|WRONG)/.test(d.raw));
    return ok ? all : null;
  });
  check(
    "each saved draft holds its own edit, and nothing else changed",
    settled !== null,
    settled === null ? "the saved sources did not settle to DELTA and GAMMA within 10s" : "",
  );
}

/**
 * Case 3, route B: close the forward, reply-draft a message the user sent
 * themselves, close that window, and rebuild the draft by ref. The saved source
 * must keep `In-Reply-To`, and exactly one draft may remain under the subject.
 */
async function rebuildCheck(mail, address, forwardSubject) {
  // The forward's window is closed first: the rebuild is for a window that is gone.
  if (!(await waitForClose(mail, forwardSubject))) {
    check("the forward's window was closed", false, "still open after two minutes");
    return;
  }

  // A message the user sent to themselves alone, so the reply is addressed to them alone.
  const self = address.toLowerCase();
  const found = await mail.call("apple_mail_search_messages", { sender: address, limit: 20 });
  let target = null;
  for (const candidate of found?.messages ?? []) {
    if (!candidate.ref || /\/Drafts#/.test(candidate.ref)) continue;
    let message;
    try {
      message = await mail.call("apple_mail_get_message", { ref: candidate.ref });
    } catch {
      continue;
    }
    const to = addressesIn(message?.headers?.to);
    const cc = addressesIn(message?.headers?.cc);
    if (
      to.length > 0 &&
      cc.length === 0 &&
      [...to, ...addressesIn(message?.sender)].every((a) => a === self)
    ) {
      target = { ...candidate, subject: message.subject ?? candidate.subject };
      break;
    }
  }
  if (!target) {
    console.log(
      `  skip the rebuild case: no message from ${address} to ${address} alone was found.\n` +
        "       Send yourself one (any subject) and run again.",
    );
    return;
  }

  // Nothing of the user's may share the reply's subject: the cleanup deletes by it.
  const predicted = /^re:/i.test(target.subject) ? target.subject : `Re: ${target.subject}`;
  const preexisting = (await draftsBySubject(mail, predicted)).length;
  const windows = ((await openComposers(mail)) ?? []).filter((c) => c.subject === predicted).length;
  if (preexisting > 0 || windows > 0) {
    console.log(
      `  skip the rebuild case: a draft or window titled "${predicted}" already exists, and the\n` +
        "       cleanup deletes by subject. Pick another self-sent message, or remove that draft.",
    );
    return;
  }

  console.log(`\n  reply-drafting "${target.subject}" (a message to yourself), nothing sent\n`);
  let subject = predicted;
  let owned = false;
  try {
    let replied;
    try {
      replied = await mail.call("apple_mail_reply_to_message", {
        ref: target.ref,
        body: "VERIFYBASE the reply a check wrote. It was never sent.",
        sendNow: false,
      });
    } catch (error) {
      check("the reply draft was composed", false, error.message);
      return;
    }
    subject = replied?.subject ?? predicted;
    owned = true;
    check("the reply draft was composed", replied?.ok === true, replied?.note ?? "");
    if (replied?.ok !== true) return;

    const saved = await until(async () => {
      const drafts = await draftsBySubject(mail, subject);
      return drafts.length === 1 ? drafts : null;
    });
    if (!saved) {
      owned = false;
      check(
        "exactly one saved reply draft exists",
        false,
        `not one draft titled "${subject}" after 10s; nothing deleted`,
      );
      return;
    }
    const recipients = addressesIn(
      (await mail.call("apple_mail_get_message", { ref: saved[0].ref }))?.headers?.to,
    );
    check(
      "the reply is addressed to the user's own account alone",
      recipients.length > 0 && recipients.every((a) => a === self),
      recipients.join(", "),
    );

    if (!(await waitForClose(mail, subject))) {
      check("the reply's window was closed", false, "still open after two minutes");
      return;
    }

    // Re-found by subject: Mail renumbers a saved draft within seconds.
    const draft = (await draftsBySubject(mail, subject))[0];
    if (!draft?.ref) {
      check("the closed draft was found in Drafts", false, `no draft "${subject}"`);
      return;
    }
    let result;
    try {
      result = await mail.call("apple_mail_update_draft", {
        ref: draft.ref,
        edits: [{ find: "VERIFYBASE", replace: "VERIFYREBUILT" }],
        confirm: true,
      });
    } catch (error) {
      check("the rebuild was accepted", false, error.message);
      return;
    }
    check(
      "a closed draft was REBUILT as a reply, threading kept",
      result?.method === "rebuild" && result?.replaced === true && result?.threadingKept === true,
      result?.replaced === true
        ? `inReplyTo: ${result.inReplyTo}, filesAdded: ${JSON.stringify(result.filesAdded)}`
        : `method: ${result?.method} — ${result?.reason ?? "no reason given"}`,
    );
    if (result?.replaced !== true) return;

    const rebuilt = await until(async () => {
      const drafts = await draftsBySubject(mail, subject);
      return drafts.length === 1 ? drafts[0] : null;
    });
    check(
      "exactly one draft remains under the subject (the original was deleted)",
      !!rebuilt,
      `${(await draftsBySubject(mail, subject)).length} draft(s)`,
    );
    if (!rebuilt) return;
    const raw = String(
      (await mail.call("apple_mail_get_message_source", { ref: rebuilt.ref, maxBytes: 1_000_000 }))
        ?.source ?? "",
    );
    const header = /^In-Reply-To:\s*(<[^>\r\n]+>)/im.exec(raw)?.[1] ?? null;
    check(
      "the saved source keeps In-Reply-To",
      header !== null &&
        (result.inReplyTo ? String(result.inReplyTo).includes(header.slice(1, -1)) : true),
      `In-Reply-To: ${header}`,
    );
    check(
      "the saved source holds the edit and not the old text",
      /VERIFYREBUILT/.test(raw) && !/VERIFYBASE/.test(raw),
      `VERIFYREBUILT: ${/VERIFYREBUILT/.test(raw)}, VERIFYBASE gone: ${!/VERIFYBASE/.test(raw)}`,
    );
  } finally {
    if (owned) {
      // The rebuild leaves its new window open, saved. Close it, then delete.
      const closed = await waitForClose(mail, subject);
      if (!closed)
        console.log(`  note a window titled "${subject}" is still open; close it by hand`);
      await deleteDrafts(mail, subject);
    }
  }
}

console.log(`${passed}/${passed + failed} automated checks passed\n`);
process.exit(failed > 0 ? 1 : 0);
