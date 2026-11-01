import { describe, it, expect } from "vitest";
import {
  PendingState, PipelineEngine, STAGES, addressOf, destReg, isBranchOp, isJumpOp, isLoadUseHazard, precompute,
  programIndexOf, stallReason,
} from "../../../src/lib/mips-machine/pipeline";
import type { MachineState } from "../../../src/lib/mips-machine/machineState";
import { B, I, J, M, R, label, text } from "../../helpers/ast";
import { TestMachine, continuePipeline, describeCycle, runPipeline, runSingleCycle, toProgram } from "../../helpers/machine";
import { hex, n, num, u32 } from "../../helpers/bits";

// ---- PendingState --------------------------------------------------------------

describe("PendingState", () => {
  const setup = () => {
    const m = new TestMachine(64).setReg("t0", 5).setWord(1, 0x11223344);
    return { m, p: new PendingState(m.readers()) };
  };

  it("reads through to the committed machine when nothing is pending", () => {
    const { p } = setup();
    expect(num(p.readReg("t0"))).toBe(5);
    expect(num(p.readReg("$t0"))).toBe(5);
    expect(hex(p.readWord(4))).toBe("0x11223344");
  });

  it("in-flight register writes shadow the committed value until committed", () => {
    const { m, p } = setup();
    p.writeReg("t0", n(9));
    expect(num(p.readReg("t0"))).toBe(9);
    expect(m.reg("t0")).toBe(5);
    p.commitReg("t0");
    // Dropped: the real register file is the source of truth again.
    expect(num(p.readReg("t0"))).toBe(5);
  });

  it("counts overlapping writes to the same location", () => {
    const { p } = setup();
    p.writeReg("$t0", n(1));
    p.writeReg("t0", n(2));
    p.commitReg("t0");
    expect(num(p.readReg("t0"))).toBe(2);
    p.commitReg("t0");
    expect(num(p.readReg("t0"))).toBe(5);
    p.commitReg("t0"); // extra commits are harmless
    expect(num(p.readReg("t0"))).toBe(5);
  });

  it("byte writes merge into the (pending or committed) word", () => {
    const { p } = setup();
    p.writeMem({ addr: 5, value: n(0xaa), byte: true });
    expect(hex(p.readWord(4))).toBe("0x1122AA44");
    p.writeMem({ addr: 4, value: n(0xbb), byte: true });
    expect(hex(p.readWord(4))).toBe("0x1122AABB");
  });

  it("readByte sign-extends", () => {
    const { p } = setup();
    p.writeMem({ addr: 0, value: n(0x80), byte: true });
    expect(num(p.readByte(0))).toBe(-128);
  });

  it("uses the same alignment and range errors as the memory bank", () => {
    const { p } = setup();
    expect(() => p.readWord(2)).toThrow("Unaligned LW operation on address 2");
    expect(() => p.readWord(64)).toThrow("Address 64 is out of range in LW");
    expect(() => p.readByte(-1)).toThrow("Address -1 is out of range in LB");
    expect(() => p.writeMem({ addr: 6, value: n(0), byte: false })).toThrow("Unaligned SW operation on address 6");
    expect(() => p.writeMem({ addr: 64, value: n(0), byte: true })).toThrow("Address 64 is out of range in SB");
  });

  it("snapshot/load copy the in-flight writes (later changes don't leak either way)", () => {
    const { m, p } = setup();
    p.writeReg("t1", n(1));
    const snap = p.snapshot();
    p.writeReg("t1", n(2));
    const q = new PendingState(m.readers());
    q.load(snap);
    expect(num(q.readReg("t1"))).toBe(1);
    q.commitReg("t1");
    expect(num(q.readReg("t1"))).toBe(0);
    expect(snap.regs[0][1].count).toBe(1);
  });
});

// ---- precompute ----------------------------------------------------------------

