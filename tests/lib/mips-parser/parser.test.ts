/**
 * parseMips() against mips.peggy. Needs src/lib/mips-parser/generated-parser.ts
 * (npm run gen:parser).
 *
 * Successful parses are compared node-for-node with tests/helpers/ast.ts's
 * builders, which copy the grammar's own REG/I32/U32 helpers — so these tests
 * also pin down that the hand-built ASTs used everywhere else match what the
 * parser really produces.
 */
import { describe, it, expect } from "vitest";
import { parseMips, type ParseFailure, type ParseSuccess } from "../../../src/lib/mips-parser";
import { B, I, J, L, M, R, S, U, V, I32, U32 } from "../../helpers/ast";
import type { Instr } from "../../../src/lib/mips-parser/ast";

function ok(src: string): ParseSuccess["program"] {
  const r = parseMips(src);
  if (!r.ok) throw new Error(`expected a parse, got: ${r.message} (line ${r.line})`);
  return r.program;
}

function fail(src: string): ParseFailure {
  const r = parseMips(src);
  if (r.ok) throw new Error(`expected a syntax error for: ${src}`);
  return r;
}

/** The only instruction in `src`. */
function inst(src: string): Instr {
  const insts = ok(src).prop.text.map((l) => l.prop.inst).filter((i): i is Instr => i !== null);
  expect(insts).toHaveLength(1);
  return insts[0];
}

describe("parseMips: instruction forms", () => {
  it.each<[string, Instr]>([
    ["add $t2, $t0, $t1", R("add", "t2", "t0", "t1")],
    ["sub $s0, $s1, $s2", R("sub", "s0", "s1", "s2")],
    ["and $t0, $t1, $t2", R("and", "t0", "t1", "t2")],
    ["or $t0, $t1, $t2", R("or", "t0", "t1", "t2")],
    ["slt $t0, $t1, $t2", R("slt", "t0", "t1", "t2")],
    ["addi $t0, $zero, 100", I("addi", "t0", "zero", 100)],
    ["addi $t0, $t0, -1", I("addi", "t0", "t0", -1)],
    ["slti $t0, $t1, -32768", I("slti", "t0", "t1", -32768)],
    ["andi $t0, $t1, 32767", I("andi", "t0", "t1", 32767)],
    ["ori $t0, $t1, 0xFF", L("ori", "t0", "t1", 0xff)],
    ["xori $t0, $t1, 0xFFFF", L("xori", "t0", "t1", 0xffff)],
    ["sll $t1, $t0, 4", S("sll", "t1", "t0", 4)],
    ["srl $t1, $t0, 31", S("srl", "t1", "t0", 31)],
    ["lw $t0, 4($t1)", M("lw", "t0", 4, "t1")],
    ["sw $t0, -8($t1)", M("sw", "t0", -8, "t1")],
    ["lb $t0, 0($zero)", M("lb", "t0", 0, "zero")],
    ["sb $t0, 3($a0)", M("sb", "t0", 3, "a0")],
    ["lw $t0, 0x10($t1)", M("lw", "t0", 16, "t1")],
    ["beq $t0, $t1, loop", B("beq", "t0", "t1", "loop")],
    ["bne $t0, $zero, done", B("bne", "t0", "zero", "done")],
    ["j end", J("end")],
    ["lui $t0, 0x1234", U("t0", 0x1234)],
    ["lui $t0, 100", U("t0", 100)],
    ["la $t0, array", V("t0", "array")],
  ])("%s", (src, expected) => {
    expect(inst(src)).toEqual(expected);
  });

  it("mnemonics and register names are case-insensitive (ops come out lower-case)", () => {
    expect(inst("ADDI $T0, $ZERO, 1")).toEqual(I("addi", "t0", "zero", 1));
    expect(inst("Add $V0, $A0, $S7")).toEqual(R("add", "v0", "a0", "s7"));
  });

  it("registers may be written by number", () => {
    expect(inst("add $10, $8, $9")).toEqual(R("add", "t2", "t0", "t1"));
    expect(inst("addi $2, $0, 1")).toEqual(I("addi", "v0", "zero", 1));
  });

  it("parses register names containing digits (regression: [A-Za-z]+ rejected $v0..$t9)", () => {
    expect(inst("add $v0, $t9, $s7")).toEqual(R("add", "v0", "t9", "s7"));
  });

  it("accepts lower-case hex digits (regression: [0-9A-F]+ only matched upper case)", () => {
    expect(inst("ori $t0, $t1, 0xff")).toEqual(L("ori", "t0", "t1", 0xff));
    expect(inst("lw $t0, 0xc($t1)")).toEqual(M("lw", "t0", 12, "t1"));
  });

  it("whitespace around operands is optional; tabs work", () => {
    expect(inst("add $t2,$t0,$t1")).toEqual(R("add", "t2", "t0", "t1"));
    expect(inst("\taddi\t$t0 , $zero ,  5  ")).toEqual(I("addi", "t0", "zero", 5));
    expect(inst("lw $t0, 4 ( $t1 )")).toEqual(M("lw", "t0", 4, "t1"));
  });

  it("hex immediates above 0x7FFF are stored sign-extended", () => {
    const n = inst("ori $t0, $t1, 0xFFFF") as ReturnType<typeof L>;
    expect(n.prop.imm.prop.num).toBe(-1);
    expect(n.prop.imm.prop.bit.every((b) => b === 1)).toBe(true);
  });
});

