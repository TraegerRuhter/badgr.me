import { gcm } from "@noble/ciphers/aes.js";
import type { Task } from "@alarmed/core";
import { gunzipSync, gzipSync } from "fflate";
import { canonicalNdjson, parseNdjson } from "./canonical";
import { frame, unframe } from "./framing";
import { deriveKek, deriveMasterKey, unwrapDataKey, wrapDataKey } from "./keys";
import { webCryptoRandom, type RandomSource } from "./random";
import {
  DEFAULT_KDF,
  FORMAT_VERSION,
  HEADER_BYTES,
  KEY_BYTES,
  MAGIC,
  NONCE_BYTES,
  OFF,
  SALT_BYTES,
  SUITE_ARGON2ID,
  SUITE_SCRYPT,
  VAULT_ID_BYTES,
  WRAPPED_KEY_BYTES,
  type KdfParams,
} from "./suite";

/** Everything needed to seal or open, once the passphrase has been spent. */
export interface VaultKeys {
  readonly vaultId: Uint8Array;
  readonly kdfSalt: Uint8Array;
  readonly kdf: KdfParams;
  readonly wrapNonce: Uint8Array;
  readonly wrappedDataKey: Uint8Array;
  /** Cache this in the OS keystore; never write it to ordinary app storage. */
  readonly dataKey: Uint8Array;
}

export interface EnvelopeHeader {
  readonly version: number;
  readonly kdf: KdfParams;
  readonly vaultId: Uint8Array;
  readonly kdfSalt: Uint8Array;
  readonly wrapNonce: Uint8Array;
  readonly wrappedDataKey: Uint8Array;
  readonly seq: bigint;
  readonly payloadNonce: Uint8Array;
}

function encodeKdfParams(kdf: KdfParams, into: Uint8Array, at: number): void {
  const view = new DataView(into.buffer, into.byteOffset, into.byteLength);
  if (kdf.suite === SUITE_ARGON2ID) {
    view.setUint32(at, kdf.m, false);
    into[at + 4] = kdf.t;
    into[at + 5] = kdf.p;
    return;
  }
  into[at] = kdf.logN;
  into[at + 1] = kdf.r;
  into[at + 2] = kdf.p;
  into.fill(0, at + 3, at + 6);
}

function decodeKdfParams(suite: number, bytes: Uint8Array, at: number): KdfParams {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (suite === SUITE_ARGON2ID) {
    return { suite: SUITE_ARGON2ID, m: view.getUint32(at, false), t: bytes[at + 4], p: bytes[at + 5] };
  }
  if (suite === SUITE_SCRYPT) {
    return { suite: SUITE_SCRYPT, logN: bytes[at], r: bytes[at + 1], p: bytes[at + 2] };
  }
  throw new Error(`Unsupported cipher suite ${suite}`);
}

export function encodeHeader(h: EnvelopeHeader): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  out.set(MAGIC, OFF.magic);
  out[OFF.version] = h.version;
  out[OFF.suite] = h.kdf.suite;
  encodeKdfParams(h.kdf, out, OFF.kdfParams);
  out.set(h.vaultId, OFF.vaultId);
  out.set(h.kdfSalt, OFF.kdfSalt);
  out.set(h.wrapNonce, OFF.wrapNonce);
  out.set(h.wrappedDataKey, OFF.wrappedDataKey);
  new DataView(out.buffer).setBigUint64(OFF.seq, h.seq, false);
  out.set(h.payloadNonce, OFF.payloadNonce);
  return out;
}