describe("precompute", () => {
  it("runs all five stages and records each stage's reads", () => {
    const m = new TestMachine().setReg("t0", 4).setWord(2, 42);
    const program = toProgram(text(M("lw", "t1", 4, "t0")));
    const pre = precompute(program, 0, new PendingState(m.readers()));
    expect(pre.states.map((s) => s.stage)).toEqual(STAGES);
    expect(pre.reads).toEqual([
      [],
      [{ kind: "reg", name: "t0" }, { kind: "reg", name: "t1" }],
      [],
      [{ kind: "word", addr: 8 }],
      [],
    ]);
    expect(pre.nextPc).toBe(1);
    expect(pre.wires).toEqual(pre.states.flatMap((s) => s.activeWires));
  });

  it("applies the instruction's writes to the pending state, so later instructions see them", () => {
    const m = new TestMachine();
    const program = toProgram(text(I("addi", "t0", "zero", 7), R("add", "t1", "t0", "t0"), M("sw", "t1", 0, "zero")));
    const pending = new PendingState(m.readers());
    precompute(program, 0, pending);
    const second = precompute(program, 1, pending);
    expect(num(second.states[4].regWrite!.value)).toBe(14);
    precompute(program, 2, pending);
    expect(num(pending.readWord(0))).toBe(14);
    expect(m.word(0)).toBe(0); // nothing committed to the machine itself
  });

  it("stops at an erroring stage, with no next PC", () => {
    const program = toProgram(text(M("sw", "t0", 2, "zero")));
    const pre = precompute(program, 0, new PendingState(new TestMachine().readers()));
    expect(pre.states).toHaveLength(4);
    expect(pre.states[3].error).toBe("Unaligned SW operation on address 2");
    expect(pre.states[3].memWrite).toBeNull();
    expect(pre.nextPc).toBeNull();
  });

  it("follows taken branches and jumps in nextPc", () => {
    const program = toProgram(text(B("beq", "zero", "zero", "t"), I("addi", "t0", "zero", 1), label("t", J("t"))));
    const pending = new PendingState(new TestMachine().readers());
    expect(precompute(program, 0, pending).nextPc).toBe(2);
    expect(precompute(program, 2, pending).nextPc).toBe(2);
  });
});

// ---- Hazard predicates ---------------------------------------------------------

/** MachineState of program[pc] at `stage`, computed against a blank machine. */
function stateOf(program: ReturnType<typeof toProgram>, pc: number, stage: "D" | "A" | "M"): MachineState {
  const pre = precompute(program, pc, new PendingState(new TestMachine().readers()));
  return pre.states[STAGES.indexOf(stage)];
}

