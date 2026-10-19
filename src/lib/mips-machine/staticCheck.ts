/**
 * Assembly-time checks for errors that used to surface only at run time,
 * once execution reached them. Each throws a CompileError carrying the
 * offending source line, so App's Assemble handler reports it the same way
 * as a syntax error (console message + red marker on that line) — and,
 * where the run-time version of the error exists, with the very same
 * message text.
 *
 *   checkSource(text, data)            before assemble():
 *     - `la`: not implemented by the assembler yet (see mips-util's
 *       assemble() notes). It used to throw a plain Error with no line,
 *       so the editor marked line 1 instead of the `la`.
 *
 *   checkProgram(program, locs, data, memSize)   after assemble():
 *     - The .data segment must fit in memory. Loading it used to fail
 *       inside App's initializeMemory() with no line (line 1 marked).
 *     - Every lw/sw/lb/sb whose address is known at assembly time must be
 *       in range and (lw/sw) word-aligned — e.g. `lw $v1, -100($zero)`
 *       gives "Address -100 is out of range in LW", exactly as running it
 *       would.
 *
 * "Known at assembly time" — a constant-propagation pass over the program's
 * control-flow graph:
 *   - At the program's start only $zero is known (0): every other register
 *     keeps whatever value it had before Assemble, which isn't part of the
 *     program.
 *   - Each instruction's effect is computed by running the interpreter's
 *     own execStage() for its F, D and A stages, so the arithmetic can't
 *     drift from what actually executes. Registers whose value isn't known
 *     are fed stand-in values; the instruction is evaluated several times
 *     with different, independent stand-ins, and a result counts as known
 *     only if it comes out identical every time (so it doesn't depend on
 *     any unknown register — e.g. `sub $t0, $t1, $t1` is known to be 0).
 *   - Loads always produce an unknown value (memory contents can change).
 *   - Where control flow merges (branch targets, loop heads), a register
 *     stays known only if it has the same value along every incoming path,
 *     so a check never fires for an address that could differ between
 *     iterations.
 *   - Instructions no path reaches (code after an endless loop) are still
 *     checked, assuming nothing but $zero — so an address that is wrong no
 *     matter what the registers hold, like -100($zero), is always caught.
 *
 * (Writes to $zero, including `lui $zero`, are rejected by the assembler
 * itself: mips-util's check$dst_zero.)
 *
 * Errors that depend on values only known while running (an address
 * computed from a loaded word, or from a register you edit mid-run) can't
 * be found here; they still stop the run when reached — and can then be
 * fixed and resumed (see useMachineHistory's planResume()).
 */
import { int32, type Int32Bits } from "../Numbers/int32";
import { CompileError } from "../Numbers/err";
import { execStage, type MachineInputs, type ProgramLine } from "./interpreter";
import { ctrlValue, isKnownOp } from "./ctrl";
import { REGISTERS } from "../mips-isa/registers";
import { outOfRangeMem, unalignedMem, wordIndexOf } from "./memoryWords";
import type { CycleStage, ValsSnapshot } from "./machineState";
import type { DataDecl, NumNode, TextLine } from "../mips-parser/ast";

// ---- Source-level checks -------------------------------------------------

export function checkSource(text: TextLine[], _data: DataDecl[] | null): void {
  for (const line of text) {
    const inst = line.prop.inst;
    if (inst === null) continue;
    const loc = line.prop.loc;
    if (inst.prop.type === "V") {
      throw new CompileError(
        `"la" (load address) is not supported yet, at line ${loc} — load the address with lui/ori, or use addi from $zero`,
        "check",
        [inst, loc],
        loc,
      );
    }
  }
}

// ---- .data must fit in memory ---------------------------------------------

/** Mirrors App's initializeMemory() / mips-util's layoutData(): ints are
 * stored with sw, bytes and strings with sb, each declaration padded to a
 * 4-byte boundary. The error is the one that store would throw. */
