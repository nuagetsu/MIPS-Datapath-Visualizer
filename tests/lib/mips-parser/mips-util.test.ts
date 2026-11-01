import { describe, it, expect } from "vitest";
import mipsUtil, { assemble, check, layoutData, lineRef, print } from "../../../src/lib/mips-parser/mips-util";
import { CompileError } from "../../../src/lib/Numbers/err";
import { hex } from "../../helpers/bits";
import { B, I, J, L, M, R, S, U, V, asciiz, bytes, label, text, words } from "../../helpers/ast";
import type { Instr, TextLine } from "../../../src/lib/mips-parser/ast";

/** Assembles a one-instruction program and returns its hex word. */
const enc = (inst: Instr) => hex(assemble(text(inst), null)[0].prop.bin);

/** Catches what `fn` throws, for asserting on its fields. */
function thrown(fn: () => void): CompileError {
  try {
    fn();
  } catch (err) {
    return err as CompileError;
  }
  throw new Error("expected a throw");
}

describe("assemble: instruction encodings", () => {
  it.each<[string, Instr, string]>([
    ["add $t2, $t0, $t1", R("add", "t2", "t0", "t1"), "0x01095020"],
    ["sub $t3, $t0, $t1", R("sub", "t3", "t0", "t1"), "0x01095822"],
    ["and $t2, $t0, $t1", R("and", "t2", "t0", "t1"), "0x01095024"],
    ["or  $t2, $t0, $t1", R("or", "t2", "t0", "t1"), "0x01095025"],
    ["slt $t2, $t0, $t1", R("slt", "t2", "t0", "t1"), "0x0109502A"],
    ["addi $t0, $zero, 100", I("addi", "t0", "zero", 100), "0x20080064"],
    ["addi $t0, $t1, -1", I("addi", "t0", "t1", -1), "0x2128FFFF"],
    ["slti $t0, $t1, 5", I("slti", "t0", "t1", 5), "0x29280005"],
    ["andi $t0, $t1, 0xFF", L("andi", "t0", "t1", 0xff), "0x312800FF"],
    ["ori  $t0, $t1, 0xFF", L("ori", "t0", "t1", 0xff), "0x352800FF"],
    ["xori $t0, $t1, 0xFF", L("xori", "t0", "t1", 0xff), "0x392800FF"],
    ["ori  $t0, $t1, 0xFFFF", L("ori", "t0", "t1", 0xffff), "0x3528FFFF"],
    ["sll $t1, $t0, 4", S("sll", "t1", "t0", 4), "0x00084900"],
    ["srl $t1, $t0, 4", S("srl", "t1", "t0", 4), "0x00084902"],
    ["sll $t1, $t0, 31", S("sll", "t1", "t0", 31), "0x00084FC0"],
    ["lw $t0, 4($t1)", M("lw", "t0", 4, "t1"), "0x8D280004"],
    ["sw $t0, 4($t1)", M("sw", "t0", 4, "t1"), "0xAD280004"],
    ["sb $t0, 4($t1)", M("sb", "t0", 4, "t1"), "0xA1280004"],
    ["lw $t0, -4($t1)", M("lw", "t0", -4, "t1"), "0x8D28FFFC"],
    ["lui $t0, 0x1234", U("t0", 0x1234), "0x3C081234"],
  ])("%s", (_src, inst, expected) => {
    expect(enc(inst)).toBe(expected);
  });

  // BUG (mips-util.ts opcode table): lb is given 0x24, which is MIPS's lbu.
  // lb is 0x20. Execution is unaffected (the interpreter dispatches on the
  // mnemonic, not the opcode bits), but the Assembled listing and the
  // datapath's opcode field show the wrong machine code. it.fails passes
  // while the bug is present; once the opcode is fixed to 0x20 it starts
  // failing — change it to a plain it() then.
  it.fails("lb $t0, 4($t1) -> 0x81280004 (lb's real opcode is 0x20)", () => {
    expect(enc(M("lb", "t0", 4, "t1"))).toBe("0x81280004");
  });

  it("lb currently assembles with opcode 0x24 (lbu's)", () => {
    expect(enc(M("lb", "t0", 4, "t1"))).toBe("0x91280004");
  });

  it("beq forward: offset counts instructions after the delay slot position (PC+4)", () => {
    const out = assemble(text(B("beq", "t0", "t1", "skip"), I("addi", "t2", "zero", 1), label("skip", R("add", "t3", "t0", "t1"))), null);
    expect(hex(out[0].prop.bin)).toBe("0x11090001");
  });

  it("bne backward: negative offsets are sign-encoded in 16 bits", () => {
    const out = assemble(text(label("loop", I("addi", "t0", "t0", -1)), B("bne", "t0", "zero", "loop")), null);
    expect(hex(out[1].prop.bin)).toBe("0x1500FFFE");
  });

  it("beq to itself is offset -1", () => {
    const out = assemble(text(label("self", B("beq", "zero", "zero", "self"))), null);
    expect(hex(out[0].prop.bin)).toBe("0x1000FFFF");
  });

  it("j encodes the target's word address", () => {
    const out = assemble(text(J("end"), R("add", "t0", "t0", "t0"), label("end", R("add", "t1", "t1", "t1"))), null);
    expect(hex(out[0].prop.bin)).toBe("0x08000002");
  });

  describe("starting $pc (third argument)", () => {
    const prog = () => text(J("end"), R("add", "t0", "t0", "t0"), label("end", R("add", "t1", "t1", "t1")));

    it("j encodes the absolute target: starting $pc + offset, as a word address", () => {
      expect(hex(assemble(prog(), null, 0x00400000)[0].prop.bin)).toBe("0x08100002");
    });

    it("accepts the starting $pc as a hex string, with or without 0x", () => {
      expect(hex(assemble(prog(), null, "00400000")[0].prop.bin)).toBe("0x08100002");
      expect(hex(assemble(prog(), null, "0x00400000")[0].prop.bin)).toBe("0x08100002");
    });

    it("keeps address bits 26-27 (regression: the base used to be masked to 0x03FFFFFF first)", () => {
      // 0x0C000000 has bits 26 and 27 set; target = 0x0C000008 -> index 0x3000002.
      expect(hex(assemble(prog(), null, 0x0c000000)[0].prop.bin)).toBe("0x0B000002");
    });

    it("drops bits 28-31, which j takes from PC+4 (never spilling into the opcode)", () => {
      // Regression: the field used to be masked to 28 bits, so these leaked into the opcode.
      expect(hex(assemble(prog(), null, 0xf0000000)[0].prop.bin)).toBe("0x08000002");
      expect(hex(assemble(prog(), null, 0xfffffff0)[0].prop.bin)).toBe("0x0BFFFFFE");
    });

    it("doesn't affect branches (PC-relative) or instruction offsets", () => {
      const lines = () => text(label("top", I("addi", "t0", "t0", -1)), B("bne", "t0", "zero", "top"));
      const at0 = assemble(lines(), null);
      const high = assemble(lines(), null, 0x00400000);
      expect(high.map((l) => hex(l.prop.bin))).toEqual(at0.map((l) => hex(l.prop.bin)));
      expect(high.map((l) => l.prop.pc)).toEqual([0, 4]);
    });
  });

  it("refuses to encode la (pseudo-instruction expansion isn't implemented)", () => {
    expect(() => assemble(text(V("t0", "arr")), [words("arr", [1])])).toThrow(/"la" cannot be encoded/);
  });
});

