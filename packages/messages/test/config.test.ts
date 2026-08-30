import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("resolves names through Contacts by default", () => {
    // Without it this server answers "+15551234567 said …", which is the whole
    // reason packages/contacts exists.
    expect(loadConfig({}).resolveContacts).toBe(true);
  });

  /**
   * Both gates default off and neither implies the other. `allowCodes` is a
   * read gate that exists because live authentication codes are a different
   * tier from conversation history — see `config.ts`.
   */
  it("keeps both gates off by default", () => {
    const c = loadConfig({});
    expect(c.allowWrites).toBe(false);
    expect(c.allowCodes).toBe(false);
  });

  it("does not let one gate open the other", () => {
    expect(loadConfig({ APPLE_MESSAGES_ALLOW_WRITES: "1" }).allowCodes).toBe(false);
    expect(loadConfig({ APPLE_MESSAGES_ALLOW_CODES: "1" }).allowWrites).toBe(false);
  });

  it("reads every APPLE_MESSAGES_ variable", () => {
    const c = loadConfig({
      APPLE_MESSAGES_INDEX_MODE: "immutable",
      APPLE_MESSAGES_RESOLVE_CONTACTS: "0",
      APPLE_MESSAGES_STORE: "/tmp/chat.db",
      APPLE_MESSAGES_DEFAULT_RANGE_DAYS: "7",
      APPLE_MESSAGES_MAX_RESULTS: "25",
      APPLE_MESSAGES_ALLOW_CODES: "1",
    });
    expect(c.indexMode).toBe("immutable");
    expect(c.resolveContacts).toBe(false);
    expect(c.storePath).toBe("/tmp/chat.db");
    expect(c.defaultRangeDays).toBe(7);
    expect(c.maxResults).toBe(25);
    expect(c.allowCodes).toBe(true);
  });
});
