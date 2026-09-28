/**
 * Pure geometry for every wire segment in the datapath, extracted directly
 * from processor.js's line$*() point arrays (init()'s `line[...]` object) —
 * same 900×580 coordinate space the original Konva stage used, so this
 * drops straight into an SVG `viewBox="0 0 900 580"` unchanged.
 *
 * Two-level structure, mirroring the original exactly:
 *   - SEGMENTS: every individual line$*() polyline/arrow (40 of them) —
 *     these are the actual drawn paths.
 *   - WIRE_TO_SEGMENTS: WireId -> which segment(s) it lights up, ported
 *     directly from processor.js's mark$*() functions (e.g. mark$RT_RR2
 *     stroked both "RT_" and "_RR2" — so WIRE_TO_SEGMENTS.RT_RR2 is
 *     ["RT_", "_RR2"]). Some segments are shared between two WireIds
 *     (e.g. "RD2_"/"_RD2_"/"_RD2" light up for both RD2_MUX2 and
 *     RD2_MWD) — that's preserved too.
 *
 * Four segments (_RD1_, _RD2_, _MWD_, _MUX3_, _WD_) were Konva.Arc calls —
 * small radius-5 decorative rounded corners connecting two collinear or
 * perpendicular line endpoints, not semantically meaningful wires. Rather
 * than replicate Konva's angle/rotation arc math exactly, these are
 * approximated as a simple SVG semicircular arc between the same two
 * connection points — visually equivalent, not pixel-identical. Flagged
 * here rather than silently assumed exact.
 */
import type { WireId } from "./datapath";

export interface WireSegment {
  /** SVG path `d` attribute. */
  d: string;
  /** Whether this segment should render an arrowhead at its end. */
  arrow: boolean;
  /** Raw polyline points [x0, y0, x1, y1, ...] — kept alongside `d` so the
   * pipelined layout (see pipelineSegment below) can re-position and split
   * the same geometry instead of maintaining a second copy of every wire. */
  pts?: number[];
  /** Endpoints [x0, y0, x1, y1] of a loop() connector, for the same reason. */
  arc?: [number, number, number, number];
  /** Pipeline mode only: which stage region this piece of wire sits in
   * (see pipelineSegment). DatapathDiagram lights a piece only during its
   * own stage. */
  stage?: Stage;
}

function poly(points: number[], arrow: boolean): WireSegment {
  const [x0, y0, ...rest] = points;
  let d = `M ${x0} ${y0}`;
  for (let i = 0; i < rest.length; i += 2) d += ` L ${rest[i]} ${rest[i + 1]}`;
  return { d, arrow, pts: points };
}

/** A ~180° radius-5 semicircular connector between two points 10 units
 * apart — see the header comment on why this approximates the original's
 * Konva.Arc calls rather than reproducing their exact angle/rotation. */
function loop(x0: number, y0: number, x1: number, y1: number): WireSegment {
  const r = 5;
  return { d: `M ${x0} ${y0} A ${r} ${r} 0 1 1 ${x1} ${y1}`, arrow: false, arc: [x0, y0, x1, y1] };
}

export const SEGMENTS: Record<string, WireSegment> = {
  IM_INST: poly([15, 75, 5, 75, 5, 360, 60, 360], true),
  RS_RR1: poly([80, 255, 200, 255], true),
  RT_: poly([80, 325, 100, 325], false),
  _RR2: poly([100, 325, 200, 325], true),
  _MUX1: poly([100, 325, 100, 355, 130, 355], true),
  RD_MUX1: poly([80, 395, 130, 395], true),
  MUX1_WR: poly([160, 375, 180, 375, 200, 375], true),
  RD1_: poly([300, 255, 320, 255], false),
  _RD1_: loop(320, 255, 330, 255),
  _ALU1: poly([330, 255, 450, 255], true),
  IMM_EXT: poly([80, 500, 200, 500], false),
  PC_: poly([170, 30, 200, 30], false),
  _ADD1: poly([200, 30, 250, 30], true),
  _IADDR: poly([200, 30, 200, 115, 115, 115], true),
  ADD1_: poly([290, 45, 400, 45], false),
  _MUX4: poly([400, 45, 780, 45], true),
  _ADD2: poly([400, 45, 400, 75, 500, 75], true),
  LS_ADD2: poly([375, 115, 500, 115], true),
  ADD2_MUX4: poly([540, 95, 780, 95], true),
  // Was MUX4_PC (poly([810,70,850,70,850,5,150,5,150,15])) — replaced by
  // the four segments below, which insert a new MUX 5 (jump-select)
  // between MUX 4 and PC instead of wiring MUX 4 straight into it. See
  // datapath.ts's WIRES header comment for what each new WireId means.
  //
  // MUX4_MUX5: MUX 4's output, stepped up from its own y=70 exit height
  // to MUX 5's first input port at y=45 (mirrors MUX 4's own two-inputs-
  // on-the-left layout).
  MUX4_MUX5: poly([810, 70, 825, 70, 825, 45, 840, 45], true),
  // JADDR_LS: the raw 26-bit jump index. Tapped from x=60 (the field
  // column's own left edge) at y=370 — inside the rd field's row (y=360-
  // 430) — then run left to x=5, since that's the actual instruction bus
  // column the raw fetched word already occupies (IM_INST's own vertical
  // run uses the same x=5, just for y=75->360; this continues that same
  // column further down rather than reusing rd's decoded value, which is
  // labeled directly beneath this tap — see the "inst[25:0]" label in
  // DatapathDiagram.tsx — precisely because this ISN'T rd, it just runs
  // past that row on its way down). Drops to y=590 (matching the jump
  // shift-left ellipse's current cy in DatapathDiagram.tsx — keep these
  // two in sync if either moves again), clearing the funct field box's
  // bottom edge at y=570 by 20px, then right into the ellipse's left
  // edge (x=110).
  JADDR_LS: poly([60, 370, 5, 370, 5, 590, 110, 590], true),
  // LS_MUX5: the jump shift-left ellipse's output (right edge, x=190) to
  // MUX 5's second input (right side, y=100 — deliberately NOT the bottom
  // edge, which would put this wire's long vertical run at x≈850,
  // directly on top of WD_'s own x=850 vertical stub below; entering from
  // the right at x=890 instead keeps a real ~40px gap from it the whole
  // way up, rather than the ~20px-or-less gap that read as "the same
  // line" the last two times this diagram hit that problem (Add1's "4"
  // arrow, the shamt arrow's first placement)). Starts at y=590, matching
  // JADDR_LS's new endpoint / the ellipse's current cy.
  LS_MUX5: poly([190, 590, 890, 590, 890, 100, 870, 100], true),
  // MUX5_PC: MUX 5's output (right edge, y=70, same exit height MUX 4
  // used to use directly) — same wraparound shape the old MUX4_PC wire
  // had, just started 20 units further right (x=870 instead of x=810,
  // since MUX 5 now sits where that wire used to begin) and turning the
  // corner at x=885 instead of x=850 to keep clear of LS_MUX5's parallel
  // vertical run at x=890 (they never share a y-range, but the extra
  // gap costs nothing and avoids relying on that).
  MUX5_PC: poly([870, 70, 885, 70, 885, 5, 150, 5, 150, 15], true),
  EXT_: poly([300, 500, 325, 500, 325, 415], false),
  _LS: poly([325, 415, 325, 140], true),
  _1MUX2: poly([325, 415, 390, 415], true),
  RD2_: poly([300, 375, 320, 375], false),
  _RD2_: loop(320, 375, 330, 375),
  _RD2: poly([330, 375, 360, 375], false),
  _2MUX2: poly([360, 375, 390, 375], true),
  MUX2_ALU2: poly([420, 395, 450, 395], true),
  // NEW — shamt field straight into the ALU's second operand, for sll/srl.
  // There was never dedicated artwork for this in processor.js (it never
  // supported shifts at all — see interpreter.ts's execA comment). Routed
  // out from the shamt field box's right edge (x=80, mid-height y=465,
  // below the Register File box's bottom edge at y=430 so it can run
  // clear underneath it), then up into the ALU pentagon's bottom-right
  // diagonal edge at x=480 (y=412.75, computed from aluPath's own
  // (450,430)->(550,372.5) diagonal so the endpoint lands exactly on the
  // boundary, same as every other wire here) — deliberately past the
  // bottom-left corner (which would be x=450) so the vertical stub clears
  // the ALUSrc control label's box (x=370-440) with room to spare for the
  // "shamt" text label placed beside it, instead of the two overlapping.
  SHAMT_ALU2: poly([80, 465, 480, 465, 480, 412.75], true),
  MWD_: poly([360, 375, 360, 410], false),
  _MWD_: loop(360, 410, 360, 420),
  _MWD: poly([360, 420, 360, 480, 650, 480], true),
  RES_: poly([550, 350, 600, 350], false),
  _MADDR: poly([600, 350, 650, 350], true),
  MUX3_: poly([600, 350, 600, 460], false),
  _MUX3_: loop(600, 460, 600, 470),
  _MUX3: poly([600, 470, 600, 525, 780, 525], true),
  MRD_MUX3: poly([750, 445, 780, 445], true),
  WD_: poly([810, 482.5, 850, 482.5, 850, 575, 185, 575, 185, 505], false),
  _WD_: loop(185, 505, 185, 495),
  _WD: poly([185, 495, 185, 410, 200, 410], true),
};

