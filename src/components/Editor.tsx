import { useEffect, useRef } from "react";
import * as ace from "ace-builds";

import "ace-builds/src-noconflict/mode-javascript";
import "ace-builds/src-noconflict/theme-monokai";

export default function Editor() {
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editorRef.current) return;

    const editor = ace.edit(editorRef.current);

    editor.setTheme("ace/theme/monokai");
    editor.session.setMode("ace/mode/javascript");

    editor.setValue(`function hello() {
  console.log("Hello!");
}`, -1);

    return () => {
      editor.destroy();
    };
  }, []);

  return (
    <div
      ref={editorRef}
      style={{
        width: "100%",
        height: "400px",
      }}
    />
  );
}