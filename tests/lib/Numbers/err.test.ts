import { describe, it, expect } from "vitest";
import { ArgumentError, CompileError, RuntimeError } from "../../../src/lib/Numbers/err";

describe("error classes", () => {
  it("ArgumentError carries comp/arg and is a real Error", () => {
    const e = new ArgumentError("bad", "int32.add", [1, 2]);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ArgumentError");
    expect(e.message).toBe("bad");
    expect(e.comp).toBe("int32.add");
    expect(e.arg).toEqual([1, 2]);
  });

  it("RuntimeError carries comp/arg", () => {
    const e = new RuntimeError("boom", "mem.ts", [8]);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RuntimeError");
    expect(e.comp).toBe("mem.ts");
    expect(e.arg).toEqual([8]);
  });

  it("CompileError also carries the source line", () => {
    const e = new CompileError("dup", "label", ["x"], 12);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("CompileError");
    expect(e.loc).toBe(12);
  });

  it("the three classes are distinguishable with instanceof", () => {
    const errors = [new ArgumentError("", "", []), new RuntimeError("", "", []), new CompileError("", "", [], 0)];
    expect(errors.filter((e) => e instanceof CompileError)).toHaveLength(1);
    expect(errors.filter((e) => e instanceof RuntimeError)).toHaveLength(1);
    expect(errors.filter((e) => e instanceof ArgumentError)).toHaveLength(1);
  });
});