/**
 * Fallback geometry for the pre-jump layout — MUX 4 wired straight into
 * PC, before MUX 5/JADDR_LS/LS_MUX5/MUX5_PC existed. Deliberately NOT
 * part of SEGMENTS/WIRE_TO_SEGMENTS: it isn't a real WireId, and the
 * interpreter should never be able to light it — execStage() always
 * computes the jump datapath correctly regardless of what the UI shows.
 * This exists purely so DatapathDiagram can render the "Jump" feature
 * toggle's off state (see its own header comment) by substituting this
 * one segment back in and hiding MUX 5's real geometry, rather than
 * maintaining two divergent execStage() implementations to match two
 * divergent diagrams.
 */
export const LEGACY_SEGMENTS: Record<string, WireSegment> = {
  MUX4_PC: poly([810, 70, 850, 70, 850, 5, 150, 5, 150, 15], true),
};

/** Ported directly from processor.js's mark$*() functions — which
 * segment(s) each public WireId lights up. */
export const WIRE_TO_SEGMENTS: Record<WireId, string[]> = {
  PC_IM: ["PC_", "_IADDR"],
  PC_ADD1: ["PC_", "_ADD1"],
  IM_INST: ["IM_INST"],
  RS_RR1: ["RS_RR1"],
  RT_RR2: ["RT_", "_RR2"],
  RT_MUX1: ["RT_", "_MUX1"],
  RD_MUX1: ["RD_MUX1"],
  MUX1_WR: ["MUX1_WR"],
  IMM_MUX2: ["IMM_EXT", "EXT_", "_1MUX2"],
  IMM_ADD2: ["IMM_EXT", "EXT_", "_LS", "LS_ADD2"],
  ADD1_ADD2: ["ADD1_", "_ADD2"],
  RD1_ALU1: ["RD1_", "_RD1_", "_ALU1"],
  RD2_MUX2: ["RD2_", "_RD2_", "_RD2", "_2MUX2"],
  MUX2_ALU2: ["MUX2_ALU2"],
  SHAMT_ALU2: ["SHAMT_ALU2"],
  RD2_MWD: ["RD2_", "_RD2_", "_RD2", "MWD_", "_MWD_", "_MWD"],
  RES_MADDR: ["RES_", "_MADDR"],
  RES_MUX3: ["RES_", "MUX3_", "_MUX3_", "_MUX3"],
  MRD_MUX3: ["MRD_MUX3"],
  ADD1_MUX4: ["ADD1_", "_MUX4"],
  ADD2_MUX4: ["ADD2_MUX4"],
  MUX4_MUX5: ["MUX4_MUX5"],
  JADDR_LS: ["JADDR_LS"],
  LS_MUX5: ["LS_MUX5"],
  MUX5_PC: ["MUX5_PC"],
  MUX3_WD: ["WD_", "_WD_", "_WD"],
};

/** Expands a list of active WireIds into the set of underlying segment
 * keys that should render as "active" — the actual thing the SVG renderer
 * checks per segment. */
export function activeSegmentKeys(activeWires: WireId[]): Set<string> {
  const keys = new Set<string>();
  for (const wire of activeWires) {
    for (const seg of WIRE_TO_SEGMENTS[wire]) keys.add(seg);
  }
  return keys;
}

/** Same custom-pentagon path shape$ALU() drew for the ALU, ADD1, and ADD2
 * boxes — ported as a pure path-string function instead of a Konva
 * sceneFunc. */
export function aluPath(x: number, y: number, w: number, h: number): string {
  const dy = h / 4;
  const m = (2 * y + h) / 2;
  const dx = w / 4;
  return [
    `M ${x} ${y}`,
    `L ${x + w} ${y + dy}`,
    `L ${x + w} ${y + h - dy}`,
    `L ${x} ${y + h}`,
    `L ${x} ${m + dy / 2}`,
    `L ${x + dx} ${m}`,
    `L ${x} ${m - dy / 2}`,
    "Z",
  ].join(" ");
}
// ===========================================================================
// Pipelined layout
// ===========================================================================
/**
 * Geometry for the "Pipeline" feature toggle: the same diagram with the four
 * pipeline registers (IF/ID, ID/EX, EX/MEM, MEM/WB) inserted as vertical
 * bars, placed the way the textbook (Patterson & Hennessy) figure places
 * them. Like the shift/jump toggles this is presentation-only — nothing
 * here changes what execStage() computes or which WireIds it lights.
 *
 * How space is made for the bars: every ID..WB component and wire point is
 * assigned to a stage and translated right by that stage's PIPELINE_OFFSET.
 * Those stages are separated by plain x-boundaries in the original
 * coordinate space (STAGE_BOUNDS).
 *
 * IF gets its own compact layout instead (PIPELINE_IF). In the single-cycle
 * layout IF is spread across the top (IM at x=15-115, PC at 130, Add1 at
 * 250-290) with the instruction fields stacked under IM — which can't be
 * separated by a vertical bar. Here the fields have moved right into ID, so
 * the space under PC is free: PC and Add1 sit in a narrow row at the top
 * and IM goes directly under PC, fed from above. IF then ends at x=165
 * (Add1's right edge) instead of 290, which is what lets ID start at +165
 * rather than +290 and keeps the whole diagram ~125 units narrower. Every
 * wire touching IF has explicit pipelined geometry in PIPELINE_OVERRIDES.
 *
 * Wires are then split wherever a horizontal run crosses a bar (see
 * splitAtBars): the piece before the bar ends at its edge with an
 * arrowhead, and a new piece starts on the far edge — so each wire
 * visibly goes *into* and *out of* the pipeline register rather than
 * just passing behind it.
 */

export type Stage = "IF" | "ID" | "EX" | "MEM" | "WB";

/** Original-space x boundaries: ID | EX at 310 (right after the Register
 * File and Sign Extend, both ending at x=300, and before the RD1/RD2 hops at
 * 320-330 — so ID/EX sits close to the Register File, and the sign-extend
 * fork, the RD2 -> Write Data fork and the branch Left Shift are all in EX,
 * as in the textbook), EX | MEM at 575 (between
 * the ALU, x=550, and the RES_ fork, x=600), MEM | WB at 765 (between Data
 * Memory, x=750, and MUX 3, x=780). Chosen so no component straddles a
 * boundary and no vertical wire run sits on one. */
const STAGE_BOUNDS = { EX: 310, MEM: 575, WB: 765 } as const;

/** Horizontal gap opened at each of the ID|EX, EX|MEM, MEM|WB boundaries. */
const STAGE_GAP = 44;

