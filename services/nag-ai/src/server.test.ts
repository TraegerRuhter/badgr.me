import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "./server";
import type { AnthropicMessages } from "./copyClient";

function fakeClient(text: string): AnthropicMessages {
  return {
    messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text }] }) },
  } as unknown as AnthropicMessages;
}

function failingClient(): AnthropicMessages {
  return {
    messages: { create: vi.fn().mockRejectedValue(new Error("anthropic is down")) },
  } as unknown as AnthropicMessages;
}

let server: Server;
let baseUrl: string;

function listen(s: Server): Promise<string> {
  return new Promise((resolve) => {
    s.listen(0, () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(() => {
  server?.close();
});

describe("createServer /v1/nag-copy", () => {
  it("returns the rewritten line on a valid, unauthenticated request when no secret is configured", async () => {
    server = createServer({ anthropicClient: fakeClient("Come on already.") });
    baseUrl = await listen(server);

    const res = await fetch(`${baseUrl}/v1/nag-copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Pay rent", level: 2 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "Pay rent", body: "Come on already." });
  });

  it("rejects requests missing the shared secret", async () => {
    server = createServer({
      anthropicClient: fakeClient("line"),
      sharedSecret: "topsecret",
    });
    baseUrl = await listen(server);

    const res = await fetch(`${baseUrl}/v1/nag-copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x", level: 0 }),
    });

    expect(res.status).toBe(401);
  });

  it("accepts requests with the correct shared secret", async () => {
    server = createServer({
      anthropicClient: fakeClient("line"),
      sharedSecret: "topsecret",
    });
    baseUrl = await listen(server);

    const res = await fetch(`${baseUrl}/v1/nag-copy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer topsecret",
      },
      body: JSON.stringify({ title: "x", level: 0 }),
    });

    expect(res.status).toBe(200);
  });

  it("400s on a body that fails schema validation", async () => {
    server = createServer({ anthropicClient: fakeClient("line") });
    baseUrl = await listen(server);

    const res = await fetch(`${baseUrl}/v1/nag-copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: 0 }),
    });

    expect(res.status).toBe(400);
  });

  it("400s on malformed JSON", async () => {
    server = createServer({ anthropicClient: fakeClient("line") });
    baseUrl = await listen(server);

    const res = await fetch(`${baseUrl}/v1/nag-copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
  });

  it("404s on an unknown route", async () => {
    server = createServer({ anthropicClient: fakeClient("line") });
    baseUrl = await listen(server);

    const res = await fetch(`${baseUrl}/v1/other`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("502s when the model call fails, so the client knows to fall back", async () => {
    server = createServer({ anthropicClient: failingClient() });
    baseUrl = await listen(server);

    const res = await fetch(`${baseUrl}/v1/nag-copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x", level: 0 }),
    });

    expect(res.status).toBe(502);
  });
});
