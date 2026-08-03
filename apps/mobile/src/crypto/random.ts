import * as Crypto from "expo-crypto";
import type { AsyncRandomSource, RandomSource } from "@alarmed/crypto";

/**
 * The device CSPRNG, wired into the `RandomSource` seam (build plan §6.1).
 *
 * `getRandomBytesAsync` rather than the synchronous `getRandomValues`: the
 * async form is the one Expo backs with the platform CSPRNG on every target,
 * and a weak nonce under AES-GCM is a silent, catastrophic failure — it leaks
 * the XOR of two plaintexts and enables forgery, with nothing visibly wrong.
 * Paying for asynchrony is cheap insurance against that.
 */
export const expoRandomAsync: AsyncRandomSource = (byteLength) =>
  Crypto.getRandomBytesAsync(byteLength);

/**
 * A synchronous source drawn from a pre-fetched pool.
 *
 * `createVault` is synchronous — it has to be, because the Argon2id derivation
 * at its centre is — so it cannot await the device CSPRNG mid-call. Drawing the
 * entropy up front keeps the one strong source without pretending a blocking
 * random API exists.
 *
 * Deliberately fails closed: running the pool dry throws rather than wrapping
 * around or falling back to `Math.random`, so a mis-sized pool surfaces as a
 * loud error at vault creation instead of a quietly predictable key.
 */
export async function drawEntropyPool(poolBytes = 256): Promise<RandomSource> {
  const pool = await Crypto.getRandomBytesAsync(poolBytes);
  let offset = 0;

  return (byteLength) => {
    if (offset + byteLength > pool.length) {
      throw new Error(
        `Entropy pool exhausted (${byteLength} more bytes needed); enlarge it rather than reusing bytes`
      );
    }
    const out = pool.slice(offset, offset + byteLength);
    offset += byteLength;
    return out;
  };
}