/** In pipeline mode the whole top row — PC, Add1, Instruction Memory, the
 * branch adder (Add2), the branch Left Shift, MUX 4/5, the PC return wire
 * along the very top, and the bars' own tops — moves down by this much,
 * closing up the gap between it and the Register File / ALU row. The
 * pipelined viewBox then starts at y=TOP_DY instead of 0, so the diagram is
 * TOP_DY shorter and the bars are TOP_DY shorter at the top.
 *
 * Applied to wires by shiftTop (every point above TOP_SPLIT) and to
 * components by DatapathDiagram's translations. 30 is set by the tightest
 * gap it closes: Add2's bottom (125 -> 155) to the ALUctrl label (y=190). */
const TOP_DY = 30;
/** Wire points above this y are in the top row. Nothing in the middle or
 * bottom rows sits above it: the instruction-field column starts at 150,
 * the Register File / ALU / MEM/WB bar at 200. */
const TOP_SPLIT = 150;
export const PIPELINE_TOP_DY = TOP_DY;

/** Compact IF-stage layout, in pipelined coordinates.
 *   PC   — x=15-55, y=15-75 (its single-cycle x=130, shifted by pcDx)
 *   Add1 — x=125-165, y=15-75 (its single-cycle x=250, shifted by add1Dx);
 *          the "4" label/arrow live in the same group and move with it
 *   IM   — x=25-125, y=150-270, directly under PC. Address enters its top
 *          edge at x=75 (the PC-output fork), instruction leaves its right
 *          edge at y=235 (below the two-line title).
 * The fork at x=75 sits 20 right of PC, and 50 left of Add1 — the same
 * spacing the single-cycle layout uses between its x=200 fork and Add1 —
 * so the "4" label keeps the same clearance from the vertical address wire. */
export const PIPELINE_IF = {
  pcDx: -115,
  add1Dx: -125,
  im: { x: 25, y: 150 + TOP_DY, width: 100, height: 120 },
  fork: 75,
  imOutY: 235 + TOP_DY,
  right: 165,
} as const;

/** ID's leftmost element, the instruction-field column (x=60), lands 24 past
 * the IF/ID bar's right edge: IF right (165) + 20 + bar (16) + 24 = 225. */
const ID_OFFSET = 165;

/** MEM's leading part — the RES_ fork at original x=600 (where the ALU
 * result splits to Data Memory's address and down towards MUX 3) and its
 * hop — gets its own offset, putting the fork 25 past EX/MEM's right edge
 * (814 -> 839), the same stub the other bars leave. Data Memory and the
 * rest of MEM (x >= MEM_SPLIT) then use PIPELINE_OFFSET.MEM, 20 less, so the
 * fork-to-Data-Memory run is 30 instead of the single-cycle 50. Together
 * that pulls Data Memory — and everything right of it — 34 units closer to
 * EX/MEM than a uniform STAGE_GAP would. */
const MEM_FORK_OFFSET = ID_OFFSET + 2 * STAGE_GAP - 14;
const MEM_SPLIT = 625;

export const PIPELINE_OFFSET: Record<Stage, number> = {
  IF: 0,
  ID: ID_OFFSET,
  EX: ID_OFFSET + STAGE_GAP,
  // MEM is tighter than the other stages, so Data Memory sits close to
  // EX/MEM: see MEM_FORK_OFFSET below. This offset applies to Data Memory
  // and everything after it within MEM (original x >= MEM_SPLIT).
  MEM: MEM_FORK_OFFSET - 20,
  WB: MEM_FORK_OFFSET - 20 + STAGE_GAP,
};

/** Pipelined viewBox width: the rightmost wire is LS_MUX5's climb at
 * LS_UP_X (1153). */
export const PIPELINE_VIEW_WIDTH = 1165;

export interface PipelineBar {
  label: string;
  /** Left edge, in pipelined coordinates. */
  x: number;
  width: number;
  top: number;
  bottom: number;
}

const BAR_W = 16;
/** In pipeline mode everything along the bottom of the single-cycle layout
 * — WD_'s return run (y=575), the jump shift-left ellipse and its wires
 * (y=590) — moves down by this much, making room below Sign Extend for the
 * rt/rd wires that travel through ID/EX to the RegDst mux in EX (see "Write
 * register path" below). Kept as small as those lanes allow, so the
 * pipelined diagram is no taller than the single-cycle one.
 *
 * The bottom stack, top to bottom: Sign Extend (bottom 515), rt lane 525,
 * rd lane 545, MUX 1's output 548, bars' bottom 555, WB_WR 568, WD_ 581,
 * jump ellipse 578-614 (cy 596) with LS_MUX5 along 596 — each 10-13 apart,
 * the same spacing the single-cycle layout uses between WD_ and the jump
 * ellipse. */
const BOTTOM_DY = 6;

/** Pipelined viewBox: starts at y=TOP_DY (the PC return wire, 5 below
 * that, is the topmost thing drawn) and ends at 622 — the jump ellipse's
 * bottom lands at 590 + 6 + 18 = 614, and 622 matches the single-cycle
 * diagram's own bottom margin. */
export const PIPELINE_VIEW_Y = TOP_DY;
export const PIPELINE_VIEW_HEIGHT = 622 - TOP_DY;

/** Bars span y=30..555: below the MUX5_PC return wire along y=5 (so the
 * bar labels fit between the two) and above the two write-back return
 * wires along the bottom (WB_WR at y=568, WD_ at y=581), so every backward
 * wire runs around the bars rather than through them, as in the textbook
 * figure. The lowest wire that has to pass through a bar is MUX 1's output
 * at y=548. */
const BAR_TOP = 30 + TOP_DY;
const BAR_BOTTOM = 555;

/** Centers a bar in the gap opened at original-space boundary `b`. */
function barAt(label: string, b: number, before: Stage, after: Stage, top = BAR_TOP): PipelineBar {
  const center = b + (PIPELINE_OFFSET[before] + PIPELINE_OFFSET[after]) / 2;
  return { label, x: center - BAR_W / 2, width: BAR_W, top, bottom: BAR_BOTTOM };
}

const IFID_X = PIPELINE_IF.right + 20;
/** Center of the funct field box's bottom edge, in pipelined coordinates. */
const JADDR_X = 70 + ID_OFFSET;

export const PIPELINE_BARS: PipelineBar[] = [
  // IF/ID: between Add1's right edge (165) and the instruction fields' new
  // left edge (60 + 165 = 225).
  { label: "IF/ID", x: IFID_X, width: BAR_W, top: BAR_TOP, bottom: BAR_BOTTOM },
  barAt("ID/EX", STAGE_BOUNDS.EX, "ID", "EX"),
  // EX/MEM: where a uniform STAGE_GAP would put it (39 past the ALU), but
  // MEM itself is compressed after it — see MEM_FORK_OFFSET.
  { label: "EX/MEM", x: STAGE_BOUNDS.MEM + PIPELINE_OFFSET.EX + STAGE_GAP / 2 - BAR_W / 2, width: BAR_W, top: BAR_TOP, bottom: BAR_BOTTOM },
  // MEM/WB starts below MUX 4's "Branch & isZero?" label, so the PC+4 and
  // branch-target wires feeding MUX 4 along the top aren't routed through
  // the write-back register — only the two MUX 3 inputs are.
  barAt("MEM/WB", STAGE_BOUNDS.WB, "MEM", "WB", 200),
];

/** Pipelined x-offset of a non-IF wire point, by its original x: its
 * stage's offset, except MEM's leading fork (see MEM_FORK_OFFSET). */
function offsetOfX(x: number): number {
  const stage = stageOfX(x);
  if (stage === "MEM" && x < MEM_SPLIT) return MEM_FORK_OFFSET;
  return PIPELINE_OFFSET[stage];
}

