import { int32, type Int32Bits } from "../Numbers/int32";
import { CompileError } from "../Numbers/err";
import type {
  TextLine, DataDecl, Instr, RegNode, NumNode,
} from "./ast";

const inst_l = 30;
const last_l = 8;
const op_l = 4;
const reg_l = 5;

const opcode: Record<string, Int32Bits> = {
  add: int32.hex("00"), sub: int32.hex("00"), and: int32.hex("00"), or: int32.hex("00"),
  xor: int32.hex("00"), nor: int32.hex("00"), slt: int32.hex("00"), sll: int32.hex("00"), srl: int32.hex("00"),
  addi: int32.hex("08"), slti: int32.hex("0A"), andi: int32.hex("0C"), ori: int32.hex("0D"), xori: int32.hex("0E"),
  beq: int32.hex("04"), bne: int32.hex("05"),
  lw: int32.hex("23"), sw: int32.hex("2B"), lb: int32.hex("24"), sb: int32.hex("28"),
  j: int32.hex("02"),
  // Added: real MIPS opcode for lui (0x0F). Missing from the original table
  // — translate$inst's "U" case couldn't have worked without it.
  lui: int32.hex("0F"),
};

const funct: Record<string, Int32Bits> = {
  add: int32.hex("20"), sub: int32.hex("22"), and: int32.hex("24"), or: int32.hex("25"),
  xor: int32.hex("26"), nor: int32.hex("27"), slt: int32.hex("2A"), sll: int32.hex("00"), srl: int32.hex("02"),
};

// ---- Error constructors ---------------------------------------------------

function mips$InvalidData(lbl: string, loc: number) {
  return new CompileError(`Invalid data "${lbl}" at line ${loc}`, "data", [lbl, loc], loc);
}
function mips$InvalidReg(inst: Instr, loc: number) {
  const dst = "dst" in inst.prop ? inst.prop.dst : undefined;
  return new CompileError(
    `Invalid writing to ${dst?.prop.name} in "${strip(print$inst(inst))}" at line ${loc}`,
    inst.prop.op, [inst, loc], loc,
  );
}
function mips$DuplicateLabel(lbl: string, loc: number, curr: number) {
  return new CompileError(`Duplicate label "${lbl}" at line ${loc} and line ${curr}`, "label", [lbl, loc, curr], curr);
}
function mips$UnknownLabel(lbl: string, loc: number) {
  return new CompileError(`Unknown label "${lbl}" at line ${loc}`, "label", [lbl, loc], loc);
}
function mips$OutOfRangeLabel(lbl: string, offset: number, loc: number, curr: number) {
  return new CompileError(
    `Label "${lbl}" at line ${loc} is out of range with offset ${offset} from line ${curr}`,
    "label", [lbl, offset, loc, curr], curr,
  );
}

// ---- Print utilities --------------------------------------------------

function strip(s: string): string {
  s = s.trim();
  while (s.indexOf("  ") >= 0) s = s.replace("  ", " ");
  return s.replace(" ,", ",");
}
function longestLabel(ast: TextLine[]): number {
  let len = 0;
  for (const line of ast) {
    if (line.prop.lbl !== null && line.prop.lbl.length > len) len = line.prop.lbl.length;
  }
  return len;
}
function rpad(str: string, len: number): string {
  while (str.length < len) str += " ";
  return str;
}
function print$lbl(lbl: string | null, lblLen: number): string {
  return lbl !== null ? rpad(lbl, lblLen) + ": " : rpad("", lblLen + 2);
}
function print$reg(reg: RegNode, last = false): string {
  return rpad(reg.prop.name, last ? last_l : reg_l);
}
function print$num_pad(imm: NumNode, len = last_l): string {
  return rpad(int32.toNum(imm.prop.bit).toString(), len);
}
function print_hex(imm: NumNode): string {
  return rpad("0x" + int32.toHex(imm.prop.bit).slice(-op_l), last_l);
}
function print$reg_name(reg: RegNode): string {
  return reg.prop.name;
}
function print$num(imm: NumNode): string {
  return int32.toNum(imm.prop.bit).toString();
}
function print$inst_lbl(lbl: string): string {
  return rpad(lbl, last_l);
}
function print$op(op: string): string {
  return rpad(op, op_l);
}

