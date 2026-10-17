/**
 * Which registers, memory words and instructions a program refers to, so
 * the register, memory and control tables can hide everything else (see
 * App.tsx's "Display all" toggle).
 *
 * Registers come straight from the assembled instructions' operands
 * ($pc is always shown by RegisterTable, so it isn't listed here).
 *
 * Memory is only partly knowable before running: a load/store's address
 * usually depends on a register computed at run time. This covers what
 * can be known statically:
 *   - every word of the .data segment (laid out exactly as App.tsx's
 *     initializeMemory() and mips-util.ts's layoutData() do), and
 *   - lw/sw/lb/sb whose base register is $zero, whose address is just the
 *     offset.
 * App.tsx adds every word actually read or written while running on top
 * of this, so addresses computed at run time appear as soon as they're
 * touched.
 *
 * Instruction kinds (ops) drive the Control table's columns: only the
 * mnemonics the program actually uses get a column.
 */
import type { DataDecl, Instr, NumNode, RegNode } from "../mips-parser/ast";

export interface ProgramRefs {
  /** Register numbers (0-31) used as an operand anywhere in the program. */
  registers: Set<number>;
  /** Word indices (byte address / 4) known to be referenced before running. */
  memoryWords: Set<number>;
  /** Mnemonics used anywhere in the program, e.g. "add", "addi". */
  ops: Set<string>;
}

function isReg(x: unknown): x is RegNode {
  return typeof x === "object" && x !== null && (x as { kind?: unknown }).kind === "reg";
}

/** Byte size of the .data segment, padded to 4-byte boundaries the same way
 * initializeMemory() writes it. */
export function dataSegmentBytes(data: DataDecl[] | null): number {
  if (data === null) return 0;
  let bytes = 0;
  for (const decl of data) {
    switch (decl.prop.type) {
      case "int":
        bytes += 4 * (decl.prop.vals as NumNode[]).length;
        break;
      case "byte":
        bytes += 4 * Math.ceil((decl.prop.vals as NumNode[]).length / 4);
        break;
      case "str":
        // +1 for the terminating NUL.
        bytes += 4 * Math.ceil(((decl.prop.vals as string).length + 1) / 4);
        break;
    }
  }
  return bytes;
}

export function collectProgramRefs(insts: Instr[], data: DataDecl[] | null): ProgramRefs {
  const registers = new Set<number>();
  const memoryWords = new Set<number>();
  const ops = new Set<string>();

  for (const inst of insts) {
    ops.add(inst.prop.op);
    const p = inst.prop as unknown as Record<string, unknown>;
    for (const field of ["dst", "src", "tgt"]) {
      const operand = p[field];
      if (isReg(operand)) registers.add(operand.prop.num);
    }
    // A load/store off $zero has a fixed address: the offset itself.
    if (inst.prop.type === "M" && inst.prop.src.prop.num === 0) {
      const addr = inst.prop.off.prop.num;
      if (addr >= 0) memoryWords.add(Math.floor(addr / 4));
    }
  }

  const dataWords = dataSegmentBytes(data) / 4;
  for (let w = 0; w < dataWords; w++) memoryWords.add(w);

  return { registers, memoryWords, ops };
}