/** Stage of a non-IF point, by its original x. */
export function stageOfX(x: number): Exclude<Stage, "IF"> {
  if (x < STAGE_BOUNDS.EX) return "ID";
  if (x < STAGE_BOUNDS.MEM) return "EX";
  if (x < STAGE_BOUNDS.WB) return "MEM";
  return "WB";
}

/** Segments redrawn from scratch for the pipelined layout, in pipelined
 * coordinates — every wire with an end in IF, plus JADDR_LS. */
const { fork, imOutY, im } = PIPELINE_IF;
const pcCx = 150 + PIPELINE_IF.pcDx; // PC's top-center input, x=35
const imRight = im.x + im.width;
const add1Left = 250 + PIPELINE_IF.add1Dx;
const WB = PIPELINE_OFFSET.WB;

/** MUX 4 / MUX 5 (the PC-select pair along the top) in pipeline mode: moved
 * left from their WB-stage position to sit 30 past EX/MEM (MUX 4 at
 * x=844-874, MUX 5 at 904-934, same 60 spacing as before), so the PC+4 and
 * branch-target wires out of EX/MEM are short. Every wire touching them is
 * redrawn below using TOP_MUX_X in place of the WB offset. */
export const PIPELINE_TOP_MUX_DX = 814 + 30 - 780;
const TM = PIPELINE_TOP_MUX_DX;
/** LS_MUX5's climb up the right-hand side. It can't come up anywhere left of
 * WD_'s vertical (850 + WB) without crossing the write-back wires along the
 * bottom, so it stays at the far right, 40 clear of WD_ as before, then
 * runs left above MEM/WB (top y=200) into MUX 5's right-hand input. */
const LS_UP_X = 850 + WB + 40;
// ---- Write register path (pipeline mode) -----------------------------------
/**
 * As in the textbook figure, the write-register number travels with its
 * instruction: rt and rd both pass through ID/EX to the RegDst mux (MUX 1),
 * which now sits in EX; its output passes through EX/MEM and MEM/WB, and
 * PIPELINE_WB_WR carries it from MEM/WB back to the Register File's WR port.
 * Otherwise WB would write to whatever register the instruction currently
 * in ID names, not its own.
 *
 * In pipelined coordinates:
 *   - rt lane: taps the rt -> RR2 wire at x=295, drops to y=525, runs right
 *     under Sign Extend (bottom y=515) through ID/EX into the mux's input 0.
 *   - rd lane: leaves the rd field (y=395), turns down at x=275 — left of
 *     the rt lane so the two never cross — to y=545, then the same way into
 *     input 1.
 *   - mux: x=640-670, y=515-555 in EX, below _MWD (y=480) and the shamt
 *     label; RegDst's control tick comes from above since the band below it
 *     carries WB_WR.
 *   - output: leaves the mux at its mid-height (y=535), then steps down at
 *     x=690 to y=548 before running through EX/MEM into MEM/WB — at 535 it
 *     would run only 10 below _MUX3 (y=525) all the way across MEM; at 548
 *     it's 23 clear, and still inside the bars (bottom 555).
 *
 * Both lanes have to cross the write-back return wires' verticals (WB_WR at
 * x=320, WD_ at x=350) and IMM_EXT (y=500): unavoidable here, because the
 * returns come up between the field column and the Register File. Each
 * crossing gets a hop on the new wire, in the same style as the diagram's
 * existing _RD1_/_WD_ hops. (Like _WD_, they cross shamt's y=465 run
 * without a hop.)
 */
export const PIPELINE_REGDST_MUX = { x: 640, y: 515, width: 30, height: 40 };
const RT_LANE_Y = 525;
const RD_LANE_Y = 545;
const RT_DOWN_X = 295;
const RD_DOWN_X = 275;
const REGDST_OUT_Y = PIPELINE_REGDST_MUX.y + PIPELINE_REGDST_MUX.height / 2; // 535
const REGDST_STEP_X = 690;
const REGDST_LANE_Y = 548;
const WR_UP_X = 155 + PIPELINE_OFFSET.ID; // WB_WR's vertical, x=320
const WD_UP_X = 185 + PIPELINE_OFFSET.ID; // WD_'s vertical, x=350
const IMM_Y = 500;

// ---- Branch Left Shift 2-bit (pipeline mode) ------------------------------
/**
 * With ID/EX moved up to the Register File, the branch shifter belongs in EX
 * (after the sign-extended immediate has passed through ID/EX), as in the
 * textbook. Its single-cycle position (center x=325) would straddle the bar,
 * so in pipeline mode it moves right and is fed from its left side instead
 * of its bottom: _LS rises from the sign-extend fork (x=325 -> 534) to the
 * ellipse's mid-height (y=115) and turns right into its left edge 20 units
 * later; LS_ADD2 leaves its right edge into Add2's lower input as before.
 * At x=554-654, y=90-140 it clears the _ADD2 fork's drop (x=609, y=45-75)
 * above and the ALU/ALUctrl label (y>=190) below.
 */
const LS_FORK_X = 325 + PIPELINE_OFFSET.EX;
export const PIPELINE_BRANCH_LS = { cx: LS_FORK_X + 20 + 50, cy: 115, rx: 50 };

type OverridePart = number[] | { arc: [number, number, number, number] };
const hop = (x0: number, y0: number, x1: number, y1: number): OverridePart => ({ arc: [x0, y0, x1, y1] });

/** A lane dropping at `downX` from `startY` to `laneY`, then right to the
 * mux, hopping IMM_EXT on the way down and both return verticals on the way
 * across. `lead` is any run before the drop. */
function lane(lead: number[], downX: number, laneY: number): OverridePart[] {
  const muxX = PIPELINE_REGDST_MUX.x;
  return [
    [...lead, downX, IMM_Y - 5],
    hop(downX, IMM_Y - 5, downX, IMM_Y + 5),
    [downX, IMM_Y + 5, downX, laneY, WR_UP_X - 5, laneY],
    hop(WR_UP_X - 5, laneY, WR_UP_X + 5, laneY),
    [WR_UP_X + 5, laneY, WD_UP_X - 5, laneY],
    hop(WD_UP_X - 5, laneY, WD_UP_X + 5, laneY),
    [WD_UP_X + 5, laneY, muxX, laneY],
  ];
}

