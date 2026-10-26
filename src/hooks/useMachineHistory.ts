/**
 * Ties interpreter.ts's pure execStage() to the already-ported register and
 * memory banks (useRegisterBank/useMemoryBank), accumulating the resulting
 * MachineState[] — this is "a list of MachineStates that keeps track of
 * the values of each reg in the datapath and which components/wires are
 * active", built on top of the pure step function.
 *
 * Timeline (scrubbing): the run is a list of frames. Frame 0 is the machine
 * before the first step; frame i is the machine after step i. Each frame
 * stores, besides its MachineState, a complete snapshot of the machine —
 * register and memory values *and* marks, this hook's own pc/stage/vals,
 * and (pipeline mode) the PipelineEngine — so any frame can be shown again
 * exactly, and execution can carry on from it.
 *
 *   - Building: after a new program (or a mode switch), the whole run is
 *     computed straight away, up to MAX_PRECOMPUTED_STEPS steps, so the
 *     scrubber spans all of it. A longer (or endless) run is extended one
 *     step at a time by step() once you reach the end.
 *   - Seeking: seek(n) restores frame n's snapshot into the banks and this
 *     hook. So the live machine is always the frame on screen.
 *   - Branching: anything that changes what the future would be — toggling
 *     Pipeline Hazards / Early Branch, or editing a register or memory word
 *     (rebase()) — drops the frames after the one on screen and computes
 *     them again from it. As before, the hazard toggles only affect the
 *     cycles that follow.
 *   - Fix and resume: if the run stopped on a run-time error and the newly
 *     assembled program differs only in the instruction that failed,
 *     planResume()/prepare() keep every frame up to just before that
 *     instruction was fetched and recompute from there with the new
 *     program, instead of starting over.
 *
 * Starting $pc (`textBase`): the byte address of the program's first
 * instruction (App.tsx's "Starting $pc" field, default 0). Internally the
 * pc is still a program index (0, 1, 2…); pipeline.ts's addressOf()/
 * programIndexOf() convert to and from the $pc register's byte address.
 * reset() puts $pc back to textBase.
 *
 * Deliberately thin otherwise: each step's job is still (1) call execStage
 * (or the pipeline engine) with read access into the banks, (2) commit any
 * reported regWrite/memWrite/pcNext back into the banks. All the actual
 * instruction semantics live in interpreter.ts / pipeline.ts, where they're
 * pure and independently testable.
 *
 * Using bank.RR/bank.WR/bank.lw/bank.sw/bank.lb/bank.sb directly as
 * MachineInputs (and as the commit calls) is deliberate, not incidental:
 * those functions already do the "success"/"warning" mark bookkeeping the
 * RegisterTable/MemoryTable components render, so register/memory reads
 * and writes stay visually highlighted for free — and the banks'
 * snapshot() captures those marks along with the values.
 *
 * Pipeline mode (`pipeline` = true): a step is one clock cycle of a
 * five-stage pipeline instead of one micro-step of one instruction — see
 * pipeline.ts. `hazardUnit` turns on the hazard detection unit and
 * predict-not-taken fetching; `earlyBranch` (with it) resolves branches in
 * ID. Switching modes rebuilds the timeline; callers should seek(0) first
 * (to put the starting values back) and reset().
 *
 * NOTE on reset(): mirrors mips.js's RES() — it clears this hook's own
 * bookkeeping (timeline, pc/stage/vals) but does NOT zero register or
 * memory values. Zeroing actual values is a fresh useRegisterBank/
 * useMemoryBank instance's job (a remount), same as the original.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RegisterBank, RegisterSnapshot } from "./useRegisterBank";
import type { MemoryBank, MemorySnapshot } from "./useMemoryBank";
import { canRun, execStage, type ProgramLine } from "../lib/mips-machine/interpreter";
import type { CycleStage, MachineState, ValsSnapshot } from "../lib/mips-machine/machineState";
import {
  PipelineEngine,
  addressOf,
  programIndexOf,
  type BaseReaders,
  type PipelineEngineSnapshot,
  type PipelineSlotView,
} from "../lib/mips-machine/pipeline";

const STAGES: CycleStage[] = ["F", "D", "A", "M", "R"];

/** How many steps are computed ahead when a timeline is built. Runs that
 * are longer (e.g. an endless loop) stop here; step() at the end of the
 * timeline keeps extending it one step at a time. */
export const MAX_PRECOMPUTED_STEPS = 300;

