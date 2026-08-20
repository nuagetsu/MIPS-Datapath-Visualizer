/**
 * Pure port of mips.js's exec() switch statement (the F/D/A/M/R cases),
 * generalized to all 20 instruction kinds ctrl.ts now knows about, and
 * restructured so it returns data (a MachineState) instead of mutating a
 * Konva canvas + DOM tables. See machineState.ts's header comment for why.
 *
 * execStage() takes the CURRENT register/memory values via two small
 * read-only callbacks (MachineInputs) and returns the next MachineState —
 * it never writes anything itself. Register/memory/PC writes are reported
 * as plain data (regWrite/memWrite/pcNext) for a runner hook to apply
 * to the actual banks (useRegisterBank/useMemoryBank) between steps. This
 * is the "separate pure computation from visualization [and mutation]"
 * split flagged as an open question in the mips.js port notes, now made
 * concrete rather than just recommended.
 *
 * Scope note: this covers every op ctrl.ts has a full row for — i.e.
 * everything except "la" (V-type), which mips-util.ts's assemble()/
 * translate() already refuse to produce a ProgramLine for at all (it
 * throws at assembly time pending the pseudo-instruction-expansion design
 * decision noted there). A ProgramLine literally cannot contain "la" yet,
 * so execStage() never needs to handle it.
 */
import { int32, type Int32Bits } from "../Numbers/int32";
import * as bit from "../Numbers/bit";
import { RuntimeError } from "../Numbers/err";
import { REGISTERS } from "./registers";
import { ctrlValue, isKnownOp, type Kind } from "./ctrl";
import { decodeFields, decodeJumpIndex, type WireId } from "./datapath";
import type { CycleStage, MachineState, ValsSnapshot } from "./machineState";

const ZERO = int32.num(0);
const FOUR = int32.num(4);

export interface ProgramLine {
  /** Instruction mnemonic — must be one ctrl.ts recognizes. */
  op: string;
  /** Assembled 32-bit instruction. */
  bin: Int32Bits;
}

// TODO: rename?
export interface MachineInputs {
  /** Read a register's current value by bare name ("t0", "zero", "pc" —
   * no leading $). */
  readReg: (name: string) => Int32Bits;
  /** Read one word of memory at a byte address (must be 4-aligned). */
  readWord: (addr: number) => Int32Bits;
  /** Read one sign-extended byte of memory at a byte address. */
  readByte: (addr: number) => Int32Bits;
}

const NUM_TO_REG_NAME: Record<number, string> = Object.fromEntries(
  REGISTERS.filter((r) => r.num !== null).map((r) => [r.num as number, r.name]),
);


function regNameOf(num: number): string {
  const name = NUM_TO_REG_NAME[num];
  if (name === undefined) {
    throw new RuntimeError(`No register numbered ${num}`, "interpreter.ts", [num]);
  }
  return name;
}

export function canRun(program: ProgramLine[], pc: number): boolean {
  return pc >= 0 && pc < program.length;
}

/**
 * Runs one F/D/A/M/R micro-step. Caller must have already checked
 * canRun(program, pc) — this doesn't handle "off the end of the program"
 * (that's a whole-program concern for the runner hook, matching how
 * mips.js's exec() only ever gets called from a canRun()-guarded context).
 */
export function execStage(
  program: ProgramLine[],
  pc: number,
  stage: CycleStage,
  vals: ValsSnapshot,
  pcBits: Int32Bits,
  inputs: MachineInputs,
): MachineState {
  const line = program[pc];
  const op = line.op;
  const inst = line.bin;
  const fields = decodeFields(inst);

  const base: Pick<MachineState, "stage" | "pc" | "op" | "inst" | "fields"> = {
    stage,
    pc,
    op,
    inst,
    fields,
  };

  if (!isKnownOp(op)) {
    return {
      ...base,
      vals,
      activeWires: [],
      regWrite: null,
      memWrite: null,
      pcNext: null,
      error: `Unknown instruction "${op}" — no control signals defined for it`,
    };
  }

  try {
    switch (stage) {
      case "F":
        return execF(base, vals);
      case "D":
        return execD(base, vals, op, fields, inputs);
      case "A":
        return execA(base, vals, op, fields);
      case "M":
        return execM(base, vals, op, inputs);
      case "R":
        return execR(base, vals, op, fields, inst, pcBits);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, vals, activeWires: [], regWrite: null, memWrite: null, pcNext: null, error: message };
  }
}

