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
  _ADD1: poly([200, 30, 220, 30], true),
  _IADDR: poly([200, 30, 200, 115, 115, 115], true),
  ADD1_: poly([260, 45, 400, 45], false),
  _MUX4: poly([400, 45, 780, 45], true),
  _ADD2: poly([400, 45, 400, 75, 500, 75], true),
  LS_ADD2: poly([375, 115, 500, 115], true),
  ADD2_MUX4: poly([540, 95, 780, 95], true),
  MUX4_PC: poly([810, 70, 850, 70, 850, 5, 150, 5, 150, 15], true),
  EXT_: poly([300, 500, 325, 500, 325, 415], false),
  _LS: poly([325, 415, 325, 140], true),
  _1MUX2: poly([325, 415, 390, 415], true),
  RD2_: poly([300, 375, 320, 375], false),
  _RD2_: loop(320, 375, 330, 375),
  _RD2: poly([330, 375, 360, 375], false),
  _2MUX2: poly([360, 375, 390, 375], true),
  MUX2_ALU2: poly([420, 395, 450, 395], true),
  MWD_: poly([360, 375, 360, 410], false),
  _MWD_: loop(360, 410, 360, 420),
  _MWD: poly([360, 420, 360, 465, 650, 465], true),
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
  RD2_MWD: ["RD2_", "_RD2_", "_RD2", "MWD_", "_MWD_", "_MWD"],
  RES_MADDR: ["RES_", "_MADDR"],
  RES_MUX3: ["RES_", "MUX3_", "_MUX3_", "_MUX3"],
  MRD_MUX3: ["MRD_MUX3"],
  ADD1_MUX4: ["ADD1_", "_MUX4"],
  ADD2_MUX4: ["ADD2_MUX4"],
  MUX4_PC: ["MUX4_PC"],
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