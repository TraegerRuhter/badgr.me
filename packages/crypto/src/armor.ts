/**
 * Armored transport form (build plan §3.3).
 *
 *   badgr-sync/1\n
 *   <base64url of the BDGR1 blob, wrapped at 76 columns>
 *
 * This is a transport wrapper, not part of the on-disk envelope: it changes no
 * authenticated byte, so it is outside FORMAT_VERSION and the committed test
 * vectors. It exists because a share sheet may hand the payload to Mail,
 * Messages, or a notes app, and every one of those is free to mangle raw bytes.
 * base64url (no padding) additionally survives being pasted into a URL.
 *
 * Integrity is *not* this layer's job. A corrupted armor body decodes to
 * garbage that then fails GCM authentication loudly, which is the guarantee
 * that actually matters (I3). No checksum is added, because a checksum here
 * would only invite someone to trust it.
 */

export const ARMOR_LABEL = "badgr-sync/1";

/** RFC 4648 §5 alphabet — URL- and filename-safe. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const DECODE = /* @__PURE__ */ (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

const WRAP_COLUMNS = 76;

export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += ALPHABET[c & 0x3f];
  }
  return out;
}

export function base64UrlDecode(text: string): Uint8Array {
  // Tolerate the whitespace that line wrapping and copy/paste introduce, but
  // nothing else — an unexpected character is a corrupt payload, not something
  // to silently skip past.
  const clean = text.replace(/[\s]/g, "");
  if (clean.length % 4 === 1) throw new Error("Armored payload has a truncated final group");

  const outLength = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(outLength);
  let written = 0;
  let acc = 0;
  let bits = 0;

  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? DECODE[code] : -1;
    if (value < 0) throw new Error("Armored payload contains a non-base64url character");
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, written);
}

/** Wraps a sealed blob for share-sheet, email, or clipboard transport. */
export function armor(blob: Uint8Array): string {
  const body = base64UrlEncode(blob);
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += WRAP_COLUMNS) {
    lines.push(body.slice(i, i + WRAP_COLUMNS));
  }
  return `${ARMOR_LABEL}\n${lines.join("\n")}\n`;
}

/**
 * Recovers the blob from armored text. Throws on anything that isn't a badgr
 * envelope — including a plain file the user picked by mistake, which is the
 * common case and deserves a message that says so.
 */
export function dearmor(text: string): Uint8Array {
  const trimmed = text.trim();
  const newline = trimmed.indexOf("\n");
  const label = (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim();
  if (label !== ARMOR_LABEL) {
    throw new Error(`Not a badgr sync file (expected a "${ARMOR_LABEL}" header)`);
  }
  if (newline === -1) throw new Error("Armored envelope has a header but no body");
  return base64UrlDecode(trimmed.slice(newline + 1));
}

/** True if `text` looks armored, for callers choosing between armored and raw input. */
export function isArmored(text: string): boolean {
  return text.trimStart().startsWith(ARMOR_LABEL);
}