type Base = Pick<MachineState, "stage" | "pc" | "op" | "inst" | "fields">;

function done(base: Base, vals: ValsSnapshot, activeWires: WireId[], extra: Partial<MachineState> = {}): MachineState {
  return {
    ...base,
    vals,
    activeWires,
    regWrite: null,
    memWrite: null,
    pcNext: null,
    error: null,
    ...extra,
  };
}

// ---- F: fetch ---------------------------------------------------------

function execF(base: Base, vals: ValsSnapshot): MachineState {
  // Decoding already happened in execStage (every stage redecodes fields
  // from the raw instruction — cheap, and keeps each stage independently
  // callable/testable). Nothing else to compute at fetch; matches the
  // original F case, which only ever calls PC_IM/IM_INST/INST().
  return done(base, vals, ["PC_IM", "IM_INST"]);
}

// ---- D: decode / register read -----------------------------------------

function execD(base: Base, vals: ValsSnapshot, op: Kind, fields: Base["fields"], inputs: MachineInputs): MachineState {
  const rd1 = inputs.readReg(regNameOf(int32.toNum(fields.rs)));
  const rd2 = inputs.readReg(regNameOf(int32.toNum(fields.rt)));
  const regDst = ctrlValue("RegDst", op) === 1;
  const wr = regDst ? fields.rd : fields.rt;

  const next: ValsSnapshot = {
    ...vals,
    REGRR1: fields.rs,
    REGRD1: rd1,
    REGRR2: fields.rt,
    REGRD2: rd2,
    REGWR: wr,
  };

  const wires: WireId[] = ["RS_RR1", "RT_RR2", regDst ? "RD_MUX1" : "RT_MUX1", "MUX1_WR"];
  return done(base, next, wires);
}

// ---- A: ALU -------------------------------------------------------------

function execA(base: Base, vals: ValsSnapshot, op: Kind, fields: Base["fields"]): MachineState {
  const isShift = op === "sll" || op === "srl";
  let op1: Int32Bits;
  let op2: Int32Bits;
  const wires: WireId[] = [];

  if (isShift) {
    // sll/srl's operand-to-field mapping differs from every other
    // instruction: mips-util.ts's translate$inst puts the register being
    // shifted (the AST node's "src") into the *rt* position and shamt into
    // bits [10:6] — so the value to shift is REGRD2 (read via the rt
    // field in stage D), and the shift amount is the SHAMT field, not the
    // 16-bit immediate ALUSrc's mux normally selects. There's no dedicated
    // wire for this path in the inherited datapath drawing (processor.js
    // never supported shifts at all), so this only reuses RD1_ALU1/
    // MUX2_ALU2 as an approximation — a real diagram would need new
    // artwork for a shamt-into-ALU path, which is out of scope here.
    op1 = vals.REGRD2 ?? ZERO;
    op2 = bit.ext(fields.shamt, 32);
    wires.push("RD1_ALU1", "MUX2_ALU2");
  } else {
    op1 = vals.REGRD1 ?? ZERO;
    const aluSrc = ctrlValue("ALUSrc", op) === 1;
    // TODO: decide if I should keep === 1 or j treat it as bools
    op2 = aluSrc ? fields.imm : vals.REGRD2 ?? ZERO;
    wires.push("RD1_ALU1", aluSrc ? "IMM_MUX2" : "RD2_MUX2", "MUX2_ALU2");
  }

  const aluCtrl = ctrlValue("ALUctrl", op);
  let res: Int32Bits;
  switch (aluCtrl) {
    case 0: res = int32.and(op1, op2); break;
    case 1: res = int32.or(op1, op2); break;
    case 2: res = int32.add(op1, op2); break;
    case 3: res = int32.xor(op1, op2); break;
    case 4: res = int32.sll(op1, int32.toNum(op2)); break; // sll
    case 5: res = int32.srl(op1, int32.toNum(op2)); break; // srl
    case 6: res = int32.sub(op1, op2); break;
    case 7: res = int32.slt(op1, op2); break;
    case 8: res = int32.sll(op2, 16); break; // lui: imm << 16, op1 (always $zero here) ignored
    default:
      throw new RuntimeError(`No ALU implementation for ALUctrl code ${aluCtrl} (op "${op}")`, "interpreter.ts", [op, aluCtrl]);
  }

  const next: ValsSnapshot = { ...vals, ALUop1: op1, ALUop2: op2, ALUres: res };
  return done(base, next, wires);
}