function checkDataFits(data: DataDecl[] | null, memSize: number): void {
  if (data === null) return;
  let addr = 0;
  for (const decl of data) {
    let size: number;
    switch (decl.prop.type) {
      case "int":
        size = 4 * (decl.prop.vals as NumNode[]).length;
        break;
      case "byte":
        size = 4 * Math.ceil((decl.prop.vals as NumNode[]).length / 4);
        break;
      case "str":
        size = 4 * Math.ceil(((decl.prop.vals as string).length + 1) / 4);
        break;
    }
    if (addr + size > memSize) {
      const firstBad = Math.max(addr, memSize);
      const err = outOfRangeMem(decl.prop.type === "int" ? "SW" : "SB", firstBad);
      throw new CompileError(err.message, "check", [decl, firstBad], decl.prop.loc);
    }
    addr += size;
  }
}

// ---- Constant propagation ---------------------------------------------------

/** Registers with a known value, by bare name. Absent = unknown. */
type Known = Map<string, Int32Bits>;

const TRIALS = 6;
const EVAL_STAGES: CycleStage[] = ["F", "D", "A"];

/** Small deterministic PRNG, so assembling the same program always gives
 * the same result. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

/** stand-ins[trial][register name]: trial 0 = all zeros, trial 1 = all
 * ones, the rest random — each register independently. */
const STAND_INS: Record<string, Int32Bits>[] = (() => {
  const rand = mulberry32(0x5eed1234);
  return Array.from({ length: TRIALS }, (_, t) =>
    Object.fromEntries(
      REGISTERS.map((r) => {
        const v = t === 0 ? 0 : t === 1 ? 0xffffffff : Math.floor(rand() * 4294967296);
        return [r.name, int32.hex(hex8(v))];
      }),
    ),
  );
})();

const same = (a: Int32Bits, b: Int32Bits) => a.join("") === b.join("");

/** Thrown by memory reads during evaluation: loaded values are unknown. */
class UnknownValue extends Error {}

interface Evaluated {
  /** The vals after stage A, from the first trial (fields-only values like
   * REGWR are the same in every trial). Null if a stage failed. */
  vals: ValsSnapshot | null;
  /** ALUres, if identical in every trial. */
  aluRes: Int32Bits | null;
}

function evaluate(program: ProgramLine[], i: number, known: Known): Evaluated {
  const pcBits = int32.num(i * 4);
  let first: ValsSnapshot | null = null;
  let aluRes: Int32Bits | null = null;
  for (let t = 0; t < TRIALS; t++) {
    const inputs: MachineInputs = {
      readReg: (name) => known.get(name) ?? STAND_INS[t][name] ?? int32.num(0),
      readWord: () => {
        throw new UnknownValue();
      },
      readByte: () => {
        throw new UnknownValue();
      },
    };
    let vals: ValsSnapshot = {};
    for (const stage of EVAL_STAGES) {
      const state = execStage(program, i, stage, vals, pcBits, inputs);
      if (state.error) return { vals: null, aluRes: null };
      vals = state.vals;
    }
    const res = vals.ALUres ?? null;
    if (t === 0) {
      first = vals;
      aluRes = res;
    } else if (aluRes !== null && (res === null || !same(aluRes, res))) {
      aluRes = null;
    }
  }
  return { vals: first, aluRes };
}

const NAME_OF_NUM: Record<number, string> = Object.fromEntries(
  REGISTERS.filter((r) => r.num !== null).map((r) => [r.num as number, r.name]),
);

/** The registers known after instruction i runs. */
function transfer(program: ProgramLine[], i: number, known: Known, ev: Evaluated): Known {
  const op = program[i].op;
  const out = new Map(known);
  if (!isKnownOp(op) || ctrlValue("RegWrite", op) !== 1) return out;
  const dstNum = ev.vals?.REGWR ? int32.toNum(ev.vals.REGWR) : null;
  const dst = dstNum === null ? undefined : NAME_OF_NUM[dstNum];
  if (dst === undefined) {
    // Can't tell which register it writes: forget everything but $zero.
    return new Map([["zero", int32.num(0)]]);
  }
  if (dst === "zero") return out;
  const value = ctrlValue("MemToReg", op) === 1 ? null : ev.aluRes;
  if (value) out.set(dst, value);
  else out.delete(dst);
  return out;
}

