import { useEffect } from "react";
import "./InfoPanel.css";

interface InstructionRow {
  name: string;
  code: string;
}

interface InstructionGroup {
  heading: string;
  rows: InstructionRow[];
}

// Content ported 1:1 from processor.html's `.info` modal table, split into
// labeled groups.
const INSTRUCTION_GROUPS: InstructionGroup[] = [
  {
    heading: "Arithmetic (R-type)",
    rows: [
      { name: "Addition", code: "add  $rd, $rs, $rt" },
      { name: "Subtraction", code: "sub  $rd, $rs, $rt" },
      { name: "Bitwise AND", code: "and  $rd, $rs, $rt" },
      { name: "Bitwise OR", code: "or   $rd, $rs, $rt" },
      { name: "Set on Less Than", code: "slt  $rd, $rs, $rt" },
    ],
  },
  {
    heading: "Immediate Arithmetic (I/L-type)",
    rows: [
      { name: "Add Immediate", code: "addi $rt, $rs, C16₂ₛ" },
      { name: "AND Immediate", code: "andi $rt, $rs, C16" },
      { name: "OR Immediate", code: "ori  $rt, $rs, C16" },
      { name: "XOR Immediate", code: "xori $rt, $rs, C16" },
      { name: "Set Less Than Immediate", code: "slti $rt, $rs, C16₂ₛ" },
    ],
  },
  {
    heading: "Shift (S-type)",
    rows: [
      { name: "Shift Left Logical", code: "sll  $rd, $rt, C5" },
      { name: "Shift Right Logical", code: "srl  $rd, $rt, C5" },
    ],
  },
  {
    heading: "Load Upper Immediate (U-type)",
    rows: [{ name: "Load Upper Immediate", code: "lui  $rt, C16" }],
  },
  {
    heading: "Branch (B-type)",
    rows: [
      { name: "Branch on Equal", code: "beq  $rs, $rt, label" },
      { name: "Branch on Not Equal", code: "bne  $rs, $rt, label" },
    ],
  },
  {
    heading: "Jump (J-type)",
    rows: [{ name: "Jump", code: "j    label" }],
  },
  {
    heading: "Memory (M-type)",
    rows: [
      { name: "Load Word", code: "lw   $rt, offset($rs)" },
      { name: "Store Word", code: "sw   $rt, offset($rs)" },
      { name: "Load Byte", code: "lb   $rt, offset($rs)" },
      { name: "Store Byte", code: "sb   $rt, offset($rs)" },
    ],
  },
];

interface InfoPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function InfoPanel({ isOpen, onClose }: InfoPanelProps) {
  // Close on Escape, matching the original Bootstrap modal's default behavior.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="info-panel-backdrop" onClick={onClose}>
      <div
        className="info-panel-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="info-panel-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="info-panel-header">
          <h5 id="info-panel-title">MIPS Processor</h5>
          <button
            type="button"
            className="info-panel-close"
            aria-label="Close"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="info-panel-body">
          {INSTRUCTION_GROUPS.map((group) => (
            <table className="info-panel-table" key={group.heading}>
              <thead>
                <tr>
                  <th scope="col">{group.heading}</th>
                  <th scope="col">Code</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.code}>
                    <th scope="row">
                      <i>{row.name}</i>
                    </th>
                    <td>
                      <samp>{row.code}</samp>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}

          <p className="info-panel-legend">
            <samp>
              C16<sub>2s</sub>
            </samp>{" "}
            is a 16-bit number (or hex pattern) interpreted as a 2s-complement number. It will
            be sign-extended.
            <br />
            <samp>C16</samp> is a 16-bit number (or hex pattern) interpreted as an unsigned
            number. It will be zero-extended.
            <br />
            <samp>C5</samp> is a 5-bit number interpreted as an unsigned number. It will be
            zero-extended.
          </p>
        </div>

        <div className="info-panel-footer">
          <button type="button" className="info-panel-close-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}