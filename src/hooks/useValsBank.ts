/**
 * TS/React port of vals.js's value-state half (the DOM-construction half
 * moves to ValsTable.tsx instead), same split as reg.js -> useRegisterBank
 * and mem.js -> useMemoryBank.
 *
 * read only values
 *
 * Keyed directly by ValKey (e.g. "REGRR1", "ALUres", "MEMAddr") rather
 * than reg.js's bareName()-stripped-$-prefix scheme — vals.js's own _vals
 * object is keyed the same way (comp+name), and mips.js's call sites use
 * these exact strings. ValKey is derived from VALS, so RD/WR/setBase only
 * accept keys that exist: a misspelt key can't create a stray entry the
 * table never renders.
 */
import { useCallback, useRef, useState } from "react";
import { int32, type Int32Bits } from "../lib/Numbers/int32";
import { VALS, type ValKey } from "../lib/mips-machine/vals";

export type DisplayBase = "hex" | "dec";
export type MarkStatus = "default" | "success" | "warning" | "danger";

export interface ValDisplay {
  bits: Int32Bits;
  base: DisplayBase;
  mark: MarkStatus;
}

export interface ValsBank {
  /** Current display state, keyed by ValKey (e.g. "REGRR1", "ALUres").
   * Read this for rendering; use RD()/WR() for imperative reads/writes. */
  vals: Record<ValKey, ValDisplay>;
  /** Read a wire value — marks it "success" (read this cycle) and returns
   * its current bits synchronously. */
  RD: (key: ValKey) => Int32Bits;
  /** Write a wire value — marks it "warning" (written this cycle). Never
   * throws (no readonly cells exist). */
  WR: (key: ValKey, bits: Int32Bits) => void;
  /** Resets every cell's mark back to "default" — called at the start of
   * each cycle stage in the original exec() loop. */
  RES: () => void;
  /** Switches a cell's display base (hex/dec) without changing its value —
   * the hex/dec toggle buttons. */
  setBase: (key: ValKey, base: DisplayBase) => void;
}

/** A record with one entry per VALS key. The cast is safe: the entries come
 * straight from VALS, so every ValKey is present. */
function perKey<T>(make: (key: ValKey) => T): Record<ValKey, T> {
  return Object.fromEntries(VALS.map((d) => [d.key, make(d.key)])) as Record<ValKey, T>;
}

function initialVals(): Record<ValKey, ValDisplay> {
  return perKey(() => ({ bits: int32.num(0), base: "hex", mark: "default" }));
}

export function useValsBank(): ValsBank {
  const bitsRef = useRef<Record<ValKey, Int32Bits>>(perKey(() => int32.num(0)));
  const baseRef = useRef<Record<ValKey, DisplayBase>>(perKey((): DisplayBase => "hex"));
  const [vals, setVals] = useState<Record<ValKey, ValDisplay>>(initialVals);

  const RD = useCallback((key: ValKey): Int32Bits => {
    const bits = bitsRef.current[key];
    setVals((prev) => ({ ...prev, [key]: { ...prev[key], mark: "success" } }));
    return bits;
  }, []);

  const WR = useCallback((key: ValKey, bits: Int32Bits): void => {
    bitsRef.current[key] = bits;
    setVals((prev) => ({ ...prev, [key]: { ...prev[key], bits, mark: "warning" } }));
  }, []);

  const RES = useCallback((): void => {
    setVals((prev) => perKey((key) => ({ ...prev[key], mark: "default" })));
  }, []);

  const setBase = useCallback((key: ValKey, base: DisplayBase): void => {
    baseRef.current[key] = base;
    setVals((prev) => ({ ...prev, [key]: { ...prev[key], base } }));
  }, []);

  return { vals, RD, WR, RES, setBase };
}