/** Program indices control can go to after instruction i (indices off the
 * end, where the program stops, are left out). Uses execStage's own
 * write-back stage: a branch is tried both taken (ALUres 0) and not. */
function successors(program: ProgramLine[], i: number, vals: ValsSnapshot | null): number[] {
  const op = program[i].op;
  if (!isKnownOp(op)) return [];
  const branch = ctrlValue("Branch", op) === 1;
  const jump = ctrlValue("Jump", op) === 1;
  let next: number[] = [i + 1];
  if (branch || jump) {
    next = [];
    const noRead: MachineInputs = { readReg: () => int32.num(0), readWord: () => int32.num(0), readByte: () => int32.num(0) };
    for (const res of branch ? [0, 1] : [0]) {
      const state = execStage(program, i, "R", { ...(vals ?? {}), ALUres: int32.num(res) }, int32.num(i * 4), noRead);
      if (state.pcNext) next.push(int32.toNum(int32.srl(state.pcNext, 2)));
    }
  }
  return next.filter((n, k, all) => n >= 0 && n < program.length && all.indexOf(n) === k);
}

/** Registers known on entry to each instruction (undefined = no path
 * reaches it). */
function propagate(program: ProgramLine[]): (Known | undefined)[] {
  const entry: (Known | undefined)[] = new Array(program.length);
  if (program.length === 0) return entry;
  entry[0] = new Map([["zero", int32.num(0)]]);
  const work = [0];
  while (work.length > 0) {
    const i = work.pop() as number;
    const known = entry[i] as Known;
    const ev = evaluate(program, i, known);
    const out = transfer(program, i, known, ev);
    for (const s of successors(program, i, ev.vals)) {
      const prev = entry[s];
      if (prev === undefined) {
        entry[s] = new Map(out);
        work.push(s);
        continue;
      }
      // Join: keep a register only if it's known, and equal, both ways.
      let changed = false;
      for (const [name, bits] of prev) {
        const other = out.get(name);
        if (!other || !same(other, bits)) {
          prev.delete(name);
          changed = true;
        }
      }
      if (changed) work.push(s);
    }
  }
  return entry;
}

// ---- Memory addresses ----------------------------------------------------------

/** The run-time error this access would raise, if any — the same checks,
 * in the same order, as useMemoryBank's lw/sw/lb/sb (and pipeline.ts's
 * PendingState). */
function memoryError(op: string, addr: number, memSize: number): Error | null {
  const OP = op.toUpperCase();
  const byte = isKnownOp(op) && ctrlValue("MemByte", op) === 1;
  if (!byte && addr % 4 !== 0) return unalignedMem(OP, addr);
  const w = wordIndexOf(addr);
  if (w < 0 || w >= Math.floor(memSize / 4)) return outOfRangeMem(OP, addr);
  return null;
}

/**
 * Checks the assembled program; throws a CompileError for the first
 * problem, at its source line. `locs[i]` is program[i]'s 1-based source
 * line (AssembledLine.prop.loc).
 */
export function checkProgram(
  program: ProgramLine[],
  locs: number[],
  data: DataDecl[] | null,
  memSize: number,
): void {
  checkDataFits(data, memSize);

  const entry = propagate(program);
  const unreached: Known = new Map([["zero", int32.num(0)]]);
  for (let i = 0; i < program.length; i++) {
    const op = program[i].op;
    if (!isKnownOp(op) || (ctrlValue("MemRead", op) !== 1 && ctrlValue("MemWrite", op) !== 1)) continue;
    const ev = evaluate(program, i, entry[i] ?? unreached);
    if (!ev.aluRes) continue;
    const err = memoryError(op, int32.toNum(ev.aluRes), memSize);
    if (err) throw new CompileError(err.message, "check", [op, locs[i]], locs[i]);
  }
}