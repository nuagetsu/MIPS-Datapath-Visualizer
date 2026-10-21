/**
 * Friendly, line-numbered explanations for source that fails to parse.
 *
 * Peggy's own SyntaxError reports the *furthest position it got to* and the
 * full list of things it could have accepted there ("Expected "add",
 * "addi", "and", ... or [ \t] but "5" found"). That's accurate but rarely
 * says what's actually wrong, and for an out-of-range immediate it doesn't
 * even mention the number (the range check is a semantic predicate, so the
 * grammar just "fails to match" and reports whatever it tried last).
 *
 * This module re-reads the source one line at a time, with the same lexical
 * rules as mips.peggy, and names the problem on each bad line:
 *
 *   - unknown / unsupported mnemonics (with a "did you mean" suggestion)
 *   - wrong number of operands, missing or extra commas
 *   - wrong operand *type*: a register where a constant belongs, a number
 *     where a label belongs, a bare label where offset($reg) belongs, ...
 *   - out-of-range immediates (16-bit, shift amount, .byte, .word, offset)
 *   - malformed numbers ("12abc", "0XFF", "1.5", "-0x10", "+4")
 *   - unknown, reserved ($sp, $ra, $at, ...) or misspelt registers
 *   - .data / .text layout rules and .word/.byte/.asciiz value types
 *
 * It's only consulted after the real parser has failed, and the real parser
 * stays the source of truth for what's valid: anything this module can't
 * explain falls back to Peggy's message, at Peggy's line.
 *
 * Keep the operand forms and ranges here in step with mips.peggy (InstInfo
 * mirrors its RInst/AInst/SInst/MInst/BInst/UInst/VInst/JInst rules, and the
 * range checks its C16_2s/C16_h2/C5/C8/C32 rules).
 */
import { REGISTERS } from "../mips-isa/registers";

// ---- Public types --------------------------------------------------------------

export interface Diagnostic {
  /** 1-indexed source line. */
  line: number;
  /** What's wrong, without the line number (callers prefix "Error at line N: "). */
  message: string;
  /** Optional suggestion for fixing it. */
  hint?: string;
  /** The offending source line, as written (for echoing in the console). */
  source: string;
}

// ---- Instruction forms (mirrors mips.peggy) ---------------------------------

type OperandKind = "reg" | "imm16" | "shamt" | "mem" | "label";

interface InstInfo {
  operands: OperandKind[];
  /** Canonical syntax, for messages: "add $rd, $rs, $rt". */
  syntax: string;
}

const R3 = (op: string): InstInfo => ({ operands: ["reg", "reg", "reg"], syntax: `${op} $rd, $rs, $rt` });
const IMM = (op: string): InstInfo => ({ operands: ["reg", "reg", "imm16"], syntax: `${op} $rt, $rs, immediate` });
const SHIFT = (op: string): InstInfo => ({ operands: ["reg", "reg", "shamt"], syntax: `${op} $rd, $rt, shamt` });
const MEM = (op: string): InstInfo => ({ operands: ["reg", "mem"], syntax: `${op} $rt, offset($rs)` });
const BR = (op: string): InstInfo => ({ operands: ["reg", "reg", "label"], syntax: `${op} $rs, $rt, label` });

const INSTRUCTIONS: Record<string, InstInfo> = {
  add: R3("add"), sub: R3("sub"), and: R3("and"), or: R3("or"), slt: R3("slt"),
  addi: IMM("addi"), andi: IMM("andi"), ori: IMM("ori"), xori: IMM("xori"), slti: IMM("slti"),
  sll: SHIFT("sll"), srl: SHIFT("srl"),
  lw: MEM("lw"), sw: MEM("sw"), lb: MEM("lb"), sb: MEM("sb"),
  beq: BR("beq"), bne: BR("bne"),
  lui: { operands: ["reg", "imm16"], syntax: "lui $rt, immediate" },
  la: { operands: ["reg", "label"], syntax: "la $rt, label" },
  j: { operands: ["label"], syntax: "j label" },
};

