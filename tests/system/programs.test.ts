/**
 * System-level evaluation: complete programs, assembled and run in all four
 * execution modes the app offers —
 *
 *   single-cycle  |  pipeline (ideal)  |  pipeline + hazards  |  pipeline + hazards + early branches
 *
 * — checking the final registers/memory against hand-computed answers, that
 * every mode ends in exactly the same machine state, and the timing
 * properties each mode promises.
 *
 * Programs are built from AST nodes (tests/helpers/ast.ts), so this file runs
 * without the generated parser; tests/system/endToEnd.test.ts covers the same
 * ground starting from source text.
 */
import { describe, it, expect } from "vitest";
import { B, I, J, L, M, R, S, U, asciiz, bytes, label, text, words } from "../helpers/ast";
import { TestMachine, runPipeline, runSingleCycle, toProgram } from "../helpers/machine";
import type { DataDecl, TextLine } from "../../src/lib/mips-parser/ast";

interface Case {
  name: string;
  lines: TextLine[];
  data?: DataDecl[];
  /** Expected final register values (signed). */
  regs?: Record<string, number>;
  /** Expected final memory words (index -> signed value). */
  mem?: Record<number, number>;
  /** Instructions executed (dynamic count). */
  executed?: number;
}

const CASES: Case[] = [
  {
    name: "arithmetic and logic",
    lines: text(
      I("addi", "t0", "zero", 12),
      I("addi", "t1", "zero", -5),
      R("add", "s0", "t0", "t1"),
      R("sub", "s1", "t0", "t1"),
      R("and", "s2", "t0", "t1"),
      R("or", "s3", "t0", "t1"),
      R("slt", "s4", "t1", "t0"),
      R("slt", "s5", "t0", "t1"),
      I("slti", "s6", "t1", 0),
      L("xori", "s7", "t0", 0xff),
    ),
    regs: { s0: 7, s1: 17, s2: 12 & -5, s3: 12 | -5, s4: 1, s5: 0, s6: 1, s7: 12 ^ 0xff },
    executed: 10,
  },
  {
    name: "sum 1..10 with a bne loop",
    lines: text(
      I("addi", "t0", "zero", 10),
      I("addi", "t1", "zero", 0),
      label("loop", R("add", "t1", "t1", "t0")),
      I("addi", "t0", "t0", -1),
      B("bne", "t0", "zero", "loop"),
    ),
    regs: { t0: 0, t1: 55 },
    executed: 2 + 3 * 10,
  },
  {
    name: "sum a .word array and store the result",
    data: [words("arr", [3, 5, 7, 9])],
    lines: text(
      I("addi", "t0", "zero", 0),
      I("addi", "t1", "zero", 4),
      I("addi", "t2", "zero", 0),
      label("loop", M("lw", "t3", 0, "t0")),
      R("add", "t2", "t2", "t3"),
      I("addi", "t0", "t0", 4),
      I("addi", "t1", "t1", -1),
      B("bne", "t1", "zero", "loop"),
      M("sw", "t2", 16, "zero"),
    ),
    regs: { t2: 24, t0: 16 },
    mem: { 0: 3, 1: 5, 2: 7, 3: 9, 4: 24 },
    executed: 3 + 5 * 4 + 1,
  },
  {
    name: "strlen of an .asciiz string (lb, beq, j)",
    data: [asciiz("msg", "hello")],
    lines: text(
      I("addi", "t0", "zero", 0),
      I("addi", "t1", "zero", 0),
      label("loop", M("lb", "t2", 0, "t0")),
      B("beq", "t2", "zero", "done"),
      I("addi", "t1", "t1", 1),
      I("addi", "t0", "t0", 1),
      J("loop"),
      label("done", M("sw", "t1", 12, "zero")),
    ),
    regs: { t1: 5, t2: 0 },
    mem: { 3: 5 },
    executed: 2 + 5 * 5 + 2 + 1,
  },
  {
    name: "signed bytes: lb sign-extends, sb stores the low byte",
    data: [bytes("b", [0x80, 0x7f, 0xff, 0x01])],
    lines: text(
      M("lb", "t0", 0, "zero"),
      M("lb", "t1", 1, "zero"),
      M("lb", "t2", 2, "zero"),
      M("lb", "t3", 3, "zero"),
      I("addi", "t4", "zero", 0x1ab),
      M("sb", "t4", 5, "zero"),
    ),
    regs: { t0: -128, t1: 127, t2: -1, t3: 1 },
    mem: { 0: 0x01ff7f80, 1: 0xab00 },
  },
  {
    name: "build a constant with lui/ori, then shift it",
    lines: text(
      U("t0", 0x1234),
      L("ori", "t0", "t0", 0x5678),
      S("srl", "t1", "t0", 16),
      S("sll", "t2", "t1", 4),
      L("andi", "t3", "t0", 0xff),
    ),
    regs: { t0: 0x12345678, t1: 0x1234, t2: 0x12340, t3: 0x78 },
  },
  {
    name: "max of two values (slt + beq)",
    lines: text(
      I("addi", "a0", "zero", 17),
      I("addi", "a1", "zero", 42),
      R("slt", "t0", "a0", "a1"),
      B("beq", "t0", "zero", "first"),
      R("add", "v0", "a1", "zero"),
      J("end"),
      label("first", R("add", "v0", "a0", "zero")),
      label("end"),
    ),
    regs: { v0: 42 },
    executed: 6,
  },
  {
    name: "bubble sort a 5-element array in place",
    data: [words("arr", [5, -1, 4, 2, 3])],
    lines: text(
      I("addi", "s0", "zero", 4), // passes
      label("outer", I("addi", "t0", "zero", 0)),
      I("addi", "t1", "zero", 4), // comparisons per pass
      label("inner", M("lw", "t2", 0, "t0")),
      M("lw", "t3", 4, "t0"),
      R("slt", "t4", "t3", "t2"),
      B("beq", "t4", "zero", "noswap"),
      M("sw", "t3", 0, "t0"),
      M("sw", "t2", 4, "t0"),
      label("noswap", I("addi", "t0", "t0", 4)),
      I("addi", "t1", "t1", -1),
      B("bne", "t1", "zero", "inner"),
      I("addi", "s0", "s0", -1),
      B("bne", "s0", "zero", "outer"),
    ),
    mem: { 0: -1, 1: 2, 2: 3, 3: 4, 4: 5 },
    regs: { s0: 0 },
  },
  {
    name: "first 10 Fibonacci numbers into memory",
    lines: text(
      I("addi", "t0", "zero", 0), // F(n)
      I("addi", "t1", "zero", 1), // F(n+1)
      I("addi", "t2", "zero", 0), // address
      I("addi", "t3", "zero", 10), // count
      label("loop", M("sw", "t0", 0, "t2")),
      R("add", "t4", "t0", "t1"),
      R("add", "t0", "t1", "zero"),
      R("add", "t1", "t4", "zero"),
      I("addi", "t2", "t2", 4),
      I("addi", "t3", "t3", -1),
      B("bne", "t3", "zero", "loop"),
    ),
    mem: { 0: 0, 1: 1, 2: 1, 3: 2, 4: 3, 5: 5, 6: 8, 7: 13, 8: 21, 9: 34 },
    executed: 4 + 7 * 10,
  },
  {
    name: "back-to-back dependencies (every forwarding path)",
    lines: text(
      I("addi", "t0", "zero", 1),
      R("add", "t0", "t0", "t0"), // EX/MEM
      R("add", "t1", "t0", "zero"),
      R("add", "t1", "t1", "t0"), // EX/MEM + MEM/WB
      M("sw", "t1", 0, "zero"),
      M("lw", "t2", 0, "zero"),
      R("add", "t3", "t2", "t2"), // load-use
      label("x", B("beq", "t3", "t3", "y")), // branch on a just-computed value
      I("addi", "t5", "zero", 99), // skipped
      label("y", I("addi", "t6", "zero", 1)),
    ),
    regs: { t0: 2, t1: 4, t2: 4, t3: 8, t5: 0, t6: 1 },
    mem: { 0: 4 },
  },
];

