/**
 * Tiny conversions so assertions can talk in numbers instead of 32-element
 * bit arrays.
 */
import { int32, type Int32Bits } from "../../src/lib/Numbers/int32";

/** Signed 32-bit number -> bits. */
export const n = (x: number): Int32Bits => int32.num(x);

/** Bits -> signed 32-bit number. */
export const num = (b: Int32Bits): number => int32.toNum(b);

/** Bits -> "0x0000002A". */
export const hex = (b: Int32Bits): string => int32.toHex(b);

/** Hex string (with or without 0x) -> bits. */
export const h = (s: string): Int32Bits => int32.hex(s);

/** Bits -> unsigned 32-bit number (handy for values with the top bit set). */
export const u32 = (b: Int32Bits): number => int32.toNum(b) >>> 0;

/** An arbitrary-length bit array from a "0101" string (MSB first). */
export const bits = (s: string): (0 | 1)[] => s.split("").map((c) => (c === "1" ? 1 : 0));