/** Real MIPS (or common pseudo-) instructions this simulator doesn't implement,
 * with the nearest supported way to get the same effect. */
const UNSUPPORTED: Record<string, string> = {
  addu: "use add", addiu: "use addi", subu: "use sub", sltu: "use slt", sltiu: "use slti",
  xor: "use xori with a constant, or and/or combinations", nor: "not available; combine or with xori -1",
  sra: "use srl (logical shift) instead", sllv: "only constant shift amounts are supported (sll)",
  srlv: "only constant shift amounts are supported (srl)", srav: "only constant shift amounts are supported",
  mult: "multiplication isn't supported; use repeated add or shifts",
  multu: "multiplication isn't supported; use repeated add or shifts",
  mul: "multiplication isn't supported; use repeated add or shifts",
  div: "division isn't supported; use repeated sub or shifts",
  divu: "division isn't supported; use repeated sub or shifts",
  mfhi: "hi/lo registers aren't supported", mflo: "hi/lo registers aren't supported",
  lh: "use lw or lb", lhu: "use lw or lb", lbu: "use lb", sh: "use sw or sb",
  jal: "function calls aren't supported; use j", jr: "register jumps aren't supported; use j label",
  jalr: "register jumps aren't supported; use j label",
  li: "use addi $rt, $zero, value (or lui + ori for 32-bit values)",
  move: "use add $rd, $rs, $zero",
  nop: "use sll $t0, $t0, 0 (or any instruction with no effect)",
  b: "use j label, or beq $zero, $zero, label",
  beqz: "use beq $rs, $zero, label", bnez: "use bne $rs, $zero, label",
  blt: "use slt then bne", bgt: "use slt then bne", ble: "use slt then beq", bge: "use slt then beq",
  bltz: "use slt then bne", bgtz: "use slt then bne", blez: "use slt then beq", bgez: "use slt then beq",
  not: "use xori $rd, $rs, -1", neg: "use sub $rd, $zero, $rs",
  syscall: "system calls aren't supported", break: "not supported",
};

/** R-type -> its immediate twin, for "use a constant" hints. */
const IMMEDIATE_TWIN: Record<string, string> = { add: "addi", and: "andi", or: "ori", slt: "slti" };
/** Immediate -> its register twin, for "use two registers" hints. */
const REGISTER_TWIN: Record<string, string> = { addi: "add", andi: "and", ori: "or", slti: "slt", xori: "or/and" };

// ---- Registers (same table as the grammar: mips-isa/registers.ts) -------------

const USABLE_BY_NAME = new Map<string, number>();
const USABLE_BY_NUM = new Map<number, string>();
for (const r of REGISTERS) {
  if (r.num === null) continue;
  USABLE_BY_NAME.set(r.name, r.num);
  USABLE_BY_NUM.set(r.num, r.name);
}
const RESERVED_NAMES: Record<string, string> = {
  at: "the assembler temporary", k0: "reserved for the OS kernel", k1: "reserved for the OS kernel",
  gp: "the global pointer", sp: "the stack pointer", fp: "the frame pointer", ra: "the return address",
};
const RESERVED_NUMS: Record<number, string> = { 1: "at", 26: "k0", 27: "k1", 28: "gp", 29: "sp", 30: "fp", 31: "ra" };
const USABLE_SUMMARY = "$zero, $v0–$v1, $a0–$a3, $t0–$t9, $s0–$s7";

// ---- Small helpers ---------------------------------------------------------------

const LABEL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** The closest candidate within a small edit distance, or null. */
function closest(word: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(word, c);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  const limit = word.length <= 3 ? 1 : 2;
  return bestDist <= limit ? best : null;
}

function ordinal(n: number): string {
  return ["first", "second", "third", "fourth", "fifth"][n - 1] ?? `#${n}`;
}

