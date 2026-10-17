/**
 * SVG port of processor.js's Konva canvas. Box positions/sizes/fills and
 * every text label's position are derived directly from processor.js's
 * elem$*() functions (same 900×580 coordinate space) — not eyeballed.
 *
 * TWO REAL BUGS FIXED FROM THE FIRST VERSION OF THIS FILE (found when the
 * rendered labels turned out to be visibly misplaced relative to the
 * original — worth recording so they don't come back):
 *
 *   1. The six instruction-field boxes (opcode/rs/rt/rd/shamt/funct):
 *      the original is a 70×20 Konva.Rect rotated 90° around its own (x,y)
 *      origin. The first version of this file approximated that as a
 *      plain vertical rectangle with made-up dimensions instead of
 *      actually computing the rotated bounding box — wrong size AND
 *      wrong position. Fixed by computing the real rotated bbox (verified
 *      programmatically, not just by hand): a 90° rotation of an axis-
 *      aligned box just swaps width/height and repositions the origin,
 *      so each field is a 20×70 vertical strip at x=60, tiling exactly
 *      from y=150 to y=570 with no gaps.
 *
 *   2. Konva.Ellipse's `x`/`y` is its CENTER (unlike Konva.Rect, where
 *      x/y is the top-left corner) — the Sign-Extend and Left-Shift
 *      ellipses were built treating x/y as top-left, which shifted both
 *      ellipses down-right by exactly half their width/height, and every
 *      label positioned relative to them inherited the same offset.
 *
 * General approach for everything else: rather than hand-placing each
 * `<text>` element's SVG x/y/anchor (which is what produced the two bugs
 * above — this is genuinely easy to get subtly wrong by eye), every label
 * is expressed as the same (x, y, width, height, align, verticalAlign)
 * box Konva.Text used, fed through a single KonvaLabel that computes the
 * SVG anchor/position from that box — one place to get the box-model
 * math right instead of N places to get it wrong slightly differently
 * each time. Rotated labels (the instruction fields) reuse the exact
 * same box-model math and are wrapped in an SVG `rotate(angle, x, y)`
 * transform around the original Konva origin point, which is the direct
 * SVG equivalent of Konva's own rotate-around-origin behavior.
 *
 * Responsive by construction — unchanged from before: fixed coordinate
 * system inside one `viewBox` (originally 900×580, matching every
 * coordinate ported from processor.js; bumped to 900×620 to actually
 * contain the new jump shift-left ellipse sitting at cy=590 below that —
 * see DatapathDiagram.css's header comment, which restates the exact
 * value and needs updating in step with this one); the SVG's on-page size
 * is pure CSS (DatapathDiagram.css), no JS resize handling.
 */
import type { CSSProperties } from "react";
import type { Int32Bits } from "../lib/Numbers/int32";
import * as bit from "../lib/Numbers/bit";
import type { WireId } from "../lib/mips-machine/datapath";
import {
  SEGMENTS,
  LEGACY_SEGMENTS,
  aluPath,
  activeSegmentKeys,
  pipelineSegment,
  PIPELINE_BARS,
  PIPELINE_OFFSET,
  PIPELINE_VIEW_WIDTH,
  PIPELINE_JADDR_LABEL,
  PIPELINE_IF,
  PIPELINE_WB_WR,
  PIPELINE_REGDST_MUX,
  PIPELINE_VIEW_HEIGHT,
  PIPELINE_BOTTOM_DY,
  PIPELINE_BRANCH_LS,
  PIPELINE_TOP_MUX_DX,
  PIPELINE_TOP_DY,
  PIPELINE_VIEW_Y,
  PIPELINE_CONTROL_OVAL,
  PIPELINE_CONTROL_INPUT,
  PIPELINE_CONTROL_WIRES,
  PIPELINE_CONTROL_CELLS,
  type Stage,
  type WireSegment,
} from "../lib/mips-machine/datapathWires";
import {
  HAZARD_MUX6,
  HAZARD_MUX7,
  HAZARD_MUX2,
  HAZARD_FWDOP1_LABEL,
  HAZARD_FWDOP2_LABEL,
  HAZARD_ALUSRC_LABEL,
  HAZARD_ALU1_IN0,
  HAZARD_MUX6_OUT,
  HAZARD_RD2_IN0,
  HAZARD_MUX7_OUT,
  HAZARD_MUX7_TO_MUX2,
  HAZARD_IMM_MUX2,
  HAZARD_STORE_EX,
  HAZARD_STORE_MEM,
  FWD_EXMEM,
  FWD_MEMWB,
  FWD_EXMEM_TAP,
  FWD_MEMWB_TAP,
} from "../lib/mips-machine/datapathHazards";
import { ctrlValue, isKnownOp } from "../lib/mips-machine/ctrl";
import {
  hazardX,
  hazardDx,
  remapPath,
  HAZARD_VIEW_WIDTH,
  HAZARD_BAR_TOP,
  HAZARD_DROPPED_CONTROL_WIRES,
  HAZARD_CONTROL_WIRE_REPLACEMENTS,
  BR_MUX4,
  BR_MUX5,
  BR_JUMP_LABEL,
  BR_JUMP_LS,
  BR_JADDR_LABEL,
  BR_LS,
  BR_ADD,
  BR_FWDRD1,
  BR_FWDRD2,
  BR_FWDRD1_LABEL,
  BR_FWDRD2_LABEL,
  BR_CMP,
  BR_PC4_TO_MUX4,
  BR_PC4_LATCH_IF,
  BR_PC4_LATCH_ID,
  BR_MUX4_TO_MUX5,
  BR_MUX4_TO_PC,
  BR_MUX5_TO_PC,
  BR_JADDR_TO_LS,
  BR_LS_TO_MUX5,
  BR_IMM_RISER,
  BR_LS_TO_ADD,
  BR_TARGET,
  BR_CMP_TO_MUX4,
  BR_RD1_TO_FWD,
  BR_RD2_TO_FWD,
  BR_FWD1_TO_CMP,
  BR_FWD2_TO_CMP,
  BR_TAPS,
  BR_FWD_EXMEM,
  BR_FWD_MEMWB,
  BR_FWD_MEMWB_TAP,
} from "../lib/mips-machine/datapathBranch";
import { isBranchOp, isJumpOp } from "../lib/mips-machine/pipeline";
import { FWD_EX_MEM, FWD_MEM_WB, FWD_NONE, type ForwardingSignals, type BranchForwardingSignals } from "../lib/mips-machine/forwarding";
import type { PipelineSlotView } from "../lib/mips-machine/pipeline";
import type { CycleStage, MachineState } from "../lib/mips-machine/machineState";
import "./DatapathDiagram.css";

/** Which of the two features added on top of processor.js's original
 * 8-instruction datapath should actually render. Purely a presentation
 * toggle — execStage() (interpreter.ts) always computes shifts/jumps
 * correctly regardless of these; see LEGACY_SEGMENTS's header comment in
 * datapathWires.ts for why that separation matters. Both default to
 * true, so any caller that doesn't pass `features` at all gets today's
 * behavior unchanged. */
export interface DatapathFeatures {
  shift?: boolean;
  jump?: boolean;
  /** Insert the IF/ID, ID/EX, EX/MEM, MEM/WB pipeline-register bars,
   * spreading the stages apart to make room (see the "Pipelined layout"
   * section of datapathWires.ts). Defaults to false. */
  pipeline?: boolean;
  /** Pipeline mode only: draw the hazard hardware — in EX, MUX 6 before
   * ALUop1, MUX 7 on the rt line (feeding MUX 2 and the store data) and
   * the dotted EX/MEM and MEM/WB forwarding wires (datapathHazards.ts); and
   * the early-branch datapath, with branches resolved in ID and MUX 4/5 in
   * IF (datapathBranch.ts, which also re-lays out the whole diagram to make
   * room). Ignored when `pipeline` is off. Defaults to false. */
  hazards?: boolean;
}

