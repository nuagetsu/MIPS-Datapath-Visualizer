import { describe, it, expect } from "vitest";
import { int32 } from "../../../src/lib/Numbers/int32";
import { ArgumentError } from "../../../src/lib/Numbers/err";
import { n, num, hex, h, u32 } from "../../helpers/bits";

const MAX = 2147483647;
const MIN = -2147483648;

describe("int32.num / toNum", () => {
  it.each([0, 1, -1, 42, -42, 12345, -12345, MAX, MIN])("round-trips %d", (x) => {
    const b = int32.num(x);
    expect(b).toHaveLength(32);
    expect(int32.toNum(b)).toBe(x);
  });

  it("uses two's complement for negatives", () => {
    expect(hex(n(-1))).toBe("0xFFFFFFFF");
    expect(hex(n(MIN))).toBe("0x80000000");
  });

  // Rejected by checkInt's (0 | x) === x test before checkRange runs, so the
  // message says "Invalid type" rather than "Invalid range".
  it.each([MAX + 1, MIN - 1, 2 ** 40])("rejects out-of-range %d", (x) => {
    expect(() => int32.num(x)).toThrow(ArgumentError);
  });

  it.each([1.5, Number.NaN])("rejects non-integer %s", (x) => {
    expect(() => int32.num(x)).toThrow(ArgumentError);
  });

  it("returns a fresh array for zero (callers may mutate it)", () => {
    const a = int32.num(0);
    a[31] = 1;
    expect(num(int32.num(0))).toBe(0);
  });
});

describe("int32.hex / toHex", () => {
  it("parses bare hex", () => {
    expect(num(int32.hex("FF"))).toBe(255);
    expect(num(int32.hex("7FFFFFFF"))).toBe(MAX);
  });

  it("is case-insensitive", () => {
    expect(num(int32.hex("ff"))).toBe(255);
    expect(num(int32.hex("aBcD"))).toBe(0xabcd);
  });

  it("accepts the 0x / 0X prefix that toHex() displays (regression)", () => {
    expect(num(int32.hex("0x2A"))).toBe(42);
    expect(num(int32.hex("0XFFFFFFFF"))).toBe(-1);
  });

  it("round-trips through toHex", () => {
    for (const x of [0, 1, -1, 0x12345678, MIN, MAX]) {
      expect(num(int32.hex(int32.toHex(n(x))))).toBe(x);
    }
  });

  it("formats with a 0x prefix and 8 upper-case digits", () => {
    expect(int32.toHex(n(42))).toBe("0x0000002A");
    expect(int32.toHex(n(-2))).toBe("0xFFFFFFFE");
  });

  it("rejects invalid characters", () => {
    expect(() => int32.hex("12G4")).toThrow(/Invalid character/);
    expect(() => int32.hex("-1")).toThrow(/Invalid character/);
  });

  it("rejects more than 8 digits", () => {
    expect(() => int32.hex("123456789")).toThrow(/Invalid length/);
  });
});

describe("int32.bin / oct / dec", () => {
  it("bin parses binary", () => {
    expect(num(int32.bin("101"))).toBe(5);
    expect(num(int32.bin("1".repeat(32)))).toBe(-1);
    expect(() => int32.bin("102")).toThrow(/Invalid character/);
    expect(() => int32.bin("1".repeat(33))).toThrow(/Invalid length/);
  });

  it("oct parses octal, including the digits 6 and 7 (regression: oct() used the decimal table)", () => {
    expect(num(int32.oct("17"))).toBe(15);
    expect(num(int32.oct("777"))).toBe(511);
    expect(num(int32.oct("0"))).toBe(0);
    expect(() => int32.oct("8")).toThrow(/Invalid character/);
  });

  it("dec parses signed decimal", () => {
    expect(num(int32.dec("42"))).toBe(42);
    expect(num(int32.dec("-42"))).toBe(-42);
    expect(num(int32.dec("+7"))).toBe(7);
    expect(num(int32.dec("2147483647"))).toBe(MAX);
  });

  it("dec rejects letters, empty input and out-of-range values", () => {
    expect(() => int32.dec("12a")).toThrow(/Invalid character/);
    expect(() => int32.dec("")).toThrow(ArgumentError);
    expect(() => int32.dec("2147483648")).toThrow(ArgumentError);
  });

  it("KNOWN LIMITATION: dec allows at most 10 characters, so -2147483648 can't be typed in decimal", () => {
    expect(() => int32.dec("-2147483648")).toThrow(/Invalid length/);
    expect(num(int32.dec("-214748364"))).toBe(-214748364);
  });
});

