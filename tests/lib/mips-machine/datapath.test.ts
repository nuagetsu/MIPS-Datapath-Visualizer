import { describe, it, expect } from "vitest";
import { WIRES, decodeFields, decodeJumpIndex, fieldToNum } from "../../../src/lib/mips-machine/datapath";
import { h, num } from "../../helpers/bits";

const fieldsOf = (word: string) => {
  const f = decodeFields(h(word));
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, num(v)]));
};

describe("decodeFields", () => {
  it("splits an R-type word: add $t2, $t0, $t1 = 0x01095020", () => {
    expect(fieldsOf("01095020")).toMatchObject({ op: 0, rs: 8, rt: 9, rd: 10, shamt: 0, funct: 0x20 });
  });

  it("splits a shift: sll $t1, $t0, 4 = 0x00084900", () => {
    expect(fieldsOf("00084900")).toMatchObject({ op: 0, rs: 0, rt: 8, rd: 9, shamt: 4, funct: 0 });
  });

  it("splits an I-type word: addi $t0, $zero, 100 = 0x20080064", () => {
    expect(fieldsOf("20080064")).toMatchObject({ op: 8, rs: 0, rt: 8, imm: 100 });
  });

  it("sign-extends the 16-bit immediate", () => {
    expect(fieldsOf("2008FFFF").imm).toBe(-1);
    expect(fieldsOf("20087FFF").imm).toBe(32767);
    expect(fieldsOf("20088000").imm).toBe(-32768);
  });

  it("reads all 16 immediate bits (regression: the original read only 15, dropping the sign bit)", () => {
    // 0x8001: with a 15-bit read this decoded as +1.
    expect(fieldsOf("20088001").imm).toBe(-32767);
    // 0x4000 is bit 14: a 15-bit read sign-extended it to a negative number.
    expect(fieldsOf("20084000").imm).toBe(0x4000);
  });

  it("every field comes back as 32 bits", () => {
    for (const v of Object.values(decodeFields(h("FFFFFFFF")))) expect(v).toHaveLength(32);
  });

  it("decodes all-ones fields at their maximum widths", () => {
    expect(fieldsOf("FFFFFFFF")).toMatchObject({ op: 63, rs: 31, rt: 31, rd: 31, shamt: 31, funct: 63, imm: -1 });
  });
});

describe("decodeJumpIndex", () => {
  it("returns the low 26 bits, zero-extended", () => {
    expect(num(decodeJumpIndex(h("08000003")))).toBe(3);
    expect(num(decodeJumpIndex(h("0BFFFFFF")))).toBe(0x3ffffff);
  });
});

describe("fieldToNum", () => {
  it("converts a decoded field to a number", () => {
    expect(fieldToNum(decodeFields(h("01095020")).rd)).toBe(10);
  });
});

describe("WIRES", () => {
  it("has unique ids", () => {
    expect(new Set(WIRES).size).toBe(WIRES.length);
  });

  it("includes the jump datapath and no longer has the old MUX4_PC wire", () => {
    for (const w of ["MUX4_MUX5", "JADDR_LS", "LS_MUX5", "MUX5_PC", "SHAMT_ALU2"]) expect(WIRES).toContain(w);
    expect((WIRES as readonly string[]).includes("MUX4_PC")).toBe(false);
  });
});
