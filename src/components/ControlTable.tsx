import type { Int32Bits } from "../lib/Numbers/int32";
import { KIND, CONTROLS } from "../lib/mips-machine/ctrl";
import { formatControlBits, type CtrlBank, type MarkStatus } from "../hooks/useControlBank";
import "./ControlTable.css";

interface ControlTableProps {
  bank: CtrlBank;
}

// Matrix layout — one header column per instruction kind, one row per
// control signal — unlike RegisterTable/ValsTable/MemoryTable, which are
// all single-value-per-row lists. Mirrors ctrl$init()'s DOM structure
// directly: thead built from KIND, one <tr> per CONTROLS entry.
//
// Read-only
export function ControlTable({ bank }: ControlTableProps) {
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