/**
 * useAceEditor
 * ------------
 * TS/React port of the legacy `editor.js` IIFE factory.
 *
 * Install first:
 *   npm install ace-builds
 *
 * Usage (see also src/components/AceEditorPanel.tsx for a full example):
 *
 *   const containerRef = useRef<HTMLDivElement>(null);
 *   const editor = useAceEditor(containerRef, { mode: "ace/mode/mips", pcNum: true });
 *   editor?.load("add $t0, $s0, $s1\n");
 *
 * Behavior preserved 1:1 from the original:
 *   - base/value/load/save/read/log            content I/O
 *   - mark(line)   -> gutter decoration ("current line")
 *   - markColours([...]) -> several coloured gutter dots at once (pipeline
 *                     mode: one per instruction in flight, in its colour)
 *   - next(line)   -> full-line marker ("next line to execute")
 *   - err(line)    -> reuses Ace's breakpoint mechanism for error highlight;
 *                     also accepts an array, to mark every line an
 *                     Assemble found a problem on
 *   - reset()      -> clears mark/next/err (was RES() in the original)
 *   - read-only mode snaps the cursor/selection back to the marked line
 *   - gutter click toggles a breakpoint (tracked in a ref, mirroring `brkpts`)
 *   - pcNum mode replaces line numbers with word-aligned hex addresses
 *
 * Theme: `theme` is live — changing it (useTheme's aceTheme, light/dark)
 * re-themes the mounted editor without recreating it. Both theme modules
 * are imported below so either can be switched to instantly.
 *
 * Deliberately NOT ported forward:
 *   - `p_err` / `p_next` bookkeeping vars — dead in the original, no reader.
 *   - the data-URI download trick in save() — replaced with Blob + revoke,
 *     which is the modern equivalent and avoids the old approach's memory/
 *     size limitations.
 *   - the `basePath` CDN-vs-local branch — no longer needed. mode-mips is a
 *     stock ace-builds module (confirmed against ace-builds' own
 *     ace-modules.d.ts), so it's imported as a real ES module below instead
 *     of being fetched at runtime.
 */
import { useEffect, useRef, useState } from "react";
import ace from "../lib/ace-core";
import type { Ace } from "ace-builds";
import "ace-builds/src-noconflict/mode-mips";
import "ace-builds/src-noconflict/theme-chrome";
import "ace-builds/src-noconflict/theme-tomorrow_night";
import "../types/ace-augment.d.ts";
import { int32 } from "../lib/Numbers/int32";

/**
 * Gutter-display hex formatting — was Hex.ts's trimHex(), a standalone
 * reimplementation written back when int32.js hadn't been ported yet.
 * Now that lib/Numbers/int32.ts exists and is the real, tested source of
 * truth for hex conversion, this reuses it instead of hand-rolling bit
 * manipulation again — but int32.toHex() always returns a fixed 8-digit,
 * zero-padded, uppercase string ("0x00000004"), which is correct for a
 * register/memory value display but wrong for a compact word-address
 * gutter ("0x0", "0x4", "0x8", ... — variable width, used directly to
 * size the gutter column below). So this wraps toHex() and strips the
 * leading zeros back off, rather than changing int32.toHex() itself
 * (register/memory tables want the fixed-width form).
 *
 * `n | 0` (not int32.num(n) directly) because int32.num() rejects values
 * outside the SIGNED 32-bit range, but a gutter/base address should
 * accept the full unsigned range the way trimHex's `>>> 0` did — `n | 0`
 * truncates any JS number to the same 32-bit bit pattern `>>> 0` would,
 * just reinterpreted as signed, which int32.num()/toHex() then convert
 * from correctly either way (two's complement is two's complement).
 */
function compactHex(n: number): string {
  const digits = int32.toHex(int32.num(n | 0)).slice(2);
  return "0x" + digits.replace(/^0+(?=.)/, "").toLowerCase();
}

/**
 * Was Hex.ts's parseHex(). int32.hex() is stricter than the original's
 * hand-rolled `parseInt(cleaned, 16)` (validates every character and caps
 * at 8 hex digits instead of silently parsing a truncated prefix), so this
 * keeps the same "never throw, fall back to 0 on anything unparseable"
 * contract the original had, now backed by int32's real validation rather
 * than parseInt's leniency.
 */
function safeParseHex(hex: string): number {
  try {
    return int32.toNum(int32.hex(hex.trim()));
  } catch {
    return 0;
  }
}

export interface AceEditorOptions {
  /** Ace mode id, e.g. "ace/mode/mips". Default: "ace/mode/mips". */
  mode?: string;
  /** CSS font-size string, e.g. "10pt". Default: "10pt". */
  size?: string;
  /** Ace theme id, e.g. "ace/theme/chrome". Default: "ace/theme/chrome".
   * Must be one of the theme modules imported above. */
  theme?: string;
  /** Whether the editor is user-editable. Default: true. */
  write?: boolean;
  /** Whether to show the gutter/line numbers at all. Default: true. */
  number?: boolean;
  /**
   * Show word-aligned hex addresses (0x0, 0x4, 0x8, ...) in the gutter
   * instead of plain line numbers. Default: false.
   */
  pcNum?: boolean;
}

