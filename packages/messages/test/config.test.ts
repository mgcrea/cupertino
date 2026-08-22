import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("resolves names through Contacts by default", () => {
    // Without it this server answers "+15551234567 said …", which is the whole
    // reason packages/contacts exists.
    expect(loadConfig({}).resolveContacts).toBe(true);
  });

  it("reads every APPLE_MESSAGES_ variable", () => {
    const c = loadConfig({
      APPLE_MESSAGES_INDEX_MODE: "immutable",
      APPLE_MESSAGES_RESOLVE_CONTACTS: "0",
      APPLE_MESSAGES_STORE: "/tmp/chat.db",
      APPLE_MESSAGES_DEFAULT_RANGE_DAYS: "7",
      APPLE_MESSAGES_MAX_RESULTS: "25",
    });
    expect(c.indexMode).toBe("immutable");
    expect(c.resolveContacts).toBe(false);
    expect(c.storePath).toBe("/tmp/chat.db");
    expect(c.defaultRangeDays).toBe(7);
    expect(c.maxResults).toBe(25);
  });
});
