// MIPS assembly grammar, for use with Peggy + ts-pegjs:
//   npx peggy --plugin ts-pegjs --extra-options-file pegconfig.json -o generated-parser.ts mips.peggy
//
// pegconfig.json (next to this file) injects the register-table import
// into the generated parser's header via ts-pegjs's `customHeader`
// option — see the Registers section below. Without it the generated
// file won't compile (REG_NUM_TO_NAME etc. would be undefined).
//
// Reconstructed from the original generated PEG.js 0.10 output (no source
// grammar was available), then extended to cover the instruction set
// mips-util.js was clearly designed for but the original grammar never
// implemented (confirmed via mips-util.js's opcode/funct tables and its
// print$inst/print$asm cases, which already handle types this grammar
// didn't produce).
//
// Added instruction types:
//   I  - immediate arithmetic, decimal immediate  (addi/andi/ori/xori/slti $d, $s, imm)
//   L  - immediate arithmetic, hex immediate       (same ops, imm written as 0x..)
//   S  - shift                                     (sll/srl $d, $t, shamt)
//   U  - load-upper-immediate                      (lui $d, imm)
//   V  - load-address pseudo-instruction            (la $d, label)
//   J  - jump                                       (j label)
// Also added: bne (join beq in BOp), lb/sb (join lw/sw in MOp).
//
// Register set: defined once, in mips-machine/registers.ts (REGISTERS),
// and shared with the simulator — see the Registers section below.
//
// NOTE: adding "lui" to this grammar is only half the work. mips-util.js's
// opcode table has no "lui" entry, translate$inst has no "U" or "V" case,
// and print$asm has no "U"/"V" case either — la (V) additionally has no
// pseudo-instruction expansion logic (real assemblers expand `la $d, lbl`
// into lui+ori). Those are mips-util.js changes, follow-up once we port
// that file — this grammar produces correctly-shaped AST nodes for them
// now, but they won't assemble to binary until that follow-up lands.

{{
  function BIT(num, len) {
    let res = [];
    if (num < 0) num = (2 ** len) + num;
    for (let i = 0; i < len; i++) res.push(0);
    for (let i = len - 1; i >= 0 && num > 0; i--) {
      res[i] = num % 2;
      num = (num - res[i]) / 2;
    }
    return res;
  }
  function SIGN32(num, len) {
    let bit = BIT(num, len);
    while (bit.length < 32) bit.unshift(bit[0]);
    return bit;
  }
  function EXT32(num, len) {
    let bit = BIT(num, len);
    while (bit.length < 32) bit.unshift(0);
    return bit;
  }
  function I32(num, len) {
    if (num > 2 ** (len - 1)) num = num - (2 ** len);
    return { kind: "num", prop: { num, bit: SIGN32(num, len) } };
  }
  function U32(num, len) {
    return { kind: "num", prop: { num, bit: EXT32(num, len) } };
  }
  function RANGE(num, low, upp) {
    return num >= low && num < upp;
  }

  // Register names/numbers come from mips-machine/registers.ts
  // (REG_NUM_TO_NAME, REG_NAME_TO_NUM, USABLE_REG_NUMS_TEXT — imported via
  // pegconfig.json's customHeader). No register list lives here any more.
  // Node names keep the leading "$" ("$t0"), as before.
  function REG(name, num) {
    return { kind: "reg", prop: { name: "$" + name, num } };
  }

  function R(op, dst, src, tgt) { return { kind: "op", prop: { type: "R", op: op.toLowerCase(), dst, src, tgt } }; }
  function M(op, dst, src, off) { return { kind: "op", prop: { type: "M", op: op.toLowerCase(), dst, src, off } }; }
  function B(op, src, tgt, lbl) { return { kind: "op", prop: { type: "B", op: op.toLowerCase(), src, tgt, lbl } }; }
  function I(op, dst, src, imm) { return { kind: "op", prop: { type: "I", op: op.toLowerCase(), dst, src, imm } }; }
  function L(op, dst, src, imm) { return { kind: "op", prop: { type: "L", op: op.toLowerCase(), dst, src, imm } }; }
  function S(op, dst, src, sht) { return { kind: "op", prop: { type: "S", op: op.toLowerCase(), dst, src, sht } }; }
  function U(op, dst, imm)      { return { kind: "op", prop: { type: "U", op: op.toLowerCase(), dst, imm } }; }
  function V(op, dst, name)     { return { kind: "op", prop: { type: "V", op: op.toLowerCase(), dst, name } }; }
  function J(op, lbl)           { return { kind: "op", prop: { type: "J", op: op.toLowerCase(), lbl } }; }

  function Text(lbl, inst, cmt, loc) { return { kind: "text", prop: { lbl, inst, cmt, loc } }; }
  function Data(type, name, vals, loc) { return { kind: "data", prop: { type, name, vals, loc } }; }
  function Prog(data, text) { return { kind: "prog", prop: { data, text } }; }
}}