/** Splits off a trailing "# comment", ignoring "#" inside a "string". */
function stripComment(line: string): { code: string; comment: boolean } {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr && ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"') inStr = !inStr;
    else if (ch === "#" && !inStr) return { code: line.slice(0, i), comment: true };
  }
  return { code: line, comment: false };
}

class LineError {
  message: string;
  hint?: string;
  constructor(message: string, hint?: string) {
    this.message = message;
    this.hint = hint;
  }
}
const fail = (message: string, hint?: string): never => {
  throw new LineError(message, hint);
};

// ---- Numbers -----------------------------------------------------------------------

interface ParsedNum {
  value: number;
  hex: boolean;
}

/** Parses one numeric literal the way the grammar's Int/Hex rules do, or
 * explains why it isn't one. `what` names the operand in messages. */
function parseNumber(tok: string, what: string): ParsedNum {
  if (/^-?[0-9]+$/.test(tok)) return { value: parseInt(tok, 10), hex: false };
  if (/^0x[0-9A-Fa-f]+$/.test(tok)) return { value: parseInt(tok, 16), hex: true };
  if (/^0X[0-9A-Fa-f]+$/.test(tok)) fail(`${what} "${tok}" uses a capital X`, `Write hex numbers with a lowercase x: ${"0x" + tok.slice(2)}`);
  if (/^-0x[0-9A-Fa-f]+$/i.test(tok)) {
    fail(`${what} "${tok}" is a negative hex number, which isn't allowed`, `Write it in decimal instead: ${-parseInt(tok.slice(3), 16)}`);
  }
  if (/^\+[0-9]+$/.test(tok)) fail(`${what} "${tok}" has a "+" sign, which isn't allowed`, `Write ${tok.slice(1)}`);
  if (/^-?[0-9]*\.[0-9]+$|^-?[0-9]+\.[0-9]*$/.test(tok)) fail(`${what} "${tok}" is a decimal fraction — only whole numbers are supported`);
  if (/^0x$/i.test(tok)) fail(`${what} "${tok}" has no digits after 0x`);
  if (/^0x/i.test(tok)) fail(`${what} "${tok}" isn't a valid hex number`, "Hex digits are 0–9 and a–f");
  if (/^-?[0-9]+[A-Za-z_]/.test(tok)) fail(`${what} "${tok}" isn't a valid number`, "Hex numbers need a 0x prefix, e.g. 0x1F");
  if (/^'.*'$/.test(tok)) fail(`${what} ${tok} is a character literal, which isn't supported`, `Use its ASCII code instead`);
  return fail(`${what} "${tok}" isn't a number`);
}

/** A 16-bit immediate, as C16_2s (decimal) / C16_h2 (hex) accept it. */
function checkImm16(tok: string, what: string, op: string): void {
  const n = parseNumber(tok, what);
  if (n.hex && n.value > 0xffff) {
    fail(
      `${what} ${tok} is out of range for ${op}: hex immediates must be between 0x0 and 0xFFFF (16 bits)`,
      op === "lui" ? undefined : `For larger constants, build the value with lui (upper 16 bits) then ori (lower 16 bits)`,
    );
  }
  if (!n.hex && (n.value < -32768 || n.value > 32767)) {
    fail(
      `${what} ${tok} is out of range for ${op}: decimal immediates must be between -32768 and 32767 (16 bits)`,
      op === "lui"
        ? `lui takes the upper 16 bits only, e.g. lui $t0, 0x1234`
        : `For larger constants, build the value with lui (upper 16 bits) then ori (lower 16 bits)`,
    );
  }
}

// ---- Registers -----------------------------------------------------------------

