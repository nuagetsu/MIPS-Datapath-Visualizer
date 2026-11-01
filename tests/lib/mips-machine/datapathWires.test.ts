import { describe, it, expect } from "vitest";
import {
  LEGACY_SEGMENTS, PIPELINE_BARS, PIPELINE_CONTROL_CELLS, PIPELINE_CONTROL_WIRES, PIPELINE_OFFSET, PIPELINE_TOP_DY,
  PIPELINE_WB_WR, SEGMENTS, WIRE_TO_SEGMENTS, activeSegmentKeys, aluPath, pipelineSegment, stageOfX, type WireSegment,
} from "../../../src/lib/mips-machine/datapathWires";
import { WIRES } from "../../../src/lib/mips-machine/datapath";
import { KIND } from "../../../src/lib/mips-machine/ctrl";
import { B, I, J, L, M, R, S, U, label, text } from "../../helpers/ast";
import { TestMachine, runSingleCycle, toProgram } from "../../helpers/machine";
import type { Instr } from "../../../src/lib/mips-parser/ast";

/** Consecutive [x0, y0, x1, y1] runs of a polyline. */
function runs(pts: number[]): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let i = 2; i < pts.length; i += 2) out.push([pts[i - 2], pts[i - 1], pts[i], pts[i + 1]]);
  return out;
}

const ALL_SEGMENTS: [string, WireSegment][] = [...Object.entries(SEGMENTS), ...Object.entries(LEGACY_SEGMENTS)];

describe("SEGMENTS / WIRE_TO_SEGMENTS", () => {
  it("maps every WireId, and nothing else", () => {
    expect(Object.keys(WIRE_TO_SEGMENTS).sort()).toEqual([...WIRES].sort());
  });

  it("every referenced segment exists", () => {
    for (const keys of Object.values(WIRE_TO_SEGMENTS)) for (const k of keys) expect(SEGMENTS[k]).toBeDefined();
  });

  it("every drawn segment belongs to at least one wire", () => {
    const used = new Set(Object.values(WIRE_TO_SEGMENTS).flat());
    expect(Object.keys(SEGMENTS).filter((k) => !used.has(k))).toEqual([]);
  });

  it("every polyline is axis-aligned (the bar-splitting logic depends on it)", () => {
    for (const [key, seg] of ALL_SEGMENTS) {
      if (!seg.pts) continue;
      for (const [x0, y0, x1, y1] of runs(seg.pts)) {
        expect({ key, aligned: x0 === x1 || y0 === y1 }).toEqual({ key, aligned: true });
      }
    }
  });

  it("each path's `d` matches its points", () => {
    for (const [, seg] of ALL_SEGMENTS) {
      if (seg.pts) {
        const [x0, y0, ...rest] = seg.pts;
        let d = `M ${x0} ${y0}`;
        for (let i = 0; i < rest.length; i += 2) d += ` L ${rest[i]} ${rest[i + 1]}`;
        expect(seg.d).toBe(d);
      } else {
        expect(seg.arc).toBeDefined();
        expect(seg.d).toMatch(/^M [\d.]+ [\d.]+ A 5 5 0 1 1 [\d.]+ [\d.]+$/);
      }
    }
  });

  it("the legacy MUX4 -> PC wire isn't a WireId (the interpreter can never light it)", () => {
    expect(Object.keys(LEGACY_SEGMENTS)).toEqual(["MUX4_PC"]);
    expect(Object.values(WIRE_TO_SEGMENTS).flat()).not.toContain("MUX4_PC");
  });
});

describe("activeSegmentKeys", () => {
  it("expands wires into their segments, de-duplicated", () => {
    const keys = activeSegmentKeys(["RD2_MUX2", "RD2_MWD"]);
    expect([...keys].sort()).toEqual(["MWD_", "RD2_", "_2MUX2", "_MWD", "_MWD_", "_RD2", "_RD2_"].sort());
  });

  it("is empty for no wires", () => {
    expect(activeSegmentKeys([]).size).toBe(0);
  });
});

