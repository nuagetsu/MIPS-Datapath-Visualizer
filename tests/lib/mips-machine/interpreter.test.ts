import { describe, it, expect, vi } from "vitest";
import { canRun, execStage, type ProgramLine } from "../../../src/lib/mips-machine/interpreter";
import type { CycleStage, MachineState, ValsSnapshot } from "../../../src/lib/mips-machine/machineState";
import { B, I, J, L, M, R, S, U, label, text } from "../../helpers/ast";
import { TestMachine, runSingleCycle, toProgram } from "../../helpers/machine";
import { h, hex, n, num, u32 } from "../../helpers/bits";
import type { Instr } from "../../../src/lib/mips-parser/ast";

const STAGES: CycleStage[] = ["F", "D", "A", "M", "R"];

/** Runs the five stages of program[pc] in order against `m`, without committing
 * anything — returns each stage's state. */
function stages(program: ProgramLine[], m: TestMachine, pc = 0): MachineState[] {
  const out: MachineState[] = [];
  let vals: ValsSnapshot = {};
  for (const stage of STAGES) {
    const s = execStage(program, pc, stage, vals, n(pc * 4), m.inputs());
    out.push(s);
    if (s.error) break;
    vals = s.vals;
  }
  return out;
}

/** One instruction, its five stages, with registers preset. */
function one(inst: Instr, regs: Record<string, number> = {}, setup?: (m: TestMachine) => void) {
  const m = new TestMachine();
  for (const [k, v] of Object.entries(regs)) m.setReg(k, v);
  setup?.(m);
  const program = toProgram(text(inst));
  const s = stages(program, m);
  return { m, s, F: s[0], D: s[1], A: s[2], Mem: s[3], Rw: s[4], last: s[s.length - 1] };
}

describe("canRun", () => {
  const prog = toProgram(text(I("addi", "t0", "zero", 1), I("addi", "t1", "zero", 2)));
  it("is true only for indices inside the program", () => {
    expect([-1, 0, 1, 2].map((pc) => canRun(prog, pc))).toEqual([false, true, true, false]);
    expect(canRun([], 0)).toBe(false);
  });
});

describe("execStage: common behaviour", () => {
  it("reports an unknown mnemonic as an error at every stage", () => {
    const program: ProgramLine[] = [{ op: "nor", bin: h("01095027") }];
    for (const stage of STAGES) {
      const s = execStage(program, 0, stage, {}, n(0), new TestMachine().inputs());
      expect(s.error).toMatch(/Unknown instruction "nor"/);
      expect(s.activeWires).toEqual([]);
      expect([s.regWrite, s.memWrite, s.pcNext]).toEqual([null, null, null]);
    }
  });

  it("decodes fields on every stage and carries pc/op/inst through", () => {
    const { s } = one(R("add", "t2", "t0", "t1"));
    for (const st of s) {
      expect(st.pc).toBe(0);
      expect(st.op).toBe("add");
      expect(hex(st.inst)).toBe("0x01095020");
      expect(num(st.fields.rd)).toBe(10);
    }
    expect(s.map((x) => x.stage)).toEqual(STAGES);
  });

  it("never mutates the vals object it's given", () => {
    const program = toProgram(text(R("add", "t2", "t0", "t1")));
    const vals: ValsSnapshot = {};
    execStage(program, 0, "D", vals, n(0), new TestMachine().inputs());
    expect(vals).toEqual({});
  });

  it("only R reports pcNext, only M reports memWrite, only R reports regWrite", () => {
    const { s } = one(M("sw", "t0", 0, "zero"));
    expect(s.map((x) => x.memWrite !== null)).toEqual([false, false, false, true, false]);
    const add = one(R("add", "t2", "t0", "t1")).s;
    expect(add.map((x) => x.regWrite !== null)).toEqual([false, false, false, false, true]);
    expect(add.map((x) => x.pcNext !== null)).toEqual([false, false, false, false, true]);
  });
});

