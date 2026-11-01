/**
 * Builders for the AST that mips.peggy produces, so the assembler, static
 * checks, interpreter and pipeline can be tested without going through the
 * generated parser. The node shapes and the I32/U32 number encoding are
 * copied from the grammar's action helpers, so a node built here is the same
 * object parseMips() would return for the equivalent source line.
 *
 * Register names are bare ("t0", "zero"); the leading "$" is added, as the
 * grammar's REG() does.
 */
import type {
  BInstr, DataDecl, IInstr, Instr, JInstr, LInstr, MInstr, NumNode, RegNode, RInstr, SInstr, TextLine, UInstr,
  VInstr,
} from "../../src/lib/mips-parser/ast";
import { REGISTERS } from "../../src/lib/mips-isa/registers";

// ---- Numbers, exactly as the grammar encodes them ---------------------------

function BIT(num: number, len: number): (0 | 1)[] {
  const res: (0 | 1)[] = [];
  if (num < 0) num = 2 ** len + num;
  for (let i = 0; i < len; i++) res.push(0);
  for (let i = len - 1; i >= 0 && num > 0; i--) {
    res[i] = (num % 2) as 0 | 1;
    num = (num - res[i]) / 2;
  }
  return res;
}

/** Grammar's I32(num, len): sign-extended. */
export function I32(num: number, len: number): NumNode {
  if (num > 2 ** (len - 1)) num = num - 2 ** len;
  const bit = BIT(num, len);
  while (bit.length < 32) bit.unshift(bit[0]);
  return { kind: "num", prop: { num, bit } };
}

/** Grammar's U32(num, len): zero-extended. */
export function U32(num: number, len: number): NumNode {
  const bit = BIT(num, len);
  while (bit.length < 32) bit.unshift(0);
  return { kind: "num", prop: { num, bit } };
}

// ---- Registers ----------------------------------------------------------------

export function reg(name: string): RegNode {
  const def = REGISTERS.find((r) => r.name === name);
  if (!def || def.num === null) throw new Error(`test helper: no numbered register "${name}"`);
  return { kind: "reg", prop: { name: "$" + name, num: def.num } };
}

// ---- Instructions -------------------------------------------------------------

type ROp = RInstr["prop"]["op"];
type AOp = IInstr["prop"]["op"];
type MOp = MInstr["prop"]["op"];
type BOp = BInstr["prop"]["op"];

/** add/sub/and/or/slt $d, $s, $t */
export const R = (op: ROp, d: string, s: string, t: string): RInstr => ({
  kind: "op",
  prop: { type: "R", op, dst: reg(d), src: reg(s), tgt: reg(t) },
});

/** addi/andi/ori/xori/slti $d, $s, <decimal imm> */
export const I = (op: AOp, d: string, s: string, imm: number): IInstr => ({
  kind: "op",
  prop: { type: "I", op, dst: reg(d), src: reg(s), imm: I32(imm, 16) },
});

/** Same ops, hex immediate (0x0000-0xFFFF). */
export const L = (op: AOp, d: string, s: string, imm: number): LInstr => ({
  kind: "op",
  prop: { type: "L", op, dst: reg(d), src: reg(s), imm: I32(imm, 16) },
});

/** sll/srl $d, $t, shamt */
export const S = (op: "sll" | "srl", d: string, src: string, shamt: number): SInstr => ({
  kind: "op",
  prop: { type: "S", op, dst: reg(d), src: reg(src), sht: U32(shamt, 5) },
});

/** lw/sw/lb/sb $d, off($s) */
export const M = (op: MOp, d: string, off: number, s: string): MInstr => ({
  kind: "op",
  prop: { type: "M", op, dst: reg(d), src: reg(s), off: I32(off, 16) },
});

/** beq/bne $s, $t, label */
export const B = (op: BOp, s: string, t: string, lbl: string): BInstr => ({
  kind: "op",
  prop: { type: "B", op, src: reg(s), tgt: reg(t), lbl },
});

/** j label */
export const J = (lbl: string): JInstr => ({ kind: "op", prop: { type: "J", op: "j", lbl } });

/** lui $d, imm */
export const U = (d: string, imm: number): UInstr => ({
  kind: "op",
  prop: { type: "U", op: "lui", dst: reg(d), imm: I32(imm, 16) },
});

/** la $d, label (parses, but isn't assemblable yet). */
export const V = (d: string, name: string): VInstr => ({ kind: "op", prop: { type: "V", op: "la", dst: reg(d), name } });

// ---- Lines and programs ---------------------------------------------------------

export interface LineSpec {
  inst?: Instr | null;
  lbl?: string | null;
  cmt?: string;
  loc?: number;
}

/** A label on its own line, or a label + instruction. */
export const label = (lbl: string, inst: Instr | null = null): LineSpec => ({ lbl, inst });

/**
 * Builds TextLine[] from instructions and/or LineSpecs. Locations default to
 * 1, 2, 3... (PEG.js line numbers are 1-based).
 */
export function text(...items: (Instr | LineSpec)[]): TextLine[] {
  return items.map((item, i) => {
    const spec: LineSpec = "kind" in item ? { inst: item } : item;
    return {
      kind: "text",
      prop: { lbl: spec.lbl ?? null, inst: spec.inst ?? null, cmt: spec.cmt ?? "", loc: spec.loc ?? i + 1 },
    };
  });
}

// ---- .data declarations ---------------------------------------------------------

export const words = (name: string, vals: number[], loc = 1): DataDecl => ({
  kind: "data",
  prop: { type: "int", name, vals: vals.map((v) => I32(v, 32)), loc },
});

export const bytes = (name: string, vals: number[], loc = 1): DataDecl => ({
  kind: "data",
  prop: { type: "byte", name, vals: vals.map((v) => U32(v, 8)), loc },
});

export const asciiz = (name: string, str: string, loc = 1): DataDecl => ({
  kind: "data",
  prop: { type: "str", name, vals: str, loc },
});