const PIPELINE_OVERRIDES: Record<string, OverridePart[]> = {
  // PC's output (right edge, y=30) to the fork.
  PC_: [[170 + PIPELINE_IF.pcDx, 30, fork, 30]],
  _ADD1: [[fork, 30, add1Left, 30]],
  // Down from the fork into IM's top edge.
  _IADDR: [[fork, 30, fork, im.y]],
  // PC+4, from Add1's output through IF/ID and ID/EX to the fork in EX.
  ADD1_: [[PIPELINE_IF.right, 45, 400 + PIPELINE_OFFSET.EX, 45]],
  // IM's output, stepped down (between IM and the bar) to the rd-row height
  // the field column is fed at, then through IF/ID into the fields.
  IM_INST: [[imRight, imOutY, imRight + 30, imOutY, imRight + 30, 360, 60 + PIPELINE_OFFSET.ID, 360]],
  // Return wires into PC's top: same shape as before, just ending at PC's
  // new x.
  MUX5_PC: [[870 + TM, 70, 885 + TM, 70, 885 + TM, 5, pcCx, 5, pcCx, 15]],
  MUX4_PC: [[810 + TM, 70, 850 + TM, 70, 850 + TM, 5, pcCx, 5, pcCx, 15]],
  // Into / between the relocated top muxes — see PIPELINE_TOP_MUX_DX.
  _MUX4: [[400 + PIPELINE_OFFSET.EX, 45, 780 + TM, 45]],
  ADD2_MUX4: [[540 + PIPELINE_OFFSET.EX, 95, 780 + TM, 95]],
  MUX4_MUX5: [[810 + TM, 70, 825 + TM, 70, 825 + TM, 45, 840 + TM, 45]],
  // JADDR_LS normally runs left from the rd field along the x=5 bus, which
  // in pipelined coordinates would fall left of the IF/ID bar. Instead it
  // leaves the instruction-field column from the bottom of the funct box
  // (x=60-80 -> 225-245, bottom edge y=570), so it still visibly comes from
  // the decoded instruction, then drops to the jump shift-left ellipse's
  // (moved-down) height and runs right into its left edge (110 + 165).
  JADDR_LS: [[JADDR_X, 570, JADDR_X, 590 + BOTTOM_DY, 110 + PIPELINE_OFFSET.ID, 590 + BOTTOM_DY]],
  // Branch shifter, now in EX — see PIPELINE_BRANCH_LS.
  _LS: [[LS_FORK_X, 415, LS_FORK_X, PIPELINE_BRANCH_LS.cy, PIPELINE_BRANCH_LS.cx - PIPELINE_BRANCH_LS.rx, PIPELINE_BRANCH_LS.cy]],
  LS_ADD2: [[PIPELINE_BRANCH_LS.cx + PIPELINE_BRANCH_LS.rx, PIPELINE_BRANCH_LS.cy, 500 + PIPELINE_OFFSET.EX, 115]],
  // Bottom-band wires, moved down by BOTTOM_DY.
  LS_MUX5: [[190 + PIPELINE_OFFSET.ID, 590 + BOTTOM_DY, LS_UP_X, 590 + BOTTOM_DY, LS_UP_X, 100, 870 + TM, 100]],
  WD_: [[810 + WB, 482.5, 850 + WB, 482.5, 850 + WB, 575 + BOTTOM_DY, WD_UP_X, 575 + BOTTOM_DY, WD_UP_X, 505]],
  // Write register path — see the section comment above. Keys are the
  // RegDst wires' own segments, so RT_MUX1 / RD_MUX1 / MUX1_WR light them
  // exactly as they light MUX 1's wires in the single-cycle layout.
  _MUX1: lane([RT_DOWN_X, 325], RT_DOWN_X, RT_LANE_Y),
  RD_MUX1: lane([80 + PIPELINE_OFFSET.ID, 395, RD_DOWN_X, 395], RD_DOWN_X, RD_LANE_Y),
  MUX1_WR: [
    [
      PIPELINE_REGDST_MUX.x + PIPELINE_REGDST_MUX.width, REGDST_OUT_Y,
      REGDST_STEP_X, REGDST_OUT_Y,
      REGDST_STEP_X, REGDST_LANE_Y,
      PIPELINE_BARS[3].x, REGDST_LANE_Y,
    ],
  ],
};

/** Where to put the "inst[25:0]" label in the pipelined layout: a
 * right-aligned box ending just left of JADDR_LS's short vertical drop,
 * below the funct box. There's nothing else in that corner — the IF/ID bar
 * ends at y=555 and WD_'s y=575 return run stops at x=350. */
export const PIPELINE_JADDR_LABEL = { x: JADDR_X - 64, y: 577, width: 60 };

// ---- Stage regions (pipeline-mode highlighting) ---------------------------
/**
 * In pipeline mode a wire is lit piece by piece: during a micro-step only
 * the pieces in that step's stage region light (F -> IF, D -> ID, A -> EX,
 * M -> MEM, R -> WB). So in Decode a wire lights up to where it enters
 * ID/EX, in ALU from where it leaves ID/EX up to EX/MEM, and so on.
 *
 * A piece's region is where its wire *starts* (by x, relative to the bars'
 * centers), advanced one stage for every bar the wire has passed through
 * before that piece. Backward wires start at their source, so e.g. WB_WR
 * (from MEM/WB) is WB. Exceptions:
 *   - STAGE_BY_KEY pins a whole segment to one stage. WD_'s tail segments
 *     are drawn in the ID area but carry MUX 3's write-back value, so WB.
 *     The PC update — MUX 4 -> MUX 5 -> PC, and for jumps inst[25:0] ->
 *     Left Shift -> MUX 5 — is WB too, matching the single-cycle view, where
 *     execStage lights all of it in the R step (it's where the interpreter
 *     actually writes PC). By position they'd be MEM and ID.
 *   - MEM_TO_WB_KEYS: the two wires feeding MUX 4 (PC+4 and the branch
 *     target) keep their earlier pieces in their own stages — they travel
 *     through IF/ID, ID/EX and EX/MEM with the instruction — but the piece
 *     from EX/MEM into MUX 4 is part of that same PC update, so WB as well.
 */
const STAGE_ORDER: Stage[] = ["IF", "ID", "EX", "MEM", "WB"];
const STAGE_BY_KEY: Record<string, Stage> = {
  WD_: "WB",
  _WD_: "WB",
  _WD: "WB",
  MUX4_MUX5: "WB",
  MUX5_PC: "WB",
  MUX4_PC: "WB",
  JADDR_LS: "WB",
  LS_MUX5: "WB",
};
const MEM_TO_WB_KEYS = new Set(["_MUX4", "ADD2_MUX4"]);

function stageAtX(x: number): Stage {
  let n = 0;
  for (const b of PIPELINE_BARS) if (x >= b.x + b.width / 2) n++;
  return STAGE_ORDER[n];
}

/** Splits a pipelined-coordinate polyline wherever a horizontal run passes
 * fully through a bar. Every piece except the last ends at a bar's near
 * edge with an arrowhead (flowing into the register); the last keeps the
 * original segment's own arrow setting. All wires in this diagram are
 * axis-aligned, and no vertical run falls inside a bar's x-range, so only
 * horizontal runs need checking. */
function splitAtBars(pts: number[], arrow: boolean, pinned?: Stage): WireSegment[] {
  const pieces: number[][] = [];
  // Stage index of each piece, advanced at every bar crossing.
  let stageIdx = STAGE_ORDER.indexOf(stageAtX(pts[0]));
  const pieceStages: number[] = [];
  let cur = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2], y0 = pts[i - 1], x1 = pts[i], y1 = pts[i + 1];
    if (y0 === y1 && x0 !== x1) {
      const dir = Math.sign(x1 - x0);
      const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
      const crossed = PIPELINE_BARS.filter((b) => y0 > b.top && y0 < b.bottom && lo < b.x && hi > b.x + b.width).sort(
        (a, b) => dir * (a.x - b.x),
      );
      for (const b of crossed) {
        const near = dir > 0 ? b.x : b.x + b.width;
        const far = dir > 0 ? b.x + b.width : b.x;
        cur.push(near, y0);
        pieces.push(cur);
        pieceStages.push(stageIdx);
        stageIdx += dir;
        cur = [far, y0];
      }
    }
    cur.push(x1, y1);
  }
  pieces.push(cur);
  pieceStages.push(stageIdx);
  return pieces.map((p, i) => ({
    ...poly(p, i < pieces.length - 1 ? true : arrow),
    stage: pinned ?? STAGE_ORDER[pieceStages[i]],
  }));
}

/** A loop() hop, tagged with the stage region it sits in. */
function stagedLoop(x0: number, y0: number, x1: number, y1: number, pinned?: Stage): WireSegment {
  return { ...loop(x0, y0, x1, y1), stage: pinned ?? stageAtX(x0) };
}

/** The pipelined version of one SEGMENTS/LEGACY_SEGMENTS entry: moved into
 * its stage's position and split into pieces at every bar it crosses.
 * Every piece keeps the original segment's key for highlighting purposes,
 * so WIRE_TO_SEGMENTS / activeSegmentKeys work unchanged. */
/** Moves top-row points down by TOP_DY (see TOP_DY). Runs on every
 * pipelined point — overrides included, since those are written in the
 * top row's pre-shift coordinates like everything else — before the bar
 * split, which compares against the bars' already-shifted tops. Wires that
 * span both rows (e.g. _LS rising from the sign-extend fork, LS_MUX5
 * climbing the right-hand side) are all vertical where they cross
 * TOP_SPLIT, so moving only their top-row points just lengthens them. */
function shiftTop(pts: number[]): number[] {
  return pts.map((v, i) => (i % 2 === 1 && v < TOP_SPLIT ? v + TOP_DY : v));
}