// ---- Program structure ----------------------------------------------

Prog
  = _ dataSeg:DataSeg? (_ _n)? _ textSeg:TextSeg { return Prog(dataSeg, textSeg); }
  / textSeg:Texts { return Prog([], textSeg); }

DataSeg
  = _ ".data" _ _n _ datas:Datas { return datas; }

Datas
  = _ head:Data tail:(_ _n _ @Data)* { return [head, ...tail]; }
  / _ { return []; }

Data
  = _ name:Lbl _ ":" _ ".word"   _ vals:Val32 { return Data("int",  name, vals, location().start.line); }
  / _ name:Lbl _ ":" _ ".byte"   _ vals:Val8  { return Data("byte", name, vals, location().start.line); }
  / _ name:Lbl _ ":" _ ".asciiz" _ vals:Str   { return Data("str",  name, vals, location().start.line); }

Val32 "32-bit values"
  = _ head:C32 tail:(_ "," _ @C32)* { return [head, ...tail]; }

Val8 "8-bit values"
  = _ head:C8 tail:(_ "," _ @C8)* { return [head, ...tail]; }

TextSeg
  = _ ".text" _ _n _ texts:Texts { return texts; }

Texts
  = _ head:Text tail:(_ _n _ @Text)* _a { return [head, ...tail]; }

Text
  = _ lbl:(Lbl _ ":")? _ inst:Inst? _ cmt:Cmt? {
      return Text(lbl ? lbl[0] : null, inst ?? null, cmt ?? "", location().start.line);
    }

// ---- Instructions -----------------------------------------------------

Inst "instruction"
  = AInst / SInst / UInst / VInst / JInst / MInst / BInst / RInst

RInst "R-instruction"
  = _ op:ROp _t dst:Reg _ "," _ src:Reg _ "," _ tgt:Reg { return R(op, dst, src, tgt); }

ROp "arithmetic"
  = "add"i / "sub"i / "and"i / "or"i / "slt"i

// New: immediate arithmetic. Decimal immediate tags "I"; hex immediate
// tags "L" — reviving the type distinction mips-util.js's print$inst/
// print$asm already special-case (decimal vs. hex display) but the
// original grammar never actually produced.
AInst "I-instruction"
  = _ op:AOp _t dst:Reg _ "," _ src:Reg _ "," _ imm:C16_h2 { return L(op, dst, src, imm); }
  / _ op:AOp _t dst:Reg _ "," _ src:Reg _ "," _ imm:C16_2s { return I(op, dst, src, imm); }

AOp "immediate arithmetic"
  = "addi"i / "andi"i / "ori"i / "xori"i / "slti"i

// New: shifts. dst,src match print$inst's S-case field names; src holds
// the register operand (rt in the real encoding), sht is the 5-bit shamt.
SInst "shift"
  = _ op:SOp _t dst:Reg _ "," _ src:Reg _ "," _ sht:C5 { return S(op, dst, src, sht); }

SOp "shift"
  = "sll"i / "srl"i

MInst "memory"
  = _ op:MOp _t dst:Reg _ "," _ off:C16_h2 _ "(" _ src:Reg _ ")" { return M(op, dst, src, off); }
  / _ op:MOp _t dst:Reg _ "," _ off:C16_2s _ "(" _ src:Reg _ ")" { return M(op, dst, src, off); }

MOp "memory"
  = "lw"i / "sw"i / "lb"i / "sb"i

BInst "branch"
  = _ op:BOp _t src:Reg _ "," _ tgt:Reg _ "," _ lbl:Lbl { return B(op, src, tgt, lbl); }

BOp "branch"
  = "beq"i / "bne"i

// New: load-upper-immediate. Accepts hex or decimal input; always a "U" node.
UInst "load-upper-immediate"
  = _ op:UOp _t dst:Reg _ "," _ imm:(C16_h2 / C16_2s) { return U(op, dst, imm); }

UOp "load-upper-immediate"
  = "lui"i

// New: load-address pseudo-instruction. References a .data label by name,
// not a register/immediate — mirrors print$inst's V-case (dst + name).
VInst "load-address"
  = _ op:VOp _t dst:Reg _ "," _ name:Lbl { return V(op, dst, name); }

VOp "load-address"
  = "la"i

// New: unconditional jump.
JInst "jump"
  = _ op:JOp _t lbl:Lbl { return J(op, lbl); }

JOp "jump"
  = "j"i

