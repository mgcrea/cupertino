import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * `apple_safari_cookies`, through the MCP client, against a FAKE EXTENSION.
 *
 * The background worker's half — `browser.cookies.getAll` and which values it
 * lets out — is pinned in `extension-background.test.ts`. What this file pins
 * is the server: the two gates (the flag registers the tool, the host list
 * decides which pages it may read), that no value ever comes back inline, and
 * the `saveAs` file a local tool reads as is.
 *
 * Every value is an obvious fake, and every assertion that a value is absent
 * searches the WHOLE result text, so a field added later that carries one
 * fails here rather than in somebody's conversation.
 */

const PAGE_URL = "https://finance.example.test/quote";
const HOSTS = "example.test";

const FAKE = {
  A3: "fake-a3-value-0000",
  T: "fake-t-value-1111",
  Y: "fake-y-value-2222",
  B: "fake-b-value-3333",
};

/** The extension's answer for `getAll({url})`: three HttpOnly logins and one plain cookie. */
const COOKIES = [
  {
    name: "A3",
    value: FAKE.A3,
    domain: ".example.test",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction",
    hostOnly: false,
    session: false,
    expirationDate: 1_798_761_600,
  },
  {
    name: "T",
    value: FAKE.T,
    domain: ".example.test",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    hostOnly: false,
    session: true,
  },
  {
    name: "Y",
    value: FAKE.Y,
    domain: ".example.test",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction",
    hostOnly: false,
    session: false,
    expirationDate: 1_798_761_600.5,
  },
  {
    name: "B",
    value: FAKE.B,
    domain: "finance.example.test",
    path: "/quote",
    secure: false,
    httpOnly: false,
    sameSite: "unspecified",
    hostOnly: true,
    session: true,
  },
];

let root: string;
let timers: (() => void)[] = [];

afterEach(() => {
  for (const stop of timers) stop();
  timers = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

const fakeOsascript: OsascriptRunner = {
  run: async <T>(): Promise<T> => ({ entries: [], folders: 0, depthTruncated: false }) as T,
};

const connect = async (env: NodeJS.ProcessEnv = {}) => {
  root = mkdtempSync(join(tmpdir(), "safari-cookies-"));
  const pages = join(root, "pages");
  const downloads = join(root, "downloads");
  mkdirSync(pages, { recursive: true });
  const config = loadConfig({
    APPLE_SAFARI_INDEX_MODE: "off",
    APPLE_SAFARI_PAGES: pages,
    APPLE_SAFARI_DOWNLOAD_DIR: downloads,
    APPLE_SAFARI_ACTION_TIMEOUT_MS: "800",
    ...env,
  });
  const { server } = createServer({ config, home: "/nonexistent-home", osascript: fakeOsascript });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, downloads, commands: join(root, "commands"), results: join(root, "results") };
};

/** The tool on, with the test host allowed, which is what most cases need. */
const connectOn = (env: NodeJS.ProcessEnv = {}) =>
  connect({ APPLE_SAFARI_ALLOW_COOKIES: "1", APPLE_SAFARI_COOKIE_HOSTS: HOSTS, ...env });

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = res.content.map((c) => c.text).join("");
  return { isError: Boolean(res.isError), text, json: () => JSON.parse(text) as never };
};

const cookies = (client: Client, args: Record<string, unknown> = {}) =>
  call(client, "apple_safari_cookies", { url: PAGE_URL, ...args });

/**
 * Answer commands the way the background worker does: claim by deletion,
 * reply by writing `results/<id>.json`. By default it answers as the real one
 * does — values only for the names in `valuesFor` — and `reply` overrides it.
 */
const fakeExtension = (
  dirs: { commands: string; results: string },
  reply?: (command: Record<string, unknown>) => { ok: boolean; data?: unknown; error?: string },
) => {
  const seen: Record<string, unknown>[] = [];
  const timer = setInterval(() => {
    let files: string[] = [];
    try {
      files = readdirSync(dirs.commands).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of files) {
      const file = join(dirs.commands, name);
      const command = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      seen.push(command);
      rmSync(file, { force: true });
      const answer = reply?.(command) ?? {
        ok: true,
        data: {
          cookies: COOKIES.map(({ value, ...rest }) =>
            (command.valuesFor as string[] | undefined)?.includes(rest.name)
              ? { ...rest, value }
              : rest,
          ),
        },
      };
      mkdirSync(dirs.results, { recursive: true });
      writeFileSync(
        join(dirs.results, `${String(command.id)}.json`),
        JSON.stringify({ id: command.id, completedAt: new Date().toISOString(), ...answer }),
      );
    }
  }, 10);
  timers.push(() => clearInterval(timer));
  return { seen };
};

