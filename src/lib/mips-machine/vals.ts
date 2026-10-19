/**
 * Canonical list of the datapath's scratch/intermediate wire values — the
 * definitional data vals.js's vals$init() built its table from, extracted
 * into a plain data structure (same treatment as reg.js -> registers.ts).
 *
 * These are the values mips.js's exec() reads/writes between pipeline
 * sub-stages (RR1/RR2/WR/RD1/RD2/WD from the register file, op1/op2/res
 * from the ALU, Addr/WD/RD from memory) — NOT user/program registers.
 *
 * `key` is the exact string mips.js's vals.RD("...")/vals.WR("...", ...)
 * call sites use (verified against every call site in mips.js, e.g.
 * vals.WR("REGRR1", ...), vals.WR("ALUres", ...), vals.WR("MEMAddr", ...)).
 * It's just `comp + name`, matching the original's `_vals[comp+name]`
 * lookup — kept as an explicit field here instead of concatenated at every
 * call site.
 *
 * VALS is also the single source of the ValKey type (the same trick ctrl.ts
 * uses for Kind): `as const` keeps each key as its literal string, so
 * ValKey is exactly "REGRR1" | "REGRR2" | ... | "MEMRD". ValsSnapshot
 * (machineState.ts), useValsBank's RD/WR/setBase and pipeline.ts's
 * STAGE_VAL_KEYS are all typed with it, so a misspelt key — reading
 * `vals.REGDR1`, writing `{ ...vals, REGDR1: rd1 }`, `valsBank.WR("REGDR1",
 * ...)` — is a compile error rather than a silent `undefined` (read as 0)
 * or a stray entry the table never shows.
 */
export interface ValDef {
  /** Bare signal name, e.g. "RR1", "op1", "Addr" — shown after the sup
   * label in the table ("REG:RR1", "ALU:op1", "MEM:Addr"). */
  name: string;
  /** Component group this wire belongs to. */
  comp: "REG" | "ALU" | "MEM";
  /** Lookup key for RD()/WR() — comp + name. */
  key: string;
}

export const VALS = [
  { name: "RR1", comp: "REG", key: "REGRR1" },
  { name: "RR2", comp: "REG", key: "REGRR2" },
  { name: "WR", comp: "REG", key: "REGWR" },
  { name: "RD1", comp: "REG", key: "REGRD1" },
  { name: "RD2", comp: "REG", key: "REGRD2" },
  { name: "WD", comp: "REG", key: "REGWD" },
  { name: "op1", comp: "ALU", key: "ALUop1" },
  { name: "op2", comp: "ALU", key: "ALUop2" },
  { name: "res", comp: "ALU", key: "ALUres" },
  { name: "Addr", comp: "MEM", key: "MEMAddr" },
  { name: "WD", comp: "MEM", key: "MEMWD" },
  { name: "RD", comp: "MEM", key: "MEMRD" },
] as const satisfies readonly ValDef[];

/** One entry of VALS, with its literal name/comp/key types. */
export type ValEntry = (typeof VALS)[number];

/** Every valid wire key: "REGRR1" | "REGRR2" | ... | "MEMRD". */
export type ValKey = ValEntry["key"];