describe("parseMips: lines, labels and comments", () => {
  it("records labels, comments and 1-based source lines", () => {
    const text = ok("start:\n  addi $t0, $zero, 1   # one\nloop: add $t1, $t1, $t0\n# just a comment").prop.text;
    expect(text.map((l) => [l.prop.lbl, l.prop.inst?.prop.op ?? null, l.prop.cmt, l.prop.loc])).toEqual([
      ["start", null, "", 1],
      [null, "addi", "one", 2],
      ["loop", "add", "", 3],
      [null, null, "just a comment", 4],
    ]);
  });

  it("a label may have spaces before its colon", () => {
    expect(ok("top : j top").prop.text[0].prop.lbl).toBe("top");
  });

  it("blank lines are skipped but line numbers stay right", () => {
    const text = ok("addi $t0, $zero, 1\n\n\naddi $t1, $zero, 2").prop.text;
    const insts = text.filter((l) => l.prop.inst);
    expect(insts.map((l) => l.prop.loc)).toEqual([1, 4]);
  });

  it("handles Windows line endings", () => {
    const insts = ok("addi $t0, $zero, 1\r\naddi $t1, $zero, 2\r\n").prop.text.filter((l) => l.prop.inst);
    expect(insts.map((l) => l.prop.loc)).toEqual([1, 2]);
  });

  it("an empty source is an empty (valid) program", () => {
    const p = ok("");
    expect(p.prop.text.every((l) => l.prop.inst === null)).toBe(true);
  });
});

describe("parseMips: segments", () => {
  it("no headers: text only, and data is []", () => {
    const p = ok("addi $t0, $zero, 1");
    expect(p.prop.data).toEqual([]);
  });

  it(".text header without .data: data is null", () => {
    const p = ok(".text\naddi $t0, $zero, 1");
    expect(p.prop.data).toBeNull();
    expect(p.prop.text.filter((l) => l.prop.inst)).toHaveLength(1);
  });

  it("parses .word / .byte / .asciiz declarations", () => {
    const p = ok(
      [
        ".data",
        "nums: .word 1, -2, 0x7FFFFFFF, 0xFFFFFFFF",
        "bs: .byte 0, 255, 16",
        'msg: .asciiz "hi\\n\\t\\"x\\"\\\\"',
        ".text",
        "lw $t0, 0($zero)",
      ].join("\n"),
    );
    const data = p.prop.data!;
    expect(data.map((d) => [d.prop.type, d.prop.name, d.prop.loc])).toEqual([
      ["int", "nums", 2],
      ["byte", "bs", 3],
      ["str", "msg", 4],
    ]);
    expect(data[0].prop.vals).toEqual([I32(1, 32), I32(-2, 32), I32(0x7fffffff, 32), I32(-1, 32)]);
    expect(data[1].prop.vals).toEqual([U32(0, 8), U32(255, 8), U32(16, 8)]);
    expect(data[2].prop.vals).toBe('hi\n\t"x"\\');
    expect(p.prop.text.find((l) => l.prop.inst)!.prop.loc).toBe(6);
  });

  // KNOWN LIMITATIONS of the Prog/Data rules: nothing may come before the
  // .data/.text header (Prog's first alternative starts with `_ DataSeg?`,
  // which only skips spaces/tabs), and Data has no Cmt. diagnose.ts now
  // explains these clearly (see below), but they're still rejected.
  // it.fails passes while the limitation stands; when the grammar accepts
  // these, it starts failing — switch it to it() then.
  it.fails("accepts a comment line before .data", () => {
    ok("# Sum an array\n.data\nx: .word 1\n.text\nlw $t0, 0($zero)");
  });
  it.fails("accepts a blank line before .data", () => {
    ok("\n.data\nx: .word 1\n.text\nlw $t0, 0($zero)");
  });
  it.fails("accepts a comment on a .data line", () => {
    ok(".data\nx: .word 1 # one\n.text\nlw $t0, 0($zero)");
  });
  it("(current behaviour) those three are rejected, with an explanation", () => {
    expect(fail("# Sum an array\n.data\nx: .word 1\n.text\nj x").diagnostics[0]).toMatchObject({
      line: 2,
      message: ".data must be on the very first line of the program",
    });
    expect(fail("\n.data\nx: .word 1\n.text\nj x").diagnostics[0]).toMatchObject({ line: 2 });
    expect(fail(".data\nx: .word 1 # one\n.text\nj x").diagnostics[0]).toMatchObject({
      line: 2,
      message: "Comments aren't allowed in the .data segment",
    });
  });

  it("an empty .data segment is []", () => {
    expect(ok(".data\n.text\nj x\nx:").prop.data).toEqual([]);
  });
});