function checkRegister(tok: string, where: string): void {
  const at = ` (${where})`;
  const num = /^\$([0-9]+)$/.exec(tok);
  if (num) {
    const n = parseInt(num[1], 10);
    if (USABLE_BY_NUM.has(n)) return;
    if (n in RESERVED_NUMS) {
      fail(`${tok} is $${RESERVED_NUMS[n]}, ${RESERVED_NAMES[RESERVED_NUMS[n]]}, which this simulator reserves${at}`, `Usable registers: ${USABLE_SUMMARY}`);
    }
    fail(`${tok} doesn't exist: MIPS has registers $0–$31${at}`, `Usable registers: ${USABLE_SUMMARY}`);
  }
  const named = /^\$([A-Za-z0-9]+)$/.exec(tok);
  if (named) {
    const name = named[1].toLowerCase();
    if (USABLE_BY_NAME.has(name)) return;
    if (name in RESERVED_NAMES) {
      fail(`$${name} is ${RESERVED_NAMES[name]}, which this simulator reserves${at}`, `Use one of: ${USABLE_SUMMARY}`);
    }
    if (name === "pc") fail(`$pc can't be used in an instruction${at} — it's only changed by branches and jumps`);
    const guess = closest(name, USABLE_BY_NAME.keys());
    fail(`"${tok}" isn't a register${at}`, guess ? `Did you mean $${guess}?` : `Usable registers: ${USABLE_SUMMARY}`);
  }
  if (tok === "$") fail(`There's a "$" with no register name after it${at}`);
  if (/^\$\s/.test(tok)) fail(`"${tok}" has a space after "$"${at}`, `Write it without the space, e.g. $t0`);
  fail(`"${tok}" isn't a valid register name${at}`, `Usable registers: ${USABLE_SUMMARY}`);
}

// ---- Operands ------------------------------------------------------------------

type TokenKind = "reg" | "number" | "mem" | "label" | "string" | "other";

