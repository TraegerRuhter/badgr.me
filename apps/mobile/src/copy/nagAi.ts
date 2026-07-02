import { createRemoteCopyGenerator, type CopyGenerator } from "@alarmed/core";

/**
 * Wires the shared `RemoteCopyGenerator` to the nag-ai proxy, if one is
 * configured. `EXPO_PUBLIC_*` vars are inlined into the bundle at build time
 * (Expo's documented mechanism for client-readable config), so this never
 * carries an LLM API key — only the proxy's URL and its abuse-deterrence
 * shared secret, if any.
 *
 * `null` when no endpoint is set: callers should skip the AI step entirely
 * and let the template ladder (already applied by the scheduler) stand.
 */
export const nagCopyGenerator: CopyGenerator | null = process.env
  .EXPO_PUBLIC_NAG_AI_ENDPOINT
  ? createRemoteCopyGenerator({
      endpoint: process.env.EXPO_PUBLIC_NAG_AI_ENDPOINT,
      sharedSecret: process.env.EXPO_PUBLIC_NAG_AI_SHARED_SECRET ?? null,
    })
  : null;
