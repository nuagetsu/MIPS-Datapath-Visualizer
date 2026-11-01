import { describe, it, expect } from "vitest";
import {
  BR_CMP, BR_FWDRD1, BR_FWDRD2, BR_FWD_EXMEM, BR_FWD_MEMWB, BR_LS_TO_MUX5, BR_MUX4, BR_MUX5, BR_TARGET,
  HAZARD_CONTROL_WIRE_REPLACEMENTS, HAZARD_DROPPED_CONTROL_WIRES, HAZARD_VIEW_WIDTH, hazardDx, hazardX, remapPath,
} from "../../../src/lib/mips-machine/datapathBranch";
import {
  FWD_EXMEM, FWD_MEMWB, HAZARD_ALU1_IN0, HAZARD_MUX2, HAZARD_MUX6, HAZARD_MUX6_OUT, HAZARD_MUX7, HAZARD_STORE_EX,
  HAZARD_STORE_MEM,
} from "../../../src/lib/mips-machine/datapathHazards";
import {
  LEGACY_SEGMENTS, PIPELINE_CONTROL_WIRES, PIPELINE_VIEW_WIDTH, SEGMENTS, pipelineSegment,
} from "../../../src/lib/mips-machine/datapathWires";

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** First and last point of an "M x y ... L x y" path. */
function ends(d: string): { first: [number, number]; last: [number, number] } {
  const nums = d.match(/-?[\d.]+/g)!.map(Number);
  return { first: [nums[0], nums[1]], last: [nums[nums.length - 2], nums[nums.length - 1]] };
}

describe("hazardX (early-branch layout remap)", () => {
  it("leaves IF alone and shifts everything from ID/EX on by a constant", () => {
    expect(hazardX(0)).toBe(0);
    expect(hazardX(174)).toBe(174);
    expect(hazardX(480)).toBe(480 + 185);
    expect(hazardX(1000)).toBe(1185);
    expect(HAZARD_VIEW_WIDTH).toBe(PIPELINE_VIEW_WIDTH + 185);
  });

  it("is strictly increasing (so nothing swaps sides)", () => {
    let prev = -Infinity;
    for (let x = 0; x <= 1300; x += 0.5) {
      const y = hazardX(x);
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }
  });

  it("opens a gap at the end of IF and is continuous everywhere else", () => {
    const eps = 1e-6;
    expect(hazardX(175) - hazardX(175 - eps)).toBeCloseTo(105, 3);
    for (const b of [245, 355, 465, 480]) expect(hazardX(b + eps) - hazardX(b - eps)).toBeCloseTo(0, 3);
  });

  it("hazardDx is the shift", () => {
    expect(hazardDx(100)).toBe(0);
    expect(hazardDx(600)).toBe(185);
  });
});

describe("remapPath", () => {
  it("remaps x coordinates of M and L commands", () => {
    expect(remapPath("M 100 5 L 500 5")).toBe("M 100 5 L 685 5");
  });

  it("remaps only the endpoint x of an arc", () => {
    expect(remapPath("M 500 10 A 5 5 0 1 1 510 10")).toBe("M 685 10 A 5 5 0 1 1 695 10");
  });

  it("passes Z through and accepts comma separators", () => {
    expect(remapPath("M 500,1 L 600,1 Z")).toBe("M 685 1 L 785 1 Z");
  });

  it("returns the same string for the same input (cached)", () => {
    const d = "M 700 1 L 800 1";
    expect(remapPath(d)).toBe(remapPath(d));
  });

  it("throws on path commands the diagram doesn't use", () => {
    expect(() => remapPath("M 0 0 C 1 1 2 2 3 3")).toThrow(/unsupported path command "C"/);
  });

  it("can remap every pipelined wire piece", () => {
    for (const [key, seg] of [...Object.entries(SEGMENTS), ...Object.entries(LEGACY_SEGMENTS)]) {
      for (const p of pipelineSegment(key, seg)) expect(() => remapPath(p.d)).not.toThrow();
    }
  });
});