function kindOf(tok: string): TokenKind {
  if (tok.startsWith("$")) return "reg";
  if (tok.includes("(") || tok.includes(")")) return "mem";
  if (/^[-+]?[0-9.]/.test(tok) || /^'/.test(tok)) return "number";
  if (tok.startsWith('"')) return "string";
  if (LABEL_RE.test(tok)) return "label";
  return "other";
}

const describe: Record<TokenKind, string> = {
  reg: "a register",
  number: "a number",
  mem: "a memory operand",
  label: "a label",
  string: "a string",
  other: "not a recognisable operand",
};

function checkOperand(op: string, info: InstInfo, index: number, tok: string, all: string[]): void {
  const expected = info.operands[index];
  const what = `The ${ordinal(index + 1)} operand of ${op}`;
  const kind = kindOf(tok);

  switch (expected) {
    case "reg": {
      if (kind === "reg") return checkRegister(tok, `${ordinal(index + 1)} operand of ${op}`);
      if (kind === "label" && USABLE_BY_NAME.has(tok.toLowerCase())) {
        fail(`${what} must be a register, but "${tok}" has no "$"`, `Write $${tok}`);
      }
      if (kind === "number") {
        const twin = IMMEDIATE_TWIN[op];
        if (twin && index === info.operands.length - 1) {
          fail(`${what} must be a register, but ${tok} is a number`, `To use a constant, use ${twin}: ${twin} ${all.slice(0, -1).join(", ")}, ${tok}`);
        }
        if (op === "sub" && index === 2) {
          fail(`${what} must be a register, but ${tok} is a number`, `To subtract a constant, use addi with its negative: addi ${all[0]}, ${all[1]}, ${tok.startsWith("-") ? tok.slice(1) : "-" + tok}`);
        }
      }
      if (kind === "mem" && (op === "beq" || op === "bne")) {
        fail(`${what} must be a register, not a memory operand`, `Load the value into a register with lw first`);
      }
      return fail(`${what} must be a register (like $t0), but "${tok}" is ${describe[kind]}`, `Syntax: ${info.syntax}`);
    }

    case "imm16": {
      if (kind === "number") return checkImm16(tok, "The immediate", op);
      if (kind === "reg") {
        const twin = REGISTER_TWIN[op];
        fail(
          `${what} must be a constant (immediate), but ${tok} is a register`,
          twin ? `To combine two registers, use ${twin}: ${twin} ${all.join(", ")}` : `Syntax: ${info.syntax}`,
        );
      }
      if (kind === "label") {
        fail(`${what} must be a number, but "${tok}" is a label`, `Labels can only be used as branch or jump targets`);
      }
      return fail(`${what} must be a number, but "${tok}" is ${describe[kind]}`, `Syntax: ${info.syntax}`);
    }

    case "shamt": {
      if (kind === "number") {
        const n = parseNumber(tok, "The shift amount");
        if (n.hex) fail(`The shift amount ${tok} must be written in decimal`, `Write ${n.value}`);
        if (n.value < 0 || n.value > 31) fail(`The shift amount ${tok} is out of range: it must be between 0 and 31`);
        return;
      }
      if (kind === "reg") {
        fail(`The shift amount must be a constant from 0 to 31, but ${tok} is a register`, `Shifting by a register (sllv/srlv) isn't supported`);
      }
      return fail(`The shift amount must be a number from 0 to 31, but "${tok}" is ${describe[kind]}`, `Syntax: ${info.syntax}`);
    }

    case "mem": {
      if (kind === "mem") {
        const m = /^(.*)\((.*)\)$/.exec(tok);
        if (!m) fail(`${what} "${tok}" isn't in the form offset($reg)`, `For example: ${op} ${all[0]}, 4($t1)`);
        const [, off, base] = m!;
        if (off === "") fail(`${what} "${tok}" is missing its offset`, `Write 0${tok}`);
        if (base === "") fail(`${what} "${tok}" has no base register inside the parentheses`, `For example: ${off}($t1)`);
        if (!base.startsWith("$")) {
          fail(`The base address of ${op} must be a register, but "${base}" is ${describe[kindOf(base)]}`, `For example: ${off}($t1)`);
        }
        if (kindOf(off) === "reg") {
          fail(`The offset of ${op} must be a constant, but ${off} is a register`, `Add the registers first (add), then use 0(${base})`);
        }
        if (kindOf(off) === "label") {
          fail(`The offset of ${op} must be a number, but "${off}" is a label`, `Labels can't be used as addresses here; use the numeric address`);
        }
        checkImm16(off, `The offset`, op);
        return checkRegister(base, `base register of ${op}`);
      }
      if (kind === "reg") {
        fail(`${op} needs a memory address in the form offset($reg), but got just ${tok}`, `Write 0(${tok})`);
      }
      if (kind === "number") {
        fail(`${op} needs a memory address in the form offset($reg), but got just ${tok}`, `To use address ${tok} directly, write ${tok}($zero)`);
      }
      if (kind === "label") {
        fail(
          `${op} can't load or store by label ("${tok}"): it needs offset($reg)`,
          `Put the data's address in a register (e.g. addi $t1, $zero, <address>), then use 0($t1)`,
        );
      }
      return fail(`${what} must be a memory address offset($reg), but "${tok}" is ${describe[kind]}`, `Syntax: ${info.syntax}`);
    }

    case "label": {
      if (kind === "label") return;
      const target = op === "j" ? "jump target" : op === "la" ? "data label" : "branch target";
      if (kind === "number") {
        fail(`The ${target} must be a label, not a number (${tok})`, `Put a label like loop: on the target line and write ${op === "j" ? "j loop" : "loop"}`);
      }
      if (kind === "reg") {
        fail(`The ${target} must be a label, but ${tok} is a register`, op === "j" ? `Jumping to an address in a register (jr) isn't supported` : `Syntax: ${info.syntax}`);
      }
      if (/^[0-9]/.test(tok)) fail(`The label "${tok}" is invalid: labels must start with a letter or underscore`);
      return fail(`The ${target} "${tok}" isn't a valid label name`, `Labels use letters, digits and _, and can't start with a digit`);
    }
  }
}

/** Splits an operand list on commas, flagging empty and space-separated operands. */
function splitOperands(op: string, info: InstInfo, rest: string): string[] {
  // Whitespace around and inside parentheses is allowed: "4 ( $t1 )".
  const text = rest.replace(/\s*\(\s*/g, "(").replace(/\s*\)/g, ")").trim();
  if (text === "") {
    fail(`${op} is missing its operands`, `Syntax: ${info.syntax}`);
  }
  const parts = text.split(",").map((p) => p.trim());
  parts.forEach((p, i) => {
    if (p !== "") return;
    if (i === parts.length - 1) fail(`There's a trailing comma after the last operand of ${op}`, `Syntax: ${info.syntax}`);
    if (i === 0) fail(`There's a comma before the first operand of ${op}`, `Syntax: ${info.syntax}`);
    fail(`There's an empty operand (two commas in a row) in ${op}`, `Syntax: ${info.syntax}`);
  });
  const operands: string[] = [];
  for (const p of parts) {
    const words = p.split(/\s+/);
    if (words.length > 1) {
      fail(`Missing comma between "${words[0]}" and "${words[1]}"`, `Syntax: ${info.syntax}`);
    }
    operands.push(p);
  }
  return operands;
}

function checkInstruction(code: string): void {
  const m = /^([A-Za-z]+)(.*)$/.exec(code);
  if (!m) {
    if (/^[0-9]/.test(code)) fail(`A line can't start with a number ("${code.split(/\s+/)[0]}")`, `Lines start with an instruction, a label (name:), or # comment`);
    return fail(`"${code.split(/\s+/)[0]}" isn't an instruction`);
  }
  const [, word, after] = m;
  const op = word.toLowerCase();
  const info = INSTRUCTIONS[op];

  if (!info) {
    if (UNSUPPORTED[op]) {
      fail(`"${word}" is a real MIPS instruction, but this simulator doesn't support it`, UNSUPPORTED[op]);
    }
    const guess = closest(op, Object.keys(INSTRUCTIONS));
    return fail(
      `Unknown instruction "${word}"`,
      guess ? `Did you mean ${guess}? (${INSTRUCTIONS[guess].syntax})` : `Supported: ${Object.keys(INSTRUCTIONS).join(", ")}`,
    );
  }

  // "add$t0, ..." reads as mnemonic "add" followed directly by "$t0".
  if (after !== "" && !/^[ \t]/.test(after)) {
    fail(`Missing a space after "${word}"`, `Write: ${word} ${after.trim()}`);
  }

  const operands = splitOperands(op, info, after);
  if (operands.length !== info.operands.length) {
    const n = info.operands.length;
    fail(
      `${op} takes ${n} operand${n === 1 ? "" : "s"}, but ${operands.length} ${operands.length === 1 ? "was" : "were"} given`,
      `Syntax: ${info.syntax}`,
    );
  }
  operands.forEach((tok, i) => checkOperand(op, info, i, tok, operands));
}

// ---- .data declarations ------------------------------------------------------------

const DATA_TYPES = new Set([".word", ".byte", ".asciiz"]);
const UNSUPPORTED_DATA: Record<string, string> = {
  ".half": "use .word or .byte", ".space": "use .word 0, 0, ... or .byte 0, 0, ...", ".ascii": "use .asciiz (adds a terminating 0 byte)",
  ".float": "floating point isn't supported", ".double": "floating point isn't supported", ".align": "data is always word-aligned already",
};

function checkDataValues(type: string, rest: string): void {
  if (type === ".asciiz") return checkString(rest);
  const values = rest.split(",").map((v) => v.trim());
  if (values.length === 1 && values[0] === "") fail(`${type} needs at least one value`, `For example: ${type} 1, 2, 3`);
  values.forEach((v, i) => {
    const what = `Value ${i + 1} of ${type}`;
    if (v === "") fail(`${what} is empty (extra comma?)`);
    if (/\s/.test(v)) fail(`Missing comma between "${v.split(/\s+/)[0]}" and "${v.split(/\s+/)[1]}"`);
    const kind = kindOf(v);
    if (kind === "string") fail(`${type} expects numbers, but ${v} is a string`, `Declare text with .asciiz "..."`);
    if (kind === "label" || kind === "reg") fail(`${what} must be a number, but "${v}" is ${describe[kind]}`);
    const n = parseNumber(v, what);
    if (type === ".byte") {
      if (n.hex) fail(`${what} (${v}) must be written in decimal`, `Write ${n.value}`);
      if (n.value < 0 || n.value > 255) fail(`${what} (${v}) is out of range: a byte must be between 0 and 255`);
    } else {
      if (n.hex && n.value > 0xffffffff) fail(`${what} (${v}) is out of range: hex words must be between 0x0 and 0xFFFFFFFF (32 bits)`);
      if (!n.hex && (n.value < -2147483648 || n.value > 2147483647)) {
        fail(`${what} (${v}) is out of range: decimal words must be between -2147483648 and 2147483647 (32 bits)`);
      }
    }
  });
}

function checkString(rest: string): void {
  const s = rest.trim();
  if (s === "") fail(`.asciiz needs a string in double quotes`, `For example: .asciiz "hello"`);
  if (!s.startsWith('"')) {
    const kind = kindOf(s);
    fail(
      `.asciiz expects a string in double quotes, but got ${describe[kind]} (${s})`,
      kind === "number" ? `For numbers use .word or .byte` : `Put the text in double quotes: .asciiz "${s.replace(/^'|'$/g, "")}"`,
    );
  }
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      const esc = s[i + 1];
      if (esc === undefined) break;
      if (!'\\"nrt'.includes(esc)) fail(`Unknown escape "\\${esc}" in string`, `Supported escapes: \\n \\t \\r \\\\ \\"`);
      i++;
      continue;
    }
    if (ch === "\t") fail(`The string contains a raw tab character`, `Write \\t instead`);
    if (ch === '"') {
      const tail = s.slice(i + 1).trim();
      if (tail !== "") fail(`Unexpected "${tail}" after the closing quote`, `.asciiz takes exactly one string`);
      return;
    }
  }
  fail(`The string is missing its closing quote (")`);
}

