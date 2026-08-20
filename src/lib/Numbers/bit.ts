/**
 * Faithful port of bit.js, now that the real source is available —
 * replaces the earlier inferred reimplementation.
 *
 * One bug found and fixed (not preserved): sll()/srl()'s minimum-amount
 * validation (bit$InvalidMin) constructed an ArgumentError but never threw
 * it — identical shape to the swallowed-throw bug already found and fixed
 * in int32.js's own sll/srl. Given it appears in both files with the same
 * exact pattern, this looks like a copy-paste-propagated mistake rather
 * than two independent bugs.
 *
 * get()'s `idx` counts from the LSB end (the back of the array) — this
 * matches the original author's own self-note exactly, and turned out to
 * make mem.js's getByte() correct rather than buggy (see mem.ts's port
 * notes for the full trace).
 */
import { ArgumentError } from "./err";

export type Bits = (0 | 1)[];

const BASE = 2;

function invalidMin(op: string, val: number, min: number) {
  return new ArgumentError(`Invalid argument ${val} expected in range ${min} <= val`, op, [val]);
}
function invalidArgument(op: string, bits: unknown[], idx: number) {
  return new ArgumentError(`Invalid argument in ${op} expected bit-array but found ${bits[idx]} at index ${idx}`, op, [bits]);
}
function mismatchLength(op: string, exp: number, bits: Bits) {
  return new ArgumentError(`Mismatch length ${bits.length} in ${op} expected length is ${exp}`, op, [bits]);
}

function checkArgs(op: string, args: Bits[]) {
  const len = args[0].length;
  for (const a of args) {
    if (a.length !== len) throw mismatchLength(op, len, a);
    for (let j = 0; j < a.length; j++) {
      if (a[j] !== 0 && a[j] !== 1) throw invalidArgument(op, a, j);
    }
  }
}

function zero(len: number): Bits {
  return new Array(len).fill(0) as Bits;
}

export function inv(bits: Bits): Bits {
  checkArgs("bit.inv", [bits]);
  return bits.map((b) => ((b + 1) % BASE) as 0 | 1);
}
export function and(l: Bits, r: Bits): Bits {
  checkArgs("bit.and", [l, r]);
  return l.map((b, i) => (b & r[i]) as 0 | 1);
}
export function or(l: Bits, r: Bits): Bits {
  checkArgs("bit.or", [l, r]);
  return l.map((b, i) => (b | r[i]) as 0 | 1);
}
export function xor(l: Bits, r: Bits): Bits {
  checkArgs("bit.xor", [l, r]);
  return l.map((b, i) => (b ^ r[i]) as 0 | 1);
}
export function nor(l: Bits, r: Bits): Bits {
  checkArgs("bit.nor", [l, r]);
  return l.map((b, i) => (((b | r[i]) + 1) % BASE) as 0 | 1);
}
export function nand(l: Bits, r: Bits): Bits {
  checkArgs("bit.nand", [l, r]);
  return l.map((b, i) => (((b & r[i]) + 1) % BASE) as 0 | 1);
}

export function sll(bits: Bits, amt: number): Bits {
  checkArgs("bit.sll", [bits]);
  if (amt < 0) throw invalidMin("bit.sll", amt, 0); // FIX: was built, never thrown
  const len = bits.length;
  if (len <= amt) return zero(len);
  return [...bits.slice(amt), ...new Array(amt).fill(0)] as Bits;
}
export function srl(bits: Bits, amt: number): Bits {
  checkArgs("bit.srl", [bits]);
  if (amt < 0) throw invalidMin("bit.srl", amt, 0); // FIX: same as sll
  const len = bits.length;
  if (len <= amt) return zero(len);
  return [...new Array(amt).fill(0), ...bits.slice(0, len - amt)] as Bits;
}

export function cll(bits: Bits, amt: number): Bits {
  checkArgs("bit.cll", [bits]);
  if (amt < 0) throw invalidMin("bit.cll", amt, 0);
  const len = bits.length;
  const a = amt % len;
  return [...bits.slice(a), ...bits.slice(0, a)] as Bits;
}
export function crl(bits: Bits, amt: number): Bits {
  checkArgs("bit.crl", [bits]);
  if (amt < 0) throw invalidMin("bit.crl", amt, 0);
  const len = bits.length;
  const a = amt % len;
  return [...bits.slice(len - a), ...bits.slice(0, len - a)] as Bits;
}

export function ext(bits: Bits, len = 32): Bits {
  checkArgs("bit.ext", [bits]);
  const res = bits.slice();
  while (res.length < len) res.unshift(0);
  return res.slice(-len) as Bits;
}
/** Sign-extends: pads with copies of the actual MSB, not always 0. */
export function sign(bits: Bits, len = 32): Bits {
  checkArgs("bit.sign", [bits]);
  const res = bits.slice();
  const msb = res[0];
  while (res.length < len) res.unshift(msb);
  return res.slice(-len) as Bits;
}

export function eq(l: Bits, r: Bits): boolean {
  checkArgs("bit.eq", [l, r]);
  return l.every((b, i) => b === r[i]);
}
export function ne(l: Bits, r: Bits): boolean {
  checkArgs("bit.ne", [l, r]);
  return !eq(l, r);
}

/** idx counts from the LSB end (the back of the array) — get(bits, 8, 4)
 * means "4 bits ending 8 bits from the right." */
export function get(bits: Bits, idx: number, len = 1): Bits {
  const eIdx = Math.max(0, bits.length - idx);
  const sIdx = Math.max(0, eIdx - len);
  return bits.slice(sIdx, eIdx) as Bits;
}