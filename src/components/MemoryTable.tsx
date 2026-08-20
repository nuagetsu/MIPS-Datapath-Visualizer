import { useState } from "react";
import { int32, type Int32Bits } from "../lib/Numbers/int32";
import type { MemoryBank, MemoryCellDisplay, DisplayBase } from "../hooks/useMemoryBank";
import "./MemoryTable.css";

interface MemoryTableProps {
  bank: MemoryBank;
}

export function MemoryTable({ bank }: MemoryTableProps) {
  // FIX: the original truncated every address to its last 2 hex digits
  // unconditionally, which only stays unique for memory sizes <= 256 bytes
  // (the only size ever actually configured). This sizes the label width
  // to the bank's real size instead, so larger configurations don't
  // silently collide (e.g. 0xFC and 0x1FC both rendering as "0xFC").
  const addrDigits = Math.max(2, Math.max(bank.size - 4, 0).toString(16).length);

  return (
    <table className="memory-table">
      <thead>
        <tr>
          <th>Addr</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {bank.cells.map((cell, wordIndex) => (
          <MemoryRow
            key={wordIndex}
            wordIndex={wordIndex}
            addr={bank.addrOf(wordIndex)}
            addrDigits={addrDigits}
            state={cell}
            setBase={bank.setBase}
            trySave={bank.trySave}
          />
        ))}
      </tbody>
    </table>
  );
}

function formatAddr(addr: number, digits: number): string {
  return "0x" + addr.toString(16).toUpperCase().padStart(digits, "0");
}
function formatValue(bits: Int32Bits, base: DisplayBase): string {
  return base === "hex" ? int32.toHex(bits) : String(int32.toNum(bits));
}

interface MemoryRowProps {
  wordIndex: number;
  addr: number;
  addrDigits: number;
  state: MemoryCellDisplay;
  setBase: MemoryBank["setBase"];
  trySave: MemoryBank["trySave"];
}

function MemoryRow({ wordIndex, addr, addrDigits, state, setBase, trySave }: MemoryRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const committedText = formatValue(state.bits, state.base);
  const displayText = draft ?? committedText;
  const addrLabel = formatAddr(addr, addrDigits);

  function commit() {
    if (draft !== null) {
      trySave(wordIndex, draft);
      setDraft(null);
    }
  }

  return (
    <tr className={`memory-row mark-${state.mark}`}>
      <td className="mem-addr">{addrLabel}</td>
      <td className="mem-value">
        <input
          type="text"
          value={displayText}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <div className="base-toggle" role="group" aria-label={`Display base for ${addrLabel}`}>
          <button
            type="button"
            className={state.base === "hex" ? "active" : ""}
            onClick={() => setBase(wordIndex, "hex")}
          >
            16
          </button>
          <button
            type="button"
            className={state.base === "dec" ? "active" : ""}
            onClick={() => setBase(wordIndex, "dec")}
          >
            10
          </button>
        </div>
      </td>
    </tr>
  );
}