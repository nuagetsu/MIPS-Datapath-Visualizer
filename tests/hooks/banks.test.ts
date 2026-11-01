import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRegisterBank } from "../../src/hooks/useRegisterBank";
import { useMemoryBank } from "../../src/hooks/useMemoryBank";
import { useValsBank } from "../../src/hooks/useValsBank";
import { formatControlBits, useCtrlBank } from "../../src/hooks/useControlBank";
import { REGISTERS } from "../../src/lib/mips-isa/registers";
import { CONTROLS, KIND, OPS } from "../../src/lib/mips-machine/ctrl";
import { VALS } from "../../src/lib/mips-machine/vals";
import { RuntimeError } from "../../src/lib/Numbers/err";
import { hex, n, num, u32 } from "../helpers/bits";

// ---- useRegisterBank -------------------------------------------------------------

describe("useRegisterBank", () => {
  const setup = () => renderHook(() => useRegisterBank());

  it("starts with every register at 0, hex, unmarked", () => {
    const { result } = setup();
    expect(Object.keys(result.current.registers).sort()).toEqual(REGISTERS.map((r) => r.name).sort());
    for (const r of Object.values(result.current.registers)) {
      expect(num(r.bits)).toBe(0);
      expect(r.base).toBe("hex");
      expect(r.mark).toBe("default");
    }
  });

  it("WR writes and marks 'warning'; RR reads and marks 'success'", () => {
    const { result } = setup();
    act(() => result.current.WR("t0", n(42)));
    expect(num(result.current.registers.t0.bits)).toBe(42);
    expect(result.current.registers.t0.mark).toBe("warning");

    let read = n(0);
    act(() => {
      result.current.RES();
      read = result.current.RR("$t0");
    });
    expect(num(read)).toBe(42);
    expect(result.current.registers.t0.mark).toBe("success");
  });

  it("returns a just-written value synchronously, before any re-render", () => {
    const { result } = setup();
    let read = n(0);
    act(() => {
      result.current.WR("t1", n(7));
      read = result.current.RR("t1");
    });
    expect(num(read)).toBe(7);
  });

  it("peek reads without marking", () => {
    const { result } = setup();
    act(() => result.current.WR("t2", n(3)));
    act(() => result.current.RES());
    expect(num(result.current.peek("$t2"))).toBe(3);
    expect(result.current.registers.t2.mark).toBe("default");
  });

  it("refuses to write $zero, marking it 'danger'", () => {
    const { result } = setup();
    let err: unknown = null;
    act(() => {
      try {
        result.current.WR("zero", n(1));
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as Error).message).toBe("Attempt to write to a readonly register zero (0)");
    expect(num(result.current.registers.zero.bits)).toBe(0);
    expect(result.current.registers.zero.mark).toBe("danger");
  });

  it("RES clears marks but keeps values", () => {
    const { result } = setup();
    act(() => result.current.WR("s0", n(9)));
    act(() => result.current.RES());
    expect(result.current.registers.s0.mark).toBe("default");
    expect(num(result.current.registers.s0.bits)).toBe(9);
  });

  it("trySave parses in the register's display base", () => {
    const { result } = setup();
    let ok = false;
    act(() => {
      ok = result.current.trySave("t0", "0x2A");
    });
    expect(ok).toBe(true);
    expect(num(result.current.registers.t0.bits)).toBe(42);

    act(() => result.current.setBase("t0", "dec"));
    act(() => {
      ok = result.current.trySave("t0", "-5");
    });
    expect(ok).toBe(true);
    expect(num(result.current.registers.t0.bits)).toBe(-5);
    expect(result.current.registers.t0.base).toBe("dec");
  });

  it("trySave rejects bad input, marks 'danger' and keeps the old value", () => {
    const { result } = setup();
    act(() => result.current.WR("t0", n(11)));
    let ok = true;
    act(() => {
      ok = result.current.trySave("t0", "xyz");
    });
    expect(ok).toBe(false);
    expect(result.current.registers.t0.mark).toBe("danger");
    expect(num(result.current.registers.t0.bits)).toBe(11);
  });

  it("setBase changes only the display base", () => {
    const { result } = setup();
    act(() => result.current.WR("a0", n(255)));
    act(() => result.current.setBase("$a0", "dec"));
    expect(result.current.registers.a0.base).toBe("dec");
    expect(num(result.current.registers.a0.bits)).toBe(255);
  });

  it("snapshot/restore put back values and marks, but not display bases", () => {
    const { result } = setup();
    act(() => result.current.WR("t0", n(1)));
    const snap = result.current.snapshot();
    act(() => {
      result.current.WR("t0", n(2));
      result.current.WR("t1", n(3));
      result.current.setBase("t0", "dec");
      result.current.RES();
    });
    act(() => result.current.restore(snap));
    expect(num(result.current.registers.t0.bits)).toBe(1);
    expect(result.current.registers.t0.mark).toBe("warning");
    expect(num(result.current.registers.t1.bits)).toBe(0);
    expect(result.current.registers.t0.base).toBe("dec");
    expect(num(result.current.peek("t0"))).toBe(1);
  });

  it("a snapshot is a copy (later writes don't change it)", () => {
    const { result } = setup();
    const snap = result.current.snapshot();
    act(() => result.current.WR("t0", n(5)));
    expect(num(snap.bits.t0)).toBe(0);
  });

  it("its functions keep the same identity across renders (useMachineHistory memoises on them)", () => {
    const { result } = setup();
    const before = result.current;
    act(() => result.current.WR("t0", n(1)));
    for (const k of ["RR", "peek", "WR", "RES", "setBase", "trySave", "snapshot", "restore"] as const) {
      expect(result.current[k]).toBe(before[k]);
    }
  });
});

// ---- useMemoryBank ---------------------------------------------------------------

describe("useMemoryBank", () => {
  const setup = (size?: number) => renderHook(() => useMemoryBank(size));

  it("defaults to 256 bytes = 64 words", () => {
    const { result } = setup();
    expect(result.current.size).toBe(256);
    expect(result.current.cells).toHaveLength(64);
    expect(result.current.addrOf(5)).toBe(20);
  });

  it("can be sized", () => {
    expect(setup(32).result.current.cells).toHaveLength(8);
  });

  it("sw/lw round-trip and mark the cell", () => {
    const { result } = setup();
    act(() => result.current.sw(8, n(99)));
    expect(num(result.current.cells[2].bits)).toBe(99);
    expect(result.current.cells[2].mark).toBe("warning");
    let v = n(0);
    act(() => {
      result.current.RES();
      v = result.current.lw(8);
    });
    expect(num(v)).toBe(99);
    expect(result.current.cells[2].mark).toBe("success");
  });

  it("lw/sw reject unaligned and out-of-range addresses", () => {
    const { result } = setup();
    expect(() => result.current.lw(2)).toThrow("Unaligned LW operation on address 2");
    expect(() => result.current.sw(256, n(0))).toThrow("Address 256 is out of range in SW");
    expect(() => result.current.lw(-4)).toThrow("Address -4 is out of range in LW");
  });

  it("sb/lb address bytes little-endian and lb sign-extends", () => {
    const { result } = setup();
    act(() => {
      result.current.sb(4, n(0x11));
      result.current.sb(5, n(0x22));
      result.current.sb(7, n(0xff));
    });
    expect(hex(result.current.cells[1].bits)).toBe("0xFF002211");
    expect(num(result.current.lb(5))).toBe(0x22);
    expect(num(result.current.lb(7))).toBe(-1);
    expect(() => result.current.lb(256)).toThrow("Address 256 is out of range in LB");
  });

  it("peekWord reads without marking", () => {
    const { result } = setup();
    act(() => result.current.sw(0, n(5)));
    act(() => result.current.RES());
    expect(num(result.current.peekWord(0))).toBe(5);
    expect(result.current.cells[0].mark).toBe("default");
  });

  it("usw/ulw handle unaligned words (little-endian, spanning two cells)", () => {
    const { result } = setup();
    act(() => result.current.usw(2, n(0x11223344)));
    expect(hex(result.current.cells[0].bits)).toBe("0x33440000");
    expect(hex(result.current.cells[1].bits)).toBe("0x00001122");
    expect(u32(result.current.ulw(2))).toBe(0x11223344);
    expect(() => result.current.ulw(253)).toThrow("Address 253 is out of range in ULW");
    expect(() => result.current.usw(-1, n(0))).toThrow("Address -1 is out of range in USW");
  });

  it("trySave parses per cell base; bad input marks 'danger'", () => {
    const { result } = setup();
    let ok = false;
    act(() => {
      ok = result.current.trySave(3, "FF");
    });
    expect(ok).toBe(true);
    expect(num(result.current.cells[3].bits)).toBe(255);
    act(() => result.current.setBase(3, "dec"));
    act(() => {
      ok = result.current.trySave(3, "0xFF");
    });
    expect(ok).toBe(false);
    expect(result.current.cells[3].mark).toBe("danger");
    expect(num(result.current.cells[3].bits)).toBe(255);
  });

  it("snapshot/restore put back values and marks", () => {
    const { result } = setup(16);
    act(() => result.current.sw(0, n(1)));
    const snap = result.current.snapshot();
    act(() => {
      result.current.sw(0, n(2));
      result.current.sw(4, n(3));
    });
    act(() => result.current.restore(snap));
    expect(result.current.cells.map((c) => num(c.bits))).toEqual([1, 0, 0, 0]);
    expect(result.current.cells.map((c) => c.mark)).toEqual(["warning", "default", "default", "default"]);
    expect(num(result.current.peekWord(4))).toBe(0);
  });
});

// ---- useValsBank -----------------------------------------------------------------

describe("useValsBank", () => {
  it("has one cell per VALS key, starting at 0", () => {
    const { result } = renderHook(() => useValsBank());
    expect(Object.keys(result.current.vals).sort()).toEqual(VALS.map((v) => v.key).sort());
    expect(Object.values(result.current.vals).every((v) => num(v.bits) === 0 && v.mark === "default")).toBe(true);
  });

  it("WR marks 'warning', RD marks 'success', RES clears marks", () => {
    const { result } = renderHook(() => useValsBank());
    act(() => result.current.WR("ALUres", n(12)));
    expect(result.current.vals.ALUres).toMatchObject({ mark: "warning" });
    expect(num(result.current.vals.ALUres.bits)).toBe(12);
    let v = n(0);
    act(() => {
      v = result.current.RD("ALUres");
    });
    expect(num(v)).toBe(12);
    expect(result.current.vals.ALUres.mark).toBe("success");
    act(() => result.current.RES());
    expect(result.current.vals.ALUres.mark).toBe("default");
    expect(num(result.current.vals.ALUres.bits)).toBe(12);
  });

  it("setBase", () => {
    const { result } = renderHook(() => useValsBank());
    act(() => result.current.setBase("MEMAddr", "dec"));
    expect(result.current.vals.MEMAddr.base).toBe("dec");
  });
});

// ---- useCtrlBank -----------------------------------------------------------------

describe("useCtrlBank", () => {
  it("holds the control table, unmarked", () => {
    const { result } = renderHook(() => useCtrlBank());
    for (const def of CONTROLS) {
      expect(result.current.cells[def.name].map((c) => num(c.bits))).toEqual(def.values);
    }
    expect(Object.keys(result.current.headerMarks)).toEqual([...KIND]);
  });

  it("RD returns the value and marks the cell and its column header", () => {
    const { result } = renderHook(() => useCtrlBank());
    let v = n(0);
    act(() => {
      v = result.current.RD("ALUctrl", "sub");
    });
    expect(num(v)).toBe(6);
    expect(result.current.cells.ALUctrl[OPS.sub].mark).toBe("success");
    expect(result.current.cells.ALUctrl[OPS.add].mark).toBe("default");
    expect(result.current.headerMarks.sub).toBe("success");
    act(() => result.current.RES());
    expect(result.current.cells.ALUctrl[OPS.sub].mark).toBe("default");
    expect(result.current.headerMarks.sub).toBe("default");
  });

  it("formatControlBits shows a value at the signal's width", () => {
    expect(formatControlBits(n(6), 4)).toBe("0110");
    expect(formatControlBits(n(1), 1)).toBe("1");
    expect(formatControlBits(n(8), 4)).toBe("1000");
  });
});
