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
  type Stage,
} from "../lib/mips-machine/datapathWires";
import type { PipelineSlotView } from "../lib/mips-machine/pipeline";
import type { MachineState } from "../lib/mips-machine/machineState";
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
}

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

export function DatapathDiagram({ activeWires, state, features, pipelineSlots }: DatapathDiagramProps) {
  const shift = features?.shift ?? true;
  const jump = features?.jump ?? true;
  const pipeline = features?.pipeline ?? false;

  // Per-stage horizontal shift for component groups. All zero when
  // pipelining is off, so the single-cycle layout is exactly as before.
  const stageShift = (stage: Stage) => (pipeline ? `translate(${PIPELINE_OFFSET[stage]} 0)` : undefined);
  const viewWidth = pipeline ? PIPELINE_VIEW_WIDTH : 900;
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

  // Single-cycle mode: a whole segment lights, red, when its wire is
  // active this micro-step.
  const active = pipeline ? new Set<string>() : litKeys(activeWires);
  // Pipeline mode: each stage region shows the instruction occupying it
  // this cycle — the pieces of that instruction's wiring in the region,
  // in that instruction's colour.
  const regionLit = new Map<Stage, { keys: Set<string>; wires: WireId[]; colour: number }>();
  if (pipeline) {
    for (const slot of pipelineSlots ?? []) {
      regionLit.set(REGION_OF_STEP[slot.stage], {
        keys: litKeys(slot.wires),
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

  // Segments to hide entirely when a feature is off, and — for jump only
  // — the legacy segment to substitute back in. Shift needs no
  // substitute: disabling it just means SHAMT_ALU2 never renders and
  // MUX2_ALU2 (already real artwork, never removed) carries on as before.
  const hiddenSegments = new Set<string>();
  if (!shift) hiddenSegments.add("SHAMT_ALU2");
  if (!jump) ["MUX4_MUX5", "JADDR_LS", "LS_MUX5", "MUX5_PC"].forEach((k) => hiddenSegments.add(k));
  // Pipeline mode's MEM/WB -> WR wire (see PIPELINE_WB_WR in
  // datapathWires.ts) lights during write-back, alongside WD.
  const wbLit = regionLit.get("WB");
  const wbWrColour = wbLit && wbLit.wires.includes("MUX3_WD") ? wbLit.colour : null;
  const segmentsToRender = jump ? SEGMENTS : { ...SEGMENTS, ...LEGACY_SEGMENTS };

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
        {PIPELINE_WIRE_COLOURS.map((colour, i) => (
          <marker key={colour} id={`dp-arrow-p${i}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: colour }} />
          </marker>
        ))}
      </defs>

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
              <path key={`${key}-${i}`} d={piece.d} {...wireProps(pieceColour(key, piece), piece.arrow)} />
            ));
          })}
        {pipeline &&
          PIPELINE_WB_WR.map((piece, i) => (
            <path key={`WB_WR-${i}`} d={piece.d} {...wireProps(wbWrColour, piece.arrow)} />
          ))}
      </g>

      {/* ---- Pipeline registers ---- */}
      {/* Drawn after the wires so each bar sits on top of them; the wires
      themselves are already split at the bar edges (pipelineSegment), so
      every wire visibly ends in an arrow into a bar and restarts out of it. */}
      {pipeline && (
        <g className="dp-pipeline-bars">
          {PIPELINE_BARS.map((b) => (
            <g key={b.label}>
              <rect x={b.x} y={b.top} width={b.width} height={b.bottom - b.top} className="dp-box dp-pipeline-bar" />
              <KonvaLabel
                spec={{ text: b.label, x: b.x - 30, y: b.top - 17, width: b.width + 60, height: 14, align: "center", bold: true, fontSize: 11 }}
              />
            </g>
          ))}
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
        <rect x={130} y={15} width={40} height={60} className="dp-box" fill="#d7dce2" />
        <KonvaLabel spec={{ text: "PC", x: 135, y: 20, width: 30, height: 50, align: "center", vAlign: "middle", bold: true }} />
      </g>

      {/* ---- Instruction fields — rotated boxes, see header comment ---- */}
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

      {/* ---- Register File ---- */}
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

      {/* ---- Sign Extend ---- */}
      {/* Ellipse x/y is its CENTER (see header comment) — was cx=300 cy=515 before, wrong. */}
      <g transform={stageShift("ID")}>
        <ellipse cx={250} cy={500} rx={50} ry={15} className="dp-box" fill="#f2f2f2" />
        <KonvaLabel spec={{ text: "Sign Extend", x: 205, y: 485, width: 90, height: 30, align: "center", vAlign: "middle", bold: true }} />
      </g>

      {/* ---- ALU ---- */}
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

      {/* ---- Data Memory ---- */}
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

      {/* ---- Left Shift 2-bit ---- */}
      {/* Ellipse x/y is its CENTER — was cx=375 cy=140 before, wrong. */}
      {/* Pipeline mode: moved into EX, after ID/EX — see PIPELINE_BRANCH_LS in
      datapathWires.ts. Same ellipse, just translated from its original
      center (325, 115). */}
      <g transform={pipeline ? `translate(${PIPELINE_BRANCH_LS.cx - 325} ${PIPELINE_BRANCH_LS.cy - 115 + PIPELINE_TOP_DY})` : undefined}>
        <ellipse cx={325} cy={115} rx={50} ry={25} className="dp-box" fill="#f2f2f2" />
        <KonvaLabel spec={{ text: "Left Shift\n2-bit", x: 275, y: 90, width: 100, height: 50, align: "center", vAlign: "middle", bold: true }} />
      </g>

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
      <g transform={pipeline ? `translate(${PIPELINE_OFFSET.EX} ${PIPELINE_TOP_DY})` : undefined}>
        <path d={aluPath(500, 65, 40, 60)} className="dp-box" fill="white" />
        <KonvaLabel spec={{ text: "Add", x: 505, y: 65, width: 40, height: 60, align: "center", vAlign: "middle", bold: true, fill: "#c0392b" }} />
      </g>

      {/* ---- MUX 1 (RegDst) ---- */}
      {/* In pipeline mode the RegDst mux sits in EX, after ID/EX, as in the
      textbook figure (see PIPELINE_REGDST_MUX in datapathWires.ts). Its
      control tick comes from above there, since the band below it carries
      the MEM/WB -> WR return wire. */}
      {pipeline ? (
        <g>
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

      {/* ---- MUX 3 (MemToReg) ---- */}
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

      {/* ---- MUX 4 (Branch) ---- */}
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
      {jump && (
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
      {jump && (
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
      {jump && (
        <KonvaLabel
          spec={
            pipeline
              ? { text: "inst[25:0]", x: PIPELINE_JADDR_LABEL.x, y: PIPELINE_JADDR_LABEL.y, width: PIPELINE_JADDR_LABEL.width, height: 14, align: "right", fontSize: 10 }
              : { text: "inst[25:0]", x: 5, y: 374, width: 60, height: 14, align: "left", fontSize: 10 }
          }
        />
      )}

      {state?.error && (
        <text x={viewWidth / 2} y={pipeline ? PIPELINE_VIEW_Y + PIPELINE_VIEW_HEIGHT - 4 : 575} className="dp-error" textAnchor="middle">
          {state.error}
        </text>
      )}
    </svg>
  );
}