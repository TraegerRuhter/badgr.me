import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemoteCopyGenerator } from "./remoteCopy";
import type { CopyGenerator } from "./copy";
import type { Task } from "./types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Renew passport",
    notes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    fireAt: "2026-01-01T00:00:00.000Z",
    nagIntervalSeconds: 120,
    nagMaxCount: null,
    nagUntil: null,
    escalationMode: "none",
    completedAt: null,
    dismissedAt: null,
    repeatRule: null,
    priority: 0,
    deviceOrigin: "mobile",
    deletedAt: null,
    snoozeCount: 0,
    ...overrides,
  };
}

const stubFallback: CopyGenerator = {
  generate: vi.fn().mockResolvedValue({ title: "fallback title", body: "fallback body" }),
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(stubFallback.generate).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRemoteCopyGenerator", () => {
  it("posts the task title/notes/level and returns the parsed result", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ title: "Renew passport", body: "AI line" }),
    } as Response);

    const generator = createRemoteCopyGenerator({ endpoint: "https://proxy/v1/nag-copy" });
    const result = await generator.generate({ task: makeTask(), level: 4 });

    expect(result).toEqual({ title: "Renew passport", body: "AI line" });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://proxy/v1/nag-copy");
    expect(JSON.parse(init?.body as string)).toEqual({
      title: "Renew passport",
      notes: null,
      level: 4,
    });
  });

  it("sends an Authorization header when a shared secret is configured", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ title: "x", body: "y" }),
    } as Response);

    const generator = createRemoteCopyGenerator({
      endpoint: "https://proxy/v1/nag-copy",
      sharedSecret: "topsecret",
    });
    await generator.generate({ task: makeTask(), level: 0 });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer topsecret"
    );
  });

  it("falls back when the proxy responds with a non-ok status", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 502 } as Response);

    const generator = createRemoteCopyGenerator({
      endpoint: "https://proxy/v1/nag-copy",
      fallback: stubFallback,
    });
    const result = await generator.generate({ task: makeTask(), level: 1 });

    expect(result).toEqual({ title: "fallback title", body: "fallback body" });
  });

  it("falls back on a malformed response body", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ title: "only a title" }),
    } as Response);

    const generator = createRemoteCopyGenerator({
      endpoint: "https://proxy/v1/nag-copy",
      fallback: stubFallback,
    });
    const result = await generator.generate({ task: makeTask(), level: 1 });

    expect(result).toEqual({ title: "fallback title", body: "fallback body" });
  });

  it("falls back when fetch throws (offline, timeout, etc.)", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    const generator = createRemoteCopyGenerator({
      endpoint: "https://proxy/v1/nag-copy",
      fallback: stubFallback,
    });
    const result = await generator.generate({ task: makeTask(), level: 1 });

    expect(result).toEqual({ title: "fallback title", body: "fallback body" });
  });

  it("never calls the network when the task has notes — notes always win", async () => {
    const generator = createRemoteCopyGenerator({
      endpoint: "https://proxy/v1/nag-copy",
      fallback: stubFallback,
    });
    const result = await generator.generate({
      task: makeTask({ notes: "bring the form" }),
      level: 5,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({ title: "fallback title", body: "fallback body" });
  });

  it("defaults to the template ladder when no fallback is given", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    const generator = createRemoteCopyGenerator({ endpoint: "https://proxy/v1/nag-copy" });
    const result = await generator.generate({ task: makeTask(), level: 0 });

    expect(result.body).toBe("Still on your list — tap to deal with it.");
  });
});
