import type { Int32Bits } from "../lib/Numbers/int32";
import { KIND, CONTROLS } from "../lib/mips-machine/ctrl";
import { formatControlBits, type CtrlBank, type MarkStatus } from "../hooks/useControlBank";
import "./ControlTable.css";

/** This cycle's forwarding-unit outputs, for the two extra rows shown in
 * pipeline hazards mode. Unlike every other control signal, Fwdop1/Fwdop2
 * aren't a fixed value per instruction kind: the forwarding unit computes
 * them each cycle for whichever instruction is in EX. So the rows show the
 * value only in that instruction's column (marked as read) and "--" in
 * every other column. */
export interface ForwardingRowsData {
  /** Mnemonic of the instruction in EX, or null if EX is empty. */
  op: string | null;
  /** Two-bit strings, e.g. "10". */
  fwdop1: string;
  fwdop2: string;
  /** Load-use hazard on that operand (forwarding.ts's loadUseA/loadUseB):
   * the cell is marked as a warning. */
  loadUse1: boolean;
  loadUse2: boolean;
  /** A one-line explanation under the rows — a load-use hazard being
   * detected, a stall in progress, or an unresolved hazard — or null. */
  note: { kind: "info" | "warning"; text: string } | null;
}

interface ControlTableProps {
  bank: CtrlBank;
  /** Pipeline hazards mode only. Omit (undefined) to hide the Fwdop rows. */
  forwarding?: ForwardingRowsData;
}

// Matrix layout — one header column per instruction kind, one row per
// control signal — unlike RegisterTable/ValsTable/MemoryTable, which are
// all single-value-per-row lists. Mirrors ctrl$init()'s DOM structure
// directly: thead built from KIND, one <tr> per CONTROLS entry.
//
// Read-only
export function ControlTable({ bank, forwarding }: ControlTableProps) {
  return (
    <table className="control-table">
      <thead>
        <tr>
          <th className="ctrl-corner">Control</th>
          {KIND.map((k) => (
            <th key={k} className={`ctrl-head mark-${bank.headerMarks[k]}`}>
              {k}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {CONTROLS.map((def) => (
          <ControlRow key={def.name} name={def.name} len={def.len} cells={bank.cells[def.name]} />
        ))}
        {forwarding && (
          <>
            <ForwardingRow name="Fwdop1" op={forwarding.op} value={forwarding.fwdop1} loadUse={forwarding.loadUse1} />
            <ForwardingRow name="Fwdop2" op={forwarding.op} value={forwarding.fwdop2} loadUse={forwarding.loadUse2} />
            {forwarding.note && (
              <tr className="ctrl-fwd-row">
                <td className={`ctrl-name ctrl-fwd-note ctrl-fwd-note-${forwarding.note.kind}`} colSpan={KIND.length + 1}>
                  {forwarding.note.text}
                </td>
              </tr>
            )}
          </>
        )}
      </tbody>
    </table>
  );
}

interface ControlRowProps {
  name: string;
  len: number;
  cells: { bits: Int32Bits; mark: MarkStatus }[];
}

function ControlRow({ name, len, cells }: ControlRowProps) {
  const rowMark = cells.some((c) => c.mark === "success") ? "success" : "default";
  return (
    <tr>
      <td className={`ctrl-name mark-${rowMark}`}>{name}</td>
      {KIND.map((k, i) => (
        <ControlCell key={k} len={len} state={cells[i]} />
      ))}
    </tr>
  );
}

interface ControlCellProps {
  len: number;
  state: { bits: Int32Bits; mark: MarkStatus };
}

function ControlCell({ len, state }: ControlCellProps) {
  return (
    <td className={`ctrl-cell mark-${state.mark}`}>
      <input type="text" value={formatControlBits(state.bits, len)} readOnly />
    </td>
  );
}

interface ForwardingRowProps {
  name: string;
  op: string | null;
  value: string;
  loadUse: boolean;
}

function ForwardingRow({ name, op, value, loadUse }: ForwardingRowProps) {
  const active = op !== null && (KIND as readonly string[]).includes(op);
  const mark = loadUse ? "warning" : "success";
  return (
    <tr className="ctrl-fwd-row">
      <td className={`ctrl-name mark-${active ? mark : "default"}`}>{name}</td>
      {KIND.map((k) => (
        <td
          key={k}
          className={`ctrl-cell mark-${k === op ? mark : "default"}`}
          title={k === op && loadUse ? "Load-use hazard: needs a one-cycle stall" : undefined}
        >
          <input type="text" value={k === op ? value : "--"} readOnly />
        </td>
      ))}
    </tr>
  );
}