describe("parseMips: errors (never thrown, always reported with a line)", () => {
  it.each<[string, string, number]>([
    ["unknown mnemonic", "foo $t0, $t1, $t2", 1],
    ["missing operand", "add $t0, $t1", 1],
    ["no space after the mnemonic", "add$t0, $t1, $t2", 1],
    ["$at is reserved", "add $t0, $at, $t1", 1],
    ["$sp is reserved", "addi $sp, $sp, -4", 1],
    ["$1 by number", "add $t0, $1, $t1", 1],
    ["$31 by number", "add $t0, $31, $t1", 1],
    ["$pc can't be named", "add $t0, $pc, $t1", 1],
    ["unknown register", "add $t0, $t10, $t1", 1],
    ["immediate too big", "addi $t0, $zero, 32768", 1],
    ["immediate too small", "addi $t0, $zero, -32769", 1],
    ["hex immediate too big", "ori $t0, $zero, 0x10000", 1],
    ["hex in .byte (decimal only)", ".data\nb: .byte 0x10\n.text\nj b", 2],
    ["shift amount 32", "sll $t0, $t1, 32", 1],
    ["byte value 256", ".data\nb: .byte 256\n.text\nj b", 2],
    ["word value 2^31", ".data\nw: .word 2147483648\n.text\nj w", 2],
    ["error on a later line", "addi $t0, $zero, 1\naddi $t1, $zero, 2\nadd $t2, $t0\naddi $t3, $zero, 3", 3],
  ])("%s", (_name, src, line) => {
    const r = fail(src);
    expect(r.line).toBe(line);
    expect(r.column).toBeGreaterThanOrEqual(1);
    expect(r.message.length).toBeGreaterThan(0);
  });
});

describe("parseMips: failure reports (diagnostics)", () => {
  it("explains the problem in plain terms, with the source line", () => {
    const r = fail("addi $t0, $zero, 1\naddi $t1, $sp, 1");
    expect(r.diagnostics).toEqual([
      {
        line: 2,
        message: "$sp is the stack pointer, which this simulator reserves (second operand of addi)",
        hint: "Use one of: $zero, $v0–$v1, $a0–$a3, $t0–$t9, $s0–$s7",
        source: "addi $t1, $sp, 1",
      },
    ]);
    expect(r.more).toBe(0);
    // Peggy's own message is kept for debugging.
    expect(r.message.length).toBeGreaterThan(0);
  });

  it("reports every bad line at once, and `line` is the first of them", () => {
    const r = fail("ad $t0, $t1, $t2\naddi $t0, $zero, 1\nsll $t0, $t0, 99");
    expect(r.diagnostics.map((d) => d.line)).toEqual([1, 3]);
    expect(r.line).toBe(1);
  });

  it("shows at most 8 problems and counts the rest in `more`", () => {
    const src = Array.from({ length: 11 }, (_, i) => `ad $t0, $t1, $t${i % 10}`).join("\n");
    const r = fail(src);
    expect(r.diagnostics).toHaveLength(8);
    expect(r.more).toBe(3);
    expect(r.diagnostics.map((d) => d.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("falls back to the parser's own (simplified) message when no line-level explanation exists", () => {
    // A .text header after instructions: diagnose.ts accepts each line on
    // its own, but the grammar only allows .text at the top.
    const r = fail("add $t0, $t1, $t2 # ok\n  .text");
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ line: 2, source: "  .text" });
    // The wording of Peggy's "expected" list depends on the generated parser,
    // so only the part index.ts writes is pinned down.
    expect(r.diagnostics[0].message).toMatch(/^Syntax error at column 3: Unexpected "\." \(expected /);
    expect(r.column).toBe(3);
  });

  it("column points into the line Peggy stopped on when that's the first problem, else 1", () => {
    expect(fail("add $t0, $t1, $t99").column).toBeGreaterThan(1);
  });
});
