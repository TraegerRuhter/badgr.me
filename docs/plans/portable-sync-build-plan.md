# Build plan: end-to-end encrypted sync (self-hosted + managed)

**Status:** proposed. Not started. Supersedes nothing; extends
`docs/ideas/portable-sync.md`.

Two tiers, one client, one format:

- **Self-hosted (free).** Point badgr at any S3-compatible bucket or WebDAV
  endpoint you control. No badgr server involved, ever.
- **Managed (paid).** Same client, same encryption, same format — badgr runs
  the bucket. Sells convenience, never capability.

The rule that makes this work, taken from Bitwarden and Standard Notes: **the
managed tier must never have a security property the self-hosted tier lacks.**
The moment you paywall a security feature, self-hosters route around you and
the goodwill that sustains the model evaporates.

---

## 0. Scope and non-goals

**In scope.** Confidentiality and integrity of task data at rest on any storage
provider, including badgr's own. Detection of tampering, rollback, and
truncation by that provider. Multi-device convergence without a trusted party.

**Explicitly not promised.** State these in the UI and the docs — every
credible project does, and hedging here is how you get accused of lying later:

| Not protected | Why |
| --- | --- |
| Metadata: blob size (bucketed), sync times, device count, IP | Inherent to storing bytes somewhere |
| A compromised *unlocked* device | Attacker has the plaintext app |
| A malicious client build | Mitigated by reproducible builds, not crypto |
| Server equivocation (split-brain across devices) | Needs a transparency log; see §4.4 |
| Forgotten passphrase | No recovery. By design. Non-negotiable. |

---

## 1. Threat model

Adversaries, in the order they actually matter:

**A1 — Honest-but-curious storage provider (including badgr).** Reads every
byte at rest. Must learn nothing but ciphertext and bucketed sizes. This is the
adversary the whole design exists for; if badgr can read your tasks, the paid
tier is a lie.

**A2 — Actively malicious storage provider.** Can serve stale blobs, withhold
writes, truncate, reorder, or replay. Cannot forge (GCM), but **rollback is not
covered by encryption alone** — see §4.3. This is the adversary most E2E
designs get wrong.

**A3 — Offline attacker with a stolen blob.** Must pay full KDF cost per
passphrase guess. Drives §3.1 parameter choice.

**A4 — Stolen locked device.** Key material must be inside the OS keystore, not
app storage. Drives §6.

**A5 — XSS on the web app.** Cannot be fully prevented; must be *contained* so
the key cannot be exfiltrated even when script runs. Drives §6.2.

---

## 2. Security invariants

Numbered because each one gets a test that fails the build if broken.

- **I1** The vault passphrase, and every value derived from it, never leaves the
  device. Not to badgr, not in telemetry, not in crash reports.
- **I2** Server auth credentials are cryptographically independent of the
  encryption key. Compromising the auth path yields zero information about the
  encryption path.
- **I3** Every stored byte of task data is authenticated. Any single-bit change
  anywhere fails decryption loudly. No partial or best-effort reads.
- **I4** A client never accepts a vault state older than the newest it has
  already seen.
- **I5** Ciphertext length reveals only a 4 KiB bucket, never an exact size.
- **I6** The managed service's schema has no column capable of holding key
  material. Zero-knowledge is structural, not a policy promise.
- **I7** Format and parameters are versioned and authenticated; downgrade is
  detectable.

---

## 3. Cryptographic specification

