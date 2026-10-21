/**
 * Assembly-time checks for errors that would otherwise surface with no
 * usable line number. Each throws a CompileError (comp "check") carrying
 * the offending source line, so App's Assemble handler reports it the same
 * way as a syntax error (console message + red marker on that line). The
 * messages here don't include the line number themselves: App prefixes
 * "Error at line N: " to errors tagged "check", matching the format of its
 * test-run errors.
 *
 *   checkSource(text, data)            before assemble():
 *     - `la`: not implemented by the assembler yet (see mips-util's
 *       assemble() notes). It used to throw a plain Error with no line,
 *       so the editor marked line 1 instead of the `la`.
 *
 *   checkProgram(data, memSize)        after assemble():
 *     - The .data segment must fit in memory. Loading it used to fail
 *       inside App's initializeMemory() with no line (line 1 marked).
 *
 * Bad memory addresses in lw/sw/lb/sb (out of range, or lw/sw not
 * word-aligned) are NOT checked here. They're caught when the program
 * runs: first by App's test run on Assemble (from the current register and
 * memory values), and otherwise when execution reaches them, where the run
 * stops at that line and can be fixed and resumed (see useMachineHistory's
 * planResume()).
 *
 * (Writes to $zero, including `lui $zero`, are rejected by the assembler
 * itself: mips-util's check$dst_zero.)
 */
import { CompileError } from "../Numbers/err";
import { outOfRangeMem } from "./memoryWords";
import type { DataDecl, NumNode, TextLine } from "../mips-parser/ast";

// ---- Source-level checks -------------------------------------------------

export function checkSource(text: TextLine[], _data: DataDecl[] | null): void {
  for (const line of text) {
    const inst = line.prop.inst;
    if (inst === null) continue;
    const loc = line.prop.loc;
    if (inst.prop.type === "V") {
      // No "at line N" here: App adds "Error at line N: " in front.
      throw new CompileError(
        `"la" (load address) is not supported yet — load the address with lui/ori, or use addi from $zero`,
        "check",
        [inst, loc],
        loc,
      );
    }
  }
}

// ---- .data must fit in memory ---------------------------------------------

/** Mirrors App's initializeMemory() / mips-util's layoutData(): ints are
 * stored with sw, bytes and strings with sb, each declaration padded to a
 * 4-byte boundary. The error is the one that store would throw. */
function checkDataFits(data: DataDecl[] | null, memSize: number): void {
  if (data === null) return;
  let addr = 0;
  for (const decl of data) {
    let size: number;
    switch (decl.prop.type) {
      case "int":
        size = 4 * (decl.prop.vals as NumNode[]).length;
        break;
      case "byte":
        size = 4 * Math.ceil((decl.prop.vals as NumNode[]).length / 4);
        break;
      case "str":
        size = 4 * Math.ceil(((decl.prop.vals as string).length + 1) / 4);
        break;
    }
    if (addr + size > memSize) {
      const firstBad = Math.max(addr, memSize);
      const err = outOfRangeMem(decl.prop.type === "int" ? "SW" : "SB", firstBad);
      throw new CompileError(err.message, "check", [decl, firstBad], decl.prop.loc);
    }
    addr += size;
  }
}

/**
 * Checks what the assembled program needs before it can be loaded; throws
 * a CompileError for the first problem, at its source line. Currently
 * just that the .data segment fits in `memSize` bytes of memory.
 */
export function checkProgram(data: DataDecl[] | null, memSize: number): void {
  checkDataFits(data, memSize);
}