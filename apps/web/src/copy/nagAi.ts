import { createRemoteCopyGenerator, type CopyGenerator } from "@alarmed/core";

/**
 * Wires the shared `RemoteCopyGenerator` to the nag-ai proxy, if one is
 * configured. Vite inlines `VITE_*` vars into the client bundle at build
 * time, so this never carries an LLM API key — only the proxy's URL and
 * its abuse-deterrence shared secret, if any. Mirrors
 * `apps/mobile/src/copy/nagAi.ts`.
 *
 * `null` when no endpoint is set: callers should skip the AI step entirely
 * and let the template ladder (already applied by the scheduler) stand.
 */
const endpoint = import.meta.env.VITE_NAG_AI_ENDPOINT;

export const nagCopyGenerator: CopyGenerator | null = endpoint
  ? createRemoteCopyGenerator({
      endpoint,
      sharedSecret: import.meta.env.VITE_NAG_AI_SHARED_SECRET ?? null,
    })
  : null;
