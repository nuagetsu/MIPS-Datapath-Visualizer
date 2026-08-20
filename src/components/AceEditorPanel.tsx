import React, { useRef } from "react";
import { useAceEditor } from "../hooks/useAceEditor";
import "./AceEditorPanel.css";
 
interface AceEditorPanelProps {
  /** Called with the handle once the editor mounts, so a parent (e.g. the
   * simulator's run/step controller) can call mark()/next()/err() during
   * execution. */
  onReady?: (handle: ReturnType<typeof useAceEditor>) => void;
}
 
export function AceEditorPanel({ onReady }: AceEditorPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
 
  const editor = useAceEditor(containerRef, {
    mode: "ace/mode/mips",
    pcNum: true,
    write: true,
  });
 
  React.useEffect(() => {
    if (editor) onReady?.(editor);
  }, [editor, onReady]);
 
  return (
    <div className="ace-editor-panel">
      {/* This div is what Ace mounts into; it replaces the original's
      `div` argument passed straight into ace.edit(div). */}
      <div ref={containerRef} className="ace-editor-container" />
      <div className="ace-editor-toolbar">
        <button onClick={() => fileInputRef.current?.click()}>Upload MIPS file</button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".asm,.s,.txt"
          style={{ display: "none" }}
          onChange={(evt) => editor?.read(evt)}
        />
        <button onClick={() => editor && editor.save("program.asm")()}>Download</button>
      </div>
 

    </div>
  );
}