/**
 * Word/byte addressing helpers shared by useMemoryBank (the real memory)
 * and pipeline.ts (the pipeline's sequential look-ahead, which has to read
 * and write memory with exactly the same semantics and errors, but outside
 * React). Moved here unchanged from useMemoryBank.ts.
 */
import { int32, type Int32Bits } from "../Numbers/int32";
import * as bit from "../Numbers/bit";
import { RuntimeError } from "../Numbers/err";

export function unalignedMem(op: string, addr: number) {
  return new RuntimeError(`Unaligned ${op} operation on address ${addr}`, "mem.ts", [addr]);
}
export function outOfRangeMem(op: string, addr: number) {
  return new RuntimeError(`Address ${addr} is out of range in ${op}`, "mem.ts", [addr]);
}

export function wordIndexOf(addr: number): number {
  return Math.floor(addr / 4);
}
export function byteOffsetOf(addr: number): number {
  return addr - wordIndexOf(addr) * 4;
}

/** Extracts byte `n` (0-3) from a 32-bit word, matching SB's little-endian
 * byte-offset convention (byte 0 = least significant). */
export function getByteBits(word: Int32Bits, n: number): Int32Bits {
  return bit.get(word, n * 8, 8);
}

/** Writes an 8-bit value into byte position `n` (0-3) of a 32-bit word,
 * leaving the other 3 bytes untouched — direct port of the original SB()'s
 * mask/shift logic. */
export function setByteBits(word: Int32Bits, n: number, val: Int32Bits): Int32Bits {
  const shift = 8 * n;
  const byteMask = int32.hex("FF");
  const shifted = bit.sll(int32.and(val, byteMask), shift);
  const clearMask = bit.inv(bit.sll(byteMask, shift));
  return int32.or(int32.and(clearMask, word), shifted);
}