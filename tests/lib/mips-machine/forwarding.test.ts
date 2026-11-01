import { describe, it, expect } from "vitest";
import {
  FWD_EX_MEM, FWD_MEM_WB, FWD_NONE, computeBranchForwarding, computeForwarding, formatFwd,
} from "../../../src/lib/mips-machine/forwarding";
import type { CycleResult } from "../../../src/lib/mips-machine/pipeline";
import type { ProgramLine } from "../../../src/lib/mips-machine/interpreter";
import { B, I, J, M, R, label, text } from "../../helpers/ast";
import { TestMachine, runPipeline, toProgram } from "../../helpers/machine";
import { h, n } from "../../helpers/bits";

/** The first cycle in which the instruction at `pc` is in `stage`. */
function cycleWith(cycles: CycleResult[], pc: number, stage: string): CycleResult {
  const c = cycles.find((cy) => cy.slots.some((s) => s.pc === pc && s.stage === stage));
  if (!c) throw new Error(`no cycle with pc ${pc} in ${stage}`);
  return c;
}

/** Runs at most `maxCycles` cycles: every program here finishes well within
 * that, and a few deliberately loop forever (a branch or jump to itself) and
 * only their first cycles matter. */
const run = (program: ProgramLine[], hazard = false, early = false, maxCycles = 50) =>
  runPipeline(program, new TestMachine(), hazard, early, maxCycles).cycles;

describe("formatFwd", () => {
  it("prints the two-bit code", () => {
    expect(([FWD_NONE, FWD_MEM_WB, FWD_EX_MEM] as const).map((sel) => formatFwd(sel))).toEqual(["00", "01", "10"]);
  });
});