export function pipelineSegment(key: string, seg: WireSegment): WireSegment[] {
  const pieces = pipelinePieces(key, seg);
  if (!MEM_TO_WB_KEYS.has(key)) return pieces;
  return pieces.map((p) => (p.stage === "MEM" ? { ...p, stage: "WB" as Stage } : p));
}

function pipelinePieces(key: string, seg: WireSegment): WireSegment[] {
  const pinned = STAGE_BY_KEY[key];
  const override = PIPELINE_OVERRIDES[key];
  if (override) {
    // Only the last part carries the segment's own arrowhead; polyline parts
    // are still split at any bars they cross (adding arrows into the bars).
    return override.flatMap((part, i) => {
      if (!Array.isArray(part)) {
        const [x0, y0, x1, y1] = shiftTop(part.arc);
        return [stagedLoop(x0, y0, x1, y1, pinned)];
      }
      return splitAtBars(shiftTop(part), i === override.length - 1 ? seg.arrow : false, pinned);
    });
  }

  if (seg.arc) {
    const [x0, y0, x1, y1] = seg.arc;
    const o = offsetOfX(x0);
    const [sx0, sy0, sx1, sy1] = shiftTop([x0 + o, y0, x1 + o, y1]);
    return [stagedLoop(sx0, sy0, sx1, sy1, pinned)];
  }

  if (!seg.pts) return [seg];
  const pts = seg.pts.slice();
  for (let i = 0; i < pts.length; i += 2) pts[i] += offsetOfX(pts[i]);
  return splitAtBars(shiftTop(pts), seg.arrow, pinned);
}

// ---- Write register, from MEM/WB back to WR (pipeline mode only) ----------
/**
 * The last leg of the write register path (see the section comment on
 * PIPELINE_REGDST_MUX above): the register number latched in MEM/WB, back
 * to WR (365, 375). Out of the bottom of the MEM/WB bar, left along y=568
 * (between the bars' bottom at 555 and WD_'s return run at 581), up at
 * x=320 and into WR.
 *
 * It has to cross WD_ once: WR is the *upper* register-file port, so its
 * wire must turn up left of WD_'s vertical (x=350) — but on the right it
 * starts left of WD_'s source (MEM/WB vs. MUX 3), so it's the inner wire
 * along the bottom. A hop marks that crossing, and a second hop marks its
 * crossing of IMM_EXT (y=500) the same way WD_ already does with _WD_. (It
 * crosses the rt/rd lanes too, but those carry the hops.)
 *
 * Not a real WireId (execStage never lights it directly): DatapathDiagram
 * lights it whenever MUX3_WD is lit, i.e. during write-back, which is when
 * the register number is actually used.
 */
const memWb = PIPELINE_BARS[3];
const WB_X = memWb.x + memWb.width / 2;
const WB_Y = 562 + BOTTOM_DY;
const WR_PORT_X = 200 + PIPELINE_OFFSET.ID; // Register File's left edge
const WR_PORT_Y = 375;

export const PIPELINE_WB_WR: WireSegment[] = [
  poly([WB_X, memWb.bottom, WB_X, WB_Y, WD_UP_X + 5, WB_Y], false),
  loop(WD_UP_X - 5, WB_Y, WD_UP_X + 5, WB_Y),
  poly([WD_UP_X - 5, WB_Y, WR_UP_X, WB_Y, WR_UP_X, IMM_Y + 5], false),
  loop(WR_UP_X, IMM_Y + 5, WR_UP_X, IMM_Y - 5),
  poly([WR_UP_X, IMM_Y - 5, WR_UP_X, WR_PORT_Y, WR_PORT_X, WR_PORT_Y], true),
].map((piece) => ({ ...piece, stage: "WB" as Stage }));

/** How far the bottom band (jump shift-left ellipse etc.) moves down in
 * pipeline mode — for DatapathDiagram's component placement. */
export const PIPELINE_BOTTOM_DY = BOTTOM_DY;
// ---- Control unit (pipeline mode) -----------------------------------------
/**
 * The textbook's Control oval and its control lines, for pipeline mode only.
 * The oval and its input (the opcode field -> Control) are always drawn; the
 * rest — every control line and the WB/M/EX cells on the pipeline registers
 * — is an overlay DatapathDiagram shows only while the oval is hovered (or
 * focused), so the everyday diagram stays as uncluttered as before.
 *
 * Everything is in final pipelined coordinates (after shiftTop), derived
 * from the constants above where the placement depends on them.
 *
 * Control lines end at the existing blue control labels (RegDst, ALUSrc,
 * ALUctrl, Branch, Jump, MemWrite, MemRead, MemToReg, RegWrite) rather than
 * at the components: the label names the signal and its existing tick
 * already carries it into the component.
 *
 * Grouping follows the textbook: EX = RegDst, ALUSrc, ALUctrl; M = Branch,
 * Jump, MemRead, MemWrite (Jump joins M because MUX 5 sits with MUX 4 after
 * EX/MEM); WB = MemToReg, RegWrite.
 *
 * Routing — why each line runs where it does:
 *   - Oval: above the Register File (y=151-187, 13 clear of its top), fed
 *     straight from the opcode field at the M cell's height (169), so its
 *     output runs straight into ID/EX's M cell and forks at x=470, just past
 *     the Register File's right edge (465), up to WB and down to EX.
 *   - EX has only two free horizontal bands: y=85, between PC+4 (75) and
 *     Add2's top (95), and y=177-195, between the branch shifter's bottom
 *     (170) and the ALU's top-left corner (200). WB takes the top band
 *     (jogging up at x=525, before _LS at 534); M steps down to 177; EX's
 *     own line runs at 195 into the ALUctrl label and feeds a bus at x=580
 *     (between MWD_'s vertical at 569 and MUX 2 at 599) down to ALUSrc and
 *     RegDst.
 *   - EX/MEM's and MEM/WB's cells sit at y=210-262, below MUX 4's label
 *     (bottom 210) and above MemWrite (272): the only band there that
 *     reaches MEM/WB (top 200). Both lanes step down in the gap between the
 *     ALU/Add2 and EX/MEM.
 *   - M fans out along y=249: a riser at x=895 up into the "Branch" line of
 *     MUX 4's label from the right; x=919 (Data Memory's centre, under
 *     MUX 5) up to Jump and down to MemWrite; and on along 249 to x=980,
 *     down the right-hand side of Data Memory to MemRead.
 *   - isZero, the ALU's other input to the branch decision, runs from the
 *     ALU's right edge at its "isZero?" label (y=281) through EX/MEM's
 *     body (below the cells) and rises at x=870 into the "isZero?" line of
 *     MUX 4's label — so Branch and isZero each visibly reach their own
 *     word of "Branch & isZero?".
 *   - WB's line to MEM/WB (y=223) must cross the isZero, Branch and Jump
 *     risers — unavoidable with WB above M, as in the textbook — so it hops
 *     them; M's line hops isZero the same way.
 *   - RegWrite goes back to the Register File along the bottom, where
 *     nothing crosses a bar: right of MUX 3 and WD_ (x=1128), under LS_MUX5
 *     (y=610), and up at x=472 into the RegWrite label.
 *
 * Crossings with the (black) data wires are left unhopped: DatapathDiagram
 * draws every control line over a white casing, which reads as "passes
 * over". Only the two control-on-control crossings get hops.
 *
 * Each line also records `start`, its distance from the oval along the
 * control lines, so the hover animation can flow outward at a constant
 * speed: a line starts drawing when the flow reaches its first point.
 */
const [, ctrlIdEx, ctrlExMem, ctrlMemWb] = PIPELINE_BARS;
const CTRL_FIELD_RIGHT = 80 + ID_OFFSET; // opcode field's right edge, x=245
/** Cells are larger than the bars' width (16) so they're easy to see: 30
 * wide (overhanging the bar by 7 each side) and 26 tall. Control lines end
 * and start at the cell edges, not the bar edges. */
