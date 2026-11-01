import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRegisterBank } from "../../src/hooks/useRegisterBank";
import { useMemoryBank } from "../../src/hooks/useMemoryBank";
import { MAX_PRECOMPUTED_STEPS, useMachineHistory } from "../../src/hooks/useMachineHistory";
import type { ProgramLine } from "../../src/lib/mips-machine/interpreter";
import { B, I, J, M, R, label, text } from "../helpers/ast";
import { toProgram } from "../helpers/machine";
import { n, num, u32 } from "../helpers/bits";

interface Props {
  program: ProgramLine[];
  pipeline?: boolean;
  hazardUnit?: boolean;
  earlyBranch?: boolean;
  textBase?: number;
}

/** The three hooks wired together the way App.tsx wires them. */
function mount(initial: Props) {
  return renderHook(
    (p: Props) => {
      const reg = useRegisterBank();
      const mem = useMemoryBank(64);
      const machine = useMachineHistory(p.program, reg, mem, p.pipeline, p.hazardUnit, p.earlyBranch, p.textBase);
      return { reg, mem, machine };
    },
    { initialProps: initial },
  );
}

const regVal = (r: { current: { reg: { registers: Record<string, { bits: (0 | 1)[] }> } } }, name: string) =>
  num(r.current.reg.registers[name].bits);

const TWO = toProgram(text(I("addi", "t0", "zero", 5), R("add", "t1", "t0", "t0")));

describe("useMachineHistory: building the timeline", () => {
  it("an empty program has only frame 0 and can't step", () => {
    const { result } = mount({ program: [] });
    const m = result.current.machine;
    expect(m.timeline).toHaveLength(1);
    expect(m.history).toEqual([]);
    expect(m.current).toBeNull();
    expect(m.canStep).toBe(false);
    expect(m.canStepBack).toBe(false);
    expect(m.complete).toBe(true);
  });

  it("computes the whole run up front: 5 micro-steps per instruction", () => {
    const { result } = mount({ program: TWO });
    const m = result.current.machine;
    expect(m.history).toHaveLength(10);
    expect(m.timeline).toHaveLength(11);
    expect(m.history.map((s) => s.stage).join("")).toBe("FDAMRFDAMR");
    expect(m.position).toBe(0);
    expect(m.current).toBeNull();
    expect(m.complete).toBe(true);
    expect(m.canStep).toBe(true);
  });

  it("leaves the banks showing frame 0 after building", () => {
    const { result } = mount({ program: TWO });
    expect(regVal(result, "t0")).toBe(0);
    expect(regVal(result, "t1")).toBe(0);
  });
});

describe("useMachineHistory: navigation", () => {
  it("step / stepBack move one frame and restore the banks to it", () => {
    const { result } = mount({ program: TWO });
    act(() => result.current.machine.step());
    expect(result.current.machine.position).toBe(1);
    expect(result.current.machine.current?.stage).toBe("F");
    act(() => result.current.machine.seek(5));
    expect(regVal(result, "t0")).toBe(5);
    expect(regVal(result, "t1")).toBe(0);
    expect(regVal(result, "pc")).toBe(4);
    act(() => result.current.machine.stepBack());
    expect(result.current.machine.position).toBe(4);
    expect(regVal(result, "t0")).toBe(0);
  });

  it("seek clamps to the timeline", () => {
    const { result } = mount({ program: TWO });
    act(() => result.current.machine.seek(999));
    expect(result.current.machine.position).toBe(10);
    expect(regVal(result, "t1")).toBe(10);
    expect(result.current.machine.canStep).toBe(false);
    act(() => result.current.machine.seek(-3));
    expect(result.current.machine.position).toBe(0);
    expect(result.current.machine.canStepBack).toBe(false);
  });

  it("restores read/write marks for the frame on screen", () => {
    const { result } = mount({ program: TWO });
    act(() => result.current.machine.seek(2)); // addi's Decode: reads $zero and $t0
    expect(result.current.reg.registers.zero.mark).toBe("success");
    act(() => result.current.machine.seek(5)); // addi's write-back
    expect(result.current.reg.registers.t0.mark).toBe("warning");
    expect(result.current.reg.registers.zero.mark).toBe("default");
  });

  it("touchedWords collects memory read or written anywhere on the timeline", () => {
    const program = toProgram(text(M("sw", "zero", 8, "zero"), M("lw", "t0", 12, "zero")));
    const { result } = mount({ program });
    expect([...result.current.machine.touchedWords].sort()).toEqual([2, 3]);
  });
});

