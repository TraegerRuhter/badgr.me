import type { CopyContext, CopyGenerator, CopyResult } from "./copy";
import { templateCopyGenerator } from "./copy";

/**
 * A `CopyGenerator` that asks the nag-ai proxy (services/nag-ai) for a
 * freshly AI-rewritten line, falling back to the deterministic template
 * ladder on any failure — bad status, malformed body, timeout, or being
 * offline. Both mobile and web can use this unmodified: `fetch` and
 * `AbortController` are globals on both platforms, and the proxy is what
 * actually holds the LLM API key, so nothing platform-specific belongs
 * here.
 */
export interface RemoteCopyGeneratorOptions {
  /** Full URL of the proxy's `/v1/nag-copy` endpoint. */
  endpoint: string;
  /** Must match the proxy's `NAG_AI_SHARED_SECRET`, if it has one configured. */
  sharedSecret?: string | null;
  /** Give up and fall back this many ms after the request starts. */
  timeoutMs?: number;
  /** What to use when the remote call fails. Defaults to the template ladder. */
  fallback?: CopyGenerator;
}

function isCopyResult(value: unknown): value is CopyResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).title === "string" &&
    typeof (value as Record<string, unknown>).body === "string"
  );
}

export function createRemoteCopyGenerator(
  options: RemoteCopyGeneratorOptions
): CopyGenerator {
  const {
    endpoint,
    sharedSecret = null,
    timeoutMs = 4000,
    fallback = templateCopyGenerator,
  } = options;

  return {
    async generate(context: CopyContext): Promise<CopyResult> {
      // User notes always win over synthetic copy (same rule as the template
      // ladder) — skip the network call entirely when the answer is fixed.
      if (context.task.notes?.trim()) {
        return fallback.generate(context);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(sharedSecret ? { authorization: `Bearer ${sharedSecret}` } : {}),
          },
          body: JSON.stringify({
            title: context.task.title,
            notes: context.task.notes,
            level: context.level,
          }),
          signal: controller.signal,
        });

        if (!res.ok) throw new Error(`nag-ai responded ${res.status}`);

        const data: unknown = await res.json();
        if (!isCopyResult(data)) throw new Error("nag-ai returned a malformed response");

        return data;
      } catch {
        return fallback.generate(context);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
