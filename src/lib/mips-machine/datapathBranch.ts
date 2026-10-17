/**
 * Layout for the "Pipeline Hazards" toggle's early-branch datapath: branches
 * and jumps resolve in ID, with predict-not-taken fetching.
 *
 * Two parts:
 *
 * 1. A coordinate remap, hazardX(), applied to the whole pipelined diagram
 *    in hazards mode (every wire path through remapPath(), every component
 *    by a translate). It makes room without touching the normal layouts:
 *      - IF widens by IF_GROW, so MUX 4 (branch) and MUX 5 (jump) fit between
 *        Add (PC+4) and IF/ID and feed PC directly, as in the textbook's
 *        early-branch figure.
 *      - In ID, the Register File, Control and Sign Extend move left by
 *        RF_SHIFT: the band of wires between them and the instruction fields
 *        (the rt/rd lanes to MUX 1 and the two write-back verticals) is
 *        compressed, and the band just after them is stretched instead.
 *      - ID then widens by ID_GROW for the comparator and its forwarding
 *        muxes. Everything from ID/EX on just moves right by
 *        IF_GROW + ID_GROW.
 *    Piecewise linear, so axis-aligned wires stay axis-aligned and every
 *    component keeps its shape.
 *
 * 2. The early-branch hardware itself, in final (remapped) coordinates:
 *      IF: MUX 4 (PC+4 vs. branch target, selected by the comparator),
 *          MUX 5 (that vs. the jump target) and its return to PC; the jump
 *          shifter, fed from inst[25:0], below IF/ID.
 *      ID: the branch shifter and adder (from Sign Extend and IF/ID's PC+4),
 *          FwdRD1/FwdRD2 (forwarding muxes for the comparator), and the
 *          isZero? comparator.
 *    The branch target and comparator result go back to MUX 4 over the top
 *    of IF/ID; the pipeline bars start lower in hazards mode (BAR_TOP) to
 *    leave those two lanes room.
 */
import { PIPELINE_BOTTOM_DY, PIPELINE_VIEW_WIDTH, type WireSegment } from "./datapathWires";

// ---- 1. The remap ------------------------------------------------------------

const IF_GROW = 105;
const RF_SHIFT = 60;
const ID_GROW = 80;

/** Pipelined-layout x boundaries the remap works between. */
const IF_END = 175; // between Add (PC+4)'s right edge (165) and IF/ID (185)
const FIELDS_RIGHT = 245; // the instruction-field column's right edge
const RF_BAND_END = 355; // just before the Control oval (358) and Register File (365)
const RF_RIGHT = 465; // Register File and Sign Extend right edges
const STRETCH_END = 480; // just before ID/EX's control cells (482)

/** Final x for a pipelined-layout x, in hazards mode. */
export function hazardX(x: number): number {
  if (x < IF_END) return x;
  if (x <= FIELDS_RIGHT) return x + IF_GROW;
  if (x < RF_BAND_END) {
    const scale = (RF_BAND_END - FIELDS_RIGHT - RF_SHIFT) / (RF_BAND_END - FIELDS_RIGHT);
    return FIELDS_RIGHT + IF_GROW + (x - FIELDS_RIGHT) * scale;
  }
  if (x <= RF_RIGHT) return x - RF_SHIFT + IF_GROW;
  if (x < STRETCH_END) {
    const scale = (STRETCH_END - RF_RIGHT + RF_SHIFT + ID_GROW) / (STRETCH_END - RF_RIGHT);
    return RF_RIGHT - RF_SHIFT + IF_GROW + (x - RF_RIGHT) * scale;
  }
  return x + IF_GROW + ID_GROW;
}

/** How far a component anchored at pipelined x moves in hazards mode. */
export const hazardDx = (x: number) => hazardX(x) - x;

export const HAZARD_VIEW_WIDTH = PIPELINE_VIEW_WIDTH + IF_GROW + ID_GROW;

/** Bars' top in hazards mode (except MEM/WB, which already starts lower):
 * 30 below the usual 60, for the two lanes back to MUX 4. */
export const HAZARD_BAR_TOP = 90;

const remapCache = new Map<string, string>();

/** Runs hazardX over every x coordinate of an SVG path built from absolute
 * M, L, A and Z commands (the only ones this diagram uses). */