const CTRL_CELL_H = 26;
const CTRL_CELL_W = 30;
const cellLeft = (bar: PipelineBar) => bar.x + bar.width / 2 - CTRL_CELL_W / 2;
const cellRight = (bar: PipelineBar) => bar.x + bar.width / 2 + CTRL_CELL_W / 2;
/** The oval's output fork, up to WB and down to EX: 5 right of the
 * Register File's edge (465; the fork ends at y=195, above its top at 200),
 * leaving a 12-unit run into ID/EX's cells (left edge 482) for the
 * arrowheads. */
const CTRL_FORK_X = 470;
/** ID/EX's cells start here so EX's centre is 195 — as low as the EX line
 * can run above the ALU's top-left corner (200) — putting WB at 143 and M
 * at 169 (the oval's height). */
const CTRL_IDEX_TOP = 130;
/** EX/MEM's and MEM/WB's cells: WB centred at 223, M at 249. The top (210)
 * is MUX 4's label box's bottom edge. */
const CTRL_LOW_TOP = 210;
const cellMid = (top: number, i: number) => top + CTRL_CELL_H * i + CTRL_CELL_H / 2;
const CTRL_WB1_Y = cellMid(CTRL_IDEX_TOP, 0); // 143
const CTRL_M1_Y = cellMid(CTRL_IDEX_TOP, 1); // 169
const CTRL_EX1_Y = cellMid(CTRL_IDEX_TOP, 2); // 195
const CTRL_WB2_Y = cellMid(CTRL_LOW_TOP, 0); // 223
const CTRL_M2_Y = cellMid(CTRL_LOW_TOP, 1); // 249
/** M's lane across EX, 7 below the branch shifter's bottom (170): M leaves
 * its cell at 169 and steps down to it right after ID/EX. */
const CTRL_M_LANE_Y = 177;
/** Where M steps down and WB steps up to the top lane, between ID/EX's
 * cells (right edge 512) and _LS's vertical (534). M's step is the inner
 * one so the two never cross. */
const CTRL_M_JOG_X = 517;
const CTRL_WB_JOG_X = 525;
/** Midway between PC+4 (y=45) and Add2's top (y=65), after shiftTop. */
const CTRL_TOP_LANE_Y = (45 + 65) / 2 + TOP_DY; // 85
const CTRL_EX_BUS_X = 580;
const CTRL_M_RISER_B = 700 + PIPELINE_OFFSET.MEM; // 919
/** Branch's riser: between MUX 4's label text (right edge ~881) and Jump's
 * (left edge ~905), entering the "Branch" line (y~165) from the right. */
const CTRL_BRANCH_X = 895;
const CTRL_BRANCH_Y = 165;
/** isZero: leaves the ALU's right edge (x=759) level with its "isZero?"
 * label (y~281), passes through EX/MEM below its cells (bottom 262), and
 * rises at x=870 — under the "isZero?" line of MUX 4's label, above Data
 * Memory (top 300) — into that line from below. */
const CTRL_ZERO_Y = 281;
const CTRL_ZERO_X = 870;
/** MemRead's drop: down the right-hand side of Data Memory (right 969),
 * clear of both the isZero riser and MEM/WB (998). */
const CTRL_MEMREAD_X = 980;
const CTRL_MEMTOREG_X = 1100; // between MUX 3 (right 1073) and WD_'s vertical (1113)
const CTRL_REGWRITE_X = 850 + WB + 15; // 1128, 15 right of WD_'s vertical
const CTRL_BOTTOM_Y = 590 + BOTTOM_DY + 14; // 610, 14 under LS_MUX5
/** RegWrite's climb from the bottom lane: midway between Sign Extend's
 * right tip (465) and the bases of the arrowheads entering ID/EX (~479). */
const CTRL_REGWRITE_UP_X = 472;

export const PIPELINE_CONTROL_OVAL = { cx: 235 + ID_OFFSET, cy: CTRL_M1_Y, rx: 42, ry: 18 };

/** Opcode field -> Control. Always drawn; lit with the instruction in ID. */
export const PIPELINE_CONTROL_INPUT: WireSegment = {
  ...poly([CTRL_FIELD_RIGHT, CTRL_M1_Y, PIPELINE_CONTROL_OVAL.cx - PIPELINE_CONTROL_OVAL.rx, CTRL_M1_Y], true),
  stage: "ID",
};

export interface ControlCell {
  label: "WB" | "M" | "EX";
  x: number;
  y: number;
  width: number;
  height: number;
  /** Flow distance at which the incoming control line reaches the cell. */
  at: number;
}

export interface ControlWire {
  key: string;
  d: string;
  /** Drawn length, hops included. */
  length: number;
  /** Flow distance from the oval at which this line starts. */
  start: number;
  /** Arrowhead triangle path, drawn separately so it can appear only when
   * the line's drawing reaches it. */
  arrowD: string;
}

interface ControlWireSpec {
  key: string;
  pts: number[];
  /** The line this one branches off (or continues from, through a
   * pipeline-register cell). Omitted for lines leaving the oval. */
  from?: string;
  /** Crossings with other control lines, as [x, y] on a horizontal run. */
  hops?: [number, number][];
}

const CTRL_ARROW_LEN = 8;
const CTRL_ARROW_HALF = 3.5;
const HOP_R = 5;

