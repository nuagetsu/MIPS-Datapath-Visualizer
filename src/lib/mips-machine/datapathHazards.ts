/**
 * Geometry for the "Pipeline Hazards" toggle (pipeline mode only): the two
 * forwarding muxes in EX, MUX 2 moved to sit after them, the rerouted store
 * data line, and the two dotted forwarding wires.
 *
 * Layout, as in the textbook's forwarding datapath:
 *
 *   ID/EX ─RD1─▶ MUX 6 (Fwdop1) ─────────────────────▶ ALUop1
 *   ID/EX ─RD2─▶ MUX 7 (Fwdop2) ─┬─▶ MUX 2 (ALUSrc) ──▶ ALUop2
 *                 imm ──────────────▶ ┘
 *                                └─▶ Write Data (via EX/MEM)
 *
 * The forwarding mux for rt comes *before* the ALUSrc mux, and the store data
 * taps between them. So a forwarded rt reaches the ALU (R-type) and Data
 * Memory (sw/sb) alike, while the immediate never goes to memory. MUX 6 and
 * MUX 7 share a column, so the two forwarding muxes read as a pair.
 *
 * The dotted forwarding wires:
 *   (b) EX/MEM -> muxes: taps the ALU-result wire between the EX/MEM bar and
 *       the Address fork, rises to a lane above the ALU, runs left behind the
 *       EX/MEM bar and the ALU, then drops down a bus to both muxes.
 *   (c) MEM/WB -> muxes: taps MUX 3's write-back wire (WD_) on its return
 *       run along the bottom and climbs a bus to both muxes.
 * Both are drawn dashed and *before* every other wire, so solid wires and
 * components pass over them: they read as running behind the diagram.
 *
 * Mux input order (top to bottom):
 *   MUX 6: ID/EX (RD1, 00) at 255, EX/MEM (10) at 270, MEM/WB (01) at 285
 *   MUX 7: EX/MEM (10) at 343, MEM/WB (01) at 358, ID/EX (RD2, 00) at 375
 *   MUX 2: MUX 7's output at 360, immediate at 415; output 395 as before
 * Bus (b) is the outer bus (x=545) and bus (c) the inner (x=553). With each
 * bus feeding both muxes, one dotted-on-dotted crossing is unavoidable:
 * (b)'s input into MUX 7 crosses bus (c), and gets a hop there.
 *
 * Everything here is in final pipelined coordinates: DatapathDiagram draws
 * these components without the EX stage's translate group.
 */
import { PIPELINE_BARS, PIPELINE_BOTTOM_DY, PIPELINE_OFFSET, type Stage, type WireSegment } from "./datapathWires";

const EX = PIPELINE_OFFSET.EX;

function poly(points: number[], arrow: boolean, stage: Stage = "EX"): WireSegment {
  const [x0, y0, ...rest] = points;
  let d = `M ${x0} ${y0}`;
  for (let i = 0; i < rest.length; i += 2) d += ` L ${rest[i]} ${rest[i + 1]}`;
  return { d, arrow, pts: points, stage };
}

// ---- Components ------------------------------------------------------------

/** The forwarding-mux column: right of the two dotted buses (553) with room
 * for an arrowhead, and far enough left that MUX 2 still fits before the
 * ALU (659). */
const FWD_COL_X = 570;
const MUX_W = 26;

/** MUX 6 (Fwdop1), around ALUop1's height (y=255). */
export const HAZARD_MUX6 = { x: FWD_COL_X, y: 238, width: MUX_W, height: 62 };
/** MUX 7 (Fwdop2), on the RD2 line (y=375), directly under MUX 6. */
export const HAZARD_MUX7 = { x: FWD_COL_X, y: 330, width: MUX_W, height: 60 };
/** MUX 2 (ALUSrc), moved right of MUX 7. Its bottom (430) and output height
 * (395, where MUX2_ALU2 leaves for the ALU) are unchanged. */
export const HAZARD_MUX2 = { x: 616, y: 345, width: MUX_W, height: 85 };

const centre = (m: { x: number; width: number }) => m.x + m.width / 2;

/** Control labels: Fwdop1/Fwdop2 above their muxes, ticking down into the
 * top edge; ALUSrc below MUX 2 as before, nudged right to keep its text
 * clear of the store-data line's vertical (STORE_X). */
export const HAZARD_FWDOP1_LABEL = { x: centre(HAZARD_MUX6) - 35, y: 213, width: 70, height: 14 };
export const HAZARD_FWDOP2_LABEL = { x: centre(HAZARD_MUX7) - 35, y: 305, width: 70, height: 14 };
export const HAZARD_ALUSRC_LABEL = { x: centre(HAZARD_MUX2) - 22, y: 435, width: 70, height: 30 };

// ---- Wires -------------------------------------------------------------------

const RD_HOP_END = 330 + EX; // where RD1/RD2 leave their hop over _LS (539)
const ALU_LEFT = 450 + EX; // 659
const ALU1_Y = 255;
const RD2_Y = 375;
const MUX7_OUT_Y = 360;
const IMM_X = 325 + EX; // the sign-extend fork's riser (534)
const IMM_Y = 415;
const STORE_Y = 480;
/** The store-data tap, between MUX 7 and MUX 2. */
const STORE_X = HAZARD_MUX7.x + MUX_W + 8; // 604
const HOP = 5;