describe("assemble: addressing and line bookkeeping", () => {
  const lines: TextLine[] = text(
    { cmt: "header comment" },
    label("start"),
    I("addi", "t0", "zero", 1),
    { inst: null, cmt: "just a comment" },
    label("next", I("addi", "t1", "zero", 2)),
    R("add", "t2", "t0", "t1"),
  );

  it("drops label-only and comment-only lines", () => {
    expect(assemble(lines, null)).toHaveLength(3);
  });

  it("gives instructions consecutive word addresses", () => {
    expect(assemble(lines, null).map((l) => l.prop.pc)).toEqual([0, 4, 8]);
  });

  it("keeps each instruction's source line and label", () => {
    const out = assemble(lines, null);
    expect(out.map((l) => l.prop.loc)).toEqual([3, 5, 6]);
    expect(out[1].prop.lbl).toBe("next");
  });

  it("a label on its own line refers to the next instruction", () => {
    const prog = text(J("target"), I("addi", "t0", "zero", 1), label("target"), I("addi", "t1", "zero", 2));
    expect(hex(assemble(prog, null)[0].prop.bin)).toBe("0x08000002");
  });

  it("an empty program assembles to nothing", () => {
    expect(assemble([], null)).toEqual([]);
  });
});

describe("check: writes to $zero", () => {
  it.each<[string, Instr]>([
    ["R", R("add", "zero", "t0", "t1")],
    ["I", I("addi", "zero", "t0", 1)],
    ["L", L("ori", "zero", "t0", 1)],
    ["S", S("sll", "zero", "t0", 1)],
    ["U (lui)", U("zero", 1)],
    ["lw", M("lw", "zero", 0, "t0")],
    ["lb", M("lb", "zero", 0, "t0")],
  ])("rejects %s with $zero as destination", (_kind, inst) => {
    const e = thrown(() => check(text(I("addi", "t0", "zero", 1), I("addi", "t1", "zero", 1), inst), null));
    expect(e).toBeInstanceOf(CompileError);
    // The line is carried in `loc` (App prints "Error at line N: ..."), not in the message.
    expect(e.loc).toBe(3);
    expect(e.message).toMatch(/writes to \$zero, which is read-only/);
    expect(e.message).not.toMatch(/line/);
  });

  it("quotes the offending instruction, tidied", () => {
    const e = thrown(() => check(text(R("add", "zero", "t0", "t1")), null));
    expect(e.message).toBe(
      '"add $zero, $t0, $t1" writes to $zero, which is read-only (always 0). Use another destination register, such as $t0',
    );
  });

  it("allows $zero where it isn't written", () => {
    expect(() =>
      check(
        text(
          M("sw", "zero", 0, "t0"),
          M("sb", "zero", 0, "t0"),
          I("addi", "t0", "zero", 1),
          label("x", B("beq", "zero", "zero", "x")),
        ),
        null,
      ),
    ).not.toThrow();
  });
});

