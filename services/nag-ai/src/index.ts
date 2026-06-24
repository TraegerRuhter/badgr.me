import Anthropic from "@anthropic-ai/sdk";

import { DEFAULT_MODEL } from "./copyClient.js";
import { createServer } from "./server.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  throw new Error("ANTHROPIC_API_KEY is required");
}

const anthropicClient = new Anthropic({ apiKey });
const port = Number(process.env.PORT ?? 8787);

const server = createServer({
  anthropicClient,
  model: process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
  sharedSecret: process.env.NAG_AI_SHARED_SECRET ?? null,
});

server.listen(port, () => {
  console.log(`nag-ai proxy listening on :${port}`);
});