// ---- M: memory ------------------------------------------------------

function execM(base: Base, vals: ValsSnapshot, op: Kind, inputs: MachineInputs): MachineState {
  const addrBits = vals.ALUres ?? ZERO;
  const wd = vals.REGRD2 ?? ZERO;
  const addr = int32.toNum(addrBits);

  const next: ValsSnapshot = { ...vals, MEMAddr: addrBits, MEMWD: wd };
  const wires: WireId[] = ["RES_MADDR", "RD2_MWD"];

  const memWrite = ctrlValue("MemWrite", op) === 1;
  const memRead = ctrlValue("MemRead", op) === 1;
  const byte = ctrlValue("MemByte", op) === 1;

  let memWriteEffect: MachineState["memWrite"] = null;
  if (memWrite) {
    memWriteEffect = { addr, value: wd, byte };
  }
  if (memRead) {
    next.MEMRD = byte ? inputs.readByte(addr) : inputs.readWord(addr);
  }

  return done(base, next, wires, { memWrite: memWriteEffect });
}

// ---- R: write-back + PC update ---------------------------------------

function execR(base: Base, vals: ValsSnapshot, op: Kind, fields: Base["fields"], inst: Int32Bits, pcBits: Int32Bits): MachineState {
  const memToReg = ctrlValue("MemToReg", op) === 1;
  const wd = memToReg ? vals.MEMRD ?? ZERO : vals.ALUres ?? ZERO;
  const next: ValsSnapshot = { ...vals, REGWD: wd };
  const wires: WireId[] = [memToReg ? "MRD_MUX3" : "RES_MUX3", "MUX3_WD"];

  // TODO: change namings here?
  let regWrite: MachineState["regWrite"] = null;
  let writeError: string | null = null;
  if (ctrlValue("RegWrite", op) === 1) {
    const wr = vals.REGWR ?? ZERO;
    const name = regNameOf(int32.toNum(wr));
    // Checked here (using registers.ts's own readonly flag — the single
    // source of truth REGISTERS already established) rather than letting
    // it surface as a thrown exception from useRegisterBank.WR() one layer
    // up. Keeps execStage() self-contained: every failure mode it can
    // detect shows up as `error` on the state it returns, not as an
    // exception a caller has to separately catch around the commit step.
    if (REGISTERS.find((r) => r.name === name)?.readonly) {
      writeError = `Attempt to write to a readonly register ${name}`;
    } else {
      regWrite = { name, value: wd };
    }
  }

  // PC update. Every instruction computes PC+4 (matches the original,
  // which unconditionally calls processor.PC_ADD1 before checking
  // Branch); jump/branch then either use it or override it.
  wires.push("PC_ADD1");
  const pcPlus4 = int32.add(pcBits, FOUR);
  const jump = ctrlValue("Jump", op) === 1;
  const branch = ctrlValue("Branch", op) === 1;
  const branchNE = ctrlValue("BranchNE", op) === 1;

  let pcNext: Int32Bits;
  if (jump) {
    // No wire exists for this in the inherited datapath drawing —
    // processor.js never had jump support, so there's no line segment to
    // light up here. See datapath.ts's header comment.
    const jaddr = decodeJumpIndex(inst);
    pcNext = int32.sll(jaddr, 2);
  } else if (branch) {
    const res = vals.ALUres ?? ZERO;
    const taken = branchNE ? !int32.eq(res, ZERO) : int32.eq(res, ZERO);
    if (taken) {
      wires.push("ADD1_ADD2", "IMM_ADD2", "ADD2_MUX4");
      pcNext = int32.add(pcPlus4, int32.sll(fields.imm, 2));
    } else {
      wires.push("ADD1_MUX4");
      pcNext = pcPlus4;
    }
  } else {
    wires.push("ADD1_MUX4");
    pcNext = pcPlus4;
  }
  wires.push("MUX4_PC");

  if (writeError) {
    return { ...done(base, next, wires), error: writeError };
  }
  return done(base, next, wires, { regWrite, pcNext });
}