describe("F (fetch)", () => {
  it("lights the instruction fetch and changes nothing", () => {
    const { F } = one(R("add", "t2", "t0", "t1"));
    expect(F.activeWires).toEqual(["PC_IM", "IM_INST"]);
    expect(F.vals).toEqual({});
    expect(F.error).toBeNull();
  });
});

describe("D (decode / register read)", () => {
  it("reads rs and rt and picks rd as the write register for R-types", () => {
    const { D } = one(R("add", "t2", "t0", "t1"), { t0: 5, t1: 7 });
    expect(num(D.vals.REGRR1!)).toBe(8);
    expect(num(D.vals.REGRD1!)).toBe(5);
    expect(num(D.vals.REGRR2!)).toBe(9);
    expect(num(D.vals.REGRD2!)).toBe(7);
    expect(num(D.vals.REGWR!)).toBe(10);
    expect(D.activeWires).toEqual(["RS_RR1", "RT_RR2", "RD_MUX1", "MUX1_WR"]);
  });

  it("picks rt as the write register for I-types (RegDst = 0)", () => {
    const { D } = one(I("addi", "t3", "t0", 1));
    expect(num(D.vals.REGWR!)).toBe(11);
    expect(D.activeWires).toContain("RT_MUX1");
  });

  it("reads registers by bare name through MachineInputs.readReg", () => {
    const readReg = vi.fn(() => n(0));
    const program = toProgram(text(R("add", "t2", "t0", "t1")));
    execStage(program, 0, "D", {}, n(0), { readReg, readWord: () => n(0), readByte: () => n(0) });
    expect(readReg).toHaveBeenCalledWith("t0");
    expect(readReg).toHaveBeenCalledWith("t1");
  });

  it("errors on a register number the simulator doesn't have ($1)", () => {
    // add $t0, $1, $zero, hand-encoded: the parser would reject $1.
    const program: ProgramLine[] = [{ op: "add", bin: h("00204020") }];
    const s = execStage(program, 0, "D", {}, n(0), new TestMachine().inputs());
    expect(s.error).toBe("No register numbered 1");
  });
});