/** RD1's last run, which stops at MUX 6's 00 input instead of continuing
 * into the ALU (replaces SEGMENTS._ALU1). */
export const HAZARD_ALU1_IN0 = poly([RD_HOP_END, ALU1_Y, FWD_COL_X, ALU1_Y], true);
/** MUX 6's output into ALUop1. */
export const HAZARD_MUX6_OUT = poly([FWD_COL_X + MUX_W, ALU1_Y, ALU_LEFT, ALU1_Y], true);

/** RD2's last run, into MUX 7's 00 input (replaces _RD2 and _2MUX2). */
export const HAZARD_RD2_IN0 = poly([RD_HOP_END, RD2_Y, FWD_COL_X, RD2_Y], true);
/** MUX 7's output to the store-data tap: the forwarded-or-not rt value. */
export const HAZARD_MUX7_OUT = poly([FWD_COL_X + MUX_W, MUX7_OUT_Y, STORE_X, MUX7_OUT_Y], false);
/** From the tap into MUX 2's register input. */
export const HAZARD_MUX7_TO_MUX2 = poly([STORE_X, MUX7_OUT_Y, HAZARD_MUX2.x, MUX7_OUT_Y], true);
/** The immediate into MUX 2 (replaces _1MUX2, which ended at MUX 2's old
 * left edge). */
export const HAZARD_IMM_MUX2 = poly([IMM_X, IMM_Y, HAZARD_MUX2.x, IMM_Y], true);

/** Store data, from the tap down to EX/MEM (replaces MWD_, _MWD_ and the EX
 * part of _MWD). Hops the immediate at y=415, as _MWD_ did. */
const exMemBar = PIPELINE_BARS[2];
export const HAZARD_STORE_EX: WireSegment = {
  d:
    `M ${STORE_X} ${MUX7_OUT_Y} L ${STORE_X} ${IMM_Y - HOP} ` +
    `A ${HOP} ${HOP} 0 1 1 ${STORE_X} ${IMM_Y + HOP} ` +
    `L ${STORE_X} ${STORE_Y} L ${exMemBar.x} ${STORE_Y}`,
  arrow: true,
  stage: "EX",
};
/** ...and on from EX/MEM into Data Memory's Write Data port. */
export const HAZARD_STORE_MEM = poly([exMemBar.x + exMemBar.width, STORE_Y, 650 + PIPELINE_OFFSET.MEM, STORE_Y], true, "MEM");

// ---- Forwarding wires --------------------------------------------------------

const MUX6_IN_EXMEM = 270;
const MUX6_IN_MEMWB = 285;
const MUX7_IN_EXMEM = 343;
const MUX7_IN_MEMWB = 358;
const BUS_EXMEM_X = 545; // between _LS's riser (534) and MUX 6/7 (570)
const BUS_MEMWB_X = 553;

/** (b): tapped between EX/MEM's right edge and the Address fork. */
export const FWD_EXMEM_TAP = { x: exMemBar.x + exMemBar.width + 12, y: 350 };
/** The lane above the ALU (top y=200), clear of the branch Left Shift
 * (bottom 170) and the ALUctrl label (text from ~192). */
const EXMEM_LANE_Y = 183;

/** (c): tapped on WD_'s return run along the bottom. */
export const FWD_MEMWB_TAP = { x: BUS_MEMWB_X, y: 575 + PIPELINE_BOTTOM_DY };

export interface ForwardWire {
  /** Shared run from the tap to the fork on the bus; lit if either mux
   * forwards from this source. */
  trunk: WireSegment;
  /** Into MUX 6; lit when Fwdop1 selects this source. */
  toMux6: WireSegment;
  /** Into MUX 7; lit when Fwdop2 selects this source. */
  toMux7: WireSegment;
}

export const FWD_EXMEM: ForwardWire = {
  trunk: poly(
    [FWD_EXMEM_TAP.x, FWD_EXMEM_TAP.y, FWD_EXMEM_TAP.x, EXMEM_LANE_Y, BUS_EXMEM_X, EXMEM_LANE_Y, BUS_EXMEM_X, MUX6_IN_EXMEM],
    false,
  ),
  toMux6: poly([BUS_EXMEM_X, MUX6_IN_EXMEM, FWD_COL_X, MUX6_IN_EXMEM], true),
  // Hops bus (c).
  toMux7: {
    d:
      `M ${BUS_EXMEM_X} ${MUX6_IN_EXMEM} L ${BUS_EXMEM_X} ${MUX7_IN_EXMEM} ` +
      `L ${BUS_MEMWB_X - HOP} ${MUX7_IN_EXMEM} A ${HOP} ${HOP} 0 0 1 ${BUS_MEMWB_X + HOP} ${MUX7_IN_EXMEM} ` +
      `L ${FWD_COL_X} ${MUX7_IN_EXMEM}`,
    arrow: true,
    stage: "EX",
  },
};

export const FWD_MEMWB: ForwardWire = {
  trunk: poly([FWD_MEMWB_TAP.x, FWD_MEMWB_TAP.y, BUS_MEMWB_X, MUX7_IN_MEMWB], false),
  toMux6: poly([BUS_MEMWB_X, MUX7_IN_MEMWB, BUS_MEMWB_X, MUX6_IN_MEMWB, FWD_COL_X, MUX6_IN_MEMWB], true),
  toMux7: poly([BUS_MEMWB_X, MUX7_IN_MEMWB, FWD_COL_X, MUX7_IN_MEMWB], true),
};