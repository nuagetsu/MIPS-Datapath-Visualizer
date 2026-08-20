/**
 * TS/React port of mem.js, split into state (this hook) + rendering
 * (MemoryTable.tsx), same treatment as reg.js -> useRegisterBank.
 *
 * Two deliberate deviations from the original, per discussion:
 *   1. lb() sign-extends (real MIPS semantics) instead of zero-extending.
 *      The original called bit.ext (zero-extend) where bit.sign
 *      (sign-extend, confirmed to exist in the real bit.js) was clearly
 *      the intended tool — sign() just never got used at its one real
 *      call site.
 */
import { useCallback, useRef, useState } from "react";
import { int32, type Int32Bits } from "../lib/Numbers/int32";
import * as bit from "../lib/Numbers/bit";
import { RuntimeError } from "../lib/Numbers/err";

export type DisplayBase = "hex" | "dec";
export type MarkStatus = "default" | "success" | "warning" | "danger";

export interface MemoryCellDisplay {
  bits: Int32Bits;
  base: DisplayBase;
  mark: MarkStatus;
}

export interface MemoryBank {
  size: number;
  /** Indexed by word number (address / 4), not by byte address. */
  cells: MemoryCellDisplay[];
  addrOf: (wordIndex: number) => number;
  lw: (addr: number) => Int32Bits;
  sw: (addr: number, bits: Int32Bits) => void;
  /** Sign-extended to 32 bits — see file header. */
  lb: (addr: number) => Int32Bits;
  sb: (addr: number, val: Int32Bits) => void;
  ulw: (addr: number) => Int32Bits;
  usw: (addr: number, val: Int32Bits) => void;
  RES: () => void;
  setBase: (wordIndex: number, base: DisplayBase) => void;
  trySave: (wordIndex: number, text: string) => boolean;
}

function unalignedMem(op: string, addr: number) {
  return new RuntimeError(`Unaligned ${op} operation on address ${addr}`, "mem.ts", [addr]);
}
function outOfRangeMem(op: string, addr: number) {
  return new RuntimeError(`Address ${addr} is out of range in ${op}`, "mem.ts", [addr]);
}

function wordIndexOf(addr: number): number {
  return Math.floor(addr / 4);
}
function byteOffsetOf(addr: number): number {
  return addr - wordIndexOf(addr) * 4;
}

/** Extracts byte `n` (0-3) from a 32-bit word, matching SB's little-endian
 * byte-offset convention (byte 0 = least significant). */
function getByteBits(word: Int32Bits, n: number): Int32Bits {
  return bit.get(word, n * 8, 8);
}

/** Writes an 8-bit value into byte position `n` (0-3) of a 32-bit word,
 * leaving the other 3 bytes untouched — direct port of the original SB()'s
 * mask/shift logic. */
function setByteBits(word: Int32Bits, n: number, val: Int32Bits): Int32Bits {
  const shift = 8 * n;
  const byteMask = int32.hex("FF");
  const shifted = bit.sll(int32.and(val, byteMask), shift);
  const clearMask = bit.inv(bit.sll(byteMask, shift));
  return int32.or(int32.and(clearMask, word), shifted);
}