// Stable empties, so memos keyed on pipelineSlots don't rerun every render.
const NO_SLOTS: PipelineSlotView[] = [];
const NO_BUBBLES: CycleStage[] = [];

/** The whole machine at one moment. */
interface LiveSnapshot {
  regs: RegisterSnapshot;
  mem: MemorySnapshot;
  pc: number;
  stageIdx: number;
  vals: ValsSnapshot;
  halted: boolean;
  engine: PipelineEngineSnapshot | null;
}

/** One position on the timeline, as the UI sees it. */
export interface TimelineFrame {
  /** The step's MachineState; null for frame 0 (before the first step). */
  state: MachineState | null;
  /** Pipeline mode: the instructions in flight that cycle. */
  slots: PipelineSlotView[];
  /** Pipeline mode: stages holding a bubble that cycle. */
  bubbles: CycleStage[];
}

interface Frame extends TimelineFrame {
  snap: LiveSnapshot;
}

type StepResult = TimelineFrame & { state: MachineState };

export interface MachineHistory {
  /** Every MachineState on the timeline, oldest first (frames 1..n). */
  history: MachineState[];
  /** Every frame, including frame 0 (before the first step): index =
   * position. */
  timeline: TimelineFrame[];
  /** The frame on screen: 0 before the first step, i after step i. */
  position: number;
  /** The MachineState on screen, or null at position 0. */
  current: MachineState | null;
  /** False at the end of the timeline once the program has run off the end
   * or hit an error. */
  canStep: boolean;
  /** False at position 0. */
  canStepBack: boolean;
  /** True when the timeline runs all the way to the end of the program
   * (false while it stops at MAX_PRECOMPUTED_STEPS). */
  complete: boolean;
  /** Pipeline mode only: the instructions in flight on screen. Empty in
   * single-cycle mode and at position 0. */
  pipelineSlots: PipelineSlotView[];
  /** Pipeline mode only: stages holding a bubble on screen. */
  pipelineBubbles: CycleStage[];
  /** Memory words read or written anywhere on the timeline. */
  touchedWords: Set<number>;
  /** One step forward (one F/D/A/M/R micro-step, or one clock cycle). */
  step: () => void;
  /** One step back. */
  stepBack: () => void;
  /** Jump to a frame (clamped to the timeline). */
  seek: (position: number) => void;
  /** Clears the timeline and pc/stage/vals, and puts $pc back to the
   * starting $pc (see the NOTE above — does not touch other register or
   * memory values). */
  reset: () => void;
  /** Call after editing a register or memory word by hand: the edit becomes
   * part of the frame on screen and everything after it is recomputed. */
  rebase: () => void;
  /** Whether `next` (a newly assembled program) is a fix for the run-time
   * error the timeline stopped on — same instructions, except the one that
   * failed — and if so, where to resume: the frame just before that
   * instruction was fetched. Null if the run didn't stop on an error, or
   * anything else changed. */
  planResume: (next: ProgramLine[]) => ResumePoint | null;
  /**
   * Test-runs a newly assembled program before it's accepted, by building
   * its timeline straight away (up to MAX_PRECOMPUTED_STEPS steps):
   *   - with `resume` (from planResume()): continuing the current run from
   *     that frame;
   *   - without: from the start, after `setup` has put the starting values
   *     in the banks (e.g. loading .data and setting $pc).
   * `textBase` is the new program's starting $pc (defaults to the current
   * one); pass the same value to the hook as `textBase` once the program
   * is accepted.
   * If the run reaches a run-time error, everything — timeline, registers,
   * memory, `setup`'s changes — is put back as it was and the error is
   * returned, for Assemble to report. Otherwise the new timeline is kept
   * and null returned; set the program right after, and it won't be
   * rebuilt.
   */
  prepare: (next: ProgramLine[], resume: ResumePoint | null, setup?: () => void, textBase?: number) => RunError | null;
}

/** A run-time error found by prepare(). */
export interface RunError {
  message: string;
  /** Program index of the instruction that fails. */
  pc: number;
}

export interface ResumePoint {
  /** The frame to resume from. */
  frame: number;
  /** Program index of the fixed instruction. */
  pc: number;
}

