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
import { useCallback, useEffect, useRef, useState } from "react";
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
import { ControlTable } from "./ControlTable";
import { DatapathDiagram } from "./DatapathDiagram";
import { parseMips } from "../lib/mips-parser";
import mipsUtil, { check, assemble } from "../lib/mips-parser/mips-util";
import { int32 } from "../lib/Numbers/int32";
import { CompileError } from "../lib/Numbers/err";
import { isKnownOp } from "../lib/mips-machine/ctrl";
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
  const machine = useMachineHistory(program, regBank, memBank);

  // keep the latest copies in a ref, updated unconditionally
  // every render (not inside an effect), and have effects read from the
  // ref instead of depending on the object directly.
  const actionsRef = useRef({ codeEditor, dispEditor, consEditor, valsBank, ctrlBank, step: machine.step, programSourceLines });
  actionsRef.current = { codeEditor, dispEditor, consEditor, valsBank, ctrlBank, step: machine.step, programSourceLines };

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
    const { codeEditor, consEditor, valsBank, ctrlBank, programSourceLines } = actionsRef.current;
 
    ctrlBank.RES();
    valsBank.RES();
 
    if (!state || !codeEditor || !consEditor) return;
    
    const editorLine = programSourceLines[state.pc] ?? state.pc; // keep track of line numbers disregarding labels
    codeEditor.mark(editorLine); // mark gutter of curr instr w red dot
    codeEditor.next(state.stage === "R" ? editorLine : -1);
 
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
    const op = state.op;
    if (isKnownOp(op)) {
      for (const name of STAGE_SIGNALS[state.stage]) {
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
          {machine.current && (
            <span className="app-stage-indicator">
              line={machine.current.pc} stage={STAGE_LABELS[machine.current.stage]} op={machine.current.op}
            </span>
          )}
        </div>
      </header>

      <main className="app-main">
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

        <section className="app-diagram">
          <DatapathDiagram activeWires={machine.current?.activeWires ?? []} state={machine.current} />
        </section>

        <section className="app-tables">
          <RegisterTable bank={regBank} />
          <ValsTable bank={valsBank} />
          <ControlTable bank={ctrlBank} />
          <MemoryTable bank={memBank} />
        </section>
      </main>
    </div>
  );
}