function print$inst(inst: Instr | null): string {
  if (inst === null) return "";
  const p = inst.prop;
  switch (p.type) {
    case "R":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print$reg(p.src) + ", " + print$reg(p.tgt, true);
    case "I":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print$reg(p.src) + ", " + print$num_pad(p.imm);
    case "L":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print$reg(p.src) + ", " + print_hex(p.imm);
    case "S":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print$reg(p.src) + ", " + print$num_pad(p.sht);
    case "M":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print$num(p.off) + "(" + print$reg_name(p.src) + ")";
    case "B":
      return print$op(p.op) + " " + print$reg(p.src) + ", " + print$reg(p.tgt) + ", " + print$inst_lbl(p.lbl);
    case "J":
      return print$op(p.op) + " " + print$inst_lbl(p.lbl);
    case "U":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print_hex(p.imm);
    case "V":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print$inst_lbl(p.name);
  }
}

function print$cmt(cmt: string): string {
  return cmt === "" ? cmt : " # " + cmt;
}

/** Pretty-prints raw parsed source (pre-assembly). Kept for parity with the
 * original — note the original never actually exported or called this
 * function either (only print_asm was exported), so it's dead code there
 * too. Exported here in case it's wanted; safe to drop otherwise. */
export function print(ast: TextLine[], lblLen = longestLabel(ast)): string {
  let res = "";
  for (const line of ast) {
    let text: string;
    if (line.prop.inst === null) {
      text = print$lbl(line.prop.lbl, lblLen) + print$cmt(line.prop.cmt).slice(1);
    } else {
      text = print$lbl(line.prop.lbl, lblLen) + rpad(print$inst(line.prop.inst), inst_l) + print$cmt(line.prop.cmt);
    }
    if (text.trim() !== "") res += text + "\n";
  }
  return res;
}

// ---- Print assembled instructions ------------------------------------

function print$asm(inst: Instr): string {
  const p = inst.prop;
  switch (p.type) {
    case "R":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print$reg(p.src) + ", " + print$reg(p.tgt, true);
    case "I":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print$reg(p.src) + ", " + print$num_pad(p.imm);
    case "L":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print$reg(p.src) + ", " + print_hex(p.imm);
    case "S":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print$reg(p.src) + ", " + print$num_pad(p.sht);
    case "M":
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print$num(p.off) + "(" + print$reg_name(p.src) + ")";
    case "B":
      // Post-assembly, B's label has been resolved to a numeric offset in
      // .prop.imm (see assemble$label) — print that, not the symbolic label.
      return print$op(p.op) + " " + print$reg(p.src) + ", " + print$reg(p.tgt) + ", " + print$num_pad((p as unknown as { imm: NumNode }).imm);
    case "J":
      return print$op(p.op) + " " + print$num_pad((p as unknown as { imm: NumNode }).imm);
    case "U":
      // Added: the original was missing this case entirely.
      return print$op(p.op) + " " + print$reg(p.dst) + ", " + print_hex(p.imm);
    case "V":
      // Not implemented — see the note on assemble()'s "la" handling below.
      // la's label hasn't been resolved to a printable form because the
      // expansion-into-lui+ori pass this needs doesn't exist yet.
      throw new Error(`print$asm: "la" is not yet assemblable — see assemble()'s notes on data-address resolution`);
  }
}

function print_asm(ast: AssembledLine[]): string {
  let res = "";
  for (const line of ast) {
    const text = rpad(print$asm(line.prop.inst), inst_l) + "# " + int32.toHex(line.prop.bin);
    if (text.trim() !== "") res += text + "\n";
  }
  return res;
}

// ---- Type checker -------------------------------------------------------

function check$dst_zero(ast: TextLine[]): void {
  for (const line of ast) {
    const inst = line.prop.inst;
    if (inst === null) continue;

    if (
      inst.prop.type === "R" ||
      inst.prop.type === "I" ||
      inst.prop.type === "L" ||
      inst.prop.type === "S"
    ) {
      if (inst.prop.dst.prop.num === 0) throw mips$InvalidReg(inst, line.prop.loc);
    } else if (inst.prop.type === "M" && (inst.prop.op === "lw" || inst.prop.op === "lb")) {
      if (inst.prop.dst.prop.num === 0) throw mips$InvalidReg(inst, line.prop.loc);
    }
  }
}

