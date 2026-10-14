/**
 * Pipelined execution: one step() = one clock cycle, with up to five
 * instructions in flight — one per stage (F, D, A, M, R). Every cycle each
 * in-flight instruction advances one stage and, if there is one, the next
 * instruction enters Fetch.
 *
 * Program behavior is identical to the single-cycle mode (useMachineHistory
 * without `pipeline`). This works because each instruction is fully
 * executed ahead of time, at the moment it's fetched, in program order:
 *
 *   - precompute() runs execStage() for all five of its stages in a row,
 *     exactly as the single-cycle runner would, but reading registers and
 *     memory through a PendingState: the real banks plus the not-yet-
 *     committed writes of every older in-flight instruction. So an
 *     instruction always sees its predecessors' results, even ones that
 *     reach the real register file cycles later (what forwarding and
 *     stalling achieve in real hardware).
 *   - The resulting pcNext says which instruction to fetch next, so after
 *     a jump or taken branch the pipeline fetches the right one straight
 *     away (as if branch prediction were perfect).
 *   - The real banks only change when an instruction actually reaches the
 *     stage that writes them — memory in M, registers in R — and reads are
 *     marked in the register/memory tables in the stage that makes them
 *     (D, M). step() reports all of that as CycleEffects for the caller
 *     (useMachineHistory) to apply, the same "report, don't apply" split
 *     execStage() uses.
 *
 * Load-use stalls (step(true), the "Pipeline Hazards" mode): the hazard
 * detection unit from the slides. When a load is in EX and the instruction
 * in ID names the load's target register as rs or rt —
 *
 *   ID/EX.MemRead and ((ID/EX.RegisterRt = IF/ID.RegisterRs)
 *                   or (ID/EX.RegisterRt = IF/ID.RegisterRt))
 *
 * — the next cycle is a stall: PC and IF/ID aren't written, so the
 * instructions in IF and ID stay where they are (and redo their stage);
 * the control values entering ID/EX are zeroed, so a bubble (a nop) enters
 * EX; and everything from EX on advances as usual. A cycle later the
 * dependent instruction reaches EX with the load in WB, and the forwarding
 * unit's MEM-hazard rule (01) supplies the loaded value. Stalling changes
 * only *when* things happen, never the values: those were fixed at fetch.
 * Like the slides' condition, this is conservative: it also stalls when the
 * matching rt is the ID instruction's destination rather than a source.
 *
 * Pure: no React, no banks — reads come in through BaseReaders.
 */
import { int32, type Int32Bits } from "../Numbers/int32";
import * as bit from "../Numbers/bit";
import { canRun, execStage, type MachineInputs, type ProgramLine } from "./interpreter";
import { ctrlValue, isKnownOp } from "./ctrl";
import type { CycleStage, MachineState, MemoryWrite, RegisterWrite, ValsSnapshot } from "./machineState";
import type { WireId } from "./datapath";
import { unalignedMem, outOfRangeMem, wordIndexOf, byteOffsetOf, getByteBits, setByteBits } from "./memoryWords";

export const STAGES: CycleStage[] = ["F", "D", "A", "M", "R"];

/** Side-effect-free access to the real (committed) register file and
 * memory — useRegisterBank.peek / useMemoryBank.peekWord. */
export interface BaseReaders {
  peekReg: (name: string) => Int32Bits;
  peekWord: (addr: number) => Int32Bits;
  /** Memory size in bytes (useMemoryBank's `size`). */
  memSize: number;
}

/** A register/memory read an instruction made in one of its stages —
 * replayed against the real banks when it gets there, for their marks. */
export type StageRead = { kind: "reg"; name: string } | { kind: "word"; addr: number } | { kind: "byte"; addr: number };

/** One instruction in flight. */
export interface PipelineSlotView {
  /** Position in the dynamic instruction stream: 0 for the first
   * instruction executed, 1 for the second, ... DatapathDiagram colors by
   * seq % 5. */
  seq: number;
  /** Program index (like MachineState.pc). */
  pc: number;
  op: string;
  /** The stage it occupies this cycle. */
  stage: CycleStage;
  /** Its MachineState for that stage. */
  state: MachineState;
  /** Every wire it lights across all five of its stages. */
  wires: WireId[];
  /** True if it's held in IF or ID by a load-use stall this cycle (it's
   * redoing the stage it was already in). */
  stalled: boolean;
}