export function remapPath(d: string): string {
  const cached = remapCache.get(d);
  if (cached !== undefined) return cached;
  const t = d.trim().split(/[\s,]+/);
  const out: string[] = [];
  let cmd = "";
  let i = 0;
  while (i < t.length) {
    if (/^[A-Za-z]$/.test(t[i])) {
      cmd = t[i++];
      out.push(cmd);
      if (cmd === "Z") continue;
    }
    if (cmd === "M" || cmd === "L") {
      out.push(String(hazardX(Number(t[i]))), t[i + 1]);
      i += 2;
    } else if (cmd === "A") {
      out.push(t[i], t[i + 1], t[i + 2], t[i + 3], t[i + 4], String(hazardX(Number(t[i + 5]))), t[i + 6]);
      i += 7;
    } else {
      throw new Error(`remapPath: unsupported path command "${cmd}"`);
    }
  }
  const result = out.join(" ");
  remapCache.set(d, result);
  return result;
}

// ---- Paths with hops ---------------------------------------------------------

const HOP = 5;

/** An axis-aligned polyline, with a half-circle hop wherever it crosses one
 * of `hops` (points on its runs): upward on horizontal runs, sideways on
 * vertical ones. */
function hopPath(pts: number[], hops: [number, number][] = []): string {
  let d = `M ${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2], y0 = pts[i - 1], x1 = pts[i], y1 = pts[i + 1];
    if (y0 === y1) {
      const s = Math.sign(x1 - x0);
      const on = hops.filter(([hx, hy]) => hy === y0 && (hx - x0) * (hx - x1) < 0).sort((a, b) => s * (a[0] - b[0]));
      for (const [hx] of on) d += ` L ${hx - s * HOP} ${y0} A ${HOP} ${HOP} 0 0 ${s > 0 ? 1 : 0} ${hx + s * HOP} ${y0}`;
    } else {
      const s = Math.sign(y1 - y0);
      const on = hops.filter(([hx, hy]) => hx === x0 && (hy - y0) * (hy - y1) < 0).sort((a, b) => s * (a[1] - b[1]));
      for (const [, hy] of on) d += ` L ${x0} ${hy - s * HOP} A ${HOP} ${HOP} 0 0 1 ${x0} ${hy + s * HOP}`;
    }
    d += ` L ${x1} ${y1}`;
  }
  return d;
}

const wire = (pts: number[], arrow: boolean, hops?: [number, number][]): WireSegment => ({ d: hopPath(pts, hops), arrow });

// ---- 2. Early-branch hardware (final coordinates) --------------------------

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// IF ------------------------------------------------------------------------

const ADD1_OUT = { x: 165, y: 75 }; // Add (PC+4)'s output, unmoved
const PC4_FORK_X = 172;
const PC_TOP = { x: 35, y: 45 };

/** MUX 4: PC+4 (a, top) or the branch target (b), selected by the
 * comparator from above. */
export const BR_MUX4: Box = { x: 195, y: 60, width: 26, height: 60 };
/** MUX 5: MUX 4's choice (a) or the jump target (b). */
export const BR_MUX5: Box = { x: 240, y: 70, width: 26, height: 60 };
export const BR_JUMP_LABEL: Box = { x: 223, y: 140, width: 60, height: 16 };

const MUX4_IN_A = 75;
const MUX4_IN_B = 105;
const MUX4_OUT = 90;
const MUX5_IN_B = 110;
const MUX5_OUT = 100;
const MUX4_SEL_X = BR_MUX4.x + BR_MUX4.width / 2; // 208
const RETURN_X = 274;
const RETURN_Y = 35;
const CMP_LANE_Y = 44;
const TARGET_LANE_Y = 53;
const TARGET_DROP_X = 185;

const IFID_X = hazardX(185); // 290
const IFID_RIGHT = IFID_X + 16;
/** PC+4 into IF/ID: below MUX 4/5 and the Jump label, above Instruction
 * Memory (top 180). */
const LATCH_Y = 165;
const LATCH_JOG_X = 318; // between IF/ID and the field column (330)
const PC4_ID_Y = 97; // its run across ID, above the fields and Control

/** The jump shifter: below IF/ID, fed from inst[25:0] on its right, output
 * from its top straight up to MUX 5. */
const JUMP_UP_X = 230;
export const BR_JUMP_LS = { cx: JUMP_UP_X, cy: 590 + PIPELINE_BOTTOM_DY, rx: 36, ry: 16 };
const JADDR_X = hazardX(70 + 165); // the funct field box's bottom centre, 340
const FIELDS_BOTTOM = 570;
const IM_INST_Y = 360; // IM_INST's run into the field column

/** Add (PC+4) -> MUX 4 input a. The latched copy forks off at PC4_FORK_X. */
export const BR_PC4_TO_MUX4 = wire([ADD1_OUT.x, MUX4_IN_A, BR_MUX4.x, MUX4_IN_A], true);
/** PC+4 into IF/ID (the IF part), and on across ID to the branch adder. */
export const BR_PC4_LATCH_IF = wire([PC4_FORK_X, ADD1_OUT.y, PC4_FORK_X, LATCH_Y, IFID_X, LATCH_Y], true);
export const BR_MUX4_TO_MUX5 = wire([BR_MUX4.x + BR_MUX4.width, MUX4_OUT, BR_MUX5.x, MUX4_OUT], true);
/** With the Jump artwork toggled off there's no MUX 5: MUX 4 feeds PC. */
export const BR_MUX4_TO_PC = wire(
  [BR_MUX4.x + BR_MUX4.width, MUX4_OUT, RETURN_X, MUX4_OUT, RETURN_X, RETURN_Y, PC_TOP.x, RETURN_Y, PC_TOP.x, PC_TOP.y],
  true,
);
/** MUX 5 -> PC: the new PC, written at the end of every cycle that isn't a
 * stall. */
export const BR_MUX5_TO_PC = wire(
  [BR_MUX5.x + BR_MUX5.width, MUX5_OUT, RETURN_X, MUX5_OUT, RETURN_X, RETURN_Y, PC_TOP.x, RETURN_Y, PC_TOP.x, PC_TOP.y],
  true,
);
/** inst[25:0], from the bottom of the field column into the jump shifter. */
export const BR_JADDR_TO_LS = wire(
  [JADDR_X, FIELDS_BOTTOM, JADDR_X, BR_JUMP_LS.cy, BR_JUMP_LS.cx + BR_JUMP_LS.rx, BR_JUMP_LS.cy],
  true,
);
/** Jump target up to MUX 5 input b, hopping IM_INST and the latched PC+4. */
export const BR_LS_TO_MUX5 = wire(
  [JUMP_UP_X, BR_JUMP_LS.cy - BR_JUMP_LS.ry, JUMP_UP_X, MUX5_IN_B, BR_MUX5.x, MUX5_IN_B],
  true,
  [
    [JUMP_UP_X, IM_INST_Y],
    [JUMP_UP_X, LATCH_Y],
  ],
);
/** Where the "inst[25:0]" label goes: right-aligned, just left of the drop
 * from the funct box, above the run into the jump shifter. */
export const BR_JADDR_LABEL: Box = { x: JADDR_X - 64, y: 577, width: 60, height: 14 };

// ID ------------------------------------------------------------------------

const RF_RIGHT_FINAL = hazardX(RF_RIGHT); // 510
const IMM_Y = 500;
const RD1_Y = 255;
const RD2_Y = 375;
const RISER_X = RF_RIGHT_FINAL + 12; // 522
const TAP_X = 536;
const IDBUS_EXMEM_X = 546;
const IDBUS_MEMWB_X = 554;

/** The branch shifter and adder, in the band above the Register File. */
export const BR_LS = { cx: 562, cy: 127, rx: 30, ry: 14 };
export const BR_ADD: Box = { x: 602, y: 85, width: 32, height: 56 };
const ADD_OUT_Y = BR_ADD.y + BR_ADD.height / 2; // 113
const ADD_RISE_X = 640;

/** FwdRD1 (above RD1) and FwdRD2 (below RD2): each picks the comparator's
 * operand from the Register File (00), EX/MEM (10) or MEM/WB (01). */
export const BR_FWDRD1: Box = { x: 566, y: 210, width: 26, height: 42 };
export const BR_FWDRD2: Box = { x: 566, y: 382, width: 26, height: 42 };
export const BR_FWDRD1_LABEL: Box = { x: 544, y: 186, width: 70, height: 14 };
export const BR_FWDRD2_LABEL: Box = { x: 544, y: 434, width: 70, height: 14 };
const FWD1_IN = { exMem: 220, memWb: 232, rf: 244 };
const FWD2_IN = { rf: 390, exMem: 402, memWb: 414 };
const FWD1_OUT = BR_FWDRD1.y + BR_FWDRD1.height / 2; // 231
const FWD2_OUT = BR_FWDRD2.y + BR_FWDRD2.height / 2; // 403

/** The comparator, between RD1 and RD2: operands enter top and bottom,
 * the result leaves on the right and climbs to the lane back to MUX 4. */
export const BR_CMP: Box = { x: 598, y: 285, width: 46, height: 60 };
const CMP_IN_X = BR_CMP.x + BR_CMP.width / 2; // 621
const CMP_OUT_Y = BR_CMP.y + BR_CMP.height / 2; // 315
/** Between the comparator (644) and ID/EX (674), far enough left that its
 * hop over RD1 stays clear of RD1's arrowhead into ID/EX. */
const CMP_RISE_X = 652;

/** Imm up from Sign Extend's output to the branch shifter, hopping RD2 and
 * RD1. */
export const BR_IMM_RISER = wire(
  [RISER_X, IMM_Y, RISER_X, BR_LS.cy, BR_LS.cx - BR_LS.rx, BR_LS.cy],
  true,
  [
    [RISER_X, RD2_Y],
    [RISER_X, RD1_Y],
  ],
);
export const BR_LS_TO_ADD = wire([BR_LS.cx + BR_LS.rx, BR_LS.cy, BR_ADD.x, BR_LS.cy], true);
/** PC+4 out of IF/ID across ID into the adder's top input. */
export const BR_PC4_LATCH_ID = wire([IFID_RIGHT, LATCH_Y, LATCH_JOG_X, LATCH_Y, LATCH_JOG_X, PC4_ID_Y, BR_ADD.x, PC4_ID_Y], true);
/** Branch target: adder -> over IF/ID -> down into MUX 4 input b. Hops MUX
 * 5's return to PC, the comparator's drop into MUX 4, and PC+4. */
export const BR_TARGET = wire(
  [
    BR_ADD.x + BR_ADD.width, ADD_OUT_Y,
    ADD_RISE_X, ADD_OUT_Y,
    ADD_RISE_X, TARGET_LANE_Y,
    TARGET_DROP_X, TARGET_LANE_Y,
    TARGET_DROP_X, MUX4_IN_B,
    BR_MUX4.x, MUX4_IN_B,
  ],
  true,
  [
    [RETURN_X, TARGET_LANE_Y],
    [MUX4_SEL_X, TARGET_LANE_Y],
    [TARGET_DROP_X, MUX4_IN_A],
  ],
);
/** Comparator result: -> over IF/ID -> down into MUX 4's select. Hops RD1
 * and MUX 5's return to PC. */
export const BR_CMP_TO_MUX4 = wire(
  [
    BR_CMP.x + BR_CMP.width, CMP_OUT_Y,
    CMP_RISE_X, CMP_OUT_Y,
    CMP_RISE_X, CMP_LANE_Y,
    MUX4_SEL_X, CMP_LANE_Y,
    MUX4_SEL_X, BR_MUX4.y,
  ],
  true,
  [
    [CMP_RISE_X, RD1_Y],
    [RETURN_X, CMP_LANE_Y],
  ],
);

/** The Register File's outputs into each FwdRD mux's 00 input. */
export const BR_RD1_TO_FWD = wire([TAP_X, RD1_Y, TAP_X, FWD1_IN.rf, BR_FWDRD1.x, FWD1_IN.rf], true);
export const BR_RD2_TO_FWD = wire([TAP_X, RD2_Y, TAP_X, FWD2_IN.rf, BR_FWDRD2.x, FWD2_IN.rf], true);
/** FwdRD outputs into the comparator's top and bottom, hopping RD1 / RD2. */
export const BR_FWD1_TO_CMP = wire(
  [BR_FWDRD1.x + BR_FWDRD1.width, FWD1_OUT, CMP_IN_X, FWD1_OUT, CMP_IN_X, BR_CMP.y],
  true,
  [[CMP_IN_X, RD1_Y]],
);
export const BR_FWD2_TO_CMP = wire(
  [BR_FWDRD2.x + BR_FWDRD2.width, FWD2_OUT, CMP_IN_X, FWD2_OUT, CMP_IN_X, BR_CMP.y + BR_CMP.height],
  true,
  [[CMP_IN_X, RD2_Y]],
);
/** Junction dots where the comparator taps RD1/RD2 and the branch riser
 * leaves the immediate. */
export const BR_TAPS: [number, number][] = [
  [TAP_X, RD1_Y],
  [TAP_X, RD2_Y],
  [RISER_X, IMM_Y],
  [PC4_FORK_X, ADD1_OUT.y],
];

/** The dotted forwarding wires into FwdRD1/FwdRD2 (drawn behind, like the
 * EX ones): EX/MEM continues the EX lane (y=183) left from the EX bus;
 * MEM/WB taps the write-back return along the bottom. */
export interface IdForwardWire {
  trunk: WireSegment;
  toRd1: WireSegment;
  toRd2: WireSegment;
}
const EX_LANE_Y = 183;
const EX_BUS_X = hazardX(545); // the EX forwarding bus, 730
export const BR_FWD_EXMEM: IdForwardWire = {
  trunk: wire([EX_BUS_X, EX_LANE_Y, IDBUS_EXMEM_X, EX_LANE_Y, IDBUS_EXMEM_X, FWD1_IN.exMem], false),
  toRd1: wire([IDBUS_EXMEM_X, FWD1_IN.exMem, BR_FWDRD1.x, FWD1_IN.exMem], true),
  toRd2: wire(
    [IDBUS_EXMEM_X, FWD1_IN.exMem, IDBUS_EXMEM_X, FWD2_IN.exMem, BR_FWDRD2.x, FWD2_IN.exMem],
    true,
    [[IDBUS_MEMWB_X, FWD2_IN.exMem]],
  ),
};
export const BR_FWD_MEMWB_TAP = { x: IDBUS_MEMWB_X, y: 575 + PIPELINE_BOTTOM_DY };
export const BR_FWD_MEMWB: IdForwardWire = {
  trunk: wire([BR_FWD_MEMWB_TAP.x, BR_FWD_MEMWB_TAP.y, IDBUS_MEMWB_X, FWD2_IN.memWb], false),
  toRd2: wire([IDBUS_MEMWB_X, FWD2_IN.memWb, BR_FWDRD2.x, FWD2_IN.memWb], true),
  toRd1: wire([IDBUS_MEMWB_X, FWD2_IN.memWb, IDBUS_MEMWB_X, FWD1_IN.memWb, BR_FWDRD1.x, FWD1_IN.memWb], true),
};

// ---- Control overlay adjustments -------------------------------------------

/** Hover-overlay control lines that no longer have a target in hazards
 * mode, where Branch and Jump act in ID and the ALU's zero output isn't
 * used for branching. */
export const HAZARD_DROPPED_CONTROL_WIRES = new Set(["m-branch", "zero-exmem", "zero-mux4"]);

/** Replacements (pipelined coordinates, remapped like the rest): M's
 * fan-out after EX/MEM without its riser to the old Jump label, and WB's
 * line to MEM/WB without hops over the risers that are gone. */
const CTRL_EXMEM_RIGHT = 821; // EX/MEM's control cells' right edge
const CTRL_MEMWB_LEFT = 999; // MEM/WB's control cell's left edge
const CTRL_M_FANOUT_X = 919; // M's riser to MemWrite/MemRead
export const HAZARD_CONTROL_WIRE_REPLACEMENTS: Record<string, { d: string; arrowD: string; length: number }> = {
  "m-jump": {
    d: `M ${CTRL_EXMEM_RIGHT} 249 L ${CTRL_M_FANOUT_X} 249`,
    arrowD: "",
    length: CTRL_M_FANOUT_X - CTRL_EXMEM_RIGHT,
  },
  "wb-memwb": {
    d: `M ${CTRL_EXMEM_RIGHT} 223 L ${CTRL_MEMWB_LEFT - 5} 223`,
    arrowD: `M ${CTRL_MEMWB_LEFT} 223 L ${CTRL_MEMWB_LEFT - 8} 226.5 L ${CTRL_MEMWB_LEFT - 8} 219.5 Z`,
    length: CTRL_MEMWB_LEFT - 5 - CTRL_EXMEM_RIGHT,
  },
};