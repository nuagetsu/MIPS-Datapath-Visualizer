/**
 * ace-builds' public type definitions (ace.d.ts) omit a couple of things
 * that genuinely exist and work at runtime:
 *
 *  - the "guttermousedown" event on Editor.on()/off() — used for toggling
 *    breakpoints by clicking the gutter. It's documented behavior (Ace's own
 *    docs describe it), just missing from EditorEvents.
 *  - `gutterRenderer` on EditSession — used to override what's drawn in the
 *    gutter (e.g. hex addresses instead of line numbers). It exists in Ace's
 *    *internal* types (ace-internal.d.ts) but was never carried into the
 *    public ace-builds package types.
 *
 * This file uses TypeScript's declaration merging to add both back, so the
 * rest of the codebase can call them without `as any` casts.
 */
import "ace-builds";
 
declare module "ace-builds" {
  namespace Ace {
    interface GutterMouseEvent {
      domEvent: MouseEvent;
      clientX: number;
      clientY: number;
      getDocumentPosition(): { row: number; column: number };
      stop(): void;
    }
 
    interface GutterRenderer {
      getWidth(session: EditSession, lastLineNumber: number, config: { characterWidth: number }): number;
      getText(session: EditSession, row: number): string;
    }
 
    interface EditorEvents {
      guttermousedown: (e: GutterMouseEvent) => void;
    }
 
    interface EditSession {
      gutterRenderer?: GutterRenderer;
    }
  }
}