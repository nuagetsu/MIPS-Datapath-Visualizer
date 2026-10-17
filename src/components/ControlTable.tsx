import type { Int32Bits } from "../lib/Numbers/int32";
import { KIND, CONTROLS, type Kind } from "../lib/mips-machine/ctrl";
import { formatControlBits, type CtrlBank, type MarkStatus } from "../hooks/useControlBank";
import "./ControlTable.css";

/** One of the forwarding unit's per-cycle signals, shown as an extra row in
 * pipeline hazards mode: Fwdop1/Fwdop2 (for the instruction in EX) and
 * FwdRD1/FwdRD2 (for a branch in ID). Unlike every other control signal they
 * aren't a fixed value per instruction kind, so a row shows its value only
 * in the column of the instruction it applies to this cycle (marked as
 * read), and "--" in every other column. */
export interface ForwardingRow {
  name: string;
  /** Mnemonic of the instruction it applies to, or null if none. */
  op: string | null;
  /** Two-bit string, e.g. "10". */
  value: string;
  /** Marks the cell as a hazard (amber) instead of read (green). */
  warn?: boolean;
  /** Tooltip for the cell. */
  title?: string;
}

export interface ForwardingRowsData {
  rows: ForwardingRow[];
  /** A one-line explanation under the rows — a hazard being detected, a
   * stall or flush in progress, a forward to the branch comparator — or
   * null. */
  note: { kind: "info" | "warning"; text: string } | null;
}

interface ControlTableProps {
  bank: CtrlBank;
  /** Pipeline hazards mode only. Omit (undefined) to hide the extra rows. */
  forwarding?: ForwardingRowsData;
  /** Instruction kinds (columns) to show, or null to show every kind. See
   * App.tsx's "Display all" toggle. */
  shownKinds?: Set<string> | null;
}

/** A visible column: its instruction kind, and its index into KIND (which
 * is also its index into each row's cells, so filtering columns never
 * misaligns a cell with its header). */
interface Column {
  kind: Kind;
  index: number;
}

// Matrix layout — one header column per instruction kind, one row per
// control signal — unlike RegisterTable/ValsTable/MemoryTable, which are
// all single-value-per-row lists. Mirrors ctrl$init()'s DOM structure
// directly: thead built from KIND, one <tr> per CONTROLS entry.
//
// Read-only
export function ControlTable({ bank, forwarding, shownKinds = null }: ControlTableProps) {
  const columns: Column[] = KIND.map((kind, index) => ({ kind, index })).filter(
    ({ kind }) => shownKinds === null || shownKinds.has(kind),
  );

  return (
    <table className="control-table">
      <thead>
        <tr>
          <th className="ctrl-corner">Control</th>
          {columns.map(({ kind }) => (
            <th key={kind} className={`ctrl-head mark-${bank.headerMarks[kind]}`}>
              {kind}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {CONTROLS.map((def) => (
          <ControlRow key={def.name} name={def.name} len={def.len} cells={bank.cells[def.name]} columns={columns} />
        ))}
        {forwarding && (
          <>
            {forwarding.rows.map((row) => (
              <ForwardingRowView key={row.name} row={row} columns={columns} />
            ))}
            {forwarding.note && (
              <tr className="ctrl-fwd-row">
                <td className={`ctrl-name ctrl-fwd-note ctrl-fwd-note-${forwarding.note.kind}`} colSpan={columns.length + 1}>
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
  columns: Column[];
}

function ControlRow({ name, len, cells, columns }: ControlRowProps) {
  const rowMark = cells.some((c) => c.mark === "success") ? "success" : "default";
  return (
    <tr>
      <td className={`ctrl-name mark-${rowMark}`}>{name}</td>
      {columns.map(({ kind, index }) => (
        <ControlCell key={kind} len={len} state={cells[index]} />
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

function ForwardingRowView({ row, columns }: { row: ForwardingRow; columns: Column[] }) {
  const { name, op, value, warn, title } = row;
  const active = op !== null && (KIND as readonly string[]).includes(op);
  const mark = warn ? "warning" : "success";
  return (
    <tr className="ctrl-fwd-row">
      <td className={`ctrl-name mark-${active ? mark : "default"}`}>{name}</td>
      {columns.map(({ kind }) => (
        <td key={kind} className={`ctrl-cell mark-${kind === op ? mark : "default"}`} title={kind === op ? title : undefined}>
          <input type="text" value={kind === op ? value : "--"} readOnly />
        </td>
      ))}
    </tr>
  );
}