describe("A (ALU)", () => {
  it.each<[string, Instr, Record<string, number>, number]>([
    ["add", R("add", "t2", "t0", "t1"), { t0: 5, t1: 7 }, 12],
    ["sub", R("sub", "t2", "t0", "t1"), { t0: 5, t1: 7 }, -2],
    ["and", R("and", "t2", "t0", "t1"), { t0: 0b1100, t1: 0b1010 }, 0b1000],
    ["or", R("or", "t2", "t0", "t1"), { t0: 0b1100, t1: 0b1010 }, 0b1110],
    ["slt (true)", R("slt", "t2", "t0", "t1"), { t0: -3, t1: 2 }, 1],
    ["slt (false)", R("slt", "t2", "t0", "t1"), { t0: 2, t1: -3 }, 0],
    ["addi", I("addi", "t2", "t0", -10), { t0: 3 }, -7],
    ["slti", I("slti", "t2", "t0", 0), { t0: -1 }, 1],
    ["andi", L("andi", "t2", "t0", 0x0f), { t0: 0xab }, 0x0b],
    ["ori", L("ori", "t2", "t0", 0xf0), { t0: 0x0f }, 0xff],
    ["xori", L("xori", "t2", "t0", 0xff), { t0: 0x0f }, 0xf0],
    ["sll", S("sll", "t2", "t0", 3), { t0: 5 }, 40],
    ["srl", S("srl", "t2", "t0", 2), { t0: 40 }, 10],
    ["srl is logical", S("srl", "t2", "t0", 28), { t0: -1 }, 15],
    ["lui", U("t2", 0x1234), {}, 0x12340000],
    ["lw address", M("lw", "t2", 8, "t0"), { t0: 4 }, 12],
    ["sw address (negative offset)", M("sw", "t2", -4, "t0"), { t0: 8 }, 4],
    ["beq compares by subtracting", B("beq", "t0", "t1", "x"), { t0: 9, t1: 4 }, 5],
  ])("%s", (_name, inst, regs, expected) => {
    // B needs its label: put it on the instruction itself.
    const program = toProgram(inst.prop.type === "B" ? text(label("x", inst)) : text(inst));
    const m = new TestMachine();
    for (const [k, v] of Object.entries(regs)) m.setReg(k, v);
    const A = stages(program, m)[2];
    expect(A.error).toBeNull();
    expect(num(A.vals.ALUres!)).toBe(expected);
  });

  it("lights RD2 -> MUX2 for register operands and IMM -> MUX2 for immediates", () => {
    expect(one(R("add", "t2", "t0", "t1")).A.activeWires).toEqual(["RD1_ALU1", "RD2_MUX2", "MUX2_ALU2"]);
    expect(one(I("addi", "t2", "t0", 1)).A.activeWires).toEqual(["RD1_ALU1", "IMM_MUX2", "MUX2_ALU2"]);
  });

  it("shifts take rt's value as op1 and shamt as op2, over the SHAMT wire", () => {
    const { A } = one(S("sll", "t2", "t0", 3), { t0: 5 });
    expect(num(A.vals.ALUop1!)).toBe(5);
    expect(num(A.vals.ALUop2!)).toBe(3);
    expect(A.activeWires).toContain("SHAMT_ALU2");
    expect(A.activeWires).not.toContain("RD1_ALU1");
  });

  it("records both ALU operands", () => {
    const { A } = one(I("addi", "t2", "t0", -2), { t0: 10 });
    expect([num(A.vals.ALUop1!), num(A.vals.ALUop2!)]).toEqual([10, -2]);
  });

  it("wraps on overflow", () => {
    expect(num(one(R("add", "t2", "t0", "t1"), { t0: 2147483647, t1: 1 }).A.vals.ALUres!)).toBe(-2147483648);
  });

  // The datapath has a single Sign Extend unit, so andi/ori/xori sign-extend
  // their immediate. Real MIPS zero-extends it for these three, so e.g.
  // `ori $t0, $zero, 0x8000` gives 0x00008000 there but 0xFFFF8000 here — which
  // also affects the lui/ori idiom staticCheck suggests in place of `la`, for
  // low halves >= 0x8000. Documented here so a change to either behaviour is a
  // deliberate one.
  it("DEVIATION from MIPS: andi/ori/xori sign-extend immediates >= 0x8000", () => {
    expect(u32(one(L("ori", "t2", "zero", 0x8000)).A.vals.ALUres!)).toBe(0xffff8000);
    expect(u32(one(L("andi", "t2", "t0", 0xffff), { t0: 0x12345678 }).A.vals.ALUres!)).toBe(0x12345678);
  });
});