const MODES = [
  { mode: "pipeline (ideal)", hazard: false, early: false },
  { mode: "pipeline + hazards", hazard: true, early: false },
  { mode: "pipeline + hazards + early branch", hazard: true, early: true },
] as const;

function freshMachine(c: Case): TestMachine {
  return new TestMachine().loadData(c.data ?? null);
}

describe.each(CASES)("program: $name", (c) => {
  const program = toProgram(c.lines, c.data ?? null);

  it("single-cycle: produces the expected registers and memory", () => {
    const m = freshMachine(c);
    const run = runSingleCycle(program, m);
    expect(run.error).toBeNull();
    for (const [r, v] of Object.entries(c.regs ?? {})) expect({ [r]: m.reg(r) }).toEqual({ [r]: v });
    for (const [w, v] of Object.entries(c.mem ?? {})) expect({ [`mem[${w}]`]: m.word(Number(w)) }).toEqual({ [`mem[${w}]`]: v });
    if (c.executed !== undefined) expect(run.instructions).toBe(c.executed);
    // Five micro-steps per instruction, and $pc ends just past the program.
    expect(run.states).toHaveLength(5 * run.instructions);
    expect(m.reg("pc")).toBe(program.length * 4);
  });

  it.each(MODES)("$mode: ends in exactly the single-cycle machine state", ({ hazard, early }) => {
    const ref = freshMachine(c);
    runSingleCycle(program, ref);
    const m = freshMachine(c);
    const run = runPipeline(program, m, hazard, early);
    expect(run.error).toBeNull();
    expect(m.dump()).toEqual(ref.dump());
  });

  it("pipeline timing: ideal = instructions + 4 cycles; hazard handling only ever adds cycles", () => {
    const single = runSingleCycle(program, freshMachine(c));
    const ideal = runPipeline(program, freshMachine(c), false, false).cycles.length;
    expect(ideal).toBe(single.instructions + 4);
    for (const { hazard, early } of MODES.slice(1)) {
      const cycles = runPipeline(program, freshMachine(c), hazard, early).cycles;
      expect(cycles.length).toBeGreaterThanOrEqual(ideal);
      // Every executed instruction passes through write-back exactly once.
      const retired = cycles.flatMap((cy) => cy.slots.filter((s) => s.stage === "R").map((s) => s.seq));
      expect(new Set(retired).size).toBe(retired.length);
      expect(retired).toHaveLength(single.instructions);
    }
  });

  it("pipeline: at most one instruction per stage, and in program-fetch order", () => {
    for (const { hazard, early } of [{ hazard: false, early: false }, ...MODES.slice(1)]) {
      for (const cy of runPipeline(program, freshMachine(c), hazard, early).cycles) {
        const stages = cy.slots.map((s) => s.stage);
        expect(new Set(stages).size).toBe(stages.length);
        // Older instructions (lower seq) are always further along.
        const order = "FDAMR";
        const sorted = [...cy.slots].sort((a, b) => a.seq - b.seq);
        for (let i = 1; i < sorted.length; i++) {
          expect(order.indexOf(sorted[i].stage)).toBeLessThan(order.indexOf(sorted[i - 1].stage));
        }
        // Bubbles and instructions never share a stage.
        for (const b of cy.bubbles) expect(stages).not.toContain(b);
      }
    }
  });
});

