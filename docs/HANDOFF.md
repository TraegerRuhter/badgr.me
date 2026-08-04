# Handoff

Written for a fresh session with no prior context. Read this first, then the
build plan for whichever workstream you've been asked to pick up.

**Two active workstreams, independent of each other:**

| Workstream | Plan | State |
| --- | --- | --- |
| Encrypted portable sync | `docs/plans/portable-sync-build-plan.md` | Phases 1–3 **merged** (#35, #36). §7 recovery sheet + passphrase change in **PR #39**. Phase 3's gate still needs physical devices |
| Reminder-editing parity with Due | `docs/plans/due-parity-build-plan.md` | Phases 1–4 built (1–3 merged as #38, Phase 4 in **PR #39**). Phases 5–6 unblocked |

### Start here, whatever you were asked to do

1. **`main` is red, and has been since #37 merged.** Last green `main` is
   `d83f914`. **PR #39 contains both fixes** (`b195b0e`, `79d0042`), so if it
   has landed by the time you read this, `main` is fine and this note is
   history — check before assuming either way. If it hasn't, branch from #39's
   head rather than `main`, or you inherit a broken typecheck.

   Both breakages came from one Dependabot bump, and neither was visible to
   branch-level CI, because each contributing PR passed alone and only the
   *merge* fails. Expect this class of failure again; check rather than assume.
2. **Run `pnpm install` at the repo root, then verify in a clean clone.** A
   partial sandbox install produces phantom `TS2307: Cannot find module` errors
   that are not real — *and* hides real errors, silently. See the gotchas
   section. Baseline is **347 tests**:
   `pnpm -r typecheck && pnpm -r lint && pnpm -r test`.
3. **Then read the plan for your workstream.** Both are self-contained and their
   section numbers are cited from code comments.

### The format question is settled

Adding a field to `Task` used to break the BDGR1 encrypted payload. It no longer
does: `canonical.ts` splits its key list into a mandatory v1 core and optional
later keys that are backfilled on read. Old snapshots still open; new snapshots
still open in older clients.

**To add a `Task` field:** append to `LATER_KEYS`, give it a default meaning
"never set", and read the rules at the top of `vectors.test.ts` before
regenerating anything. `compat.test.ts` is the guard — if it fails, the design
has failed and a `FORMAT_VERSION` bump becomes the right answer.

This deliberately overrode an older note in this file, and one in
`canonical.ts`, that both said to bump `FORMAT_VERSION` rather than regenerate
the vectors. Those notes predated anyone trying to add a field. The full
reasoning, and the conditions under which the version bump becomes correct
after all, are in `docs/plans/due-parity-build-plan.md` §9.4.

### Picking up the Due-parity work

Go straight to its plan — it is self-contained, and its §1 explains how to
regenerate the reference frames from the recording on branch `Vid`.

Phases 1–4 are built: the derived-label engine (`packages/core/src/describe.ts`),
nag presets with live fire-time previews, progressive disclosure in both editors,
and the pre-alarm lead time. Phases 5 (intra-day recurrence) and 6 (categories)
are specified and now unblocked — both add `Task` fields, which the format change
above made routine.

Two things to know before touching this:

- **`scripts/shots.mjs`** renders the web PWA at phone size with seeded fixtures
  and a frozen clock. Build *without* `CI=true` first. It is how the screenshots
  in the PR were produced, and the fastest way to see a change.
- **The mobile UI cannot be rendered here.** `expo export --platform web` gets
  as far as bundling — it needs `wasm` added to `config.resolver.assetExts` in
  `apps/mobile/metro.config.js` — but `expo-sqlite`'s web worker never creates
  the schema, so the app boots to an empty list and the editor is unreachable.
  Mobile parity currently rests on typecheck plus the shared-source guard in
  `apps/web/src/labelParity.test.ts`, not on anyone having looked at it.

### Picking up the encrypted-sync work

Phases 1–3 are merged and Phase 3's gate still needs physical devices — the
checklist is at the bottom of this file.

**PR #39 adds the §7 recovery paths** and is the most recent work: a recovery
sheet (Crockford base32 with a checksum, deviating from the plan's base64 for
transcription reasons recorded in `recovery.ts`), unlocking with that code, and
passphrase change by re-wrapping the data key. Before it, forgetting a
passphrase meant permanently unreadable snapshots.

Two API shapes there are deliberate and worth not "simplifying":
`unlockVaultRecord` exists so rotating a passphrase does not demand a snapshot
file, and `changeWebVaultPassphrase` takes the passphrase rather than the live
vault because the web key is non-extractable by design.

Everything below this line is the encrypted-sync workstream.

---

## Where things stand

Building **end-to-end encrypted sync** for badgr, in two tiers: a free
self-hosted option (point at any S3/WebDAV bucket you control) and a paid
managed option (badgr runs the bucket). Same client, same format, same
encryption — the managed tier sells convenience, never capability.

**Done:** the threat model, the full build plan, the KDF benchmark that picked
the parameters, `packages/crypto` (the sealed envelope), and **Phase 3 — offline
file sync**, wired end to end on both clients.

**Next:** sign off the Phase 3 gate on physical devices (see "Still open"), then
Phase 4 — S3/WebDAV adapters against the §5 storage contract.

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

The groundwork (build plan, `packages/crypto`) merged to `main` as **#35**, so
`main` is at `df2a433` and the branch was restarted from it rather than stacked
on already-merged history. It now carries the Phase 3 work.

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

Phase 3 added three things here without touching the on-disk format (the
committed vectors still pass, so `FORMAT_VERSION` stays at 1):

| File | Role |
| --- | --- |
| `aead.ts` | The `Aead` seam — `nobleAead` (raw bytes) vs `webCryptoAead` (key handle) |
| `armor.ts` | `badgr-sync/1` + base64url transport wrapper (§3.3). Not part of the envelope |
| `webVault.ts` | Web unlock: derive → unwrap → import non-extractable → zero the raw bytes |

`seal`/`openEnvelope` are unchanged and still synchronous. `sealWith`/
`openEnvelopeWith` are the same thing over the `Aead` seam, async because
WebCrypto is; a test asserts the two produce identical bytes.

---

## What `packages/portable-sync` gives you (Phase 3)

The policy layer: it owns the rollback rule and the file exchange, and depends
on both `core` and `crypto`. Phase 4's storage adapters belong here too — that
is why it is its own package rather than more files in `crypto`, which must stay
free of I/O and policy.

```ts
exportSnapshot(ctx): { blob, text, seq, taskCount }
importSnapshot(ctx, blob): { applied, localAhead, seq }
importSnapshotText(ctx, text)        // same, for a picked file
```

`PortableSyncContext` injects everything platform-specific — the vault record,
the `Aead`, the `LocalTaskStore`, the `SeqStore`, and the CSPRNG — so the whole
layer is testable with no device, no keystore, and no filesystem.

**`reconcileTasks` was not modified**, as expected: it was already pure and
handled soft deletes.

Two ordering decisions worth not undoing:

- **Export persists the new `seq` before returning the blob.** A cancelled share
  then merely burns a sequence number, which costs nothing. The reverse order
  risks a crash leaving two different snapshots at one sequence, which quietly
  breaks the ordering the rollback defence rests on.
- **Import re-checks the rollback rule after decryption.** The cheap `peekSeq`
  pre-check reads an unauthenticated header; the value that actually decides
  anything has to be the one GCM verified.

### Where the rollback rule lives on each platform

`seqSeen` is in secure storage beside the key, per §4.3, and is cleared together
with the vault — a stale mark would reject the next vault's first snapshot, and
clearing it alone would silently disarm the defence.

| | Key material | `seqSeen` |
| --- | --- | --- |
| Mobile | `expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (also keeps it out of iCloud Keychain and backups) | same store, separate entry |
| Web | IndexedDB, non-extractable `CryptoKey` | same IndexedDB store |

**The web guarantee is genuinely weaker and the UI should not imply otherwise:**
clearing site data resets `seqSeen`, disarming rollback detection on that
browser. The browser has no OS keystore to do better with.

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
- **A partial install also *hides* real errors, and `pnpm install` will not tell
  you.** It reports "Already up to date" against the lockfile while the tree is
  missing packages, and a `tsc` run that never loads a `.d.ts` cannot fail on it.
  This is how a green local `pnpm -r typecheck` and a red CI coexist. When CI
  disagrees with you, reproduce in a clean tree before doubting CI:

  ```bash
  git clone --shared . /tmp/repro && cd /tmp/repro
  pnpm install --frozen-lockfile && pnpm -r typecheck
  ```

  The store is local, so it takes seconds.
- **`@types/node` is pinned to one major by a `pnpm.overrides` entry in the root
  `package.json`. Don't remove it.** `apps/web` declares `^24`, while vitest's
  open peer range pulled a second major in transitively. Two majors means two
  bundled `undici-types`, so `fetch`'s `RequestInit.signal` and
  `new AbortController().signal` come from different declarations of
  `AbortSignal` and refuse to unify —
  `Property 'onabort' is missing in type 'AbortSignal' but required in type
  'AbortSignal'`, which reads like nonsense until you know there are two.
  Dependabot can reintroduce this by bumping one and not the other.
- **Tests use `TEST_KDF`** (`m: 64, t: 1`), not `DEFAULT_KDF`. Real Argon2id
  parameters take ~830 ms per call and would make the suite unusable. A separate
  test asserts `DEFAULT_KDF` hasn't changed, so speeding up tests can't quietly
  weaken production.
- **A failing `vectors.test.ts` is not flaky.** It means the bytes badgr writes
  changed. Default to bumping `FORMAT_VERSION` and writing a migration — do not
  just paste in the new expected bytes. **The one exception**, taken once and
  documented in `vectors.test.ts`'s own doc comment: appending an optional key
  that reads tolerantly changes what we *write* without changing what we can
  *read*, so old vaults stay readable and no migration exists to write. Taking
  that exception requires a `compat.test.ts` case proving a genuine old envelope
  still opens. Reasoning in `docs/plans/due-parity-build-plan.md` §9.4.
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

Current baseline — **347 tests**, all passing (was 192 before Phase 3):

| Package | Tests |
| --- | --- |
| `packages/core` | 156 |
| `packages/crypto` | 101 |
| `packages/portable-sync` | 25 |
| `services/nag-ai` | 14 |
| `packages/supabase` | 10 |
| `apps/web` | 14 |

`packages/ui` and `apps/mobile` have no tests yet — the mobile file-sync logic
is deliberately thin glue over `portable-sync`, which is where it is tested.

The Phase 3 additions worth knowing about:

- `crypto/aead.interop.test.ts` — noble and WebCrypto produce identical bytes and
  open each other's envelopes. This is what makes the §6.2 split safe rather than
  a fork, so it runs on every commit.
- `portable-sync/crossPlatform.test.ts` — a phone context (noble, raw key) and a
  browser context (WebCrypto, non-extractable key) exchange snapshots and
  converge, including soft deletes and rollback rejection in both directions.
- `portable-sync/fileSync.test.ts` — the §9 rollback test, plus: a forged higher
  `seq` stapled onto old ciphertext fails GCM, a rejection writes nothing, and a
  truncated or foreign file fails closed.

---

## Next steps, in order

**Sign off the Phase 3 gate (start here).** The gate is "round-trip across web ↔
mobile on physical devices; rollback rejected." The rollback half is done and
tested. The round trip is proven in tests across both crypto paths, but **not on
real hardware** — nothing in this sandbox has run Expo. What needs a physical
device:

- Export from the phone via the share sheet, import in a browser, and back.
- Confirm `expo-secure-store` actually persists across a force-close, and that
  the entry stays out of iCloud Keychain and backups.
- Confirm `expo-crypto.getRandomBytesAsync` on-device (it was never verified in
  the spike sandbox either — this is Phase 1's leftover too).
- Time `createDeviceVault`, which is the real Phase 1 measurement: Argon2id at
  `DEFAULT_KDF` on the JS thread. Budget: unlock ≤3 s, peak RSS ≤200 MB, no OOM.

**Then Phase 4** — S3/WebDAV adapters against the §5 contract. They belong in
`packages/portable-sync`; the `PortableSyncContext` seam is already the shape
they plug into.
**Then Phase 5** — the managed service.

### Three things still genuinely open

1. **Snapshots vs. op-log CRDT.** The plan specifies snapshots + LWW, reusing
   `reconcileTasks` unchanged. An op-log (Yjs — pure JS; Automerge is WASM and
   awkward in RN) buys field-level merges and delta sync. **Expensive to
   retrofit — decide before Phase 4.** Honest read: for one person with two
   devices, snapshots are probably sufficient forever.
2. **Phase 1's gate is not fully signed off.** The 830 ms figure is Node on
   server hardware — an optimistic floor. Hermes will be 2–4× slower. Folded
   into the physical-device checklist above.
3. **Passphrase change and the recovery sheet (§7) are not built.** Re-wrapping
   the data key is cheap and the crypto supports it, but there is no UI, and no
   printable recovery sheet. Until that ships, a forgotten passphrase is
   unrecoverable with no warning beyond the setup copy.

### Unrelated, still outstanding

- Supabase sync has never been verified end-to-end (needs a real machine; the
  sandbox blocks `supabase.co`).
- GitHub Pages Source should be flipped to "GitHub Actions" to stop a
  README/deploy race. Requires the repo owner — an agent cannot do it.
