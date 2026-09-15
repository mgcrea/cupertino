// Tests for the guard rails on `push-worker-secrets.mjs`.
//
// The script's last act is `pnpm exec wrangler secret bulk`, which writes to the
// Worker taking real money. So every run here gets a PATH holding ONLY a fake
// `pnpm` that records its arguments and exits: the real one cannot be found,
// and no case can push anything anywhere, whichever way the script decides.
//
// The case that matters most is the unmarked one. A test-mode webhook signing
// secret is `whsec_` followed by random characters, exactly like a live one, so
// the old test-marker heuristic called such a set "live", never refused, and
// pushed it to the default environment. Only the file name and `--env` can say
// where a set belongs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "push-worker-secrets.mjs");
const work = mkdtempSync(join(tmpdir(), "cupertino-secrets-"));
after(() => rmSync(work, { recursive: true, force: true }));

const bin = join(work, "bin");
const pushed = join(work, "pushed.txt");
mkdirSync(bin);
writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$@" > "${pushed}"\n`);
chmodSync(join(bin, "pnpm"), 0o755);

/** Shaped like the real thing and random every run: `whsec_` plus 32 characters, no mode marker. */
const unmarkedWebhookSecret = () => `whsec_${randomBytes(24).toString("base64url").slice(0, 32)}`;
const signingKey = () => randomBytes(48).toString("base64");

/** Run the script against `contents` saved as `name`, with the fake pnpm as the only one. */
const run = (contents, { name = ".test.vars", args = [] } = {}) => {
  const dir = mkdtempSync(join(work, "case-"));
  const file = join(dir, name);
  writeFileSync(file, contents);
  rmSync(pushed, { force: true });
  const env = { PATH: bin, HOME: work };
  let code = 0;
  let output = "";
  try {
    execFileSync(process.execPath, [SCRIPT, file, ...args], {
      encoding: "utf8",
      env,
      stdio: "pipe",
    });
  } catch (error) {
    code = error.status;
    output = String(error.stderr ?? "");
  }
  const push = existsSync(pushed) ? readFileSync(pushed, "utf8").trim() : null;
  return { code, output, push };
};

const UNMARKED = () =>
  `LICENSE_SIGNING_KEY=${signingKey()}\nSTRIPE_WEBHOOK_SECRET=${unmarkedWebhookSecret()}\n`;

describe("push-worker-secrets", () => {
  it("refuses an unmarked test-mode set that is not .prod.vars when no --env is named", () => {
    const { code, output, push } = run(UNMARKED(), { name: ".test.vars" });
    assert.equal(code, 2);
    assert.match(output, /is not \.prod\.vars, and no --env names where it should go/);
    // The message has to name the fix, not just the problem.
    assert.match(output, /--env <name>/);
    assert.equal(push, null);
  });

  it("still warns about mixed markers, and still refuses the unnamed target", () => {
    const mixed = `${UNMARKED()}STRIPE_SECRET_KEY=rk_test_${randomBytes(12).toString("hex")}\n`;
    const { code, output, push } = run(mixed, { name: ".dev.vars" });
    assert.match(output, /WARNING: .* mixes test and live Stripe credentials/);
    assert.equal(code, 2);
    assert.equal(push, null);
  });

  it("forwards --env to wrangler when one is named", () => {
    const { code, push } = run(UNMARKED(), { name: ".test.vars", args: ["--env", "test"] });
    assert.equal(code, 0);
    assert.match(push ?? "", /secret bulk .*\.test\.vars --env test$/);
  });

  it("pushes .prod.vars to the top-level Worker without --env", () => {
    const { code, push } = run(UNMARKED(), { name: ".prod.vars" });
    assert.equal(code, 0);
    assert.match(push ?? "", /secret bulk .*\.prod\.vars$/);
  });

  it("refuses --env with no name after it", () => {
    const { code, output, push } = run(UNMARKED(), { args: ["--env"] });
    assert.equal(code, 2);
    assert.match(output, /--env needs a name/);
    assert.equal(push, null);
  });

  it("refuses a set with an empty value", () => {
    const { code, output } = run(
      `LICENSE_SIGNING_KEY=\nSTRIPE_WEBHOOK_SECRET=${unmarkedWebhookSecret()}\n`,
      {
        name: ".prod.vars",
      },
    );
    assert.equal(code, 2);
    assert.match(output, /LICENSE_SIGNING_KEY is empty/);
  });

  it("refuses a file that defines nothing", () => {
    const { code, output } = run("# just a comment\n", { name: ".prod.vars" });
    assert.equal(code, 2);
    assert.match(output, /defines no KEY=VALUE pairs/);
  });

  it("refuses a file that is not there", () => {
    let code = 0;
    let output = "";
    try {
      execFileSync(process.execPath, [SCRIPT, join(work, "absent.vars")], {
        encoding: "utf8",
        env: { PATH: bin, HOME: work },
        stdio: "pipe",
      });
    } catch (error) {
      code = error.status;
      output = String(error.stderr ?? "");
    }
    assert.equal(code, 2);
    assert.match(output, /cannot read/);
  });
});
