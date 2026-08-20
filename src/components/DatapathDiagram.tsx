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
 * Responsive by construction — unchanged from before: fixed 900×580
 * coordinate system inside one `viewBox`; the SVG's on-page size is pure
 * CSS (DatapathDiagram.css), no JS resize handling.
 */
import { int32, type Int32Bits } from "../lib/Numbers/int32";
import * as bit from "../lib/Numbers/bit";
import type { WireId } from "../lib/mips-machine/datapath";
import { SEGMENTS, aluPath, activeSegmentKeys } from "../lib/mips-machine/datapathWires";
import type { MachineState } from "../lib/mips-machine/machineState";
import "./DatapathDiagram.css";

export interface DatapathDiagramProps {
  /** Which wires are lit for the current micro-step. */
  activeWires: WireId[];
  /** Optional — when provided, live values (decoded instruction fields,
   * ALU result) render as text overlays. Omit for just the static
   * schematic. */
  state?: MachineState | null;
}

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

export function DatapathDiagram({ activeWires, state }: DatapathDiagramProps) {
  const active = activeSegmentKeys(activeWires);
  const inst = state?.inst ?? null;

  const fieldRows: { name: string; idx: number; len: number; y: number }[] = [
    { name: "opcode", idx: 26, len: 6, y: 150 },
    { name: "rs", idx: 21, len: 5, y: 220 },
    { name: "rt", idx: 16, len: 5, y: 290 },
    { name: "rd", idx: 11, len: 5, y: 360 },
    { name: "shamt", idx: 6, len: 5, y: 430 },
    { name: "funct", idx: 0, len: 6, y: 500 },
  ];

  return (
    <svg className="datapath-diagram" viewBox="0 0 900 580" xmlns="http://www.w3.org/2000/svg">
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
      </defs>

      {/* ---- Wires (drawn first, so component boxes sit on top) ---- */}
      <g className="dp-wires">
        {Object.entries(SEGMENTS).map(([key, seg]) => {
          const isActive = active.has(key);
          return (
            <path
              key={key}
              d={seg.d}
              className={isActive ? "dp-wire dp-wire-active" : "dp-wire"}
              markerEnd={seg.arrow ? `url(#${isActive ? "dp-arrow-active" : "dp-arrow"})` : undefined}
            />
          );
        })}
      </g>

      {/* ---- Instruction Memory ---- */}
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

      {/* ---- PC ---- */}
      <g>
        <rect x={130} y={15} width={40} height={60} className="dp-box" fill="#d7dce2" />
        <KonvaLabel spec={{ text: "PC", x: 135, y: 20, width: 30, height: 50, align: "center", vAlign: "middle", bold: true }} />
      </g>

      {/* ---- Instruction fields — rotated boxes, see header comment ---- */}
      <g className="dp-inst-fields">
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
      <g>
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
            { text: "RegWrite", x: 205, y: 405, width: 90, height: 50, align: "right", bold: true, fill: "#2c5aa0" },
          ]}
        />
      </g>

      {/* ---- Sign Extend ---- */}
      {/* Ellipse x/y is its CENTER (see header comment) — was cx=300 cy=515 before, wrong. */}
      <g>
        <ellipse cx={250} cy={500} rx={50} ry={15} className="dp-box" fill="#f2f2f2" />
        <KonvaLabel spec={{ text: "Sign Extend", x: 205, y: 485, width: 90, height: 30, align: "center", vAlign: "middle", bold: true }} />
      </g>

      {/* ---- ALU ---- */}
      <g>
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
        {state?.vals.ALUres && (
          <text x={500} y={355} className="dp-value" textAnchor="middle">
            {int32.toHex(state.vals.ALUres)}
          </text>
        )}
      </g>

      {/* ---- Data Memory ---- */}
      <g>
        <rect x={650} y={300} width={100} height={190} className="dp-box" fill="#e1ffc4" />
        <KonvaLabels
          specs={[
            { text: "Data Memory", x: 655, y: 305, width: 90, height: 50, align: "center", bold: true, fill: "#c0392b" },
            { text: "Address", x: 655, y: 345, width: 90, height: 50, align: "left" },
            { text: "Write Data", x: 655, y: 455, width: 40, height: 50, align: "left" },
            { text: "Read Data", x: 705, y: 455, width: 40, height: 50, align: "right" },
            { text: "MemWrite", x: 655, y: 270, width: 90, height: 50, align: "center", bold: true, fill: "#2c5aa0" },
            { text: "MemRead", x: 655, y: 510, width: 90, height: 50, align: "center", bold: true, fill: "#2c5aa0" },
          ]}
        />
        <CtrlTick x={700} y1={280} y2={300} />
        <CtrlTick x={700} y1={490} y2={510} />
      </g>

      {/* ---- Left Shift 2-bit ---- */}
      {/* Ellipse x/y is its CENTER — was cx=375 cy=140 before, wrong. */}
      <g>
        <ellipse cx={325} cy={115} rx={50} ry={25} className="dp-box" fill="#f2f2f2" />
        <KonvaLabel spec={{ text: "Left Shift\n2-bit", x: 275, y: 90, width: 100, height: 50, align: "center", vAlign: "middle", bold: true }} />
      </g>

      {/* ---- Add1 (PC+4) ---- */}
      <g>
        <path d={aluPath(220, 15, 40, 60)} className="dp-box" fill="white" />
        <KonvaLabels
          specs={[
            { text: "Add", x: 225, y: 15, width: 40, height: 60, align: "center", vAlign: "middle", bold: true, fill: "#c0392b" },
            { text: "4", x: 175, y: 50, width: 40, height: 30, align: "right", vAlign: "middle", bold: true },
          ]}
        />
      </g>

      {/* ---- Add2 (branch target) ---- */}
      <g>
        <path d={aluPath(500, 65, 40, 60)} className="dp-box" fill="white" />
        <KonvaLabel spec={{ text: "Add", x: 505, y: 65, width: 40, height: 60, align: "center", vAlign: "middle", bold: true, fill: "#c0392b" }} />
      </g>

      {/* ---- MUX 1 (RegDst) ---- */}
      <g>
        <rect x={130} y={340} width={30} height={70} rx={7.5} className="dp-box" fill="#f2f2f2" />
        <KonvaLabels
          specs={[
            { text: "MUX 1", x: 130, y: 340, width: 30, height: 70, align: "center", vAlign: "middle", bold: true },
            { text: "RegDst", x: 110, y: 415, width: 70, height: 30, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" },
          ]}
        />
        <CtrlTick x={145} y1={410} y2={420} />
      </g>

      {/* ---- MUX 2 (ALUSrc) ---- */}
      <g>
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
      <g>
        <rect x={780} y={450} width={30} height={70} rx={7.5} className="dp-box" fill="#f2f2f2" />
        <KonvaLabels
          specs={[
            { text: "MUX 3", x: 780, y: 450, width: 30, height: 70, align: "center", vAlign: "middle", bold: true },
            { text: "MemToReg", x: 760, y: 525, width: 70, height: 30, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" },
          ]}
        />
        <CtrlTick x={795} y1={520} y2={530} />
      </g>

      {/* ---- MUX 4 (Branch) ---- */}
      <g>
        <rect x={780} y={25} width={30} height={90} rx={7.5} className="dp-box" fill="#f2f2f2" />
        <KonvaLabels
          specs={[
            { text: "MUX 4", x: 780, y: 25, width: 30, height: 90, align: "center", vAlign: "middle", bold: true },
            { text: "Branch\n&\nisZero?", x: 760, y: 120, width: 70, height: 60, align: "center", vAlign: "middle", bold: true, fill: "#2c5aa0" },
          ]}
        />
        <CtrlTick x={795} y1={115} y2={125} />
      </g>

      {state?.error && (
        <text x={450} y={575} className="dp-error" textAnchor="middle">
          {state.error}
        </text>
      )}
    </svg>
  );
}