describe("M (memory)", () => {
  it("lw reads the word at the ALU result", () => {
    const { Mem } = one(M("lw", "t2", 4, "t0"), { t0: 4 }, (m) => m.setWord(2, 99));
    expect(num(Mem.vals.MEMAddr!)).toBe(8);
    expect(num(Mem.vals.MEMRD!)).toBe(99);
    expect(Mem.memWrite).toBeNull();
    expect(Mem.activeWires).toEqual(["RES_MADDR", "RD2_MWD"]);
  });

  it("lb reads one byte and sign-extends it", () => {
    const { Mem } = one(M("lb", "t2", 1, "zero"), {}, (m) => m.setWord(0, 0x0000ff00));
    expect(num(Mem.vals.MEMRD!)).toBe(-1);
    const pos = one(M("lb", "t2", 0, "zero"), {}, (m) => m.setWord(0, 0x7f));
    expect(num(pos.Mem.vals.MEMRD!)).toBe(0x7f);
  });

  it("sw reports a word write of rt's value (it doesn't apply it)", () => {
    const { Mem, m } = one(M("sw", "t1", 8, "t0"), { t0: 4, t1: 77 });
    expect(Mem.memWrite).toEqual({ addr: 12, value: n(77), byte: false });
    expect(num(Mem.vals.MEMWD!)).toBe(77);
    expect(m.word(3)).toBe(0);
  });

  it("sb reports a byte write", () => {
    const { Mem } = one(M("sb", "t1", 3, "zero"), { t1: 0x1ff });
    expect(Mem.memWrite).toMatchObject({ addr: 3, byte: true });
  });

  it("non-memory instructions don't touch memory", () => {
    const readWord = vi.fn(() => n(0));
    const program = toProgram(text(R("add", "t2", "t0", "t1")));
    const m = new TestMachine();
    const s = stages(program, m);
    const Mem = execStage(program, 0, "M", s[2].vals, n(0), { ...m.inputs(), readWord });
    expect(Mem.memWrite).toBeNull();
    expect(Mem.vals.MEMRD).toBeUndefined();
    expect(readWord).not.toHaveBeenCalled();
  });

  it("an unaligned lw becomes an error state", () => {
    const { last } = one(M("lw", "t2", 2, "zero"));
    expect(last.stage).toBe("M");
    expect(last.error).toBe("Unaligned LW operation on address 2");
  });

  it("an out-of-range load becomes an error state", () => {
    expect(one(M("lw", "t2", 256, "zero")).last.error).toBe("Address 256 is out of range in LW");
    expect(one(M("lb", "t2", -1, "zero")).last.error).toBe("Address -1 is out of range in LB");
  });
});

describe("R (write-back + next PC)", () => {
  it("writes the ALU result to the destination register", () => {
    const { Rw } = one(R("add", "t2", "t0", "t1"), { t0: 5, t1: 7 });
    expect(Rw.regWrite).toEqual({ name: "t2", value: n(12) });
    expect(num(Rw.vals.REGWD!)).toBe(12);
    expect(Rw.activeWires.slice(0, 2)).toEqual(["RES_MUX3", "MUX3_WD"]);
  });

  it("loads write the memory value (MemToReg)", () => {
    const { Rw } = one(M("lw", "t2", 0, "zero"), {}, (m) => m.setWord(0, 1234));
    expect(Rw.regWrite).toEqual({ name: "t2", value: n(1234) });
    expect(Rw.activeWires).toContain("MRD_MUX3");
  });

  it("stores, branches and jumps write no register", () => {
    expect(one(M("sw", "t2", 0, "zero")).Rw.regWrite).toBeNull();
    expect(stages(toProgram(text(label("x", B("beq", "t0", "t1", "x")))), new TestMachine())[4].regWrite).toBeNull();
    expect(stages(toProgram(text(label("x", J("x")))), new TestMachine())[4].regWrite).toBeNull();
  });

  it("advances PC by 4 for ordinary instructions", () => {
    const { Rw } = one(R("add", "t2", "t0", "t1"));
    expect(num(Rw.pcNext!)).toBe(4);
    expect(Rw.activeWires).toEqual(["RES_MUX3", "MUX3_WD", "PC_ADD1", "ADD1_MUX4", "MUX4_MUX5", "MUX5_PC"]);
  });

  it("refuses to write $zero (hand-encoded: the assembler rejects it)", () => {
    const program: ProgramLine[] = [{ op: "add", bin: h("01090020") }]; // add $zero, $t0, $t1
    const s = stages(program, new TestMachine());
    expect(s[4].error).toBe("Attempt to write to a readonly register zero");
    expect(s[4].regWrite).toBeNull();
    expect(s[4].pcNext).toBeNull();
  });
});

