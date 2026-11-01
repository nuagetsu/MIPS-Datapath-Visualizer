# Tests

768 tests across 24 files, run with [Vitest](https://vitest.dev). They cover the
number library, the ISA tables, the parser, the syntax-error diagnoser and the
assembler, the single-cycle interpreter, the pipeline engine (stalls, flushes,
forwarding, early branches), the datapath geometry, the React state and theme
hooks, the value tables and scrubber, and whole programs run end to end in every
execution mode and at different starting `$pc` addresses.

## Setup

1. Copy `tests/` and `vitest.config.ts` into the project root (next to `src/`).
2. Install the test tooling:

   ```sh
   npm i -D vitest @vitest/coverage-v8 jsdom @testing-library/react @testing-library/dom
   ```

3. Add scripts to `package.json`:

   ```json
   "scripts": {
     "gen:parser": "peggy --plugin ts-pegjs --extra-options-file src/lib/mips-parser/pegconfig.json -o src/lib/mips-parser/generated-parser.ts src/lib/mips-parser/mips.peggy",
     "test": "vitest run",
     "test:watch": "vitest",
     "test:coverage": "vitest run --coverage"
   }
   ```

   (Adjust `gen:parser` if you already have a command that produces
   `generated-parser.ts`. `tests/lib/mips-parser/parser.test.ts` and
   `tests/system/endToEnd.test.ts` import the generated parser; everything else
   builds its ASTs directly and runs without it.)

4. `npm test`

The imports assume this layout, taken from the project's own import paths:

```
src/lib/Numbers/          int32.ts bit.ts err.ts
src/lib/mips-isa/         registers.ts
src/lib/mips-parser/      index.ts ast.ts diagnose.ts mips-util.ts mips.peggy generated-parser.ts
src/lib/mips-machine/     ctrl.ts vals.ts interpreter.ts pipeline.ts forwarding.ts ...
src/hooks/                useRegisterBank.ts useMemoryBank.ts useMachineHistory.ts useTheme.ts ...
src/components/           RegisterTable.tsx MemoryTable.tsx ControlTable.tsx Scrubber.tsx ...
```

## What's where

| File | Tests | Covers |
|---|---:|---|
| `lib/Numbers/bit.test.ts` | 28 | gates, shifts, rotations, extension, `get()` indexing, argument errors |
| `lib/Numbers/int32.test.ts` | 41 | conversions in every base, two's complement, overflow wrap, signed compare, randomized check against JS `\|0` arithmetic |
| `lib/Numbers/err.test.ts` | 4 | error classes |
| `lib/mips-isa/registers.test.ts` | 11 | register table, reserved registers, parser lookups, the usable-numbers text |
| `lib/mips-machine/ctrl.test.ts` | 53 | control table shape, every instruction family's signals, cross-signal invariants, `VALS` |
| `lib/mips-machine/memoryWords.test.ts` | 15 | byte/word addressing, byte get/set, memory errors |
| `lib/mips-machine/datapath.test.ts` | 11 | field decoding incl. the 16-bit immediate fix, jump index |
| `lib/mips-machine/interpreter.test.ts` | 53 | each F/D/A/M/R stage for every op, wires lit, branch/jump targets, error states |
| `lib/mips-machine/pipeline.test.ts` | 48 | `PendingState`, `precompute`, hazard predicates, cycle-by-cycle diagrams for ideal, load-use stall, late and early branch flushes, snapshot/restore, `addressOf`/`programIndexOf` and running from a starting `$pc` |
| `lib/mips-machine/forwarding.test.ts` | 15 | ForwardA/B (00/01/10), load-use flagging, branch-comparator forwarding |
| `lib/mips-machine/staticCheck.test.ts` | 8 | `la` rejection, `.data` fit, agreement with actually loading `.data` |
| `lib/mips-machine/programRefs.test.ts` | 11 | registers/memory/ops a program refers to; layout agrees with `layoutData` |
| `lib/mips-machine/datapathWires.test.ts` | 34 | every wire maps to drawn segments, all wires reachable, bar splitting, stage pinning, control overlay |
| `lib/mips-machine/datapathBranch.test.ts` | 19 | early-branch remap (monotonic, continuous), `remapPath`, forwarding-mux wiring |
| `lib/mips-parser/diagnose.test.ts` | 87 | the plain-language syntax-error explanations: unknown/unsupported instructions with suggestions, operand counts and commas, registers, immediates and number formats, shift amounts, memory operands, branch targets, labels, `.data`/`.text` layout and declarations, `simplifyPeggyMessage` |
| `lib/mips-parser/mips-util.test.ts` | 66 | machine-code encodings, label/offset resolution, `check()` errors and hints, `layoutData`, listings, jump encoding from a starting `$pc` |
| `lib/mips-parser/parser.test.ts` | 65 | every instruction form, labels/comments/lines, segments, syntax errors with line numbers, the `diagnostics`/`more` failure report |
| `hooks/banks.test.ts` | 27 | register/memory/vals/control banks: reads, writes, marks, edits, snapshots |
| `hooks/useMachineHistory.test.ts` | 27 | timeline building, seeking, rebase, reset, long runs, pipeline mode, fix-and-resume, starting `$pc` |
| `hooks/useTheme.test.ts` | 12 | starting theme (stored choice vs. OS), toggling and remembering, following the OS live, blocked storage |
| `components/tables.test.ts` | 18 | register/memory/vals/control tables: filtering, formatting, marks, forwarding rows |
| `components/Scrubber.test.ts` | 11 | readout, segments, slider values, jump buttons |
| `system/programs.test.ts` | 78 | 10 complete programs (array sum, strlen, bubble sort, Fibonacci, ...) in all four modes: expected results, identical final state across modes, pipeline timing; and each program again loaded at `0x00400000` |
| `system/endToEnd.test.ts` | 26 | source text through App's Assemble steps to a result, where each kind of error is reported, and assembling at a starting `$pc` |

`tests/helpers/` holds the shared pieces: AST builders that mirror the
grammar's own `REG`/`I32`/`U32` helpers, a plain-object machine with
single-cycle and pipeline drivers that apply effects the way
`useMachineHistory` does, and bit/number conversions.

## Conventions

- **`it.fails(...)`** marks a known bug. It passes while the bug is there and
  starts failing once it's fixed, as a reminder to turn it into a normal `it`.
- Tests named **`DEVIATION`** or **`KNOWN LIMITATION`** pin down current
  behaviour that differs from real MIPS or might surprise a user, so changing it
  is a deliberate decision.

## Findings

Issues the tests surfaced, most important first. All are still present in the
current code (items 7 and 8 are new with this update).

1. **`lb` is assembled with `lbu`'s opcode.** `mips-util.ts` maps `lb` to
   `0x24`; MIPS `lb` is `0x20` (`0x24` is `lbu`). Execution is unaffected (the
   interpreter goes by mnemonic), but the Assembled listing and the datapath's
   opcode field show the wrong machine code. Fix: `lb: int32.hex("20")`.
   Test: `mips-util.test.ts`, `it.fails("lb $t0, 4($t1) -> 0x81280004 ...")`.

2. **Nothing may precede the `.data`/`.text` header.** A comment or blank line
   before `.data`, or a comment on a `.data` line, is a syntax error. `Prog`
   starts with `_ DataSeg?` (spaces/tabs only) and `Data` has no `Cmt`. The new
   `diagnose.ts` now explains this clearly ("`.data` must be on the very first
   line…"), so it's a documented rule rather than a confusing error, but the
   grammar still rejects it. Tests: `parser.test.ts`, three `it.fails`.

3. **`andi`/`ori`/`xori` sign-extend their immediate.** Real MIPS zero-extends
   for these three, so `ori $t0, $zero, 0x8000` gives `0xFFFF8000` here and
   `0x00008000` on MIPS. This matches the diagram's single Sign Extend unit, so
   it may be intended; but the `la` error message suggests `lui`/`ori`, which
   only works when the low half is below `0x8000`. Test:
   `interpreter.test.ts`, `DEVIATION`.

4. **`prepare()` from scratch doesn't reset `$pc` itself.** Single-cycle steps
   compute the next PC from the `$pc` register, while the instruction index
   restarts at 0. App's `setup` callback writes `$pc` = the starting `$pc`, so
   the app is fine, but any other caller that forgets runs from a stale PC.
   Setting `$pc` to `addressOf(0, textBase)` in `rebuildAll()` would remove the
   trap.

5. **Out-of-range numbers report the wrong error.** `int32.num(2 ** 31)` throws
   "Invalid type ... expected integer", because `checkInt`'s `(0 | x) === x` test
   fails before `checkRange` runs. Harmless, but the range check is effectively
   unreachable.

6. **`-2147483648` can't be typed in decimal.** `int32.dec` allows at most 10
   characters. Test: `int32.test.ts`, `KNOWN LIMITATION`.

7. **`diagnose.ts`: a register used as a memory offset gets the wrong
   explanation.** For `lw $t0, $t2($t1)`, `kindOf()` sees the leading `$` and
   classes the whole operand as a register before checking for `(`, so the
   message is "…but got just $t2($t1)" with the hint "Write 0($t2($t1))". The
   intended "The offset of lw must be a constant…" branch can't be reached.
   Fix: check for `(`/`)` before `$` in `kindOf()`. Tests: `diagnose.test.ts`,
   `it.fails` plus a current-behaviour test.

8. **The scrubber shows addresses relative to the start, not real ones.**
   `Scrubber.tsx`'s `hexAddr(pc)` returns `pc * 4`, and App doesn't pass the
   starting `$pc`, so with a starting `$pc` of `0x00400000` the readout says
   "add at 0x4" while the `$pc` register shows `0x00400004`. Fix: pass
   `textBase` to `Scrubber` and use `addressOf()`. (Not covered by a test, since
   the component has no way to receive the base yet.)

9. **Minor:** `.byte` accepts decimal only; the grammar's `I32` keeps
   `num = 32768` for hex `0x8000` while its bits are negative (`>` rather than
   `>=`), which only affects `programRefs`' guess of referenced memory.

## Not covered yet

`DatapathDiagram`, `App` (including its starting-`$pc` field parsing,
`parseStartPc`, which isn't exported), the Ace editor panels and `InfoPanel`,
and user interaction (typing into a cell and blurring, clicking base toggles, dragging
the scrubber). The logic those interactions call is tested through the hooks;
driving them through the DOM would need `@testing-library/user-event` on top
of the setup above.
