import {
  SUBSCRIPTION_ID_META_KEY,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { ListenLedger, withListenLedger } from "../src/listens.js";

const URI = "cupertino://widget/watch/w_1";

/** The ack the SDK's router writes for an honoured listen. */
const ack = (id: string | number, notifications: Record<string, unknown>): JSONRPCMessage =>
  ({
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: { notifications, _meta: { [SUBSCRIPTION_ID_META_KEY]: id } },
  }) as JSONRPCMessage;

/** The result the router writes for each open listen when the connection ends. */
const complete = (id: string | number): JSONRPCMessage =>
  ({
    jsonrpc: "2.0",
    id,
    result: { resultType: "complete", _meta: { [SUBSCRIPTION_ID_META_KEY]: id } },
  }) as JSONRPCMessage;

const cancelled = (requestId: string | number): JSONRPCMessage =>
  ({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId },
  }) as JSONRPCMessage;

describe("ListenLedger", () => {
  it("covers a URI only once an ack names it in resourceSubscriptions", () => {
    const ledger = new ListenLedger();
    expect(ledger.covers(URI)).toBe(false);
    ledger.outbound(ack(1, { toolsListChanged: true, resourcesListChanged: true }));
    expect(ledger.size).toBe(1);
    expect(ledger.covers(URI)).toBe(false);
    ledger.outbound(ack(2, { resourceSubscriptions: [URI] }));
    expect(ledger.covers(URI)).toBe(true);
    expect(ledger.covers(`${URI}?after=5`)).toBe(false);
  });

  it("does not take the client's request for what the router honoured", () => {
    const ledger = new ListenLedger();
    ledger.inbound({
      jsonrpc: "2.0",
      id: 1,
      method: "subscriptions/listen",
      params: { notifications: { resourceSubscriptions: [URI] } },
    } as JSONRPCMessage);
    expect(ledger.covers(URI)).toBe(false);
  });

  it("forgets a listen when the client cancels it", () => {
    const ledger = new ListenLedger();
    ledger.outbound(ack(1, { resourceSubscriptions: [URI] }));
    ledger.inbound(cancelled(1));
    expect(ledger.covers(URI)).toBe(false);
    expect(ledger.size).toBe(0);
  });

  it("forgets a listen when the router ends it", () => {
    const ledger = new ListenLedger();
    ledger.outbound(ack("a", { resourceSubscriptions: [URI] }));
    ledger.outbound(complete("a"));
    expect(ledger.covers(URI)).toBe(false);
  });

  it('keeps 1 and "1" apart, as JSON-RPC does', () => {
    const ledger = new ListenLedger();
    ledger.outbound(ack(1, { resourceSubscriptions: [URI] }));
    ledger.inbound(cancelled("1"));
    expect(ledger.covers(URI)).toBe(true);
  });

  it("ignores an ack with no subscription id", () => {
    const ledger = new ListenLedger();
    ledger.outbound({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: { resourceSubscriptions: [URI] } },
    } as JSONRPCMessage);
    expect(ledger.size).toBe(0);
  });
});

/** A transport that keeps what it is sent and delivers nothing on its own. */
const bare = () => {
  const sent: JSONRPCMessage[] = [];
  const transport: Transport = {
    start: async () => {},
    send: async (message) => {
      sent.push(message);
    },
    close: async () => {},
  };
  return { sent, transport };
};

describe("withListenLedger", () => {
  it("sees what is sent, and still sends it", async () => {
    const { sent, transport } = bare();
    const ledger = new ListenLedger();
    withListenLedger(transport, ledger);
    await transport.send(ack(1, { resourceSubscriptions: [URI] }));
    expect(sent).toHaveLength(1);
    expect(ledger.covers(URI)).toBe(true);
  });

  it("sees what arrives through a handler assigned after wrapping, and still delivers it", () => {
    const { transport } = bare();
    const ledger = new ListenLedger();
    withListenLedger(transport, ledger);
    ledger.outbound(ack(1, { resourceSubscriptions: [URI] }));
    const delivered: JSONRPCMessage[] = [];
    // serveStdio assigns its handler after it is handed the transport.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK's message hook, not a DOM event.
    transport.onmessage = (message) => {
      delivered.push(message);
    };
    transport.onmessage?.(cancelled(1));
    expect(delivered).toHaveLength(1);
    expect(ledger.covers(URI)).toBe(false);
  });
});
