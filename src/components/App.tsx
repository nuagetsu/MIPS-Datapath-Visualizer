/**
 * Top-level page: three Ace editors (source / assembled listing / console)
 * on the left, the datapath diagram in the middle, and the register/vals/
 * control/memory tables on the right — the same four-region layout
 * processor.html laid out with Bootstrap's grid, rebuilt here with plain
 * CSS Grid/Flexbox (see App.css) so it scales the way the diagram does.
 *
 * This file is the piece of glue mips.js's parse()/exec() used to be:
 *   - Parse button: source -> parseMips() -> check() -> assemble() -> a
 *     ProgramLine[] for useMachineHistory, plus the assembled listing and
 *     initial .data memory contents.
 *   - Step/Play/Pause: drive useMachineHistory's step(), and mirror each
 *     resulting MachineState out to the code editor's mark/next/err
 *     gutters, the console log, and (see syncDisplays below) the vals/
 *     control tables' own mark-based bank hooks.
 *
 * Register/memory values are the real source of truth (useRegisterBank/
 * useMemoryBank, committed to by useMachineHistory). Vals/control table
 * marks are re-derived from each new MachineState — see the effect below.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AceEditorPanel } from "./AceEditorPanel";
import { useAceEditor, type AceEditorHandle } from "../hooks/useAceEditor";
import { useRegisterBank } from "../hooks/useRegisterBank";
import { useMemoryBank, type MemoryBank } from "../hooks/useMemoryBank";
import { useCtrlBank } from "../hooks/useControlBank";
import { useValsBank } from "../hooks/useValsBank";
import { useMachineHistory } from "../hooks/useMachineHistory";
import { RegisterTable } from "./RegisterTable";
import { MemoryTable } from "./MemoryTable";
import { ValsTable } from "./ValsTable";
import { ControlTable, type ForwardingRowsData } from "./ControlTable";
import { DatapathDiagram, PIPELINE_WIRE_COLOURS } from "./DatapathDiagram";
import { parseMips } from "../lib/mips-parser";
import mipsUtil, { check, assemble } from "../lib/mips-parser/mips-util";
import { int32 } from "../lib/Numbers/int32";
import { CompileError } from "../lib/Numbers/err";
import { isKnownOp } from "../lib/mips-machine/ctrl";
import {
  computeForwarding,
  computeBranchForwarding,
  formatFwd,
  FWD_NONE,
  FWD_EX_MEM,
  FWD_MEM_WB,
  type ForwardingSignals,
  type BranchForwardingSignals,
} from "../lib/mips-machine/forwarding";
import { destReg, isBranchOp, isJumpOp, stallReason, type PipelineSlotView } from "../lib/mips-machine/pipeline";
import { REGISTERS } from "../lib/mips-machine/registers";
import type { ProgramLine } from "../lib/mips-machine/interpreter";
import type { CycleStage } from "../lib/mips-machine/machineState";
import type { DataDecl, NumNode } from "../lib/mips-parser/ast";
import "./App.css";

const DEFAULT_SOURCE = `addi $v1, $zero, 100
add $v0, $zero, $v1
`;

/** Which control signals matter for a given stage — used purely to decide
 * which ControlTable cells/header column to mark "read this step",
 * mirroring which ctrl.RD(name, op) calls the original mips.js's exec()
 * actually made in each F/D/A/M/R case. */
const STAGE_SIGNALS: Record<CycleStage, string[]> = {
  F: [],
  D: ["RegDst"],
  A: ["ALUSrc", "ALUctrl"],
  M: ["MemRead", "MemWrite", "MemByte"],
  R: ["MemToReg", "RegWrite", "Branch", "BranchNE", "Jump"],
};

/** Lookup for stage names for display */
const STAGE_LABELS: Record<CycleStage, string> = {
  F: "Fetch",
  D: "Decode",
  A: "ALU",
  M: "Memory",
  R: "Register Write",
};

function regName(num: number): string {
  const name = REGISTERS.find((r) => r.num === num)?.name;
  return name ? `$${name}` : `$${num}`;
}

const FWD_SOURCE = { [FWD_EX_MEM]: "EX/MEM (10)", [FWD_MEM_WB]: "MEM/WB (01)" } as Record<number, string>;

/** Pipeline hazards mode: a one-line explanation of the hazard handling
 * going on this cycle, for under the Control table's forwarding rows —
 * following each hazard from detection, through the stall or flush, to the
 * forward. */
