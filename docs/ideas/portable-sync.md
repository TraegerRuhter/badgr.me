# Idea: portable sync — one encrypted file, no database

**Status:** rough sketch, not scheduled. Captured so it doesn't get lost.

## The idea

Sync a device pair (mobile ↔ web) by passing a single small, normalized,
encrypted text file between them — over whatever channel is already at hand
(email to yourself, AirDrop, a file in Drive/iCloud, a pasted string, a QR
code). No server, no database, no account. The file *is* the sync protocol.

## Why this fits badgr better than it looks

The existing sync engine was already built transport-agnostic, so this is a
new adapter, not a rewrite:

- `reconcileTasks(local, remote)` in `packages/core/src/sync.ts` is **pure**.
  It takes two `Task[]` snapshots and returns which rows move each way. It has
  no idea whether `remote` came from Postgres or a text file.
- `RemoteTaskStore` is a two-method seam — `listAll()` and `upsertMany()`.
  A file-backed implementation satisfies it directly, sitting alongside the
  Supabase one in `packages/supabase/src/remoteStore.ts`.
- **Soft deletes already propagate.** A deleted task is just a row with a
  non-null `deletedAt` and a bumped `updatedAt`. A naive export/import would
  silently resurrect deleted tasks; ours won't, because deletes travel as
  ordinary edits.
- **Last-write-wins on `updatedAt`** is exactly the right conflict rule for a
  channel this sloppy. Files can arrive late, out of order, or twice, and the
  result still converges. Replaying an old file is a no-op, not corruption.

## One correction to the premise

Email is **not** an encrypted exchange. Mail is TLS in transit but sits in
plaintext on the provider's servers, and it gets indexed, backed up, and
retained after "deletion." Leaning on the transport for confidentiality would
mean handing Google a readable copy of everything.

This makes the design *better*, not worse: encrypt the payload client-side, and
the transport stops mattering at all. A self-encrypting blob is safe to send
over any dumb pipe, so the channel becomes a user preference rather than a
security dependency — email today, AirDrop or a QR code tomorrow, same file.

## Format sketch

Armored text so it survives being pasted into a mail body, not just attached:

```
BADGR-SYNC-1
<base64url salt>.<base64url iv>.<base64url ciphertext>
```

Plaintext inside: NDJSON, one `Task` per line, **sorted by id with a fixed key
order**. Canonical ordering means identical state produces identical bytes,
which makes the thing diffable and debuggable by hand. (Ciphertext still
differs per export because the IV is random — which is what we want; equal
ciphertexts would leak that nothing changed.)

Sketch of the crypto, subject to the open question below: AES-GCM-256, key
derived from a user passphrase via PBKDF2/Argon2 with the per-file salt. GCM
gives integrity for free, so a truncated or tampered file fails loudly instead
of importing garbage. The version prefix lets the format change later without
guessing.

## The honest limitation

With a database, "remote" is authoritative shared state. With a file, each
device exports **a snapshot of its own view** — so a full exchange is a
two-way handshake. A exports → B imports (B now holds the union) → but A stays
stale until B exports back. Convergence takes a round trip in each direction,
and it's manual.

That's a real cost, and it's the thing to decide about before building: is
"press export, press import, occasionally" an acceptable ritual in exchange for
owing nothing to a server? For a single user with two devices — plausibly yes.
It's also strictly better than the current state when Supabase is unconfigured.

## Open questions

1. **Crypto availability in React Native.** The web side has WebCrypto natively.
   RN/Expo does not ship full `SubtleCrypto`; it'd need `expo-crypto`,
   `expo-standard-web-crypto`, or `react-native-quick-crypto`. This needs a
   spike before committing to AES-GCM — it's the main technical unknown.
2. **Key management UX.** A passphrase the user types on both devices is the
   simplest model with no server. Losing it means losing the ability to import,
   and there is deliberately no recovery. Is that acceptable, or should the
   first pairing generate a key that's transferred once by QR?
3. **File growth.** Snapshots carry soft-deleted rows forever. Needs a tombstone
   horizon (drop deletes older than N days) or the file grows without bound.
4. **Does it replace Supabase sync or sit beside it?** Beside, most likely —
   they're different tradeoffs, and the `RemoteTaskStore` seam allows both.