describe("useMachineHistory: errors", () => {
  it("the timeline ends on the failing step, which carries the error", () => {
    const program = toProgram(text(I("addi", "t0", "zero", 1), M("lw", "t1", 2, "zero"), I("addi", "t2", "zero", 1)));
    const { result } = mount({ program });
    const m = result.current.machine;
    expect(m.history).toHaveLength(9); // 5 for addi, F/D/A/M for the lw
    const last = m.history[m.history.length - 1];
    expect(last).toMatchObject({ pc: 1, stage: "M", error: "Unaligned LW operation on address 2" });
    expect(m.complete).toBe(true);
    act(() => result.current.machine.seek(9));
    expect(result.current.machine.canStep).toBe(false);
  });
});

describe("useMachineHistory: long runs", () => {
  it(`stops precomputing at MAX_PRECOMPUTED_STEPS (${MAX_PRECOMPUTED_STEPS}) and extends one step at a time`, () => {
    const loop = toProgram(text(label("x", J("x"))));
    const { result } = mount({ program: loop });
    expect(result.current.machine.timeline).toHaveLength(MAX_PRECOMPUTED_STEPS + 1);
    expect(result.current.machine.complete).toBe(false);
    act(() => result.current.machine.seek(MAX_PRECOMPUTED_STEPS));
    expect(result.current.machine.canStep).toBe(true);
    act(() => result.current.machine.step());
    expect(result.current.machine.position).toBe(MAX_PRECOMPUTED_STEPS + 1);
    expect(result.current.machine.timeline).toHaveLength(MAX_PRECOMPUTED_STEPS + 2);
  });
});

describe("useMachineHistory: editing values (rebase)", () => {
  it("an edit becomes part of the frame on screen and the rest is recomputed", () => {
    const program = toProgram(text(R("add", "t1", "t0", "t0")));
    const { result } = mount({ program });
    act(() => {
      result.current.reg.trySave("t0", "15"); // hex 0x15 = 21
      result.current.machine.rebase();
    });
    act(() => result.current.machine.seek(5));
    expect(regVal(result, "t1")).toBe(42);
    act(() => result.current.machine.seek(0));
    expect(regVal(result, "t0")).toBe(21);
  });

  it("frames before the edit are kept", () => {
    const program = toProgram(text(I("addi", "t0", "zero", 1), R("add", "t1", "t2", "t2")));
    const { result } = mount({ program });
    const firstFive = result.current.machine.history.slice(0, 5);
    act(() => result.current.machine.seek(5));
    act(() => {
      result.current.reg.WR("t2", n(4));
      result.current.machine.rebase();
    });
    expect(result.current.machine.history.slice(0, 5)).toEqual(firstFive);
    act(() => result.current.machine.seek(10));
    expect(regVal(result, "t1")).toBe(8);
  });
});

describe("useMachineHistory: reset", () => {
  it("clears the timeline and parks $pc at 0 but keeps register values", () => {
    const { result } = mount({ program: TWO });
    act(() => result.current.machine.seek(10));
    act(() => {
      result.current.machine.reset();
    });
    expect(result.current.machine.timeline).toHaveLength(0);
    expect(result.current.machine.position).toBe(0);
    expect(result.current.machine.canStep).toBe(false);
    expect(regVal(result, "pc")).toBe(0);
    expect(regVal(result, "t1")).toBe(10);
  });
});

describe("useMachineHistory: pipeline mode", () => {
  it("one step is one clock cycle (N + 4 cycles), with the same results", () => {
    const { result } = mount({ program: TWO, pipeline: true });
    expect(result.current.machine.history).toHaveLength(6);
    act(() => result.current.machine.seek(6));
    expect(regVal(result, "t1")).toBe(10);
    expect(regVal(result, "pc")).toBe(8);
  });

  it("exposes the instructions in flight for the frame on screen", () => {
    const { result } = mount({ program: TWO, pipeline: true });
    expect(result.current.machine.pipelineSlots).toEqual([]);
    act(() => result.current.machine.seek(2));
    expect(result.current.machine.pipelineSlots.map((s) => `${s.stage}:${s.op}`)).toEqual(["D:addi", "F:add"]);
  });

  it("switching hazard handling recomputes only the cycles after the one on screen", () => {
    const program = toProgram(text(M("lw", "t0", 0, "zero"), R("add", "t1", "t0", "t0"), I("addi", "t2", "zero", 1)));
    const { result, rerender } = mount({ program, pipeline: true });
    expect(result.current.machine.history).toHaveLength(7);
    act(() => result.current.machine.seek(2));
    const kept = result.current.machine.history.slice(0, 2);
    rerender({ program, pipeline: true, hazardUnit: true });
    expect(result.current.machine.position).toBe(2);
    expect(result.current.machine.history).toHaveLength(8); // one load-use stall
    expect(result.current.machine.history.slice(0, 2)).toEqual(kept);
    expect(result.current.machine.timeline.some((f) => f.bubbles.length > 0)).toBe(true);
  });

  it("switching modes rebuilds the timeline", () => {
    const { result, rerender } = mount({ program: TWO });
    expect(result.current.machine.history).toHaveLength(10);
    act(() => {
      result.current.machine.seek(0);
      result.current.machine.reset();
    });
    rerender({ program: TWO, pipeline: true });
    expect(result.current.machine.history).toHaveLength(6);
  });
});

