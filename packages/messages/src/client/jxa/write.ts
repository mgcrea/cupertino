import { PRELUDE } from "./core.js";

/**
 * One script, one verb.
 *
 * `send` is the only mutating command in the Messages dictionary that this
 * server exposes — see `core.ts` for the full list, for why `login`/`logout` are
 * left out, and for the two lanes the file form arrives in.
 *
 * ## One call site, two payloads
 *
 * The file form is `M.send(Path(...), …)` and the text form is `M.send(str, …)`,
 * which invites two branches around two `send` calls. It is written as one call
 * over a payload chosen beforehand instead, because `test/jxa.test.ts` proves
 * the target is resolved before anything is sent by comparing the position of
 * `resolveTarget(` against `M.send(` — with two call sites that check would pin
 * the first and quietly ignore the second.
 *
 * ## What this script deliberately does NOT do
 *
 * It does not report success from its own read-back, because there is nothing to
 * read back: `send` returns no value, and every read this app offers fails. A
 * script that answered `{ok: true}` and stopped would be claiming delivery on
 * the strength of a command that did not throw — the exact shape of "plausible,
 * wrong and silent" this repo keeps designing against.
 *
 * So the script's answer is deliberately narrow: **the send command was accepted
 * by Messages, and here is how the target was addressed.** Whether a row landed
 * is a question for the file lane, and `client/messages.ts` asks it immediately
 * afterwards by polling chat.db for the outgoing row. That split is the answer
 * to the open question `docs/messages.md` left — "whether a send should
 * re-resolve by scanning the store for a recent row on the target chat" — and it
 * is what makes a send reportable at all on a surface with no id bridge.
 */
export const SEND_MESSAGE = `${PRELUDE}
function run(argv) {
  var p = JSON.parse(argv[0]);
  var M = Application("Messages");

  var wasRunning = isMessagesRunning();
  if (!wasRunning && !p.allowLaunch) {
    return err("APP_NOT_RUNNING", "Messages is not running.");
  }

  // The dictionary's direct parameter is file OR text, so one send sends one
  // thing. The client enforces this too; it is repeated here because a
  // malformed param set must fail before a target is addressed, not after.
  var hasFile = typeof p.file === "string" && p.file.length > 0;
  var hasText = typeof p.text === "string" && p.text.length > 0;
  if (hasFile === hasText) {
    return err("SEND_PAYLOAD_INVALID", "Expected exactly one of text or file.");
  }
  // \`p.file\` is already resolved and already bounded by the client. This does
  // not build a path, join one, or read one — it forwards what it was handed.
  var payload = hasFile ? Path(p.file) : p.text;

  var tried = [];
  var resolved = resolveTarget(M, p, tried);
  if (!resolved) {
    return err(
      "SEND_TARGET_NOT_FOUND",
      "Messages would not resolve a chat or participant for that recipient.",
      tried
    );
  }

  try {
    M.send(payload, { to: resolved.target });
  } catch (e) {
    return err("SEND_FAILED", e.message || e, tried);
  }

  return ok({
    sent: hasFile ? "file" : "text",
    strategy: resolved.strategy,
    targetKind: resolved.kind,
    // Best effort, and allowed to be null: reading the id back is itself a read.
    targetId: prop(function () { return String(resolved.target.id()); }, null),
    launched: !wasRunning,
    attempts: tried
  });
}
`;
