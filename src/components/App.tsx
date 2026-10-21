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
 *     initial .data memory contents. useMachineHistory then computes the
 *     whole run as a timeline.
 *   - Back/Step/Play and the scrubber (Scrubber.tsx) move through that
 *     timeline — forwards, backwards, or straight to any step — and every
 *     MachineState shown is mirrored out to the code editor's mark/next/err
 *     gutters, the console, and (see the effect below) the vals/control
 *     tables' own mark-based bank hooks.
 *
 * Register/memory values are the real source of truth (useRegisterBank/
 * useMemoryBank); seeking restores them to the step on screen. Editing a
 * register or memory word by hand rebases the timeline on the edit (see
 * useMachineHistory's rebase()). Vals/control table marks are re-derived
 * from each MachineState shown.
 *
 * Values tray filtering: by default the register, memory and control tables
 * only list what the assembled program refers to (see programRefs.ts): its
 * registers, its memory (plus any word read or written while running) and
 * a Control column per instruction kind it uses. "Display all registers,
 * memory & control signals" turns that off. Each of the four tables can also be shown or
 * hidden from the tray's toolbar.
 *
 * Errors: every error the console shows — syntax (parser + diagnose.ts),
 * assembly (mips-util / staticCheck), the test run on Assemble, and
 * run-time errors while stepping — goes through formatProblems(), so each
 * one reads "Error at line N (0xA): <what's wrong>" — 0xA being the
 * address the editor gutter shows for that line — followed by the offending
 * source line and, where there is one, a hint. A syntax pass can report
 * several lines at once; all of them get a gutter marker.
 *
 * Theme: useTheme() switches light/dark (colours are CSS custom
 * properties in theme.css; the Ace editors get the matching Ace theme).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AceEditorPanel } from "./AceEditorPanel";
import { useAceEditor, type AceEditorHandle } from "../hooks/useAceEditor";
import { useRegisterBank, type RegisterBank } from "../hooks/useRegisterBank";
import { useMemoryBank, type MemoryBank } from "../hooks/useMemoryBank";
import { useCtrlBank } from "../hooks/useControlBank";
import { useValsBank } from "../hooks/useValsBank";
import { useMachineHistory } from "../hooks/useMachineHistory";
import { useTheme } from "../hooks/useTheme";
import { RegisterTable } from "./RegisterTable";
import { MemoryTable } from "./MemoryTable";
import { ValsTable } from "./ValsTable";
import { ControlTable, type ForwardingRowsData } from "./ControlTable";
import { DatapathDiagram, PIPELINE_WIRE_COLOURS } from "./DatapathDiagram";
import { Scrubber } from "./Scrubber";
import { parseMips } from "../lib/mips-parser";
import mipsUtil, { check, assemble, lineRef } from "../lib/mips-parser/mips-util";
import { int32 } from "../lib/Numbers/int32";
import { CompileError } from "../lib/Numbers/err";
import { isKnownOp } from "../lib/mips-machine/ctrl";
import { VALS } from "../lib/mips-machine/vals";
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
import { REGISTERS } from "../lib/mips-isa/registers";
import { collectProgramRefs, type ProgramRefs } from "../lib/mips-machine/programRefs";
import { checkProgram, checkSource } from "../lib/mips-machine/staticCheck";
import type { ProgramLine } from "../lib/mips-machine/interpreter";
import type { CycleStage } from "../lib/mips-machine/machineState";
import type { DataDecl, NumNode } from "../lib/mips-parser/ast";
import "./theme.css";
import "./App.css";

