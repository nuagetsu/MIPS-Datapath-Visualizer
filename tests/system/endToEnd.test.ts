/**
 * Source text -> result, through the same steps App.tsx's Assemble button
 * takes (parseMips -> check -> checkSource -> assemble -> checkProgram ->
 * load .data -> run), and the error each step reports for a bad program.
 *
 * Needs src/lib/mips-parser/generated-parser.ts (npm run gen:parser).
 */
import { describe, it, expect } from "vitest";
import { parseMips } from "../../src/lib/mips-parser";
import mipsUtil, { assemble, check } from "../../src/lib/mips-parser/mips-util";
import { checkProgram, checkSource } from "../../src/lib/mips-machine/staticCheck";
import { collectProgramRefs } from "../../src/lib/mips-machine/programRefs";
import type { ProgramLine } from "../../src/lib/mips-machine/interpreter";
import { CompileError } from "../../src/lib/Numbers/err";
import { TestMachine, runPipeline, runSingleCycle } from "../helpers/machine";

const MEM_SIZE = 256;

type Outcome =
  | { stage: "syntax"; line: number; message: string; lines: number[] }
  | { stage: "compile"; line: number; message: string; comp: string }
  | { stage: "ok"; program: ProgramLine[]; sourceLines: number[]; machine: () => TestMachine; listing: string };

/** App.tsx's handleParse, minus the editors. */
function assembleSource(src: string, startPc = 0): Outcome {
  const parsed = parseMips(src);
  // App reports every diagnostic, each at its own line.
  if (!parsed.ok) {
    return { stage: "syntax", line: parsed.line, message: parsed.diagnostics[0].message, lines: parsed.diagnostics.map((d) => d.line) };
  }
  try {
    const { text, data } = parsed.program.prop;
    check(text, data);
    checkSource(text, data);
    const assembled = assemble(text, data, startPc);
    const program = assembled.map((l) => ({ op: l.prop.inst.prop.op, bin: l.prop.bin }));
    checkProgram(data, MEM_SIZE);
    return {
      stage: "ok",
      program,
      sourceLines: assembled.map((l) => l.prop.loc - 1),
      machine: () => new TestMachine(MEM_SIZE).loadData(data),
      listing: mipsUtil.print(assembled),
    };
  } catch (err) {
    if (!(err instanceof CompileError)) throw err;
    return { stage: "compile", line: err.loc, message: err.message, comp: err.comp };
  }
}

function runSource(src: string, mode: "single" | "pipeline" | "hazards" | "early" = "single") {
  const out = assembleSource(src);
  if (out.stage !== "ok") throw new Error(`didn't assemble: ${out.message}`);
  const m = out.machine();
  const error =
    mode === "single"
      ? runSingleCycle(out.program, m).error
      : runPipeline(out.program, m, mode !== "pipeline", mode === "early").error;
  return { m, error, out };
}