describe("hazard predicates", () => {
  const program = toProgram(
    text(
      M("lw", "t0", 0, "zero"), // 0
      R("add", "t1", "t0", "t2"), // 1 uses t0 as rs
      R("add", "t1", "t2", "t0"), // 2 uses t0 as rt
      R("add", "t1", "t2", "t3"), // 3 independent
      label("x", B("beq", "t1", "zero", "x")), // 4 branch on t1
      I("addi", "t1", "zero", 1), // 5 writes t1
      J("x"), // 6
      M("sw", "t0", 0, "zero"), // 7
    ),
  );

  it("isBranchOp / isJumpOp", () => {
    expect(["beq", "bne", "j", "add", "la"].map(isBranchOp)).toEqual([true, true, false, false, false]);
    expect(["beq", "j", "add", "nope"].map(isJumpOp)).toEqual([false, true, false, false]);
  });

  it("destReg is the register an instruction writes, if any", () => {
    expect(destReg(stateOf(program, 0, "A"))).toBe(8);
    expect(destReg(stateOf(program, 5, "A"))).toBe(9);
    expect(destReg(stateOf(program, 7, "A"))).toBeNull(); // sw writes no register
    expect(destReg(stateOf(program, 4, "A"))).toBeNull(); // beq neither
    expect(destReg(undefined)).toBeNull();
  });

  it("isLoadUseHazard: a load in EX whose rt the instruction in ID reads", () => {
    const lw = stateOf(program, 0, "A");
    expect(isLoadUseHazard(lw, stateOf(program, 1, "D"))).toBe(true);
    expect(isLoadUseHazard(lw, stateOf(program, 2, "D"))).toBe(true);
    expect(isLoadUseHazard(lw, stateOf(program, 3, "D"))).toBe(false);
    // Only loads cause it.
    expect(isLoadUseHazard(stateOf(program, 5, "A"), stateOf(program, 4, "D"))).toBe(false);
  });

  it("stallReason: load-use, and nothing without a load", () => {
    expect(stallReason(stateOf(program, 1, "D"), stateOf(program, 0, "A"), undefined, false)).toBe("load-use");
    expect(stallReason(stateOf(program, 3, "D"), stateOf(program, 0, "A"), undefined, false)).toBeNull();
    expect(stallReason(undefined, stateOf(program, 0, "A"))).toBeNull();
  });

  it("stallReason with early branches: producer in EX, or a load in MEM", () => {
    const beq = stateOf(program, 4, "D");
    expect(stallReason(beq, stateOf(program, 5, "A"), undefined, true)).toBe("branch-ex");
    // An ALU result in MEM can be forwarded: no stall.
    expect(stallReason(beq, undefined, stateOf(program, 5, "M"), true)).toBeNull();
    // Without early branches the branch is an ordinary EX instruction.
    expect(stallReason(beq, stateOf(program, 5, "A"), undefined, false)).toBeNull();
  });

  it("stallReason: a load in MEM stalls an early branch that reads its target", () => {
    const loadProgram = toProgram(text(M("lw", "t1", 0, "zero"), label("x", B("beq", "t1", "zero", "x"))));
    expect(stallReason(stateOf(loadProgram, 1, "D"), undefined, stateOf(loadProgram, 0, "M"), true)).toBe("branch-mem");
  });
});

// ---- The engine ------------------------------------------------------------------

describe("PipelineEngine: ideal pipeline (no hazard unit)", () => {
  const program = toProgram(text(I("addi", "t0", "zero", 1), I("addi", "t1", "zero", 2), I("addi", "t2", "zero", 3)));

  it("an N-instruction program takes N + 4 cycles", () => {
    const { cycles } = runPipeline(program, new TestMachine());
    expect(cycles).toHaveLength(7);
  });

  it("each instruction moves one stage per cycle", () => {
    const { cycles } = runPipeline(program, new TestMachine());
    expect(cycles.map(describeCycle)).toEqual([
      "F:addi@0 D:- A:- M:- R:-",
      "F:addi@1 D:addi@0 A:- M:- R:-",
      "F:addi@2 D:addi@1 A:addi@0 M:- R:-",
      "F:- D:addi@2 A:addi@1 M:addi@0 R:-",
      "F:- D:- A:addi@2 M:addi@1 R:addi@0",
      "F:- D:- A:- M:addi@2 R:addi@1",
      "F:- D:- A:- M:- R:addi@2",
    ]);
    expect(cycles.flatMap((c) => c.slots.map((s) => s.seq))).not.toContain(3);
  });

  it("reports $pc on each fetch, then parks it after the last instruction once", () => {
    const { cycles } = runPipeline(program, new TestMachine());
    expect(cycles.map((c) => (c.effects.pc ? num(c.effects.pc) : null))).toEqual([0, 4, 8, 12, null, null, null]);
  });

  it("register reads happen in Decode, writes in write-back", () => {
    const { cycles } = runPipeline(program, new TestMachine());
    expect(cycles[1].effects.regReads).toEqual(["zero", "t0"]);
    expect(cycles[4].effects.regWrites).toEqual([{ name: "t0", value: n(1) }]);
    expect(cycles.slice(0, 4).every((c) => c.effects.regWrites.length === 0)).toBe(true);
  });

  it("dependent instructions still see their predecessors' results (values are fixed at fetch)", () => {
    const m = new TestMachine();
    const deps = toProgram(text(I("addi", "t0", "zero", 5), R("add", "t1", "t0", "t0"), R("add", "t2", "t1", "t0")));
    runPipeline(deps, m);
    expect([m.reg("t0"), m.reg("t1"), m.reg("t2")]).toEqual([5, 10, 15]);
  });

  it("the cycle summary merges each stage's vals from the instruction in that stage", () => {
    const m = new TestMachine();
    const { cycles } = runPipeline(toProgram(text(I("addi", "t0", "zero", 5), I("addi", "t1", "zero", 6))), m);
    // Cycle 3: addi t1 in D (reads $zero for rs, t1 for rt), addi t0 in A (result 5).
    const c3 = cycles[2].summary;
    expect(num(c3.vals.ALUres!)).toBe(5);
    expect(num(c3.vals.REGWR!)).toBe(9);
    expect(c3.pc).toBe(0); // the oldest in flight
  });

  it("an empty program can't step", () => {
    const engine = new PipelineEngine([], new TestMachine().readers());
    expect(engine.canStep()).toBe(false);
    expect(engine.step()).toBeNull();
  });

  it("ideal mode never stalls, flushes or makes bubbles", () => {
    const loopy = toProgram(
      text(I("addi", "t0", "zero", 3), label("top", M("lw", "t1", 0, "zero")), R("add", "t2", "t1", "t1"), I("addi", "t0", "t0", -1), B("bne", "t0", "zero", "top")),
    );
    const { cycles } = runPipeline(loopy, new TestMachine());
    expect(cycles.every((c) => c.bubbles.length === 0 && c.slots.every((s) => !s.stalled && !s.flushed))).toBe(true);
  });
});

