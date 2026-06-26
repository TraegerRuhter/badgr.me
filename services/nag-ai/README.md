# @alarmed/nag-ai

A tiny proxy that holds the Anthropic API key server-side and rewrites one
nag line per request. Neither client app embeds an API key — a key baked
into a mobile or web bundle is trivially extractable, so the AI rewrite has
to go through here instead.

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
ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @alarmed/nag-ai build
ANTHROPIC_API_KEY=sk-ant-... node services/nag-ai/dist/index.js
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
| `ANTHROPIC_API_KEY` | yes | Server-side only. Never ship this in a client build. |
| `ANTHROPIC_MODEL` | no | Defaults to a small/fast Claude model; override to bump a deprecated dated snapshot. |
| `PORT` | no | Defaults to `8787`. |
| `NAG_AI_SHARED_SECRET` | no | If set, requests must send `Authorization: Bearer <secret>`. This is abuse-deterrence for a single-user app, not real auth — it doesn't protect the secret itself from extraction any better than the Anthropic key would be, it just keeps random internet traffic from burning your Anthropic budget. Real per-user auth arrives with the Phase 3 Supabase work. |