describe("every wire the interpreter lights can be drawn", () => {
  const programs: Instr[][] = [
    [R("add", "t0", "t1", "t2")],
    [I("addi", "t0", "t1", 1)],
    [L("ori", "t0", "t1", 1)],
    [S("sll", "t0", "t1", 1)],
    [U("t0", 1)],
    [M("sw", "t0", 0, "zero")],
    [M("lw", "t0", 0, "zero")],
    [M("lb", "t0", 0, "zero")],
    [M("sb", "t0", 0, "zero")],
  ];

  it("for straight-line instructions and taken/not-taken branches and jumps", () => {
    const seen = new Set<string>();
    const all = [
      ...programs.map((p) => text(...p)),
      text(label("x", B("beq", "zero", "zero", "x"))),
      text(B("bne", "zero", "zero", "y"), label("y", I("addi", "t0", "zero", 1))),
      text(J("z"), label("z", I("addi", "t0", "zero", 1))),
    ];
    for (const lines of all) {
      const run = runSingleCycle(toProgram(lines), new TestMachine(), 20);
      for (const s of run.states) {
        for (const w of s.activeWires) {
          expect(WIRE_TO_SEGMENTS[w]).toBeDefined();
          seen.add(w);
        }
      }
    }
    // Every WireId is reachable by some instruction.
    expect(WIRES.filter((w) => !seen.has(w))).toEqual([]);
    expect(KIND.length).toBeGreaterThan(0);
  });
});

describe("aluPath", () => {
  it("draws the notched pentagon as a closed path", () => {
    expect(aluPath(0, 0, 100, 100)).toBe("M 0 0 L 100 25 L 100 75 L 0 100 L 0 62.5 L 25 50 L 0 37.5 Z");
  });
});

// ---- Pipelined layout ---------------------------------------------------------

describe("pipeline bars", () => {
  it("are four registers, left to right, not overlapping", () => {
    expect(PIPELINE_BARS.map((b) => b.label)).toEqual(["IF/ID", "ID/EX", "EX/MEM", "MEM/WB"]);
    for (let i = 1; i < PIPELINE_BARS.length; i++) {
      expect(PIPELINE_BARS[i].x).toBeGreaterThan(PIPELINE_BARS[i - 1].x + PIPELINE_BARS[i - 1].width);
    }
    for (const b of PIPELINE_BARS) expect(b.width).toBe(16);
  });

  it("MEM/WB starts lower than the others (clear of MUX 4's label)", () => {
    expect(PIPELINE_BARS[3].top).toBe(200);
    expect(PIPELINE_BARS.slice(0, 3).every((b) => b.top === 30 + PIPELINE_TOP_DY)).toBe(true);
  });

  it("stage offsets increase through the pipeline", () => {
    const o = PIPELINE_OFFSET;
    expect(o.IF < o.ID && o.ID < o.EX && o.EX < o.MEM && o.MEM < o.WB).toBe(true);
  });
});

describe("stageOfX", () => {
  it.each<[number, string]>([
    [0, "ID"],
    [309, "ID"],
    [310, "EX"],
    [574, "EX"],
    [575, "MEM"],
    [764, "MEM"],
    [765, "WB"],
    [900, "WB"],
  ])("x=%d is in %s", (x, stage) => {
    expect(stageOfX(x)).toBe(stage);
  });
});