// ---- Registers ----------------------------------------------------------

// FIX: the named-register alternative's character class was `[A-Za-z]+` —
// letters only, no digits. Since this regex applies to every character of
// the name (not just the first), it made every register with a digit in
// its name ($v0/$v1/$a0-$a3/$t0-$t9/$s0-$s7/$k0/$k1) completely
// unparseable — only the letter-only names ($zero/$at/$gp/$sp/$fp/$ra)
// ever matched. `!IdChar` (the negative lookahead right after) then
// rejected even the partial match (e.g. "v" from "v0"), since the
// following digit is itself an IdChar — so the whole alternative failed
// outright rather than silently mis-parsing. Confirmed against the
// compiled parser: `add $v0, $v0, $v0` failed to parse before this fix,
// and correctly resolved $v0 -> register 2 after it.
IdChar = [A-Za-z_0-9]

// Which registers are usable is decided in mips-machine/registers.ts, not
// here: that file's header explains why $at (1) and $k0/$k1/$gp/$sp/$fp/
// $ra (26-31) are left out. Anything absent from REGISTERS is rejected
// by name AND by number ($26 fails exactly like $k0 does). $pc has no
// number, so it's absent from both lookups and can't be named either.
Reg "regs"
  = _ "$" n:$([0-9]+) !IdChar {
      const num = parseInt(n, 10);
      const name = REG_NUM_TO_NAME.get(num);
      if (name === undefined) {
        expected(`a usable register number (${USABLE_REG_NUMS_TEXT})`);
      }
      return REG(name, num);
    }
  / _ "$" name:$([A-Za-z0-9]+) !IdChar {
      const bare = name.toLowerCase();
      const num = REG_NAME_TO_NUM.get(bare);
      if (num === undefined) { expected("valid register name"); }
      return REG(bare, num);
    }

// ---- Labels, comments, literals ------------------------------------------

Lbl "label"
  = pre:[A-Za-z_] rst:[A-Za-z_0-9]* { return pre + rst.join(""); }

Cmt "comment"
  = "#" _ txt:[^\r\n]* { return txt.join(""); }

C32
  = C32_h2 / C32_2s
C32_2s "32-bit 2s"
  = _ num:Int &{ return RANGE(num, -2147483648, 2147483648); } { return I32(num, 32); }
C32_h2 "32-bit 2s hex"
  = _ num:Hex &{ return RANGE(num, 0, 4294967296); } { return I32(num, 32); }

C16_2s "16-bit 2s"
  = _ num:Int &{ return RANGE(num, -32768, 32768); } { return I32(num, 16); }
C16_h2 "16-bit 2s hex"
  = _ num:Hex &{ return RANGE(num, 0, 65536); } { return I32(num, 16); }

C5 "5-bit unsigned"
  = _ num:Int &{ return RANGE(num, 0, 32); } { return U32(num, 5); }

C8 "8-bit unsigned"
  = _ num:Int &{ return RANGE(num, 0, 256); } { return U32(num, 8); }

Int "integer"
  = _ "-"? [0-9]+ { return parseInt(text(), 10); }

// FIX: this was `[0-9A-F]+` — uppercase only. parseInt(text(), 16) itself
// handles either case fine, but the character class gating what counts as
// a hex digit didn't, so any lowercase hex digit (routine — most people
// write "0xff", not "0xFF") caused a silent partial match: the parser
// consumed as many uppercase-digit characters as it could, then stopped,
// leaving the lowercase letters dangling for something else to trip over
// downstream. The resulting error ("expected end of input... found 'x'"
// or similar) pointed nowhere near the real cause — same "furthest
// backtrack position, not the real failure" red herring as the earlier
// register-name bug. Confirmed against the compiled parser: every
// lowercase/mixed-case hex immediate failed before this fix and succeeds
// after it, across 16-bit immediates, 32-bit .word literals, and memory
// offsets.
Hex "hexadecimal"
  = _ "0x" [0-9A-Fa-f]+ { return parseInt(text(), 16); }

Str "string"
  = _ "\"" txt:Txt "\"" { return txt; }

Txt
  = chars:Char* { return chars.join(""); }

Char
  = [^"\\\r\n\t"]
  / Esc seq:Seq { return seq; }

Esc
  = "\\"

Seq
  = "\\" { return "\\"; }
  / "\"" { return "\""; }
  / "n" { return "\n"; }
  / "r" { return "\r"; }
  / "t" { return "\t"; }

// ---- Whitespace -----------------------------------------------------------

_ "space" = [ \t]*
_t "space" = [ \t]+
_n "newline" = [\r\n]+
_a "whitespace" = [ \t\r\n]*