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
 * Early branches (step(true, true)): branches compare their registers in
 * ID, so a branch in ID whose rs or rt is still being produced stalls —
 *   - one cycle for an instruction in EX that writes it (then its result is
 *     forwarded from EX/MEM), and
 *   - one more if that producer is a load, which only has its data at the
 *     end of MEM (a load in MEM stalls the branch too; then the data is
 *     forwarded from MEM/WB).
 * See stallReason(). Without early branches, a branch is just an ALU
 * instruction for hazard purposes: its operands are forwarded in EX like
 * anyone else's, and only the load-use rule can stall it.
 *
 * Branch prediction (step(true, ...)): predict not taken. The instructions
 * after a branch or jump are always fetched next. If it turns out taken,
 * every instruction fetched behind it is on the wrong path, and is flushed
 * when the branch resolves (each becomes a bubble), then the target is
 * fetched. Where it resolves decides the cost:
 *   - early branches: in ID, by the comparator there, so one instruction
 *     (in IF) is flushed;
 *   - otherwise: in MEM, where MUX 4/5 sit after EX/MEM, so three are
 *     (in IF, ID and EX).
 * The engine already knows each instruction's real next PC (precompute), so
 * wrong-path instructions are fetched as "doomed" slots: their IF, ID and
 * EX stages are computed against the pending state, but never MEM or WB,
 * so they read registers but can't change anything.
 *
 * Starting $pc: instructions are identified by program index (0, 1, 2…)
 * throughout, but the program's first instruction sits at byte address
 * `textBase` (App.tsx's "Starting $pc" field, default 0). addressOf() and
 * programIndexOf() convert between the two; useMachineHistory uses the
 * same helpers in single-cycle mode.
 *
 * Timeline scrubbing: snapshot() captures the engine's complete state
 * between cycles, and PipelineEngine.restore() builds an engine back from
 * one, so useMachineHistory can rewind to any earlier cycle and carry on
 * from there (e.g. after the hazard toggles change).
 *
 * Pure: no React, no banks — reads come in through BaseReaders.
 */
import { int32, type Int32Bits } from "../Numbers/int32";
import * as bit from "../Numbers/bit";
import { canRun, execStage, type MachineInputs, type ProgramLine } from "./interpreter";
import { ctrlValue, isKnownOp } from "./ctrl";
import type { CycleStage, MachineState, MemoryWrite, RegisterWrite, ValsSnapshot } from "./machineState";
import type { ValKey } from "./vals";
import type { WireId } from "./datapath";
import { unalignedMem, outOfRangeMem, wordIndexOf, byteOffsetOf, getByteBits, setByteBits } from "./memoryWords";

export const STAGES: CycleStage[] = ["F", "D", "A", "M", "R"];

// ---- Program index <-> byte address -----------------------------------------

/** The byte address of the instruction at program index `pc`, for a
 * program whose first instruction is at byte address `textBase`. */
export function addressOf(pc: number, textBase = 0): Int32Bits {
  return int32.num((textBase + pc * 4) | 0);
}

/** The program index of the instruction at byte address `addr` (negative,
 * or past the end of the program, if `addr` is outside it — canRun() then
 * says so). */
export function programIndexOf(addr: Int32Bits, textBase = 0): number {
  return ((int32.toNum(addr) - textBase) | 0) >> 2;
}

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
  /** True if it's held in IF or ID by a stall this cycle (it's redoing the
   * stage it was already in). */
  stalled: boolean;
  /** True if it's the wrong-path instruction in IF behind a taken branch or
   * jump that resolves in ID this cycle: it'll be flushed at the end of the
   * cycle. */
  flushed: boolean;
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

/** Why the instruction in ID must stall this cycle, if it must:
 *   - "branch-ex":  it's a branch, and the instruction in EX writes one of
 *                   its registers (an ALU result one cycle away, or a load);
 *   - "branch-mem": it's a branch, and the instruction in MEM is a load
 *                   writing one of its registers;
 *   - "load-use":   the slides' load-use condition (a load in EX).
 * Arguments are each stage's MachineState, if occupied. */
export type StallReason = "branch-ex" | "branch-mem" | "load-use";

export function isBranchOp(op: string): boolean {
  return isKnownOp(op) && ctrlValue("Branch", op) === 1;
}

export function isJumpOp(op: string): boolean {
  return isKnownOp(op) && ctrlValue("Jump", op) === 1;
}

/** The register `s` will write, if it writes one (RegWrite, not $zero). */
export function destReg(s: MachineState | undefined): number | null {
  if (!s || s.error || !isKnownOp(s.op) || ctrlValue("RegWrite", s.op) !== 1) return null;
  const wr = s.vals.REGWR ? int32.toNum(s.vals.REGWR) : 0;
  return wr === 0 ? null : wr;
}

export function stallReason(
  id?: MachineState,
  ex?: MachineState,
  mem?: MachineState,
  earlyBranch = true,
): StallReason | null {
  if (!id || id.error) return null;
  if (earlyBranch && isBranchOp(id.op)) {
    const srcs = [int32.toNum(id.fields.rs), int32.toNum(id.fields.rt)];
    const exDest = destReg(ex);
    if (exDest !== null && srcs.includes(exDest)) return "branch-ex";
    const memDest = destReg(mem);
    if (mem && memDest !== null && isKnownOp(mem.op) && ctrlValue("MemRead", mem.op) === 1 && srcs.includes(memDest)) return "branch-mem";
    return null;
  }
  if (ex && isLoadUseHazard(ex, id)) return "load-use";
  return null;
}

// ---- PendingState: committed state + in-flight writes -------------------

export interface Pending {
  bits: Int32Bits;
  /** In-flight writes to this location not yet committed to the real
   * bank. The entry is dropped when this reaches 0, so the real bank is
   * the source of truth again (and any manual edit made in the register or
   * memory table between steps is respected). */
  count: number;
}

/** A PendingState's in-flight writes, copied — see snapshot()/load(). */
export interface PendingSnapshot {
  regs: [string, Pending][];
  words: [number, Pending][];
}

function copyEntries<K>(map: Map<K, Pending>): [K, Pending][] {
  return [...map].map(([k, v]) => [k, { ...v }]);
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

  /** A copy of the in-flight writes (entries are copied too: release()
   * mutates their counts in place). */
  snapshot(): PendingSnapshot {
    return { regs: copyEntries(this.regs), words: copyEntries(this.words) };
  }

  /** Replaces the in-flight writes with a copy of `snap`'s. */
  load(snap: PendingSnapshot): void {
    this.regs = new Map(snap.regs.map(([k, v]) => [k, { ...v }]));
    this.words = new Map(snap.words.map(([k, v]) => [k, { ...v }]));
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

export interface Precomputed {
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
 * `pending`, so the instructions fetched after it see them. `textBase` is
 * the byte address of the program's first instruction. */
export function precompute(program: ProgramLine[], pc: number, pending: PendingState, textBase = 0): Precomputed {
  const states: MachineState[] = [];
  const reads: StageRead[][] = [];
  const wires: WireId[] = [];
  const pcBits = addressOf(pc, textBase);
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
  return { states, reads, wires, nextPc: pcNext ? programIndexOf(pcNext, textBase) : null };
}

// ---- The engine ------------------------------------------------------------

export interface Slot extends Precomputed {
  seq: number;
  pc: number;
  stageIdx: number;
  /** A wrong-path fetch behind a taken branch/jump: flushed when the
   * branch resolves, before it can reach MEM. */
  doomed?: boolean;
  /** A taken branch or jump fetched with prediction on: when it reaches
   * the stage it resolves in, the doomed slots behind it are flushed. */
  redirect?: boolean;
}

/** Everything a PipelineEngine holds between cycles — see snapshot(). */
export interface PipelineEngineSnapshot {
  slots: Slot[];
  bubbles: number[];
  nextPc: number | null;
  predictPc: number | null;
  awaitingRedirect: boolean;
  seq: number;
  halted: boolean;
  pcParked: boolean;
  pending: PendingSnapshot;
}

const ID_IDX = 1;
const EX_IDX = 2;
const MEM_IDX = 3;

/** A wrong-path instruction's IF, ID and EX stages (all it can reach before
 * a flush), against `pending` — reads only. Stops early if a stage errors. */
function precomputeDoomed(program: ProgramLine[], pc: number, pending: PendingState, textBase = 0): Precomputed {
  const states: MachineState[] = [];
  const reads: StageRead[][] = [];
  const wires: WireId[] = [];
  const pcBits = addressOf(pc, textBase);
  let vals: ValsSnapshot = {};
  for (let i = 0; i <= EX_IDX; i++) {
    const stageReads: StageRead[] = [];
    reads.push(stageReads);
    const inputs: MachineInputs = {
      readReg: (name) => {
        stageReads.push({ kind: "reg", name: bare(name) });
        return pending.readReg(name);
      },
      readWord: () => int32.num(0),
      readByte: () => int32.num(0),
    };
    const state = execStage(program, pc, STAGES[i], vals, pcBits, inputs);
    if (state.error) break;
    states.push(state);
    wires.push(...state.activeWires);
    vals = state.vals;
  }
  return { states, reads, wires, nextPc: null };
}

/** A slot's state for its current stage (a doomed slot whose later stage
 * errored keeps showing its last good one). */
function stateOf(s: Slot): MachineState {
  return s.states[Math.min(s.stageIdx, s.states.length - 1)];
}

/** Which vals each stage produces — for merging one cycle's vals across
 * the instructions in flight: the vals table then shows what's on the
 * datapath this cycle (Decode's register reads, the ALU's operands and
 * result, Memory's address and data, write-back's value), each from the
 * instruction in that stage. Typed with ValKey, so a misspelt key here is a
 * compile error rather than a value that silently never shows. */
const STAGE_VAL_KEYS: Record<CycleStage, readonly ValKey[]> = {
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
  /** While a taken branch/jump is unresolved (prediction on): the next
   * not-taken successor to fetch, as a doomed slot. */
  private predictPc: number | null = null;
  /** True from fetching a taken branch/jump until it resolves: the real
   * target (nextPc) mustn't be fetched before then. */
  private awaitingRedirect = false;
  private seq = 0;
  private halted = false;
  private pcParked = false;
  private readonly program: ProgramLine[];
  private readonly pending: PendingState;
  /** Byte address of the program's first instruction (the starting $pc). */
  private readonly textBase: number;

  constructor(program: ProgramLine[], base: BaseReaders, textBase = 0) {
    this.program = program;
    this.pending = new PendingState(base);
    this.textBase = textBase;
  }

  /** A copy of this engine's whole state between cycles. Slots are copied
   * (step() flips `redirect` on them in place); their precomputed states,
   * reads and wires are never mutated, so those are shared. */
  snapshot(): PipelineEngineSnapshot {
    return {
      slots: this.slots.map((s) => ({ ...s })),
      bubbles: [...this.bubbles],
      nextPc: this.nextPc,
      predictPc: this.predictPc,
      awaitingRedirect: this.awaitingRedirect,
      seq: this.seq,
      halted: this.halted,
      pcParked: this.pcParked,
      pending: this.pending.snapshot(),
    };
  }

  /** A new engine in the state `snap` was taken in. `snap` itself is left
   * untouched, so it can be restored again later. */
  static restore(program: ProgramLine[], base: BaseReaders, snap: PipelineEngineSnapshot, textBase = 0): PipelineEngine {
    const engine = new PipelineEngine(program, base, textBase);
    engine.slots = snap.slots.map((s) => ({ ...s }));
    engine.bubbles = [...snap.bubbles];
    engine.nextPc = snap.nextPc;
    engine.predictPc = snap.predictPc;
    engine.awaitingRedirect = snap.awaitingRedirect;
    engine.seq = snap.seq;
    engine.halted = snap.halted;
    engine.pcParked = snap.pcParked;
    engine.pending.load(snap.pending);
    return engine;
  }

  private canFetch(): boolean {
    return this.nextPc !== null && canRun(this.program, this.nextPc);
  }

  private stateAt(stageIdx: number): MachineState | undefined {
    return this.slots.find((s) => s.stageIdx === stageIdx && !s.doomed)?.states[stageIdx];
  }

  /** The hazard detection unit, on the current pipeline (see stallReason).
   * Wrong-path instructions never cause stalls: they're flushed first. */
  private hazard(earlyBranch: boolean): StallReason | null {
    return stallReason(this.stateAt(ID_IDX), this.stateAt(EX_IDX), this.stateAt(MEM_IDX), earlyBranch);
  }

  /** The taken branch/jump that resolves this cycle, if any: it has reached
   * its resolving stage (ID with early branches, else MEM). `>=` so one
   * already past it — if early branches were switched on mid-flight —
   * still resolves. */
  private resolving(earlyBranch: boolean): Slot | undefined {
    const at = earlyBranch ? ID_IDX : MEM_IDX;
    return this.slots.find((s) => s.redirect && s.stageIdx >= at);
  }

  /** Whether this cycle stalls and/or flushes. With early branches a branch
   * waiting on its operands can't resolve, so a stall wins; otherwise the
   * branch resolves in MEM and everything behind it is on the wrong path,
   * so the flush wins (and no stall is needed for wrong-path work). */
  private decide(hazardUnit: boolean, earlyBranch: boolean): { stall: boolean; resolving: Slot | undefined } {
    const hazard = hazardUnit && this.hazard(earlyBranch) !== null;
    const resolving = this.resolving(earlyBranch);
    if (earlyBranch) return { stall: hazard, resolving: hazard ? undefined : resolving };
    return { stall: !resolving && hazard, resolving };
  }

  /** False once every instruction has left the pipeline and there's
   * nothing left to fetch, or after an error. */
  canStep(): boolean {
    return !this.halted && (this.slots.some((s) => s.stageIdx < STAGES.length - 1) || this.canFetch());
  }

  /** Runs one clock cycle. `hazardUnit` turns on the hazard detection unit
   * (stalls) and predict-not-taken fetching, with branches resolving in ID
   * (`earlyBranch`) or MEM (see the header); off, the pipeline is ideal, as
   * if every hazard were resolved for free. */
  step(hazardUnit = false, earlyBranch = false): CycleResult | null {
    if (!this.canStep()) return null;
    const effects: CycleEffects = { regReads: [], memReads: [], memWrites: [], regWrites: [], pc: null };
    const { stall, resolving } = this.decide(hazardUnit, earlyBranch);

    // A taken branch or jump resolving flushes every wrong-path instruction
    // behind it; each leaves a bubble where it would have advanced to.
    const flushedAt: number[] = [];
    if (resolving) {
      resolving.redirect = false;
      this.awaitingRedirect = false;
      this.predictPc = null;
      for (const s of this.slots) if (s.doomed) flushedAt.push(s.stageIdx + 1);
      this.slots = this.slots.filter((s) => !s.doomed);
    }

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
    this.bubbles.push(...flushedAt);

    // The next instruction enters Fetch (not on a stall: IF is still busy).
    if (stall) {
      // PC holds.
    } else if (this.awaitingRedirect) {
      // Predicted not taken: fetch the next instruction in sequence, which
      // is the wrong one (or nothing, past the end of the program).
      const pc = this.predictPc;
      if (pc !== null && canRun(this.program, pc)) {
        this.slots.push({
          seq: this.seq++,
          pc,
          stageIdx: 0,
          ...precomputeDoomed(this.program, pc, this.pending, this.textBase),
          doomed: true,
        });
        this.predictPc = pc + 1;
        effects.pc = addressOf(pc, this.textBase);
      } else {
        this.predictPc = null;
      }
    } else if (this.canFetch()) {
      const pc = this.nextPc as number;
      const pre = precompute(this.program, pc, this.pending, this.textBase);
      const op = pre.states[0]?.op ?? "";
      // A taken branch or jump: the not-taken prediction will be wrong.
      const redirect = hazardUnit && pre.nextPc !== null && pre.nextPc !== pc + 1 && (isBranchOp(op) || isJumpOp(op));
      this.slots.push({ seq: this.seq++, pc, stageIdx: 0, ...pre, redirect });
      this.nextPc = pre.nextPc;
      effects.pc = addressOf(pc, this.textBase);
      if (redirect) {
        this.awaitingRedirect = true;
        this.predictPc = pc + 1;
      }
    } else if (this.nextPc !== null && !this.pcParked) {
      // Ran off the end: $pc shows where fetching stopped, as the single-
      // cycle mode leaves it after the last instruction.
      effects.pc = addressOf(this.nextPc, this.textBase);
      this.pcParked = true;
    }

    // Each in-flight instruction performs its stage (a held one redoes
    // it — real hardware re-decodes the instruction in IF/ID too). Wrong-
    // path instructions only ever read.
    let error: string | null = null;
    let errorSlot: Slot | null = null;
    for (const slot of this.slots) {
      const state = stateOf(slot);
      for (const read of slot.reads[slot.stageIdx] ?? []) {
        if (read.kind === "reg") effects.regReads.push(read.name);
        else effects.memReads.push({ addr: read.addr, byte: read.kind === "byte" });
      }
      if (slot.doomed) continue;
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

    // Doomed slots are flushed at the end of this cycle if their branch
    // resolves then.
    const flushNext = !!this.decide(hazardUnit, earlyBranch).resolving;
    const views: PipelineSlotView[] = this.slots.map((s) => ({
      seq: s.seq,
      pc: s.pc,
      op: stateOf(s).op,
      stage: STAGES[s.stageIdx],
      state: stateOf(s),
      wires: s.wires,
      stalled: stall && s.stageIdx < EX_IDX,
      flushed: !!s.doomed && flushNext,
    }));
    const oldest = this.slots.reduce((a, b) => (b.stageIdx > a.stageIdx ? b : a));
    const focus = errorSlot ?? oldest;
    const summary: MachineState = { ...stateOf(focus), vals: mergedVals(views), error };
    return { slots: views, bubbles: this.bubbles.map((b) => STAGES[b]), effects, summary, error };
  }
}