function hazardNote(
  slots: PipelineSlotView[],
  bubbles: CycleStage[],
  fwd: ForwardingSignals | null,
  brFwd: BranchForwardingSignals | null,
): ForwardingRowsData["note"] {
  const at = (stage: CycleStage) => slots.find((s) => s.stage === stage);
  const ex = at("A");
  const id = at("D");
  const mem = at("M");
  const info = (text: string) => ({ kind: "info" as const, text });

  // A taken branch or jump resolving in ID, flushing the wrong-path fetch.
  const flushed = slots.find((s) => s.flushed);
  if (flushed && id) {
    const what = isJumpOp(id.op) ? `${id.op} is a jump, decoded in ID` : `${id.op} is taken: the comparator in ID found its condition true`;
    return info(
      `Misprediction: ${what}. ${flushed.op} was fetched because the pipeline predicts not taken, so it's flushed ` +
        `(IF/ID is zeroed and a bubble enters ID) and MUX 4/5 send the target to PC instead.`,
    );
  }
  // The stall cycle: IF and ID held.
  const heldInId = slots.find((s) => s.stalled && s.stage === "D");
  if (heldInId) {
    const head =
      `Stall: ${heldInId.op} is held in ID (and the next instruction in IF) because PC and IF/ID aren't written ` +
      `this cycle, and a bubble (nop) enters EX.`;
    if (!isBranchOp(heldInId.op)) {
      return info(`${head} ${mem?.op ?? "The load"} is in MEM, reading the data ${heldInId.op} needs.`);
    }
    const again = stallReason(heldInId.state, ex?.state, mem?.state) === "branch-mem";
    return info(
      again
        ? `${head} ${mem?.op ?? "The load"} is now in MEM, but its data is only ready at the end of MEM, so the branch stalls once more.`
        : `${head} Next cycle its operand can be forwarded to the comparator.`,
    );
  }
  // Detection: the hazard detection unit fires; next cycle stalls.
  const reason = stallReason(id?.state, ex?.state, mem?.state);
  if (id && reason) {
    if (reason === "load-use" && ex) {
      return info(
        `Hazard detection: ${ex.op} in EX loads ${regName(int32.toNum(ex.state.fields.rt))}, which ${id.op} in ID ` +
          `uses. Its data won't exist until the end of MEM, so the pipeline stalls for one cycle next.`,
      );
    }
    const producer = reason === "branch-ex" ? ex : mem;
    const reg = regName(destReg(producer?.state) ?? 0);
    const when =
      reason === "branch-ex"
        ? `${producer?.op} in EX is still computing ${reg}`
        : `${producer?.op} in MEM is still loading ${reg}`;
    return info(`Branch hazard: ${id.op} compares ${reg} in ID, but ${when}. The pipeline stalls for one cycle next.`);
  }
  // Forwarding to the branch comparator.
  if (brFwd && (brFwd.fwdRd1 !== FWD_NONE || brFwd.fwdRd2 !== FWD_NONE)) {
    const parts: string[] = [];
    if (brFwd.fwdRd1 !== FWD_NONE) parts.push(`rs from ${FWD_SOURCE[brFwd.fwdRd1]}`);
    if (brFwd.fwdRd2 !== FWD_NONE) parts.push(`rt from ${FWD_SOURCE[brFwd.fwdRd2]}`);
    return info(`Forwarding to the comparator: ${brFwd.id.op} in ID takes ${parts.join(" and ")}.`);
  }
  // The cycle after a flush.
  if (bubbles.includes("D") && !id) {
    return info(`The flushed instruction is a bubble in ID; the branch target is in IF.`);
  }
  // A branch resolving not taken: the prediction was right.
  if (id && isBranchOp(id.op) && !id.wires.includes("ADD2_MUX4")) {
    return info(`${id.op} is not taken: the comparator in ID found its condition false, so the predicted instruction in IF carries on.`);
  }
  // The cycle after a load-use stall: the dependent instruction is in EX, the load in WB.
  if (fwd && bubbles.includes("M") && (fwd.fwdA === FWD_MEM_WB || fwd.fwdB === FWD_MEM_WB)) {
    return info(`After the stall: ${fwd.memWb?.op ?? "the load"}'s loaded value is forwarded from MEM/WB to ${fwd.ex.op} (01).`);
  }
  // Only reachable if hazards mode was switched on mid-run, after the stall
  // would already have happened.
  if (fwd && (fwd.loadUseA || fwd.loadUseB)) {
    return {
      kind: "warning",
      text:
        `Load-use hazard: ${fwd.exMem?.op ?? "the load"}'s data isn't ready until the end of MEM, so it can't be ` +
        `forwarded to ${fwd.ex.op} yet. A stall was needed a cycle ago.`,
    };
  }
  return null;
}

