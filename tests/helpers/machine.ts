/**
 * A plain-object machine (registers + word memory) and two drivers that run a
 * program on it the same way the app does:
 *
 *   - runSingleCycle(): the F/D/A/M/R loop from useMachineHistory's
 *     stepSingle(), applying each stage's reported regWrite/memWrite/pcNext.
 *   - runPipeline():    PipelineEngine.step() per clock cycle, applying the
 *     CycleEffects the way useMachineHistory's stepPipeline() does.
 *
 * Both work without React, so the interpreter and pipeline can be tested as
 * the pure modules they are. Memory reads/writes use the same memoryWords
 * helpers (and so the same errors) as useMemoryBank.
 */
import { int32, type Int32Bits } from "../../src/lib/Numbers/int32";
import * as bit from "../../src/lib/Numbers/bit";
import { REGISTERS } from "../../src/lib/mips-isa/registers";
import { canRun, execStage, type MachineInputs, type ProgramLine } from "../../src/lib/mips-machine/interpreter";
import type { CycleStage, MachineState, MemoryWrite, ValsSnapshot } from "../../src/lib/mips-machine/machineState";
import { PipelineEngine, addressOf, programIndexOf, type BaseReaders, type CycleResult } from "../../src/lib/mips-machine/pipeline";
import {
  byteOffsetOf, getByteBits, outOfRangeMem, setByteBits, unalignedMem, wordIndexOf,
} from "../../src/lib/mips-machine/memoryWords";
import { assemble, check } from "../../src/lib/mips-parser/mips-util";
import type { DataDecl, NumNode, TextLine } from "../../src/lib/mips-parser/ast";

const STAGES: CycleStage[] = ["F", "D", "A", "M", "R"];

export class TestMachine {
  regs: Record<string, Int32Bits>;
  mem: Int32Bits[];
  readonly memSize: number;

  constructor(memSize = 256) {
    this.memSize = memSize;
    this.regs = Object.fromEntries(REGISTERS.map((r) => [r.name, int32.num(0)]));
    this.mem = Array.from({ length: Math.floor(memSize / 4) }, () => int32.num(0));
  }

  /** Register value as a signed number. */
  reg(name: string): number {
    return int32.toNum(this.regs[name.replace(/^\$/, "")]);
  }

  setReg(name: string, value: number): this {
    this.regs[name.replace(/^\$/, "")] = int32.num(value);
    return this;
  }

  /** Word `index` (byte address / 4) as a signed number. */
  word(index: number): number {
    return int32.toNum(this.mem[index]);
  }

  setWord(index: number, value: number): this {
    this.mem[index] = int32.num(value);
    return this;
  }

  private checkRange(op: string, addr: number): number {
    const w = wordIndexOf(addr);
    if (w < 0 || w >= this.mem.length) throw outOfRangeMem(op, addr);
    return w;
  }

  lw(addr: number): Int32Bits {
    if (addr % 4 !== 0) throw unalignedMem("LW", addr);
    return this.mem[this.checkRange("LW", addr)];
  }

  lb(addr: number): Int32Bits {
    const w = this.checkRange("LB", addr);
    return bit.sign(getByteBits(this.mem[w], byteOffsetOf(addr)), 32);
  }

  sw(addr: number, value: Int32Bits): void {
    if (addr % 4 !== 0) throw unalignedMem("SW", addr);
    this.mem[this.checkRange("SW", addr)] = value;
  }

  sb(addr: number, value: Int32Bits): void {
    const w = this.checkRange("SB", addr);
    this.mem[w] = setByteBits(this.mem[w], byteOffsetOf(addr), value);
  }

  write(w: MemoryWrite): void {
    if (w.byte) this.sb(w.addr, w.value);
    else this.sw(w.addr, w.value);
  }

  /** For execStage. */
  inputs(): MachineInputs {
    return {
      readReg: (name) => this.regs[name.replace(/^\$/, "")],
      readWord: (addr) => this.lw(addr),
      readByte: (addr) => this.lb(addr),
    };
  }

  /** For PipelineEngine / PendingState. */
  readers(): BaseReaders {
    return {
      peekReg: (name) => this.regs[name.replace(/^\$/, "")],
      peekWord: (addr) => this.mem[wordIndexOf(addr)],
      memSize: this.memSize,
    };
  }

  /** Every register and word as numbers — for comparing two machines. */
  dump(): { regs: Record<string, number>; mem: number[] } {
    return {
      regs: Object.fromEntries(Object.entries(this.regs).map(([k, v]) => [k, int32.toNum(v)])),
      mem: this.mem.map((w) => int32.toNum(w)),
    };
  }

