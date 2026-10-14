/**
 * The forwarding unit, for pipeline mode's "Pipeline Hazards" toggle.
 *
 * Each cycle it computes Fwdop1 and Fwdop2 (the textbook's ForwardA and
 * ForwardB) for the instruction in EX. It compares that instruction's rs and
 * rt with the destination registers of the instructions in MEM (whose
 * values sit in the EX/MEM register) and WB (the MEM/WB register).
 *
 * Presentation only, like the other datapath toggles. PipelineEngine already
 * gives every instruction its predecessors' results (see pipeline.ts's
 * PendingState), so program values are the same with or without this. It
 * only decides which forwarding path the diagram lights and what the Control
 * table shows.
 *
 * Encoding, as on the slides:
 *   00 = no forwarding: the operand comes from ID/EX (the register file read)
 *   10 = forward from EX/MEM: the ALU result of the instruction one ahead
 *   01 = forward from MEM/WB: MUX 3's write-back value, two instructions ahead
 *
 * The load-use hazard. The EX-hazard rule compares register numbers only, so
 * it also matches a load immediately followed by an instruction that reads
 * the loaded register (lw $v1 ... ; add ..., $v1). But the value in EX/MEM at
 * that point is the load's *address*, not the loaded word, which only exists
 * once MEM finishes. Forwarding it would be wrong. The textbook pipeline
 * never gets here: its hazard detection unit spots the pair in ID
 * (ID/EX.MemRead and ID/EX.RegisterRt = IF/ID.RegisterRs/Rt), stalls one
 * cycle, and the value is then forwarded from MEM/WB (01).
 *
 * PipelineEngine doesn't stall, so when this case reaches EX the unit
 * forwards nothing (00) and sets loadUseA/loadUseB instead, which the UI
 * shows as a hazard. It doesn't fall through to the MEM-hazard rule either:
 * MEM/WB would hold an even older value of the register.
 */
import { int32 } from "../Numbers/int32";
import { ctrlValue, isKnownOp } from "./ctrl";
import type { PipelineSlotView } from "./pipeline";

export const FWD_NONE = 0b00;
export const FWD_MEM_WB = 0b01;
export const FWD_EX_MEM = 0b10;
export type ForwardSelect = typeof FWD_NONE | typeof FWD_MEM_WB | typeof FWD_EX_MEM;

export interface ForwardingSignals {
  /** The instruction in EX, which the two signals select operands for. */
  ex: PipelineSlotView;
  /** The instruction in MEM (its result is latched in EX/MEM), if any. */
  exMem: PipelineSlotView | null;
  /** The instruction in WB (its result is latched in MEM/WB), if any. */
  memWb: PipelineSlotView | null;
  /** Fwdop1 / ForwardA: selects ALUop1 (MUX 6). */
  fwdA: ForwardSelect;
  /** Fwdop2 / ForwardB: selects the register operand into MUX 2. */
  fwdB: ForwardSelect;
  /** True when rs (A) / rt (B) is the target of the load in MEM: a
   * load-use hazard real hardware would have stalled for. fwdA/fwdB are 00
   * in that case. */
  loadUseA: boolean;
  loadUseB: boolean;
}

/** The fields of a pipeline register the forwarding conditions read, named
 * as on the slides (EX/MEM.RegWrite, EX/MEM.RegisterRd, ...). RegisterRd is
 * the instruction's write register, i.e. MUX 1's choice of rd or rt. */
interface PipelineRegister {
  RegWrite: boolean;
  MemRead: boolean;
  RegisterRd: number;
}

function latched(slot: PipelineSlotView | null): PipelineRegister | null {
  if (!slot || slot.state.error || !isKnownOp(slot.op)) return null;
  const wr = slot.state.vals.REGWR;
  return {
    RegWrite: ctrlValue("RegWrite", slot.op) === 1,
    MemRead: ctrlValue("MemRead", slot.op) === 1,
    RegisterRd: wr ? int32.toNum(wr) : 0,
  };
}

interface Forward {
  sel: ForwardSelect;
  loadUse: boolean;
}

/** The slides' conditions for one operand, `source` being
 * ID/EX.RegisterRs (Fwdop1) or ID/EX.RegisterRt (Fwdop2). */
function forwardFor(source: number, exMem: PipelineRegister | null, memWb: PipelineRegister | null): Forward {
  // EX hazard:
  //   EX/MEM.RegWrite and (EX/MEM.RegisterRd ≠ 0) and (EX/MEM.RegisterRd = source)
  const exHazard = exMem !== null && exMem.RegWrite && exMem.RegisterRd !== 0 && exMem.RegisterRd === source;
  // MEM hazard (the revised condition):
  //   MEM/WB.RegWrite and (MEM/WB.RegisterRd ≠ 0)
  //   and not (EX hazard condition)
  //   and (MEM/WB.RegisterRd = source)
  const memHazard =
    memWb !== null && memWb.RegWrite && memWb.RegisterRd !== 0 && !exHazard && memWb.RegisterRd === source;

  // A load's EX/MEM value is its address, not its data: see the header.
  if (exHazard && exMem?.MemRead) return { sel: FWD_NONE, loadUse: true };
  if (exHazard) return { sel: FWD_EX_MEM, loadUse: false };
  if (memHazard) return { sel: FWD_MEM_WB, loadUse: false };
  return { sel: FWD_NONE, loadUse: false };
}

/** Forwarding signals for this cycle, or null when no (error-free)
 * instruction is in EX. */
export function computeForwarding(slots: PipelineSlotView[]): ForwardingSignals | null {
  const ex = slots.find((s) => s.stage === "A");
  if (!ex || ex.state.error) return null;
  const exMemSlot = slots.find((s) => s.stage === "M") ?? null;
  const memWbSlot = slots.find((s) => s.stage === "R") ?? null;
  const exMem = latched(exMemSlot);
  const memWb = latched(memWbSlot);

  const a = forwardFor(int32.toNum(ex.state.fields.rs), exMem, memWb);
  const b = forwardFor(int32.toNum(ex.state.fields.rt), exMem, memWb);
  return {
    ex,
    exMem: exMemSlot,
    memWb: memWbSlot,
    fwdA: a.sel,
    fwdB: b.sel,
    loadUseA: a.loadUse,
    loadUseB: b.loadUse,
  };
}

/** "00" / "01" / "10", for the Control table. */
export function formatFwd(sel: ForwardSelect): string {
  return sel.toString(2).padStart(2, "0");
}