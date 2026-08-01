# Handoff: encrypted portable sync

Written for a fresh session with no prior context. Read this first, then the
build plan. Should take about two minutes.

---

## Where things stand

Building **end-to-end encrypted sync** for badgr, in two tiers: a free
self-hosted option (point at any S3/WebDAV bucket you control) and a paid
managed option (badgr runs the bucket). Same client, same format, same
encryption — the managed tier sells convenience, never capability.

**Done:** the threat model, the full build plan, the KDF benchmark that picked
the parameters, and `packages/crypto` — the sealed-envelope implementation with
40 tests.

**Next:** Phase 3, offline file sync. Wire `seal`/`openEnvelope` to the existing
`reconcileTasks` and the OS share sheet. No network, no server; it ships real
user value on its own.

---

## Read these, in this order

1. `docs/plans/portable-sync-build-plan.md` — the spec. Threat model, security
   invariants I1–I7, byte-exact envelope layout, phases with blocking gates.
   **This is the source of truth.** Section numbers are referenced throughout
   the code comments.
2. `docs/ideas/portable-sync.md` — how the idea started, plus the first spike's
   results. Useful background, superseded by the plan where they disagree.
3. `packages/crypto/src/suite.ts` — every format constant in one file.

---

## The work in git

Branch: **`claude/alarmed-tech-spec-f697nr`** (all work goes here — do not push
elsewhere without asking).

Four commits ahead of `main`, none merged, **no PR open**:

```
58c8118  feat(crypto): add @alarmed/crypto with the BDGR1 sealed envelope
d953122  docs: add build plan for E2E encrypted sync
c104083  docs: record portable-sync crypto spike results
eda95ff  docs: capture portable-sync idea
```

`main` is at `379da54`. Working tree is clean.