const DEFAULT_SOURCE = ` # Once you write your program, click assemble to run it
addi $v1, $zero, 100
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

/** The four tables in the values tray, in display order, each of which can
 * be shown or hidden from the tray's toolbar. */
type TrayTable = "registers" | "datapath" | "control" | "memory";
const TRAY_TABLES: { key: TrayTable; label: string; title: string }[] = [
  { key: "registers", label: "Registers", title: "Register file values ($pc, $zero, $v0…)" },
  { key: "datapath", label: "Datapath", title: "Values on the datapath's wires and pipeline registers" },
  { key: "control", label: "Control", title: "Control signals for each instruction kind" },
  { key: "memory", label: "Memory", title: "Data memory contents" },
];

function regName(num: number): string {
  const name = REGISTERS.find((r) => r.num === num)?.name;
  return name ? `$${name}` : `$${num}`;
}

// ---- Error reporting --------------------------------------------------------

/** One problem to report: a 1-indexed source line (0 = no line known), what's
 * wrong, and optionally how to fix it. */
interface Problem {
  line: number;
  message: string;
  hint?: string;
}

/**
 * Console text for a list of problems: a heading when there's more than
 * one, then for each "Error at line N (0xA): message" (lineRef: the line
 * number and the editor gutter's address for it), the source line itself
 * (so the line number can be matched up without counting), and the hint.
 */
function formatProblems(problems: Problem[], source: string, opts: { kind?: string; more?: number } = {}): string[] {
  const kind = opts.kind ?? "Error";
  const srcLines = source.split(/\r\n|\r|\n/);
  const out: string[] = [];
  const total = problems.length + (opts.more ?? 0);
  if (total > 1) out.push(`Assembly failed: ${total} problems found.`, "");
  problems.forEach((p, i) => {
    out.push(p.line > 0 ? `${kind} at ${lineRef(p.line)}: ${p.message}` : `${kind}: ${p.message}`);
    const text = p.line > 0 ? srcLines[p.line - 1] : undefined;
    if (text !== undefined && text.trim() !== "") out.push(`    ${p.line} | ${text.trim()}`);
    if (p.hint) out.push(`    Hint: ${p.hint}`);
    if (i < problems.length - 1) out.push("");
  });
  if (opts.more) out.push("", `…and ${opts.more} more. Fix these and press Assemble again to see the rest.`);
  return out;
}

/** The pipeline register zeroed to flush an instruction in each stage. */
const FLUSH_REGISTER: Partial<Record<CycleStage, string>> = { F: "IF/ID", D: "ID/EX", A: "EX/MEM" };

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
  early: boolean,
): ForwardingRowsData["note"] {
  const at = (stage: CycleStage) => slots.find((s) => s.stage === stage);
  const ex = at("A");
  const id = at("D");
  const mem = at("M");
  const info = (text: string) => ({ kind: "info" as const, text });

  // A taken branch or jump resolving (in ID with early branches, else in
  // MEM), flushing the wrong-path fetches behind it.
  const flushed = slots.filter((s) => s.flushed).sort((a, b) => a.seq - b.seq);
  const resolver = early ? id : mem;
  if (flushed.length > 0 && resolver) {
    const where = early ? "ID" : "MEM";
    const what = isJumpOp(resolver.op)
      ? `${resolver.op} is a jump, and jumps resolve in ${where}`
      : early
        ? `${resolver.op} is taken: the comparator in ID found its condition true`
        : `${resolver.op} is taken: it resolves in MEM, from the ALU's isZero? latched in EX/MEM`;
    const ops = flushed.map((s) => s.op).join(", ");
    const these = flushed.length === 1 ? `${ops} was fetched` : `${ops} were fetched`;
    const regs = flushed.map((s) => FLUSH_REGISTER[s.stage]).filter(Boolean).join(", ");
    return info(
      `Misprediction: ${what}. ${these} because the pipeline predicts not taken, so ${flushed.length === 1 ? "it's" : "they're"} ` +
        `flushed (${regs} ${flushed.length === 1 ? "is" : "are"} zeroed, leaving bubbles) and MUX 4/5 send the target to PC instead.`,
    );
  }
  // The stall cycle: IF and ID held.
  const heldInId = slots.find((s) => s.stalled && s.stage === "D");
  if (heldInId) {
    const head =
      `Stall: ${heldInId.op} is held in ID (and the next instruction in IF) because PC and IF/ID aren't written ` +
      `this cycle, and a bubble (nop) enters EX.`;
    if (!early || !isBranchOp(heldInId.op)) {
      return info(`${head} ${mem?.op ?? "The load"} is in MEM, reading the data ${heldInId.op} needs.`);
    }
    const again = stallReason(heldInId.state, ex?.state, mem?.state, early) === "branch-mem";
    return info(
      again
        ? `${head} ${mem?.op ?? "The load"} is now in MEM, but its data is only ready at the end of MEM, so the branch stalls once more.`
        : `${head} Next cycle its operand can be forwarded to the comparator.`,
    );
  }
  // Detection: the hazard detection unit fires; next cycle stalls.
  const reason = stallReason(id?.state, ex?.state, mem?.state, early);
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
    return info(
      early
        ? `The flushed instruction is a bubble in ID; the branch target is in IF.`
        : `The flushed instructions are bubbles in ID, EX and MEM; the branch target is in IF.`,
    );
  }
  // A branch resolving not taken: the prediction was right.
  if (resolver && isBranchOp(resolver.op) && !resolver.wires.includes("ADD2_MUX4")) {
    return info(
      early
        ? `${resolver.op} is not taken: the comparator in ID found its condition false, so the predicted instruction in IF carries on.`
        : `${resolver.op} is not taken (resolved in MEM), so the instructions fetched after it carry on.`,
    );
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
 * later). programRefs.ts's dataSegmentBytes() mirrors this layout too. */
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
  const { theme, toggle: toggleTheme, aceTheme } = useTheme();
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
  // Pipeline hazards: draws the forwarding hardware (MUX 6/7 in EX), adds
  // the forwarding signals to the Control table, and turns on the hazard
  // detection unit and predict-not-taken fetching: load-use hazards stall,
  // taken branches and jumps flush (see also early branches below). Toggling it
  // doesn't restart the run: it recomputes the cycles after the one on
  // screen. Only offered in pipeline mode; the choice is remembered while
  // pipeline mode is off.
  const [showHazards, setShowHazards] = useState(false);
  const hazards = showPipeline && showHazards;
  // Early branches (within hazards mode): resolve branches and jumps in ID,
  // with the comparator, its forwarding muxes and MUX 4/5 moved forward
  // (one instruction flushed on a taken branch). Off, they resolve at MUX
  // 4/5 after EX/MEM (three flushed). Like the hazards toggle, it doesn't
  // restart the run.
  const [showEarlyBranch, setShowEarlyBranch] = useState(false);
  const earlyBranch = hazards && showEarlyBranch;

  // ---- Values tray: which tables are shown, and how much of each ------
  const [visibleTables, setVisibleTables] = useState<Record<TrayTable, boolean>>({
    registers: true,
    datapath: true,
    control: true,
    memory: true,
  });
  // Off: the register and memory tables only list what the assembled
  // program refers to. On: every register and memory word.
  const [showAllValues, setShowAllValues] = useState(false);
  // What the last successfully assembled program refers to (see
  // programRefs.ts). null until the first Assemble, when there's no
  // program to filter by yet, so everything is shown.
  const [programRefs, setProgramRefs] = useState<ProgramRefs | null>(null);
  // Memory words read or written since the last Assemble — addresses a
  // program computes at run time can't be known from its source, so they
  // join the memory table the first time they're touched, and stay.
  // (Words touched anywhere on the precomputed timeline are added too, via
  // machine.touchedWords, so rows don't pop in while scrubbing.)
  const [touchedMemory, setTouchedMemory] = useState<Set<number>>(() => new Set());

  const dispContainerRef = useRef<HTMLDivElement>(null);
  const consContainerRef = useRef<HTMLDivElement>(null);
  const dispEditor = useAceEditor(dispContainerRef, { mode: "ace/mode/mips", pcNum: true, write: false, theme: aceTheme });
  const consEditor = useAceEditor(consContainerRef, { mode: "ace/mode/text", write: false, number: false, theme: aceTheme });

  const [program, setProgram] = useState<ProgramLine[]>([]);
  // keep track of line numbers disregarding labels
  const [programSourceLines, setProgramSourceLines] = useState<number[]>([]);
  const [speedMs, setSpeedMs] = useState(500);
  const [playing, setPlaying] = useState(false);

  const regBank = useRegisterBank();
  const memBank = useMemoryBank(256);
  const ctrlBank = useCtrlBank();
  const valsBank = useValsBank();
  const machine = useMachineHistory(program, regBank, memBank, showPipeline, hazards, earlyBranch);

  // The tables edit the banks through these: a hand edit becomes part of
  // the step on screen, and the rest of the timeline is recomputed from it.
  const tableRegBank: RegisterBank = {
    ...regBank,
    trySave: (name, text) => {
      const ok = regBank.trySave(name, text);
      if (ok) machine.rebase();
      return ok;
    },
  };
  const tableMemBank: MemoryBank = {
    ...memBank,
    trySave: (wordIndex, text) => {
      const ok = memBank.trySave(wordIndex, text);
      if (ok) machine.rebase();
      return ok;
    },
  };

  // Any memory cell marked this render (read = success, written = warning,
  // bad edit = danger) has been touched: remember it.
  useEffect(() => {
    setTouchedMemory((prev) => {
      const added = memBank.cells.flatMap((cell, i) => (cell.mark !== "default" && !prev.has(i) ? [i] : []));
      return added.length === 0 ? prev : new Set([...prev, ...added]);
    });
  }, [memBank.cells]);

  const shownRegs = useMemo(
    () => (showAllValues || programRefs === null ? null : programRefs.registers),
    [showAllValues, programRefs],
  );
  const shownWords = useMemo(
    () =>
      showAllValues || programRefs === null
        ? null
        : new Set([...programRefs.memoryWords, ...touchedMemory, ...machine.touchedWords]),
    [showAllValues, programRefs, touchedMemory, machine.touchedWords],
  );
  const shownKinds = useMemo(
    () => (showAllValues || programRefs === null ? null : programRefs.ops),
    [showAllValues, programRefs],
  );
  // For the "Hiding …" line under the toggles.
  const hiddenRegCount = shownRegs === null ? 0 : REGISTERS.filter((r) => r.num !== null && !shownRegs.has(r.num)).length;
  const hiddenWordCount = shownWords === null ? 0 : memBank.cells.filter((_, i) => !shownWords.has(i)).length;
  const plural = (n: number, word: string) => `${n} unused ${word}${n === 1 ? "" : "s"}`;
  const hiddenParts = [
    hiddenRegCount > 0 ? plural(hiddenRegCount, "register") : null,
    hiddenWordCount > 0 ? plural(hiddenWordCount, "memory word") : null,
  ].filter((p): p is string => p !== null);
  // e.g. "22 unused registers and 64 unused memory words"
  const hiddenSummary = hiddenParts.join(" and ");

  // This cycle's Fwdop1/Fwdop2 (for the instruction in EX) and
  // FwdRD1/FwdRD2 (for a branch in ID), from the instructions in MEM and WB.
  const forwarding = useMemo(
    () => (hazards ? computeForwarding(machine.pipelineSlots, earlyBranch) : null),
    [hazards, earlyBranch, machine.pipelineSlots],
  );
  const branchForwarding = useMemo(
    () => (earlyBranch ? computeBranchForwarding(machine.pipelineSlots) : null),
    [earlyBranch, machine.pipelineSlots],
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
          ...(earlyBranch
            ? [
                { name: "FwdRD1", op: branchForwarding?.id.op ?? null, value: formatFwd(branchForwarding?.fwdRd1 ?? FWD_NONE) },
                { name: "FwdRD2", op: branchForwarding?.id.op ?? null, value: formatFwd(branchForwarding?.fwdRd2 ?? FWD_NONE) },
              ]
            : []),
        ],
        note: hazardNote(machine.pipelineSlots, machine.pipelineBubbles, forwarding, branchForwarding, earlyBranch),
      }
    : undefined;

  // keep the latest copies in a ref, updated unconditionally
  // every render (not inside an effect), and have effects read from the
  // ref instead of depending on the object directly.
  const actionsRef = useRef({ codeEditor, dispEditor, consEditor, valsBank, ctrlBank, step: machine.step, programSourceLines, pipelineSlots: machine.pipelineSlots });
  actionsRef.current = { codeEditor, dispEditor, consEditor, valsBank, ctrlBank, step: machine.step, programSourceLines, pipelineSlots: machine.pipelineSlots };
  // Whether the console/editor currently show a run-time error (from the
  // step on screen), so scrubbing away from that step can clear it again.
  const showingRunErrorRef = useRef(false);
  // The last assembled .data segment (without line numbers), to tell
  // whether a re-assemble left it unchanged — a condition for resuming.
  const lastDataKeyRef = useRef<string | null>(null);

  // ---- Parse / assemble --------------------------------------------------
  const handleParse = useCallback(() => {
    if (!codeEditor || !dispEditor || !consEditor) return;
    setPlaying(false);
    consEditor.load("");
    showingRunErrorRef.current = false;

    const source = codeEditor.value();
    // Logs problems to the console and marks each line in the editor.
    const report = (problems: Problem[], opts?: { kind?: string; more?: number }) => {
      for (const text of formatProblems(problems, source, opts)) consEditor.log(text);
      codeEditor.err(problems.filter((p) => p.line > 0).map((p) => p.line - 1));
    };

    const result = parseMips(source);
    if (!result.ok) {
      report(result.diagnostics, { more: result.more });
      return;
    }

    try {
      const { text, data } = result.program.prop;
      check(text, data);
      checkSource(text, data); // la not supported yet — see staticCheck.ts
      const assembled = assemble(text, data); // AssembledLine[] w kind, lbl, inst, cmt, loc, pc, 32 bit instruction

      const programLines: ProgramLine[] = assembled.map((line) => ({
        op: line.prop.inst.prop.op,
        bin: line.prop.bin,
      }));
      // .data too big for memory: caught here, at its line, rather than
      // inside initializeMemory() with no line. Bad lw/sw/lb/sb addresses
      // are left to the test run below and to run time.
      checkProgram(data, memBank.size);
      // Same index space as programLines above — line.prop.loc is
      // 1-indexed (PEG.js convention), Ace rows are 0-indexed.
      const sourceLines: number[] = assembled.map((line) => line.prop.loc - 1);
      const refs = collectProgramRefs(assembled.map((line) => line.prop.inst), data);

      // A fix for the run-time error the run stopped on? Same .data, and
      // the same instructions except the one that failed: keep the run up
      // to just before that instruction and carry on from there.
      const dataKey = JSON.stringify(data, (key, value) => (key === "loc" ? undefined : value));
      const resume = dataKey === lastDataKeyRef.current ? machine.planResume(programLines) : null;

      // Test-run it before accepting it: build its whole run now (from the
      // resume point, or from the start with .data loaded and $pc at 0).
      // If the run hits a run-time error, nothing changes — the previous
      // program and its run stay — and the error is reported like any
      // other assembly error, at its line.
      const runError = machine.prepare(
        programLines,
        resume,
        () => {
          // Clear the previous run's memory marks first, so they don't
          // count as "touched" by this new program.
          memBank.RES();
          initializeMemory(data, memBank);
          regBank.WR("pc", int32.num(0));
        },
      );
      if (runError) {
        const line = sourceLines[runError.pc] ?? -1;
        report([
          {
            line: line + 1,
            message: runError.message,
            hint:
              `Found by test-running the program ${resume ? "from where it stopped" : "from the current register and memory values"} ` +
              `before assembling. Fix the line and press Assemble again.`,
          },
        ], { kind: "Run-time error" });
        return;
      }

      lastDataKeyRef.current = dataKey;
      dispEditor.load(mipsUtil.print(assembled));
      codeEditor.reset();
      dispEditor.reset();
      setProgram(programLines);
      setProgramSourceLines(sourceLines);
      setProgramRefs(refs);
      if (resume) {
        consEditor.log(
          `Fixed ${lineRef(sourceLines[resume.pc] + 1)}: resuming just before it runs ` +
            `(${showPipeline ? "cycle" : "step"} ${resume.frame}). Earlier steps are kept.`,
        );
      } else {
        setTouchedMemory(new Set());
        consEditor.log(`Assembled ${programLines.length} instruction${programLines.length === 1 ? "" : "s"} with no errors.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Every CompileError (mips-util's assembler checks and staticCheck's)
      // carries its source line in `loc` and leaves the line number out of
      // its message, so all of them print in the same "Error at line N"
      // form. Anything else has no line.
      const loc = err instanceof CompileError ? err.loc : 0;
      report([{ line: loc, message }]);
    }
  }, [codeEditor, dispEditor, consEditor, memBank, regBank, machine, showPipeline]);

  // ---- Step / Back / Seek ---------------------------------------------
  const handleStep = useCallback(() => {
    machine.step();
  }, [machine]);

  const handleStepBack = useCallback(() => {
    setPlaying(false);
    machine.stepBack();
  }, [machine]);

  const handleSeek = useCallback(
    (position: number) => {
      setPlaying(false);
      machine.seek(position);
    },
    [machine],
  );

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
  }, [playing, machine.position, machine.canStep, speedMs]);

  // ---- Mirror the MachineState on screen out to the editors + tables ------
  useEffect(() => {
    const state = machine.current;
    const { codeEditor, consEditor, valsBank, ctrlBank, programSourceLines, pipelineSlots } = actionsRef.current;

    ctrlBank.RES();
    valsBank.RES();

    // Clear a run-time error shown for another step.
    if (showingRunErrorRef.current && !state?.error) {
      consEditor?.load("");
      codeEditor?.err(-1);
      showingRunErrorRef.current = false;
    }

    // Before the first step (the scrubber's start, or right after a reset
    // or a mode switch): no instruction is current.
    if (!state) {
      codeEditor?.markColours([]);
      codeEditor?.mark(-1);
      codeEditor?.next(-1);
    }
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
      // Shown fresh each time this step comes on screen (it may be visited
      // many times while scrubbing), rather than appended.
      consEditor.load("");
      const lines = formatProblems(
        [
          {
            line: editorLine + 1,
            message: state.error,
            hint: `Fix this line (without changing any other instruction or the .data) and press Assemble to resume from here.`,
          },
        ],
        codeEditor.value(),
        { kind: "Run-time error" },
      );
      for (const text of lines) consEditor.log(text);
      codeEditor.err(editorLine);
      showingRunErrorRef.current = true;
      setPlaying(false);
      return;
    }

    // vals: every key present this step gets repainted as "just updated".
    // Iterates VALS rather than Object.entries(state.vals), whose keys are
    // plain strings, so every key handed to WR() is a checked ValKey.
    for (const { key } of VALS) {
      const bits = state.vals[key];
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
    // Re-runs on a new program too: Assemble clears the editor's markers,
    // and after a fix-and-resume the step on screen may not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.current, programSourceLines]);

  // Load the default instructions upon starting
  useEffect(() => {
    if (!codeEditor) return;
    codeEditor.load(DEFAULT_SOURCE);
  }, [codeEditor]);

  const noTablesShown = TRAY_TABLES.every(({ key }) => !visibleTables[key]);
  const dark = theme === "dark";

  return (
    <div className="app">
      <header className="app-toolbar">
        <h1>MIPS Datapath Simulator</h1>
        <button
          type="button"
          className="app-theme-toggle"
          onClick={toggleTheme}
          aria-pressed={dark}
          title={dark ? "Switch to light mode" : "Switch to dark mode"}
        >
          <span className="app-theme-toggle-icon" aria-hidden="true">
            {dark ? "☀" : "☾"}
          </span>
          {dark ? "Light mode" : "Dark mode"}
        </button>
        <div className="app-toolbar-controls">
          <button onClick={handleParse}>Assemble</button>
          <button onClick={handleStepBack} disabled={!machine.canStepBack} title="One step back">
            Back
          </button>
          <button onClick={handleStep} disabled={!machine.canStep} title="One step forward">
            Step
          </button>
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
              cycle={machine.position}
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
        <Scrubber
          timeline={machine.timeline}
          position={machine.position}
          pipeline={showPipeline}
          complete={machine.complete}
          onSeek={handleSeek}
        />
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
          <AceEditorPanel onReady={setCodeEditor} theme={aceTheme} />
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
          <div className="app-diagram-toolbar" role="group" aria-label="Diagram toggles">
            <span className="app-diagram-toolbar-label">Toggles:</span>
            <button
              className={showShift ? "app-diagram-toggle app-diagram-toggle-on" : "app-diagram-toggle"}
              onClick={() => setShowShift((s) => !s)}
              aria-pressed={showShift}
              title={showShift ? "Hide shift (sll/srl) artwork" : "Show shift (sll/srl) artwork"}
            >
              Shift
            </button>
            <button
              className={showJump ? "app-diagram-toggle app-diagram-toggle-on" : "app-diagram-toggle"}
              onClick={() => setShowJump((j) => !j)}
              aria-pressed={showJump}
              title={showJump ? "Hide jump (j) artwork" : "Show jump (j) artwork"}
            >
              Jump
            </button>
            <button
              className={showPipeline ? "app-diagram-toggle app-diagram-toggle-on" : "app-diagram-toggle"}
              onClick={() => {
                // The two modes step differently (micro-step vs. clock
                // cycle), so a run in progress can't carry over: rewind to
                // the start (putting the starting register/memory values
                // back) and build the other mode's timeline from there.
                setPlaying(false);
                machine.seek(0);
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
              Pipeline
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
                Pipeline Hazards
              </button>
            )}
            {hazards && (
              <button
                className={showEarlyBranch ? "app-diagram-toggle app-diagram-toggle-on" : "app-diagram-toggle"}
                onClick={() => setShowEarlyBranch((e) => !e)}
                aria-pressed={showEarlyBranch}
                title={
                  showEarlyBranch
                    ? "Resolve branches in MEM again: up to three wrong-path instructions flushed"
                    : "Resolve branches in ID: comparator and forwarding in ID, one wrong-path instruction flushed"
                }
              >
                Early Branch
              </button>
            )}
          </div>
          <div className="app-diagram">
            <DatapathDiagram
              activeWires={machine.current?.activeWires ?? []}
              state={machine.current}
              features={{ shift: showShift, jump: showJump, pipeline: showPipeline, hazards, earlyBranch }}
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
              <div className="app-tables-toolbar">
                <div className="app-tables-toolbar-row" role="group" aria-label="Tables to show">
                  <span className="app-tables-toolbar-label">Show</span>
                  {TRAY_TABLES.map(({ key, label, title }) => (
                    <button
                      key={key}
                      type="button"
                      className={visibleTables[key] ? "app-tables-chip app-tables-chip-on" : "app-tables-chip"}
                      onClick={() => setVisibleTables((v) => ({ ...v, [key]: !v[key] }))}
                      aria-pressed={visibleTables[key]}
                      title={`${visibleTables[key] ? "Hide" : "Show"}: ${title}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="app-tables-showall">
                  <input
                    type="checkbox"
                    checked={showAllValues}
                    onChange={(e) => setShowAllValues(e.target.checked)}
                  />
                  Display all registers, memory &amp; control signals
                </label>
                {!showAllValues && programRefs === null && (
                  <div className="app-tables-filter-note">Once you assemble a program, only relevant registers and memory will remain!</div>
                )}
                {!showAllValues && programRefs !== null && hiddenSummary && (
                  <div className="app-tables-filter-note">Hiding {hiddenSummary}.</div>
                )}
              </div>

              {visibleTables.registers && <RegisterTable bank={tableRegBank} shownRegs={shownRegs} />}
              {visibleTables.datapath && <ValsTable bank={valsBank} />}
              {visibleTables.control && <ControlTable bank={ctrlBank} forwarding={forwardingRows} shownKinds={shownKinds} />}
              {visibleTables.memory && <MemoryTable bank={tableMemBank} shownWords={shownWords} />}
              {noTablesShown && <div className="app-tables-filter-note">All tables are hidden. Pick one above to show it.</div>}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}