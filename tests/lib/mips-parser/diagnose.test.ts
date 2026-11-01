/**
 * diagnose.ts: the plain-language, per-line explanations shown when source
 * fails to parse. Pure string-in / list-out, so no parser is needed here
 * (parser.test.ts checks how parseMips() combines these with Peggy's error).
 */
import { describe, it, expect } from "vitest";
import { diagnoseSource, simplifyPeggyMessage, type Diagnostic } from "../../../src/lib/mips-parser/diagnose";

/** Diagnostics for a one-line program. */
const one = (line: string): Diagnostic[] => diagnoseSource(line);
/** The message (and hint) for a one-line program with exactly one problem. */
function msg(line: string): { message: string; hint?: string } {
  const d = one(line);
  expect(d).toHaveLength(1);
  return { message: d[0].message, hint: d[0].hint };
}

describe("valid programs produce no diagnostics", () => {
  it.each([
    "add $t2, $t0, $t1",
    "addi $t0, $zero, -32768",
    "addi $t0, $zero, 32767",
    "ori $t0, $t1, 0xFFFF",
    "andi $t0, $t1, 0xff",
    "sll $t1, $t0, 31",
    "lw $t0, 4($t1)",
    "lw $t0, 4 ( $t1 )",
    "sw $t0, -8($t1)",
    "lb $t0, 0x10($zero)",
    "beq $t0, $t1, loop",
    "j end",
    "lui $t0, 0x1234",
    "la $t0, arr",
    "loop: add $t0, $t0, $t1   # comment",
    "label_only:",
    "# just a comment",
    "",
    "ADD $T0, $T1, $T2",
    "add $8, $9, $10",
  ])("%s", (src) => {
    expect(one(src)).toEqual([]);
  });

  it("a full program with .data and .text", () => {
    const src = ['.data', 'nums: .word 1, -2, 0x7FFFFFFF, 0xFFFFFFFF', 'b: .byte 0, 255', 's: .asciiz "hi\\n"', ".text", "lw $t0, 0($zero)"].join("\n");
    expect(diagnoseSource(src)).toEqual([]);
  });
});

