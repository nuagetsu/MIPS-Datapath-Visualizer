// Central import for the Ace core.
//
// Must be imported BEFORE any "ace-builds/src-noconflict/mode-*" or
// "theme-*" side-effect imports. Those files are legacy UMD-style scripts
// that reference a bare, global `ace` identifier (the old
// `<script src="ace.js">` pattern) rather than importing it — that worked
// when ace.js was loaded via a script tag, which creates `window.ace` as
// a side effect. `import ace from "ace-builds"` under Vite/ESM only gives
// you a local, module-scoped binding; it does NOT also set `window.ace`.
// So the first time a mode/theme file's own top-level `ace.define(...)`
// call runs, there's no global `ace` for it to find — this reliably
// breaks the production bundle even when it happens to work in dev.
//
// Importing this file first (as its own module) guarantees `window.ace`
// is set before any mode/theme file gets evaluated, since ES module
// imports are resolved depth-first in declaration order — this module's
// top-level code (the assignment below) fully completes before the
// interpreter moves on to the next-listed import.
import ace from "ace-builds";

declare global {
  interface Window {
    ace: typeof ace;
  }
}

window.ace = ace;

export default ace;