export function useMemoryBank(size = 256): MemoryBank {
  const wordCount = Math.floor(size / 4);
  const bitsRef = useRef<Int32Bits[]>(
    Array.from({ length: wordCount }, () => int32.num(0)),
  );
  const baseRef = useRef<DisplayBase[]>(new Array(wordCount).fill("hex") as DisplayBase[]);
  const [cells, setCells] = useState<MemoryCellDisplay[]>(() =>
    Array.from({ length: wordCount }, () => ({
      bits: int32.num(0),
      base: "hex" as DisplayBase,
      mark: "default" as MarkStatus,
    })),
  );

  const markCell = useCallback((w: number, mark: MarkStatus) => {
    setCells((prev) => prev.map((c, i) => (i === w ? { ...c, mark } : c)));
  }, []);

  const checkRange = useCallback(
    (op: string, addr: number) => {
      const w = wordIndexOf(addr);
      if (w < 0 || w >= wordCount) throw outOfRangeMem(op, addr);
    },
    [wordCount],
  );

  const lw = useCallback(
    (addr: number): Int32Bits => {
      if (addr % 4 !== 0) throw unalignedMem("LW", addr);
      checkRange("LW", addr);
      const w = wordIndexOf(addr);
      markCell(w, "success");
      return bitsRef.current[w];
    },
    [checkRange, markCell],
  );

  const sw = useCallback(
    (addr: number, bits: Int32Bits): void => {
      if (addr % 4 !== 0) throw unalignedMem("SW", addr);
      checkRange("SW", addr);
      const w = wordIndexOf(addr);
      bitsRef.current[w] = bits;
      setCells((prev) => prev.map((c, i) => (i === w ? { ...c, bits, mark: "warning" } : c)));
    },
    [checkRange],
  );

  const lb = useCallback(
    (addr: number): Int32Bits => {
      checkRange("LB", addr);
      const w = wordIndexOf(addr);
      const offs = byteOffsetOf(addr);
      markCell(w, "success");
      const byteBits = getByteBits(bitsRef.current[w], offs);
      return bit.sign(byteBits, 32);
    },
    [checkRange, markCell],
  );

  const sb = useCallback(
    (addr: number, val: Int32Bits): void => {
      checkRange("SB", addr);
      const w = wordIndexOf(addr);
      const offs = byteOffsetOf(addr);
      const next = setByteBits(bitsRef.current[w], offs, val);
      bitsRef.current[w] = next;
      setCells((prev) => prev.map((c, i) => (i === w ? { ...c, bits: next, mark: "warning" } : c)));
    },
    [checkRange],
  );

  const ulw = useCallback(
    (addr: number): Int32Bits => {
      const w0 = wordIndexOf(addr);
      const w3 = wordIndexOf(addr + 3);
      if (w0 < 0 || w0 >= wordCount || w3 < 0 || w3 >= wordCount) throw outOfRangeMem("ULW", addr);
      const bytes: Int32Bits[] = [];
      for (const off of [3, 2, 1, 0]) {
        const a = addr + off;
        const w = wordIndexOf(a);
        markCell(w, "success");
        bytes.push(getByteBits(bitsRef.current[w], byteOffsetOf(a)));
      }
      return bytes.flat() as Int32Bits;
    },
    [wordCount, markCell],
  );

  const usw = useCallback(
    (addr: number, val: Int32Bits): void => {
      const w0 = wordIndexOf(addr);
      const w3 = wordIndexOf(addr + 3);
      if (w0 < 0 || w0 >= wordCount || w3 < 0 || w3 >= wordCount) throw outOfRangeMem("USW", addr);
      let v = val;
      for (const off of [0, 1, 2, 3]) {
        const a = addr + off;
        const w = wordIndexOf(a);
        const next = setByteBits(bitsRef.current[w], byteOffsetOf(a), v);
        bitsRef.current[w] = next;
        setCells((prev) => prev.map((c, i) => (i === w ? { ...c, bits: next, mark: "warning" } : c)));
        v = int32.srl(v, 8);
      }
    },
    [wordCount],
  );

  const RES = useCallback((): void => {
    setCells((prev) => prev.map((c) => ({ ...c, mark: "default" })));
  }, []);

  const setBase = useCallback((wordIndex: number, base: DisplayBase): void => {
    baseRef.current[wordIndex] = base;
    setCells((prev) => prev.map((c, i) => (i === wordIndex ? { ...c, base } : c)));
  }, []);

  const trySave = useCallback((wordIndex: number, text: string): boolean => {
    const base = baseRef.current[wordIndex] ?? "hex";
    try {
      const bits = base === "hex" ? int32.hex(text) : int32.dec(text);
      bitsRef.current[wordIndex] = bits;
      setCells((prev) => prev.map((c, i) => (i === wordIndex ? { ...c, bits, mark: "warning" } : c)));
      return true;
    } catch {
      setCells((prev) => prev.map((c, i) => (i === wordIndex ? { ...c, mark: "danger" } : c)));
      return false;
    }
  }, []);

  return {
    size,
    cells,
    addrOf: (wordIndex: number) => wordIndex * 4,
    lw,
    sw,
    lb,
    sb,
    ulw,
    usw,
    RES,
    setBase,
    trySave,
  };
}