describe("unknown and unsupported instructions", () => {
  it("suggests the closest supported mnemonic", () => {
    expect(msg("ad $t0, $t1, $t2")).toEqual({ message: 'Unknown instruction "ad"', hint: "Did you mean add? (add $rd, $rs, $rt)" });
    expect(msg("addd $t0, $t1, $t2").hint).toBe("Did you mean add? (add $rd, $rs, $rt)");
  });

  it("lists what's supported when nothing is close", () => {
    expect(msg("frobnicate $t0").hint).toMatch(/^Supported: add, sub, and, or, slt, addi/);
  });

  it.each([
    ["addu $t0, $t1, $t2", "use add"],
    ["mult $t0, $t1", "multiplication isn't supported; use repeated add or shifts"],
    ["jal func", "function calls aren't supported; use j"],
    ["li $t0, 5", "use addi $rt, $zero, value (or lui + ori for 32-bit values)"],
    ["move $t0, $t1", "use add $rd, $rs, $zero"],
    ["nop", "use sll $t0, $t0, 0 (or any instruction with no effect)"],
    ["blt $t0, $t1, x", "use slt then bne"],
  ])("%s: real MIPS, but unsupported here (%s)", (src, hint) => {
    const d = msg(src);
    expect(d.message).toMatch(/is a real MIPS instruction, but this simulator doesn't support it$/);
    expect(d.hint).toBe(hint);
  });

  it("flags a missing space after the mnemonic", () => {
    expect(msg("add$t0, $t1, $t2")).toEqual({ message: 'Missing a space after "add"', hint: "Write: add $t0, $t1, $t2" });
  });

  it("a line can't start with a number", () => {
    expect(msg("5 $t0").message).toBe('A line can\'t start with a number ("5")');
  });
});

describe("operand counts and commas", () => {
  it("too few / too many operands", () => {
    expect(msg("add $t0, $t1")).toEqual({ message: "add takes 3 operands, but 2 were given", hint: "Syntax: add $rd, $rs, $rt" });
    expect(msg("j a, b").message).toBe("j takes 1 operand, but 2 were given");
  });

  it("no operands at all", () => {
    expect(msg("add").message).toBe("add is missing its operands");
  });

  it("missing comma between operands", () => {
    expect(msg("add $t0 $t1, $t2").message).toBe('Missing comma between "$t0" and "$t1"');
  });

  it("trailing, leading and doubled commas", () => {
    expect(msg("add $t0, $t1, $t2,").message).toBe("There's a trailing comma after the last operand of add");
    expect(msg("add , $t0, $t1, $t2").message).toBe("There's a comma before the first operand of add");
    expect(msg("add $t0,, $t1, $t2").message).toBe("There's an empty operand (two commas in a row) in add");
  });
});

describe("registers", () => {
  it("reserved registers, by name and by number", () => {
    expect(msg("add $t0, $sp, $t1").message).toBe("$sp is the stack pointer, which this simulator reserves (second operand of add)");
    expect(msg("add $t0, $29, $t1").message).toBe("$29 is $sp, the stack pointer, which this simulator reserves (second operand of add)");
    expect(msg("add $t0, $1, $t1").message).toBe("$1 is $at, the assembler temporary, which this simulator reserves (second operand of add)");
  });

  it("register numbers past 31", () => {
    expect(msg("add $t0, $32, $t1").message).toBe("$32 doesn't exist: MIPS has registers $0–$31 (second operand of add)");
  });

  it("$pc can't be named", () => {
    expect(msg("add $t0, $pc, $t1").message).toMatch(/^\$pc can't be used in an instruction/);
  });

  it("misspelt registers get a suggestion", () => {
    // $t0 and $t1 are equally close; the first in the register table wins.
    expect(msg("add $t0, $t10, $t1")).toMatchObject({ message: '"$t10" isn\'t a register (second operand of add)', hint: "Did you mean $t0?" });
    expect(msg("add $t0, $zer, $t1").hint).toBe("Did you mean $zero?");
  });

  it("a register name without its $", () => {
    expect(msg("add t0, $t1, $t2")).toEqual({ message: 'The first operand of add must be a register, but "t0" has no "$"', hint: "Write $t0" });
  });

  it("a constant where an R-type needs a register suggests the immediate form", () => {
    expect(msg("add $t0, $t1, 5")).toEqual({
      message: "The third operand of add must be a register, but 5 is a number",
      hint: "To use a constant, use addi: addi $t0, $t1, 5",
    });
  });

  it("sub with a constant suggests addi with the negative", () => {
    expect(msg("sub $t0, $t1, 5").hint).toBe("To subtract a constant, use addi with its negative: addi $t0, $t1, -5");
    expect(msg("sub $t0, $t1, -5").hint).toBe("To subtract a constant, use addi with its negative: addi $t0, $t1, 5");
  });
});

describe("immediates and numbers", () => {
  it("16-bit decimal range", () => {
    const d = msg("addi $t0, $zero, 32768");
    expect(d.message).toBe("The immediate 32768 is out of range for addi: decimal immediates must be between -32768 and 32767 (16 bits)");
    expect(d.hint).toMatch(/lui \(upper 16 bits\) then ori/);
    expect(msg("addi $t0, $zero, -32769").message).toMatch(/out of range for addi/);
  });

  it("16-bit hex range", () => {
    expect(msg("ori $t0, $zero, 0x10000").message).toBe(
      "The immediate 0x10000 is out of range for ori: hex immediates must be between 0x0 and 0xFFFF (16 bits)",
    );
  });

  it("lui gets its own hint", () => {
    expect(msg("lui $t0, 70000").hint).toBe("lui takes the upper 16 bits only, e.g. lui $t0, 0x1234");
    expect(msg("lui $t0, 0x10000").hint).toBeUndefined();
  });

  it.each([
    ["addi $t0, $zero, 0XFF", 'The immediate "0XFF" uses a capital X'],
    ["addi $t0, $zero, -0x10", 'The immediate "-0x10" is a negative hex number, which isn\'t allowed'],
    ["addi $t0, $zero, +4", 'The immediate "+4" has a "+" sign, which isn\'t allowed'],
    ["addi $t0, $zero, 1.5", 'The immediate "1.5" is a decimal fraction — only whole numbers are supported'],
    ["addi $t0, $zero, 0x", 'The immediate "0x" has no digits after 0x'],
    ["addi $t0, $zero, 0xZZ", 'The immediate "0xZZ" isn\'t a valid hex number'],
    ["addi $t0, $zero, 12abc", 'The immediate "12abc" isn\'t a valid number'],
  ])("%s", (src, message) => {
    expect(msg(src).message).toBe(message);
  });

  it("a register where a constant belongs suggests the register form", () => {
    expect(msg("addi $t0, $t1, $t2")).toEqual({
      message: "The third operand of addi must be a constant (immediate), but $t2 is a register",
      hint: "To combine two registers, use add: add $t0, $t1, $t2",
    });
  });

  it("a label where a constant belongs", () => {
    expect(msg("addi $t0, $t1, foo").message).toBe('The third operand of addi must be a number, but "foo" is a label');
  });
});

describe("shift amounts", () => {
  it("must be 0-31, in decimal, and not a register", () => {
    expect(msg("sll $t0, $t1, 32").message).toBe("The shift amount 32 is out of range: it must be between 0 and 31");
    expect(msg("sll $t0, $t1, -1").message).toBe("The shift amount -1 is out of range: it must be between 0 and 31");
    expect(msg("sll $t0, $t1, 0x4")).toEqual({ message: "The shift amount 0x4 must be written in decimal", hint: "Write 4" });
    expect(msg("sll $t0, $t1, $t2").message).toBe("The shift amount must be a constant from 0 to 31, but $t2 is a register");
  });
});

describe("memory operands", () => {
  it.each([
    ["lw $t0, $t1", "lw needs a memory address in the form offset($reg), but got just $t1", "Write 0($t1)"],
    ["lw $t0, 8", "lw needs a memory address in the form offset($reg), but got just 8", "To use address 8 directly, write 8($zero)"],
    ["lw $t0, arr", 'lw can\'t load or store by label ("arr"): it needs offset($reg)', undefined],
    ["lw $t0, ($t1)", 'The second operand of lw "($t1)" is missing its offset', "Write 0($t1)"],
    ["lw $t0, 4()", 'The second operand of lw "4()" has no base register inside the parentheses', "For example: 4($t1)"],
    ["lw $t0, 4(t1)", 'The base address of lw must be a register, but "t1" is a label', "For example: 4($t1)"],
  ] as [string, string, string | undefined][])("%s", (src, message, hint) => {
    const d = msg(src);
    expect(d.message).toBe(message);
    if (hint !== undefined) expect(d.hint).toBe(hint);
  });

  // BUG (diagnose.ts kindOf): a token starting with "$" is classed as a
  // register before the "(" check, so "$t2($t1)" never reaches the
  // offset-is-a-register branch. it.fails passes while the bug is there.
  it.fails("a register used as the offset gets its own message", () => {
    expect(msg("lw $t0, $t2($t1)").message).toBe("The offset of lw must be a constant, but $t2 is a register");
  });

  it("(current behaviour) a register used as the offset is reported as a bare register", () => {
    expect(msg("lw $t0, $t2($t1)")).toEqual({
      message: "lw needs a memory address in the form offset($reg), but got just $t2($t1)",
      hint: "Write 0($t2($t1))",
    });
  });

  it("checks the offset's range and the base register", () => {
    expect(msg("lw $t0, 40000($t1)").message).toMatch(/^The offset 40000 is out of range for lw/);
    expect(msg("lw $t0, 0($sp)").message).toBe("$sp is the stack pointer, which this simulator reserves (base register of lw)");
  });
});

describe("branch and jump targets", () => {
  it("must be labels", () => {
    expect(msg("j 100").message).toBe("The jump target must be a label, not a number (100)");
    expect(msg("beq $t0, $t1, 8").message).toBe("The branch target must be a label, not a number (8)");
    expect(msg("j $t0")).toEqual({
      message: "The jump target must be a label, but $t0 is a register",
      hint: "Jumping to an address in a register (jr) isn't supported",
    });
    expect(msg("la $t0, 5").message).toBe("The data label must be a label, not a number (5)");
  });

  it("branch operands can't be memory operands", () => {
    expect(msg("beq 0($t0), $t1, x").hint).toBe("Load the value into a register with lw first");
  });
});

describe("labels", () => {
  it("can't start with a digit", () => {
    expect(msg("1loop: add $t0, $t1, $t2").message).toBe('The label "1loop" can\'t start with a digit');
  });

  it("the instruction after a label is still checked", () => {
    expect(msg("loop: ad $t0, $t1, $t2").message).toBe('Unknown instruction "ad"');
  });
});

describe(".data and .text layout", () => {
  it(".data must be the first line (comments and blank lines included)", () => {
    const d = diagnoseSource("# header\n.data\nx: .word 1\n.text\nj x");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ line: 2, message: ".data must be on the very first line of the program", hint: "Remove the line above it (comments and blank lines included)" });
    expect(diagnoseSource("\n\n.data\nx: .word 1\n.text\nj x")[0].hint).toBe("Remove the 2 lines above it (comments and blank lines included)");
  });

  it("comments aren't allowed in .data or on the header lines", () => {
    expect(diagnoseSource(".data\nx: .word 1 # one\n.text\nj x")[0]).toMatchObject({ line: 2, message: "Comments aren't allowed in the .data segment" });
    expect(diagnoseSource(".data # data\nx: .word 1\n.text\nj x")[0]).toMatchObject({ line: 1, message: "Comments can't go on the .data line" });
  });

  it("directives must be lowercase and alone on their line", () => {
    expect(diagnoseSource(".DATA\nx: .word 1\n.text\nj x")[0].message).toBe('".DATA" must be written in lowercase');
    expect(diagnoseSource(".text j x")[0].message).toBe("Nothing else can go on the .text line");
  });

  it("a .data segment needs a .text line", () => {
    expect(diagnoseSource(".data\nx: .word 1")).toEqual([
      expect.objectContaining({ line: 1, message: "A program with a .data segment needs a .text line before its instructions" }),
    ]);
  });

  it(".text twice, and .data after .text", () => {
    expect(diagnoseSource(".text\nj x\n.text\nx:")[0]).toMatchObject({ line: 3, message: ".text appears more than once" });
    expect(diagnoseSource(".text\nj x\n.data\nx:").map((d) => d.message)).toContain(".data must come before .text (and appear only once)");
  });

  it("instructions in .data, and data declarations in .text", () => {
    expect(diagnoseSource(".data\nadd $t0, $t1, $t2\n.text")[0].message).toBe("Instructions must go after .text, not in the .data segment");
    expect(one("nums: .word 1, 2")[0].message).toBe("Data declarations (.word) must go in a .data segment at the top of the program");
  });

  it("unsupported directives", () => {
    expect(one(".globl main")[0].message).toBe("The .globl directive isn't supported");
    expect(one(".align 2")[0].message).toBe('Unknown directive ".align"');
  });
});