describe("check: labels", () => {
  it("rejects duplicate labels, reporting both lines", () => {
    const e = thrown(() => check(text(label("a", I("addi", "t0", "zero", 1)), label("a", I("addi", "t1", "zero", 1))), null));
    expect(e.message).toBe('Label "a" is already defined at line 1. Each label can only be used once');
    expect(e.loc).toBe(2);
    expect(e.comp).toBe("label");
  });

  it("rejects branches and jumps to unknown labels, at the line that uses them", () => {
    expect(thrown(() => check(text(B("beq", "t0", "t1", "nowhere")), null)).loc).toBe(1);
    expect(thrown(() => check(text(I("addi", "t0", "zero", 1), J("gone")), null)).loc).toBe(2);
  });

  it("unknown label, no labels defined: says how to add one", () => {
    expect(thrown(() => check(text(B("beq", "t0", "t1", "nowhere")), null)).message).toBe(
      'Unknown label "nowhere". No labels are defined yet: add one, e.g. "nowhere:" at the start of the target line',
    );
  });

  it("unknown label: lists the labels that are defined", () => {
    const e = thrown(() => check(text(label("start", I("addi", "t0", "zero", 1)), label("end"), J("finish")), null));
    expect(e.message).toBe('Unknown label "finish". Defined labels: start, end');
  });

  it("unknown label differing only in case: points out labels are case-sensitive", () => {
    const e = thrown(() => check(text(label("Loop", I("addi", "t0", "t0", -1)), B("bne", "t0", "zero", "loop")), null));
    expect(e.message).toBe('Unknown label "loop". Labels are case-sensitive: did you mean "Loop"?');
  });

  it("rejects a branch whose target is too far away", () => {
    const far: TextLine[] = text(B("beq", "t0", "t1", "far"));
    for (let i = 0; i < 32768; i++) far.push({ kind: "text", prop: { lbl: null, inst: null, cmt: "", loc: i + 2 } });
    far.push({ kind: "text", prop: { lbl: "far", inst: null, cmt: "", loc: 32770 } });
    const e = thrown(() => check(far, null));
    expect(e.message).toBe(
      `Label "far" (line 32770) is too far away: an offset of 32768 instructions doesn't fit in the 16-bit branch offset`,
    );
    expect(e.loc).toBe(1);
  });

  it("accepts forward and backward references", () => {
    expect(() =>
      check(text(label("top", B("bne", "t0", "zero", "bottom")), J("top"), label("bottom")), null),
    ).not.toThrow();
  });
});