describe("int32 arithmetic", () => {
  it("add / sub", () => {
    expect(num(int32.add(n(20), n(22)))).toBe(42);
    expect(num(int32.sub(n(20), n(22)))).toBe(-2);
    expect(num(int32.add(n(-5), n(-7)))).toBe(-12);
  });

  it("wraps on overflow like 32-bit hardware", () => {
    expect(num(int32.add(n(MAX), n(1)))).toBe(MIN);
    expect(num(int32.sub(n(MIN), n(1)))).toBe(MAX);
    expect(num(int32.add(n(-1), n(-1)))).toBe(-2);
  });

  it("neg is two's-complement negation (and -MIN wraps to MIN)", () => {
    expect(num(int32.neg(n(5)))).toBe(-5);
    expect(num(int32.neg(n(-5)))).toBe(5);
    expect(num(int32.neg(n(0)))).toBe(0);
    expect(num(int32.neg(n(MIN)))).toBe(MIN);
  });

  it("slt is a signed comparison that returns 1 or 0", () => {
    expect(num(int32.slt(n(-1), n(1)))).toBe(1);
    expect(num(int32.slt(n(1), n(-1)))).toBe(0);
    expect(num(int32.slt(n(3), n(3)))).toBe(0);
    expect(num(int32.slt(n(MIN), n(MAX)))).toBe(1);
  });

  it("agrees with JavaScript's |0 arithmetic on random values", () => {
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed * 2 - 0x7fffffff) | 0;
    };
    for (let i = 0; i < 200; i++) {
      const a = rand();
      const b = rand();
      expect(num(int32.add(n(a), n(b)))).toBe((a + b) | 0);
      expect(num(int32.sub(n(a), n(b)))).toBe((a - b) | 0);
      expect(num(int32.and(n(a), n(b)))).toBe(a & b);
      expect(num(int32.or(n(a), n(b)))).toBe(a | b);
      expect(num(int32.xor(n(a), n(b)))).toBe(a ^ b);
      expect(num(int32.nor(n(a), n(b)))).toBe(~(a | b));
      expect(num(int32.nand(n(a), n(b)))).toBe(~(a & b));
      expect(num(int32.slt(n(a), n(b)))).toBe(a < b ? 1 : 0);
    }
  });
});

describe("int32 predicates", () => {
  it("eq / ne / is0", () => {
    expect(int32.eq(n(7), n(7))).toBe(true);
    expect(int32.ne(n(7), n(8))).toBe(true);
    expect(int32.is0(n(0))).toBe(true);
    expect(int32.is0(n(-1))).toBe(false);
  });

  it("ordering is signed", () => {
    expect(int32.lt(n(-3), n(2))).toBe(true);
    expect(int32.gt(n(2), n(-3))).toBe(true);
    expect(int32.lte(n(4), n(4))).toBe(true);
    expect(int32.gte(n(4), n(4))).toBe(true);
    expect(int32.lt(n(MAX), n(MIN))).toBe(false);
    expect(int32.gt(n(MAX), n(MIN))).toBe(true);
  });

  it("le / ge are aliases of lte / gte", () => {
    expect(int32.le).toBe(int32.lte);
    expect(int32.ge).toBe(int32.gte);
  });
});

describe("int32 shifts", () => {
  it("sll / srl", () => {
    expect(num(int32.sll(n(1), 4))).toBe(16);
    expect(num(int32.srl(n(256), 4))).toBe(16);
  });

  it("srl is logical (fills with zeros, even for negatives)", () => {
    expect(num(int32.srl(n(-1), 28))).toBe(15);
    expect(u32(int32.srl(h("80000000"), 31))).toBe(1);
  });

  it("only accepts shift amounts 0-31 (regression: the range check was never thrown)", () => {
    expect(() => int32.sll(n(1), 32)).toThrow(/Invalid range/);
    expect(() => int32.srl(n(1), -1)).toThrow(/Invalid range/);
    expect(num(int32.sll(n(1), 31))).toBe(MIN);
  });
});

describe("int32 argument checking", () => {
  it("requires exactly 32 bits", () => {
    const short = new Array(31).fill(0) as (0 | 1)[];
    expect(() => int32.add(short, n(0))).toThrow(/Mismatch length 31 in int32.add/);
    expect(() => int32.toNum(short)).toThrow(ArgumentError);
  });

  it("rejects non-bit elements", () => {
    const bad = n(0);
    (bad as number[])[5] = 3;
    expect(() => int32.toHex(bad)).toThrow(/found 3 at index 5/);
  });
});