describe("PipelineEngine: load-use stall (hazard unit on)", () => {
  const program = toProgram(text(M("lw", "t0", 0, "zero"), R("add", "t1", "t0", "t0"), I("addi", "t2", "zero", 1)));

  it("holds IF and ID for one cycle and sends a bubble into EX", () => {
    const m = new TestMachine().setWord(0, 21);
    const { cycles } = runPipeline(program, m, true);
    expect(cycles.map(describeCycle)).toEqual([
      "F:lw@0 D:- A:- M:- R:-",
      "F:add@1 D:lw@0 A:- M:- R:-",
      "F:addi@2 D:add@1 A:lw@0 M:- R:-",
      "F:addi@2(stall) D:add@1(stall) A:bubble M:lw@0 R:-",
      "F:- D:addi@2 A:add@1 M:bubble R:lw@0",
      "F:- D:- A:addi@2 M:add@1 R:bubble",
      "F:- D:- A:- M:addi@2 R:add@1",
      "F:- D:- A:- M:- R:addi@2",
    ]);
    expect(m.reg("t1")).toBe(42);
  });

  it("doesn't fetch during the stall", () => {
    const { cycles } = runPipeline(program, new TestMachine(), true);
    expect(cycles[3].effects.pc).toBeNull();
  });

  it("no stall when the next instruction doesn't use the loaded register", () => {
    const indep = toProgram(text(M("lw", "t0", 0, "zero"), R("add", "t1", "t2", "t3")));
    expect(runPipeline(indep, new TestMachine(), true).cycles).toHaveLength(6);
  });
});

