import { useState } from "react";
import { int32, type Int32Bits } from "../lib/Numbers/int32";
import { REGISTERS, type RegisterDef } from "../lib/mips-machine/registers";
import type { RegisterBank, RegisterDisplay, DisplayBase } from "../hooks/useRegisterBank";
import "./RegisterTable.css";
 
interface RegisterTableProps {
  bank: RegisterBank;
}
 
export function RegisterTable({ bank }: RegisterTableProps) {
  return (
    <table className="register-table">
      <thead>
        <tr>
          <th>Reg</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {REGISTERS.map((def) => (
          <RegisterRow
            key={def.name}
            def={def}
            state={bank.registers[def.name]}
            setBase={bank.setBase}
            trySave={bank.trySave}
          />
        ))}
      </tbody>
    </table>
  );
}
 
function formatValue(bits: Int32Bits, base: DisplayBase): string {
  return base === "hex" ? int32.toHex(bits) : String(int32.toNum(bits));
}
 
interface RegisterRowProps {
  def: RegisterDef;
  state: RegisterDisplay;
  setBase: RegisterBank["setBase"];
  trySave: RegisterBank["trySave"];
}
 
function RegisterRow({ def, state, setBase, trySave }: RegisterRowProps) {
  // null = not currently editing; show the committed value. Non-null =
  // user is typing; show their draft text instead. Matches reg.js's input
  // staying uncommitted until the "change" (blur) event fires.
  const [draft, setDraft] = useState<string | null>(null);
 
  const committedText = formatValue(state.bits, state.base);
  const displayText = draft ?? committedText;
 
  function commit() {
    if (draft !== null) {
      trySave(def.name, draft); // on failure, marks "danger" and leaves bits unchanged
      setDraft(null); // either way, fall back to displaying the committed value
    }
  }
 
  const sup = def.num === null ? "pc" : String(def.num).padStart(2, "0");
 
  return (
    <tr className={`register-row mark-${state.mark}`}>
      <td className="reg-name">
        <sup>{sup}:</sup>${def.name}
      </td>
      <td className="reg-value">
        <input
          type="text"
          value={displayText}
          readOnly={!def.editable}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <div className="base-toggle" role="group" aria-label={`Display base for $${def.name}`}>
          <button
            type="button"
            className={state.base === "hex" ? "active" : ""}
            onClick={() => setBase(def.name, "hex")}
          >
            16
          </button>
          <button
            type="button"
            className={state.base === "dec" ? "active" : ""}
            onClick={() => setBase(def.name, "dec")}
          >
            10
          </button>
        </div>
      </td>
    </tr>
  );
}