const CONTROL_WIRE_SPECS: ControlWireSpec[] = [
  // Oval -> ID/EX's WB, M, EX cells.
  { key: "oval-m", pts: [PIPELINE_CONTROL_OVAL.cx + PIPELINE_CONTROL_OVAL.rx, CTRL_M1_Y, cellLeft(ctrlIdEx), CTRL_M1_Y] },
  { key: "oval-wb", from: "oval-m", pts: [CTRL_FORK_X, CTRL_M1_Y, CTRL_FORK_X, CTRL_WB1_Y, cellLeft(ctrlIdEx), CTRL_WB1_Y] },
  { key: "oval-ex", from: "oval-m", pts: [CTRL_FORK_X, CTRL_M1_Y, CTRL_FORK_X, CTRL_EX1_Y, cellLeft(ctrlIdEx), CTRL_EX1_Y] },
  // EX: ALUctrl, then the bus down to ALUSrc and RegDst.
  { key: "ex-aluctrl", from: "oval-ex", pts: [cellRight(ctrlIdEx), CTRL_EX1_Y, 681, CTRL_EX1_Y] },
  { key: "ex-alusrc", from: "ex-aluctrl", pts: [CTRL_EX_BUS_X, CTRL_EX1_Y, CTRL_EX_BUS_X, 450, 591, 450] },
  { key: "ex-regdst", from: "ex-alusrc", pts: [CTRL_EX_BUS_X, 450, CTRL_EX_BUS_X, 496, 631, 496] },
  // ID/EX -> EX/MEM: WB over the top band, M straight along 177.
  {
    key: "wb-exmem",
    from: "oval-wb",
    pts: [
      cellRight(ctrlIdEx), CTRL_WB1_Y,
      CTRL_WB_JOG_X, CTRL_WB1_Y,
      CTRL_WB_JOG_X, CTRL_TOP_LANE_Y,
      cellLeft(ctrlExMem) - 12, CTRL_TOP_LANE_Y,
      cellLeft(ctrlExMem) - 12, CTRL_WB2_Y,
      cellLeft(ctrlExMem), CTRL_WB2_Y,
    ],
  },
  {
    key: "m-exmem",
    from: "oval-m",
    pts: [
      cellRight(ctrlIdEx), CTRL_M1_Y,
      CTRL_M_JOG_X, CTRL_M1_Y,
      CTRL_M_JOG_X, CTRL_M_LANE_Y,
      cellLeft(ctrlExMem) - 23, CTRL_M_LANE_Y,
      cellLeft(ctrlExMem) - 23, CTRL_M2_Y,
      cellLeft(ctrlExMem), CTRL_M2_Y,
    ],
  },
  // MEM: M fans out to Jump, MemWrite, Branch, MemRead.
  {
    key: "m-jump",
    from: "m-exmem",
    pts: [cellRight(ctrlExMem), CTRL_M2_Y, CTRL_M_RISER_B, CTRL_M2_Y, CTRL_M_RISER_B, 185],
    hops: [[CTRL_ZERO_X, CTRL_M2_Y]],
  },
  { key: "m-memwrite", from: "m-jump", pts: [CTRL_M_RISER_B, CTRL_M2_Y, CTRL_M_RISER_B, 269] },
  { key: "m-branch", from: "m-jump", pts: [CTRL_BRANCH_X, CTRL_M2_Y, CTRL_BRANCH_X, CTRL_BRANCH_Y, 883, CTRL_BRANCH_Y] },
  { key: "m-memread", from: "m-jump", pts: [CTRL_M_RISER_B, CTRL_M2_Y, CTRL_MEMREAD_X, CTRL_M2_Y, CTRL_MEMREAD_X, 516, 946, 516] },
  // isZero: ALU -> EX/MEM (through the register's body, like the ALU
  // result) -> "isZero?" under MUX 4. It starts when the flow reaches the
  // ALU (the end of the ALUctrl line).
  { key: "zero-exmem", from: "ex-aluctrl", pts: [550 + PIPELINE_OFFSET.EX, CTRL_ZERO_Y, ctrlExMem.x, CTRL_ZERO_Y] },
  { key: "zero-mux4", from: "zero-exmem", pts: [ctrlExMem.x + ctrlExMem.width, CTRL_ZERO_Y, CTRL_ZERO_X, CTRL_ZERO_Y, CTRL_ZERO_X, 202] },
  // EX/MEM -> MEM/WB, hopping M's two risers.
  {
    key: "wb-memwb",
    from: "wb-exmem",
    pts: [cellRight(ctrlExMem), CTRL_WB2_Y, cellLeft(ctrlMemWb), CTRL_WB2_Y],
    hops: [
      [CTRL_ZERO_X, CTRL_WB2_Y],
      [CTRL_BRANCH_X, CTRL_WB2_Y],
      [CTRL_M_RISER_B, CTRL_WB2_Y],
    ],
  },
  // WB: RegWrite all the way back along the bottom; MemToReg off it.
  {
    key: "wb-regwrite",
    from: "wb-memwb",
    pts: [
      cellRight(ctrlMemWb), CTRL_WB2_Y,
      CTRL_REGWRITE_X, CTRL_WB2_Y,
      CTRL_REGWRITE_X, CTRL_BOTTOM_Y,
      CTRL_REGWRITE_UP_X, CTRL_BOTTOM_Y,
      CTRL_REGWRITE_UP_X, 455,
      447, 455,
    ],
  },
  { key: "wb-memtoreg", from: "wb-regwrite", pts: [CTRL_MEMTOREG_X, CTRL_WB2_Y, CTRL_MEMTOREG_X, 560, 1090, 560] },
];

/** Builds one control line's path: the polyline with its last run trimmed
 * under the arrowhead, hops inserted as upward half-circles, plus the
 * arrowhead triangle and the drawn length. */
function buildControlPath(pts: number[], hops: [number, number][]): { d: string; length: number; arrowD: string } {
  const n = pts.length;
  const tx = pts[n - 2], ty = pts[n - 1];
  const dx = Math.sign(tx - pts[n - 4]), dy = Math.sign(ty - pts[n - 3]);
  const trimmed = pts.slice();
  trimmed[n - 2] = tx - dx * (CTRL_ARROW_LEN - 3);
  trimmed[n - 1] = ty - dy * (CTRL_ARROW_LEN - 3);

  let d = `M ${trimmed[0]} ${trimmed[1]}`;
  let length = 0;
  for (let i = 2; i < n; i += 2) {
    const x0 = trimmed[i - 2], y0 = trimmed[i - 1], x1 = trimmed[i], y1 = trimmed[i + 1];
    const sx = Math.sign(x1 - x0);
    const onRun = hops
      .filter(([hx, hy]) => y0 === y1 && hy === y0 && (hx - x0) * (hx - x1) < 0)
      .sort((a, b) => sx * (a[0] - b[0]));
    for (const [hx] of onRun) {
      d += ` L ${hx - sx * HOP_R} ${y0} A ${HOP_R} ${HOP_R} 0 0 ${sx > 0 ? 1 : 0} ${hx + sx * HOP_R} ${y0}`;
      length += Math.PI * HOP_R - 2 * HOP_R;
    }
    d += ` L ${x1} ${y1}`;
    length += Math.abs(x1 - x0) + Math.abs(y1 - y0);
  }

  const bx = tx - dx * CTRL_ARROW_LEN, by = ty - dy * CTRL_ARROW_LEN;
  const px = -dy * CTRL_ARROW_HALF, py = dx * CTRL_ARROW_HALF;
  const arrowD = `M ${tx} ${ty} L ${bx + px} ${by + py} L ${bx - px} ${by - py} Z`;
  return { d, length, arrowD };
}

/** Distance along an axis-aligned polyline to its point nearest (x, y),
 * plus the gap from that point to (x, y) — how far the flow has travelled
 * when a line branching (or continuing through a cell) at (x, y) starts. */
function distanceAlong(pts: number[], x: number, y: number): number {
  let bestGap = Infinity, bestAlong = 0, run = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2], y0 = pts[i - 1], x1 = pts[i], y1 = pts[i + 1];
    const cx = Math.min(Math.max(x, Math.min(x0, x1)), Math.max(x0, x1));
    const cy = Math.min(Math.max(y, Math.min(y0, y1)), Math.max(y0, y1));
    const gap = Math.abs(x - cx) + Math.abs(y - cy);
    if (gap < bestGap) {
      bestGap = gap;
      bestAlong = run + Math.abs(cx - x0) + Math.abs(cy - y0);
    }
    run += Math.abs(x1 - x0) + Math.abs(y1 - y0);
  }
  return bestAlong + bestGap;
}

const controlWireStart = new Map<string, number>();
export const PIPELINE_CONTROL_WIRES: ControlWire[] = CONTROL_WIRE_SPECS.map((spec) => {
  let start = 0;
  if (spec.from) {
    const parent = CONTROL_WIRE_SPECS.find((s) => s.key === spec.from)!;
    start = controlWireStart.get(spec.from)! + distanceAlong(parent.pts, spec.pts[0], spec.pts[1]);
  }
  controlWireStart.set(spec.key, start);
  return { key: spec.key, start, ...buildControlPath(spec.pts, spec.hops ?? []) };
});

const controlWireEnd = (key: string) => {
  const w = PIPELINE_CONTROL_WIRES.find((c) => c.key === key)!;
  return w.start + w.length;
};
const controlCell = (bar: PipelineBar, top: number, i: number, label: ControlCell["label"], enteredBy: string): ControlCell => ({
  label,
  x: cellLeft(bar),
  y: top + CTRL_CELL_H * i,
  width: CTRL_CELL_W,
  height: CTRL_CELL_H,
  at: controlWireEnd(enteredBy),
});

/** The control portion of each pipeline register, as in the textbook:
 * ID/EX holds WB, M and EX; EX/MEM holds WB and M; MEM/WB holds WB. */
export const PIPELINE_CONTROL_CELLS: ControlCell[] = [
  controlCell(ctrlIdEx, CTRL_IDEX_TOP, 0, "WB", "oval-wb"),
  controlCell(ctrlIdEx, CTRL_IDEX_TOP, 1, "M", "oval-m"),
  controlCell(ctrlIdEx, CTRL_IDEX_TOP, 2, "EX", "oval-ex"),
  controlCell(ctrlExMem, CTRL_LOW_TOP, 0, "WB", "wb-exmem"),
  controlCell(ctrlExMem, CTRL_LOW_TOP, 1, "M", "m-exmem"),
  controlCell(ctrlMemWb, CTRL_LOW_TOP, 0, "WB", "wb-memwb"),
];