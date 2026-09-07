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
}

function poly(points: number[], arrow: boolean): WireSegment {
  const [x0, y0, ...rest] = points;
  let d = `M ${x0} ${y0}`;
  for (let i = 0; i < rest.length; i += 2) d += ` L ${rest[i]} ${rest[i + 1]}`;
  return { d, arrow };
}

/** A ~180° radius-5 semicircular connector between two points 10 units
 * apart — see the header comment on why this approximates the original's
 * Konva.Arc calls rather than reproducing their exact angle/rotation. */
function loop(x0: number, y0: number, x1: number, y1: number): WireSegment {
  const r = 5;
  return { d: `M ${x0} ${y0} A ${r} ${r} 0 1 1 ${x1} ${y1}`, arrow: false };
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
  _MWD: poly([360, 420, 360, 500, 650, 500], true),
  RES_: poly([550, 350, 600, 350], false),
  _MADDR: poly([600, 350, 650, 350], true),
  MUX3_: poly([600, 350, 600, 460], false),
  _MUX3_: loop(600, 460, 600, 470),
  _MUX3: poly([600, 470, 600, 500, 780, 500], true),
  MRD_MUX3: poly([750, 465, 780, 465], true),
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