export interface DatapathDiagramProps {
  /** Which wires are lit for the current micro-step. */
  activeWires: WireId[];
  /** Optional — when provided, live values (decoded instruction fields,
   * ALU result) render as text overlays. Omit for just the static
   * schematic. */
  state?: MachineState | null;
  /** Optional — toggles the shift/jump artwork independently. Omitted
   * fields and the whole prop default to shown (both true). */
  features?: DatapathFeatures;
  /** Pipeline mode only: the instructions in flight this cycle
   * (useMachineHistory's pipelineSlots). Each lights the pieces of its own
   * wiring that lie in the stage region it occupies, in its own colour
   * (PIPELINE_WIRE_COLOURS[seq % 5]). activeWires is not used in pipeline
   * mode. */
  pipelineSlots?: PipelineSlotView[];
  /** Hazards mode only: this cycle's Fwdop1/Fwdop2 (forwarding.ts's
   * computeForwarding over the same pipelineSlots), or null when nothing
   * is in EX. */
  forwarding?: ForwardingSignals | null;
  /** Pipeline mode only: stages holding a stall's bubble this cycle
   * (useMachineHistory's pipelineBubbles), each labelled "(bubble)". */
  bubbles?: CycleStage[];
  /** Hazards mode only: this cycle's FwdRD1/FwdRD2 for a branch in ID
   * (forwarding.ts's computeBranchForwarding), or null. */
  branchForwarding?: BranchForwardingSignals | null;
}

/** Where to label a bubble, per stage, in pipelined coordinates: inside the
 * Register File under its title (a flushed instruction), inside the ALU
 * under its name, inside Data Memory between its Address and Read Data
 * labels, and above MUX 3. A bubble in IF can't happen (a stall holds IF
 * instead). */
const BUBBLE_LABEL_AT: Partial<Record<CycleStage, { x: number; y: number }>> = {
  D: { x: 200 + PIPELINE_OFFSET.ID + 50, y: 237 },
  A: { x: 450 + PIPELINE_OFFSET.EX + 50, y: 340 },
  M: { x: 650 + PIPELINE_OFFSET.MEM + 50, y: 400 },
  R: { x: 795 + PIPELINE_OFFSET.WB, y: 410 },
};

/** Which stage region of the pipelined diagram each micro-step lights. */
const REGION_OF_STEP: Record<string, Stage> = { F: "IF", D: "ID", A: "EX", M: "MEM", R: "WB" };

/** Pipeline mode's wire colours, by instruction: the 1st instruction
 * executed is red, the 2nd blue, then green, orange, purple, and the 6th
 * red again — so at most one instruction in flight has each colour. Red
 * is the single-cycle highlight colour (.dp-wire-active). */
export const PIPELINE_WIRE_COLOURS = ["#d0342c", "#1f6fd6", "#1e9e46", "#e67e00", "#8e44ad"] as const;

function fieldBits(inst: Int32Bits, idx: number, len: number): string {
  return bit.get(inst, idx, len).join("");
}

// ---- Text: a single, data-driven box model instead of hand-placed <text>
// elements — see the header comment for why. Mirrors Konva.Text's
// (x, y, width, height, align, verticalAlign) exactly; `rotate` wraps the
// result in the SVG equivalent of Konva's rotate-around-(x,y) behavior.
interface TextSpec {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  align: "left" | "center" | "right";
  vAlign?: "top" | "middle";
  rotate?: number;
  bold?: boolean;
  italic?: boolean;
  fill?: string;
  fontSize?: number;
}

function KonvaLabel({ spec }: { spec: TextSpec }) {
  const { text, x, y, width, height, align, vAlign = "top", rotate, bold, italic, fill = "black", fontSize = 12 } = spec;
  const lines = text.split("\n");
  const lineHeight = fontSize * 1.15;
  const blockHeight = lines.length * lineHeight;
  const anchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
  const tx = align === "left" ? x : align === "right" ? x + width : x + width / 2;
  const startY = vAlign === "middle" ? y + height / 2 - blockHeight / 2 : y;

  const node = (
    <text x={tx} textAnchor={anchor} fill={fill} fontSize={fontSize} fontWeight={bold ? "bold" : undefined} fontStyle={italic ? "italic" : undefined}>
      {lines.map((line, i) => (
        <tspan key={i} x={tx} y={startY + i * lineHeight + fontSize * 0.85}>
          {line}
        </tspan>
      ))}
    </text>
  );

  return rotate ? <g transform={`rotate(${rotate} ${x} ${y})`}>{node}</g> : node;
}

function KonvaLabels({ specs }: { specs: TextSpec[] }) {
  return (
    <>
      {specs.map((spec, i) => (
        <KonvaLabel key={i} spec={spec} />
      ))}
    </>
  );
}

// A small static blue arrow tick pointing into a component — decorative
// control-signal indicators (RegDst/ALUSrc/MemToReg/Branch/ALUctrl/
// MemWrite/MemRead), always the same color, never affected by
// activeWires. Ported from elem$*'s `new Konva.Line({ points: [...],
// stroke: "blue", ... })` calls.
function CtrlTick({ x, y1, y2 }: { x: number; y1: number; y2: number }) {
  return <line x1={x} y1={y1} x2={x} y2={y2} className="dp-ctrl-line" markerEnd="url(#dp-arrow-blue)" />;
}

/** How fast the hover animation's control lines flow out of the Control
 * oval, in diagram units per second. The longest line (RegWrite, ~2100
 * units from the oval) takes about 1.4 s; everything else is drawn within
 * about 0.6 s. */
const CONTROL_FLOW_SPEED = 1500;

const flowTime = (distance: number) => `${(distance / CONTROL_FLOW_SPEED).toFixed(3)}s`;
/** CSS custom properties driving one overlay element's hover transition
 * (see DatapathDiagram.css): --d is when the flow reaches it, --t how long
 * it takes to draw. */
const flowVars = (delay: number, duration = 0) => ({ "--d": flowTime(delay), "--t": flowTime(duration) }) as CSSProperties;

/**
 * Pipeline mode's Control unit: the oval (always shown) plus a hover
 * overlay with every control line and the WB/M/EX cells on the pipeline
 * registers (geometry: the "Control unit" section of datapathWires.ts).
 *
 * The show/hide is pure CSS (.dp-control:hover / :focus-visible) rather
 * than React state, so it needs no re-render and works in the static
 * preview too. The overlay ignores the pointer, so only the oval itself
 * triggers it. On hover each line draws from its start to its end
 * (stroke-dashoffset over pathLength=1), starting when the flow from the
 * oval reaches it, so the signals visibly spread out stage by stage; cells
 * and arrowheads appear as the flow reaches them. Leaving the oval fades
 * the whole overlay out.
 *
 * Every line is drawn over a white casing, so where it crosses a black
 * data wire it reads as passing over it without needing a hop.
 */
