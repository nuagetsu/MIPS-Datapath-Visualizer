import { describe, it, expect } from "vitest";
import { checkProgram, checkSource } from "../../../src/lib/mips-machine/staticCheck";
import { CompileError } from "../../../src/lib/Numbers/err";
import { I, M, V, asciiz, bytes, text, words } from "../../helpers/ast";
import { TestMachine } from "../../helpers/machine";
import type { DataDecl } from "../../../src/lib/mips-parser/ast";

function thrown(fn: () => void): CompileError {
  try {
    fn();
  } catch (err) {
    return err as CompileError;
  }
  throw new Error("expected a throw");
}

describe("checkSource", () => {
  it("rejects la at its own line, tagged 'check'", () => {
    const e = thrown(() => checkSource(text(I("addi", "t0", "zero", 1), { inst: V("t1", "arr"), loc: 7 }), [words("arr", [1])]));
    expect(e).toBeInstanceOf(CompileError);
    expect(e.comp).toBe("check");
    expect(e.loc).toBe(7);
    expect(e.message).toMatch(/"la" \(load address\) is not supported yet/);
    // App.tsx prefixes "Error at line N: " itself.
    expect(e.message).not.toMatch(/line/);
  });

  it("accepts programs without la", () => {
    expect(() => checkSource(text(I("addi", "t0", "zero", 1), M("lw", "t1", 0, "zero"), { inst: null }), null)).not.toThrow();
  });
});

describe("checkProgram (.data must fit in memory)", () => {
  it("accepts no .data, and .data that exactly fills memory", () => {
    expect(() => checkProgram(null, 256)).not.toThrow();
    expect(() => checkProgram([words("w", new Array(64).fill(1))], 256)).not.toThrow();
  });

  it("rejects one word too many, at the declaration's line, with the store's error", () => {
    const e = thrown(() => checkProgram([words("a", [1, 2]), words("big", new Array(63).fill(0), 9)], 256));
    expect(e.comp).toBe("check");
    expect(e.loc).toBe(9);
    expect(e.message).toBe("Address 256 is out of range in SW");
  });

  it("bytes and strings overflow as SB", () => {
    expect(thrown(() => checkProgram([bytes("b", new Array(257).fill(1))], 256)).message).toBe("Address 256 is out of range in SB");
    expect(thrown(() => checkProgram([asciiz("s", "x".repeat(256))], 256)).message).toBe("Address 256 is out of range in SB");
  });

  it("counts padding: 5 bytes take 8", () => {
    expect(() => checkProgram([bytes("b", [1, 2, 3, 4, 5])], 8)).not.toThrow();
    expect(() => checkProgram([bytes("b", [1, 2, 3, 4, 5])], 4)).toThrow(CompileError);
  });

  it("strings need room for their NUL", () => {
    expect(() => checkProgram([asciiz("s", "abc")], 4)).not.toThrow();
    expect(() => checkProgram([asciiz("s", "abcd")], 4)).toThrow(CompileError);
  });

  it("agrees with actually loading the data (App's initializeMemory)", () => {
    const layouts: DataDecl[][] = [
      [words("w", new Array(16).fill(7))],
      [words("w", new Array(15).fill(7)), bytes("b", [1, 2, 3, 4, 5])],
      [asciiz("s", "hello world"), words("w", [1, 2, 3])],
      [bytes("b", new Array(60).fill(9)), asciiz("s", "abc")],
      [bytes("b", new Array(61).fill(9)), asciiz("s", "abc")],
    ];
    for (const data of layouts) {
      let loadError: unknown = null;
      try {
        new TestMachine(64).loadData(data);
      } catch (err) {
        loadError = err;
      }
      let checkError: unknown = null;
      try {
        checkProgram(data, 64);
      } catch (err) {
        checkError = err;
      }
      expect(checkError === null).toBe(loadError === null);
      if (loadError) expect((checkError as Error).message).toBe((loadError as Error).message);
    }
  });
});
