/*
**
 * AST types for the extended MIPS parser (mips.peggy), generated via
 * peggy + ts-pegjs. Kept in sync with the grammar's action-function shapes
 * (R, M, B, I, L, S, U, V, J, REG, I32, U32, Text, Data, Prog).
 *
 * Instruction type reference:
 *   R - register arithmetic     add/sub/and/or/slt   $d, $s, $t
 *   I - immediate arithmetic (decimal immediate)   addi/andi/ori/xori/slti $d, $s, imm
 *   L - immediate arithmetic (hex immediate)        same ops, imm written as 0x..
 *   S - shift                    sll/srl             $d, $t, shamt
 *   M - memory                   lw/sw/lb/sb         $d, off($s)
 *   B - branch                   beq/bne             $s, $t, label
 *   U - load-upper-immediate     lui                 $d, imm
 *   V - load-address (pseudo)    la                  $d, label
 *   J - jump                     j                    label
 *
 * Known remaining gap (mips-util.js, not this grammar): the opcode table
 * has no "lui" entry, translate$inst has no "U"/"V" case, print$asm has no
 * "U"/"V" case, and "la" has no pseudo-instruction expansion logic. U/V
 * nodes parse correctly but won't assemble to binary until mips-util.js is
 * extended to match — tracked as follow-up when we port that file.
 */
 
/** A source location, as produced by PEG.js's location() helper. */
export interface SourceLocation {
  line: number;
}
 
export interface RegNode {
  kind: "reg";
  prop: {
    name: string; // canonical form, e.g. "$t0", "$zero", "$ra"
    num: number; // 0-31 register index
  };
}
 
export interface NumNode {
  kind: "num";
  prop: {
    num: number;
    /** 32-element array of 0|1, MSB first — sign- or zero-extended per I32/U32. */
    bit: (0 | 1)[];
  };
}
 
export interface RInstr {
  kind: "op";
  prop: { type: "R"; op: "add" | "sub" | "and" | "or" | "slt"; dst: RegNode; src: RegNode; tgt: RegNode };
}
 
export interface IInstr {
  kind: "op";
  prop: { type: "I"; op: "addi" | "andi" | "ori" | "xori" | "slti"; dst: RegNode; src: RegNode; imm: NumNode };
}
 
export interface LInstr {
  kind: "op";
  prop: { type: "L"; op: "addi" | "andi" | "ori" | "xori" | "slti"; dst: RegNode; src: RegNode; imm: NumNode };
}
 
export interface SInstr {
  kind: "op";
  prop: { type: "S"; op: "sll" | "srl"; dst: RegNode; src: RegNode; sht: NumNode };
}
 
export interface MInstr {
  kind: "op";
  prop: { type: "M"; op: "lw" | "sw" | "lb" | "sb"; dst: RegNode; src: RegNode; off: NumNode };
}
 
export interface BInstr {
  kind: "op";
  prop: { type: "B"; op: "beq" | "bne"; src: RegNode; tgt: RegNode; lbl: string };
}
 
export interface UInstr {
  kind: "op";
  prop: { type: "U"; op: "lui"; dst: RegNode; imm: NumNode };
}
 
export interface VInstr {
  kind: "op";
  prop: { type: "V"; op: "la"; dst: RegNode; name: string };
}
 
export interface JInstr {
  kind: "op";
  prop: { type: "J"; op: "j"; lbl: string };
}
 
/** Union of every instruction shape the parser can produce. */
export type Instr = RInstr | IInstr | LInstr | SInstr | MInstr | BInstr | UInstr | VInstr | JInstr;
 
export interface TextLine {
  kind: "text";
  prop: {
    lbl: string | null;
    inst: Instr | null;
    cmt: string;
    loc: number;
  };
}
 
export interface DataDecl {
  kind: "data";
  prop: {
    type: "int" | "byte" | "str";
    name: string;
    /** NumNode[] for "int"/"byte"; string for "str" (.asciiz). */
    vals: NumNode[] | string;
    loc: number;
  };
}
 
export interface Program {
  kind: "prog";
  prop: {
    /** null when no .data segment header was written at all (distinct from
     * an empty-but-present .data segment, which is []) — mirrors mips.js's
     * `if (data === null) return;` check in load(). */
    data: DataDecl[] | null;
    text: TextLine[];
  };
}
 