function check$dup_lbl(ast: TextLine[]): { lbl: Record<string, number>; loc: Record<string, number> } {
  const lbl: Record<string, number> = {};
  const loc: Record<string, number> = {};
  for (let i = 0; i < ast.length; i++) {
    const line = ast[i];
    if (line.prop.lbl !== null && lbl[line.prop.lbl] !== undefined) {
      throw mips$DuplicateLabel(line.prop.lbl, lbl[line.prop.lbl], line.prop.loc);
    }
    if (line.prop.lbl !== null) {
      lbl[line.prop.lbl] = line.prop.loc;
      loc[line.prop.lbl] = i;
    }
  }
  return { lbl, loc };
}

function check$valid_lbl(ast: TextLine[], lbl: Record<string, number>, loc: Record<string, number>): void {
  for (let i = 0; i < ast.length; i++) {
    const inst = ast[i].prop.inst;
    if (inst === null) continue;
    switch (inst.prop.type) {
      case "B":
      case "J": {
        if (lbl[inst.prop.lbl] === undefined) throw mips$UnknownLabel(inst.prop.lbl, ast[i].prop.loc);
        const offset = loc[inst.prop.lbl] - (i + 1);
        if (offset > 32767 || offset < -32768) {
          throw mips$OutOfRangeLabel(inst.prop.lbl, offset, lbl[inst.prop.lbl], ast[i].prop.loc);
        }
      }
    }
  }
}

function check$find_data(data: DataDecl[] | null, name: string): boolean {
  if (data === null) return false;
  return data.some((d) => d.prop.name === name);
}

function check$valid_data(ast: TextLine[], data: DataDecl[] | null): void {
  for (const line of ast) {
    const inst = line.prop.inst;
    if (inst === null) continue;
    if (inst.prop.type === "V" && !check$find_data(data, inst.prop.name)) {
      throw mips$InvalidData(inst.prop.name, line.prop.loc);
    }
  }
}

/**
 * FIX: the original's `check(ast)` took only one parameter but was declared
 * as `check(ast, data)`, so `data` was always undefined at the call site in
 * mips.js. It didn't matter there because check$valid_data (the only
 * function that reads `data`) was never actually called from check() either
 * — both bugs canceled out into "silently does nothing," rather than
 * crashing. Now that "la" needs check$valid_data for real, both are fixed:
 * `data` is a required parameter, and check$valid_data is wired in.
 *
 * Call-site update needed when mips.js is ported: `mips_util.check(ast)`
 * must become `mips_util.check(ast, data)`.
 */
export function check(ast: TextLine[], data: DataDecl[] | null): void {
  check$dst_zero(ast);
  const { lbl, loc } = check$dup_lbl(ast);
  check$valid_lbl(ast, lbl, loc);
  check$valid_data(ast, data);
}

// ---- Data segment layout --------------------------------------------

/**
 * New: computes each .data label's base address, mirroring the address-
 * assignment logic in mips.js's load() function exactly (same per-type
 * sizing/padding rules), but as a pure function that only computes
 * addresses — it doesn't touch memory. Needed to resolve "la" targets
 * during assembly (see assemble()'s notes below), and worth having mips.js's
 * eventual load() call this too, so the two address computations can't
 * drift out of sync with each other.
 */
export function layoutData(data: DataDecl[] | null): Map<string, number> {
  const bases = new Map<string, number>();
  if (data === null) return bases;
  let addr = 0;
  for (const d of data) {
    bases.set(d.prop.name, addr);
    switch (d.prop.type) {
      case "int": {
        const vals = d.prop.vals as NumNode[];
        addr += 4 * vals.length;
        break;
      }
      case "byte": {
        const vals = d.prop.vals as NumNode[];
        addr += 4 * Math.ceil(vals.length / 4);
        break;
      }
      case "str": {
        const text = (d.prop.vals as string) + "\0";
        addr += 4 * Math.ceil(text.length / 4);
        break;
      }
    }
  }
  return bases;
}

// ---- Assembler ------------------------------------------------------

