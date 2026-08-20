/**
 * Canonical control-signal table — the definitional data ctrl.js's
 * ctrl$init() built its matrix from, extracted into a plain data structure
 * (same treatment as reg.js -> registers.ts, vals.js -> vals.ts).
 *
 * ---------------------------------------------------------------------
 *
 * IMPORTANT CAVEAT — read before wiring this into mips.js:
 * Extending this *table* is necessary but NOT sufficient to actually
 * simulate the new instructions. The original 8-signal set
 * (RegDst/ALUSrc/MemToReg/RegWrite/MemRead/MemWrite/Branch/ALUctrl) was
 * built for a single-cycle datapath that only ever does "ALU(rs, rt-or-
 * imm) -> optionally-word-memory -> optionally-write-rd-or-rt, optionally
 * branch-on-zero". Four of the new instruction *families* don't fit that
 * shape no matter what values go in the table:
 *
 *   - bne needs to branch on ALUres != 0, not == 0. The original single
 *     `Branch` bit can't express "which direction". Added `BranchNE`
 *     (0 = beq's branch-on-equal behavior, 1 = bne's branch-on-not-equal)
 *     as a new column — meaningless unless Branch=1. exec() doesn't read
 *     it yet; that's mips.js-port work.
 *   - lb/sb need byte-granularity mem.lb()/mem.sb(), not mem.lw()/mem.sw()
 *     (which is all the current exec() ever calls). Added `MemByte`
 *     (1 = byte op) as a new column, same "not consumed yet" caveat.
 *   - j has no rs/rt/rd fields, no ALU operation, and unconditionally
 *     overwrites PC — none of the existing 8 signals apply to it at all.
 *     Added `Jump` as a new column; simulating it needs a real branch in
 *     exec()'s control-flow logic, not just a table value.
 *   - sll/srl's second ALU operand is the 5-bit `shamt` field at bits
 *     [10:6], not the 16-bit immediate field at [15:0] that ALUSrc's
 *     existing MUX path (processor.IMM()) reads. Setting ALUSrc=1 for
 *     them is semantically right ("operand 2 comes from the instruction
 *     encoding, not $rt") but processor.js needs a new SHAMT() extractor
 *     before that MUX path actually produces the right value.
 *
 * None of this is silently swept under the rug: every new column/code is
 * flagged above with what still needs to happen in mips.js/processor.js.
 * The alternative — leaving bne/lb/sb/j indistinguishable from beq/lw/sw/
 * (nothing) in the table just to avoid adding columns — would have made
 * ctrl.RD() stop crashing while quietly producing the *wrong* simulated
 * behavior for those ops once mips.js is ported, which is worse.
 */
export const KIND = [
  "and", "or", "add", "sub", "slt", "lw", "sw", "beq",
  "addi", "andi", "ori", "xori", "slti",
  "sll", "srl",
  "lui",
  "j",
  "bne",
  "lb", "sb",
] as const;

export type Kind = (typeof KIND)[number];

export const OPS: Record<Kind, number> = Object.fromEntries(
  KIND.map((op, i) => [op, i]),
) as Record<Kind, number>;

export interface ControlDef {
  name: string;
  /** Values per op, in KIND order. */
  values: number[];
  /** Bit width for the binary display/parse (matches ctrl$()'s `len` param)
   * — 1 for boolean flags, 4 for ALUctrl's multi-value code. */
  len: number;
}

/* eslint-disable prettier/prettier -- keep these hand-aligned by column, one per KIND entry, for reviewability */
export const CONTROLS: ControlDef[] = [
  // Ported unchanged from the original 8 columns for and/or/add/sub/slt/lw/sw/beq.
  { name: "RegDst",   len: 1, values: [1,1,1,1,1, 0,0,0,  0,0,0,0,0,  1,1,  0,  0,  0,  0,0] },
  { name: "ALUSrc",   len: 1, values: [0,0,0,0,0, 1,1,0,  1,1,1,1,1,  1,1,  1,  0,  0,  1,1] },
  { name: "MemToReg", len: 1, values: [0,0,0,0,0, 1,0,0,  0,0,0,0,0,  0,0,  0,  0,  0,  1,0] },
  { name: "RegWrite", len: 1, values: [1,1,1,1,1, 1,0,0,  1,1,1,1,1,  1,1,  1,  0,  0,  1,0] },
  { name: "MemRead",  len: 1, values: [0,0,0,0,0, 1,0,0,  0,0,0,0,0,  0,0,  0,  0,  0,  1,0] },
  { name: "MemWrite", len: 1, values: [0,0,0,0,0, 0,1,0,  0,0,0,0,0,  0,0,  0,  0,  0,  0,1] },
  // NEW — see the "IMPORTANT CAVEAT" note above for why this exists and what still needs building.
  { name: "MemByte",  len: 1, values: [0,0,0,0,0, 0,0,0,  0,0,0,0,0,  0,0,  0,  0,  0,  1,1] },
  { name: "Branch",   len: 1, values: [0,0,0,0,0, 0,0,1,  0,0,0,0,0,  0,0,  0,  0,  1,  0,0] },
  { name: "BranchNE", len: 1, values: [0,0,0,0,0, 0,0,0,  0,0,0,0,0,  0,0,  0,  0,  1,  0,0] },
  { name: "Jump",     len: 1, values: [0,0,0,0,0, 0,0,0,  0,0,0,0,0,  0,0,  0,  1,  0,  0,0] },
  // Codes 0/1/2/6/7 (AND/OR/ADD/SUB/SLT) ported unchanged. Codes 3/4/5/8
  // (XOR/SLL/SRL/LUI) are NEW reserved codes — see the caveat above for
  // which ALU-switch cases in mips.js still need to be written for them.
  { name: "ALUctrl",  len: 4, values: [0,1,2,6,7, 2,2,6,  2,0,1,3,7,  4,5,  8,  0,  6,  2,2] },
];
/* eslint-enable prettier/prettier */

/** Plain lookup into CONTROLS, independent of the React hook — used by the
 * interpreter (interpreter.ts) to read control signals while computing a
 * MachineState, without needing a component tree or any state at all. */
export function ctrlValue(name: string, op: Kind): number {
  const def = CONTROLS.find((d) => d.name === name);
  if (!def) throw new Error(`Unknown control signal "${name}"`);
  return def.values[OPS[op]];
}

/** True if `op` is one of the 20 mnemonics this table knows about — lets
 * callers fail with a clear message instead of an `undefined` lookup deep
 * inside ctrlValue. */
export function isKnownOp(op: string): op is Kind {
  return Object.prototype.hasOwnProperty.call(OPS, op);
}