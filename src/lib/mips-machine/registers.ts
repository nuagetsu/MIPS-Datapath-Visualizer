/**
 * Canonical MIPS register list — the definitional data reg.js's
 * reg$init() built its table from, extracted into a plain data structure.
 *
 * $at (1) and $k0/$k1/$gp/$sp/$fp/$ra (26-31) are deliberately excluded —
 * matching the same decision made in mips.peggy's Reg rule. These are
 * conventionally reserved (assembler-temporary, OS/kernel,
 * global/stack/frame pointer, return address), and this simulator has no
 * pseudo-instruction expansion, OS, or calling convention (no `jal`) that
 * would give them real meaning — allowing them anyway would just let a
 * program use `$sp` as an ordinary scratch register, teaching the wrong
 * mental model. Since the grammar already rejects these at parse time
 * (by name and by number), the interpreter can never actually reference
 * them — but they're excluded here too, rather than just left unreachable,
 * so the register table doesn't display 7 rows that could never be
 * written to by any program that could ever assemble.
 */
export interface RegisterDef {
  /** Bare name, no leading $ — e.g. "t0", "pc", "zero". */
  name: string;
  /** Register index 0-31, or null for $pc (which has no numeric index). */
  num: number | null;
  /** If true, WR() always throws — only $zero. */
  readonly: boolean;
  /** If false, the UI input is read-only — $zero and $pc (pc is only
   * ever written programmatically by the interpreter, not by the user). */
  editable: boolean;
}

export const REGISTERS: RegisterDef[] = [
  { name: "pc", num: null, readonly: false, editable: false },
  { name: "zero", num: 0, readonly: true, editable: false },
  { name: "v0", num: 2, readonly: false, editable: true },
  { name: "v1", num: 3, readonly: false, editable: true },
  { name: "a0", num: 4, readonly: false, editable: true },
  { name: "a1", num: 5, readonly: false, editable: true },
  { name: "a2", num: 6, readonly: false, editable: true },
  { name: "a3", num: 7, readonly: false, editable: true },
  { name: "t0", num: 8, readonly: false, editable: true },
  { name: "t1", num: 9, readonly: false, editable: true },
  { name: "t2", num: 10, readonly: false, editable: true },
  { name: "t3", num: 11, readonly: false, editable: true },
  { name: "t4", num: 12, readonly: false, editable: true },
  { name: "t5", num: 13, readonly: false, editable: true },
  { name: "t6", num: 14, readonly: false, editable: true },
  { name: "t7", num: 15, readonly: false, editable: true },
  { name: "s0", num: 16, readonly: false, editable: true },
  { name: "s1", num: 17, readonly: false, editable: true },
  { name: "s2", num: 18, readonly: false, editable: true },
  { name: "s3", num: 19, readonly: false, editable: true },
  { name: "s4", num: 20, readonly: false, editable: true },
  { name: "s5", num: 21, readonly: false, editable: true },
  { name: "s6", num: 22, readonly: false, editable: true },
  { name: "s7", num: 23, readonly: false, editable: true },
  { name: "t8", num: 24, readonly: false, editable: true },
  { name: "t9", num: 25, readonly: false, editable: true },
];