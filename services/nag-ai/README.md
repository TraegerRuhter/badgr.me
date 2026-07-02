# @alarmed/nag-ai

A tiny proxy that holds the LLM API key server-side and rewrites one nag
line per request. Neither client app embeds an API key — a key baked into a
mobile or web bundle is trivially extractable, so the AI rewrite has to go
through here instead.

The model behind it is Groq's free tier (default `llama-3.1-8b-instant`,
OpenAI-compatible API) — fast enough to sit in the live snooze path and free
for this app's volume. Get a key at https://console.groq.com. Because the
client is the standard `openai` SDK pointed at a `baseURL`, swapping
providers later is a two-line change in `src/index.ts`.

This only sits in the *live* path: when a user taps "Snooze" on a fired
notification, the app calls this once to get a freshly escalated line for
the *next* occurrence, then falls back to its own local template ladder
(`generateTemplateCopy` in `@alarmed/core`) on any timeout, error, or offline
condition. It is never called to pre-fill an entire pre-scheduled burst —
local OS notifications are static at schedule time, so every occurrence
beyond "the next one" is always the deterministic template ladder regardless
of whether this service is reachable.

## Running it

```
GROQ_API_KEY=gsk_... pnpm --filter @alarmed/nag-ai dev    # build + run
```

or build once and run the artifact:

```
pnpm --filter @alarmed/nag-ai build
GROQ_API_KEY=gsk_... node services/nag-ai/dist/index.js
```

## Endpoint

`POST /v1/nag-copy`

```json
{ "title": "Renew passport", "notes": null, "level": 3 }
```

→

```json
{ "title": "Renew passport", "body": "Still not done? Bold strategy." }
```

`level` is `task.snoozeCount` at call time — see
`packages/core/src/copy.ts` for what it represents.

## Env vars

| Var | Required | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | yes | Server-side only. Never ship this in a client build. |
| `GROQ_MODEL` | no | Defaults to `llama-3.1-8b-instant`; other free options include `llama-3.3-70b-versatile` and `gemma2-9b-it`. |
| `PORT` | no | Defaults to `8787`. |
| `NAG_AI_SHARED_SECRET` | no | If set, requests must send `Authorization: Bearer <secret>`. This is abuse-deterrence for a single-user app, not real auth — it doesn't protect the secret itself from extraction any better than the API key would be, it just keeps random internet traffic from burning your quota. |