export interface CycleEffects {
  regReads: string[];
  memReads: { addr: number; byte: boolean }[];
  memWrites: MemoryWrite[];
  regWrites: RegisterWrite[];
  /** New $pc value to show, if it changes this cycle: the address of the
   * instruction entering Fetch (or, once fetching stops, the address after
   * the program's last instruction). */
  pc: Int32Bits | null;
}

export interface CycleResult {
  slots: PipelineSlotView[];
  /** Stages holding a bubble (a nop inserted by a stall) this cycle. */
  bubbles: CycleStage[];
  effects: CycleEffects;
  /** A single MachineState summarizing the cycle, for the parts of the UI
   * that show one state (header, editor marker, vals table): the
   * instruction that errored, if one did, else the oldest in flight — with
   * `vals` merged across all of them (see mergedVals). */
  summary: MachineState;
  error: string | null;
}

function bare(name: string): string {
  return name.startsWith("$") ? name.slice(1) : name;
}

/** The slides' load-use hazard condition, for a load in EX (`ex`, its
 * MachineState there) and the instruction in ID (`id`). Exported so the UI
 * can point out the hazard in the cycle it's detected, before the stall. */
export function isLoadUseHazard(ex: MachineState, id: MachineState): boolean {
  if (ex.error || id.error || !isKnownOp(ex.op)) return false;
  if (ctrlValue("MemRead", ex.op) !== 1) return false;
  const loadRt = int32.toNum(ex.fields.rt);
  return loadRt === int32.toNum(id.fields.rs) || loadRt === int32.toNum(id.fields.rt);
}

// ---- PendingState: committed state + in-flight writes -------------------

interface Pending {
  bits: Int32Bits;
  /** In-flight writes to this location not yet committed to the real
   * bank. The entry is dropped when this reaches 0, so the real bank is
   * the source of truth again (and any manual edit made in the register or
   * memory table between steps is respected). */
  count: number;
}

export class PendingState {
  private regs = new Map<string, Pending>();
  private words = new Map<number, Pending>();
  private readonly base: BaseReaders;
  private readonly wordCount: number;

  constructor(base: BaseReaders) {
    this.base = base;
    this.wordCount = Math.floor(base.memSize / 4);
  }

  private checkRange(op: string, addr: number): number {
    const w = wordIndexOf(addr);
    if (w < 0 || w >= this.wordCount) throw outOfRangeMem(op, addr);
    return w;
  }

  private word(w: number): Int32Bits {
    return this.words.get(w)?.bits ?? this.base.peekWord(w * 4);
  }

  readReg(name: string): Int32Bits {
    const key = bare(name);
    return this.regs.get(key)?.bits ?? this.base.peekReg(key);
  }

  /** Same semantics and errors as useMemoryBank.lw. */
  readWord(addr: number): Int32Bits {
    if (addr % 4 !== 0) throw unalignedMem("LW", addr);
    return this.word(this.checkRange("LW", addr));
  }

  /** Same semantics and errors as useMemoryBank.lb (sign-extended). */
  readByte(addr: number): Int32Bits {
    const w = this.checkRange("LB", addr);
    return bit.sign(getByteBits(this.word(w), byteOffsetOf(addr)), 32);
  }

  writeReg(name: string, bits: Int32Bits): void {
    const key = bare(name);
    this.regs.set(key, { bits, count: (this.regs.get(key)?.count ?? 0) + 1 });
  }

  /** Same semantics and errors as useMemoryBank.sw / sb. */
  writeMem({ addr, value, byte }: MemoryWrite): void {
    let w: number;
    let bits: Int32Bits;
    if (byte) {
      w = this.checkRange("SB", addr);
      bits = setByteBits(this.word(w), byteOffsetOf(addr), value);
    } else {
      if (addr % 4 !== 0) throw unalignedMem("SW", addr);
      w = this.checkRange("SW", addr);
      bits = value;
    }
    this.words.set(w, { bits, count: (this.words.get(w)?.count ?? 0) + 1 });
  }

