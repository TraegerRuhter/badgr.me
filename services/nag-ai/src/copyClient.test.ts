import { describe, expect, it, vi } from "vitest";
import { generateEscalatedLine, type LlmClient } from "./copyClient";

function fakeClient(text: string): LlmClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: text } }],
        }),
      },
    },
  } as unknown as LlmClient;
}

describe("generateEscalatedLine", () => {
  it("returns the task title untouched and the model's line as body", async () => {
    const client = fakeClient("Still not done. Wow.");
    const result = await generateEscalatedLine(
      { title: "Renew passport", level: 3 },
      client
    );
    expect(result).toEqual({ title: "Renew passport", body: "Still not done. Wow." });
  });

  it("trims whitespace from the model's reply", async () => {
    const client = fakeClient("  trimmed line  \n");
    const result = await generateEscalatedLine({ title: "x", level: 0 }, client);
    expect(result.body).toBe("trimmed line");
  });

  it("throws on an empty response so the caller can fall back", async () => {
    const client = fakeClient("");
    await expect(
      generateEscalatedLine({ title: "x", level: 0 }, client)
    ).rejects.toThrow();
  });

  it("throws on an oversized response", async () => {
    const client = fakeClient("x".repeat(500));
    await expect(
      generateEscalatedLine({ title: "x", level: 0 }, client)
    ).rejects.toThrow();
  });

  it("passes the requested model through to the SDK call", async () => {
    const client = fakeClient("fine");
    await generateEscalatedLine({ title: "x", level: 0 }, client, "llama-3.3-70b-versatile");
    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "llama-3.3-70b-versatile" }),
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });
});