describe("pipelineSegment", () => {
  const pieces = Object.fromEntries(ALL_SEGMENTS.map(([k, s]) => [k, pipelineSegment(k, s)]));

  it("returns at least one piece per segment, each tagged with a stage", () => {
    for (const [, ps] of Object.entries(pieces)) {
      expect(ps.length).toBeGreaterThan(0);
      for (const p of ps) expect(["IF", "ID", "EX", "MEM", "WB"]).toContain(p.stage);
    }
  });

  it("splits a wire where it crosses a bar: RD1_ crosses ID/EX", () => {
    const [a, b] = pieces.RD1_;
    expect(pieces.RD1_).toHaveLength(2);
    const bar = PIPELINE_BARS[1];
    expect(a.pts!.slice(-2)).toEqual([bar.x, 255]);
    expect(a.arrow).toBe(true); // into the register
    expect(a.stage).toBe("ID");
    expect(b.pts!.slice(0, 2)).toEqual([bar.x + bar.width, 255]);
    expect(b.arrow).toBe(false); // RD1_ itself has no arrowhead
    expect(b.stage).toBe("EX");
  });

  it("leaves a wire that stays within one stage whole", () => {
    expect(pieces.RS_RR1).toHaveLength(1);
    expect(pieces.RS_RR1[0].stage).toBe("ID");
  });

  it("no piece runs straight through a bar after splitting", () => {
    for (const [key, ps] of Object.entries(pieces)) {
      for (const p of ps) {
        if (!p.pts) continue;
        for (const [x0, y0, x1, y1] of runs(p.pts)) {
          if (y0 !== y1) continue;
          const lo = Math.min(x0, x1);
          const hi = Math.max(x0, x1);
          const through = PIPELINE_BARS.filter((b) => y0 > b.top && y0 < b.bottom && lo < b.x && hi > b.x + b.width);
          expect({ key, through: through.map((b) => b.label) }).toEqual({ key, through: [] });
        }
      }
    }
  });

  it("write-back and PC-update wires are pinned to WB wherever they're drawn", () => {
    for (const key of ["WD_", "_WD_", "_WD", "MUX4_MUX5", "MUX5_PC", "JADDR_LS", "LS_MUX5", "MUX4_PC"]) {
      for (const p of pieces[key]) expect({ key, stage: p.stage }).toEqual({ key, stage: "WB" });
    }
  });

  it("the last leg into MUX 4 counts as WB, earlier legs keep their stages", () => {
    const stages = pieces._MUX4.map((p) => p.stage);
    expect(stages[stages.length - 1]).toBe("WB");
    expect(stages).not.toContain("MEM");
    expect(stages[0]).toBe("EX");
  });

  it("moves the top row down by PIPELINE_TOP_DY", () => {
    // PC's output wire runs along y=30 in the single-cycle layout.
    expect(pieces.PC_[0].pts![1]).toBe(30 + PIPELINE_TOP_DY);
  });

  it("keeps arcs as arcs", () => {
    expect(pieces._RD1_).toHaveLength(1);
    expect(pieces._RD1_[0].arc).toBeDefined();
  });
});

describe("PIPELINE_WB_WR", () => {
  it("is drawn entirely in WB and ends with an arrow into WR", () => {
    expect(PIPELINE_WB_WR.every((p) => p.stage === "WB")).toBe(true);
    expect(PIPELINE_WB_WR[PIPELINE_WB_WR.length - 1].arrow).toBe(true);
  });
});

describe("control unit overlay", () => {
  it("control lines have unique keys and positive lengths", () => {
    const keys = PIPELINE_CONTROL_WIRES.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const w of PIPELINE_CONTROL_WIRES) {
      expect(w.length).toBeGreaterThan(0);
      expect(w.d.startsWith("M ")).toBe(true);
      expect(w.arrowD).toMatch(/ Z$/);
    }
  });

  it("the animation flows outward: lines leaving the oval start at 0, later lines start later", () => {
    const byKey = Object.fromEntries(PIPELINE_CONTROL_WIRES.map((w) => [w.key, w]));
    expect(byKey["oval-m"].start).toBe(0);
    expect(byKey["oval-wb"].start).toBeGreaterThan(0);
    expect(byKey["wb-exmem"].start).toBeGreaterThan(byKey["oval-wb"].start);
    expect(byKey["wb-memwb"].start).toBeGreaterThan(byKey["wb-exmem"].start);
    expect(byKey["wb-regwrite"].start).toBeGreaterThan(byKey["wb-memwb"].start);
  });

  it("hops add length: wb-memwb (3 hops) is longer than its straight span", () => {
    const w = PIPELINE_CONTROL_WIRES.find((c) => c.key === "wb-memwb")!;
    expect((w.d.match(/ A /g) ?? []).length).toBe(3);
  });

  it("the pipeline registers hold WB/M/EX, WB/M and WB", () => {
    expect(PIPELINE_CONTROL_CELLS.map((c) => c.label)).toEqual(["WB", "M", "EX", "WB", "M", "WB"]);
    const [idexWb, , , exmemWb, , memwbWb] = PIPELINE_CONTROL_CELLS;
    expect(idexWb.at).toBeLessThan(exmemWb.at);
    expect(exmemWb.at).toBeLessThan(memwbWb.at);
  });
});
