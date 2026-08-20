/**
 * The state-list model that replaces processor.js + the imperative half of
 * mips.js's exec(). Separates pure computation from UI elements.
 */
import type { Int32Bits } from "../Numbers/int32";
import type { DecodedFields, WireId } from "./datapath";

export type CycleStage = "F" | "D" | "A" | "M" | "R";

/**
 * The datapath's scratch/wire values, as of the end of this micro-step.
 * Deliberately reuses vals.ts's exact key vocabulary (REGRR1, ALUres,
 * MEMAddr, ...) so there's one canonical name per wire value shared
 * between the (already-ported) ValsTable UI and this new state-history
 * model.
 */
export type ValsSnapshot = Partial<Record<string, Int32Bits>>;

export interface RegisterWrite {
  /** Bare register name, e.g. "t0", "zero" — no leading $. */
  name: string;
  value: Int32Bits;
}

export interface MemoryWrite {
  /** Byte address. */
  addr: number;
  value: Int32Bits;
  /** true = byte-granularity (sb), false = word-granularity (sw). */
  byte: boolean;
}

export interface MachineState {
  /** Which of the 5 micro-steps this snapshot represents. */
  stage: CycleStage;
  /** Index into the assembled program this state belongs to (matches
   * mips.js's `curr`). */
  pc: number;
  /** Instruction mnemonic being executed, e.g. "addi" — drives every
   * ctrl.ts lookup for this step. */
  op: string;
  /** Raw 32-bit instruction word. */
  inst: Int32Bits;
  /** OP/RS/RT/RD/SHAMT/FUNCT/IMM, decoded once per stage from `inst`. */
  fields: DecodedFields;
  /** Scratch wire values accumulated so far this instruction — see the
   * ValsSnapshot doc comment above. */
  vals: ValsSnapshot;
  /** Which named datapath segments are lit for this stage — the direct
   * replacement for processor.js's mark$* calls. */
  activeWires: WireId[];
  /** Populated only on stage "R", and only when RegWrite=1 for this op.
   * The runner hook is responsible for actually committing this to the
   * register bank — execStage() only reports it as data. */
  regWrite: RegisterWrite | null;
  /** Populated only on stage "M", and only when MemWrite=1 for this op.
   * Same "reported, not applied" contract as regWrite. */
  memWrite: MemoryWrite | null;
  /** Populated only on stage "R" — the new $pc value to commit once this
   * step finishes (every instruction ends by advancing or redirecting PC,
   * so this is always non-null on an error-free "R" state). Kept separate
   * from regWrite since a single R-stage can both write a general-purpose
   * register AND redirect $pc (e.g. any non-branch, non-jump instruction). */
  pcNext: Int32Bits | null;
  /** Set if this stage threw (e.g. an out-of-range memory access, or a
   * write to $zero). A state with an error is terminal, mirroring
   * mips.js's catch(err) block, which logs the error and halts
   * (PC(ast.length)) rather than continuing. */
  error: string | null;
}