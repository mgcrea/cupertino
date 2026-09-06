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
const rpc = (identity) =>
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
          resolve({
            call: (tool, args = {}) =>
              new Promise((ok, no) => {
                const id = nextId++;
                waiting.set(id, { ok, no });
                socket.write(
                  `${JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    method: "tools/call",
                    params: { name: `apple_desktop_${tool}`, arguments: args },
                  })}\n`,
                );
              }),
            close: () => socket.destroy(),
          });
          continue;
        }
        const message = JSON.parse(line);
        const pending = waiting.get(message.id);
        if (!pending) continue;
        waiting.delete(message.id);
        if (message.error) pending.no(new Error(message.error.message));
        else pending.ok(JSON.parse(message.result.content[0].text));
      }
    });
    socket.write(`cupertino/1 desktop for=${identity}\n`);
  });

console.log(`\nmail accessibility lane (${BUNDLE})\n`);

// ─── the peer check, which is the security property ────────────────────────
let refusedFromTerminal = false;
let refusal = "";
try {
  const channel = await rpc("mail");
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
console.log(
  "\nThe checks below need the mail server the app hosts. Run them from a client\n" +
    "wired to Cupertino:\n\n" +
    "  apple_mail_diagnostics   -> permissions.composerLane should be 'accessibility'\n" +
    "                              and composerLaneNote should be present\n" +
    (COMPOSE
      ? "  apple_mail_reply_to_message with a short body and sendNow=false\n" +
        "                           -> a composer opens, the body is IN it, and the\n" +
        "                              tool reports bodyVerified true\n" +
        "  Then, with Automation to System Events REVOKED, do it again: it must\n" +
        "  still work. That is the whole point of the change and the only check\n" +
        "  that proves the second grant is really gone.\n"
      : "  re-run with --compose for the write-side checklist\n"),
);

console.log(`${passed}/${passed + failed} automated checks passed\n`);
process.exit(failed > 0 ? 1 : 0);
