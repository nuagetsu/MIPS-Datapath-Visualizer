/**
 * Rendering tests for the value tables, using react-dom/server's
 * renderToStaticMarkup: no DOM needed, so they run in Vitest's default node
 * environment. Banks come from the real hooks.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, renderHook } from "@testing-library/react";
import { RegisterTable } from "../../src/components/RegisterTable";
import { MemoryTable } from "../../src/components/MemoryTable";
import { ValsTable } from "../../src/components/ValsTable";
import { ControlTable, type ForwardingRowsData } from "../../src/components/ControlTable";
import { useRegisterBank } from "../../src/hooks/useRegisterBank";
import { useMemoryBank } from "../../src/hooks/useMemoryBank";
import { useValsBank } from "../../src/hooks/useValsBank";
import { useCtrlBank } from "../../src/hooks/useControlBank";
import { REGISTERS } from "../../src/lib/mips-isa/registers";
import { CONTROLS, KIND } from "../../src/lib/mips-machine/ctrl";
import { n } from "../helpers/bits";

const count = (html: string, needle: string) => html.split(needle).length - 1;
const inputValues = (html: string) => [...html.matchAll(/<input [^>]*value="([^"]*)"/g)].map((m) => m[1]);
const rowsOf = (html: string, cls: string) => [...html.matchAll(new RegExp(`<tr class="${cls} ([^"]*)">(.*?)</tr>`, "g"))];

// ---- RegisterTable -------------------------------------------------------------

describe("RegisterTable", () => {
  const bank = () => renderHook(() => useRegisterBank()).result;

  it("shows every register by default", () => {
    const html = renderToStaticMarkup(createElement(RegisterTable, { bank: bank().current }));
    expect(count(html, 'class="register-row ')).toBe(REGISTERS.length);
  });

  it("filters to the given register numbers, always keeping $pc", () => {
    const html = renderToStaticMarkup(createElement(RegisterTable, { bank: bank().current, shownRegs: new Set([8, 9]) }));
    expect(count(html, 'class="register-row ')).toBe(3);
    expect(html).toContain("$pc");
    expect(html).toContain("$t0");
    expect(html).toContain("$t1");
    expect(html).not.toContain("$t2");
  });

  it("an empty filter still shows $pc", () => {
    const html = renderToStaticMarkup(createElement(RegisterTable, { bank: bank().current, shownRegs: new Set() }));
    expect(count(html, 'class="register-row ')).toBe(1);
  });

  it("labels rows with the register number (two digits) or 'pc'", () => {
    const html = renderToStaticMarkup(createElement(RegisterTable, { bank: bank().current }));
    expect(html).toContain("<sup>pc:</sup>$pc");
    expect(html).toContain("<sup>00:</sup>$zero");
    expect(html).toContain("<sup>08:</sup>$t0");
  });

  it("formats values in each register's base and shows its mark", () => {
    const r = bank();
    act(() => {
      r.current.WR("t0", n(42));
      r.current.WR("t1", n(-1));
      r.current.setBase("t1", "dec");
    });
    const html = renderToStaticMarkup(createElement(RegisterTable, { bank: r.current, shownRegs: new Set([8, 9]) }));
    expect(inputValues(html)).toEqual(["0x00000000", "0x0000002A", "-1"]);
    const rows = rowsOf(html, "register-row");
    expect(rows.map((m) => m[1])).toEqual(["mark-default", "mark-warning", "mark-warning"]);
  });

  it("$pc and $zero are read-only; the rest are editable", () => {
    const html = renderToStaticMarkup(createElement(RegisterTable, { bank: bank().current, shownRegs: new Set([0, 8]) }));
    const inputs = [...html.matchAll(/<input [^>]*>/g)].map((m) => m[0].includes("readOnly") || m[0].includes("readonly"));
    expect(inputs).toEqual([true, true, false]);
  });

  it("highlights the active base button", () => {
    const r = bank();
    act(() => r.current.setBase("t0", "dec"));
    const html = renderToStaticMarkup(createElement(RegisterTable, { bank: r.current, shownRegs: new Set([8]) }));
    const t0Row = rowsOf(html, "register-row")[1][2];
    expect(t0Row).toMatch(/<button type="button" class="">16<\/button>/);
    expect(t0Row).toMatch(/<button type="button" class="active">10<\/button>/);
  });
});

// ---- MemoryTable -----------------------------------------------------------------

describe("MemoryTable", () => {
  const bank = (size?: number) => renderHook(() => useMemoryBank(size)).result;

  it("shows one row per word, addressed in bytes", () => {
    const html = renderToStaticMarkup(createElement(MemoryTable, { bank: bank().current }));
    expect(count(html, 'class="memory-row ')).toBe(64);
    expect(html).toContain('<td class="mem-addr">0x00</td>');
    expect(html).toContain('<td class="mem-addr">0x04</td>');
    expect(html).toContain('<td class="mem-addr">0xFC</td>');
  });

  it("widens address labels for bigger memories so they stay unique (regression)", () => {
    const html = renderToStaticMarkup(createElement(MemoryTable, { bank: bank(1024).current }));
    expect(html).toContain('<td class="mem-addr">0x000</td>');
    expect(html).toContain('<td class="mem-addr">0x3FC</td>');
    const labels = [...html.matchAll(/<td class="mem-addr">([^<]*)<\/td>/g)].map((m) => m[1]);
    expect(new Set(labels).size).toBe(256);
  });

  it("filters without renumbering", () => {
    const r = bank();
    act(() => r.current.sw(12, n(7)));
    const html = renderToStaticMarkup(createElement(MemoryTable, { bank: r.current, shownWords: new Set([3, 10]) }));
    expect([...html.matchAll(/<td class="mem-addr">([^<]*)<\/td>/g)].map((m) => m[1])).toEqual(["0x0C", "0x28"]);
    expect(inputValues(html)).toEqual(["0x00000007", "0x00000000"]);
  });

  it("explains an empty filter", () => {
    const html = renderToStaticMarkup(createElement(MemoryTable, { bank: bank().current, shownWords: new Set() }));
    expect(html).toContain("No memory addresses referenced yet");
  });

  it("shows marks and decimal values", () => {
    const r = bank();
    act(() => {
      r.current.sw(0, n(-20));
      r.current.setBase(0, "dec");
    });
    const html = renderToStaticMarkup(createElement(MemoryTable, { bank: r.current, shownWords: new Set([0]) }));
    expect(inputValues(html)).toEqual(["-20"]);
    expect(rowsOf(html, "memory-row")[0][1]).toBe("mark-warning");
  });
});

// ---- ValsTable ---------------------------------------------------------------------

describe("ValsTable", () => {
  it("lists the 12 datapath values, read-only, labelled COMP:name", () => {
    const r = renderHook(() => useValsBank()).result;
    act(() => {
      r.current.WR("ALUres", n(12));
      r.current.setBase("ALUres", "dec");
    });
    const html = renderToStaticMarkup(createElement(ValsTable, { bank: r.current }));
    expect(count(html, 'class="vals-row ')).toBe(12);
    expect(html).toContain("<sup>ALU:</sup>res");
    expect(html).toContain("<sup>MEM:</sup>Addr");
    expect(inputValues(html)).toContain("12");
    expect(count(html, "readOnly") + count(html, "readonly")).toBe(12);
  });
});

// ---- ControlTable --------------------------------------------------------------------

describe("ControlTable", () => {
  const bank = () => renderHook(() => useCtrlBank()).result;

  it("has one column per instruction kind and one row per signal", () => {
    const html = renderToStaticMarkup(createElement(ControlTable, { bank: bank().current }));
    expect(count(html, '<th class="ctrl-head')).toBe(KIND.length);
    expect(count(html, '<td class="ctrl-name')).toBe(CONTROLS.length);
    expect(count(html, '<td class="ctrl-cell')).toBe(KIND.length * CONTROLS.length);
  });

  it("filters columns, keeping each cell under its own header", () => {
    const html = renderToStaticMarkup(createElement(ControlTable, { bank: bank().current, shownKinds: new Set(["sub", "lw"]) }));
    expect([...html.matchAll(/<th class="ctrl-head[^"]*">([^<]*)<\/th>/g)].map((m) => m[1])).toEqual(["sub", "lw"]);
    // ALUctrl is the last row: sub = 6, lw = 2, shown as 4 bits.
    const vals = inputValues(html);
    expect(vals.slice(-2)).toEqual(["0110", "0010"]);
    // RegDst (first row): sub = 1, lw = 0.
    expect(vals.slice(0, 2)).toEqual(["1", "0"]);
  });

  it("marks the cells and header read this step", () => {
    const r = bank();
    act(() => {
      r.current.RD("RegWrite", "add");
    });
    const html = renderToStaticMarkup(createElement(ControlTable, { bank: r.current, shownKinds: new Set(["add"]) }));
    expect(html).toContain('<th class="ctrl-head mark-success">add</th>');
    expect(html).toContain('<td class="ctrl-name mark-success">RegWrite</td>');
    expect(html).toContain('<td class="ctrl-name mark-default">RegDst</td>');
  });

  it("forwarding rows show a value only in their instruction's column", () => {
    const forwarding: ForwardingRowsData = {
      rows: [
        { name: "Fwdop1", op: "add", value: "10" },
        { name: "Fwdop2", op: "add", value: "00", warn: true, title: "Load-use hazard" },
        { name: "FwdRD1", op: null, value: "00" },
      ],
      note: { kind: "info", text: "Forwarding from EX/MEM." },
    };
    const html = renderToStaticMarkup(
      createElement(ControlTable, { bank: bank().current, forwarding, shownKinds: new Set(["add", "sub"]) }),
    );
    const fwdRows = [...html.matchAll(/<tr class="ctrl-fwd-row">(.*?)<\/tr>/g)].map((m) => m[1]);
    expect(fwdRows).toHaveLength(4);
    expect(inputValues(fwdRows[0])).toEqual(["10", "--"]);
    expect(fwdRows[0]).toContain('<td class="ctrl-name mark-success">Fwdop1</td>');
    expect(fwdRows[1]).toContain('class="ctrl-cell mark-warning" title="Load-use hazard"');
    expect(inputValues(fwdRows[2])).toEqual(["--", "--"]);
    expect(fwdRows[2]).toContain('<td class="ctrl-name mark-default">FwdRD1</td>');
    expect(fwdRows[3]).toContain('colSpan="3"');
    expect(fwdRows[3]).toContain("ctrl-fwd-note-info");
    expect(fwdRows[3]).toContain("Forwarding from EX/MEM.");
  });

  it("no forwarding prop, no forwarding rows", () => {
    expect(renderToStaticMarkup(createElement(ControlTable, { bank: bank().current }))).not.toContain("ctrl-fwd-row");
  });
});
