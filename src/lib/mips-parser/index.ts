import { parse, PeggySyntaxError as MipsSyntaxError } from "./generated-parser";
import { diagnoseSource, simplifyPeggyMessage, type Diagnostic } from "./diagnose";
import type { Program } from "./ast";

export type {
  Program, Instr, RegNode, NumNode, TextLine, DataDecl,
  RInstr, IInstr, LInstr, SInstr, MInstr, BInstr, UInstr, VInstr, JInstr,
} from "./ast";
export type { Diagnostic } from "./diagnose";

export interface ParseSuccess {
  ok: true;
  program: Program;
}

export interface ParseFailure {
  ok: false;
  /** Peggy's raw message, kept for debugging. */
  message: string;
  /** 1-indexed line of the first problem (the first diagnostic's line). */
  line: number;
  column: number;
  /** Every problem found, in line order, each with its own line number and
   * a plain-language message (see diagnose.ts). Never empty. */
  diagnostics: Diagnostic[];
  /** How many further problems were found but left out of `diagnostics`. */
  more: number;
}

export type ParseResult = ParseSuccess | ParseFailure;

/** Most diagnostics shown for one Assemble. More than this and the console
 * gets hard to read; the rest show up once the first ones are fixed. */
const MAX_DIAGNOSTICS = 8;

/**
 * Parses MIPS source text into the AST. Never throws — parse errors (the
 * generated parser's SyntaxError) are caught and returned as a typed
 * ParseFailure instead, since a syntax error while editing is expected,
 * routine input, not an exceptional program state.
 *
 * On failure, diagnoseSource() re-reads every line to say what's wrong on
 * each, in plain terms. The parser stays the authority on validity: if the
 * line it stopped on got no diagnostic of its own, its message for that
 * line is included too, so a real error is never hidden behind the others.
 */
export function parseMips(source: string): ParseResult {
  try {
    const program = parse(source) as Program;
    return { ok: true, program };
  } catch (e) {
    if (e instanceof MipsSyntaxError) {
      const peggyLine = e.location.start.line;
      const lines = source.split(/\r\n|\r|\n/);
      const diagnostics = diagnoseSource(source);
      if (!diagnostics.some((d) => d.line === peggyLine)) {
        diagnostics.push({
          line: peggyLine,
          message: `Syntax error at column ${e.location.start.column}: ${simplifyPeggyMessage(e.message)}`,
          source: lines[peggyLine - 1] ?? "",
        });
        diagnostics.sort((a, b) => a.line - b.line);
      }
      const shown = diagnostics.slice(0, MAX_DIAGNOSTICS);
      return {
        ok: false,
        message: e.message,
        line: shown[0].line,
        column: shown[0].line === peggyLine ? e.location.start.column : 1,
        diagnostics: shown,
        more: diagnostics.length - shown.length,
      };
    }
    throw e; // genuinely unexpected error — don't swallow it
  }
}