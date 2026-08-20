/**
 * TS/React port of vals.js's value-state half (the DOM-construction half
 * moves to ValsTable.tsx instead), same split as reg.js -> useRegisterBank
 * and mem.js -> useMemoryBank.
 *
 * read only values
 * 
 * Keyed directly by the ValDef.key string (e.g. "REGRR1", "ALUres",
 * "MEMAddr") rather than reg.js's bareName()-stripped-$-prefix scheme —
 * vals.js's own _vals object is keyed the same way (comp+name), and
 * mips.js's call sites use these exact strings.
 */
import { useCallback, useRef, useState } from "react";
import { int32, type Int32Bits } from "../lib/Numbers/int32";
import { VALS } from "../lib/mips-machine/vals";

export type DisplayBase = "hex" | "dec";
export type MarkStatus = "default" | "success" | "warning" | "danger";

export interface ValDisplay {
  bits: Int32Bits;
  base: DisplayBase;
  mark: MarkStatus;
}

export interface ValsBank {
  /** Current display state, keyed by ValDef.key (e.g. "REGRR1", "ALUres").
   * Read this for rendering; use RD()/WR() for imperative reads/writes. */
  vals: Record<string, ValDisplay>;
  /** Read a wire value — marks it "success" (read this cycle) and returns
   * its current bits synchronously. */
  RD: (key: string) => Int32Bits;
  /** Write a wire value — marks it "warning" (written this cycle). Never
   * throws (no readonly cells exist). */
  WR: (key: string, bits: Int32Bits) => void;
  /** Resets every cell's mark back to "default" — called at the start of
   * each cycle stage in the original exec() loop. */
  RES: () => void;
  /** Switches a cell's display base (hex/dec) without changing its value —
   * the hex/dec toggle buttons. */
  setBase: (key: string, base: DisplayBase) => void;
}

function initialVals(): Record<string, ValDisplay> {
  const state: Record<string, ValDisplay> = {};
  for (const def of VALS) {
    state[def.key] = { bits: int32.num(0), base: "hex", mark: "default" };
  }
  return state;
}

export function useValsBank(): ValsBank {
  const bitsRef = useRef<Record<string, Int32Bits>>(
    Object.fromEntries(VALS.map((d) => [d.key, int32.num(0)])),
  );
  const baseRef = useRef<Record<string, DisplayBase>>(
    Object.fromEntries(VALS.map((d) => [d.key, "hex" as DisplayBase])),
  );
  const [vals, setVals] = useState<Record<string, ValDisplay>>(initialVals);

  const RD = useCallback((key: string): Int32Bits => {
    const bits = bitsRef.current[key];
    setVals((prev) => ({ ...prev, [key]: { ...prev[key], mark: "success" } }));
    return bits;
  }, []);

  const WR = useCallback((key: string, bits: Int32Bits): void => {
    bitsRef.current[key] = bits;
    setVals((prev) => ({ ...prev, [key]: { ...prev[key], bits, mark: "warning" } }));
  }, []);

  const RES = useCallback((): void => {
    setVals((prev) => {
      const next: Record<string, ValDisplay> = {};
      for (const key of Object.keys(prev)) next[key] = { ...prev[key], mark: "default" };
      return next;
    });
  }, []);

  const setBase = useCallback((key: string, base: DisplayBase): void => {
    baseRef.current[key] = base;
    setVals((prev) => ({ ...prev, [key]: { ...prev[key], base } }));
  }, []);

  return { vals, RD, WR, RES, setBase };
}