/** Direct port of mips.js's load(data) — walks the .data segment and
 * writes its initial contents into memory, one step ahead of assembly.
 * Byte/string entries pad to 4-byte boundaries exactly like
 * mips-util.ts's layoutData() does, so addresses stay consistent between
 * the two (see layoutData's own doc comment on why that matters for "la"
 * later). */
function initializeMemory(data: DataDecl[] | null, memBank: MemoryBank): void {
  if (data === null) return;
  let addr = 0;
  for (const decl of data) {
    switch (decl.prop.type) {
      case "int": {
        for (const v of decl.prop.vals as NumNode[]) {
          memBank.sw(addr, v.prop.bit);
          addr += 4;
        }
        break;
      }
      case "byte": {
        const vals = decl.prop.vals as NumNode[];
        for (let j = 0; j < vals.length; j += 4) {
          for (let k = 0; k < 4; k++) {
            memBank.sb(addr, j + k < vals.length ? vals[j + k].prop.bit : int32.num(0));
            addr += 1;
          }
        }
        break;
      }
      case "str": {
        const text = (decl.prop.vals as string) + "\0";
        for (let j = 0; j < text.length; j += 4) {
          for (let k = 0; k < 4; k++) {
            const bits = j + k < text.length ? int32.num(text.charCodeAt(j + k)) : int32.num(0);
            memBank.sb(addr, bits);
            addr += 1;
          }
        }
        break;
      }
    }
  }
}