describe("PipelineEngine: taken branches with predict-not-taken", () => {
  const program = toProgram(
    text(
      B("beq", "zero", "zero", "target"),
      I("addi", "t0", "zero", 1),
      I("addi", "t1", "zero", 2),
      I("addi", "t2", "zero", 3),
      label("target", I("addi", "t3", "zero", 4)),
    ),
  );

  it("resolving in MEM: three wrong-path instructions are fetched and flushed", () => {
    const m = new TestMachine();
    const { cycles } = runPipeline(program, m, true, false);
    expect(cycles.map(describeCycle)).toEqual([
      "F:beq@0 D:- A:- M:- R:-",
      "F:addi@1 D:beq@0 A:- M:- R:-",
      "F:addi@2 D:addi@1 A:beq@0 M:- R:-",
      "F:addi@3(flush) D:addi@2(flush) A:addi@1(flush) M:beq@0 R:-",
      "F:addi@4 D:bubble A:bubble M:bubble R:beq@0",
      "F:- D:addi@4 A:bubble M:bubble R:bubble",
      "F:- D:- A:addi@4 M:bubble R:bubble",
      "F:- D:- A:- M:addi@4 R:bubble",
      "F:- D:- A:- M:- R:addi@4",
    ]);
    expect([m.reg("t0"), m.reg("t1"), m.reg("t2"), m.reg("t3")]).toEqual([0, 0, 0, 4]);
  });

  it("resolving in ID (early branches): only one instruction is flushed", () => {
    const m = new TestMachine();
    const { cycles } = runPipeline(program, m, true, true);
    expect(cycles.map(describeCycle).slice(0, 3)).toEqual([
      "F:beq@0 D:- A:- M:- R:-",
      "F:addi@1(flush) D:beq@0 A:- M:- R:-",
      "F:addi@4 D:bubble A:beq@0 M:- R:-",
    ]);
    expect(cycles).toHaveLength(7);
    expect([m.reg("t0"), m.reg("t3")]).toEqual([0, 4]);
  });

  it("ideal mode fetches the target straight away", () => {
    const { cycles } = runPipeline(program, new TestMachine(), false);
    expect(cycles.map(describeCycle)[1]).toBe("F:addi@4 D:beq@0 A:- M:- R:-");
    expect(cycles).toHaveLength(6);
  });

  it("wrong-path instructions read registers but never write anything", () => {
    const m = new TestMachine();
    const { cycles } = runPipeline(program, m, true, false);
    const writes = cycles.flatMap((c) => c.effects.regWrites.map((w) => w.name));
    expect(writes).toEqual(["t3"]);
    expect(cycles.flatMap((c) => c.effects.memWrites)).toEqual([]);
  });

  it("a not-taken branch costs nothing", () => {
    const notTaken = toProgram(text(B("bne", "zero", "zero", "x"), I("addi", "t0", "zero", 1), label("x", I("addi", "t1", "zero", 1))));
    expect(runPipeline(notTaken, new TestMachine(), true, false).cycles).toHaveLength(7);
    expect(runPipeline(notTaken, new TestMachine(), true, true).cycles).toHaveLength(7);
  });

  it("jumps are predicted and flushed the same way", () => {
    const jprog = toProgram(text(J("end"), I("addi", "t0", "zero", 1), I("addi", "t1", "zero", 1), label("end", I("addi", "t2", "zero", 1))));
    const late = new TestMachine();
    expect(runPipeline(jprog, late, true, false).cycles).toHaveLength(9);
    const early = new TestMachine();
    expect(runPipeline(jprog, early, true, true).cycles).toHaveLength(7);
    for (const m of [late, early]) expect([m.reg("t0"), m.reg("t1"), m.reg("t2")]).toEqual([0, 0, 1]);
  });
});

describe("PipelineEngine: early-branch data hazards", () => {
  it("a branch waits one cycle for an ALU result being computed in EX", () => {
    const program = toProgram(text(I("addi", "t0", "zero", 1), label("x", B("beq", "t0", "zero", "x")), I("addi", "t1", "zero", 1)));
    const { cycles } = runPipeline(program, new TestMachine(), true, true);
    expect(describeCycle(cycles[2])).toBe("F:addi@2 D:beq@1 A:addi@0 M:- R:-");
    expect(describeCycle(cycles[3])).toBe("F:addi@2(stall) D:beq@1(stall) A:bubble M:addi@0 R:-");
    expect(describeCycle(cycles[4])).toBe("F:- D:addi@2 A:beq@1 M:bubble R:addi@0");
  });

  it("a branch waits two cycles for a load", () => {
    const program = toProgram(text(M("lw", "t0", 0, "zero"), label("x", B("bne", "t0", "zero", "x")), I("addi", "t1", "zero", 1)));
    const { cycles } = runPipeline(program, new TestMachine(), true, true);
    const stalls = cycles.filter((c) => c.slots.some((s) => s.stalled));
    expect(stalls).toHaveLength(2);
    expect(stalls.every((c) => c.slots.find((s) => s.stage === "D")?.op === "bne")).toBe(true);
  });
});

