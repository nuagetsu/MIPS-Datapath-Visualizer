import { parse, PeggySyntaxError as MipsSyntaxError } from "./generated-parser";
import type { Program } from "./ast";
 
export type {
  Program, Instr, RegNode, NumNode, TextLine, DataDecl,
  RInstr, IInstr, LInstr, SInstr, MInstr, BInstr, UInstr, VInstr, JInstr,
} from "./ast";
 
export interface ParseSuccess {
  ok: true;
  program: Program;
}
 
export interface ParseFailure {
  ok: false;
  message: string;
  line: number;
  column: number;
}
 
export type ParseResult = ParseSuccess | ParseFailure;
 
/**
 * Parses MIPS source text into the AST. Never throws — parse errors (the
 * generated parser's SyntaxError) are caught and returned as a typed
 * ParseFailure instead, since a syntax error while editing is expected,
 * routine input, not an exceptional program state.
 */
export function parseMips(source: string): ParseResult {
  try {
    const program = parse(source) as Program;
    return { ok: true, program };
  } catch (e) {
    if (e instanceof MipsSyntaxError) {
      return {
        ok: false,
        message: e.message,
        line: e.location.start.line,
        column: e.location.start.column,
      };
    }
    throw e; // genuinely unexpected error — don't swallow it
  }
}