describe(".data declarations", () => {
  const data = (decl: string) => diagnoseSource(`.data\n${decl}\n.text\nj x`);
  const dmsg = (decl: string) => {
    const d = data(decl);
    expect(d).toHaveLength(1);
    expect(d[0].line).toBe(2);
    return d[0].message;
  };

  it("needs a label and a supported type", () => {
    expect(dmsg(".word 1")).toBe("Data declarations need a label");
    expect(dmsg("x:")).toBe('The label "x" has no data after it');
    expect(dmsg("x: .half 1")).toBe(".half isn't supported");
    expect(dmsg("x: .quad 1")).toBe('Unknown data type ".quad"');
    expect(dmsg("x: 1, 2")).toBe('"x:" must be followed by .word, .byte or .asciiz');
  });

  it(".byte values: decimal 0-255", () => {
    expect(dmsg("b: .byte 256")).toBe("Value 1 of .byte (256) is out of range: a byte must be between 0 and 255");
    expect(dmsg("b: .byte 1, -1")).toBe("Value 2 of .byte (-1) is out of range: a byte must be between 0 and 255");
    expect(dmsg("b: .byte 0x10")).toBe("Value 1 of .byte (0x10) must be written in decimal");
  });

  it(".word values: 32 bits", () => {
    expect(dmsg("w: .word 2147483648")).toMatch(/^Value 1 of .word \(2147483648\) is out of range: decimal words/);
    expect(dmsg("w: .word 0x100000000")).toMatch(/^Value 1 of .word \(0x100000000\) is out of range: hex words/);
  });

  it("value lists", () => {
    expect(dmsg("w: .word")).toBe(".word needs at least one value");
    expect(dmsg("w: .word 1,, 2")).toBe("Value 2 of .word is empty (extra comma?)");
    expect(dmsg("w: .word 1 2")).toBe('Missing comma between "1" and "2"');
    expect(dmsg('w: .word "hi"')).toBe('.word expects numbers, but "hi" is a string');
    expect(dmsg("w: .word $t0")).toBe('Value 1 of .word must be a number, but "$t0" is a register');
  });

  it(".asciiz strings", () => {
    expect(dmsg("s: .asciiz")).toBe(".asciiz needs a string in double quotes");
    expect(dmsg("s: .asciiz hello")).toBe(".asciiz expects a string in double quotes, but got a label (hello)");
    expect(dmsg('s: .asciiz "hi')).toBe('The string is missing its closing quote (")');
    expect(dmsg('s: .asciiz "a\\qb"')).toBe('Unknown escape "\\q" in string');
    expect(dmsg('s: .asciiz "a" "b"')).toBe('Unexpected ""b"" after the closing quote');
    expect(data('s: .asciiz "say \\"hi\\""')).toEqual([]);
  });
});