/** Output of assemble$pc: every original line, +pc. `inst` may still be
 * null here (label-only/comment-only lines haven't been filtered yet). */
export interface AddressedLine {
  kind: "text";
  prop: TextLine["prop"] & { pc: number };
}

/** Output of assemble$label: lines with inst === null have been dropped
 * (mirrors the original's `if (inst === null) continue`), so `inst` is
 * guaranteed non-null from here on — this is what translate() receives. */
export interface InstructionLine {
  kind: "text";
  prop: {
    lbl: string | null;
    inst: Instr;
    cmt: string;
    loc: number;
    pc: number;
  };
}

/** Output of translate(): adds bin. Since InstructionLine already
 * guarantees inst is present, bin can be required here too — no optional
 * field, no discriminated union needed. This is the type print_asm (and
 * eventually mips.js) actually consumes. */
export interface AssembledLine {
  kind: "text";
  prop: InstructionLine["prop"] & { bin: Int32Bits };
}

function assemble$pc(ast: TextLine[]): AddressedLine[] {
  let pc = 0;
  return ast.map((line) => {
    const withPc: AddressedLine = { ...line, prop: { ...line.prop, pc } };
    if (line.prop.inst !== null) pc += 4;
    return withPc;
  });
}

function assemble$find_lbl(ast: AddressedLine[], label: string): number {
  const found = ast.find((line) => line.prop.lbl === label);
  return found ? found.prop.pc : -4;
}

function assemble$label(ast: AddressedLine[], base: number): InstructionLine[] {
  const ir: InstructionLine[] = [];
  for (const line of ast) {
    const inst = line.prop.inst;
    if (inst === null) continue;
    const pc = line.prop.pc;
    switch (inst.prop.type) {
      case "B": {
        const target = assemble$find_lbl(ast, inst.prop.lbl);
        (inst.prop as unknown as { imm: NumNode }).imm = I32((target - (pc + 4)) / 4, 32);
        break;
      }
      case "J": {
        const target = assemble$find_lbl(ast, inst.prop.lbl);
        (inst.prop as unknown as { imm: NumNode }).imm = I32(target / 4 + base / 4, 32);
        break;
      }
    }
    ir.push({ ...line, prop: { ...line.prop, inst } });
  }
  return ir;
}

// Local copies of the parser's I32/U32 helpers, needed here to build the
// resolved-immediate NumNodes for B/J after label resolution. (Same
// duplication the original had between parser.js and mips-util.js — see
// the note on this in the ast.ts/mips.peggy port. Worth eventually sharing
// one copy across the parser and this file.)
function BIT(num: number, len: number): (0 | 1)[] {
  const res: (0 | 1)[] = new Array(len).fill(0);
  if (num < 0) num = 2 ** len + num;
  for (let i = len - 1; i >= 0 && num > 0; i--) {
    res[i] = (num % 2) as 0 | 1;
    num = (num - res[i]) / 2;
  }
  return res;
}
function SIGN32(num: number, len: number): (0 | 1)[] {
  const bit = BIT(num, len);
  while (bit.length < 32) bit.unshift(bit[0]);
  return bit;
}
function I32(num: number, len: number): NumNode {
  if (num > 2 ** (len - 1)) num = num - 2 ** len;
  return { kind: "num", prop: { num, bit: SIGN32(num, len) } };
}

/**
 * "la" (V) resolution is NOT implemented here — this is a deliberate gap,
 * not an oversight, and needs a decision before it can be:
 *
 * `la $d, label` is a pseudo-instruction: it isn't real hardware, and a real
 * assembler expands it into TWO real instructions (lui + ori) before
 * assigning addresses. That means expanding it can't happen inside
 * translate() (which produces one .bin per existing AST line) — it has to
 * happen as an earlier pass that *grows the ast array*, replacing one V-type
 * TextLine with two new lines, BEFORE assemble$pc runs (since inserting an
 * extra instruction shifts every subsequent instruction's address).
 *
 * That has real UX implications this file shouldn't decide unilaterally:
 * once one source line becomes two executed instructions, what does
 * disp_editor.mark(curr)/err(curr) highlight for the second one? Does it
 * still highlight the `la` line for both steps, or introduce a synthetic
 * "half-line" concept? That's a product decision for whoever owns the
 * editor/execution UX, not something to bake in silently here.
 *
 * layoutData() above is ready to provide the resolved address once this
 * expansion pass exists — la's translate case is where it'd be used.
 */