**PR policy:** do not open one unless the user asks. They asked once, for the
memoization work (#33, merged), and were happy to have it merged straight
away — but treat that as per-change permission, not standing.

---

## What `packages/crypto` gives you

Pure and platform-agnostic: no I/O, no platform APIs, so it runs identically
under Node, browsers, and Hermes.

```ts
// Expensive — Argon2id. Once per unlock, then cache dataKey in the OS keystore.
createVault(passphrase, { kdf?, random? }): VaultKeys
unlockVault(passphrase, blob): VaultKeys

// Cheap — no KDF. Per sync.
seal(vault, tasks, seq, random?): Uint8Array
openEnvelope(vault, blob): { tasks, seq }

// Cheap rollback pre-check, no decryption needed.
peekSeq(blob): bigint
```

That split is deliberate and load-bearing: the KDF is affordable only because
it is paid once per unlock rather than per sync.

| File | Role |
| --- | --- |
| `suite.ts` | Format constants, offsets, `DEFAULT_KDF` |
| `keys.ts` | Argon2id → HKDF → KEK → unwrap dataKey |
| `envelope.ts` | Header encode/decode, `seal`, `openEnvelope` |
| `canonical.ts` | Deterministic NDJSON (sorted by id, fixed key order) |
| `framing.ts` | Length-hiding pad to 4 KiB blocks |
| `random.ts` | CSPRNG seam — platforms inject their own |
| `testing.ts` | Deterministic fake random + fast `TEST_KDF`. Test-only. |

---

## Decisions already made — please don't re-litigate these

Each one has a reason recorded. Change them if the reason turns out wrong, not
because they look arbitrary.

**Argon2id, not scrypt.** Measured: scrypt at OWASP's recommended N=2¹⁷ peaks at
**+132 MB RSS** in pure JS, which risks OOM on low-end Android. Argon2id at
OWASP's minimum costs **+23 MB** for comparable time (830 ms vs 1074 ms), and is
OWASP's *first-choice* algorithm anyway. The plan originally ranked scrypt first
only because Obsidian uses it — imitation, not reasoning.

**Two separate secrets.** Vault passphrase (encryption) is independent of server
auth. The server never holds any value derived from the passphrase, so a breach
cannot even begin a brute-force. This is invariant I2.

**Managed auth uses device Ed25519 keypairs — no account password at all.**
Tailscale's model. Makes I2 structural rather than a promise.

**Web uses native WebCrypto; mobile uses `@noble/*`.** Not a compromise. Only
WebCrypto can hold a **non-extractable** `CryptoKey`, so injected script can
*use* the key but never read its bytes. Against XSS that's the difference
between losing the vault key forever and losing one session. The split is safe
because interop is asserted on every test run.

**Plaintext length lives inside the ciphertext, never in the header.** A
cleartext `padLen` field would leak the exact size and defeat padding entirely.
If this looks like it could be simplified, it can't.

**`gzipSync(..., { mtime: 0 })` is required, not cosmetic.** fflate defaults the
gzip MTIME to `Date.now()`, which made sealing non-deterministic and stamped the
seal time into the payload. The committed test vector caught this on its first
run — note that every functional round-trip test still passed, so nothing else
would have found it.

**Publish a storage contract; don't build a self-host server.** Two operations
(`GET`/`PUT` with HTTP preconditions) that S3, R2, MinIO, and WebDAV all satisfy
today. Obsidian never shipped self-hosted sync — it got a whole ecosystem free
because the vault was just files. Same play.

**Internal `@alarmed/*` scope stays** despite the badgr.me rebrand. Renaming
churns every import for zero user value.

---

## Environment gotchas that cost time here

- **Run `pnpm install` at the repo root first.** The sandbox may arrive with a
  partial install, which produces phantom `TS2307: Cannot find module` errors in
  packages whose `node_modules` is missing. They are not real type errors.
- **Tests use `TEST_KDF`** (`m: 64, t: 1`), not `DEFAULT_KDF`. Real Argon2id
  parameters take ~830 ms per call and would make the suite unusable. A separate
  test asserts `DEFAULT_KDF` hasn't changed, so speeding up tests can't quietly
  weaken production.
- **A failing `vectors.test.ts` is not flaky.** It means the on-disk format
  changed and existing vaults can no longer be read. Bump `FORMAT_VERSION` and
  write a migration — do not just paste in the new expected bytes.
- **Playwright:** chromium is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`,
  the module at `/opt/node22/lib/node_modules/playwright/index.mjs`. Never run
  `playwright install`.
- **Web build uses base path `/badgr.me/`.** A naive static server returns
  `index.html` for `/badgr.me/assets/*` and you get MIME errors; strip the
  prefix when serving `dist` locally.
- **Don't background processes with `&`** in compound Bash commands, and don't
  `pkill` harness-tracked jobs — both cause exit 144 and can abort the command
  mid-run. Use `run_in_background: true`.

---

## Verifying

```bash
pnpm install
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

Current baseline — **192 tests**, all passing:

| Package | Tests |
| --- | --- |
| `packages/core` | 121 |
| `packages/crypto` | 40 |
| `services/nag-ai` | 14 |
| `packages/supabase` | 10 |
| `apps/web` | 7 |

`packages/ui` and `apps/mobile` have no tests yet.

---

## Next steps, in order

**Phase 3 — offline file sync (start here).** Export a sealed envelope through
the OS share sheet; import one back. Wire to `reconcileTasks` in
`packages/core/src/sync.ts`, which is already pure, transport-agnostic, and
handles soft deletes correctly — it needs no changes.

Enforce the rollback rule here (plan §4.3): persist `seqSeen` in secure storage
and reject any envelope with a lower seq. **A rollback rejection is a security
event**, not a sync error — surface it as an explicit warning naming a possible
compromised provider, never a silent retry.

Mobile needs `expo-secure-store` added (not currently a dependency) for the
keystore, and `expo-crypto.getRandomBytesAsync` wired into the `RandomSource`
seam.

**Then Phase 4** — S3/WebDAV adapters against the §5 contract.
**Then Phase 5** — the managed service.

### Two things still genuinely open

1. **Snapshots vs. op-log CRDT.** The plan specifies snapshots + LWW, reusing
   `reconcileTasks` unchanged. An op-log (Yjs — pure JS; Automerge is WASM and
   awkward in RN) buys field-level merges and delta sync. **Expensive to
   retrofit — decide before Phase 4.** Honest read: for one person with two
   devices, snapshots are probably sufficient forever.
2. **Phase 1's gate is not fully signed off.** The 830 ms figure is Node on
   server hardware — an optimistic floor. Hermes will be 2–4× slower. Needs
   measurement on a physical low-end Android, which could not be done in the
   sandbox. Budget: unlock ≤3 s, peak RSS ≤200 MB, no OOM.

### Unrelated, still outstanding

- Supabase sync has never been verified end-to-end (needs a real machine; the
  sandbox blocks `supabase.co`).
- GitHub Pages Source should be flipped to "GitHub Actions" to stop a
  README/deploy race. Requires the repo owner — an agent cannot do it.