  /** Writes a .data segment into memory exactly as App.tsx's initializeMemory() does. */
  loadData(data: DataDecl[] | null): this {
    if (data === null) return this;
    let addr = 0;
    for (const decl of data) {
      switch (decl.prop.type) {
        case "int":
          for (const v of decl.prop.vals as NumNode[]) {
            this.sw(addr, v.prop.bit);
            addr += 4;
          }
          break;
        case "byte": {
          const vals = decl.prop.vals as NumNode[];
          for (let j = 0; j < vals.length; j += 4) {
            for (let k = 0; k < 4; k++) {
              this.sb(addr, j + k < vals.length ? vals[j + k].prop.bit : int32.num(0));
              addr += 1;
            }
          }
          break;
        }
        case "str": {
          const s = (decl.prop.vals as string) + "\0";
          for (let j = 0; j < s.length; j += 4) {
            for (let k = 0; k < 4; k++) {
              this.sb(addr, j + k < s.length ? int32.num(s.charCodeAt(j + k)) : int32.num(0));
              addr += 1;
            }
          }
          break;
        }
      }
    }
    return this;
  }
}

/** check() + assemble() -> the ProgramLine[] App.tsx hands to useMachineHistory.
 * `textBase` is the starting $pc (App's "Starting $pc" field). */
export function toProgram(lines: TextLine[], data: DataDecl[] | null = null, textBase = 0): ProgramLine[] {
  check(lines, data);
  return assemble(lines, data, textBase).map((line) => ({ op: line.prop.inst.prop.op, bin: line.prop.bin }));
}

export interface SingleCycleRun {
  /** One MachineState per micro-step, in order. */
  states: MachineState[];
  /** Number of instructions that completed write-back. */
  instructions: number;
  error: string | null;
}

/** Runs to completion (or `maxSteps` micro-steps) like useMachineHistory's
 * stepSingle(), with $pc starting at `textBase` (as App's Assemble sets it). */
export function runSingleCycle(program: ProgramLine[], m: TestMachine, maxSteps = 5_000, textBase = 0): SingleCycleRun {
  const states: MachineState[] = [];
  m.regs.pc = addressOf(0, textBase);
  let pc = 0;
  let stageIdx = 0;
  let vals: ValsSnapshot = {};
  let instructions = 0;

  while (canRun(program, pc) && states.length < maxSteps) {
    const stage = STAGES[stageIdx];
    let state = execStage(program, pc, stage, vals, m.regs.pc, m.inputs());
    if (!state.error) {
      try {
        if (state.regWrite) {
          if (REGISTERS.find((r) => r.name === state.regWrite!.name)?.readonly) {
            throw new Error(`readonly ${state.regWrite.name}`);
          }
          m.regs[state.regWrite.name] = state.regWrite.value;
        }
        if (state.memWrite) m.write(state.memWrite);
      } catch (err) {
        state = { ...state, error: err instanceof Error ? err.message : String(err) };
      }
    }
    states.push(state);
    vals = state.vals;
    if (state.error) return { states, instructions, error: state.error };
    if (stage === "R") {
      if (state.pcNext) {
        m.regs.pc = state.pcNext;
        pc = programIndexOf(state.pcNext, textBase);
      }
      stageIdx = 0;
      instructions++;
    } else {
      stageIdx++;
    }
  }
  return { states, instructions, error: null };
}

export interface PipelineRun {
  cycles: CycleResult[];
  engine: PipelineEngine;
  error: string | null;
}

/** Runs to completion (or `maxCycles`) like useMachineHistory's stepPipeline(). */
export function runPipeline(
  program: ProgramLine[],
  m: TestMachine,
  hazardUnit = false,
  earlyBranch = false,
  maxCycles = 2_000,
  textBase = 0,
): PipelineRun {
  const engine = new PipelineEngine(program, m.readers(), textBase);
  return continuePipeline(engine, m, hazardUnit, earlyBranch, maxCycles);
}

export function continuePipeline(
  engine: PipelineEngine,
  m: TestMachine,
  hazardUnit = false,
  earlyBranch = false,
  maxCycles = 2_000,
): PipelineRun {
  const cycles: CycleResult[] = [];
  let error: string | null = null;
  while (cycles.length < maxCycles) {
    const result = engine.step(hazardUnit, earlyBranch);
    if (!result) break;
    cycles.push(result);
    for (const w of result.effects.memWrites) m.write(w);
    for (const w of result.effects.regWrites) m.regs[w.name] = w.value;
    if (result.effects.pc) m.regs.pc = result.effects.pc;
    if (result.error) {
      error = result.error;
      break;
    }
  }
  return { cycles, engine, error };
}

/** "F:add@0 D:- A:bubble ..." — a compact picture of one cycle, for readable assertions. */
export function describeCycle(c: CycleResult): string {
  return STAGES.map((stage) => {
    const slot = c.slots.find((s) => s.stage === stage);
    if (slot) return `${stage}:${slot.op}@${slot.pc}${slot.stalled ? "(stall)" : ""}${slot.flushed ? "(flush)" : ""}`;
    return `${stage}:${c.bubbles.includes(stage) ? "bubble" : "-"}`;
  }).join(" ");
}