describe("check: la targets", () => {
  it("rejects la to a label that isn't in .data", () => {
    const e = thrown(() => check(text(V("t0", "missing")), [words("arr", [1])]));
    expect(e.message).toBe('"la" refers to "missing", but no .data label has that name');
    expect(e.loc).toBe(1);
    expect(e.comp).toBe("data");
  });

  it("rejects la when there is no .data segment at all", () => {
    expect(() => check(text(V("t0", "arr")), null)).toThrow('"la" refers to "arr", but no .data label has that name');
  });

  it("accepts la to a declared label (assembly then refuses it, see staticCheck)", () => {
    expect(() => check(text(V("t0", "arr")), [words("arr", [1])])).not.toThrow();
  });
});

describe("lineRef", () => {
  it("formats a 1-based line number the way every error message does", () => {
    expect(lineRef(7)).toBe("line 7");
  });
});

describe("layoutData", () => {
  it("returns an empty map without a .data segment", () => {
    expect(layoutData(null).size).toBe(0);
    expect(layoutData([]).size).toBe(0);
  });

  it("lays declarations out back to back, each padded to a word boundary", () => {
    const bases = layoutData([
      words("w", [1, 2, 3]), // 12 bytes
      bytes("b", [1, 2, 3, 4, 5]), // 5 -> 8
      asciiz("s", "hi"), // "hi\0" 3 -> 4
      asciiz("t", "abcd"), // "abcd\0" 5 -> 8
      words("end", [0]),
    ]);
    expect(Object.fromEntries(bases)).toEqual({ w: 0, b: 12, s: 20, t: 24, end: 32 });
  });

  it("an empty string still takes a word (for its NUL)", () => {
    expect(layoutData([asciiz("e", ""), words("x", [1])]).get("x")).toBe(4);
  });
});

describe("print (assembled listing)", () => {
  const listing = (lines: TextLine[]) =>
    mipsUtil.print(assemble(lines, null)).trimEnd().split("\n").map((l) => l.replace(/\s+/g, " ").trim());

  it("prints one line per instruction with its hex word", () => {
    expect(listing(text(R("add", "t2", "t0", "t1"), I("addi", "t0", "zero", -5)))).toEqual([
      "add $t2 , $t0 , $t1 # 0x01095020",
      "addi $t0 , $zero, -5 # 0x2008FFFB",
    ]);
  });

  it("shows hex immediates in hex and memory operands as offset(base)", () => {
    expect(listing(text(L("ori", "t0", "t1", 0xff), M("lw", "t2", -4, "t0"), U("t3", 0x1234)))).toEqual([
      "ori $t0 , $t1 , 0x00FF # 0x352800FF",
      "lw $t2 , -4($t0) # 0x8D0AFFFC",
      "lui $t3 , 0x1234 # 0x3C0B1234",
    ]);
  });

  it("shows resolved branch offsets and jump targets, not label names", () => {
    expect(
      listing(text(label("top", B("beq", "t0", "t1", "top")), J("top"))),
    ).toEqual(["beq $t0 , $t1 , -1 # 0x1109FFFF", "j 0 # 0x08000000"]);
  });

  it("the default export bundles print/check/assemble/layoutData/lineRef", () => {
    expect(Object.keys(mipsUtil).sort()).toEqual(["assemble", "check", "layoutData", "lineRef", "print"]);
  });
});

describe("print (source pretty-printer)", () => {
  it("aligns labels and keeps comments", () => {
    const out = print(text(label("loop", I("addi", "t0", "t0", 1)), { inst: I("addi", "t1", "t1", 1), cmt: "count" }));
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("loop: addi")).toBe(true);
    expect(lines[1].startsWith("      addi")).toBe(true);
    expect(lines[1]).toMatch(/ # count$/);
  });

  it("skips blank lines", () => {
    expect(print(text({ inst: null }, I("addi", "t0", "zero", 1))).split("\n").filter(Boolean)).toHaveLength(1);
  });
});