describe("PipelineEngine: errors", () => {
  it("halts in the cycle the failing instruction reaches the failing stage", () => {
    const program = toProgram(text(I("addi", "t0", "zero", 1), M("lw", "t1", 2, "zero"), I("addi", "t2", "zero", 1)));
    const m = new TestMachine();
    const { cycles, engine, error } = runPipeline(program, m);
    expect(error).toBe("Unaligned LW operation on address 2");
    expect(cycles).toHaveLength(5); // lw (fetched in cycle 2) reaches M in cycle 5
    const last = cycles[cycles.length - 1];
    expect(last.summary.pc).toBe(1);
    expect(last.summary.error).toBe(error);
    expect(engine.canStep()).toBe(false);
    expect(engine.step()).toBeNull();
    // The addi before it completed; the one after never wrote.
    expect([m.reg("t0"), m.reg("t2")]).toEqual([1, 0]);
  });
});

describe("PipelineEngine: snapshot / restore", () => {
  const program = toProgram(
    text(
      I("addi", "t0", "zero", 3),
      label("top", M("sw", "t0", 0, "zero")),
      M("lw", "t1", 0, "zero"),
      R("add", "t2", "t2", "t1"),
      I("addi", "t0", "t0", -1),
      B("bne", "t0", "zero", "top"),
    ),
  );

  it("restoring a mid-run snapshot (with the machine as it was) replays the rest identically", () => {
    for (const [hazard, early] of [[false, false], [true, false], [true, true]]) {
      const m = new TestMachine();
      const engine = new PipelineEngine(program, m.readers());
      continuePipeline(engine, m, hazard, early, 9);
      const snap = engine.snapshot();
      const saved = m.dump();

      const rest = continuePipeline(engine, m, hazard, early);
      const m2 = new TestMachine();
      Object.entries(saved.regs).forEach(([k, v]) => m2.setReg(k, v));
      saved.mem.forEach((w, i) => m2.setWord(i, w));
      const replay = continuePipeline(PipelineEngine.restore(program, m2.readers(), snap), m2, hazard, early);

      expect(replay.cycles.map(describeCycle)).toEqual(rest.cycles.map(describeCycle));
      expect(m2.dump()).toEqual(m.dump());
    }
  });

  it("a snapshot isn't changed by later steps and can be restored twice", () => {
    const m = new TestMachine();
    const engine = new PipelineEngine(program, m.readers());
    continuePipeline(engine, m, true, false, 4);
    const snap = engine.snapshot();
    const frozen = JSON.stringify(snap);
    continuePipeline(engine, m, true, false);
    expect(JSON.stringify(snap)).toBe(frozen);
    PipelineEngine.restore(program, m.readers(), snap).step(true, false);
    expect(JSON.stringify(snap)).toBe(frozen);
  });
});

describe("PipelineEngine agrees with the single-cycle interpreter", () => {
  it("on a loop with loads, stores and a backward branch, in every mode", () => {
    const program = toProgram(
      text(
        I("addi", "t0", "zero", 4),
        label("top", M("sw", "t0", 0, "zero")),
        M("lw", "t1", 0, "zero"),
        R("add", "t2", "t2", "t1"),
        I("addi", "t0", "t0", -1),
        B("bne", "t0", "zero", "top"),
      ),
    );
    const reference = new TestMachine();
    runSingleCycle(program, reference);
    expect(reference.reg("t2")).toBe(10);
    for (const [hazard, early] of [[false, false], [true, false], [true, true]] as const) {
      const m = new TestMachine();
      runPipeline(program, m, hazard, early);
      expect(m.dump()).toEqual(reference.dump());
    }
  });
});

