// GEN BY CLAUD, HAVENT LOOKED THROUGH AT ALL.
/**
 * Faithful port of int32.js, now that the real source is available —
 * replaces the earlier from-scratch reimplementation. Delegates to bit.ts
 * for raw bitwise ops, exactly as the original delegated to bit.js.
 *
 * Two bugs found in the original, fixed here (not preserved):
 *
 * 1. oct() indexed into the wrong lookup table. It validated input against
 *    the OCT charset ("01234567") but then looked up positions in DEC
 *    ("-+0123456789") and read from _DEC — a 3-bit table sized for indices
 *    0-7. Since '0'-'5' land at DEC-index 2-7 (valid but WRONG binary
 *    values — off by 2) and '6'-'7' land at DEC-index 8-9 (out of bounds,
 *    so `_DEC[8]`/`_DEC[9]` is undefined and spreading it throws
 *    TypeError), oct() has never actually worked for any input. Not
 *    exercised anywhere in mips.js/mips-util.js, so it had zero real-world
 *    impact — but it's fixed here rather than ported forward broken.
 *
 * 2. sll()/srl()'s range validation constructed an error object
 *    (`int32$InvalidRange(...)`) but never called `throw` on it — the
 *    check was completely inert; any shift amount, valid or not, passed
 *    straight through. Fixed by actually throwing.
 */
import * as bit from "./bit";
import type { Bits } from "./bit";
import { ArgumentError } from "./err";
 
export type Int32Bits = Bits;
 
const LEN = 32;
const POW = 4294967296; // 2**32
const MAX = 2147483647; // 2**31 - 1
const MIN = -2147483648; // -2**31
const BIN = "01";
const OCT = "01234567";
const DEC = "-+0123456789";
const HEX = "0123456789ABCDEF";
 
const _OCT: Bits[] = [
  [0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1],
  [1, 0, 0], [1, 0, 1], [1, 1, 0], [1, 1, 1],
];
const _HEX: Bits[] = [
  [0, 0, 0, 0], [0, 0, 0, 1], [0, 0, 1, 0], [0, 0, 1, 1],
  [0, 1, 0, 0], [0, 1, 0, 1], [0, 1, 1, 0], [0, 1, 1, 1],
  [1, 0, 0, 0], [1, 0, 0, 1], [1, 0, 1, 0], [1, 0, 1, 1],
  [1, 1, 0, 0], [1, 1, 0, 1], [1, 1, 1, 0], [1, 1, 1, 1],
];
const ONE: Bits = [...new Array(31).fill(0), 1] as Bits;
const ZERO: Bits = new Array(32).fill(0) as Bits;
 
// ---- Errors -------------------------------------------------------------
 
function invalidRange(op: string, val: number, min: number, max: number) {
  return new ArgumentError(`Invalid range for ${val} expected in the range of [${min},${max}]`, op, [val]);
}
function invalidInt(op: string, val: unknown) {
  return new ArgumentError(`Invalid type for ${val} expected integer`, op, [val]);
}
function invalidBase(op: string, val: string, idx: number, base: string) {
  return new ArgumentError(`Invalid character for ${val} expected base ${base} but found ${val[idx]} at index ${idx}`, op, [val, idx]);
}
function invalidLength(op: string, val: string, len: number) {
  return new ArgumentError(`Invalid length for ${val} expected ${len} but found ${val.length}`, op, [val]);
}
function invalidArgument(op: string, bits: unknown[], idx: number) {
  return new ArgumentError(`Invalid argument in ${op} expected bit-array but found ${bits[idx]} at index ${idx}`, op, [bits]);
}
function mismatchLength(op: string, exp: number, bits: Bits) {
  return new ArgumentError(`Mismatch length ${bits.length} in ${op} expected length is ${exp}`, op, [bits]);
}
 
// ---- Checkers -------------------------------------------------------------
 
function checkRange(op: string, val: number, min: number, max: number) {
  if (val < min || val > max) throw invalidRange(op, val, min, max);
}
function checkInt(op: string, val: number) {
  if (Number.isNaN(val)) throw invalidInt(op, val);
  const x = parseFloat(String(val));
  if ((0 | x) !== x) throw invalidInt(op, val);
}
function checkBase(op: string, str: string, base: string, len: number) {
  for (let i = 0; i < str.length; i++) {
    if (base.indexOf(str[i]) < 0) throw invalidBase(op, str, i, base);
  }
  if (str.length > len) throw invalidLength(op, str, len);
}
function checkArgs(op: string, args: Bits[]) {
  for (const a of args) {
    if (a.length !== LEN) throw mismatchLength(op, LEN, a);
    for (let j = 0; j < a.length; j++) {
      if (a[j] !== 0 && a[j] !== 1) throw invalidArgument(op, a, j);
    }
  }
}
 
// ---- Converters: FROM -----------------------------------------------------
 
