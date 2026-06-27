import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";

import { generateEscalatedLine, type AnthropicMessages } from "./copyClient.js";

const requestSchema = z.object({
  title: z.string().min(1),
  notes: z.string().nullable().optional(),
  level: z.number().int().nonnegative(),
});

export interface ServerOptions {
  anthropicClient: AnthropicMessages;
  model?: string;
  /** When set, requests must send a matching `Authorization: Bearer <secret>` header. */
  sharedSecret?: string | null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage, sharedSecret?: string | null): boolean {
  if (!sharedSecret) return true;
  // `authorization` is string | string[] — a duplicated header arrives as an
  // array, which would never === the expected string. Normalize to the first.
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  return value === `Bearer ${sharedSecret}`;
}

/**
 * The whole proxy: a single endpoint that holds the Anthropic key
 * server-side and rewrites one nag line per request. Clients (mobile/web)
 * never see the key — they call this over plain HTTPS and fall back to
 * their own local template ladder if this is slow, down, or rejects them.
 */
export function createServer(options: ServerOptions) {
  return createHttpServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/nag-copy") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (!isAuthorized(req, options.sharedSecret)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    readBody(req)
      .then(async (raw) => {
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }

        const parsed = requestSchema.safeParse(parsedBody);
        if (!parsed.success) {
          sendJson(res, 400, { error: parsed.error.message });
          return;
        }

        try {
          const result = await generateEscalatedLine(
            parsed.data,
            options.anthropicClient,
            options.model
          );
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 502, {
            error: err instanceof Error ? err.message : "generation failed",
          });
        }
      })
      .catch(() => sendJson(res, 400, { error: "could not read request body" }));
  });
}