const expectNoValue = (text: string) => {
  for (const value of Object.values(FAKE)) expect(text).not.toContain(value);
};

const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).toSorted();

describe("cookies registration", () => {
  it("is not registered by default", async () => {
    const { client } = await connect();
    expect(await toolNames(client)).not.toContain("apple_safari_cookies");
  });

  it("is not reached through allowWrites, allowCodes or allowNetwork", async () => {
    const { client } = await connect({
      APPLE_SAFARI_ALLOW_WRITES: "1",
      APPLE_SAFARI_ALLOW_CODES: "1",
      APPLE_SAFARI_ALLOW_NETWORK: "1",
      APPLE_SAFARI_COOKIE_HOSTS: HOSTS,
    });
    expect(await toolNames(client)).not.toContain("apple_safari_cookies");
  });

  it("adds only apple_safari_cookies when APPLE_SAFARI_ALLOW_COOKIES is set", async () => {
    const off = await toolNames((await connect()).client);
    const on = await toolNames((await connect({ APPLE_SAFARI_ALLOW_COOKIES: "1" })).client);
    expect(on.filter((n) => !off.includes(n))).toEqual(["apple_safari_cookies"]);
    expect(off.filter((n) => !on.includes(n))).toEqual([]);
  });

  it("is registered even with an empty host list, so the refusal can say why", async () => {
    const { client } = await connect({ APPLE_SAFARI_ALLOW_COOKIES: "1" });
    expect(await toolNames(client)).toContain("apple_safari_cookies");
  });

  it("is annotated as a non-destructive tool that may write a file", async () => {
    const { client } = await connectOn();
    const tool = (await client.listTools()).tools.find((t) => t.name === "apple_safari_cookies");
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.description).toMatch(/never.*value/i);
    expect(tool?.description).toContain("APPLE_SAFARI_COOKIE_HOSTS");
  });
});

