/**
 * Ties interpreter.ts's pure execStage() to the already-ported register and
 * memory banks (useRegisterBank/useMemoryBank), accumulating the resulting
 * MachineState[] — this is "a list of MachineStates that keeps track of
 * the values of each reg in the datapath and which components/wires are
 * active", built on top of the pure step function.
 *
 * Deliberately thin: this hook's only job is (1) call execStage with the
 * current pc/stage/vals plus read access into the banks, (2) commit any
 * reported regWrite/memWrite/pcNext back into the banks, (3) push the
 * resulting state onto history. All the actual instruction semantics live
 * in interpreter.ts, where they're pure and independently testable.
 *
 * Using bank.RR/bank.WR/bank.lw/bank.sw/bank.lb/bank.sb directly as
 * MachineInputs (and as the commit calls) is deliberate, not incidental:
 * those functions already do the "success"/"warning" mark bookkeeping the
 * RegisterTable/MemoryTable components render, so register/memory reads
 * and writes stay visually highlighted for free — this hook doesn't need
 * to duplicate that.
 *
 * NOTE on reset(): mirrors mips.js's RES() exactly — it clears this hook's
 * own bookkeeping (pc/stage/vals/history) but does NOT zero register or
 * memory values, since RES() in the original never did either (it only
 * resets marks). Zeroing actual values is a fresh useRegisterBank/
 * useMemoryBank instance's job (a remount), same as the original.
 */
import { useCallback, useRef, useState } from "react";
import { int32 } from "../lib/Numbers/int32";
import type { RegisterBank } from "./useRegisterBank";
import type { MemoryBank } from "./useMemoryBank";
import { canRun, execStage, type ProgramLine } from "../lib/mips-machine/interpreter";
import type { CycleStage, MachineState, ValsSnapshot } from "../lib/mips-machine/machineState";

const STAGES: CycleStage[] = ["F", "D", "A", "M", "R"];

export interface MachineHistory {
  /** Every MachineState produced so far, oldest first. */
  history: MachineState[];
  /** The most recent state, or null before the first step(). */
  current: MachineState | null;
  /** False once the program has run off the end or hit an error. */
  canStep: boolean;
  /** Runs exactly one F/D/A/M/R micro-step and appends it to history. */
  step: () => void;
  /** Clears history/pc/stage/vals (see the NOTE above — does not touch
   * register/memory values). */
  reset: () => void;
}

export function useMachineHistory(program: ProgramLine[], regBank: RegisterBank, memBank: MemoryBank): MachineHistory {
  const pcRef = useRef(0); // pcRef is just the index for programLine array, not the byte addressing of the pc
  const stageIdxRef = useRef(0);
  const valsRef = useRef<ValsSnapshot>({});
  const haltedRef = useRef(false);
  const [history, setHistory] = useState<MachineState[]>([]);

  const step = useCallback((): void => {
    if (haltedRef.current || !canRun(program, pcRef.current)) {
      haltedRef.current = true;
      return;
    }

    regBank.RES();
    memBank.RES();

    const stage = STAGES[stageIdxRef.current];
    const pcBits = regBank.RR("pc");
    let state = execStage(program, pcRef.current, stage, valsRef.current, pcBits, {
      readReg: regBank.RR,
      readWord: memBank.lw,
      readByte: memBank.lb,
    });

    if (!state.error) {
      try {
        if (state.regWrite) regBank.WR(state.regWrite.name, state.regWrite.value);
        if (state.memWrite) {
          if (state.memWrite.byte) memBank.sb(state.memWrite.addr, state.memWrite.value);
          else memBank.sw(state.memWrite.addr, state.memWrite.value);
        }
      } catch (err) {
        // Same "self-contained error, not a thrown exception the caller
        // must catch" contract as execStage's own readonly-register check
        // — anything the banks themselves reject (e.g. an out-of-range
        // store) still ends up as `error` on the pushed state.
        state = { ...state, error: err instanceof Error ? err.message : String(err) };
      }
    }

    valsRef.current = state.vals;
    setHistory((prev) => [...prev, state]);

    if (state.error) {
      haltedRef.current = true;
      return;
    }

    if (stage === "R") {
      if (state.pcNext) {
        regBank.WR("pc", state.pcNext);
        pcRef.current = int32.toNum(int32.srl(state.pcNext, 2));
      }
      stageIdxRef.current = 0;
    } else {
      stageIdxRef.current += 1;
    }
  }, [program, regBank, memBank]);

  const reset = useCallback((): void => {
    pcRef.current = 0;
    stageIdxRef.current = 0;
    valsRef.current = {};
    haltedRef.current = false;
    setHistory([]);
    regBank.WR("pc", int32.num(0));
  }, [regBank]);

  return {
    history,
    current: history.length > 0 ? history[history.length - 1] : null,
    canStep: !haltedRef.current && canRun(program, pcRef.current),
    step,
    reset,
  };
}