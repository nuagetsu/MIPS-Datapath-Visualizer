import { describe, it, expect } from "vitest";
import { REGISTERS, REG_NAME_TO_NUM, REG_NUM_TO_NAME, USABLE_REG_NUMS_TEXT } from "../../../src/lib/mips-isa/registers";

describe("REGISTERS", () => {
  it("lists $pc first, with no register number", () => {
    expect(REGISTERS[0]).toMatchObject({ name: "pc", num: null, readonly: false, editable: false });
  });

  it("makes $zero (0) read-only and not editable", () => {
    expect(REGISTERS.find((r) => r.name === "zero")).toMatchObject({ num: 0, readonly: true, editable: false });
  });

  it("leaves out $at (1) and $k0..$ra (26-31)", () => {
    const nums = REGISTERS.map((r) => r.num);
    for (const reserved of [1, 26, 27, 28, 29, 30, 31]) expect(nums).not.toContain(reserved);
    for (const name of ["at", "k0", "k1", "gp", "sp", "fp", "ra"]) {
      expect(REGISTERS.some((r) => r.name === name)).toBe(false);
    }
  });

  it("covers $v0..$t9 (2-25) exactly once each", () => {
    const nums = REGISTERS.filter((r) => r.num !== null && r.num !== 0).map((r) => r.num);
    expect(nums.slice().sort((a, b) => (a as number) - (b as number))).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 2),
    );
  });

  it("has unique names, all bare (no leading $)", () => {
    const names = REGISTERS.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.startsWith("$")).toBe(false);
  });

  it("only $zero is read-only, and every general-purpose register is editable", () => {
    expect(REGISTERS.filter((r) => r.readonly).map((r) => r.name)).toEqual(["zero"]);
    expect(REGISTERS.filter((r) => !r.editable).map((r) => r.name).sort()).toEqual(["pc", "zero"]);
  });

  it("uses the conventional MIPS numbering", () => {
    const byName = Object.fromEntries(REGISTERS.map((r) => [r.name, r.num]));
    expect(byName).toMatchObject({ v0: 2, a0: 4, t0: 8, t7: 15, s0: 16, s7: 23, t8: 24, t9: 25 });
  });
});

describe("parser register lookups (used by mips.peggy)", () => {
  it("REG_NUM_TO_NAME and REG_NAME_TO_NUM agree with REGISTERS", () => {
    for (const r of REGISTERS) {
      if (r.num === null) continue;
      expect(REG_NUM_TO_NAME.get(r.num)).toBe(r.name);
      expect(REG_NAME_TO_NUM.get(r.name)).toBe(r.num);
    }
  });

  it("have no entry for reserved registers or $pc", () => {
    for (const reserved of [1, 26, 31]) expect(REG_NUM_TO_NAME.get(reserved)).toBeUndefined();
    expect(REG_NAME_TO_NUM.get("pc")).toBeUndefined();
    expect(REG_NAME_TO_NUM.get("sp")).toBeUndefined();
  });
});

describe("USABLE_REG_NUMS_TEXT (used in the parser's register-number error)", () => {
  it("collapses the usable register numbers into ranges", () => {
    expect(USABLE_REG_NUMS_TEXT).toBe("0, 2-25");
  });

  it("agrees with REG_NUM_TO_NAME", () => {
    const expanded = USABLE_REG_NUMS_TEXT.split(", ").flatMap((part) => {
      const [a, b] = part.split("-").map(Number);
      return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i);
    });
    expect(expanded).toEqual([...REG_NUM_TO_NAME.keys()].sort((x, y) => x - y));
  });
});
