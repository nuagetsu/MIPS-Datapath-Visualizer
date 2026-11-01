import { describe, it, expect } from "vitest";
import { CONTROLS, KIND, OPS, ctrlValue, isKnownOp, type Kind } from "../../../src/lib/mips-machine/ctrl";
import { VALS } from "../../../src/lib/mips-machine/vals";

const sig = (name: string, op: Kind) => ctrlValue(name, op);

describe("control table shape", () => {
  it("has 20 unique instruction kinds, indexed by OPS", () => {
    expect(KIND).toHaveLength(20);
    expect(new Set(KIND).size).toBe(KIND.length);
    KIND.forEach((op, i) => expect(OPS[op]).toBe(i));
  });

  it("every signal has one value per instruction kind", () => {
    for (const def of CONTROLS) expect(def.values).toHaveLength(KIND.length);
  });

  it("signal names are unique", () => {
    const names = CONTROLS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every value fits its declared bit width", () => {
    for (const def of CONTROLS) {
      for (const v of def.values) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(2 ** def.len);
      }
    }
  });

  it("ALUctrl is the only multi-bit signal", () => {
    expect(CONTROLS.filter((d) => d.len !== 1).map((d) => d.name)).toEqual(["ALUctrl"]);
  });
});

describe("ctrlValue / isKnownOp", () => {
  it("looks up a signal for an op", () => {
    expect(ctrlValue("RegWrite", "add")).toBe(1);
    expect(ctrlValue("MemWrite", "sw")).toBe(1);
  });

  it("throws on an unknown signal name", () => {
    expect(() => ctrlValue("NoSuchSignal", "add")).toThrow(/Unknown control signal "NoSuchSignal"/);
  });

  it("knows exactly the 20 kinds", () => {
    for (const op of KIND) expect(isKnownOp(op)).toBe(true);
    expect(isKnownOp("la")).toBe(false);
    expect(isKnownOp("nor")).toBe(false);
    expect(isKnownOp("")).toBe(false);
  });

  it("isn't fooled by Object.prototype keys", () => {
    expect(isKnownOp("toString")).toBe(false);
    expect(isKnownOp("constructor")).toBe(false);
  });
});

describe("control signals per instruction family (single-cycle datapath rules)", () => {
  const R_TYPE: Kind[] = ["add", "sub", "and", "or", "slt"];
  const I_ARITH: Kind[] = ["addi", "andi", "ori", "xori", "slti"];

  it.each(R_TYPE)("%s: rd <- rs op rt", (op) => {
    expect([sig("RegDst", op), sig("ALUSrc", op), sig("RegWrite", op), sig("MemToReg", op)]).toEqual([1, 0, 1, 0]);
    expect([sig("MemRead", op), sig("MemWrite", op), sig("Branch", op), sig("Jump", op)]).toEqual([0, 0, 0, 0]);
  });

  it.each(I_ARITH)("%s: rt <- rs op imm", (op) => {
    expect([sig("RegDst", op), sig("ALUSrc", op), sig("RegWrite", op), sig("MemToReg", op)]).toEqual([0, 1, 1, 0]);
    expect([sig("MemRead", op), sig("MemWrite", op), sig("Branch", op)]).toEqual([0, 0, 0]);
  });

  it.each(["sll", "srl"] as Kind[])("%s writes rd", (op) => {
    expect(sig("RegDst", op)).toBe(1);
    expect(sig("RegWrite", op)).toBe(1);
  });

  it.each([["lw", 0], ["lb", 1]] as [Kind, number][])("%s reads memory into rt (MemByte=%d)", (op, byte) => {
    expect([sig("RegDst", op), sig("ALUSrc", op), sig("MemRead", op), sig("MemToReg", op), sig("RegWrite", op)]).toEqual([0, 1, 1, 1, 1]);
    expect(sig("MemByte", op)).toBe(byte);
    expect(sig("ALUctrl", op)).toBe(2); // address = rs + offset
  });

  it.each([["sw", 0], ["sb", 1]] as [Kind, number][])("%s writes memory and no register (MemByte=%d)", (op, byte) => {
    expect([sig("ALUSrc", op), sig("MemWrite", op), sig("MemRead", op), sig("RegWrite", op)]).toEqual([1, 1, 0, 0]);
    expect(sig("MemByte", op)).toBe(byte);
    expect(sig("ALUctrl", op)).toBe(2);
  });

  it.each([["beq", 0], ["bne", 1]] as [Kind, number][])("%s subtracts and branches (BranchNE=%d)", (op, ne) => {
    expect([sig("Branch", op), sig("BranchNE", op), sig("ALUSrc", op), sig("RegWrite", op)]).toEqual([1, ne, 0, 0]);
    expect(sig("ALUctrl", op)).toBe(6);
  });

  it("j only jumps", () => {
    expect([sig("Jump", "j"), sig("RegWrite", "j"), sig("MemWrite", "j"), sig("MemRead", "j"), sig("Branch", "j")]).toEqual([1, 0, 0, 0, 0]);
  });

  it("lui writes rt from the immediate", () => {
    expect([sig("RegDst", "lui"), sig("ALUSrc", "lui"), sig("RegWrite", "lui"), sig("ALUctrl", "lui")]).toEqual([0, 1, 1, 8]);
  });

  it("uses the documented ALUctrl codes", () => {
    const expected: Partial<Record<Kind, number>> = {
      and: 0, or: 1, add: 2, sub: 6, slt: 7, addi: 2, andi: 0, ori: 1, xori: 3, slti: 7, sll: 4, srl: 5, lui: 8,
    };
    for (const [op, code] of Object.entries(expected)) expect(sig("ALUctrl", op as Kind)).toBe(code);
  });
});

describe("cross-signal invariants", () => {
  for (const op of KIND) {
    it(`${op} is internally consistent`, () => {
      if (sig("MemRead", op)) expect([sig("MemToReg", op), sig("RegWrite", op)]).toEqual([1, 1]);
      if (sig("MemToReg", op)) expect(sig("MemRead", op)).toBe(1);
      if (sig("MemWrite", op)) expect([sig("RegWrite", op), sig("MemRead", op)]).toEqual([0, 0]);
      if (sig("MemByte", op)) expect(sig("MemRead", op) + sig("MemWrite", op)).toBe(1);
      if (sig("BranchNE", op)) expect(sig("Branch", op)).toBe(1);
      if (sig("Branch", op) || sig("Jump", op)) expect([sig("RegWrite", op), sig("MemWrite", op)]).toEqual([0, 0]);
      expect(sig("Branch", op) && sig("Jump", op)).toBe(0);
    });
  }
});

describe("VALS (datapath wire values)", () => {
  it("lists 12 values with unique keys", () => {
    expect(VALS).toHaveLength(12);
    expect(new Set(VALS.map((v) => v.key)).size).toBe(12);
  });

  it("key is always comp + name", () => {
    for (const v of VALS) expect(v.key).toBe(v.comp + v.name);
  });

  it("groups values into REG / ALU / MEM", () => {
    const count = (comp: string) => VALS.filter((v) => v.comp === comp).length;
    expect([count("REG"), count("ALU"), count("MEM")]).toEqual([6, 3, 3]);
  });
});