export function assemble(ast: TextLine[], _data: DataDecl[] | null, hex?: string): AssembledLine[] {
  const base = int32.toNum(int32.and(int32.hex(hex ?? "00000000"), int32.hex("03FFFFFF")));
  const addressed = assemble$pc(ast);
  const resolved = assemble$label(addressed, base);
  return translate(resolved);
}

// ---- Translate --------------------------------------------------------

function translate$inst(inst: Instr): Int32Bits {
  let bins = int32.hex("00000000");
  const p = inst.prop;
  switch (p.type) {
    case "R":
      bins = int32.or(bins, int32.sll(opcode[p.op], 26));
      bins = int32.or(bins, int32.sll(int32.num(p.src.prop.num), 21));
      bins = int32.or(bins, int32.sll(int32.num(p.tgt.prop.num), 16));
      bins = int32.or(bins, int32.sll(int32.num(p.dst.prop.num), 11));
      bins = int32.or(bins, funct[p.op]);
      return bins;
    case "I":
    case "L":
      bins = int32.or(bins, int32.sll(opcode[p.op], 26));
      bins = int32.or(bins, int32.sll(int32.num(p.src.prop.num), 21));
      bins = int32.or(bins, int32.sll(int32.num(p.dst.prop.num), 16));
      bins = int32.or(bins, int32.and(int32.hex("0000FFFF"), p.imm.prop.bit));
      return bins;
    case "S":
      bins = int32.or(bins, int32.sll(opcode[p.op], 26));
      bins = int32.or(bins, int32.sll(int32.num(p.src.prop.num), 16));
      bins = int32.or(bins, int32.sll(int32.num(p.dst.prop.num), 11));
      bins = int32.or(bins, int32.sll(p.sht.prop.bit, 6));
      bins = int32.or(bins, funct[p.op]);
      return bins;
    case "M":
      bins = int32.or(bins, int32.sll(opcode[p.op], 26));
      bins = int32.or(bins, int32.sll(int32.num(p.src.prop.num), 21));
      bins = int32.or(bins, int32.sll(int32.num(p.dst.prop.num), 16));
      bins = int32.or(bins, int32.and(int32.hex("0000FFFF"), p.off.prop.bit));
      return bins;
    case "B":
      bins = int32.or(bins, int32.sll(opcode[p.op], 26));
      bins = int32.or(bins, int32.sll(int32.num(p.src.prop.num), 21));
      bins = int32.or(bins, int32.sll(int32.num(p.tgt.prop.num), 16));
      bins = int32.or(bins, int32.and(int32.hex("0000FFFF"), (p as unknown as { imm: NumNode }).imm.prop.bit));
      return bins;
    case "J":
      bins = int32.or(bins, int32.sll(opcode[p.op], 26));
      bins = int32.or(bins, int32.and(int32.hex("0FFFFFFF"), (p as unknown as { imm: NumNode }).imm.prop.bit));
      return bins;
    case "U":
      // Added: original had no case for this at all.
      bins = int32.or(bins, int32.sll(opcode[p.op], 26));
      bins = int32.or(bins, int32.sll(int32.num(p.dst.prop.num), 16)); // rt = dest; rs left 0
      bins = int32.or(bins, int32.and(int32.hex("0000FFFF"), p.imm.prop.bit));
      return bins;
    case "V":
      // See the assemble() notes above — not implemented pending the
      // la-expansion-pass design decision.
      throw new Error(`translate$inst: "la" cannot be encoded directly — it needs pseudo-instruction expansion, not yet implemented`);
  }
}

function translate(ast: InstructionLine[]): AssembledLine[] {
  // No inst === null guard needed: InstructionLine already guarantees a
  // present inst (assemble$label filtered those lines out before this
  // runs), confirmed this is never reachable with a null inst in practice.
  return ast.map((line) => ({ ...line, prop: { ...line.prop, bin: translate$inst(line.prop.inst) } }));
}

export default { print: print_asm, check, assemble, layoutData };