export interface AceEditorHandle {
  /** The live Ace editor instance, for anything not covered by this handle. */
  editor: Ace.Editor;
  /** Re-anchor the pcNum gutter to a new base address, given as a hex string. */
  base: (hex: string) => void;
  value: () => string;
  load: (text: string) => void;
  /** Returns a callback suitable for a button's onClick to download current content. */
  save: (filename: string) => () => void;
  /** Wire to a <input type="file"> onChange handler. */
  read: (evt: React.ChangeEvent<HTMLInputElement>) => void;
  log: (text: string, end?: string) => void;
  mark: (line: number) => void;
  /** Coloured gutter dots, replacing any previous set (pass [] to clear).
   * Several entries on the same line become side-by-side dots, in the
   * order given. Independent of mark()'s single red dot. */
  markColours: (marks: { line: number; colour: string }[]) => void;
  next: (line: number) => void;
  /** Error marker(s), replacing any previous ones: one 0-indexed line, or
   * several. A negative line (or []) clears them. The first line given is
   * scrolled into view. */
  err: (line: number | number[]) => void;
  reset: () => void;
}

const DEFAULTS: Required<AceEditorOptions> = {
  mode: "ace/mode/mips",
  size: "10pt",
  theme: "ace/theme/chrome",
  write: true,
  number: true,
  pcNum: false,
};

const DEFAULT_BREAKPOINT_CLASS = "ace_breakpoint";

// ---- markColours() dot styles ------------------------------------------
/**
 * Gutter decorations can only add a class to a gutter cell, so each
 * distinct combination of dot colours on a line gets its own class, whose
 * ::before draws those dots — same size and spacing as mark()'s red "RD"
 * dot in AceEditorPanel.css, overlapping slightly when there are several
 * so they fit the gutter. The rules are generated here, once per
 * combination, into one shared <style> element, rather than hard-coded in
 * CSS: callers pass whatever colours they use (e.g. DatapathDiagram's
 * PIPELINE_WIRE_COLOURS), so there's no second copy of a palette to keep
 * in sync. Colours may be CSS var() references (they are, for the
 * pipeline palette), which the generated rule resolves per theme.
 */
const DOT = 8;
const DOT_STEP = 5;
let colourDotStyle: HTMLStyleElement | null = null;
const colourDotRules = new Set<string>();

function colourDotClass(colours: string[]): string {
  const cls = "PDOT-" + colours.map((c) => c.replace(/[^0-9a-zA-Z]/g, "")).join("-");
  if (!colourDotRules.has(cls)) {
    colourDotRules.add(cls);
    let style = colourDotStyle;
    if (!style) {
      style = document.createElement("style");
      document.head.appendChild(style);
      colourDotStyle = style;
    }
    const r = DOT / 2;
    // CSS draws the first background on top, so list them last-to-first to
    // stack each dot over the one before it.
    const layers = colours
      .map((c, i) => `radial-gradient(circle ${r}px at ${r + i * DOT_STEP}px 50%, ${c} ${r - 0.5}px, transparent ${r}px)`)
      .reverse()
      .join(", ");
    const width = DOT + (colours.length - 1) * DOT_STEP;
    style.appendChild(
      document.createTextNode(
        `.ace_gutter-cell.${cls}::before { content: ""; display: inline-block; width: ${width}px; height: ${DOT}px; margin-right: 4px; background: ${layers}; }\n`,
      ),
    );
  }
  return cls;
}

