import OpenAI from "openai";

import { DEFAULT_MODEL } from "./copyClient.js";
import { createServer } from "./server.js";

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  throw new Error("GROQ_API_KEY is required");
}

const llmClient = new OpenAI({
  apiKey,
  baseURL: "https://api.groq.com/openai/v1",
});
const port = Number(process.env.PORT ?? 8787);

const server = createServer({
  llmClient,
  model: process.env.GROQ_MODEL ?? DEFAULT_MODEL,
  sharedSecret: process.env.NAG_AI_SHARED_SECRET ?? null,
});

server.on("error", (err) => {
  console.error("nag-ai server error:", err);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`nag-ai proxy listening on :${port}`);
});