export function useMachineHistory(
  program: ProgramLine[],
  regBank: RegisterBank,
  memBank: MemoryBank,
  pipeline = false,
  hazardUnit = false,
  earlyBranch = false,
  textBase = 0,
): MachineHistory {
  const pcRef = useRef(0); // pcRef is just the index for programLine array, not the byte addressing of the pc
  const stageIdxRef = useRef(0);
  const valsRef = useRef<ValsSnapshot>({});
  const haltedRef = useRef(false);
  // Pipeline mode: created on the first step after a reset, so it always
  // runs the current program.
  const engineRef = useRef<PipelineEngine | null>(null);

  const framesRef = useRef<Frame[]>([]);
  const positionRef = useRef(0);
  // Whether the machine at the last frame can still step.
  const headOpenRef = useRef(false);
  // The hazard settings the frames after the one on screen were built with.
  const settingsRef = useRef({ hazardUnit, earlyBranch });
  // The program the step functions run. Normally the `program` argument;
  // prepare() points it at the program being assembled while it test-runs
  // it, before that program is the app's state.
  const progRef = useRef(program);
  progRef.current = program;
  // The starting $pc the step functions use — same arrangement as progRef.
  const baseRef = useRef(textBase);
  baseRef.current = textBase;
  // Set by a successful prepare(): the timeline for the program about to
  // arrive is already built, so the effect below mustn't rebuild it.
  const preparedRef = useRef(false);
  const [position, setPosition] = useState(0);
  // Bumped whenever framesRef's contents change, to re-derive the timeline.
  const [version, setVersion] = useState(0);

  const baseReaders: BaseReaders = useMemo(
    () => ({ peekReg: regBank.peek, peekWord: memBank.peekWord, memSize: memBank.size }),
    [regBank.peek, memBank.peekWord, memBank.size],
  );

  function show(pos: number, framesChanged: boolean): void {
    positionRef.current = pos;
    setPosition(pos);
    if (framesChanged) setVersion((v) => v + 1);
  }

  // ---- Snapshots -----------------------------------------------------------

  function capture(): LiveSnapshot {
    return {
      regs: regBank.snapshot(),
      mem: memBank.snapshot(),
      pc: pcRef.current,
      stageIdx: stageIdxRef.current,
      vals: valsRef.current,
      halted: haltedRef.current,
      engine: engineRef.current ? engineRef.current.snapshot() : null,
    };
  }

  function apply(snap: LiveSnapshot): void {
    regBank.restore(snap.regs);
    memBank.restore(snap.mem);
    pcRef.current = snap.pc;
    stageIdxRef.current = snap.stageIdx;
    valsRef.current = snap.vals;
    haltedRef.current = snap.halted;
    engineRef.current = snap.engine
      ? PipelineEngine.restore(progRef.current, baseReaders, snap.engine, baseRef.current)
      : null;
  }

  // ---- Executing one step on the live machine ------------------------------

  function canContinue(): boolean {
    if (haltedRef.current) return false;
    if (pipeline) return engineRef.current ? engineRef.current.canStep() : canRun(progRef.current, 0);
    return canRun(progRef.current, pcRef.current);
  }

  function stepPipeline(): StepResult | null {
    if (haltedRef.current) return null;
    if (!engineRef.current) engineRef.current = new PipelineEngine(progRef.current, baseReaders, baseRef.current);
    const result = engineRef.current.step(hazardUnit, earlyBranch);
    if (!result) {
      haltedRef.current = true;
      return null;
    }

    regBank.RES();
    memBank.RES();

    // Reads first (they only mark), then writes — so a register written in
    // write-back and read in Decode in the same cycle shows as written.
    // Values were already taken by pipeline.ts's look-ahead; a read that
    // fails here is one whose stage already carries the error.
    const { effects } = result;
    for (const name of effects.regReads) regBank.RR(name);
    for (const { addr, byte } of effects.memReads) {
      try {
        if (byte) memBank.lb(addr);
        else memBank.lw(addr);
      } catch {
        /* reported via the stage's own error */
      }
    }
    let error = result.error;
    try {
      for (const w of effects.memWrites) {
        if (w.byte) memBank.sb(w.addr, w.value);
        else memBank.sw(w.addr, w.value);
      }
      for (const w of effects.regWrites) regBank.WR(w.name, w.value);
      if (effects.pc) regBank.WR("pc", effects.pc);
    } catch (err) {
      error = error ?? (err instanceof Error ? err.message : String(err));
    }

    if (error) haltedRef.current = true;
    return { state: { ...result.summary, error }, slots: result.slots, bubbles: result.bubbles };
  }

  function stepSingle(): StepResult | null {
    if (haltedRef.current || !canRun(progRef.current, pcRef.current)) {
      haltedRef.current = true;
      return null;
    }

    regBank.RES();
    memBank.RES();

    const stage = STAGES[stageIdxRef.current];
    const pcBits = regBank.RR("pc");
    let state = execStage(progRef.current, pcRef.current, stage, valsRef.current, pcBits, {
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
        // store) still ends up as `error` on the state.
        state = { ...state, error: err instanceof Error ? err.message : String(err) };
      }
    }

    valsRef.current = state.vals;

    if (state.error) {
      haltedRef.current = true;
      return { state, slots: [], bubbles: [] };
    }

    if (stage === "R") {
      if (state.pcNext) {
        regBank.WR("pc", state.pcNext);
        // Byte address -> program index, relative to the starting $pc.
        pcRef.current = programIndexOf(state.pcNext, baseRef.current);
      }
      stageIdxRef.current = 0;
    } else {
      stageIdxRef.current += 1;
    }
    return { state, slots: [], bubbles: [] };
  }

  const stepLive = pipeline ? stepPipeline : stepSingle;

  // ---- Building the timeline -----------------------------------------------

  /** Appends up to `limit` frames. The live machine must be at the last
   * frame. */
  function extend(limit: number): void {
    const frames = framesRef.current;
    for (let n = 0; n < limit && canContinue(); n++) {
      const result = stepLive();
      if (!result) break;
      frames.push({ ...result, snap: capture() });
    }
    headOpenRef.current = canContinue();
  }

  /** Drops every frame after `p` and computes them again from frame p
   * (with the current hazard settings), then shows frame p. */
  function rebuildFrom(p: number): void {
    const frames = framesRef.current;
    if (frames.length === 0) return;
    const at = Math.min(p, frames.length - 1);
    frames.length = at + 1;
    apply(frames[at].snap);
    extend(Math.max(0, MAX_PRECOMPUTED_STEPS - at));
    // Each step above queued its own bank display updates; this restore is
    // queued last, so it's the one that ends up on screen.
    apply(frames[at].snap);
    settingsRef.current = { hazardUnit, earlyBranch };
    show(at, true);
  }

  /** A new timeline starting from the banks' current values. */
  function rebuildAll(): void {
    pcRef.current = 0;
    stageIdxRef.current = 0;
    valsRef.current = {};
    haltedRef.current = false;
    engineRef.current = null;
    framesRef.current = [{ state: null, slots: [], bubbles: [], snap: capture() }];
    rebuildFrom(0);
  }

  // A new program or execution mode: build its whole timeline — or, for a
  // fix approved by planResume(), keep the timeline up to the resume point
  // and carry on from there with the new program.
  useEffect(() => {
    if (preparedRef.current) {
      preparedRef.current = false;
      return;
    }
    rebuildAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, pipeline]);

  // Hazard settings changed: the cycles after the one on screen change.
  useEffect(() => {
    const prev = settingsRef.current;
    if (prev.hazardUnit === hazardUnit && prev.earlyBranch === earlyBranch) return;
    settingsRef.current = { hazardUnit, earlyBranch };
    if (!pipeline || framesRef.current.length === 0) return;
    rebuildFrom(positionRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hazardUnit, earlyBranch]);

  // ---- Navigation ------------------------------------------------------------

  function seek(target: number): void {
    const frames = framesRef.current;
    if (frames.length === 0) return;
    const p = Math.max(0, Math.min(frames.length - 1, Math.round(target)));
    if (p === positionRef.current) return;
    apply(frames[p].snap);
    show(p, false);
  }

  function step(): void {
    const frames = framesRef.current;
    if (frames.length === 0) return;
    const p = positionRef.current;
    if (p < frames.length - 1) {
      seek(p + 1);
      return;
    }
    // At the end of the timeline (a run longer than MAX_PRECOMPUTED_STEPS):
    // compute one more step. The live machine is already at this frame.
    const result = canContinue() ? stepLive() : null;
    if (result) frames.push({ ...result, snap: capture() });
    headOpenRef.current = canContinue();
    show(result ? p + 1 : p, true);
  }

  function stepBack(): void {
    seek(positionRef.current - 1);
  }

  function reset(): void {
    pcRef.current = 0;
    stageIdxRef.current = 0;
    valsRef.current = {};
    haltedRef.current = false;
    engineRef.current = null;
    framesRef.current = [];
    headOpenRef.current = false;
    regBank.WR("pc", addressOf(0, baseRef.current));
    show(0, true);
  }

  function rebase(): void {
    const frames = framesRef.current;
    if (frames.length === 0) return;
    const p = positionRef.current;
    frames[p] = { ...frames[p], snap: capture() };
    rebuildFrom(p);
  }

  // ---- Fix and resume ----------------------------------------------------------

  function planResume(next: ProgramLine[]): ResumePoint | null {
    const frames = framesRef.current;
    const last = frames.length - 1;
    const head = frames[last];
    if (!head?.state?.error || next.length !== program.length) return null;

    // The failing instruction, and the frame it was fetched in.
    let pc: number;
    let fetched = -1;
    if (pipeline) {
      const failing = head.slots.find((s) => s.state.error);
      if (!failing) return null; // e.g. a store the memory bank refused
      pc = failing.pc;
      // seq numbers are unique, so the first frame with it in IF is its
      // fetch (a stall can hold it there for more than one).
      fetched = frames.findIndex((f) => f.slots.some((s) => s.seq === failing.seq && s.stage === "F"));
    } else {
      pc = head.state.pc;
      // The latest Fetch of that instruction (it may have run before, in a
      // loop, without failing).
      for (let i = last; i >= 1; i--) {
        const s = frames[i].state;
        if (s && s.pc === pc && s.stage === "F") {
          fetched = i;
          break;
        }
      }
    }
    if (fetched < 1) return null;

    // Only that instruction may differ, and it must.
    const sameLine = (a: ProgramLine, b: ProgramLine) => a.op === b.op && a.bin.join("") === b.bin.join("");
    for (let i = 0; i < next.length; i++) {
      if (i !== pc && !sameLine(program[i], next[i])) return null;
    }
    if (sameLine(program[pc], next[pc])) return null;
    return { frame: fetched - 1, pc };
  }

  /** The run-time error the timeline ends on, if it ends on one. */
  function headError(): RunError | null {
    const frames = framesRef.current;
    const head = frames[frames.length - 1];
    const state = head?.state;
    if (!state?.error) return null;
    // Pipeline mode: the summary state is the failing instruction's when
    // one failed; prefer the failing slot's own pc if there is one.
    const failing = head.slots.find((s) => s.state.error);
    return { message: state.error, pc: failing ? failing.pc : state.pc };
  }

  function prepare(
    next: ProgramLine[],
    resume: ResumePoint | null,
    setup?: () => void,
    nextBase: number = baseRef.current,
  ): RunError | null {
    // Everything needed to put things back if the test run fails.
    const savedFrames = framesRef.current;
    const savedPosition = positionRef.current;
    const savedHeadOpen = headOpenRef.current;
    const savedSettings = settingsRef.current;
    const savedBase = baseRef.current;
    const savedLive = capture();

    progRef.current = next;
    baseRef.current = nextBase;
    if (resume && resume.frame < savedFrames.length) {
      // Work on a copy: rebuildFrom() truncates the array it's given.
      framesRef.current = savedFrames.slice(0, resume.frame + 1);
      rebuildFrom(resume.frame);
    } else {
      setup?.();
      rebuildAll();
    }

    const error = headError();
    if (!error) {
      preparedRef.current = true;
      return null;
    }

    // The program would fail: put the previous program's run back exactly
    // as it was (bank displays included — this restore is queued last).
    progRef.current = program;
    baseRef.current = savedBase;
    framesRef.current = savedFrames;
    headOpenRef.current = savedHeadOpen;
    settingsRef.current = savedSettings;
    apply(savedLive);
    show(savedPosition, true);
    return error;
  }

  // ---- Derived views -----------------------------------------------------------

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const frames = useMemo(() => framesRef.current.slice(), [version]);
  const history = useMemo(() => frames.slice(1).map((f) => f.state as MachineState), [frames]);
  const touchedWords = useMemo(() => {
    const touched = new Set<number>();
    for (const f of frames) {
      f.snap.mem.marks.forEach((mark, i) => {
        if (mark !== "default") touched.add(i);
      });
    }
    return touched;
  }, [frames]);

  const frame = frames[position] ?? null;
  const atHead = frames.length > 0 && position >= frames.length - 1;

  return {
    history,
    timeline: frames,
    position,
    current: frame?.state ?? null,
    canStep: frames.length > 0 && (!atHead || headOpenRef.current),
    canStepBack: position > 0,
    complete: frames.length > 0 && !headOpenRef.current,
    pipelineSlots: frame?.slots ?? NO_SLOTS,
    pipelineBubbles: frame?.bubbles ?? NO_BUBBLES,
    touchedWords,
    step,
    stepBack,
    seek,
    reset,
    rebase,
    planResume,
    prepare,
  };
}