describe("early-branch hardware layout", () => {
  it("components don't overlap", () => {
    const boxes = { BR_MUX4, BR_MUX5, BR_FWDRD1, BR_FWDRD2, BR_CMP };
    const entries = Object.entries(boxes);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        expect({ pair: [entries[i][0], entries[j][0]], overlap: overlaps(entries[i][1], entries[j][1]) }).toEqual({
          pair: [entries[i][0], entries[j][0]],
          overlap: false,
        });
      }
    }
  });

  it("wires with crossings get hops", () => {
    expect((BR_LS_TO_MUX5.d.match(/ A /g) ?? []).length).toBe(2);
    expect((BR_TARGET.d.match(/ A /g) ?? []).length).toBe(3);
  });

  it("the branch target ends at MUX 4's lower input", () => {
    expect(ends(BR_TARGET.d).last).toEqual([BR_MUX4.x, 105]);
  });

  it("ID forwarding trunks meet their branches", () => {
    for (const fw of [BR_FWD_EXMEM, BR_FWD_MEMWB]) {
      const trunkEnd = ends(fw.trunk.d).last;
      const starts = [ends(fw.toRd1.d).first, ends(fw.toRd2.d).first];
      expect(starts.some((s) => s[0] === trunkEnd[0] && s[1] === trunkEnd[1])).toBe(true);
    }
    expect(ends(BR_FWD_EXMEM.toRd1.d).last[0]).toBe(BR_FWDRD1.x);
    expect(ends(BR_FWD_MEMWB.toRd2.d).last[0]).toBe(BR_FWDRD2.x);
  });

  it("dropped and replaced control lines refer to lines that exist", () => {
    const keys = new Set(PIPELINE_CONTROL_WIRES.map((w) => w.key));
    for (const k of HAZARD_DROPPED_CONTROL_WIRES) expect(keys.has(k)).toBe(true);
    for (const k of Object.keys(HAZARD_CONTROL_WIRE_REPLACEMENTS)) expect(keys.has(k)).toBe(true);
  });
});

describe("forwarding hardware in EX (datapathHazards)", () => {
  it("MUX 6 and MUX 7 share a column, MUX 2 sits right of them and left of the ALU", () => {
    expect(HAZARD_MUX6.x).toBe(HAZARD_MUX7.x);
    expect(overlaps(HAZARD_MUX6, HAZARD_MUX7)).toBe(false);
    expect(HAZARD_MUX2.x).toBeGreaterThan(HAZARD_MUX7.x + HAZARD_MUX7.width);
    expect(HAZARD_MUX2.x + HAZARD_MUX2.width).toBeLessThan(659);
    expect(ends(HAZARD_MUX6_OUT.d).last[0]).toBe(659);
  });

  it("RD1 now stops at MUX 6", () => {
    expect(ends(HAZARD_ALU1_IN0.d).last[0]).toBe(HAZARD_MUX6.x);
  });

  it("forwarding trunks connect to both mux inputs, and each input lands on its mux", () => {
    for (const fw of [FWD_EXMEM, FWD_MEMWB]) {
      const trunkEnd = ends(fw.trunk.d).last;
      for (const branch of [fw.toMux6, fw.toMux7]) {
        expect(ends(branch.d).first).toEqual(trunkEnd);
      }
      const [x6, y6] = ends(fw.toMux6.d).last;
      const [x7, y7] = ends(fw.toMux7.d).last;
      expect(x6).toBe(HAZARD_MUX6.x);
      expect(x7).toBe(HAZARD_MUX7.x);
      expect(y6).toBeGreaterThan(HAZARD_MUX6.y);
      expect(y6).toBeLessThan(HAZARD_MUX6.y + HAZARD_MUX6.height);
      expect(y7).toBeGreaterThan(HAZARD_MUX7.y);
      expect(y7).toBeLessThan(HAZARD_MUX7.y + HAZARD_MUX7.height);
    }
  });

  it("store data is drawn in EX up to EX/MEM, then in MEM", () => {
    expect(HAZARD_STORE_EX.stage).toBe("EX");
    expect(HAZARD_STORE_MEM.stage).toBe("MEM");
    expect(ends(HAZARD_STORE_EX.d).last[1]).toBe(ends(HAZARD_STORE_MEM.d).first[1]);
  });
});