// ---- Whole-source pass -------------------------------------------------------

type Segment = "none" | "data" | "text";

/**
 * Checks every line of `source` and returns a Diagnostic for each line it
 * can explain, in line order. An empty result means nothing recognisably
 * wrong was found line by line (the caller then falls back to the parser's
 * own message).
 */
export function diagnoseSource(source: string): Diagnostic[] {
  const lines = source.split(/\r\n|\r|\n/);
  const out: Diagnostic[] = [];
  const dataLine = lines.findIndex((l) => l.trim() === ".data" || l.trim().startsWith(".data"));
  let segment: Segment = "none";
  let sawText = false;

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const report = (message: string, hint?: string) => out.push({ line: lineNo, message, hint, source: raw });
    try {
      const { code: rawCode, comment } = stripComment(raw);
      let code = rawCode.trim();

      // Section directives. The grammar only accepts .data/.text alone on
      // their line (no comment), .data only as the very first line, and
      // requires .text after a .data segment.
      if (/^\.(data|text)\b/i.test(code)) {
        const dir = code.split(/\s+/)[0];
        if (dir !== ".data" && dir !== ".text") fail(`"${dir}" must be written in lowercase`, `Write ${dir.toLowerCase()}`);
        if (code !== dir) fail(`Nothing else can go on the ${dir} line`, `Move "${code.slice(dir.length).trim()}" to the next line`);
        if (comment) fail(`Comments can't go on the ${dir} line`, `Move the comment to its own line in the .text segment`);
        if (dir === ".data") {
          if (segment !== "none") fail(`.data must come before .text (and appear only once)`);
          segment = "data";
          if (idx !== 0) {
            fail(`.data must be on the very first line of the program`, `Remove the ${idx === 1 ? "line" : `${idx} lines`} above it (comments and blank lines included)`);
          }
          segment = "data";
        } else {
          if (sawText) fail(`.text appears more than once`);
          segment = "text";
          sawText = true;
        }
        return;
      }

      if (segment === "data") {
        if (code === "") {
          if (comment) fail(`Comments aren't allowed in the .data segment`, `Move it below .text, or delete it`);
          return;
        }
        if (comment) fail(`Comments aren't allowed in the .data segment`, `Move it below .text, or delete it`);
        const lm = /^([^\s:"]+)\s*:\s*(.*)$/.exec(code);
        if (!lm) {
          if (/^\./.test(code)) {
            fail(`Data declarations need a label`, `For example: nums: ${code}`);
          }
          const first = code.split(/\s+/)[0].toLowerCase();
          if (INSTRUCTIONS[first] || UNSUPPORTED[first]) fail(`Instructions must go after .text, not in the .data segment`, `Add a .text line above your instructions`);
          return fail(`"${code}" isn't a data declaration`, `Data lines look like: nums: .word 1, 2, 3`);
        }
        const [, name, body] = lm;
        if (!LABEL_RE.test(name)) fail(`"${name}" isn't a valid label name`, `Labels use letters, digits and _, and can't start with a digit`);
        const type = body.split(/\s+/)[0];
        if (type === "") fail(`The label "${name}" has no data after it`, `For example: ${name}: .word 0`);
        if (!DATA_TYPES.has(type)) {
          if (UNSUPPORTED_DATA[type]) fail(`${type} isn't supported`, UNSUPPORTED_DATA[type]);
          if (type.startsWith(".")) fail(`Unknown data type "${type}"`, `Supported: .word, .byte, .asciiz`);
          fail(`"${name}:" must be followed by .word, .byte or .asciiz`, `For example: ${name}: .word ${body}`);
        }
        return checkDataValues(type, body.slice(type.length));
      }

      // Text (or a program with no section headers at all).
      if (code === "") return;
      const lm = /^([^\s:"]+)\s*:(.*)$/.exec(code);
      if (lm && !lm[1].includes("(") && !lm[1].includes(",")) {
        const [, name, after] = lm;
        if (!LABEL_RE.test(name)) {
          fail(
            /^[0-9]/.test(name) ? `The label "${name}" can't start with a digit` : `"${name}" isn't a valid label name`,
            `Labels use letters, digits and _, and start with a letter or _`,
          );
        }
        code = after.trim();
        if (code === "") return;
      }
      if (code.startsWith(".")) {
        const dir = code.split(/\s+/)[0];
        if (DATA_TYPES.has(dir)) {
          fail(`Data declarations (${dir}) must go in a .data segment at the top of the program`, `Start the program with .data, then your data, then .text`);
        }
        if (dir === ".globl" || dir === ".global" || dir === ".ent" || dir === ".end") fail(`The ${dir} directive isn't supported`, `Delete this line`);
        fail(`Unknown directive "${dir}"`, `Only .data and .text are supported here`);
      }
      checkInstruction(code);
    } catch (e) {
      if (e instanceof LineError) report(e.message, e.hint);
      else throw e;
    }
  });

  if (dataLine >= 0 && !sawText) {
    out.push({
      line: dataLine + 1,
      message: `A program with a .data segment needs a .text line before its instructions`,
      hint: `Add .text on its own line after the data`,
      source: lines[dataLine],
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Rewrites Peggy's raw "Expected ... but X found." into something shorter,
 * for when diagnoseSource() found nothing to say. */
export function simplifyPeggyMessage(message: string): string {
  const m = /^Expected (.*) but (.*) found\.?$/s.exec(message);
  if (!m) return message;
  const found = m[2] === "end of input" ? "the end of the program" : m[2];
  const expected = m[1].split(/, | or /);
  const short = expected.length > 6 ? `${expected.slice(0, 5).join(", ")}, …` : m[1];
  return `Unexpected ${found} (expected ${short})`;
}