export function useAceEditor(
  containerRef: React.RefObject<HTMLDivElement | null>,
  opt: AceEditorOptions = {}
): AceEditorHandle | null {
  // Skip options passed as undefined (e.g. `theme={undefined}`), so they
  // fall back to the default instead of overriding it with undefined.
  const defined = Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== undefined)) as AceEditorOptions;
  const options = { ...DEFAULTS, ...defined };
  const [handle, setHandle] = useState<AceEditorHandle | null>(null);

  // Mutable per-instance state, equivalent to the original's closure vars.
  const editorRef = useRef<Ace.Editor | null>(null);
  const breakpointsRef = useRef<Set<number>>(new Set());
  const markedLineRef = useRef<number>(-1);
  // markColours(): the gutter decoration class currently on each line.
  const colourDotsRef = useRef<Map<number, string>>(new Map());
  const nextMarkerIdRef = useRef<number | undefined>(undefined);
  const baseAddrRef = useRef<number>(0);

  useEffect(() => {
    if (!containerRef.current) return;

    const editor = ace.edit(containerRef.current);
    editorRef.current = editor;
    const session = editor.getSession();
    const { Range } = ace.require("ace/range");

    // ---- init() -----------------------------------------------------
    editor.setTheme(options.theme);
    session.setUseWorker(false);
    session.setUseWrapMode(true);
    editor.setOptions({ fontSize: options.size });
    session.setMode(options.mode);

    if (options.write) {
      editor.setReadOnly(false);
    } else {
      editor.setOptions({
        readOnly: true,
        highlightActiveLine: false,
        highlightGutterLine: false,
      });
      session.selection.on("changeSelection", () => {
        session.selection.clearSelection();
        editor.selection.moveCursorToPosition({
          row: markedLineRef.current,
          column: 0,
        });
      });
    }

    editor.renderer.setShowGutter(options.number);

    function applyPcGutterRenderer() {
      session.gutterRenderer = {
        getWidth: (_s: unknown, last: number, config: { characterWidth: number }) =>
          compactHex(last * 4 + baseAddrRef.current).length * config.characterWidth,
        getText: (_s: unknown, row: number) => compactHex(row * 4 + baseAddrRef.current),
      };
    }
    if (options.pcNum) {
      applyPcGutterRenderer();
    }

    // Gutter click -> toggle breakpoint (mirrors the original's `brkpts`).
    const onGutterMouseDown = (e: any) => {
      const target = e.domEvent.target as HTMLElement;
      if (target.className.indexOf("ace_gutter-cell") === -1) return;
      if (!editor.isFocused()) return;
      if (e.clientX > 25 + target.getBoundingClientRect().left) return;

      const row = e.getDocumentPosition().row;
      if (!breakpointsRef.current.has(row)) {
        session.setBreakpoint(row, DEFAULT_BREAKPOINT_CLASS);
        breakpointsRef.current.add(row);
      } else {
        session.clearBreakpoint(row);
        breakpointsRef.current.delete(row);
      }
      e.stop();
    };
    editor.on("guttermousedown", onGutterMouseDown);

    // ---- handle methods -----------------------------------------------
    const base = (hex: string) => {
      baseAddrRef.current = safeParseHex(hex);
      if (options.pcNum) applyPcGutterRenderer();
    };

    const value = () => editor.getValue();

    const load = (text: string) => {
      editor.setValue(text, 1); // 1 = move cursor to start, matches original
    };

    const save = (filename: string) => () => {
      const blob = new Blob([value()], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    };

    const read = (evt: React.ChangeEvent<HTMLInputElement>) => {
      const file = evt.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => load(String(e.target?.result ?? ""));
      reader.readAsText(file);
    };

    const log = (text: string, end = "\n") => {
      load(value() + text + end);
    };

    const mark = (line: number) => {
      if (markedLineRef.current >= 0) {
        session.removeGutterDecoration(markedLineRef.current, "RD");
      }
      if (line >= 0) {
        session.addGutterDecoration(line, "RD");
      }
      markedLineRef.current = line;
    };

    const markColours = (marks: { line: number; colour: string }[]) => {
      for (const [line, cls] of colourDotsRef.current) session.removeGutterDecoration(line, cls);
      colourDotsRef.current.clear();
      const byLine = new Map<number, string[]>();
      for (const { line, colour } of marks) {
        if (line < 0) continue;
        byLine.set(line, [...(byLine.get(line) ?? []), colour]);
      }
      for (const [line, colours] of byLine) {
        const cls = colourDotClass(colours);
        session.addGutterDecoration(line, cls);
        colourDotsRef.current.set(line, cls);
      }
    };

    const next = (line: number) => {
      if (nextMarkerIdRef.current !== undefined) {
        session.removeMarker(nextMarkerIdRef.current);
        nextMarkerIdRef.current = undefined;
      }
      if (line >= 0) {
        nextMarkerIdRef.current = session.addMarker(
          new Range(line, 0, line, 1),
          "WR",
          "fullLine"
        );
      }
    };

    const err = (line: number | number[]) => {
      session.clearBreakpoints();
      const lines = (Array.isArray(line) ? line : [line]).filter((l) => l >= 0);
      for (const l of lines) session.setBreakpoint(l, DEFAULT_BREAKPOINT_CLASS);
      if (lines.length > 0) editor.scrollToLine(lines[0], true, true, () => {});
    };

    const reset = () => {
      mark(-1);
      markColours([]);
      next(-1);
      err(-1);
    };

    setHandle({ editor, base, value, load, save, read, log, mark, markColours, next, err, reset });

    // ---- cleanup --------------------------------------------------------
    // The original never destroyed the editor (fine in a static page, but
    // leaks in React if this effect re-runs). Always clean up on unmount.
    return () => {
      editor.off("guttermousedown", onGutterMouseDown);
      editor.destroy();
      editorRef.current = null;
      setHandle(null);
    };
    // Intentionally only re-run if the container changes; option changes
    // that should reconfigure a live editor are handled in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  // Keep a live editor in sync if options change after mount, without
  // tearing the whole editor down (mirrors calling init() again for the
  // parts that are cheap to re-apply). This is what makes the light/dark
  // switch re-theme the editors in place.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setTheme(options.theme);
    editor.getSession().setMode(options.mode);
    editor.setOptions({ fontSize: options.size });
    editor.setReadOnly(!options.write);
    editor.renderer.setShowGutter(options.number);
  }, [options.theme, options.mode, options.size, options.write, options.number]);

  return handle;
}