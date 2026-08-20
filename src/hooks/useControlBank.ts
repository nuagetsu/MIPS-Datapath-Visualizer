/**
 * TS/React port of ctrl.js's control-signal state half (the DOM-
 * construction half moves to ControlTable.tsx instead), same split as
 * reg.js -> useRegisterBank and vals.js -> useValsBank.
 *
 * Shape differs from those two: ctrl.js's table is a matrix (one row per
 * control signal, one column per instruction kind), not a flat list of
 * cells — RD(name, op) looks up CONTROLS[name].values[OPS[op]]. State here
 * mirrors that: `cells` is keyed by control name, each holding one display
 * entry per KIND index.
 *
 * RD(name, op) also highlights the op's header column in the original
 * (`_head[op]`) — ported as `headerMarks`, a parallel Record<Kind,
 * MarkStatus> the table's header row reads.
 */
import { useCallback, useRef, useState } from "react";
import { int32, type Int32Bits } from "../lib/Numbers/int32";
import * as bit from "../lib/Numbers/bit";
import { KIND, OPS, CONTROLS, type Kind } from "../lib/mips-machine/ctrl";
 
export type MarkStatus = "default" | "success" | "warning" | "danger";
 
export interface ControlCellDisplay {
  bits: Int32Bits;
  mark: MarkStatus;
}
 
export interface CtrlBank {
  /** cells[controlName][kindIndex] — current display state for every cell
   * in the matrix. Read this for rendering; use RD() for imperative reads. */
  cells: Record<string, ControlCellDisplay[]>;
  /** Highlight state for each header column (one per Kind) — mirrors the
   * original's _head[op] column highlight on RD(). */
  headerMarks: Record<Kind, MarkStatus>;
  /** Read control signal `name` for instruction kind `op` — marks that
   * cell "success" and the op's header column "success", then returns the
   * value synchronously. Matches ctrl.RD(name, op) exactly. */
  RD: (name: string, op: Kind) => Int32Bits;
  /** Resets every cell's mark (and every header's mark) back to "default" —
   * called at the start of each cycle stage in the original exec() loop. */
  RES: () => void;
}
 
function initialCells(): Record<string, ControlCellDisplay[]> {
  const state: Record<string, ControlCellDisplay[]> = {};
  for (const def of CONTROLS) {
    state[def.name] = def.values.map((v) => ({ bits: int32.num(v), mark: "default" as MarkStatus }));
  }
  return state;
}
 
function initialHeaderMarks(): Record<Kind, MarkStatus> {
  return Object.fromEntries(KIND.map((k) => [k, "default" as MarkStatus])) as Record<Kind, MarkStatus>;
}
 
export function useCtrlBank(): CtrlBank {
  const bitsRef = useRef<Record<string, Int32Bits[]>>(
    Object.fromEntries(CONTROLS.map((def) => [def.name, def.values.map((v) => int32.num(v))])),
  );
  const [cells, setCells] = useState<Record<string, ControlCellDisplay[]>>(initialCells);
  const [headerMarks, setHeaderMarks] = useState<Record<Kind, MarkStatus>>(initialHeaderMarks);
 
  const RD = useCallback((name: string, op: Kind): Int32Bits => {
    const i = OPS[op];
    const bits = bitsRef.current[name][i];
    setCells((prev) => ({
      ...prev,
      [name]: prev[name].map((c, idx) => (idx === i ? { ...c, mark: "success" } : c)),
    }));
    setHeaderMarks((prev) => ({ ...prev, [op]: "success" }));
    return bits;
  }, []);
 
  const RES = useCallback((): void => {
    setCells((prev) => {
      const next: Record<string, ControlCellDisplay[]> = {};
      for (const name of Object.keys(prev)) {
        next[name] = prev[name].map((c) => ({ ...c, mark: "default" }));
      }
      return next;
    });
    setHeaderMarks(initialHeaderMarks());
  }, []);
 
  return { cells, headerMarks, RD, RES };
}
 
/** Formats a control cell's value as an N-bit binary string, matching the
 * original load()'s `bit.get(_vals[i], 0, len).join("")` exactly. */
export function formatControlBits(bits: Int32Bits, len: number): string {
  return bit.get(bits, 0, len).join("");
}