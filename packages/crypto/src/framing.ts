import { PAD_BLOCK } from "./suite";

/**
 * Inner framing: `u32be(payloadLength) ‖ payload ‖ zeroPad`, padded to a
 * multiple of PAD_BLOCK, then encrypted as a unit.
 *
 * The length lives INSIDE the ciphertext, deliberately. Putting a padded-length
 * field in the cleartext header would reveal the exact plaintext size and
 * defeat the padding entirely — so if you are ever tempted to "simplify" this
 * by hoisting the length into the header, don't.
 */
export function frame(payload: Uint8Array, block: number = PAD_BLOCK): Uint8Array {
  if (block <= 0) throw new Error("Pad block must be positive");
  const total = Math.ceil((4 + payload.length) / block) * block;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

export function unframe(inner: Uint8Array): Uint8Array {
  if (inner.length < 4) throw new Error("Framed payload is truncated");
  const length = new DataView(inner.buffer, inner.byteOffset, inner.byteLength).getUint32(0, false);
  if (4 + length > inner.length) {
    throw new Error("Framed payload declares a length beyond its bounds");
  }
  return inner.slice(4, 4 + length);
}
