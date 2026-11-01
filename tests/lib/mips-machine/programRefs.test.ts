import { describe, it, expect } from "vitest";
import { collectProgramRefs, dataSegmentBytes } from "../../../src/lib/mips-machine/programRefs";
import { layoutData } from "../../../src/lib/mips-parser/mips-util";
import { B, I, J, L, M, R, S, U, asciiz, bytes, words } from "../../helpers/ast";
import type { DataDecl } from "../../../src/lib/mips-parser/ast";

describe("collectProgramRefs: registers", () => {
  it("collects every register operand by number", () => {
    const refs = collectProgramRefs(
      [R("add", "t2", "t0", "t1"), I("addi", "s0", "zero", 1), M("lw", "v0", 4, "a0"), B("beq", "t3", "t4", "x"), S("sll", "s1", "s2", 1)],
      null,
    );
    expect([...refs.registers].sort((a, b) => a - b)).toEqual([0, 2, 4, 8, 9, 10, 11, 12, 16, 17, 18]);
  });

  it("instructions without register operands add none", () => {
    expect(collectProgramRefs([J("x")], null).registers.size).toBe(0);
  });

  it("lui and hex-immediate forms count their registers too", () => {
    expect([...collectProgramRefs([U("t5", 1), L("ori", "t6", "t5", 0xff)], null).registers].sort()).toEqual([13, 14]);
  });
});

describe("collectProgramRefs: ops", () => {
  it("lists each mnemonic once", () => {
    const refs = collectProgramRefs([I("addi", "t0", "zero", 1), I("addi", "t1", "zero", 2), J("x"), M("sw", "t0", 0, "zero")], null);
    expect([...refs.ops].sort()).toEqual(["addi", "j", "sw"]);
  });
});

describe("collectProgramRefs: memory words known before running", () => {
  it("includes loads/stores off $zero (address = offset)", () => {
    const refs = collectProgramRefs([M("lw", "t0", 8, "zero"), M("sb", "t0", 13, "zero")], null);
    expect([...refs.memoryWords].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it("ignores loads/stores off other registers (address unknown until run time)", () => {
    expect(collectProgramRefs([M("lw", "t0", 8, "t1")], null).memoryWords.size).toBe(0);
  });

  it("ignores negative $zero offsets (they'd fault anyway)", () => {
    expect(collectProgramRefs([M("lw", "t0", -4, "zero")], null).memoryWords.size).toBe(0);
  });

  it("includes every word of the .data segment", () => {
    const refs = collectProgramRefs([], [words("w", [1, 2]), bytes("b", [1, 2, 3, 4, 5]), asciiz("s", "hi")]);
    expect([...refs.memoryWords].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("dataSegmentBytes", () => {
  it("is 0 without .data", () => {
    expect(dataSegmentBytes(null)).toBe(0);
    expect(dataSegmentBytes([])).toBe(0);
  });

  it("pads each declaration to a word", () => {
    expect(dataSegmentBytes([words("w", [1, 2, 3])])).toBe(12);
    expect(dataSegmentBytes([bytes("b", [1])])).toBe(4);
    expect(dataSegmentBytes([asciiz("s", "abc")])).toBe(4);
    expect(dataSegmentBytes([asciiz("s", "abcd")])).toBe(8);
  });

  it("agrees with mips-util's layoutData (the two must never drift)", () => {
    const cases: DataDecl[][] = [
      [words("a", [1]), bytes("b", [1, 2, 3]), asciiz("c", "hello"), words("d", [1, 2])],
      [asciiz("a", ""), bytes("b", new Array(9).fill(0))],
      [bytes("a", [1, 2, 3, 4]), bytes("b", [5])],
    ];
    for (const data of cases) {
      const withSentinel = [...data, words("__end", [0])];
      expect(dataSegmentBytes(data)).toBe(layoutData(withSentinel).get("__end"));
    }
  });
});
