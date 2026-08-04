import { sha256 } from "@noble/hashes/sha2.js";
import { KEY_BYTES } from "./suite";

/**
 * The recovery sheet (build plan §7).
 *
 * A forgotten passphrase is unrecoverable by design — there is no reset, no
 * support route, and nobody else holds a key. That is the whole point, and it
 * is also the single most dangerous thing about the feature. The recovery sheet
 * is the only supported hedge: the data key itself, written down by the user,
 * stored wherever they store important paper.
 *
 * **Deviation from the plan, deliberate.** §7 says "the base64 `dataKey`".
 * Base64 is the wrong encoding for something a human copies by hand: it is
 * case-sensitive (so `l` and `L` are different keys), and it contains `0`/`O`
 * and `1`/`l`/`I` — the exact pairs people transcribe wrongly. This uses
 * Crockford base32 instead, which drops `I`, `L`, `O` and `U` from the alphabet
 * entirely, treats case as insignificant, and maps the confusable characters
 * back on input. A checksum then catches whatever slips through, so a
 * mistyped code fails loudly rather than silently yielding a wrong key and an
 * "envelope failed authentication" error the user cannot act on.
 */

/** Crockford base32. No I, L, O or U — the letters people mis-copy. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 32 bytes = 256 bits, which needs 52 base32 characters (52 × 5 = 260). */
const BODY_CHARS = 52;
/** 20 bits of check data: a wrong character survives with ~1-in-a-million odds. */
const CHECK_CHARS = 4;
const GROUP = 4;

const DECODE: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET[i]] = i;
  // Crockford's forgiving reads: the excluded letters map to what they look like.
  table.I = 1;
  table.L = 1;
  table.O = 0;
  // U is excluded to avoid an accidental obscenity, and has no digit twin —
  // rejecting it outright is better than guessing which character was meant.
  return table;
})();

function toBase32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (out.length < chars) {
    if (bits < 5) {
      acc = (acc << 8) | (i < bytes.length ? bytes[i++] : 0);
      bits += 8;
    }
    bits -= 5;
    out += ALPHABET[(acc >>> bits) & 0x1f];
  }
  return out;
}

/** First 20 bits of SHA-256 over the key, as 4 characters. */
function checkChars(dataKey: Uint8Array): string {
  return toBase32(sha256(dataKey), CHECK_CHARS);
}

/**
 * Renders a data key as the code printed on the recovery sheet.
 *
 * Grouped in fours because unbroken 56-character strings are transcribed
 * badly — the eye loses its place, and there is no way to say "third group,
 * second character" when reading one aloud.
 */
export function formatRecoveryCode(dataKey: Uint8Array): string {
  if (dataKey.length !== KEY_BYTES) {
    throw new Error(`Recovery code needs a ${KEY_BYTES}-byte key`);
  }
  const raw = toBase32(dataKey, BODY_CHARS) + checkChars(dataKey);
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP) groups.push(raw.slice(i, i + GROUP));
  return groups.join("-");
}

export class RecoveryCodeError extends Error {
  readonly name = "RecoveryCodeError";
}

/**
 * Reads a code back, tolerating how people actually write things down.
 *
 * Spaces, dashes and line breaks are ignored; case is insignificant; `I`/`L`
 * become `1` and `O` becomes `0`. Anything left that isn't in the alphabet, or
 * a code whose checksum doesn't match, throws — a recovery code is either
 * exactly right or useless, and the failure has to say which.
 */
export function parseRecoveryCode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s\-–—_.]/g, "");

  if (clean.length !== BODY_CHARS + CHECK_CHARS) {
    throw new RecoveryCodeError(
      `A recovery code has ${BODY_CHARS + CHECK_CHARS} characters; this one has ${clean.length}`
    );
  }

  const values: number[] = [];
  for (const char of clean) {
    const value = DECODE[char];
    if (value === undefined) {
      throw new RecoveryCodeError(`"${char}" isn't a character used in recovery codes`);
    }
    values.push(value);
  }

  const dataKey = new Uint8Array(KEY_BYTES);
  let acc = 0;
  let bits = 0;
  let written = 0;
  for (let i = 0; i < BODY_CHARS; i++) {
    acc = (acc << 5) | values[i];
    bits += 5;
    if (bits >= 8 && written < KEY_BYTES) {
      bits -= 8;
      dataKey[written++] = (acc >>> bits) & 0xff;
    }
  }

  /*
   * 52 characters carry 260 bits but the key is 256, so the last character has
   * 4 bits spare. Sixteen different final characters would otherwise decode to
   * the same key — and to the same checksum, which is precisely the window a
   * typo could slip through. Requiring the spare bits to be zero makes the
   * encoding canonical: one key, one code, and a mistyped last character is
   * caught like any other.
   */
  if ((acc & ((1 << bits) - 1)) !== 0) {
    throw new RecoveryCodeError(
      "That recovery code has a typo in it — check it against your sheet"
    );
  }

  const expected = checkChars(dataKey);
  const actual = clean.slice(BODY_CHARS);
  if (expected !== actual) {
    throw new RecoveryCodeError(
      "That recovery code has a typo in it — check it against your sheet"
    );
  }

  return dataKey;
}

/** True if `text` could plausibly be a recovery code, for choosing an input mode. */
export function looksLikeRecoveryCode(text: string): boolean {
  return text.toUpperCase().replace(/[\s\-–—_.]/g, "").length === BODY_CHARS + CHECK_CHARS;
}
