/**
 * Faithful port of err.js, now that the real source is available. Field
 * names (comp, arg, loc) match the original exactly. Implemented as real
 * ES6 classes extending Error (cleaner than the original's manual
 * prototype-subclassing helper) — same external shape, same behavior.
 *
 * Fields are declared and assigned explicitly rather than via constructor
 * parameter properties (`constructor(public readonly x: T)`), since that
 * shorthand emits real runtime code and is rejected under the
 * erasableSyntaxOnly compiler option.
 */
export class ArgumentError extends Error {
  readonly comp: string;
  readonly arg: unknown[];
 
  constructor(message: string, comp: string, arg: unknown[]) {
    super(message);
    this.name = "ArgumentError";
    this.comp = comp;
    this.arg = arg;
  }
}
 
export class RuntimeError extends Error {
  readonly comp: string;
  readonly arg: unknown[];
 
  constructor(message: string, comp: string, arg: unknown[]) {
    super(message);
    this.name = "RuntimeError";
    this.comp = comp;
    this.arg = arg;
  }
}
 
export class CompileError extends Error {
  readonly comp: string;
  readonly arg: unknown[];
  readonly loc: number;
 
  constructor(message: string, comp: string, arg: unknown[], loc: number) {
    super(message);
    this.name = "CompileError";
    this.comp = comp;
    this.arg = arg;
    this.loc = loc;
  }
}