function num(n: number): Bits {
  checkInt("int32.num", n);
  checkRange("int32.num", n, MIN, MAX);
  let v = n < 0 ? POW + n : +n;
  if (v === 0) return ZERO.slice() as Bits;
  const res: number[] = [];
  while (v > 0) {
    res.unshift(v % 2);
    v = (v - res[0]) / 2;
  }
  return bit.ext(res as Bits, LEN);
}
function binFn(str: string): Bits {
  checkBase("int32.bin", str, BIN, LEN);
  const res = str.split("").map((c) => parseInt(c, 10)) as Bits;
  return bit.ext(res, LEN);
}
function octFn(str: string): Bits {
  checkBase("int32.oct", str, OCT, Math.ceil(LEN / 3));
  const res: number[] = [];
  for (const ch of str) res.push(..._OCT[OCT.indexOf(ch)]); // FIX: was indexing DEC/_DEC
  return bit.ext(res as Bits, LEN);
}
function decFn(str: string): Bits {
  checkBase("int32.dec", str, DEC, MAX.toString().length);
  return num(parseInt(str, 10));
}
function hexFn(str: string): Bits {
  str = str.toUpperCase();
  // FIX: toHex() (below) displays values with a "0x" prefix, but this
  // rejected that same prefix on the way back in — str.toUpperCase()
  // turns "0x..." into "0X...", and checkBase's HEX charset
  // ("0123456789ABCDEF") has no "X", so re-submitting exactly what was
  // displayed always threw ("...found X at index 1"), while a bare hex
  // string like "0000000A" worked fine. Strip an optional "0x"/"0X"
  // prefix before validating so both forms are accepted.
  if (str.startsWith("0X")) str = str.slice(2);
  checkBase("int32.hex", str, HEX, Math.ceil(LEN / 4));
  const res: number[] = [];
  for (const ch of str) res.push(..._HEX[HEX.indexOf(ch)]);
  return bit.ext(res as Bits, LEN);
}
// ---- Converters: TO ---------------------------------------------------
 
function toNum(ints: Bits): number {
  checkArgs("int32.toNum", [ints]);
  let res = 0;
  for (let i = 0; i < LEN; i++) {
    res <<= 1;
    res += ints[i];
  }
  return res;
}
function toHex(ints: Bits): string {
  checkArgs("int32.toHex", [ints]);
  let res = "";
  for (let i = 0; i < LEN; i += 4) {
    res += HEX[8 * ints[i] + 4 * ints[i + 1] + 2 * ints[i + 2] + ints[i + 3]];
  }
  return `0x${res}`;
}
 
// ---- Bitwise operations ------------------------------------------------
 
function inv(ints: Bits): Bits { checkArgs("int32.inv", [ints]); return bit.inv(ints); }
function and(l: Bits, r: Bits): Bits { checkArgs("int32.and", [l, r]); return bit.and(l, r); }
function or(l: Bits, r: Bits): Bits { checkArgs("int32.or", [l, r]); return bit.or(l, r); }
function xor(l: Bits, r: Bits): Bits { checkArgs("int32.xor", [l, r]); return bit.xor(l, r); }
function nor(l: Bits, r: Bits): Bits { checkArgs("int32.nor", [l, r]); return bit.nor(l, r); }
function nand(l: Bits, r: Bits): Bits { checkArgs("int32.nand", [l, r]); return bit.nand(l, r); }
 
// ---- Arithmetic ---------------------------------------------------------
 
function neg(ints: Bits): Bits {
  checkArgs("int32.neg", [ints]);
  return add(inv(ints), ONE);
}
function add(l: Bits, r: Bits): Bits {
  checkArgs("int32.add", [l, r]);
  const res = new Array(32) as Bits;
  let carry: 0 | 1 = 0;
  for (let i = 31; i >= 0; i--) {
    res[i] = (l[i] ^ r[i] ^ carry) as 0 | 1;
    carry = (((l[i] & r[i]) | (r[i] & carry) | (l[i] & carry)) as 0 | 1);
  }
  return res;
}
function sub(l: Bits, r: Bits): Bits {
  checkArgs("int32.sub", [l, r]);
  return add(l, neg(r));
}
function slt(l: Bits, r: Bits): Bits {
  checkArgs("int32.slt", [l, r]);
  return lt(l, r) ? (ONE.slice() as Bits) : (ZERO.slice() as Bits);
}
 
// ---- Predicates ---------------------------------------------------------
 
function eq(l: Bits, r: Bits): boolean { checkArgs("int32.eq", [l, r]); return bit.eq(l, r); }
function ne(l: Bits, r: Bits): boolean { checkArgs("int32.ne", [l, r]); return !eq(l, r); }
function is0(ints: Bits): boolean { checkArgs("int32.is0", [ints]); return eq(ints, ZERO); }
function lt(l: Bits, r: Bits): boolean {
  checkArgs("int32.lt", [l, r]);
  if (l[0] === 1 && r[0] === 0) return true;
  if (l[0] === 0 && r[0] === 1) return false;
  const res = sub(l, r);
  return res[0] === 1;
}
function lte(l: Bits, r: Bits): boolean { checkArgs("int32.lte", [l, r]); return lt(l, r) || eq(l, r); }
function gt(l: Bits, r: Bits): boolean { checkArgs("int32.gt", [l, r]); return !lte(l, r); }
function gte(l: Bits, r: Bits): boolean { checkArgs("int32.gte", [l, r]); return gt(l, r) || eq(l, r); }
 
function lShift(l: Bits, amt: number): Bits {
  checkArgs("int32.sll", [l]);
  checkRange("int32.sll", amt, 0, 31); // FIX: original built this error but never threw it
  return bit.sll(l, amt);
}
function rShift(l: Bits, amt: number): Bits {
  checkArgs("int32.srl", [l]);
  checkRange("int32.srl", amt, 0, 31); // FIX: same as above
  return bit.srl(l, amt);
}
 
export const int32 = {
  num, bin: binFn, oct: octFn, dec: decFn, hex: hexFn,
  toNum, toHex,
  inv, and, or, xor, nor, nand,
  neg, add, sub, slt,
  eq, ne, is0, lt, lte, le: lte, gt, gte, ge: gte,
  sll: lShift, srl: rShift,
};