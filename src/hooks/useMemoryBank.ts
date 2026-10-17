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
 *
 * Timeline scrubbing: like useRegisterBank, marks are mirrored into a ref
 * so snapshot()/restore() can capture and put back each word's value and
 * read/write mark synchronously (see useMachineHistory).
 */
import { useCallback, useRef, useState } from "react";
import { int32, type Int32Bits } from "../lib/Numbers/int32";
import * as bit from "../lib/Numbers/bit";
import {
  unalignedMem,
  outOfRangeMem,
  wordIndexOf,
  byteOffsetOf,
  getByteBits,
  setByteBits,
} from "../lib/mips-machine/memoryWords";

export type DisplayBase = "hex" | "dec";
export type MarkStatus = "default" | "success" | "warning" | "danger";

export interface MemoryCellDisplay {
  bits: Int32Bits;
  base: DisplayBase;
  mark: MarkStatus;
}

/** Every word's value and mark at one moment — see snapshot()/restore(). */
export interface MemorySnapshot {
  bits: Int32Bits[];
  marks: MarkStatus[];
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
  /** The word at a (4-aligned) byte address, without marking any cell —
   * for pipeline.ts's look-ahead, which reads an instruction's memory when
   * it's fetched but only marks it when it reaches Memory. */
  peekWord: (addr: number) => Int32Bits;
  ulw: (addr: number) => Int32Bits;
  usw: (addr: number, val: Int32Bits) => void;
  RES: () => void;
  setBase: (wordIndex: number, base: DisplayBase) => void;
  trySave: (wordIndex: number, text: string) => boolean;
  /** Every word's current value and mark, read synchronously. */
  snapshot: () => MemorySnapshot;
  /** Puts back the values and marks from snapshot(); display bases stay. */
  restore: (snap: MemorySnapshot) => void;
}

export function useMemoryBank(size = 256): MemoryBank {
  const wordCount = Math.floor(size / 4);
  const bitsRef = useRef<Int32Bits[]>(
    Array.from({ length: wordCount }, () => int32.num(0)),
  );
  const marksRef = useRef<MarkStatus[]>(new Array(wordCount).fill("default") as MarkStatus[]);
  const baseRef = useRef<DisplayBase[]>(new Array(wordCount).fill("hex") as DisplayBase[]);
  const [cells, setCells] = useState<MemoryCellDisplay[]>(() =>
    Array.from({ length: wordCount }, () => ({
      bits: int32.num(0),
      base: "hex" as DisplayBase,
      mark: "default" as MarkStatus,
    })),
  );

  const markCell = useCallback((w: number, mark: MarkStatus) => {
    marksRef.current[w] = mark;
    setCells((prev) => prev.map((c, i) => (i === w ? { ...c, mark } : c)));
  }, []);

  /** Sets a word's bits and marks it written ("warning"). */
  const writeCell = useCallback((w: number, bits: Int32Bits) => {
    bitsRef.current[w] = bits;
    marksRef.current[w] = "warning";
    setCells((prev) => prev.map((c, i) => (i === w ? { ...c, bits, mark: "warning" } : c)));
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
      writeCell(wordIndexOf(addr), bits);
    },
    [checkRange, writeCell],
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

  const peekWord = useCallback((addr: number): Int32Bits => bitsRef.current[wordIndexOf(addr)], []);

  const sb = useCallback(
    (addr: number, val: Int32Bits): void => {
      checkRange("SB", addr);
      const w = wordIndexOf(addr);
      const offs = byteOffsetOf(addr);
      writeCell(w, setByteBits(bitsRef.current[w], offs, val));
    },
    [checkRange, writeCell],
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
        writeCell(w, setByteBits(bitsRef.current[w], byteOffsetOf(a), v));
        v = int32.srl(v, 8);
      }
    },
    [wordCount, writeCell],
  );

  const RES = useCallback((): void => {
    marksRef.current.fill("default");
    setCells((prev) => prev.map((c) => ({ ...c, mark: "default" })));
  }, []);

  const setBase = useCallback((wordIndex: number, base: DisplayBase): void => {
    baseRef.current[wordIndex] = base;
    setCells((prev) => prev.map((c, i) => (i === wordIndex ? { ...c, base } : c)));
  }, []);

  const trySave = useCallback(
    (wordIndex: number, text: string): boolean => {
      const base = baseRef.current[wordIndex] ?? "hex";
      try {
        const bits = base === "hex" ? int32.hex(text) : int32.dec(text);
        writeCell(wordIndex, bits);
        return true;
      } catch {
        markCell(wordIndex, "danger");
        return false;
      }
    },
    [writeCell, markCell],
  );

  const snapshot = useCallback(
    (): MemorySnapshot => ({ bits: [...bitsRef.current], marks: [...marksRef.current] }),
    [],
  );

  const restore = useCallback((snap: MemorySnapshot): void => {
    bitsRef.current = [...snap.bits];
    marksRef.current = [...snap.marks];
    setCells((prev) => prev.map((c, i) => ({ ...c, bits: snap.bits[i] ?? c.bits, mark: snap.marks[i] ?? "default" })));
  }, []);

  return {
    size,
    cells,
    addrOf: (wordIndex: number) => wordIndex * 4,
    lw,
    sw,
    lb,
    sb,
    peekWord,
    ulw,
    usw,
    RES,
    setBase,
    trySave,
    snapshot,
    restore,
  };
}