describe("useMachineHistory: fix and resume", () => {
  const broken = toProgram(text(I("addi", "t0", "zero", 1), M("lw", "t1", 2, "zero"), I("addi", "t2", "zero", 3)));
  const fixed = toProgram(text(I("addi", "t0", "zero", 1), M("lw", "t1", 4, "zero"), I("addi", "t2", "zero", 3)));

  it("planResume: only a fix to the failing instruction resumes, from just before its fetch", () => {
    const { result } = mount({ program: broken });
    const m = result.current.machine;
    expect(m.planResume(fixed)).toEqual({ frame: 5, pc: 1 });
    // Unchanged program, a different line changed, or a different length: start over.
    expect(m.planResume(broken)).toBeNull();
    expect(m.planResume(toProgram(text(I("addi", "t0", "zero", 2), M("lw", "t1", 4, "zero"), I("addi", "t2", "zero", 3))))).toBeNull();
    expect(m.planResume(fixed.slice(0, 2))).toBeNull();
  });

  it("planResume returns null when the run didn't fail", () => {
    const { result } = mount({ program: TWO });
    expect(result.current.machine.planResume(TWO)).toBeNull();
  });

  it("prepare + new program resumes without rebuilding the frames before the fix", () => {
    const { result, rerender } = mount({ program: broken });
    act(() => {
      result.current.mem.sw(4, n(77));
      result.current.machine.rebase();
    });
    const before = result.current.machine.history.slice(0, 5);
    const resume = result.current.machine.planResume(fixed)!;
    let err: unknown = "unset";
    act(() => {
      err = result.current.machine.prepare(fixed, resume);
    });
    expect(err).toBeNull();
    rerender({ program: fixed });
    const m = result.current.machine;
    expect(m.position).toBe(5);
    expect(m.history).toHaveLength(15);
    expect(m.history.slice(0, 5)).toEqual(before);
    act(() => result.current.machine.seek(15));
    expect([regVal(result, "t0"), regVal(result, "t1"), regVal(result, "t2")]).toEqual([1, 77, 3]);
  });

  it("prepare from scratch runs `setup` first (e.g. loading .data)", () => {
    const { result, rerender } = mount({ program: [] });
    const program = toProgram(text(M("lw", "t0", 0, "zero")));
    let err: unknown = "unset";
    act(() => {
      err = result.current.machine.prepare(program, null, () => {
        result.current.mem.sw(0, n(123));
        result.current.reg.WR("pc", n(0));
      });
    });
    expect(err).toBeNull();
    rerender({ program });
    act(() => result.current.machine.seek(5));
    expect(regVal(result, "t0")).toBe(123);
  });

  it("prepare of a failing program reports the error and puts everything back", () => {
    const { result } = mount({ program: TWO });
    act(() => result.current.machine.seek(7));
    const lengthBefore = result.current.machine.timeline.length;
    const t0Before = regVal(result, "t0");
    let err: unknown = null;
    act(() => {
      // Like App.tsx's setup: starting values in, and $pc back to 0 (prepare
      // doesn't reset $pc itself, and single-cycle steps compute the next PC
      // from it).
      err = result.current.machine.prepare(broken, null, () => {
        result.current.reg.WR("t5", n(9));
        result.current.reg.WR("pc", n(0));
      });
    });
    expect(err).toEqual({ message: "Unaligned LW operation on address 2", pc: 1 });
    expect(result.current.machine.position).toBe(7);
    expect(result.current.machine.timeline).toHaveLength(lengthBefore);
    expect(regVal(result, "t0")).toBe(t0Before);
    expect(regVal(result, "t5")).toBe(0); // setup's change rolled back too
    act(() => result.current.machine.seek(10));
    expect(regVal(result, "t1")).toBe(10); // still the old program's run
  });

  it("pipeline mode: resumes from just before the failing instruction's fetch cycle", () => {
    const { result } = mount({ program: broken, pipeline: true });
    expect(result.current.machine.planResume(fixed)).toEqual({ frame: 1, pc: 1 });
  });
});