export function decodeHeader(blob: Uint8Array): EnvelopeHeader {
  if (blob.length < HEADER_BYTES) throw new Error("Envelope is shorter than its header");
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[OFF.magic + i] !== MAGIC[i]) throw new Error("Not a badgr sync envelope");
  }
  const version = blob[OFF.version];
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported envelope version ${version}`);
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return {
    version,
    kdf: decodeKdfParams(blob[OFF.suite], blob, OFF.kdfParams),
    vaultId: blob.slice(OFF.vaultId, OFF.vaultId + VAULT_ID_BYTES),
    kdfSalt: blob.slice(OFF.kdfSalt, OFF.kdfSalt + SALT_BYTES),
    wrapNonce: blob.slice(OFF.wrapNonce, OFF.wrapNonce + NONCE_BYTES),
    wrappedDataKey: blob.slice(OFF.wrappedDataKey, OFF.wrappedDataKey + WRAPPED_KEY_BYTES),
    seq: view.getBigUint64(OFF.seq, false),
    payloadNonce: blob.slice(OFF.payloadNonce, OFF.payloadNonce + NONCE_BYTES),
  };
}

/**
 * Reads the sequence number without decrypting.
 *
 * Safe to use for the cheap rollback pre-check (build plan §4.3) because the
 * only thing an attacker gains by lowering it is a rejection. The authoritative
 * check is decryption itself: seq is inside the AAD, so a tampered value fails
 * authentication.
 */
export function peekSeq(blob: Uint8Array): bigint {
  return decodeHeader(blob).seq;
}

export interface CreateVaultOptions {
  readonly kdf?: KdfParams;
  readonly random?: RandomSource;
}

/** Generates a brand new vault: fresh id, salt, and data key. */
export function createVault(passphrase: string, opts: CreateVaultOptions = {}): VaultKeys {
  const random = opts.random ?? webCryptoRandom;
  const kdf = opts.kdf ?? DEFAULT_KDF;
  const vaultId = random(VAULT_ID_BYTES);
  const kdfSalt = random(SALT_BYTES);
  const wrapNonce = random(NONCE_BYTES);
  const dataKey = random(KEY_BYTES);

  const kek = deriveKek(deriveMasterKey(passphrase, kdfSalt, kdf), kdfSalt);
  return {
    vaultId,
    kdfSalt,
    kdf,
    wrapNonce,
    wrappedDataKey: wrapDataKey(kek, wrapNonce, dataKey, vaultId),
    dataKey,
  };
}

/**
 * Spends the passphrase to recover the data key from an existing envelope.
 * This is the expensive call — do it once per unlock and cache the result.
 */
export function unlockVault(passphrase: string, blob: Uint8Array): VaultKeys {
  const h = decodeHeader(blob);
  const kek = deriveKek(deriveMasterKey(passphrase, h.kdfSalt, h.kdf), h.kdfSalt);
  let dataKey: Uint8Array;
  try {
    dataKey = unwrapDataKey(kek, h.wrapNonce, h.wrappedDataKey, h.vaultId);
  } catch {
    throw new Error("Wrong passphrase, or the vault header has been tampered with");
  }
  return {
    vaultId: h.vaultId,
    kdfSalt: h.kdfSalt,
    kdf: h.kdf,
    wrapNonce: h.wrapNonce,
    wrappedDataKey: h.wrappedDataKey,
    dataKey,
  };
}

/**
 * Encrypts a task snapshot at a given sequence number.
 *
 * `seq` must be strictly greater than any previously sealed value for this
 * vault; the caller owns that counter because only the caller knows what it has
 * already published. See build plan §4.2.
 */
export function seal(
  vault: VaultKeys,
  tasks: readonly Task[],
  seq: bigint,
  random: RandomSource = webCryptoRandom
): Uint8Array {
  const header = encodeHeader({
    version: FORMAT_VERSION,
    kdf: vault.kdf,
    vaultId: vault.vaultId,
    kdfSalt: vault.kdfSalt,
    wrapNonce: vault.wrapNonce,
    wrappedDataKey: vault.wrappedDataKey,
    seq,
    payloadNonce: random(NONCE_BYTES),
  });
  const payloadNonce = header.slice(OFF.payloadNonce, OFF.payloadNonce + NONCE_BYTES);

  // mtime: 0 is required, not cosmetic. fflate defaults the gzip MTIME field to
  // Date.now(), which would make sealing non-deterministic and stamp the seal
  // time into the payload.
  const gz = gzipSync(new TextEncoder().encode(canonicalNdjson(tasks)), { mtime: 0 });
  const ciphertext = gcm(vault.dataKey, payloadNonce, header).encrypt(frame(gz));

  const out = new Uint8Array(header.length + ciphertext.length);
  out.set(header, 0);
  out.set(ciphertext, header.length);
  return out;
}

export interface OpenedEnvelope {
  readonly tasks: Task[];
  readonly seq: bigint;
}

/** Decrypts and authenticates. Throws on any tamper; never returns partial data. */
export function openEnvelope(vault: VaultKeys, blob: Uint8Array): OpenedEnvelope {
  const h = decodeHeader(blob);
  const header = blob.slice(0, HEADER_BYTES);
  const ciphertext = blob.slice(HEADER_BYTES);

  let inner: Uint8Array;
  try {
    inner = gcm(vault.dataKey, h.payloadNonce, header).decrypt(ciphertext);
  } catch {
    throw new Error("Envelope failed authentication: wrong key, or it was modified");
  }
  const text = new TextDecoder().decode(gunzipSync(unframe(inner)));
  return { tasks: parseNdjson(text), seq: h.seq };
}