describe("the app's default program", () => {
  const DEFAULT_SOURCE = `addi $v1, $zero, 100\nadd $v0, $zero, $v1\n`;

  it("assembles to the expected machine code", () => {
    const out = assembleSource(DEFAULT_SOURCE);
    expect(out.stage).toBe("ok");
    if (out.stage !== "ok") return;
    expect(out.listing).toMatch(/# 0x20030064/);
    expect(out.listing).toMatch(/# 0x00031020/);
  });

  it.each(["single", "pipeline", "hazards", "early"] as const)("runs in %s mode", (mode) => {
    const { m, error } = runSource(DEFAULT_SOURCE, mode);
    expect(error).toBeNull();
    expect([m.reg("v1"), m.reg("v0"), m.reg("pc")]).toEqual([100, 100, 8]);
  });
});

describe("whole programs from source", () => {
  const SUM_ARRAY = `.data
arr:  .word 10, 20, 30, 40
.text
      addi $t0, $zero, 0      # address
      addi $t1, $zero, 4      # count
loop: lw   $t2, 0($t0)
      add  $t3, $t3, $t2
      addi $t0, $t0, 4
      addi $t1, $t1, -1
      bne  $t1, $zero, loop
      sw   $t3, 16($zero)
`;

  const STRLEN = `.data
s: .asciiz "MIPS!"
.text
      addi $t0, $zero, 0
loop: lb   $t1, 0($t0)
      beq  $t1, $zero, done
      addi $t0, $t0, 1
      j    loop
done: sw   $t0, 8($zero)
`;

  const BITS = `lui  $t0, 0xDEAD
ori  $t0, $t0, 0x7EEF
srl  $t1, $t0, 16
sll  $t2, $t1, 1
xori $t3, $t1, 0xFFF
`;

  it.each(["single", "pipeline", "hazards", "early"] as const)("array sum (%s)", (mode) => {
    const { m, error } = runSource(SUM_ARRAY, mode);
    expect(error).toBeNull();
    expect([m.reg("t3"), m.word(4)]).toEqual([100, 100]);
  });

  it.each(["single", "pipeline", "hazards", "early"] as const)("strlen (%s)", (mode) => {
    const { m, error } = runSource(STRLEN, mode);
    expect(error).toBeNull();
    expect(m.word(2)).toBe(5);
  });

  it("lui/ori/shifts", () => {
    const { m } = runSource(BITS);
    expect((m.reg("t0") >>> 0).toString(16)).toBe("dead7eef");
    expect(m.reg("t1")).toBe(0xdead);
    expect(m.reg("t2")).toBe(0xdead << 1);
    expect(m.reg("t3")).toBe(0xdead ^ 0xfff);
  });

  it("maps every instruction back to its source line (comments and labels don't count)", () => {
    const out = assembleSource(SUM_ARRAY);
    if (out.stage !== "ok") throw new Error();
    // 0-based editor rows of the 8 instructions (line 1 is ".data").
    expect(out.sourceLines).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("collects the registers, memory and ops the program refers to", () => {
    const parsed = parseMips(SUM_ARRAY);
    if (!parsed.ok) throw new Error();
    const insts = parsed.program.prop.text.flatMap((l) => (l.prop.inst ? [l.prop.inst] : []));
    const refs = collectProgramRefs(insts, parsed.program.prop.data);
    expect([...refs.registers].sort((a, b) => a - b)).toEqual([0, 8, 9, 10, 11]);
    expect([...refs.memoryWords].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect([...refs.ops].sort()).toEqual(["add", "addi", "bne", "lw", "sw"]);
  });
});

describe("errors, at the step and line App reports them", () => {
  it("syntax error -> parser, with its line and a plain-language explanation", () => {
    const out = assembleSource("addi $t0, $zero, 1\naddi $t1, $sp, 1\n");
    expect(out).toMatchObject({
      stage: "syntax",
      line: 2,
      message: "$sp is the stack pointer, which this simulator reserves (second operand of addi)",
    });
  });

  it("several syntax errors -> all reported at once", () => {
    const out = assembleSource("ad $t0, $t1, $t2\naddi $t0, $zero, 1\nsll $t0, $t0, 40\nlw $t0, arr");
    expect(out).toMatchObject({ stage: "syntax", lines: [1, 3, 4] });
  });

  it("write to $zero -> assembler check", () => {
    const out = assembleSource("addi $t0, $zero, 1\nadd $zero, $t0, $t0");
    expect(out).toMatchObject({ stage: "compile", line: 2 });
    if (out.stage === "compile") expect(out.message).toMatch(/writes to \$zero, which is read-only/);
  });

  it("unknown label -> assembler check", () => {
    expect(assembleSource("j nowhere")).toMatchObject({ stage: "compile", line: 1, comp: "label" });
  });

  it("label case mismatch -> assembler check, with a hint", () => {
    const out = assembleSource("Loop: addi $t0, $t0, -1\nbne $t0, $zero, loop");
    expect(out).toMatchObject({ stage: "compile", line: 2 });
    if (out.stage === "compile") expect(out.message).toMatch(/case-sensitive: did you mean "Loop"\?/);
  });

  it("duplicate label -> assembler check, at the second one", () => {
    expect(assembleSource("a: addi $t0, $zero, 1\na: addi $t1, $zero, 1")).toMatchObject({ stage: "compile", line: 2 });
  });

  it("la -> staticCheck, at its line", () => {
    expect(assembleSource(".data\nx: .word 1\n.text\nla $t0, x")).toMatchObject({ stage: "compile", line: 4, comp: "check" });
  });

  it(".data larger than memory -> staticCheck, at the declaration", () => {
    const words = new Array(65).fill("1").join(", ");
    expect(assembleSource(`.data\nbig: .word ${words}\n.text\nlw $t0, 0($zero)`)).toMatchObject({
      stage: "compile",
      line: 2,
      comp: "check",
      message: "Address 256 is out of range in SW",
    });
  });

  it("unaligned access -> found by running, at the instruction", () => {
    const { error, out } = runSource("addi $t0, $zero, 2\nlw $t1, 0($t0)");
    expect(error).toBe("Unaligned LW operation on address 2");
    expect(out.sourceLines[1]).toBe(1);
  });
});

describe("assembling at a starting $pc", () => {
  it("only jump encodings change, and the program still runs", () => {
    const src = "addi $t0, $zero, 1\nj end\naddi $t1, $zero, 9\nend: addi $t2, $zero, 2";
    const at0 = assembleSource(src);
    const high = assembleSource(src, 0x00400000);
    if (at0.stage !== "ok" || high.stage !== "ok") throw new Error("didn't assemble");
    const words = (o: typeof at0) => o.listing.trimEnd().split("\n").map((l) => l.slice(-10));
    expect(words(at0)).toEqual(["0x20080001", "0x08000003", "0x20090009", "0x200A0002"]);
    expect(words(high)).toEqual(["0x20080001", "0x08100003", "0x20090009", "0x200A0002"]);
    const m = high.machine();
    expect(runSingleCycle(high.program, m, 5_000, 0x00400000).error).toBeNull();
    expect([m.reg("t1"), m.reg("t2")]).toEqual([0, 2]);
  });
});