describe("branches and jumps", () => {
  const prog = (op: "beq" | "bne") =>
    toProgram(text(B(op, "t0", "t1", "target"), I("addi", "t2", "zero", 1), label("target", I("addi", "t3", "zero", 1))));

  const pcAfter = (program: ProgramLine[], regs: Record<string, number>) => {
    const m = new TestMachine();
    for (const [k, v] of Object.entries(regs)) m.setReg(k, v);
    return stages(program, m)[4];
  };

  it("beq taken: PC+4 + offset*4, over the branch adder", () => {
    const r = pcAfter(prog("beq"), { t0: 3, t1: 3 });
    expect(num(r.pcNext!)).toBe(8);
    expect(r.activeWires).toEqual(expect.arrayContaining(["ADD1_ADD2", "IMM_ADD2", "ADD2_MUX4", "MUX4_MUX5", "MUX5_PC"]));
    expect(r.activeWires).not.toContain("ADD1_MUX4");
  });

  it("beq not taken: PC+4", () => {
    const r = pcAfter(prog("beq"), { t0: 3, t1: 4 });
    expect(num(r.pcNext!)).toBe(4);
    expect(r.activeWires).toContain("ADD1_MUX4");
    expect(r.activeWires).not.toContain("ADD2_MUX4");
  });

  it("bne is the opposite of beq", () => {
    expect(num(pcAfter(prog("bne"), { t0: 3, t1: 4 }).pcNext!)).toBe(8);
    expect(num(pcAfter(prog("bne"), { t0: 3, t1: 3 }).pcNext!)).toBe(4);
  });

  it("backward branches go backwards", () => {
    const program = toProgram(text(label("top", I("addi", "t0", "t0", -1)), B("bne", "t0", "zero", "top")));
    const m = new TestMachine().setReg("t0", 5);
    expect(num(stages(program, m, 1)[4].pcNext!)).toBe(0);
  });

  it("j goes to the label's address over the jump datapath", () => {
    const program = toProgram(text(J("end"), I("addi", "t0", "zero", 1), I("addi", "t0", "zero", 2), label("end", I("addi", "t1", "zero", 1))));
    const r = stages(program, new TestMachine())[4];
    expect(num(r.pcNext!)).toBe(12);
    expect(r.activeWires).toEqual(["RES_MUX3", "MUX3_WD", "PC_ADD1", "JADDR_LS", "LS_MUX5", "MUX5_PC"]);
  });

  it("j keeps the top 4 bits of PC+4 (regression: they used to be dropped)", () => {
    const program: ProgramLine[] = [{ op: "j", bin: h("08000002") }];
    let vals: ValsSnapshot = {};
    const pcBits = h("10000000");
    let r!: MachineState;
    for (const stage of STAGES) {
      r = execStage(program, 0, stage, vals, pcBits, new TestMachine().inputs());
      vals = r.vals;
    }
    expect(hex(r.pcNext!)).toBe("0x10000008");
  });
});

describe("whole instructions through runSingleCycle", () => {
  it("commits register writes and leaves $pc after the program", () => {
    const m = new TestMachine();
    const run = runSingleCycle(toProgram(text(I("addi", "t0", "zero", 5), I("addi", "t1", "t0", 2))), m);
    expect(run.error).toBeNull();
    expect(run.states).toHaveLength(10);
    expect([m.reg("t0"), m.reg("t1"), m.reg("pc")]).toEqual([5, 7, 8]);
  });

  it("stops at the first error with the machine as it was", () => {
    const m = new TestMachine();
    const run = runSingleCycle(toProgram(text(I("addi", "t0", "zero", 1), M("lw", "t1", 3, "zero"), I("addi", "t2", "zero", 1))), m);
    expect(run.error).toBe("Unaligned LW operation on address 3");
    expect(run.states[run.states.length - 1]).toMatchObject({ pc: 1, stage: "M" });
    expect([m.reg("t0"), m.reg("t2")]).toEqual([1, 0]);
  });
});
