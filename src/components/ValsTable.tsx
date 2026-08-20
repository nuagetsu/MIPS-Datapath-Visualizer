import { int32, type Int32Bits } from "../lib/Numbers/int32";
import { VALS, type ValDef } from "../lib/mips-machine/vals";
import type { ValsBank, ValDisplay, DisplayBase } from "../hooks/useValsBank";
import "./ValsTable.css";

interface ValsTableProps {
  bank: ValsBank;
}

export function ValsTable({ bank }: ValsTableProps) {
  return (
    <table className="vals-table">
      <thead>
        <tr>
          <th>Reg</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {VALS.map((def) => (
          <ValRow key={def.key} def={def} state={bank.vals[def.key]} setBase={bank.setBase} />
        ))}
      </tbody>
    </table>
  );
}

function formatValue(bits: Int32Bits, base: DisplayBase): string {
  return base === "hex" ? int32.toHex(bits) : String(int32.toNum(bits));
}

interface ValRowProps {
  def: ValDef;
  state: ValDisplay;
  setBase: ValsBank["setBase"];
}

// readonly
function ValRow({ def, state, setBase }: ValRowProps) {
  return (
    <tr className={`vals-row mark-${state.mark}`}>
      <td className="val-name">
        <sup>{def.comp}:</sup>
        {def.name}
      </td>
      <td className="val-value">
        <input type="text" value={formatValue(state.bits, state.base)} readOnly />
        <div className="base-toggle" role="group" aria-label={`Display base for ${def.key}`}>
          <button
            type="button"
            className={state.base === "hex" ? "active" : ""}
            onClick={() => setBase(def.key, "hex")}
          >
            16
          </button>
          <button
            type="button"
            className={state.base === "dec" ? "active" : ""}
            onClick={() => setBase(def.key, "dec")}
          >
            10
          </button>
        </div>
      </td>
    </tr>
  );
}