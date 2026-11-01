import { describe, it, expect } from "vitest";
import {
  byteOffsetOf, getByteBits, outOfRangeMem, setByteBits, unalignedMem, wordIndexOf,
} from "../../../src/lib/mips-machine/memoryWords";
import { RuntimeError } from "../../../src/lib/Numbers/err";
import { h, hex, n, num, u32 } from "../../helpers/bits";
import * as bit from "../../../src/lib/Numbers/bit";

describe("addressing", () => {
  it.each([
    [0, 0, 0],
    [3, 0, 3],
    [4, 1, 0],
    [7, 1, 3],
    [255, 63, 3],
  ])("byte address %d is word %d, byte %d", (addr, word, byte) => {
    expect(wordIndexOf(addr)).toBe(word);
    expect(byteOffsetOf(addr)).toBe(byte);
  });

  it("negative addresses map to negative word indices (so range checks reject them)", () => {
    expect(wordIndexOf(-1)).toBe(-1);
    expect(byteOffsetOf(-1)).toBe(3);
  });
});

describe("getByteBits (byte 0 = least significant)", () => {
  const word = h("11223344");

  it.each([
    [0, 0x44],
    [1, 0x33],
    [2, 0x22],
    [3, 0x11],
  ])("byte %d of 0x11223344 is %d", (i, expected) => {
    const b = getByteBits(word, i);
    expect(b).toHaveLength(8);
    expect(num(bit.ext(b, 32))).toBe(expected);
  });
});

describe("setByteBits", () => {
  it("replaces exactly one byte", () => {
    expect(hex(setByteBits(h("11223344"), 0, n(0xaa)))).toBe("0x112233AA");
    expect(hex(setByteBits(h("11223344"), 2, n(0xaa)))).toBe("0x11AA3344");
    expect(hex(setByteBits(h("11223344"), 3, n(0xaa)))).toBe("0xAA223344");
  });

  it("only stores the low 8 bits of the value", () => {
    expect(hex(setByteBits(n(0), 1, n(-1)))).toBe("0x0000FF00");
    expect(hex(setByteBits(n(0), 0, n(0x1234)))).toBe("0x00000034");
  });

  it("round-trips with getByteBits", () => {
    let w = n(0);
    [0xde, 0xad, 0xbe, 0xef].forEach((v, i) => {
      w = setByteBits(w, i, n(v));
    });
    expect(u32(w)).toBe(0xefbeadde);
    expect(num(bit.ext(getByteBits(w, 2), 32))).toBe(0xbe);
  });
});

describe("memory errors", () => {
  it("unalignedMem", () => {
    const e = unalignedMem("LW", 6);
    expect(e).toBeInstanceOf(RuntimeError);
    expect(e.message).toBe("Unaligned LW operation on address 6");
  });

  it("outOfRangeMem", () => {
    const e = outOfRangeMem("SB", 300);
    expect(e).toBeInstanceOf(RuntimeError);
    expect(e.message).toBe("Address 300 is out of range in SB");
  });
});