describe("hazard handling costs (whole programs)", () => {
  const cycles = (lines: TextLine[], hazard: boolean, early: boolean) =>
    runPipeline(toProgram(lines), new TestMachine(), hazard, early).cycles.length;

  it("each load-use pair costs exactly one stall cycle", () => {
    const one = text(M("lw", "t0", 0, "zero"), R("add", "t1", "t0", "t0"));
    const two = text(M("lw", "t0", 0, "zero"), R("add", "t1", "t0", "t0"), M("lw", "t2", 4, "zero"), R("add", "t3", "t2", "t2"));
    expect(cycles(one, true, false) - cycles(one, false, false)).toBe(1);
    expect(cycles(two, true, false) - cycles(two, false, false)).toBe(2);
  });

  it("a taken branch costs 3 cycles resolved in MEM, 1 resolved in ID", () => {
    const prog = text(
      label("a", B("beq", "zero", "zero", "b")),
      I("addi", "t0", "zero", 1),
      I("addi", "t0", "zero", 2),
      I("addi", "t0", "zero", 3),
      label("b", I("addi", "t1", "zero", 1)),
      I("addi", "t2", "zero", 1),
    );
    const ideal = cycles(prog, false, false);
    expect(cycles(prog, true, false) - ideal).toBe(3);
    expect(cycles(prog, true, true) - ideal).toBe(1);
  });

  it("early branches make the 10-iteration sum loop cheaper overall", () => {
    const loop = CASES[1].lines;
    expect(cycles(loop, true, true)).toBeLessThan(cycles(loop, true, false));
  });
});

describe("run-time errors stop every mode at the same instruction", () => {
  const faulty = text(
    I("addi", "t0", "zero", 1),
    I("addi", "t1", "zero", 6),
    M("sw", "t0", 0, "t1"), // unaligned
    I("addi", "t2", "zero", 1),
  );

  it.each([
    { mode: "single-cycle", run: (m: TestMachine) => runSingleCycle(toProgram(faulty), m).error },
    { mode: "pipeline", run: (m: TestMachine) => runPipeline(toProgram(faulty), m).error },
    { mode: "pipeline + hazards", run: (m: TestMachine) => runPipeline(toProgram(faulty), m, true).error },
    { mode: "pipeline + early", run: (m: TestMachine) => runPipeline(toProgram(faulty), m, true, true).error },
  ])("$mode", ({ run }) => {
    const m = new TestMachine();
    expect(run(m)).toBe("Unaligned SW operation on address 6");
    expect([m.reg("t0"), m.reg("t1"), m.reg("t2")]).toEqual([1, 6, 0]);
    expect(m.mem.every((w) => w.every((b) => b === 0))).toBe(true);
  });

  it("running off the end of memory is caught too", () => {
    const m = new TestMachine(64);
    const run = runSingleCycle(toProgram(text(I("addi", "t0", "zero", 64), M("lw", "t1", 0, "t0"))), m);
    expect(run.error).toBe("Address 64 is out of range in LW");
  });
});

describe("starting $pc: every program behaves the same at a different load address", () => {
  const BASE = 0x00400000;

  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const at0 = new TestMachine().loadData(c.data ?? null);
    runSingleCycle(toProgram(c.lines, c.data ?? null), at0);
    const expected = at0.dump();
    expected.regs.pc = BASE + expected.regs.pc;

    const single = new TestMachine().loadData(c.data ?? null);
    expect(runSingleCycle(toProgram(c.lines, c.data ?? null, BASE), single, 5_000, BASE).error).toBeNull();
    expect(single.dump()).toEqual(expected);

    for (const { hazard, early } of [{ hazard: false, early: false }, ...MODES.slice(1)]) {
      const m = new TestMachine().loadData(c.data ?? null);
      expect(runPipeline(toProgram(c.lines, c.data ?? null, BASE), m, hazard, early, 2_000, BASE).error).toBeNull();
      expect(m.dump()).toEqual(expected);
    }
  });
});