  commitReg(name: string): void {
    release(this.regs, bare(name));
  }

  commitMem(addr: number): void {
    release(this.words, wordIndexOf(addr));
  }
}

function release<K>(map: Map<K, Pending>, key: K): void {
  const entry = map.get(key);
  if (!entry) return;
  if (entry.count <= 1) map.delete(key);
  else entry.count -= 1;
}

// ---- precompute: one instruction, all five stages -----------------------

interface Precomputed {
  /** One MachineState per stage reached; shorter than 5 if a stage errored
   * (that state is the last one and carries the error). */
  states: MachineState[];
  reads: StageRead[][];
  wires: WireId[];
  /** Program index of the next instruction, or null if this one errors. */
  nextPc: number | null;
}

/** Runs every stage of the instruction at `pc` in order, as the single-
 * cycle runner would, against `pending` — and applies its writes to
 * `pending`, so the instructions fetched after it see them. */
export function precompute(program: ProgramLine[], pc: number, pending: PendingState): Precomputed {
  const states: MachineState[] = [];
  const reads: StageRead[][] = [];
  const wires: WireId[] = [];
  const pcBits = int32.num(pc * 4);
  let vals: ValsSnapshot = {};

  for (let i = 0; i < STAGES.length; i++) {
    const stageReads: StageRead[] = [];
    reads.push(stageReads);
    const inputs: MachineInputs = {
      readReg: (name) => {
        stageReads.push({ kind: "reg", name: bare(name) });
        return pending.readReg(name);
      },
      readWord: (addr) => {
        stageReads.push({ kind: "word", addr });
        return pending.readWord(addr);
      },
      readByte: (addr) => {
        stageReads.push({ kind: "byte", addr });
        return pending.readByte(addr);
      },
    };

    let state = execStage(program, pc, STAGES[i], vals, pcBits, inputs);
    if (!state.error && state.memWrite) {
      try {
        pending.writeMem(state.memWrite);
      } catch (err) {
        state = { ...state, memWrite: null, error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (!state.error && state.regWrite) pending.writeReg(state.regWrite.name, state.regWrite.value);

    states.push(state);
    wires.push(...state.activeWires);
    if (state.error) return { states, reads, wires, nextPc: null };
    vals = state.vals;
  }

  const pcNext = states[STAGES.length - 1].pcNext;
  return { states, reads, wires, nextPc: pcNext ? int32.toNum(int32.srl(pcNext, 2)) : null };
}

// ---- The engine ------------------------------------------------------------

interface Slot extends Precomputed {
  seq: number;
  pc: number;
  stageIdx: number;
}

const ID_IDX = 1;
const EX_IDX = 2;

/** Which vals each stage produces — for merging one cycle's vals across
 * the instructions in flight: the vals table then shows what's on the
 * datapath this cycle (Decode's register reads, the ALU's operands and
 * result, Memory's address and data, write-back's value), each from the
 * instruction in that stage. */
const STAGE_VAL_KEYS: Record<CycleStage, string[]> = {
  F: [],
  D: ["REGRR1", "REGRD1", "REGRR2", "REGRD2", "REGWR"],
  A: ["ALUop1", "ALUop2", "ALUres"],
  M: ["MEMAddr", "MEMWD", "MEMRD"],
  R: ["REGWD"],
};

function mergedVals(slots: PipelineSlotView[]): ValsSnapshot {
  const vals: ValsSnapshot = {};
  for (const slot of slots) {
    for (const key of STAGE_VAL_KEYS[slot.stage]) {
      const v = slot.state.vals[key];
      if (v) vals[key] = v;
    }
  }
  return vals;
}

export class PipelineEngine {
  private slots: Slot[] = [];
  /** Stage index of each bubble in flight. */
  private bubbles: number[] = [];
  private nextPc: number | null = 0;
  private seq = 0;
  private halted = false;
  private pcParked = false;
  private readonly program: ProgramLine[];
  private readonly pending: PendingState;

  constructor(program: ProgramLine[], base: BaseReaders) {
    this.program = program;
    this.pending = new PendingState(base);
  }

  private canFetch(): boolean {
    return this.nextPc !== null && canRun(this.program, this.nextPc);
  }

  /** The hazard detection unit, on the current (pre-step) pipeline: a load
   * in EX that the instruction in ID depends on. */
  private loadUseHazard(): boolean {
    const ex = this.slots.find((s) => s.stageIdx === EX_IDX);
    const id = this.slots.find((s) => s.stageIdx === ID_IDX);
    const exState = ex?.states[EX_IDX];
    const idState = id?.states[ID_IDX];
    return !!exState && !!idState && isLoadUseHazard(exState, idState);
  }

  /** False once every instruction has left the pipeline and there's
   * nothing left to fetch, or after an error. */
  canStep(): boolean {
    return !this.halted && (this.slots.some((s) => s.stageIdx < STAGES.length - 1) || this.canFetch());
  }

  /** Runs one clock cycle. With `stallOnLoadUse`, a load-use hazard
   * detected this cycle makes it a stall cycle (see the header). */
  step(stallOnLoadUse = false): CycleResult | null {
    if (!this.canStep()) return null;
    const effects: CycleEffects = { regReads: [], memReads: [], memWrites: [], regWrites: [], pc: null };
    const stall = stallOnLoadUse && this.loadUseHazard();

    // Everything in flight advances one stage; whatever just finished
    // write-back leaves. On a stall, IF and ID hold (PCWrite = IF/IDWrite =
    // 0) and a bubble takes the place of the instruction that would have
    // entered EX.
    const advances = (stageIdx: number) => !stall || stageIdx >= EX_IDX;
    this.slots = this.slots
      .map((s) => (advances(s.stageIdx) ? { ...s, stageIdx: s.stageIdx + 1 } : s))
      .filter((s) => s.stageIdx < STAGES.length);
    this.bubbles = this.bubbles.map((b) => b + 1).filter((b) => b < STAGES.length);
    if (stall) this.bubbles.push(EX_IDX);

    // The next instruction enters Fetch (not on a stall: IF is still busy).
    if (stall) {
      // PC holds.
    } else if (this.canFetch()) {
      const pc = this.nextPc as number;
      const pre = precompute(this.program, pc, this.pending);
      this.slots.push({ seq: this.seq++, pc, stageIdx: 0, ...pre });
      this.nextPc = pre.nextPc;
      effects.pc = int32.num(pc * 4);
    } else if (this.nextPc !== null && !this.pcParked) {
      // Ran off the end: $pc shows where fetching stopped, as the single-
      // cycle mode leaves it after the last instruction.
      effects.pc = int32.num(this.nextPc * 4);
      this.pcParked = true;
    }

    // Each in-flight instruction performs its stage (a held one redoes
    // it — real hardware re-decodes the instruction in IF/ID too).
    let error: string | null = null;
    let errorSlot: Slot | null = null;
    for (const slot of this.slots) {
      const state = slot.states[slot.stageIdx];
      for (const read of slot.reads[slot.stageIdx]) {
        if (read.kind === "reg") effects.regReads.push(read.name);
        else effects.memReads.push({ addr: read.addr, byte: read.kind === "byte" });
      }
      if (state.memWrite) {
        effects.memWrites.push(state.memWrite);
        this.pending.commitMem(state.memWrite.addr);
      }
      if (state.regWrite) {
        effects.regWrites.push(state.regWrite);
        this.pending.commitReg(state.regWrite.name);
      }
      if (state.error && !error) {
        error = state.error;
        errorSlot = slot;
      }
    }
    if (error) this.halted = true;

    const views: PipelineSlotView[] = this.slots.map((s) => ({
      seq: s.seq,
      pc: s.pc,
      op: s.states[s.stageIdx].op,
      stage: STAGES[s.stageIdx],
      state: s.states[s.stageIdx],
      wires: s.wires,
      stalled: stall && s.stageIdx < EX_IDX,
    }));
    const oldest = this.slots.reduce((a, b) => (b.stageIdx > a.stageIdx ? b : a));
    const focus = errorSlot ?? oldest;
    const summary: MachineState = { ...focus.states[focus.stageIdx], vals: mergedVals(views), error };
    return { slots: views, bubbles: this.bubbles.map((b) => STAGES[b]), effects, summary, error };
  }
}