/**
 * Pure, renderer-agnostic datapath vocabulary — replaces processor.js
 * entirely, per the decision to track execution as a list of MachineState
 * snapshots instead of driving a Konva canvas imperatively.
 *
 * processor.js mixed three genuinely different things into one file:
 *   1. Konva scene construction (elem$IM/elem$PC/.../shape$ALU/shape$MUX)
 *      — pure rendering, discarded entirely. A future renderer redraws the
 *      diagram however it likes (SVG, HTML/CSS, canvas) and looks up
 *      which visual elements correspond to which WireId below.
 *   2. 22 named wire-highlight functions (mark$PC_IM, mark$RS_RR1, ...)
 *      — this WAS the interesting information: which of a fixed set of
 *      datapath segments lights up for a given micro-step. Kept below as
 *      plain string IDs (WireId) instead of imperative `.stroke(color)`
 *      calls; the interpreter (interpreter.ts) records which WireIds are
 *      active per MachineState, and a renderer just reads that list.
 *   3. Raw-instruction field extraction (get$OP/RS/RT/RD/SHAMT/FUNCT/IMM,
 *      put$INST) — real, renderer-independent logic. Kept below as
 *      decodeFields(), a pure function of the instruction bits.
 *
 * One bug found and fixed here, not preserved: the original get$IMM was
 *   bit.sign(bit.get(inst, 0, 15), 32)
 * — a 15-bit read, not 16. The immediate field is bits [15:0] everywhere
 * else in this codebase (mips-util.ts's translate$inst masks every I/L/M/B
 * immediate with 0x0000FFFF — a 16-bit mask), so a 15-bit read silently
 * drops the field's MSB (the sign bit for any negative immediate, or bit
 * 14 for anything ≥ 0x4000 unsigned) on every single decode. This would
 * have corrupted nearly every immediate-using instruction's simulated
 * value the moment mips.js was ported and actually exercised it. Fixed to
 * 16 bits.
 */
import * as bit from "../Numbers/bit";
import { int32, type Int32Bits } from "../Numbers/int32";

/**
 * The 22 named wire segments mips.js's exec() lit up per micro-step, taken
 * verbatim from processor.js's returned mark$* function names (its public
 * API — the internal per-segment `line["..."]` names that each mark$*
 * function fans out to are a drawing-layer implementation detail and
 * aren't part of this vocabulary).
 */
export const WIRES = [
  "PC_IM",
  "PC_ADD1",
  "IM_INST",
  "RS_RR1",
  "RT_RR2",
  "RT_MUX1",
  "RD_MUX1",
  "MUX1_WR",
  "IMM_MUX2",
  "IMM_ADD2",
  "ADD1_ADD2",
  "RD1_ALU1",
  "RD2_MUX2",
  "MUX2_ALU2",
  "RD2_MWD",
  "RES_MADDR",
  "RES_MUX3",
  "MRD_MUX3",
  "ADD1_MUX4",
  "ADD2_MUX4",
  "MUX4_PC",
  "MUX3_WD",
] as const;

export type WireId = (typeof WIRES)[number];

export interface DecodedFields {
  op: Int32Bits;
  rs: Int32Bits;
  rt: Int32Bits;
  rd: Int32Bits;
  shamt: Int32Bits;
  funct: Int32Bits;
  imm: Int32Bits;
}

/** Pure port of processor.js's get$OP/RS/RT/RD/SHAMT/FUNCT/IMM — bit-field
 * extraction only. No Konva side effects; put$INST's canvas-text-updating
 * half is gone (a renderer reads these fields directly instead). */
export function decodeFields(inst: Int32Bits): DecodedFields {
  return {
    op: bit.ext(bit.get(inst, 26, 6), 32),
    rs: bit.ext(bit.get(inst, 21, 5), 32),
    rt: bit.ext(bit.get(inst, 16, 5), 32),
    rd: bit.ext(bit.get(inst, 11, 5), 32),
    shamt: bit.ext(bit.get(inst, 6, 5), 32),
    funct: bit.ext(bit.get(inst, 0, 6), 32),
    // 16 bits, sign-extended — see the header comment on the original's
    // 15-bit bug.
    imm: bit.sign(bit.get(inst, 0, 16), 32),
  };
}

/** Convenience: the 26-bit jump index field (j's target), zero-extended.
 * processor.js never had this — it never supported j at all — but it's
 * the same kind of pure field extraction as the rest of this file. */
export function decodeJumpIndex(inst: Int32Bits): Int32Bits {
  return bit.ext(bit.get(inst, 0, 26), 32);
}

/** Handy for a future renderer that wants a decimal register number rather
 * than a raw bit-field, e.g. to label "$8" under the rs box. */
// TODO: Decide if this is necessary... or should directly call int32.toNum??
export function fieldToNum(field: Int32Bits): number {
  return int32.toNum(field);
}