function ControlUnit({ hazards }: { hazards: boolean }) {
  // Hazards mode: everything goes through the early-branch remap, and the
  // lines to the old Branch/Jump/isZero labels after EX/MEM are dropped or
  // trimmed (see HAZARD_DROPPED_CONTROL_WIRES).
  const X = hazards ? hazardX : (x: number) => x;
  const P = hazards ? remapPath : (d: string) => d;
  const oval = { ...PIPELINE_CONTROL_OVAL, cx: X(PIPELINE_CONTROL_OVAL.cx) };
  const wires = hazards
    ? PIPELINE_CONTROL_WIRES.filter((w) => !HAZARD_DROPPED_CONTROL_WIRES.has(w.key)).map((w) => ({
        ...w,
        ...(HAZARD_CONTROL_WIRE_REPLACEMENTS[w.key] ?? {}),
      }))
    : PIPELINE_CONTROL_WIRES;
  return (
    <g className="dp-control" tabIndex={0} aria-label="Control unit: hover or focus to show its control signals">
      <ellipse cx={oval.cx} cy={oval.cy} rx={oval.rx} ry={oval.ry} className="dp-box dp-control-oval" />
      <KonvaLabel
        spec={{ text: "Control", x: oval.cx - oval.rx, y: oval.cy - oval.ry, width: 2 * oval.rx, height: 2 * oval.ry, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" }}
      />
      <g className="dp-ctrl-overlay" aria-hidden="true">
        {wires.map((w) => (
          <path key={`${w.key}-halo`} d={P(w.d)} pathLength={1} className="dp-ctrl-draw dp-ctrl-halo" style={flowVars(w.start, w.length)} />
        ))}
        {wires.map((w) => (
          <path key={w.key} d={P(w.d)} pathLength={1} className="dp-ctrl-draw dp-ctrl-wire" style={flowVars(w.start, w.length)} />
        ))}
        {wires.map(
          (w) =>
            w.arrowD && (
              <path key={`${w.key}-arrow`} d={P(w.arrowD)} className="dp-ctrl-pop dp-ctrl-arrowhead" style={flowVars(w.start + w.length)} />
            ),
        )}
        {PIPELINE_CONTROL_CELLS.map((c) => (
          <g key={`${c.x}-${c.label}`} className="dp-ctrl-pop" style={flowVars(c.at)}>
            <rect x={X(c.x)} y={c.y} width={c.width} height={c.height} className="dp-ctrl-cell" />
            <KonvaLabel spec={{ text: c.label, x: X(c.x), y: c.y, width: c.width, height: c.height, align: "center", vAlign: "middle", bold: true, fontSize: 11, fill: "#2c5aa0" }} />
          </g>
        ))}
      </g>
    </g>
  );
}

export function DatapathDiagram({ activeWires, state, features, pipelineSlots, forwarding, bubbles, branchForwarding }: DatapathDiagramProps) {
  const shift = features?.shift ?? true;
  const jump = features?.jump ?? true;
  const pipeline = features?.pipeline ?? false;
  // Forwarding hardware only exists in the pipelined drawing.
  const hazards = pipeline && (features?.hazards ?? false);
  const fwd = hazards ? (forwarding ?? null) : null;
  const brFwd = hazards ? (branchForwarding ?? null) : null;

  // Hazards mode re-lays out the pipelined diagram for the early-branch
  // hardware (datapathBranch.ts): X/P remap x coordinates and paths, and
  // hzShift moves a component group anchored at pipelined x. All three are
  // the identity otherwise.
  const X = (x: number) => (hazards ? hazardX(x) : x);
  const P = (d: string) => (hazards ? remapPath(d) : d);
  const hzShift = (anchorX: number) => (hazards ? `translate(${hazardDx(anchorX)} 0)` : undefined);

  // Per-stage horizontal shift for component groups. All zero when
  // pipelining is off, so the single-cycle layout is exactly as before.
  const stageShift = (stage: Stage) => (pipeline ? `translate(${PIPELINE_OFFSET[stage]} 0)` : undefined);
  const viewWidth = hazards ? HAZARD_VIEW_WIDTH : pipeline ? PIPELINE_VIEW_WIDTH : 900;
  const viewHeight = pipeline ? PIPELINE_VIEW_HEIGHT : 620;
  const regDstMux = PIPELINE_REGDST_MUX;
  // MUX 4 / MUX 5 move left to just after EX/MEM in pipeline mode.
  const topMuxShift = pipeline ? `translate(${PIPELINE_TOP_MUX_DX} ${PIPELINE_TOP_DY})` : undefined;
  const viewY = pipeline ? PIPELINE_VIEW_Y : 0;
  // Top-row components (PC, Add1) — also moved down by PIPELINE_TOP_DY.
  const ifShift = (dx: number) => (pipeline ? `translate(${dx} ${PIPELINE_TOP_DY})` : undefined);
  const im = PIPELINE_IF.im;

  // Remap SHAMT_ALU2 -> MUX2_ALU2 before computing active segments, so
  // turning the "Shift" toggle off makes a shift micro-step light the
  // ordinary ALUSrc-mux entry exactly the way it used to before this
  // artwork existed, instead of lighting a wire that's about to be hidden
  // (which would just make the ALU's second operand look permanently
  // dark for every shift instruction).
  //
  // Jump can't be remapped the same way — MUX4_PC isn't a real WireId
  // anymore (see LEGACY_SEGMENTS's header comment), so it can't flow
  // through activeSegmentKeys's WireId[]-typed input. Light it directly
  // whenever any of the real jump-path wires are lit.
  const litKeys = (wires: WireId[]): Set<string> => {
    const keys = activeSegmentKeys(shift ? wires : wires.map((w) => (w === "SHAMT_ALU2" ? "MUX2_ALU2" : w)));
    if (!jump && wires.some((w) => w === "MUX4_MUX5" || w === "LS_MUX5" || w === "MUX5_PC")) keys.add("MUX4_PC");
    return keys;
  };

  // Hazards mode: which forwarding paths are actually in use this cycle.
  // A Fwdop value only matters if the EX instruction actually uses that
  // register's value: Fwdop1 when ALUop1 is RD1 (RD1_ALU1); Fwdop2 when rt
  // goes to the ALU through MUX 2 (RD2_MUX2) or to Data Memory as store data
  // (MemWrite: sw/sb). For other I-types rt is the destination, not a
  // source, so their Fwdop2 is computed but unused.
  const exSlot = hazards ? pipelineSlots?.find((s) => s.stage === "A") : undefined;
  const exWires = exSlot?.wires ?? [];
  const usesRd1 = exWires.includes("RD1_ALU1");
  const usesRtAlu = exWires.includes("RD2_MUX2");
  const usesRtStore = !!exSlot && isKnownOp(exSlot.op) && ctrlValue("MemWrite", exSlot.op) === 1;
  const fwdA = fwd && usesRd1 ? fwd.fwdA : 0;
  const fwdB = fwd && (usesRtAlu || usesRtStore) ? fwd.fwdB : 0;

  // Single-cycle mode: a whole segment lights, red, when its wire is
  // active this micro-step.
  const active = pipeline ? new Set<string>() : litKeys(activeWires);
  // Pipeline mode: each stage region shows the instruction occupying it
  // this cycle — the pieces of that instruction's wiring in the region,
  // in that instruction's colour.
  const regionLit = new Map<Stage, { keys: Set<string>; wires: WireId[]; colour: number }>();
  if (pipeline) {
    for (const slot of pipelineSlots ?? []) {
      const region = REGION_OF_STEP[slot.stage];
      // Early branches: a branch or jump is finished once it leaves ID, and
      // passes through EX, MEM and WB as a no-op.
      if (hazards && (isBranchOp(slot.op) || isJumpOp(slot.op)) && region !== "IF" && region !== "ID") continue;
      // A forwarded operand doesn't come along its usual route from ID/EX,
      // so that route stays dark and the dotted wire lights instead. For rt
      // that's both of RD2's uses (ALU and store data): they share the run
      // from ID/EX into MUX 7.
      let lightWires = slot.wires;
      if (fwd && slot.seq === fwd.ex.seq) {
        lightWires = slot.wires.filter(
          (w) => !(w === "RD1_ALU1" && fwdA !== 0) && !((w === "RD2_MUX2" || w === "RD2_MWD") && fwdB !== 0),
        );
      }
      regionLit.set(region, {
        keys: litKeys(lightWires),
        wires: slot.wires,
        colour: slot.seq % PIPELINE_WIRE_COLOURS.length,
      });
    }
  }
  /** Colour index for one rendered piece of segment `key`, or null if
   * it's unlit. Single-cycle mode: 0 (red) for any piece of an active
   * segment. Pipeline mode: the colour of the instruction in the piece's
   * stage region, if that instruction uses this segment. */
  const pieceColour = (key: string, piece: { stage?: Stage }): number | null => {
    if (!pipeline) return active.has(key) ? 0 : null;
    const lit = piece.stage ? regionLit.get(piece.stage) : undefined;
    return lit && lit.keys.has(key) ? lit.colour : null;
  };
  const wireProps = (colour: number | null, arrow: boolean) => ({
    className: colour === null ? "dp-wire" : "dp-wire dp-wire-active",
    style: pipeline && colour !== null ? { stroke: PIPELINE_WIRE_COLOURS[colour] } : undefined,
    markerEnd: arrow
      ? `url(#${colour === null ? "dp-arrow" : pipeline ? `dp-arrow-p${colour}` : "dp-arrow-active"})`
      : undefined,
  });

  // Hazards mode colours. MUX 6's output carries the EX instruction's
  // ALUop1 whichever input is selected. Each dotted forwarding wire
  // carries the *producing* instruction's result, so it's drawn in that
  // instruction's colour: EX/MEM's is the instruction in MEM, MEM/WB's the
  // instruction in WB.
  const exColour = regionLit.get("EX")?.colour ?? null;
  const mux6OutColour = usesRd1 ? exColour : null;
  // MUX 7's output carries rt whichever input is selected: to MUX 2 when
  // the ALU uses it, and down to EX/MEM as store data (lit for every
  // instruction, matching the single-cycle view's RD2_MWD).
  const usesRtStoreLine = exWires.includes("RD2_MWD");
  const mux7OutColour = usesRtAlu || usesRtStoreLine ? exColour : null;
  const mux7ToMux2Colour = usesRtAlu ? exColour : null;
  const storeExColour = usesRtStoreLine ? exColour : null;
  const exMemColour = fwd?.exMem ? fwd.exMem.seq % PIPELINE_WIRE_COLOURS.length : null;
  const memWbColour = fwd?.memWb ? fwd.memWb.seq % PIPELINE_WIRE_COLOURS.length : null;
  const fwdWireProps = (colour: number | null, lit: boolean, arrow: boolean) => {
    const on = lit && colour !== null;
    return {
      className: on ? "dp-wire dp-fwd-wire dp-fwd-wire-active" : "dp-wire dp-fwd-wire",
      style: on ? { stroke: PIPELINE_WIRE_COLOURS[colour] } : undefined,
      markerEnd: arrow ? `url(#${on ? `dp-arrow-p${colour}` : "dp-arrow-fwd"})` : undefined,
    };
  };
  const forwardPaths = [
    { key: "exmem", wire: FWD_EXMEM, colour: exMemColour, sel: FWD_EX_MEM, tap: FWD_EXMEM_TAP },
    { key: "memwb", wire: FWD_MEMWB, colour: memWbColour, sel: FWD_MEM_WB, tap: FWD_MEMWB_TAP },
  ];

  // Segments to hide entirely when a feature is off, and — for jump only
  // — the legacy segment to substitute back in. Shift needs no
  // substitute: disabling it just means SHAMT_ALU2 never renders and
  // MUX2_ALU2 (already real artwork, never removed) carries on as before.
  const hiddenSegments = new Set<string>();
  if (!shift) hiddenSegments.add("SHAMT_ALU2");
  if (!jump) ["MUX4_MUX5", "JADDR_LS", "LS_MUX5", "MUX5_PC"].forEach((k) => hiddenSegments.add(k));
  // Hazards mode: the wires around MUX 2 are redrawn for the forwarding
  // layout (datapathHazards.ts): RD1 stops at MUX 6; RD2 stops at MUX 7,
  // whose output feeds MUX 2 and the store data line; the immediate runs
  // to MUX 2's new position.
  if (hazards) ["_ALU1", "_RD2", "_2MUX2", "MWD_", "_MWD_", "_MWD", "_1MUX2"].forEach((k) => hiddenSegments.add(k));
  // ...and the PC-update wiring is replaced by the early-branch version:
  // PC+4 no longer travels past ID, the branch adder and shifter move to ID,
  // and MUX 4/5 move to IF.
  if (hazards) {
    ["ADD1_", "_MUX4", "_ADD2", "LS_ADD2", "ADD2_MUX4", "MUX4_MUX5", "MUX5_PC", "MUX4_PC", "JADDR_LS", "LS_MUX5", "_LS"].forEach((k) =>
      hiddenSegments.add(k),
    );
  }
  // Pipeline mode's MEM/WB -> WR wire (see PIPELINE_WB_WR in
  // datapathWires.ts) lights during write-back, alongside WD.
  const wbLit = regionLit.get("WB");
  // ...and the opcode -> Control wire lights with whichever instruction is
  // in Decode (every instruction's opcode goes through Control).
  const controlInColour = regionLit.get("ID")?.colour ?? null;
  const wbWrColour = wbLit && wbLit.wires.includes("MUX3_WD") ? wbLit.colour : null;
  const segmentsToRender = jump ? SEGMENTS : { ...SEGMENTS, ...LEGACY_SEGMENTS };

  // A load-use stall this cycle: PC and IF/ID aren't written (PCWrite =
  // IF/IDWrite = 0), so both are drawn as held.
  const held = pipeline && (pipelineSlots ?? []).some((s) => s.stalled);

  // The instruction-field column shows the instruction being decoded — in
  // pipeline mode, whichever one is in Decode this cycle.
  const inst = pipeline ? (pipelineSlots?.find((s) => s.stage === "D")?.state.inst ?? null) : (state?.inst ?? null);

  const fieldRows: { name: string; idx: number; len: number; y: number }[] = [
    { name: "opcode", idx: 26, len: 6, y: 150 },
    { name: "rs", idx: 21, len: 5, y: 220 },
    { name: "rt", idx: 16, len: 5, y: 290 },
    { name: "rd", idx: 11, len: 5, y: 360 },
    { name: "shamt", idx: 6, len: 5, y: 430 },
    { name: "funct", idx: 0, len: 6, y: 500 },
  ];

  // Hazards-mode wires drawn in place of hidden segments. Pieces that a
  // segment key fully describes take their colour the usual way; the rest
  // were coloured above.
  const hazardWires: { key: string; seg: WireSegment; colour: number | null }[] = hazards
    ? [
        { key: "alu1-in0", seg: HAZARD_ALU1_IN0, colour: pieceColour("_ALU1", HAZARD_ALU1_IN0) },
        { key: "mux6-out", seg: HAZARD_MUX6_OUT, colour: mux6OutColour },
        { key: "rd2-in0", seg: HAZARD_RD2_IN0, colour: pieceColour("_RD2", HAZARD_RD2_IN0) },
        { key: "mux7-out", seg: HAZARD_MUX7_OUT, colour: mux7OutColour },
        { key: "mux7-mux2", seg: HAZARD_MUX7_TO_MUX2, colour: mux7ToMux2Colour },
        { key: "imm-mux2", seg: HAZARD_IMM_MUX2, colour: pieceColour("_1MUX2", HAZARD_IMM_MUX2) },
        { key: "store-ex", seg: HAZARD_STORE_EX, colour: storeExColour },
        { key: "store-mem", seg: HAZARD_STORE_MEM, colour: pieceColour("_MWD", HAZARD_STORE_MEM) },
      ]
    : [];
  const muxBox = (m: { x: number; y: number; width: number; height: number }, label: string) => (
    <>
      <rect x={m.x} y={m.y} width={m.width} height={m.height} rx={7.5} className="dp-box" fill="#f2f2f2" />
      <KonvaLabel spec={{ text: label, x: m.x, y: m.y, width: m.width, height: m.height, align: "center", vAlign: "middle", bold: true, fontSize: 11 }} />
    </>
  );
  const ctrlLabel = (box: { x: number; y: number; width: number; height: number }, text: string) => (
    <KonvaLabel spec={{ ...box, text, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" }} />
  );

  // ---- Early-branch lighting (hazards mode) ----
  const slotAt = (stage: CycleStage) => (hazards ? pipelineSlots?.find((s) => s.stage === stage) : undefined);
  const colourOf = (s: PipelineSlotView | null | undefined) => (s ? s.seq % PIPELINE_WIRE_COLOURS.length : null);
  const ifSlot = slotAt("F");
  const idSlot = slotAt("D");
  const idBranch = idSlot && isBranchOp(idSlot.op) ? idSlot : undefined;
  const idJump = idSlot && isJumpOp(idSlot.op) ? idSlot : undefined;
  const branchTaken = !!idBranch && idBranch.wires.includes("ADD2_MUX4");
  // Where this cycle's new PC comes from: the jump or taken branch in ID,
  // else PC+4 of the instruction in IF (predict not taken). A stall writes
  // no PC.
  const pcSource: "jump" | "branch" | "seq" | null =
    !hazards || held ? null : idJump ? "jump" : branchTaken ? "branch" : ifSlot ? "seq" : null;
  const pcColour = colourOf(pcSource === "jump" ? idJump : pcSource === "branch" ? idBranch : pcSource === "seq" ? ifSlot : null);
  const branchColour = colourOf(idBranch);
  const fwdRd1 = brFwd?.fwdRd1 ?? FWD_NONE;
  const fwdRd2 = brFwd?.fwdRd2 ?? FWD_NONE;
  const branchWires: { key: string; seg: WireSegment; colour: number | null }[] = hazards
    ? [
        { key: "pc4-mux4", seg: BR_PC4_TO_MUX4, colour: pcSource === "seq" ? pcColour : null },
        { key: "pc4-latch-if", seg: BR_PC4_LATCH_IF, colour: colourOf(ifSlot) },
        { key: "pc4-latch-id", seg: BR_PC4_LATCH_ID, colour: branchColour },
        ...(jump
          ? [
              { key: "mux4-mux5", seg: BR_MUX4_TO_MUX5, colour: pcSource === "seq" || pcSource === "branch" ? pcColour : null },
              { key: "mux5-pc", seg: BR_MUX5_TO_PC, colour: pcColour },
              { key: "jaddr-ls", seg: BR_JADDR_TO_LS, colour: colourOf(idJump) },
              { key: "ls-mux5", seg: BR_LS_TO_MUX5, colour: colourOf(idJump) },
            ]
          : [{ key: "mux4-pc", seg: BR_MUX4_TO_PC, colour: pcSource === "seq" || pcSource === "branch" ? pcColour : null }]),
        { key: "imm-riser", seg: BR_IMM_RISER, colour: branchColour },
        { key: "ls-add", seg: BR_LS_TO_ADD, colour: branchColour },
        { key: "target", seg: BR_TARGET, colour: branchColour },
        { key: "cmp-mux4", seg: BR_CMP_TO_MUX4, colour: branchColour },
        { key: "rd1-fwd", seg: BR_RD1_TO_FWD, colour: fwdRd1 === FWD_NONE ? branchColour : null },
        { key: "rd2-fwd", seg: BR_RD2_TO_FWD, colour: fwdRd2 === FWD_NONE ? branchColour : null },
        { key: "fwd1-cmp", seg: BR_FWD1_TO_CMP, colour: branchColour },
        { key: "fwd2-cmp", seg: BR_FWD2_TO_CMP, colour: branchColour },
      ]
    : [];
  // The dotted forwarding wires into FwdRD1/FwdRD2, in the producer's
  // colour (as in EX).
  const idForwardPaths = [
    { key: "id-exmem", wire: BR_FWD_EXMEM, colour: colourOf(brFwd?.exMem), sel: FWD_EX_MEM },
    { key: "id-memwb", wire: BR_FWD_MEMWB, colour: colourOf(brFwd?.memWb), sel: FWD_MEM_WB },
  ];
  // The EX/MEM forwarding trunk out of the ALU result also feeds the ID
  // continuation, so it lights for either.
  const idUsesExMem = fwdRd1 === FWD_EX_MEM || fwdRd2 === FWD_EX_MEM;
  const exMemTrunkColour = exMemColour ?? colourOf(brFwd?.exMem);

  return (
    <svg className="datapath-diagram" viewBox={`0 ${viewY} ${viewWidth} ${viewHeight}`} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="dp-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="dp-arrowhead" />
        </marker>
        <marker id="dp-arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="dp-arrowhead-active" />
        </marker>
        <marker id="dp-arrow-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="dp-arrowhead-blue" />
        </marker>
        <marker id="dp-arrow-fwd" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="dp-arrowhead-fwd" />
        </marker>
        {PIPELINE_WIRE_COLOURS.map((colour, i) => (
          <marker key={colour} id={`dp-arrow-p${i}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: colour }} />
          </marker>
        ))}
      </defs>

      {/* ---- Forwarding wires (hazards mode) ---- */}
      {/* Drawn before everything else, so every solid wire, bar and
      component passes over them: they run behind the diagram. */}
      {hazards && (
        <g className="dp-fwd-wires">
          {forwardPaths.map(({ key, wire, colour, sel }) => {
            const toMux6 = fwdA === sel;
            const toMux7 = fwdB === sel;
            const toId = sel === FWD_EX_MEM && idUsesExMem;
            return (
              <g key={key}>
                <path
                  d={P(wire.trunk.d)}
                  {...fwdWireProps(toId && !(toMux6 || toMux7) ? exMemTrunkColour : colour, toMux6 || toMux7 || toId, false)}
                />
                <path d={P(wire.toMux6.d)} {...fwdWireProps(colour, toMux6, true)} />
                <path d={P(wire.toMux7.d)} {...fwdWireProps(colour, toMux7, true)} />
              </g>
            );
          })}
          {idForwardPaths.map(({ key, wire, colour, sel }) => {
            const toRd1 = fwdRd1 === sel;
            const toRd2 = fwdRd2 === sel;
            return (
              <g key={key}>
                <path d={wire.trunk.d} {...fwdWireProps(colour, toRd1 || toRd2, false)} />
                <path d={wire.toRd1.d} {...fwdWireProps(colour, toRd1, true)} />
                <path d={wire.toRd2.d} {...fwdWireProps(colour, toRd2, true)} />
              </g>
            );
          })}
        </g>
      )}

      {/* ---- Wires (drawn first, so component boxes sit on top) ---- */}
      <g className="dp-wires">
        {Object.entries(segmentsToRender)
          .filter(([key]) => !hiddenSegments.has(key))
          .flatMap(([key, seg]) => {
            // In pipeline mode one segment can become several pieces (split
            // at each bar it crosses), each tagged with its stage region and
            // coloured by whichever instruction is in that region.
            const pieces = pipeline ? pipelineSegment(key, seg) : [seg];
            return pieces.map((piece, i) => (
              <path key={`${key}-${i}`} d={P(piece.d)} {...wireProps(pieceColour(key, piece), piece.arrow)} />
            ));
          })}
        {pipeline &&
          PIPELINE_WB_WR.map((piece, i) => (
            <path key={`WB_WR-${i}`} d={P(piece.d)} {...wireProps(wbWrColour, piece.arrow)} />
          ))}
        {pipeline && <path d={P(PIPELINE_CONTROL_INPUT.d)} {...wireProps(controlInColour, true)} />}
        {hazardWires.map(({ key, seg, colour }) => (
          <path key={key} d={P(seg.d)} {...wireProps(colour, seg.arrow)} />
        ))}
        {/* Early-branch wiring: already in final coordinates. */}
        {branchWires.map(({ key, seg, colour }) => (
          <path key={key} d={seg.d} {...wireProps(colour, seg.arrow)} />
        ))}
      </g>

      {/* Where the forwarding wires tap their source wires. */}
      {hazards &&
        forwardPaths.map(({ key, colour, sel, tap }) => {
          const on = (fwdA === sel || fwdB === sel || (sel === FWD_EX_MEM && idUsesExMem)) && (colour ?? exMemTrunkColour) !== null;
          const c = colour ?? exMemTrunkColour;
          return (
            <circle
              key={`${key}-tap`}
              cx={X(tap.x)}
              cy={tap.y}
              r={3}
              className="dp-fwd-tap"
              style={on && c !== null ? { fill: PIPELINE_WIRE_COLOURS[c] } : undefined}
            />
          );
        })}
      {hazards && (
        <circle
          cx={BR_FWD_MEMWB_TAP.x}
          cy={BR_FWD_MEMWB_TAP.y}
          r={3}
          className="dp-fwd-tap"
          style={
            (fwdRd1 === FWD_MEM_WB || fwdRd2 === FWD_MEM_WB) && brFwd?.memWb
              ? { fill: PIPELINE_WIRE_COLOURS[brFwd.memWb.seq % PIPELINE_WIRE_COLOURS.length] }
              : undefined
          }
        />
      )}
      {/* Junctions on the early-branch wiring's source wires. */}
      {hazards && BR_TAPS.map(([x, y]) => <circle key={`br-tap-${x}-${y}`} cx={x} cy={y} r={2.5} className="dp-junction" />)}

      {/* ---- Pipeline registers ---- */}
      {/* Drawn after the wires so each bar sits on top of them; the wires
      themselves are already split at the bar edges (pipelineSegment), so
      every wire visibly ends in an arrow into a bar and restarts out of it. */}
      {pipeline && (
        <g className="dp-pipeline-bars">
          {PIPELINE_BARS.map((bar) => {
            // Hazards mode: remapped, and (except MEM/WB, which already
            // starts lower) starting lower to leave the lanes back to MUX 4
            // room above.
            const b = { ...bar, x: X(bar.x), top: hazards && bar.label !== "MEM/WB" ? HAZARD_BAR_TOP : bar.top };
            const flushing = hazards && b.label === "IF/ID" && (pipelineSlots ?? []).some((s) => s.flushed);
            return (
              <g key={b.label}>
                <rect
                  x={b.x}
                  y={b.top}
                  width={b.width}
                  height={b.bottom - b.top}
                  className={
                    held && b.label === "IF/ID"
                      ? "dp-box dp-pipeline-bar dp-held"
                      : flushing
                        ? "dp-box dp-pipeline-bar dp-flushing"
                        : "dp-box dp-pipeline-bar"
                  }
                >
                  {held && b.label === "IF/ID" && <title>Stalled: IF/ID keeps its contents this cycle (IF/IDWrite = 0)</title>}
                  {flushing && <title>Flush: IF/ID is zeroed at the end of this cycle (IF.Flush = 1)</title>}
                </rect>
                <KonvaLabel
                  spec={{ text: b.label, x: b.x - 30, y: b.top - 17, width: b.width + 60, height: 14, align: "center", bold: true, fontSize: 11 }}
                />
              </g>
            );
          })}
        </g>
      )}

      {/* ---- Instruction Memory ---- */}
      {/* In pipeline mode IM sits directly under PC (see PIPELINE_IF in
      datapathWires.ts): the address arrives from above, so "Address" moves
      to the top edge, and the instruction leaves the right edge toward
      IF/ID, so "Instruction" moves to the right at that wire's height. */}
      {pipeline ? (
        <g>
          <rect x={im.x} y={im.y} width={im.width} height={im.height} className="dp-box" fill="#e8e5bb" />
          <KonvaLabels
            specs={[
              { text: "Address", x: im.x + 5, y: im.y + 5, width: im.width - 10, height: 20, align: "center" },
              { text: "Instruction\nMemory", x: im.x + 5, y: im.y + 30, width: im.width - 10, height: 30, align: "center", bold: true, fill: "#c0392b" },
              { text: "Instruction", x: im.x + 5, y: PIPELINE_IF.imOutY - 10, width: im.width - 10, height: 20, align: "right", vAlign: "middle" },
            ]}
          />
        </g>
      ) : (
        <g>
          <rect x={15} y={15} width={100} height={120} className="dp-box" fill="#e8e5bb" />
          <KonvaLabels
            specs={[
              { text: "Instruction Memory", x: 20, y: 20, width: 90, height: 30, align: "center", bold: true, fill: "#c0392b" },
              { text: "Instruction", x: 20, y: 70, width: 90, height: 30, align: "left" },
              { text: "Address", x: 20, y: 110, width: 90, height: 30, align: "right" },
            ]}
          />
        </g>
      )}

      {/* ---- PC ---- */}
      <g transform={ifShift(PIPELINE_IF.pcDx)}>
        <rect x={130} y={15} width={40} height={60} className={held ? "dp-box dp-held" : "dp-box"} fill="#d7dce2">
          {held && <title>Stalled: PC keeps its value this cycle (PCWrite = 0)</title>}
        </rect>
        <KonvaLabel spec={{ text: "PC", x: 135, y: 20, width: 30, height: 50, align: "center", vAlign: "middle", bold: true }} />
      </g>

      {/* ---- Instruction fields — rotated boxes, see header comment ---- */}
      <g transform={hzShift(60 + PIPELINE_OFFSET.ID)}>
      <g className="dp-inst-fields" transform={stageShift("ID")}>
        {fieldRows.map((f) => (
          <g key={f.name}>
            <rect x={60} y={f.y} width={20} height={70} className="dp-box-thin" fill="white" />
            <KonvaLabel
              spec={{ text: f.name, x: 55, y: f.y, width: 70, height: 20, align: "center", rotate: 90, italic: true, fontSize: 10 }}
            />
            <KonvaLabel
              spec={{
                text: inst ? fieldBits(inst, f.idx, f.len) : "0".repeat(f.len),
                x: 75,
                y: f.y,
                width: 70,
                height: 20,
                align: "center",
                rotate: 90,
                fontSize: 10,
              }}
            />
          </g>
        ))}
      </g>
      </g>

      {/* ---- Register File ---- */}
      {/* Hazards mode: Register File, Sign Extend and Control move left
      (datapathBranch.ts). */}
      <g transform={hzShift(200 + PIPELINE_OFFSET.ID)}>
      <g transform={stageShift("ID")}>
        <rect x={200} y={200} width={100} height={230} className="dp-box" fill="#ffffcc" />
        <KonvaLabels
          specs={[
            { text: "Register File", x: 205, y: 205, width: 90, height: 50, align: "center", bold: true, fill: "#c0392b" },
            { text: "RR1", x: 205, y: 250, width: 90, height: 50, align: "left" },
            { text: "RR2", x: 205, y: 320, width: 90, height: 50, align: "left" },
            { text: "WR", x: 205, y: 370, width: 90, height: 50, align: "left" },
            { text: "WD", x: 205, y: 405, width: 90, height: 50, align: "left" },
            { text: "RD1", x: 205, y: 250, width: 90, height: 50, align: "right" },
            { text: "RD2", x: 205, y: 370, width: 90, height: 50, align: "right" },
            { text: "RegWrite", x: 205, y: 440, width: 90, height: 30, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" },
          ]}
        />
        <CtrlTick x={250} y1={430} y2={440} />
      </g>
      </g>

      {/* ---- Sign Extend ---- */}
      {/* Ellipse x/y is its CENTER (see header comment) — was cx=300 cy=515 before, wrong. */}
      <g transform={hzShift(200 + PIPELINE_OFFSET.ID)}>
      <g transform={stageShift("ID")}>
        <ellipse cx={250} cy={500} rx={50} ry={15} className="dp-box" fill="#f2f2f2" />
        <KonvaLabel spec={{ text: "Sign Extend", x: 205, y: 485, width: 90, height: 30, align: "center", vAlign: "middle", bold: true }} />
      </g>
      </g>

      {/* ---- ALU ---- */}
      <g transform={hzShift(450 + PIPELINE_OFFSET.EX)}>
      <g transform={stageShift("EX")}>
        <path d={aluPath(450, 200, 100, 230)} className="dp-box" fill="white" />
        <KonvaLabels
          specs={[
            { text: "ALU", x: 450, y: 200, width: 100, height: 230, align: "center", vAlign: "middle", bold: true, fill: "#c0392b", fontSize: 20 },
            { text: "ALUop1", x: 455, y: 245, width: 100, height: 50, align: "left" },
            { text: "ALUop2", x: 455, y: 375, width: 100, height: 50, align: "left" },
            { text: "isZero?", x: 455, y: 275, width: 90, height: 50, align: "right", bold: true, fill: "#2c5aa0" },
            { text: "result", x: 455, y: 345, width: 90, height: 50, align: "right" },
            { text: "ALUctrl", x: 450, y: 190, width: 100, height: 50, align: "center", bold: true, fill: "#2c5aa0" },
          ]}
        />
        <CtrlTick x={500} y1={200} y2={230} />
        {/* "shamt" label for the SHAMT_ALU2 wire (see datapathWires.ts).
        Anchored at x=490-520, just past (right of) the vertical stub's
        x=480 entry point into the ALU's bottom diagonal edge — moved here
        after the first placement (x=445-475, to the left of the stub)
        still read too close to the arrow. fontSize omitted to match the
        default used by every other label in this diagram (was 10,
        visibly smaller). Hidden along with SHAMT_ALU2 itself when the
        "Shift" feature toggle is off. */}
        {shift && <KonvaLabel spec={{ text: "shamt", x: 490, y: 435, width: 30, height: 20, align: "right", vAlign: "middle" }} />}
      </g>
      </g>

      {/* ---- Data Memory ---- */}
      <g transform={hzShift(650 + PIPELINE_OFFSET.MEM)}>
      <g transform={stageShift("MEM")}>
        <rect x={650} y={300} width={100} height={200} className="dp-box" fill="#e1ffc4" />
        <KonvaLabels
          specs={[
            { text: "Data Memory", x: 655, y: 305, width: 90, height: 50, align: "center", bold: true, fill: "#c0392b" },
            { text: "Address", x: 655, y: 345, width: 90, height: 50, align: "left" },
            { text: "Write Data", x: 655, y: 470, width: 40, height: 50, align: "left" },
            { text: "Read Data", x: 705, y: 435, width: 40, height: 50, align: "right" },
            { text: "MemWrite", x: 655, y: 270, width: 90, height: 50, align: "center", bold: true, fill: "#2c5aa0" },
            { text: "MemRead", x: 655, y: 510, width: 90, height: 50, align: "center", bold: true, fill: "#2c5aa0" },
          ]}
        />
        <CtrlTick x={700} y1={280} y2={300} />
        <CtrlTick x={700} y1={500} y2={510} />
      </g>
      </g>

      {/* ---- Left Shift 2-bit ---- */}
      {/* Ellipse x/y is its CENTER — was cx=375 cy=140 before, wrong. */}
      {/* Pipeline mode: moved into EX, after ID/EX — see PIPELINE_BRANCH_LS in
      datapathWires.ts. Same ellipse, just translated from its original
      center (325, 115). Hazards mode draws its own, in ID. */}
      {!hazards && (
        <g transform={pipeline ? `translate(${PIPELINE_BRANCH_LS.cx - 325} ${PIPELINE_BRANCH_LS.cy - 115 + PIPELINE_TOP_DY})` : undefined}>
          <ellipse cx={325} cy={115} rx={50} ry={25} className="dp-box" fill="#f2f2f2" />
          <KonvaLabel spec={{ text: "Left Shift\n2-bit", x: 275, y: 90, width: 100, height: 50, align: "center", vAlign: "middle", bold: true }} />
        </g>
      )}

      {/* ---- Add1 (PC+4) ---- */}
      {/* Shifted 30 units right of its original x=220 so its left edge
      (and the "4" input arrow) sit clearly apart from the PC->Instruction-
      Address vertical line at x=200 — at the old position they were only
      20px apart, which read as the same line kinking into the "4" arrow. */}
      <g transform={ifShift(PIPELINE_IF.add1Dx)}>
        <path d={aluPath(250, 15, 40, 60)} className="dp-box" fill="white" />
        <KonvaLabels
          specs={[
            { text: "Add", x: 255, y: 15, width: 40, height: 60, align: "center", vAlign: "middle", bold: true, fill: "#c0392b" },
            { text: "4", x: 185, y: 50, width: 40, height: 30, align: "right", vAlign: "middle", bold: true },
          ]}
        />
        {/* Constant 4 flowing into the adder's second (bottom-left) input,
        at the same height (y=65) the "4" label is centered on. Starts at
        x=230, clear of the label's right edge (x=225), so the wire's
        stroke doesn't paint over the digit. */}
        <line x1={230} y1={65} x2={250} y2={65} className="dp-wire" markerEnd="url(#dp-arrow)" />
      </g>

      {/* ---- Add2 (branch target) ---- */}
      {/* Hazards mode draws its own, in ID. */}
      {!hazards && (
        <g transform={pipeline ? `translate(${PIPELINE_OFFSET.EX} ${PIPELINE_TOP_DY})` : undefined}>
          <path d={aluPath(500, 65, 40, 60)} className="dp-box" fill="white" />
          <KonvaLabel spec={{ text: "Add", x: 505, y: 65, width: 40, height: 60, align: "center", vAlign: "middle", bold: true, fill: "#c0392b" }} />
        </g>
      )}

      {/* ---- MUX 1 (RegDst) ---- */}
      {/* In pipeline mode the RegDst mux sits in EX, after ID/EX, as in the
      textbook figure (see PIPELINE_REGDST_MUX in datapathWires.ts). Its
      control tick comes from above there, since the band below it carries
      the MEM/WB -> WR return wire. */}
      {pipeline ? (
        <g transform={hzShift(regDstMux.x)}>
          <rect x={regDstMux.x} y={regDstMux.y} width={regDstMux.width} height={regDstMux.height} rx={7.5} className="dp-box" fill="#f2f2f2" />
          <KonvaLabels
            specs={[
              { text: "MUX 1", x: regDstMux.x, y: regDstMux.y, width: regDstMux.width, height: regDstMux.height, align: "center", vAlign: "middle", bold: true },
              { text: "RegDst", x: regDstMux.x - 20, y: regDstMux.y - 27, width: regDstMux.width + 40, height: 16, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" },
            ]}
          />
          <CtrlTick x={regDstMux.x + regDstMux.width / 2} y1={regDstMux.y - 10} y2={regDstMux.y} />
        </g>
      ) : (
        <g transform={stageShift("ID")}>
          <rect x={130} y={340} width={30} height={70} rx={7.5} className="dp-box" fill="#f2f2f2" />
          <KonvaLabels
            specs={[
              { text: "MUX 1", x: 130, y: 340, width: 30, height: 70, align: "center", vAlign: "middle", bold: true },
              { text: "RegDst", x: 110, y: 415, width: 70, height: 30, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" },
            ]}
          />
          <CtrlTick x={145} y1={410} y2={420} />
        </g>
      )}

      {/* ---- MUX 2 (ALUSrc) ---- */}
      {!hazards && (
        <g transform={stageShift("EX")}>
          <rect x={390} y={355} width={30} height={75} rx={7.5} className="dp-box" fill="#f2f2f2" />
          <KonvaLabels
            specs={[
              { text: "MUX 2", x: 390, y: 360, width: 30, height: 70, align: "center", vAlign: "middle", bold: true },
              { text: "ALUSrc", x: 370, y: 435, width: 70, height: 30, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" },
            ]}
          />
          <CtrlTick x={405} y1={430} y2={440} />
        </g>
      )}

      {/* ---- Forwarding muxes (hazards mode) ---- */}
      {/* Pipelined coordinates (datapathHazards.ts), so no stage transform.
      MUX 6 (Fwdop1) selects ALUop1 and MUX 7 (Fwdop2) selects rt, each
      from 00 = ID/EX, 10 = EX/MEM's ALU result, 01 = MUX 3's write-back
      value. MUX 7's output feeds both MUX 2 (ALUSrc) and the store data
      line, so a forwarded rt reaches the ALU and Data Memory alike. */}
      {hazards && (
        <g transform={hzShift(HAZARD_MUX6.x)}>
          {muxBox(HAZARD_MUX6, "MUX 6")}
          {ctrlLabel(HAZARD_FWDOP1_LABEL, "Fwdop1")}
          <CtrlTick x={HAZARD_MUX6.x + HAZARD_MUX6.width / 2} y1={HAZARD_FWDOP1_LABEL.y + HAZARD_FWDOP1_LABEL.height + 1} y2={HAZARD_MUX6.y} />

          {muxBox(HAZARD_MUX7, "MUX 7")}
          {ctrlLabel(HAZARD_FWDOP2_LABEL, "Fwdop2")}
          <CtrlTick x={HAZARD_MUX7.x + HAZARD_MUX7.width / 2} y1={HAZARD_FWDOP2_LABEL.y + HAZARD_FWDOP2_LABEL.height + 1} y2={HAZARD_MUX7.y} />

          {muxBox(HAZARD_MUX2, "MUX 2")}
          {ctrlLabel(HAZARD_ALUSRC_LABEL, "ALUSrc")}
          <CtrlTick x={HAZARD_MUX2.x + HAZARD_MUX2.width / 2} y1={HAZARD_MUX2.y + HAZARD_MUX2.height} y2={HAZARD_MUX2.y + HAZARD_MUX2.height + 10} />
        </g>
      )}

      {/* ---- MUX 3 (MemToReg) ---- */}
      <g transform={hzShift(780 + PIPELINE_OFFSET.WB)}>
      <g transform={stageShift("WB")}>
        <rect x={780} y={430} width={30} height={110} rx={7.5} className="dp-box" fill="#f2f2f2" />
        <KonvaLabels
          specs={[
            { text: "MUX 3", x: 780, y: 450, width: 30, height: 70, align: "center", vAlign: "middle", bold: true },
            { text: "MemToReg", x: 760, y: 545, width: 70, height: 30, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" },
          ]}
        />
        <CtrlTick x={795} y1={540} y2={550} />
      </g>
      </g>

      {/* ---- Early-branch hardware (hazards mode) ---- */}
      {/* Final coordinates (datapathBranch.ts). IF: MUX 4 (PC+4 vs. branch
      target, selected by the comparator from above) and MUX 5 (vs. the jump
      target), feeding PC; the jump shifter below IF/ID. ID: the branch
      shifter and adder, FwdRD1/FwdRD2, and the isZero? comparator. */}
      {hazards && (
        <g>
          {muxBox(BR_MUX4, "MUX 4")}
          {jump && (
            <>
              {muxBox(BR_MUX5, "MUX 5")}
              <CtrlTick x={BR_MUX5.x + BR_MUX5.width / 2} y1={BR_MUX5.y + BR_MUX5.height} y2={BR_JUMP_LABEL.y} />
              {ctrlLabel(BR_JUMP_LABEL, "Jump")}
              <ellipse cx={BR_JUMP_LS.cx} cy={BR_JUMP_LS.cy} rx={BR_JUMP_LS.rx} ry={BR_JUMP_LS.ry} className="dp-box" fill="#f2f2f2" />
              <KonvaLabel
                spec={{
                  text: "Left Shift\n2-bit",
                  x: BR_JUMP_LS.cx - BR_JUMP_LS.rx,
                  y: BR_JUMP_LS.cy - BR_JUMP_LS.ry,
                  width: 2 * BR_JUMP_LS.rx,
                  height: 2 * BR_JUMP_LS.ry,
                  align: "center",
                  vAlign: "middle",
                  bold: true,
                  fontSize: 9,
                }}
              />
              <KonvaLabel spec={{ ...BR_JADDR_LABEL, text: "inst[25:0]", align: "right", fontSize: 10 }} />
            </>
          )}

          <ellipse cx={BR_LS.cx} cy={BR_LS.cy} rx={BR_LS.rx} ry={BR_LS.ry} className="dp-box" fill="#f2f2f2" />
          <KonvaLabel
            spec={{
              text: "Left Shift\n2-bit",
              x: BR_LS.cx - BR_LS.rx,
              y: BR_LS.cy - BR_LS.ry,
              width: 2 * BR_LS.rx,
              height: 2 * BR_LS.ry,
              align: "center",
              vAlign: "middle",
              bold: true,
              fontSize: 9,
            }}
          />
          <path d={aluPath(BR_ADD.x, BR_ADD.y, BR_ADD.width, BR_ADD.height)} className="dp-box" fill="white" />
          <KonvaLabel spec={{ ...BR_ADD, x: BR_ADD.x + 4, text: "Add", align: "center", vAlign: "middle", bold: true, fill: "#c0392b", fontSize: 11 }} />

          {muxBox(BR_FWDRD1, "MUX 8")}
          {ctrlLabel(BR_FWDRD1_LABEL, "FwdRD1")}
          <CtrlTick x={BR_FWDRD1.x + BR_FWDRD1.width / 2} y1={BR_FWDRD1_LABEL.y + BR_FWDRD1_LABEL.height} y2={BR_FWDRD1.y} />
          {muxBox(BR_FWDRD2, "MUX 9")}
          {ctrlLabel(BR_FWDRD2_LABEL, "FwdRD2")}
          <CtrlTick x={BR_FWDRD2.x + BR_FWDRD2.width / 2} y1={BR_FWDRD2.y + BR_FWDRD2.height} y2={BR_FWDRD2_LABEL.y} />

          <rect x={BR_CMP.x} y={BR_CMP.y} width={BR_CMP.width} height={BR_CMP.height} className="dp-box" fill="#f2f2f2" />
          <KonvaLabel spec={{ ...BR_CMP, text: "isZero?", align: "center", vAlign: "middle", bold: true, fontSize: 10 }} />
        </g>
      )}

      {/* ---- MUX 4 (Branch) ---- */}
      {!hazards && (
      <g transform={topMuxShift}>
        <rect x={780} y={25} width={30} height={90} rx={7.5} className="dp-box" fill="#f2f2f2" />
        <KonvaLabels
          specs={[
            { text: "MUX 4", x: 780, y: 25, width: 30, height: 90, align: "center", vAlign: "middle", bold: true },
            { text: "Branch\n&\nisZero?", x: 760, y: 120, width: 70, height: 60, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" },
          ]}
        />
        <CtrlTick x={795} y1={115} y2={125} />
      </g>
      )}

      {/* ---- MUX 5 (Jump) ---- */}
      {/* NEW — processor.js never supported jumps, so there was never a
      second PC-select mux here at all; MUX 4's output used to wire
      straight into PC (the old MUX4_PC segment, still available as
      LEGACY_SEGMENTS.MUX4_PC for when the "Jump" toggle below is off).
      input 1 (left, y=45) is MUX 4's branch-or-PC+4 result; input 2
      (right, y=100) is the jump target, arriving via LS_MUX5 from the
      jump shift-left ellipse below; output (right, y=70) continues to PC
      via MUX5_PC — see datapathWires.ts for why input 2 and the output
      share the right side instead of following MUX 4's left-in/right-out
      convention (a real gap-from-WD_ concern, not just taste). */}
      {jump && !hazards && (
        <g transform={topMuxShift}>
          <rect x={840} y={25} width={30} height={90} rx={7.5} className="dp-box" fill="#f2f2f2" />
          <KonvaLabel spec={{ text: "MUX 5", x: 840, y: 25, width: 30, height: 90, align: "center", vAlign: "middle", bold: true }} />
          <CtrlTick x={855} y1={115} y2={125} />
          <KonvaLabel spec={{ text: "Jump", x: 825, y: 130, width: 60, height: 30, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" }} />
        </g>
      )}

      {/* ---- Left Shift 2-bit (Jump) ---- */}
      {/* NEW — a second, dedicated shifter for the jump index. This is
      deliberately NOT shared with the branch-offset "Left Shift 2-bit"
      ellipse above (real MIPS hardware has two separate shift-left-2
      units; the two fields being shifted — a sign-extended 16-bit branch
      immediate vs. a raw 26-bit jump index — aren't the same data, so
      reusing one box for both would misrepresent the datapath, not just
      simplify its drawing). Fed by JADDR_LS, outputs via LS_MUX5.
      cy=590 matches JADDR_LS/LS_MUX5's current endpoints in
      datapathWires.ts (poly(...,110,590) / poly(190,590,...)) — cx/rx are
      unchanged (110/190 = 150∓40), only the vertical position moved. */}
      {jump && !hazards && (
        <g transform={pipeline ? `translate(${PIPELINE_OFFSET.ID} ${PIPELINE_BOTTOM_DY})` : undefined}>
          <ellipse cx={150} cy={590} rx={40} ry={18} className="dp-box" fill="#f2f2f2" />
          <KonvaLabel spec={{ text: "Left Shift\n2-bit", x: 110, y: 572, width: 80, height: 36, align: "center", vAlign: "middle", bold: true }} />
        </g>
      )}

      {/* Labels the JADDR_LS wire's tap point (its first segment, running
      left from the rd field at y=370) with what it actually carries — the
      raw 26-bit jump index straight out of the fetched instruction word,
      not anything decoded via the rd/shamt/funct field boxes it happens
      to run past. Positioned directly beneath that segment. */}
      {jump && !hazards && (
        <KonvaLabel
          spec={
            pipeline
              ? { text: "inst[25:0]", x: PIPELINE_JADDR_LABEL.x, y: PIPELINE_JADDR_LABEL.y, width: PIPELINE_JADDR_LABEL.width, height: 14, align: "right", fontSize: 10 }
              : { text: "inst[25:0]", x: 5, y: 374, width: 60, height: 14, align: "left", fontSize: 10 }
          }
        />
      )}

      {/* ---- Bubbles (pipeline mode) ---- */}
      {/* A stall's nop, labelled in each stage it passes through. */}
      {pipeline &&
        (bubbles ?? []).map((stage) => {
          const at = BUBBLE_LABEL_AT[stage];
          return (
            at && (
              <text key={stage} x={X(at.x)} y={at.y} className="dp-bubble" textAnchor="middle">
                (bubble)
              </text>
            )
          );
        })}

      {/* ---- Control (pipeline mode) ---- */}
      {/* Last, so its hover overlay draws over the bars and every other
      component. */}
      {pipeline && <ControlUnit hazards={hazards} />}

      {state?.error && (
        <text x={viewWidth / 2} y={pipeline ? PIPELINE_VIEW_Y + PIPELINE_VIEW_HEIGHT - 4 : 575} className="dp-error" textAnchor="middle">
          {state.error}
        </text>
      )}
    </svg>
  );
}