/**
 * Repair for Notes' lossy `body` round trip.
 *
 * `UPDATE_NOTE`'s append mode reads `note.body()` and assigns the result back,
 * so whatever the getter mangles is written back mangled — onto content the
 * caller never touched. Two independent losses, both reproduced against Notes
 * on macOS 15:
 *
 * 1. **Entities come back unterminated.** The text `ps."projectId";` serialises
 *    to `ps.&quotprojectId&quot;` — `&quot` with no semicolon. Fed back to the
 *    setter, the trailing `&quot` fuses with the literal `;` that followed it
 *    into a single `"`, and the semicolon is gone. The getter never terminates
 *    an entity, so a `&quot;` in its output is always entity-plus-literal-`;`,
 *    never a well-formed `&quot;`. That is what makes the repair unconditional
 *    rather than a `(?!;)` lookahead — a lookahead would skip exactly the case
 *    that loses a character.
 * 2. **Space runs come back literal**, and HTML collapses them on re-parse, so
 *    every indented line loses its indentation and every aligned block loses
 *    its alignment.
 *
 * Order matters: entities first, then spaces. The space pass emits `&nbsp;`
 * with a terminating semicolon, and running the entity pass afterwards would
 * rewrite those into `&nbsp;;`.
 *
 * Exported as source rather than a function because it runs inside the JXA
 * script, in osascript's JavaScriptCore. `test/repair.test.ts` evaluates this
 * same string, so the tested code is the shipped code.
 */
export const REPAIR_BODY_SRC = `
var repairBody = function (html) {
  var entities = html
    .replace(/&(amp|quot|apos|lt|gt|nbsp)/g, "&$1;")
    .replace(/&#(x?[0-9a-fA-F]+)/g, "&#$1;");
  return entities.replace(/>([^<]*)</g, function (_m, text) {
    return ">" + text
      .replace(/ {2,}/g, function (run) { return new Array(run.length + 1).join("&nbsp;"); })
      .replace(/^ /, "&nbsp;") + "<";
  });
};
`;
