/**
 * Canonical MIPS register list — the single source of truth for which
 * registers exist in this simulator and what their numbers are. The
 * assembler grammar (mips.peggy), the interpreter, the register bank and
 * the register table all derive from this list; nothing else should
 * hard-code register names or numbers.
 *
 * $at (1) and $k0/$k1/$gp/$sp/$fp/$ra (26-31) are deliberately excluded.
 * Conventionally: $at is reserved for the assembler's own use when
 * expanding pseudo-instructions (e.g. a future `la` expansion into
 * lui+ori would want it); $k0/$k1 are reserved for OS/kernel use;
 * $gp/$sp/$fp are the global/stack/frame pointers a real calling
 * convention manages; $ra holds the return address `jal`/`jr` use. This
 * simulator has no pseudo-instruction expansion, OS, or calling
 * convention (no `jal`), so none of these would carry real meaning —
 * allowing them anyway would just let a program use `$sp` as an ordinary
 * scratch register, teaching the wrong mental model.
 *
 * Because the grammar builds its register lookup from this list, leaving
 * a register out here rejects it at parse time by name AND by number
 * ($26 fails exactly like $k0 does), and also keeps it out of the
 * register table. To re-enable one, add it here — nowhere else.
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

// ---- Derived lookups ---------------------------------------------------
//
// The addressable registers only: everything with a number. $pc has no
// number and can't be named in an instruction, so it's absent from both
// maps — `$pc` in source fails to parse, as before.

const ADDRESSABLE = REGISTERS.filter(
  (r): r is RegisterDef & { num: number } => r.num !== null,
);

/** Register number -> bare name (e.g. 8 -> "t0"). Usable registers only. */
export const REG_NUM_TO_NAME: ReadonlyMap<number, string> = new Map(
  ADDRESSABLE.map((r) => [r.num, r.name]),
);

/** Bare name -> register number (e.g. "t0" -> 8). Usable registers only. */
export const REG_NAME_TO_NUM: ReadonlyMap<string, number> = new Map(
  ADDRESSABLE.map((r) => [r.name, r.num]),
);

/** Human-readable list of the usable register numbers, collapsed into
 * ranges (currently "0, 2-25") — for parse errors, so the message can't
 * drift from the table either. */
export const USABLE_REG_NUMS_TEXT: string = (() => {
  const nums = ADDRESSABLE.map((r) => r.num).sort((a, b) => a - b);
  const parts: string[] = [];
  let start = nums[0];
  let prev = nums[0];
  for (const n of [...nums.slice(1), Infinity]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = n;
  }
  return parts.join(", ");
})();