describe("cookies host allowlist", () => {
  it("refuses every host when the list is empty, naming the setting, and sends nothing", async () => {
    const dirs = await connect({ APPLE_SAFARI_ALLOW_COOKIES: "1" });
    const ext = fakeExtension(dirs);
    const r = await cookies(dirs.client);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("APPLE_SAFARI_COOKIE_HOSTS");
    expect(r.text).toContain("finance.example.test");
    expect(ext.seen).toEqual([]);
  });

  it("refuses a host outside the list, naming the setting, and sends nothing", async () => {
    const dirs = await connect({
      APPLE_SAFARI_ALLOW_COOKIES: "1",
      APPLE_SAFARI_COOKIE_HOSTS: "other.test, third.test",
    });
    const ext = fakeExtension(dirs);
    const r = await cookies(dirs.client);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("APPLE_SAFARI_COOKIE_HOSTS");
    expect(ext.seen).toEqual([]);
  });

  it("matches a suffix only on a label boundary", async () => {
    const dirs = await connectOn();
    const ext = fakeExtension(dirs);
    const r = await cookies(dirs.client, { url: "https://notexample.test/" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("APPLE_SAFARI_COOKIE_HOSTS");
    expect(ext.seen).toEqual([]);
  });

  it("allows the registrable domain itself and any subdomain of it", async () => {
    const dirs = await connectOn();
    fakeExtension(dirs);
    expect((await cookies(dirs.client, { url: "https://example.test/" })).isError).toBe(false);
    expect((await cookies(dirs.client, { url: "https://a.b.example.test/x" })).isError).toBe(false);
  });

  it("normalises the list: case, spaces and a leading dot do not matter", async () => {
    const dirs = await connect({
      APPLE_SAFARI_ALLOW_COOKIES: "1",
      APPLE_SAFARI_COOKIE_HOSTS: " other.test ,, .EXAMPLE.test ",
    });
    fakeExtension(dirs);
    expect((await cookies(dirs.client)).isError).toBe(false);
  });

  it("ignores an entry with no dot, so 'test' cannot open a whole top-level domain", async () => {
    const dirs = await connect({
      APPLE_SAFARI_ALLOW_COOKIES: "1",
      APPLE_SAFARI_COOKIE_HOSTS: "test",
    });
    const ext = fakeExtension(dirs);
    const r = await cookies(dirs.client);
    expect(r.isError).toBe(true);
    expect(ext.seen).toEqual([]);
  });

  it("refuses a page that is not http or https", async () => {
    const dirs = await connectOn();
    const ext = fakeExtension(dirs);
    const r = await cookies(dirs.client, { url: "file:///etc/example.test" });
    expect(r.isError).toBe(true);
    expect(ext.seen).toEqual([]);
  });
});

describe("cookies inline", () => {
  it("lists every cookie's metadata and no value", async () => {
    const dirs = await connectOn();
    const ext = fakeExtension(dirs);
    const r = await cookies(dirs.client);
    expect(r.isError).toBe(false);
    expectNoValue(r.text);
    const json = r.json() as { url: string; count: number; cookies: Record<string, unknown>[] };
    expect(json.url).toBe(PAGE_URL);
    expect(json.count).toBe(4);
    expect(json.cookies[0]).toEqual({
      name: "A3",
      domain: ".example.test",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
      expires: "2027-01-01T00:00:00.000Z",
    });
    // A session cookie has no expiry, and says so rather than leaving it out.
    expect(json.cookies[1]).toMatchObject({ name: "T", expires: null });
    for (const cookie of json.cookies) expect(cookie).not.toHaveProperty("value");
    // A listing asks for no value at all, so none crosses the channel.
    expect(ext.seen).toHaveLength(1);
    expect(ext.seen[0]).toMatchObject({ action: "cookies", url: PAGE_URL });
    expect(ext.seen[0]).not.toHaveProperty("valuesFor");
  });

  it("drops a value the extension sent anyway", async () => {
    const dirs = await connectOn();
    fakeExtension(dirs, () => ({ ok: true, data: { cookies: COOKIES } }));
    const r = await cookies(dirs.client);
    expect(r.isError).toBe(false);
    expectNoValue(r.text);
  });

  it("narrows the listing to `names`", async () => {
    const dirs = await connectOn();
    fakeExtension(dirs);
    const r = await cookies(dirs.client, { names: ["T", "Y"] });
    const json = r.json() as { cookies: { name: string }[] };
    expect(json.cookies.map((c) => c.name)).toEqual(["T", "Y"]);
    expectNoValue(r.text);
  });

  it("passes the page's refusal through without a value in it", async () => {
    const dirs = await connectOn();
    fakeExtension(dirs, () => ({
      ok: false,
      error: "browser.cookies is not available to the extension.",
    }));
    const r = await cookies(dirs.client);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("browser.cookies");
  });

  it("says an extension that does not know the command is older than this server", async () => {
    const dirs = await connectOn();
    fakeExtension(dirs, () => ({ ok: false, error: 'Unknown action "cookies".' }));
    const r = await cookies(dirs.client);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/older|update/i);
  });
});

describe("cookies saveAs", () => {
  const save = (client: Client, args: Record<string, unknown> = {}) =>
    cookies(client, { names: ["A3", "T", "Y"], saveAs: "yahoo.cookie", ...args });

  it("refuses without writes, naming APPLE_SAFARI_ALLOW_WRITES, and sends nothing", async () => {
    const dirs = await connectOn();
    const ext = fakeExtension(dirs);
    const r = await save(dirs.client);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("APPLE_SAFARI_ALLOW_WRITES");
    expect(ext.seen).toEqual([]);
    expect(existsSync(join(dirs.downloads, "yahoo.cookie"))).toBe(false);
  });

  it("refuses saveAs without names, so a file never holds more than was asked for", async () => {
    const dirs = await connectOn({ APPLE_SAFARI_ALLOW_WRITES: "1" });
    const ext = fakeExtension(dirs);
    const r = await cookies(dirs.client, { saveAs: "yahoo.cookie" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("names");
    expect(ext.seen).toEqual([]);
  });

  it("writes one Cookie header value, mode 0600, and returns only the path, names and bytes", async () => {
    const dirs = await connectOn({ APPLE_SAFARI_ALLOW_WRITES: "1" });
    const ext = fakeExtension(dirs);
    const r = await save(dirs.client);
    expect(r.isError).toBe(false);
    expectNoValue(r.text);

    const file = join(dirs.downloads, "yahoo.cookie");
    const line = `A3=${FAKE.A3}; T=${FAKE.T}; Y=${FAKE.Y}`;
    // Exactly the header's value: no "Cookie:" prefix and no newline, so a
    // tool that splits it on "; " gets three clean pairs.
    expect(readFileSync(file, "utf8")).toBe(line);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const json = r.json() as { saved: { path: string; bytes: number; names: string[] } };
    expect(json.saved).toEqual({
      path: realpathSync(file),
      bytes: line.length,
      names: ["A3", "T", "Y"],
    });
    // Values are asked for by name, and only those names.
    expect(ext.seen[0]).toMatchObject({ action: "cookies", valuesFor: ["A3", "T", "Y"] });
  });

  it("refuses a name the page does not have, naming it, and writes nothing", async () => {
    const dirs = await connectOn({ APPLE_SAFARI_ALLOW_WRITES: "1" });
    fakeExtension(dirs);
    const r = await save(dirs.client, { names: ["A3", "GUC"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("GUC");
    expectNoValue(r.text);
    expect(existsSync(join(dirs.downloads, "yahoo.cookie"))).toBe(false);
  });

  it("refuses a value that would break the header line, naming the cookie only", async () => {
    const dirs = await connectOn({ APPLE_SAFARI_ALLOW_WRITES: "1" });
    fakeExtension(dirs, () => ({
      ok: true,
      data: { cookies: [{ ...COOKIES[0], value: "fake;broken\nvalue" }] },
    }));
    const r = await save(dirs.client, { names: ["A3"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("A3");
    expect(r.text).not.toContain("fake;broken");
    expect(existsSync(join(dirs.downloads, "yahoo.cookie"))).toBe(false);
  });

  it("refuses to overwrite an existing file unless asked", async () => {
    const dirs = await connectOn({ APPLE_SAFARI_ALLOW_WRITES: "1" });
    fakeExtension(dirs);
    mkdirSync(dirs.downloads, { recursive: true });
    const file = join(dirs.downloads, "yahoo.cookie");
    writeFileSync(file, "old");

    const refused = await save(dirs.client);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/already exists/);
    expectNoValue(refused.text);
    expect(readFileSync(file, "utf8")).toBe("old");

    const replaced = await save(dirs.client, { overwrite: true });
    expect(replaced.isError).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(`A3=${FAKE.A3}; T=${FAKE.T}; Y=${FAKE.Y}`);
  });

  it("keeps saveAs to a bare filename inside the download directory", async () => {
    const dirs = await connectOn({ APPLE_SAFARI_ALLOW_WRITES: "1" });
    fakeExtension(dirs);
    const r = await save(dirs.client, { saveAs: "../escape.cookie" });
    expect(r.isError).toBe(false);
    expect(existsSync(join(dirs.downloads, "escape.cookie"))).toBe(true);
    expect(existsSync(join(root, "escape.cookie"))).toBe(false);
  });
});

describe("cookies in diagnostics", () => {
  it("reports the flag and the host list, and no cookie at all", async () => {
    const dirs = await connect({
      APPLE_SAFARI_ALLOW_COOKIES: "1",
      APPLE_SAFARI_COOKIE_HOSTS: "Example.test, com",
    });
    const r = await call(dirs.client, "apple_safari_diagnostics");
    const json = r.json() as { lanes: { cookies: Record<string, unknown> } };
    expect(json.lanes.cookies).toMatchObject({
      enabled: true,
      hosts: ["example.test"],
      ignoredHosts: ["com"],
    });
    expectNoValue(r.text);
  });

  it("says it is off, and how to turn it on, by default", async () => {
    const dirs = await connect();
    const r = await call(dirs.client, "apple_safari_diagnostics");
    const json = r.json() as { lanes: { cookies: Record<string, unknown> } };
    expect(json.lanes.cookies).toMatchObject({ enabled: false, hosts: [] });
    expect(JSON.stringify(json.lanes.cookies)).toContain("APPLE_SAFARI_ALLOW_COOKIES");
  });
});