export function App() {
  const [codeEditor, setCodeEditor] = useState<AceEditorHandle | null>(null);
  const [tablesCollapsed, setTablesCollapsed] = useState(false);
  // Presentation-only toggles for the datapath diagram's shift/jump
  // artwork (see DatapathDiagram's DatapathFeatures/LEGACY_SEGMENTS
  // comments) — default to both shown, matching the diagram's current
  // out-of-the-box behavior. Purely visual: execStage() always computes
  // shifts/jumps correctly regardless of these, so toggling either one
  // just changes what's drawn for the *same* underlying MachineState
  // history, including re-rendering past steps correctly.
  const [showShift, setShowShift] = useState(true);
  const [showJump, setShowJump] = useState(true);
  // Pipeline mode: draws the pipeline-register bars (IF/ID, ID/EX, EX/MEM,
  // MEM/WB) AND switches execution to pipelined — each Step is one clock
  // cycle with up to five instructions in flight, each drawn in its own
  // colour (see pipeline.ts). Program results are the same in both modes.
  // Off by default so the single-cycle diagram stays the out-of-the-box
  // view.
  const [showPipeline, setShowPipeline] = useState(false);
  // Pipeline hazards: draws the forwarding hardware (MUX 6/7 in EX, and the
  // early-branch datapath: branches resolved in ID, FwdRD1/FwdRD2, MUX 4/5
  // in IF), adds the forwarding signals to the Control table, and turns on
  // the hazard detection unit and predict-not-taken fetching: load-use and
  // branch hazards stall, taken branches and jumps flush. Toggling it
  // doesn't restart the run: it only affects the cycles that follow. Only
  // offered in pipeline mode; the choice is remembered while pipeline mode
  // is off.
  const [showHazards, setShowHazards] = useState(false);
  const hazards = showPipeline && showHazards;
  const dispContainerRef = useRef<HTMLDivElement>(null);
  const consContainerRef = useRef<HTMLDivElement>(null);
  const dispEditor = useAceEditor(dispContainerRef, { mode: "ace/mode/mips", pcNum: true, write: false });
  const consEditor = useAceEditor(consContainerRef, { mode: "ace/mode/text", write: false, number: false });

  const [program, setProgram] = useState<ProgramLine[]>([]);
  // keep track of line numbers disregarding labels
  const [programSourceLines, setProgramSourceLines] = useState<number[]>([]);
  const [speedMs, setSpeedMs] = useState(500);
  const [playing, setPlaying] = useState(false);

  const regBank = useRegisterBank();
  const memBank = useMemoryBank(256);
  const ctrlBank = useCtrlBank();
  const valsBank = useValsBank();
  const machine = useMachineHistory(program, regBank, memBank, showPipeline, hazards);

  // This cycle's Fwdop1/Fwdop2 (for the instruction in EX) and
  // FwdRD1/FwdRD2 (for a branch in ID), from the instructions in MEM and WB.
  const forwarding = useMemo(
    () => (hazards ? computeForwarding(machine.pipelineSlots, true) : null),
    [hazards, machine.pipelineSlots],
  );
  const branchForwarding = useMemo(
    () => (hazards ? computeBranchForwarding(machine.pipelineSlots) : null),
    [hazards, machine.pipelineSlots],
  );
  const loadUseTitle = "Load-use hazard: needs a one-cycle stall";
  const forwardingRows: ForwardingRowsData | undefined = hazards
    ? {
        rows: [
          {
            name: "Fwdop1",
            op: forwarding?.ex.op ?? null,
            value: formatFwd(forwarding?.fwdA ?? FWD_NONE),
            warn: forwarding?.loadUseA,
            title: forwarding?.loadUseA ? loadUseTitle : undefined,
          },
          {
            name: "Fwdop2",
            op: forwarding?.ex.op ?? null,
            value: formatFwd(forwarding?.fwdB ?? FWD_NONE),
            warn: forwarding?.loadUseB,
            title: forwarding?.loadUseB ? loadUseTitle : undefined,
          },
          { name: "FwdRD1", op: branchForwarding?.id.op ?? null, value: formatFwd(branchForwarding?.fwdRd1 ?? FWD_NONE) },
          { name: "FwdRD2", op: branchForwarding?.id.op ?? null, value: formatFwd(branchForwarding?.fwdRd2 ?? FWD_NONE) },
        ],
        note: hazardNote(machine.pipelineSlots, machine.pipelineBubbles, forwarding, branchForwarding),
      }
    : undefined;

  // keep the latest copies in a ref, updated unconditionally
  // every render (not inside an effect), and have effects read from the
  // ref instead of depending on the object directly.
  const actionsRef = useRef({ codeEditor, dispEditor, consEditor, valsBank, ctrlBank, step: machine.step, programSourceLines, pipelineSlots: machine.pipelineSlots });
  actionsRef.current = { codeEditor, dispEditor, consEditor, valsBank, ctrlBank, step: machine.step, programSourceLines, pipelineSlots: machine.pipelineSlots };

  // ---- Parse / assemble --------------------------------------------------
  const handleParse = useCallback(() => {
    if (!codeEditor || !dispEditor || !consEditor) return;
    setPlaying(false);
    consEditor.load("");

    const result = parseMips(codeEditor.value());
    if (!result.ok) {
      consEditor.log(result.message);
      codeEditor.err(Math.max(0, result.line - 1));
      return;
    }

    try {
      const { text, data } = result.program.prop;
      check(text, data);
      const assembled = assemble(text, data); // AssembledLine[] w kind, lbl, inst, cmt, loc, pc, 32 bit instruction

      const programLines: ProgramLine[] = assembled.map((line) => ({
        op: line.prop.inst.prop.op,
        bin: line.prop.bin,
      }));
      // Same index space as programLines above — line.prop.loc is
      // 1-indexed (PEG.js convention), Ace rows are 0-indexed.
      const sourceLines: number[] = assembled.map((line) => line.prop.loc - 1);

      initializeMemory(data, memBank);
      dispEditor.load(mipsUtil.print(assembled));
      codeEditor.reset();
      dispEditor.reset();
      machine.reset();
      setProgram(programLines);
      setProgramSourceLines(sourceLines);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      consEditor.log(message);
      const loc = err instanceof CompileError ? err.loc : 0;
      codeEditor.err(Math.max(0, loc - 1));
    }
  }, [codeEditor, dispEditor, consEditor, memBank, machine]);

  // ---- Step ---------------------------------------------------------
  const handleStep = useCallback(() => {
    machine.step();
  }, [machine]);

  // Play loop
  useEffect(() => {
    if (!playing) return;
    if (!machine.canStep) {
      setPlaying(false);
      return;
    }
    const id = window.setTimeout(() => actionsRef.current.step(), speedMs);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, machine.current, speedMs]);

  // ---- Mirror every new MachineState out to the editors + tables --------
  useEffect(() => {
    const state = machine.current;
    const { codeEditor, consEditor, valsBank, ctrlBank, programSourceLines, pipelineSlots } = actionsRef.current;

    ctrlBank.RES();
    valsBank.RES();

    // Before the first step (e.g. right after a reset or a mode switch),
    // clear any pipeline dots left from the previous run.
    if (!state) codeEditor?.markColours([]);
    if (!state || !codeEditor || !consEditor) return;

    const editorLine = programSourceLines[state.pc] ?? state.pc; // keep track of line numbers disregarding labels
    if (pipelineSlots.length > 0) {
      // Pipeline mode: a dot per instruction in flight, in the same colour
      // as its wires, instead of the single red dot.
      codeEditor.mark(-1);
      codeEditor.markColours(
        [...pipelineSlots]
          .sort((a, b) => a.seq - b.seq)
          .map((s) => ({
            line: programSourceLines[s.pc] ?? s.pc,
            colour: PIPELINE_WIRE_COLOURS[s.seq % PIPELINE_WIRE_COLOURS.length],
          })),
      );
      // As in single-cycle mode's R step: highlight the instruction
      // completing write-back this cycle, if there is one.
      const wb = pipelineSlots.find((s) => s.stage === "R");
      codeEditor.next(wb ? (programSourceLines[wb.pc] ?? wb.pc) : -1);
    } else {
      codeEditor.markColours([]);
      codeEditor.mark(editorLine); // mark gutter of curr instr w red dot
      codeEditor.next(state.stage === "R" ? editorLine : -1);
    }

    if (state.error) {
      consEditor.log(state.error);
      codeEditor.err(editorLine);
      setPlaying(false);
      return;
    }

    // vals: every key present this step gets repainted as "just updated" —
    for (const [key, bits] of Object.entries(state.vals)) {
      if (bits) valsBank.WR(key, bits);
    }

    // ctrl: mark whichever signals this stage actually reads, mirroring
    // exactly which ctrl.RD(name, op) calls mips.js's exec() made per case.
    // Pipeline mode: every instruction in flight reads its own stage's
    // signals this cycle.
    const reads = pipelineSlots.length > 0 ? pipelineSlots.map((s) => ({ op: s.op, stage: s.stage })) : [{ op: state.op, stage: state.stage }];
    for (const { op, stage } of reads) {
      if (!isKnownOp(op)) continue;
      for (const name of STAGE_SIGNALS[stage]) {
        ctrlBank.RD(name, op);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.current]);

  // Load the default instructions upon starting
  useEffect(() => {
    if (!codeEditor) return;
    codeEditor.load(DEFAULT_SOURCE);
  }, [codeEditor]);

  return (
    <div className="app">
      <header className="app-toolbar">
        <h1>MIPS Datapath Simulator</h1>
        <div className="app-toolbar-controls">
          <button onClick={handleParse}>Assemble</button>
          <button onClick={handleStep} disabled={!machine.canStep}>Step</button>
          <button onClick={() => setPlaying((p) => !p)} disabled={!machine.canStep && !playing}>
            {playing ? "Pause" : "Play"}
          </button>
          <label className="app-speed">
            Speed
            <input
              type="range"
              min={50}
              max={1500}
              step={50}
              value={1550 - speedMs}
              onChange={(e) => setSpeedMs(1550 - Number(e.target.value))}
            />
          </label>
          {machine.current && showPipeline && (
            // Pipeline mode: which instruction is in each stage this cycle,
            // in the same colour as its wires.
            <span className="app-stage-indicator">
              cycle={machine.history.length}
              {(["F", "D", "A", "M", "R"] as CycleStage[]).map((stage) => {
                const slot = machine.pipelineSlots.find((s) => s.stage === stage);
                const bubble = machine.pipelineBubbles.includes(stage);
                return (
                  <span
                    key={stage}
                    style={slot ? { color: PIPELINE_WIRE_COLOURS[slot.seq % PIPELINE_WIRE_COLOURS.length] } : undefined}
                  >
                    {" "}
                    {stage}:
                    {slot
                      ? `${slot.op}@${slot.pc}${slot.stalled ? "(stall)" : ""}${slot.flushed ? "(flush)" : ""}`
                      : bubble
                        ? "bubble"
                        : "-"}
                  </span>
                );
              })}
            </span>
          )}
          {machine.current && !showPipeline && (
            <span className="app-stage-indicator">
              line={machine.current.pc} stage={STAGE_LABELS[machine.current.stage]} op={machine.current.op}
            </span>
          )}
        </div>
        {/* <div className="app-feedback-group">
          <h1 className="app-feedback-link-label">We would appreciate it if you provided your feedback here: </h1>
          <a
            className="app-feedback-link"
            href="https://docs.google.com/forms/d/1ikhZhLoUp3EycgYMbi0k7gV7K92e_o_0SDqBJSIv5eM/edit"
            target="_blank"
            rel="noopener noreferrer"
          >
            Give Feedback
          </a>
        </div> */}
      </header>

      <main className={tablesCollapsed ? "app-main app-main-tables-collapsed" : "app-main"}>
        <section className="app-editors">
          <AceEditorPanel onReady={setCodeEditor} />
          <div className="app-editor-panel">
            <div className="app-editor-label">Assembled</div>
            <div ref={dispContainerRef} className="app-editor-container" />
          </div>
          <div className="app-editor-panel app-editor-panel-console">
            <div className="app-editor-label">Console</div>
            <div ref={consContainerRef} className="app-editor-container" />
          </div>
        </section>

        <section className="app-diagram-wrap">
          <div className="app-diagram-toolbar">
            <button
              className={showShift ? "app-diagram-toggle app-diagram-toggle-on" : "app-diagram-toggle"}
              onClick={() => setShowShift((s) => !s)}
              aria-pressed={showShift}
              title={showShift ? "Hide shift (sll/srl) artwork" : "Show shift (sll/srl) artwork"}
            >
              Toggle Shift
            </button>
            <button
              className={showJump ? "app-diagram-toggle app-diagram-toggle-on" : "app-diagram-toggle"}
              onClick={() => setShowJump((j) => !j)}
              aria-pressed={showJump}
              title={showJump ? "Hide jump (j) artwork" : "Show jump (j) artwork"}
            >
              Toggle Jump
            </button>
            <button
              className={showPipeline ? "app-diagram-toggle app-diagram-toggle-on" : "app-diagram-toggle"}
              onClick={() => {
                // The two modes step differently (micro-step vs. clock
                // cycle), so a run in progress can't carry over: start it
                // again from the first instruction, as Assemble does.
                setPlaying(false);
                machine.reset();
                setShowPipeline((p) => !p);
              }}
              aria-pressed={showPipeline}
              title={
                showPipeline
                  ? "Switch back to single-cycle execution (restarts the run)"
                  : "Switch to pipelined execution (restarts the run)"
              }
            >
              Toggle Pipeline
            </button>
            {showPipeline && (
              <button
                className={showHazards ? "app-diagram-toggle app-diagram-toggle-on" : "app-diagram-toggle"}
                onClick={() => setShowHazards((h) => !h)}
                aria-pressed={showHazards}
                title={
                  showHazards
                    ? "Back to the ideal pipeline: no stalls, flushes or forwarding hardware"
                    : "Show hazard handling: forwarding, stalls, early branches and predict-not-taken"
                }
              >
                Toggle Pipeline Hazards
              </button>
            )}
          </div>
          <div className="app-diagram">
            <DatapathDiagram
              activeWires={machine.current?.activeWires ?? []}
              state={machine.current}
              features={{ shift: showShift, jump: showJump, pipeline: showPipeline, hazards }}
              pipelineSlots={machine.pipelineSlots}
              forwarding={forwarding}
              branchForwarding={branchForwarding}
              bubbles={machine.pipelineBubbles}
            />
          </div>
        </section>

        <div className={tablesCollapsed ? "app-tables-tray app-tables-tray-collapsed" : "app-tables-tray"}>
          <button
            className="app-tables-handle"
            onClick={() => setTablesCollapsed((c) => !c)}
            aria-expanded={!tablesCollapsed}
            aria-label={tablesCollapsed ? "Show tables" : "Hide tables"}
            title={tablesCollapsed ? "Show tables" : "Hide tables"}
          >
            <span className="app-tables-handle-bar" />
            <span className="app-tables-handle-bar" />
            <span className="app-tables-handle-bar" />
          </button>
          {!tablesCollapsed && (
            <section className="app-tables">
              <RegisterTable bank={regBank} />
              <ValsTable bank={valsBank} />
              <ControlTable bank={ctrlBank} forwarding={forwardingRows} />
              <MemoryTable bank={memBank} />
            </section>
          )}
        </div>
      </main>
    </div>
  );
}