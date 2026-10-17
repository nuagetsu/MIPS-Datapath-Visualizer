/**
 * TS/React port of reg.js's register-state half (the DOM-construction half
 * moves to RegisterTable.tsx instead — reg.js mixed both together, but
 * there's no third-party library forcing that here the way there was for
 * Ace, so this splits into state (this hook) + rendering (the component).
 *
 * Mirrors useAceEditor's pattern for the same reason: RR()/WR() need to be
 * callable from the simulator's exec() loop, outside the render cycle, and
 * need the just-written value back synchronously — plain React state can't
 * do that (a value set via setState isn't readable until the next render).
 * So the actual bits live in a ref; React state exists purely to trigger
 * re-renders for the visual mark colors (success/warning/danger/default)
 * and the current display base.
 *
 * Timeline scrubbing: marks are mirrored into a ref too, so snapshot() can
 * capture a register file's values *and* this step's read/write marks
 * synchronously, mid-step, and restore() can put both back when the user
 * scrubs to that step again (see useMachineHistory).
 */
import { useCallback, useRef, useState } from "react";
import { int32, type Int32Bits } from "../lib/Numbers/int32";
import { RuntimeError } from "../lib/Numbers/err";
import { REGISTERS } from "../lib/mips-machine/registers";

export type DisplayBase = "hex" | "dec";
export type MarkStatus = "default" | "success" | "warning" | "danger";

export interface RegisterDisplay {
  bits: Int32Bits;
  base: DisplayBase;
  mark: MarkStatus;
}

/** Every register's value and mark at one moment — see snapshot()/restore(). */
export interface RegisterSnapshot {
  bits: Record<string, Int32Bits>;
  marks: Record<string, MarkStatus>;
}

export interface RegisterBank {
  /** Current display state, keyed by bare register name (no $). Read this
   * for rendering; use RR()/WR() for imperative reads/writes. */
  registers: Record<string, RegisterDisplay>;
  /** Read a register — marks it "success" (this cycle read this register)
   * and returns its current bits synchronously. Accepts either "$t0" or
   * "t0". */
  RR: (name: string) => Int32Bits;
  /** Same value RR() would return, without marking anything — for
   * pipeline.ts's look-ahead, which reads an instruction's registers when
   * it's fetched but only marks them when it reaches Decode. */
  peek: (name: string) => Int32Bits;
  /** Write a register — marks it "warning" (this cycle wrote this
   * register). Throws RuntimeError if the register is readonly ($zero),
   * matching reg.js's reg$ReadOnly exactly. */
  WR: (name: string, bits: Int32Bits) => void;
  /** Resets every register's mark back to "default" — called at the start
   * of each cycle stage in the original exec() loop. */
  RES: () => void;
  /** Switches a register's display base (hex/dec) without changing its
   * value — the hex/dec toggle buttons. */
  setBase: (name: string, base: DisplayBase) => void;
  /** Attempts to parse user-typed text (per the register's current base)
   * and commit it. Returns true/marks "warning" on success; returns
   * false/marks "danger" and leaves the value unchanged on failure —
   * matches save()'s try/catch/revert behavior exactly. */
  trySave: (name: string, text: string) => boolean;
  /** Every register's current value and mark, read synchronously. */
  snapshot: () => RegisterSnapshot;
  /** Puts back the values and marks from snapshot(). Display bases are
   * left as they are — they're a viewing preference, not machine state. */
  restore: (snap: RegisterSnapshot) => void;
}

function bareName(name: string): string {
  return name.startsWith("$") ? name.slice(1) : name;
}

function initialDisplay(): Record<string, RegisterDisplay> {
  const state: Record<string, RegisterDisplay> = {};
  for (const def of REGISTERS) {
    state[def.name] = { bits: int32.num(0), base: "hex", mark: "default" };
  }
  return state;
}

export function useRegisterBank(): RegisterBank {
  const bitsRef = useRef<Record<string, Int32Bits>>(
    Object.fromEntries(REGISTERS.map((d) => [d.name, int32.num(0)])),
  );
  const marksRef = useRef<Record<string, MarkStatus>>(
    Object.fromEntries(REGISTERS.map((d) => [d.name, "default" as MarkStatus])),
  );
  const baseRef = useRef<Record<string, DisplayBase>>(
    Object.fromEntries(REGISTERS.map((d) => [d.name, "hex" as DisplayBase])),
  );
  const [registers, setRegisters] = useState<Record<string, RegisterDisplay>>(initialDisplay);

  const setMark = useCallback((key: string, mark: MarkStatus) => {
    marksRef.current[key] = mark;
    setRegisters((prev) => ({ ...prev, [key]: { ...prev[key], mark } }));
  }, []);

  const RR = useCallback(
    (name: string): Int32Bits => {
      const key = bareName(name);
      const bits = bitsRef.current[key];
      setMark(key, "success");
      return bits;
    },
    [setMark],
  );

  const peek = useCallback((name: string): Int32Bits => bitsRef.current[bareName(name)], []);

  const WR = useCallback(
    (name: string, bits: Int32Bits): void => {
      const key = bareName(name);
      const def = REGISTERS.find((d) => d.name === key);
      if (def?.readonly) {
        setMark(key, "danger");
        throw new RuntimeError(
          `Attempt to write to a readonly register ${key} (${def.num})`,
          "reg.ts",
          [key, def.num],
        );
      }
      bitsRef.current[key] = bits;
      marksRef.current[key] = "warning";
      setRegisters((prev) => ({ ...prev, [key]: { ...prev[key], bits, mark: "warning" } }));
    },
    [setMark],
  );

  const RES = useCallback((): void => {
    for (const key of Object.keys(marksRef.current)) marksRef.current[key] = "default";
    setRegisters((prev) => {
      const next: Record<string, RegisterDisplay> = {};
      for (const key of Object.keys(prev)) next[key] = { ...prev[key], mark: "default" };
      return next;
    });
  }, []);

  const setBase = useCallback((name: string, base: DisplayBase): void => {
    const key = bareName(name);
    baseRef.current[key] = base;
    setRegisters((prev) => ({ ...prev, [key]: { ...prev[key], base } }));
  }, []);

  const trySave = useCallback(
    (name: string, text: string): boolean => {
      const key = bareName(name);
      const base = baseRef.current[key] ?? "hex";
      try {
        const bits = base === "hex" ? int32.hex(text) : int32.dec(text);
        bitsRef.current[key] = bits;
        marksRef.current[key] = "warning";
        setRegisters((prev) => ({ ...prev, [key]: { ...prev[key], bits, mark: "warning" } }));
        return true;
      } catch {
        setMark(key, "danger");
        return false;
      }
    },
    [setMark],
  );

  const snapshot = useCallback(
    (): RegisterSnapshot => ({ bits: { ...bitsRef.current }, marks: { ...marksRef.current } }),
    [],
  );

  const restore = useCallback((snap: RegisterSnapshot): void => {
    bitsRef.current = { ...snap.bits };
    marksRef.current = { ...snap.marks };
    setRegisters((prev) => {
      const next: Record<string, RegisterDisplay> = {};
      for (const key of Object.keys(prev)) {
        next[key] = { ...prev[key], bits: snap.bits[key] ?? prev[key].bits, mark: snap.marks[key] ?? "default" };
      }
      return next;
    });
  }, []);

  return { registers, RR, peek, WR, RES, setBase, trySave, snapshot, restore };
}