describe("computeForwarding (ForwardA / ForwardB into the ALU)", () => {
  it("returns null when nothing is in EX", () => {
    const cycles = run(toProgram(text(I("addi", "t0", "zero", 1))));
    expect(computeForwarding(cycles[0].slots)).toBeNull();
  });

  it("EX hazard: forwards the ALU result from EX/MEM (10) to both operands", () => {
    const cycles = run(toProgram(text(I("addi", "t0", "zero", 1), R("add", "t1", "t0", "t0"))));
    const f = computeForwarding(cycleWith(cycles, 1, "A").slots)!;
    expect(f.ex.op).toBe("add");
    expect(f.exMem?.op).toBe("addi");
    expect([f.fwdA, f.fwdB]).toEqual([FWD_EX_MEM, FWD_EX_MEM]);
    expect([f.loadUseA, f.loadUseB]).toEqual([false, false]);
  });

  it("MEM hazard: forwards the write-back value from MEM/WB (01)", () => {
    const cycles = run(toProgram(text(I("addi", "t0", "zero", 1), I("addi", "t5", "zero", 2), R("add", "t1", "t2", "t0"))));
    const f = computeForwarding(cycleWith(cycles, 2, "A").slots)!;
    expect(f.memWb?.pc).toBe(0);
    expect([f.fwdA, f.fwdB]).toEqual([FWD_NONE, FWD_MEM_WB]);
  });

  it("when both match, the more recent result (EX/MEM) wins", () => {
    const cycles = run(toProgram(text(I("addi", "t0", "zero", 1), I("addi", "t0", "t0", 1), R("add", "t1", "t0", "zero"))));
    const f = computeForwarding(cycleWith(cycles, 2, "A").slots)!;
    expect(f.fwdA).toBe(FWD_EX_MEM);
  });

  it("no hazard: 00 for independent instructions", () => {
    const cycles = run(toProgram(text(I("addi", "t0", "zero", 1), R("add", "t1", "t2", "t3"))));
    const f = computeForwarding(cycleWith(cycles, 1, "A").slots)!;
    expect([f.fwdA, f.fwdB]).toEqual([FWD_NONE, FWD_NONE]);
  });

  it("stores and branches don't forward (they write no register)", () => {
    const cycles = run(toProgram(text(M("sw", "t0", 0, "zero"), R("add", "t1", "t0", "t0"))));
    expect(computeForwarding(cycleWith(cycles, 1, "A").slots)!.fwdA).toBe(FWD_NONE);
  });

  it("$zero is never forwarded, even if EX/MEM's write register is 0", () => {
    // The assembler won't produce a write to $zero, so fake one: take the
    // cycle where add $t1, $zero, $zero is in EX and set the EX/MEM
    // instruction's write register to 0.
    const cycles = run(toProgram(text(I("addi", "t0", "zero", 1), R("add", "t1", "zero", "zero"))));
    const slots = cycleWith(cycles, 1, "A").slots.map((s) =>
      s.stage === "M" ? { ...s, state: { ...s.state, vals: { ...s.state.vals, REGWR: n(0) } } } : s,
    );
    const f = computeForwarding(slots)!;
    expect([f.fwdA, f.fwdB]).toEqual([FWD_NONE, FWD_NONE]);
  });

  it("an instruction that will fail is fetched, but nothing is fetched after it", () => {
    const program: ProgramLine[] = [{ op: "add", bin: h("01080020") }, ...toProgram(text(R("add", "t1", "zero", "zero")))];
    const cycles = run(program);
    expect(cycles.some((c) => c.slots.some((s) => s.pc === 1))).toBe(false);
  });

  it("load-use without a stall: flags the hazard and forwards nothing (the address isn't the data)", () => {
    const cycles = run(toProgram(text(M("lw", "t0", 0, "zero"), R("add", "t1", "t0", "t2"))), false);
    const f = computeForwarding(cycleWith(cycles, 1, "A").slots)!;
    expect([f.fwdA, f.loadUseA]).toEqual([FWD_NONE, true]);
    expect([f.fwdB, f.loadUseB]).toEqual([FWD_NONE, false]);
  });

  it("load-use with the stall: the loaded value comes from MEM/WB (01)", () => {
    const cycles = run(toProgram(text(M("lw", "t0", 0, "zero"), R("add", "t1", "t0", "t2"))), true);
    const f = computeForwarding(cycleWith(cycles, 1, "A").slots)!;
    expect(f.memWb?.op).toBe("lw");
    expect([f.fwdA, f.loadUseA]).toEqual([FWD_MEM_WB, false]);
  });

  it("with early branches, branches and jumps in EX get no forwarding signals", () => {
    const br = run(toProgram(text(I("addi", "t5", "zero", 1), label("x", B("beq", "t1", "t2", "x")))), true, true);
    expect(computeForwarding(cycleWith(br, 1, "A").slots, true)).toBeNull();
    // ...but without early branches the branch's comparison runs in EX like any ALU op.
    expect(computeForwarding(cycleWith(br, 1, "A").slots, false)).not.toBeNull();

    const jmp = run(toProgram(text(label("x", J("x")))), false);
    expect(computeForwarding(cycleWith(jmp, 0, "A").slots, true)).toBeNull();
  });
});

describe("computeBranchForwarding (FwdRD1 / FwdRD2 into the ID comparator)", () => {
  it("returns null unless a branch is in ID", () => {
    const cycles = run(toProgram(text(I("addi", "t0", "zero", 1), R("add", "t1", "t0", "t0"))), true, true);
    expect(cycles.every((c) => computeBranchForwarding(c.slots) === null)).toBe(true);
  });

  it("after the one-cycle stall, takes an ALU result from EX/MEM (10)", () => {
    const cycles = run(toProgram(text(I("addi", "t0", "zero", 1), label("x", B("beq", "t0", "zero", "x")))), true, true);
    const stalled = cycles.find((c) => c.slots.some((s) => s.op === "beq" && s.stage === "D" && s.stalled))!;
    const f = computeBranchForwarding(stalled.slots)!;
    expect(f.id.op).toBe("beq");
    expect([f.fwdRd1, f.fwdRd2]).toEqual([FWD_EX_MEM, FWD_NONE]);
  });

  it("takes an older result from MEM/WB (01)", () => {
    const program = toProgram(
      text(I("addi", "t0", "zero", 1), I("addi", "t5", "zero", 1), I("addi", "t6", "zero", 1), label("x", B("beq", "zero", "t0", "x"))),
    );
    const cycles = run(program, true, true);
    const f = computeBranchForwarding(cycleWith(cycles, 3, "D").slots)!;
    expect([f.fwdRd1, f.fwdRd2]).toEqual([FWD_NONE, FWD_MEM_WB]);
  });
});
