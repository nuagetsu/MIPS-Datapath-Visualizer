/**
 * Scrubber rendering (react-dom/server, no DOM needed): readout text, segment
 * layout, slider ARIA values and which jump buttons are enabled. Timelines are
 * built from real single-cycle / pipeline runs.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Scrubber } from "../../src/components/Scrubber";
import type { TimelineFrame } from "../../src/hooks/useMachineHistory";
import { I, M, R, label, text, J } from "../helpers/ast";
import { TestMachine, runPipeline, runSingleCycle, toProgram } from "../helpers/machine";

const TWO = toProgram(text(I("addi", "t0", "zero", 5), R("add", "t1", "t0", "t0")));

function singleTimeline(program = TWO): TimelineFrame[] {
  const run = runSingleCycle(program, new TestMachine());
  return [{ state: null, slots: [], bubbles: [] }, ...run.states.map((state) => ({ state, slots: [], bubbles: [] }))];
}

function pipelineTimeline(program = TWO): TimelineFrame[] {
  const run = runPipeline(program, new TestMachine());
  return [{ state: null, slots: [], bubbles: [] }, ...run.cycles.map((c) => ({ state: c.summary, slots: c.slots, bubbles: c.bubbles }))];
}

function render(timeline: TimelineFrame[], position: number, pipeline = false, complete = true) {
  return renderToStaticMarkup(createElement(Scrubber, { timeline, position, pipeline, complete, onSeek: () => {} }));
}

const readout = (html: string) => /<div class="scrubber-readout"[^>]*>([^<]*)<\/div>/.exec(html)![1];
/** Whether the button whose title contains `t` is disabled. */
const disabled = (html: string, t: string) => {
  const tag = [...html.matchAll(/<button [^>]*>/g)].map((m) => m[0]).find((b) => b.includes(t));
  if (!tag) throw new Error(`no button "${t}"`);
  return tag.includes("disabled");
};
const segments = (html: string) => [...html.matchAll(/<div class="(scrubber-seg[^"]*)"/g)].map((m) => m[1]);
/** An attribute of the slider (the track). */
const attr = (html: string, name: string) => {
  const slider = /<div [^>]*role="slider"[^>]*>/.exec(html)![0];
  return new RegExp(` ${name}="([^"]*)"`).exec(slider)![1];
};

describe("Scrubber: no program", () => {
  it("asks for a program and disables everything", () => {
    const html = render([], 0);
    expect(readout(html)).toBe("Assemble a program to scrub through its run");
    for (const t of ["start", "Previous", "Next", "end"]) expect(disabled(html, t)).toBe(true);
    expect(attr(html, "aria-disabled")).toBe("true");
    expect(attr(html, "tabindex")).toBe("-1");
    expect(attr(html, "aria-valuetext")).toBe("No program");
  });
});

describe("Scrubber: single-cycle", () => {
  const tl = singleTimeline();

  it("one segment for the start plus one per executed instruction", () => {
    expect(segments(render(tl, 0))).toHaveLength(3);
  });

  it("reads 'Start' at frame 0", () => {
    expect(readout(render(tl, 0))).toBe("Start · before the first step");
  });

  it("names the step, instruction, address and stage", () => {
    expect(readout(render(tl, 7))).toBe("Step 7 of 10 · instruction 2 of 2: add at 0x4 · Decode");
    expect(readout(render(tl, 5))).toBe("Step 5 of 10 · instruction 1 of 2: addi at 0x0 · Register Write");
  });

  it("marks an unfinished (precompute-limited) run with '+'", () => {
    expect(readout(render(tl, 7, false, false))).toBe("Step 7 of 10+ · instruction 2 of 2+: add at 0x4 · Decode");
  });

  it("slider values follow the position", () => {
    const html = render(tl, 4);
    expect([attr(html, "aria-valuemin"), attr(html, "aria-valuemax"), attr(html, "aria-valuenow")]).toEqual(["0", "10", "4"]);
    expect(attr(html, "aria-label")).toBe("Execution step");
  });

  it("enables only the jumps that go somewhere", () => {
    const start = render(tl, 0);
    expect([disabled(start, "start"), disabled(start, "Previous"), disabled(start, "Next"), disabled(start, "end")]).toEqual([true, true, false, false]);
    const end = render(tl, 10);
    expect([disabled(end, "start"), disabled(end, "Previous"), disabled(end, "Next"), disabled(end, "end")]).toEqual([false, false, true, true]);
  });

  it("flags the segment of an instruction that failed", () => {
    const failing = singleTimeline(toProgram(text(I("addi", "t0", "zero", 1), M("lw", "t1", 2, "zero"))));
    expect(segments(render(failing, 1))).toEqual(["scrubber-seg", "scrubber-seg", "scrubber-seg scrubber-seg-error"]);
  });
});

describe("Scrubber: pipeline", () => {
  const tl = pipelineTimeline();

  it("one segment per clock cycle, and a cycle readout", () => {
    const html = render(tl, 3, true);
    expect(segments(html)).toHaveLength(tl.length);
    expect(readout(html)).toBe("Cycle 3 of 6");
    expect(attr(html, "aria-label")).toBe("Clock cycle");
  });

  it("'previous/next instruction' stops at write-back cycles", () => {
    // Write-backs happen in cycles 5 and 6 of a 2-instruction program.
    expect(disabled(render(tl, 6, true), "Next")).toBe(true);
    expect(disabled(render(tl, 4, true), "Next")).toBe(false);
    expect(disabled(render(tl, 4, true), "Previous")).toBe(false); // back to 0
  });

  it("stops drawing individual segments for very long runs", () => {
    const loop = toProgram(text(label("x", J("x"))));
    const run = runPipeline(loop, new TestMachine(), false, false, 900);
    const long: TimelineFrame[] = [{ state: null, slots: [], bubbles: [] }, ...run.cycles.map((c) => ({ state: c.summary, slots: c.slots, bubbles: c.bubbles }))];
    const html = render(long, 10, true, false);
    expect(segments(html)).toHaveLength(0);
    expect(readout(html)).toBe("Cycle 10 of 900+");
  });
});