describe("useMachineHistory: single-cycle and pipeline agree", () => {
  it("on a counted loop with memory traffic", () => {
    const program = toProgram(
      text(
        I("addi", "t0", "zero", 3),
        label("top", M("sw", "t0", 4, "zero")),
        M("lw", "t1", 4, "zero"),
        R("add", "t2", "t2", "t1"),
        I("addi", "t0", "t0", -1),
        B("bne", "t0", "zero", "top"),
      ),
    );
    const finals: number[][] = [];
    for (const props of [
      { program },
      { program, pipeline: true },
      { program, pipeline: true, hazardUnit: true },
      { program, pipeline: true, hazardUnit: true, earlyBranch: true },
    ]) {
      const { result } = mount(props);
      act(() => result.current.machine.seek(Number.MAX_SAFE_INTEGER));
      finals.push([regVal(result, "t0"), regVal(result, "t1"), regVal(result, "t2"), regVal(result, "pc"), num(result.current.mem.cells[1].bits)]);
    }
    expect(finals[0]).toEqual([0, 1, 6, 24, 1]);
    for (const f of finals) expect(f).toEqual(finals[0]);
  });
});

describe("useMachineHistory: starting $pc (textBase)", () => {
  const BASE = 0x00400000;
  const program = toProgram(
    text(I("addi", "t0", "zero", 1), J("end"), I("addi", "t1", "zero", 99), label("end", I("addi", "t2", "zero", 3))),
    null,
    BASE,
  );
  const pcOf = (r: { current: { reg: { registers: Record<string, { bits: (0 | 1)[] }> } } }) =>
    u32(r.current.reg.registers.pc.bits);

  /** Like App's Assemble: prepare() with $pc set to the base, then the new props. */
  function assembled(pipeline = false) {
    const r = mount({ program: [], pipeline, textBase: BASE });
    let err: unknown = "unset";
    act(() => {
      err = r.result.current.machine.prepare(program, null, () => r.result.current.reg.WR("pc", n(BASE)), BASE);
    });
    expect(err).toBeNull();
    r.rerender({ program, pipeline, textBase: BASE });
    return r;
  }

  it("single-cycle: $pc counts in real addresses and the jump lands", () => {
    const { result } = assembled();
    act(() => result.current.machine.seek(5));
    expect(pcOf(result)).toBe(BASE + 4);
    act(() => result.current.machine.seek(Number.MAX_SAFE_INTEGER));
    expect([regVal(result, "t1"), regVal(result, "t2")]).toEqual([0, 3]);
    expect(pcOf(result)).toBe(BASE + 16);
    // 3 instructions executed, 5 micro-steps each; MachineState.pc stays a program index.
    expect(result.current.machine.history).toHaveLength(15);
    expect(result.current.machine.history.map((s) => s.pc).filter((_, i) => i % 5 === 0)).toEqual([0, 1, 3]);
  });

  it("pipeline: same result", () => {
    const { result } = assembled(true);
    act(() => result.current.machine.seek(Number.MAX_SAFE_INTEGER));
    expect([regVal(result, "t1"), regVal(result, "t2")]).toEqual([0, 3]);
    expect(pcOf(result)).toBe(BASE + 16);
  });

  it("reset() puts $pc back to the starting $pc, not 0", () => {
    const { result } = assembled();
    act(() => result.current.machine.seek(10));
    act(() => result.current.machine.reset());
    expect(pcOf(result)).toBe(BASE);
  });

  it("a failed prepare() also restores the previous starting $pc", () => {
    const { result } = assembled();
    const bad = toProgram(text(M("lw", "t0", 2, "zero")));
    let err: unknown = null;
    act(() => {
      err = result.current.machine.prepare(bad, null, () => result.current.reg.WR("pc", n(0)), 0);
    });
    expect(err).toMatchObject({ pc: 0 });
    // Still the old program at the old base: reset() goes back to BASE.
    act(() => result.current.machine.reset());
    expect(pcOf(result)).toBe(BASE);
  });
});