// ---- Starting $pc (textBase) --------------------------------------------------

describe("addressOf / programIndexOf", () => {
  it("convert between program index and byte address, from the starting $pc", () => {
    expect(num(addressOf(0))).toBe(0);
    expect(num(addressOf(3))).toBe(12);
    expect(hex(addressOf(2, 0x00400000))).toBe("0x00400008");
    expect(programIndexOf(addressOf(5, 0x00400000), 0x00400000)).toBe(5);
    expect(programIndexOf(n(12))).toBe(3);
  });

  it("round-trip for bases near the top of the address space", () => {
    for (const base of [0, 4, 0x00400000, 0x7ffffff0, 0x80000000, 0xfffffff0]) {
      for (const pc of [0, 1, 3]) expect(programIndexOf(addressOf(pc, base), base)).toBe(pc);
    }
    expect(u32(addressOf(1, 0xfffffff0))).toBe(0xfffffff4);
  });

  it("addresses below the program give a negative index (so canRun rejects them)", () => {
    expect(programIndexOf(n(0x003ffffc), 0x00400000)).toBe(-1);
  });
});

describe("PipelineEngine with a starting $pc", () => {
  const BASE = 0x00400000;
  const lines = () =>
    text(
      I("addi", "t0", "zero", 2),
      label("loop", I("addi", "t0", "t0", -1)),
      B("bne", "t0", "zero", "loop"),
      J("end"),
      I("addi", "t1", "zero", 99),
      label("end", I("addi", "t2", "zero", 7)),
    );

  it("reports $pc as real byte addresses", () => {
    const { cycles } = runPipeline(toProgram(lines(), null, BASE), new TestMachine(), false, false, 2_000, BASE);
    const pcs = cycles.flatMap((c) => (c.effects.pc ? [u32(c.effects.pc)] : []));
    expect(pcs[0]).toBe(BASE);
    expect(pcs[1]).toBe(BASE + 4);
    expect(pcs.every((a) => a >= BASE)).toBe(true);
  });

  it("follows branches and absolute jumps there, in every mode", () => {
    for (const [hazard, early] of [[false, false], [true, false], [true, true]] as const) {
      const m = new TestMachine();
      const run = runPipeline(toProgram(lines(), null, BASE), m, hazard, early, 2_000, BASE);
      expect(run.error).toBeNull();
      expect([m.reg("t0"), m.reg("t1"), m.reg("t2")]).toEqual([0, 0, 7]);
      expect(u32(m.regs.pc)).toBe(BASE + 6 * 4);
    }
  });

  it("matches the single-cycle interpreter at the same base", () => {
    const ref = new TestMachine();
    runSingleCycle(toProgram(lines(), null, BASE), ref, 5_000, BASE);
    const m = new TestMachine();
    runPipeline(toProgram(lines(), null, BASE), m, true, true, 2_000, BASE);
    expect(m.dump()).toEqual(ref.dump());
  });

  it("restore() needs the same base to carry on correctly", () => {
    const program = toProgram(lines(), null, BASE);
    const m = new TestMachine();
    const engine = new PipelineEngine(program, m.readers(), BASE);
    continuePipeline(engine, m, false, false, 3);
    const snap = engine.snapshot();
    const rest = continuePipeline(PipelineEngine.restore(program, m.readers(), snap, BASE), m);
    expect(rest.error).toBeNull();
    expect(m.reg("t2")).toBe(7);
  });

  it("precompute takes the base too: j's target is found relative to it", () => {
    const program = toProgram(lines(), null, BASE);
    const pending = new PendingState(new TestMachine().readers());
    expect(precompute(program, 3, pending, BASE).nextPc).toBe(5);
    // Without the base, the absolute jump target lands far outside the program.
    expect(precompute(program, 3, new PendingState(new TestMachine().readers())).nextPc).toBe(0x00100005);
  });
});