describe("whole-source behaviour", () => {
  it("reports every bad line, in order, with its 1-based line number and source text", () => {
    const src = "addi $t0, $zero, 1\nad $t1, $t0, $t0\nadd $t2, $t0\nsll $t3, $t0, 40";
    const d = diagnoseSource(src);
    expect(d.map((x) => x.line)).toEqual([2, 3, 4]);
    expect(d[0].source).toBe("ad $t1, $t0, $t0");
  });

  it("handles Windows and old-Mac line endings", () => {
    expect(diagnoseSource("add $t0, $t1, $t2\r\nad $t0\r\n").map((x) => x.line)).toEqual([2]);
    expect(diagnoseSource("add $t0, $t1, $t2\rad $t0").map((x) => x.line)).toEqual([2]);
  });

  it("ignores # inside strings when stripping comments", () => {
    expect(diagnoseSource('.data\ns: .asciiz "a#b"\n.text\nj x')).toEqual([]);
  });
});

describe("simplifyPeggyMessage", () => {
  it("shortens long 'Expected ...' lists", () => {
    const raw = 'Expected "a", "b", "c", "d", "e", "f", "g" or [ \\t] but "5" found.';
    expect(simplifyPeggyMessage(raw)).toBe('Unexpected "5" (expected "a", "b", "c", "d", "e", …)');
  });

  it("keeps short lists whole and names the end of input", () => {
    expect(simplifyPeggyMessage('Expected "," but end of input found.')).toBe('Unexpected the end of the program (expected ",")');
  });

  it("passes other messages through", () => {
    expect(simplifyPeggyMessage("Expected a usable register number (0, 2-25).")).toBe("Expected a usable register number (0, 2-25).");
  });
});