Algorithms follow [Obsidian Sync's published scheme](https://obsidianmd.github.io/sync/security)
(scrypt → HKDF → AES-256-GCM), with two additions it doesn't document: a
wrapped data key, and rollback binding.

### 3.1 Key hierarchy

```
vaultPassphrase                    (user secret; never transmitted, in any form)
   │
   ├─ scrypt(passphrase, kdfSalt, N, r, p, dkLen=32) ──► masterKey
   │
   ├─ HKDF-SHA256(masterKey, info="badgr/v1/kek")   ──► KEK
   │
   └─ dataKey  ← 32 CSPRNG bytes, generated once per vault
         stored as: AES-256-GCM(KEK, wrapNonce, AAD = vaultId ‖ version, dataKey)
```

**Why a wrapped data key** (Obsidian derives the content key straight from the
passphrase): changing your passphrase re-wraps 32 bytes instead of
re-encrypting the entire vault. It also makes future key rotation and
per-device revocation tractable. This is how LUKS, Bitwarden, and restic all do
it, and skipping it is a decision you cannot reverse cheaply later.

### 3.2 Parameters — and the constraint that may break them

[OWASP recommends](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
Argon2id at ≥19 MiB / t=2 / p=1, or, where unavailable, **scrypt at N=2¹⁷, r=8,
p=1 — which costs roughly 128 MB of RAM per derivation.**

That number is the single biggest technical risk in this plan. Pure-JS scrypt
allocating 128 MB on a low-end Android device may simply OOM, and `expo-crypto`
does not expose scrypt or Argon2, so there is no native escape hatch without a
dev-client build (which would forfeit Expo Go).

**Mitigating reframe:** KDF cost is paid **once per unlock**, not per sync. The
derived `dataKey` is cached in the OS keystore for the session, so the budget is
"acceptable app-unlock latency," not "acceptable sync latency." A 2–3 second
unlock is normal for a vault app.

**Fallback ladder**, in preference order, to be resolved by the Phase 1 gate:

1. scrypt N=2¹⁷, r=8, p=1 — OWASP high. Preferred.
2. scrypt N=2¹⁶, r=8, p=1 (~64 MB) — OWASP moderate. Document the deviation.
3. Argon2id 19 MiB / t=3 — lower peak memory, may fare better in JS.
4. PBKDF2-SHA256 ≥600k via native WebCrypto where available. **Last resort** —
   not memory-hard, materially weaker against GPU/ASIC attackers. If chosen,
   say so publicly rather than quietly.

Do not pick from this list by intuition. Pick by measurement (§8, Gate 1).

### 3.3 Envelope format — `BDGR1`

Header is cleartext and serves as the GCM **AAD**, so every field below is
tamper-evident without being secret.

```
offset  size  field
------  ----  --------------------------------------------------
     0     4  magic          "BDGR"
     4     1  version        0x01
     5     1  suite          0x01 = scrypt+HKDF-SHA256+AES-256-GCM
     6     1  scryptLogN
     7     1  scryptR
     8     1  scryptP
     9    16  vaultId        random 128-bit, not user-derived
    25    16  kdfSalt
    41    12  wrapNonce
    53    48  wrappedDataKey (32 ct + 16 tag)
   101     8  seq            u64 big-endian, strictly monotonic
   109    12  payloadNonce
------  ----  --------------------------------------------------
            121 bytes total
```

Payload:

```
inner = u32be(gzipLen) ‖ gzip(canonicalNDJSON(tasks)) ‖ zeroPad
        padded to a multiple of 4096
ct    = AES-256-GCM(dataKey, payloadNonce, AAD = headerBytes, inner)
blob  = headerBytes ‖ ct
```

**The real length lives inside the ciphertext, never in the header.** Putting a
`padLen` field in the cleartext header would defeat padding entirely — an
obvious-in-hindsight mistake worth stating explicitly so nobody "simplifies" it
back in (I5).

`canonicalNDJSON` = one `Task` per line, rows sorted by `id`, keys emitted in a
fixed declared order, `\n` separated, no trailing newline. Deterministic output
makes the format diffable and makes test vectors meaningful.

**Nonces:** 96-bit, CSPRNG, never derived from a counter. GCM nonce reuse under
one key is catastrophic (it leaks the XOR of plaintexts *and* enables forgery).
Random 96-bit nonces are safe to ~2³² messages by the birthday bound — roughly
four billion syncs, unreachable here. Counter-derived nonces were considered and
rejected: a restore-from-backup can rewind a counter, and that failure mode is
silent.

**Armored form** for share-sheet/email transport (`docs/ideas/portable-sync.md`):
`badgr-sync/1` newline, then base64url of `blob`.

### 3.4 Rejected alternatives

| Rejected | Why |
| --- | --- |
| AES-CBC + HMAC | More moving parts, encrypt-then-MAC ordering is a classic footgun; GCM is one primitive |
| XChaCha20-Poly1305 | Genuinely fine, arguably better nonce margin — but WebCrypto has no ChaCha, forfeiting non-extractable keys on web (§6.2) |
| Deriving auth from the vault passphrase | Violates I2; hands the server a brute-forceable verifier |
| Per-task encryption | Leaks task count and edit patterns directly |

---

## 4. Sync protocol

### 4.1 State model

One object per vault holds the entire state. At ~3 KB for 250 tasks, sharding
buys nothing and costs consistency.

Local persistent state (secure storage, never in plain app files):

```
vaultId, dataKey (cached), seqSeen (u64), etagSeen (string)
```

### 4.2 The sync cycle

```
1. GET current            → blob, etag
2. Parse header. Reject unless seq >= seqSeen             (I4)
3. Decrypt with AAD = header. Any failure → abort loudly, never partial-apply
4. reconcileTasks(localTasks, remoteTasks)  ← already exists, pure, unchanged
5. If nothing to push:  persist seqSeen/etagSeen; done
6. Else: build blob with seq = max(seq, seqSeen) + 1
7. PUT current  If-Match: etag
      200 → persist seqSeen, etagSeen
      412 → someone else wrote; goto 1 (bounded retry, jittered backoff)
```

Step 4 is the whole reason this is cheap to build: `reconcileTasks` in
`packages/core/src/sync.ts` is already pure, transport-agnostic, and handles
soft deletes. This plan adds an envelope and a transport around code that
already works.

### 4.3 Rollback defence — read this twice

Encryption does not stop a malicious provider from serving you a **genuine,
correctly-signed, older** blob to silently revert your changes. Every check
passes; the data is authentically yours, just stale. Two mechanisms, and you
need both:

- `seq` is inside the AAD, so an attacker cannot lift old ciphertext and staple
  a higher sequence number onto it.
- The client persists `seqSeen` locally and **refuses any blob with a lower
  seq**. This is the part that actually stops the attack, and it only works
  because the state is local — which is why `seqSeen` must live in secure
  storage alongside the key, not in a file the app can be tricked into resetting.

A rollback rejection is a **security event**, not a sync error. It must surface
as a hard, explicit warning that names the possibility of a compromised
provider — never as a silent retry or an auto-resolve.

### 4.4 Known limitation: equivocation

A malicious server can serve device A one history and device B another, and
neither detects it while they stay partitioned. Real defences (Keybase/Signal
key transparency, gossiped Merkle roots) are disproportionate here. Documented
as a non-goal; revisit only if a multi-user tier appears.

---

## 5. Storage contract — the self-hosting story

Publish this, don't build a server for it. Obsidian never shipped self-hosted
sync; it got [a whole ecosystem of it](https://www.obsidianstats.com/plugins/obsidian-livesync)
for free because the vault was just files. Same play: define the contract so
thinly that infrastructure people already run satisfies it.

```
GET  {base}/{vaultId}/current     → 200 blob + ETag | 404
PUT  {base}/{vaultId}/current     If-Match: <etag>     → 200 | 412
                                  If-None-Match: *     → 201 | 412 (create)
```

Two operations. Compare-and-swap comes from standard HTTP preconditions, so
every one of these works today with no custom code:

| Backend | CAS mechanism |
| --- | --- |
| Amazon S3 | [conditional writes, GA Nov 2024](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes) |
| Cloudflare R2 | [If-Match / If-None-Match](https://developers.cloudflare.com/r2/api/s3/extensions/) |
| MinIO / SeaweedFS | S3-compatible conditionals |
| WebDAV / Nextcloud | HTTP ETags natively |
| badgr managed | same contract, nothing special |

Optional write-once history at `{base}/{vaultId}/history/{seq}` enables
point-in-time restore; it is a convenience, not a correctness requirement.

---

## 6. Client integration

### 6.1 Mobile

`@noble/ciphers` + `@noble/hashes` — audited, zero-dependency, no `node:`
imports, Metro-safe, already validated (`docs/ideas/portable-sync.md`).

Key storage: **`expo-secure-store`** (new dependency) → iOS Keychain / Android
Keystore. Set `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Explicitly **do not** allow
iCloud Keychain sync — the key must not escape into a cloud outside the
threat model.

CSPRNG: `expo-crypto.getRandomBytesAsync`. Already a dependency. Confirm on a
real device (Gate 1) — it could not be verified in the spike sandbox.

### 6.2 Web

Use **native WebCrypto**, not noble — for one specific reason: WebCrypto can
hold a `CryptoKey` marked **non-extractable**, persisted in IndexedDB. Injected
script can then *use* the key but **cannot read its bytes out**. Against A5 that
is the difference between "attacker exfiltrates your vault key forever" and
"attacker abuses this one session." Raw noble key bytes sitting in JS memory
offer no such containment.

This split is safe precisely because the spike proved byte-identical KDF output
and bidirectional AES-GCM interop between noble and WebCrypto.

Supporting controls: strict CSP with no `unsafe-inline`, SRI on all bundles,
`Trusted Types` where supported.

### 6.3 Managed service auth

**No password.** Each device generates an Ed25519 keypair in hardware-backed
storage and authenticates by signing a server challenge, exchanged for a
short-lived (≤15 min) bearer token. New devices enrol by scanning a QR from an
already-trusted device, which signs the attestation. Tailscale's model.

This satisfies I2 structurally: there is no account password anywhere, so no
password-derived value can be confused with, or leak information about, the
encryption key.

Server schema, in full:

```
account(id, created_at)
device (id, account_id, ed25519_pubkey, label, created_at, revoked_at)
vault  (id, account_id, etag, seq, size_bytes, updated_at)
blob   (vault_id, bytes)          -- opaque ciphertext
audit  (vault_id, device_id, seq, at)   -- user-visible write log
```

There is deliberately no column that could hold a key, a password, a hash of
one, or plaintext (I6). Enforce it with a schema test in CI so a future
migration cannot quietly add one.

Abuse controls: per-account rate limits, hard max blob size (5 MB, ~1600× real
usage), storage quota, random 128-bit `vaultId` so enumeration is useless, and
ownership checks on every request.

---

## 7. Recovery, rotation, revocation

- **Passphrase change:** re-wrap `dataKey` under the new KEK, bump `seq`, PUT.
  No bulk re-encryption.
- **Forgotten passphrase:** unrecoverable. Say it at setup, require explicit
  acknowledgement, and offer a printable recovery sheet containing the
  base64 `dataKey` — the only supported backup. Obsidian's warning is the
  wording to imitate.
- **Device revocation:** delete the device row (blocks auth) **and** rotate
  `dataKey` with re-encryption, because a revoked device already knows the old
  key. Revocation without rotation is theatre; ship both or neither.

---

## 8. Phases and gates

Each gate is blocking. No phase starts until the prior gate is signed off.

**Phase 0 — Spec freeze.** Threat model reviewed, envelope byte layout final,
test vectors generated and committed.
*Gate: a second reader can implement a decoder from the spec alone.*

**Phase 1 — KDF feasibility. The plan's pivot point.**
Benchmark the §3.2 ladder on a reference low-end Android (4 GB RAM, ~2020) and
a mid-tier iPhone. Confirm `expo-crypto` CSPRNG on-device.
*Gate: unlock ≤3 s, peak RSS ≤200 MB, zero OOM across 100 runs. If rung 1
fails, descend the ladder and record the deviation publicly.*
*If all four rungs fail, stop — the design needs native crypto and a
dev-client build, which is a different project.*

**Phase 2 — `@alarmed/crypto`.** Pure package: envelope encode/decode, key
hierarchy, canonical serialisation. No I/O, no platform APIs.
*Gate: test vectors pass under both noble and WebCrypto; property tests green.*

**Phase 3 — Offline file sync.** Share-sheet export/import wired to
`reconcileTasks`. No network at all. Ships real user value alone.
*Gate: round-trip across web ↔ mobile on physical devices; rollback rejected.*

**Phase 4 — Storage adapters.** S3 and WebDAV against the §5 contract.
*Gate: CAS conflicts verified against MinIO **and** real R2 — including a
forced concurrent-write 412 and its retry.*

**Phase 5 — Managed service.** Device-key auth, quotas, audit log.
*Gate: schema test proves I6; external pen test of the auth path; verify a
full-database dump yields nothing but ciphertext.*

**Phase 6 — Assurance.** Publish the spec and threat model, reproducible builds
with published hashes, then a third-party audit (Cure53 and Trail of Bits are
the firms with track records here).
*Gate: audit findings resolved before any "end-to-end encrypted" marketing
claim ships. Do not make the claim first and audit later.*

---

## 9. Test strategy

- **Test vectors.** Fixed passphrase/salt/nonce → expected ciphertext hex,
  committed. Any unintended format change breaks CI.
- **Cross-implementation.** noble-encrypt → WebCrypto-decrypt and the reverse,
  on every commit. Already proven once; now enforced.
- **Property tests.** Round-trip fidelity; every single-bit mutation fails auth;
  wrong passphrase never yields plaintext.
- **Rollback test.** Serve blob `seq=N-1` after accepting `seq=N` → must reject
  and raise a security warning.
- **Concurrency test.** Two clients race a write; exactly one wins, the loser
  retries and converges. Assert no lost update.
- **Parser fuzzing.** Malformed and truncated headers must fail closed, never
  panic, never read out of bounds.
- **Leak test.** Grep built bundles and log output for key material; assert
  crash reporters scrub the vault fields.

---

## 10. Operational security

- Secrets never in the repo; managed-service keys in a KMS.
- Reproducible web builds with published SRI hashes so a user can verify the
  served bundle matches the audited source. Without this, E2E on the web is a
  promise about a script you control and can silently change.
- `security.txt`, a published disclosure policy, and a stated response SLA.
- Incident plan written **before** launch: what you say, how fast, and to whom.
- Dependency pinning with lockfile audit in CI; `@noble/*` upgrades reviewed by
  hand, never auto-merged by Dependabot.

---

## 11. Open decisions

1. **Snapshot vs. op-log.** This plan specifies snapshots + LWW, matching
   existing `reconcileTasks`. An op-log (Yjs — pure JS, unlike WASM-based
   Automerge) buys field-level merges and delta sync. Expensive to retrofit;
   decide before Phase 2, not after.
2. **Managed pricing** must exceed storage + egress + support at low volume, or
   the free tier is subsidised by nothing.
3. **Recovery-sheet UX** — the highest-risk usability surface. Users who lose
   passphrases with no recourse leave angry reviews regardless of correctness.

---

## 12. Prior art

| Project | What to take |
| --- | --- |
| [Bitwarden](https://bitwarden.com/help/bitwarden-security-white-paper/) | Self-host + managed + E2E; their whitepaper is the format to imitate |
| Standard Notes | Open server spec; self-hosting as a first-class path |
| [Obsidian Sync](https://obsidianmd.github.io/sync/security) | scrypt → HKDF → AES-256-GCM; blunt no-recovery warning |
| Cryptomator | E2E layered over a user's own cloud drive — the self-hosted tier, essentially |
| restic / borg | Wrapped data keys, AAD discipline, chunk formats |
| Tailscale | Device-keypair auth with no account password |
| age | Small, versioned, armored envelope design |
| Syncthing | Conflict handling and P2P without a central authority |
