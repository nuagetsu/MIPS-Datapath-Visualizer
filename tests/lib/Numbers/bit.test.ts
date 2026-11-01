import { describe, it, expect } from "vitest";
import * as bit from "../../../src/lib/Numbers/bit";
import { ArgumentError } from "../../../src/lib/Numbers/err";
import { bits } from "../../helpers/bits";

const L = bits("0011");
const R = bits("0101");

describe("bit: logic gates (truth tables)", () => {
  it("inv flips every bit", () => {
    expect(bit.inv(bits("0110"))).toEqual(bits("1001"));
  });
  it("and", () => expect(bit.and(L, R)).toEqual(bits("0001")));
  it("or", () => expect(bit.or(L, R)).toEqual(bits("0111")));
  it("xor", () => expect(bit.xor(L, R)).toEqual(bits("0110")));
  it("nor", () => expect(bit.nor(L, R)).toEqual(bits("1000")));
  it("nand", () => expect(bit.nand(L, R)).toEqual(bits("1110")));

  it("does not mutate its inputs", () => {
    const a = bits("1010");
    const copy = a.slice();
    bit.inv(a);
    bit.and(a, a);
    bit.sll(a, 1);
    expect(a).toEqual(copy);
  });
});

describe("bit: argument validation", () => {
  it("rejects operands of different lengths", () => {
    expect(() => bit.and(bits("01"), bits("011"))).toThrow(ArgumentError);
    expect(() => bit.and(bits("01"), bits("011"))).toThrow(/Mismatch length/);
  });

  it("rejects non-bit elements", () => {
    const bad = [0, 2, 1] as unknown as (0 | 1)[];
    expect(() => bit.inv(bad)).toThrow(/expected bit-array but found 2 at index 1/);
  });

  it("tags errors with the operation name", () => {
    let caught: unknown = null;
    try {
      bit.or(bits("1"), bits("11"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArgumentError);
    expect((caught as ArgumentError).comp).toBe("bit.or");
  });
});

describe("bit: shifts", () => {
  it("sll shifts toward the MSB, filling with zeros", () => {
    expect(bit.sll(bits("10110"), 2)).toEqual(bits("11000"));
  });
  it("srl shifts toward the LSB, filling with zeros (logical)", () => {
    expect(bit.srl(bits("10110"), 2)).toEqual(bits("00101"));
  });
  it("shifting by 0 is the identity", () => {
    expect(bit.sll(bits("1011"), 0)).toEqual(bits("1011"));
    expect(bit.srl(bits("1011"), 0)).toEqual(bits("1011"));
  });
  it("shifting by the length or more gives all zeros", () => {
    expect(bit.sll(bits("1111"), 4)).toEqual(bits("0000"));
    expect(bit.srl(bits("1111"), 9)).toEqual(bits("0000"));
  });
  it("negative shift amounts throw (regression: the check used to be built but never thrown)", () => {
    expect(() => bit.sll(bits("1"), -1)).toThrow(ArgumentError);
    expect(() => bit.srl(bits("1"), -1)).toThrow(ArgumentError);
    expect(() => bit.cll(bits("1"), -1)).toThrow(ArgumentError);
    expect(() => bit.crl(bits("1"), -1)).toThrow(ArgumentError);
  });
});

describe("bit: rotations", () => {
  it("cll rotates left", () => {
    expect(bit.cll(bits("10010"), 1)).toEqual(bits("00101"));
  });
  it("crl rotates right", () => {
    expect(bit.crl(bits("10010"), 1)).toEqual(bits("01001"));
  });
  it("rotating by a multiple of the length is the identity", () => {
    expect(bit.cll(bits("1101"), 8)).toEqual(bits("1101"));
    expect(bit.crl(bits("1101"), 4)).toEqual(bits("1101"));
  });
  it("cll and crl are inverses", () => {
    const x = bits("1100101");
    for (let a = 0; a < 10; a++) expect(bit.crl(bit.cll(x, a), a)).toEqual(x);
  });
});

describe("bit: width changes", () => {
  it("ext zero-extends to the requested length", () => {
    expect(bit.ext(bits("11"), 5)).toEqual(bits("00011"));
  });
  it("ext defaults to 32 bits", () => {
    expect(bit.ext(bits("1"))).toHaveLength(32);
  });
  it("ext keeps the low bits when truncating", () => {
    expect(bit.ext(bits("101101"), 3)).toEqual(bits("101"));
    expect(bit.ext(bits("110011"), 2)).toEqual(bits("11"));
  });
  it("sign sign-extends with copies of the MSB", () => {
    expect(bit.sign(bits("10"), 5)).toEqual(bits("11110"));
    expect(bit.sign(bits("01"), 5)).toEqual(bits("00001"));
  });
});

describe("bit: comparison", () => {
  it("eq / ne", () => {
    expect(bit.eq(bits("101"), bits("101"))).toBe(true);
    expect(bit.eq(bits("101"), bits("100"))).toBe(false);
    expect(bit.ne(bits("101"), bits("100"))).toBe(true);
  });
});

describe("bit.get (index counts from the LSB end)", () => {
  const x = bits("11110000"); // MSB ... LSB

  it("reads the lowest bits with idx 0", () => {
    expect(bit.get(x, 0, 4)).toEqual(bits("0000"));
  });
  it("reads a field `idx` bits up from the LSB", () => {
    expect(bit.get(x, 4, 4)).toEqual(bits("1111"));
    expect(bit.get(x, 2, 4)).toEqual(bits("1100"));
  });
  it("defaults to a single bit", () => {
    expect(bit.get(x, 7)).toEqual(bits("1"));
    expect(bit.get(x, 0)).toEqual(bits("0"));
  });
  it("clips at the MSB end instead of throwing", () => {
    expect(bit.get(x, 6, 4)).toEqual(bits("11"));
    expect(bit.get(x, 10, 4)).toEqual([]);
  });
});
