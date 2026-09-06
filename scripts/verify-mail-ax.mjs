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

import { connect } from "node:net";
import { homedir } from "node:os";
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

    // What is actually on screen differs by outcome, and saying "a draft" after
    // a failure would send someone looking for one that was never saved: the
    // compose path returns BEFORE the save when the body cannot be verified.
    console.log(
      result?.ok === true
        ? `\n  Left in Mail, on purpose, as the evidence:\n` +
            `    a saved draft "${result.subject}" addressed to ${address},\n` +
            `    and its composer window.\n` +
            `  Open it, read it, then delete both. Nothing here will.\n`
        : `\n  Left in Mail: an EMPTY composer window "${result?.subject ?? "Fwd: …"}".\n` +
            `  No draft was saved — the compose path stops before the save when it\n` +
            `  cannot verify the body, and it does not close the window either,\n` +
            `  because closing an unsaved composer raises a sheet whose buttons are\n` +
            `  localised. Close it in Mail by hand.\n`,
    );
  } finally {
    mail.close();
  }
}

console.log(`${passed}/${passed + failed} automated checks passed\n`);
process.exit(failed > 0 ? 1 : 0);
