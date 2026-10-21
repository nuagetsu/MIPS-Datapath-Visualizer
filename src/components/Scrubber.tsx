/**
 * Timeline scrubber: a bar with one discrete position per step of the run
 * (frame 0 = before the first step), which you can click, drag across, or
 * move along with the keyboard, plus buttons to jump to the start/end and
 * to the previous/next instruction.
 *
 * Laid out as one short row (buttons · readout · bar · buttons) so it takes
 * as little height as possible away from the datapath diagram.
 *
 * Single-cycle mode: the bar is split into one segment per executed
 * instruction, each holding its F/D/A/M/R steps (the thin tick lines), in
 * the same colour its instruction gets in pipeline mode. Pipeline mode: one
 * segment per clock cycle, coloured by the instruction fetched that cycle.
 *
 * Segment tints mix the instruction's colour with the track background
 * (--scrub-mix: white in light mode, near-black in dark), so they read as
 * pale tints in one theme and deep tints in the other.
 *
 * Purely presentational: the timeline itself (and what seeking does to the
 * machine) lives in useMachineHistory.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { TimelineFrame } from "../hooks/useMachineHistory";
import type { CycleStage } from "../lib/mips-machine/machineState";
import { PIPELINE_WIRE_COLOURS } from "./DatapathDiagram";
import "./Scrubber.css";

const STAGE_ORDER: CycleStage[] = ["F", "D", "A", "M", "R"];
const STAGE_NAMES: Record<CycleStage, string> = {
  F: "Fetch",
  D: "Decode",
  A: "ALU",
  M: "Memory",
  R: "Register Write",
};

/** Past this many segments the bar is drawn as one plain track: thousands
 * of DOM nodes would make dragging sluggish, and they'd be sub-pixel wide
 * anyway. The positions themselves stay discrete either way. */
const MAX_SEGMENTS = 800;

interface Segment {
  /** First frame in the segment. */
  start: number;
  /** Number of frames in it. */
  length: number;
  label: string;
  title: string;
  colour: string | null;
  error: boolean;
}

function hexAddr(pc: number): string {
  return "0x" + (pc * 4).toString(16);
}

function colourOf(seq: number): string {
  return PIPELINE_WIRE_COLOURS[seq % PIPELINE_WIRE_COLOURS.length];
}

function buildSegments(timeline: TimelineFrame[], pipeline: boolean): Segment[] {
  if (timeline.length === 0) return [];
  const segments: Segment[] = [
    { start: 0, length: 1, label: "", title: "Start: before the first step", colour: null, error: false },
  ];
  let instr = -1;
  for (let i = 1; i < timeline.length; i++) {
    const frame = timeline[i];
    const state = frame.state;
    if (!state) continue;
    if (pipeline) {
      const fetched = frame.slots.find((s) => s.stage === "F");
      const stages = STAGE_ORDER.map((stage) => {
        const slot = frame.slots.find((s) => s.stage === stage);
        return `${stage}: ${slot ? slot.op : frame.bubbles.includes(stage) ? "bubble" : "-"}`;
      }).join("  ");
      segments.push({
        start: i,
        length: 1,
        label: String(i),
        title: `Cycle ${i}\n${stages}${state.error ? "\nError: " + state.error : ""}`,
        colour: fetched ? colourOf(fetched.seq) : null,
        error: !!state.error,
      });
    } else {
      // A new instruction starts at each Fetch.
      if (state.stage === "F" || instr < 0) {
        instr += 1;
        segments.push({
          start: i,
          length: 0,
          label: state.op,
          title: `Instruction ${instr + 1}: ${state.op} at ${hexAddr(state.pc)}`,
          colour: colourOf(instr),
          error: false,
        });
      }
      const seg = segments[segments.length - 1];
      seg.length += 1;
      if (state.error) {
        seg.error = true;
        seg.title += `\nError: ${state.error}`;
      }
    }
  }
  return segments;
}

/** Frames to stop at for "previous/next instruction": the start of each
 * instruction (single-cycle), or each cycle an instruction finishes
 * write-back (pipeline). Always includes 0. */
function instructionStops(timeline: TimelineFrame[], segments: Segment[], pipeline: boolean): number[] {
  if (!pipeline) return segments.map((s) => s.start);
  const stops = [0];
  timeline.forEach((f, i) => {
    if (i > 0 && f.slots.some((s) => s.stage === "R")) stops.push(i);
  });
  return stops;
}

export interface ScrubberProps {
  timeline: TimelineFrame[];
  position: number;
  pipeline: boolean;
  /** The timeline reaches the end of the program (vs. stopping at the
   * precompute limit). */
  complete: boolean;
  onSeek: (position: number) => void;
}

export function Scrubber({ timeline, position, pipeline, complete, onSeek }: ScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setTrackWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const segments = useMemo(() => buildSegments(timeline, pipeline), [timeline, pipeline]);
  const stops = useMemo(() => instructionStops(timeline, segments, pipeline), [timeline, segments, pipeline]);

  const count = timeline.length; // number of positions
  const last = Math.max(0, count - 1);
  const empty = count <= 1;
  const pxPerFrame = count > 0 ? trackWidth / count : 0;
  const drawSegments = segments.length <= MAX_SEGMENTS;

  const prevStop = [...stops].reverse().find((s) => s < position);
  const nextStop = stops.find((s) => s > position);

  // ---- Pointer: click or drag to seek ---------------------------------------
  function frameAt(clientX: number): number {
    const el = trackRef.current;
    if (!el || count === 0) return 0;
    const rect = el.getBoundingClientRect();
    const f = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(last, Math.floor(f * count)));
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (empty) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    onSeek(frameAt(e.clientX));
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const f = frameAt(e.clientX);
    if (f !== position) onSeek(f);
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // ---- Keyboard: arrows step, Page Up/Down by instruction, Home/End --------
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let target: number | undefined;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        target = position - 1;
        break;
      case "ArrowRight":
      case "ArrowUp":
        target = position + 1;
        break;
      case "PageDown":
        target = prevStop;
        break;
      case "PageUp":
        target = nextStop;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (target !== undefined) onSeek(Math.max(0, Math.min(last, target)));
  }

  // ---- Readout ------------------------------------------------------------------
  const current = timeline[position]?.state ?? null;
  const total = `${last}${complete ? "" : "+"}`;
  let readout: string;
  if (empty) {
    readout = "Assemble a program to scrub through its run";
  } else if (!current) {
    readout = `Start · before the first ${pipeline ? "cycle" : "step"}`;
  } else if (pipeline) {
    readout = `Cycle ${position} of ${total}`;
  } else {
    const instrIdx = segments.findIndex((s) => position >= s.start && position < s.start + s.length);
    const instrCount = segments.length - 1;
    readout =
      `Step ${position} of ${total} · instruction ${instrIdx} of ${instrCount}${complete ? "" : "+"}: ` +
      `${current.op} at ${hexAddr(current.pc)} · ${STAGE_NAMES[current.stage]}`;
  }
  const valueText = empty ? "No program" : readout;

  return (
    <div className="scrubber">
      <div className="scrubber-buttons" role="group" aria-label="Jump">
        <button type="button" onClick={() => onSeek(0)} disabled={empty || position === 0} title="Back to the start (Home)">
          ⏮
        </button>
        <button
          type="button"
          onClick={() => prevStop !== undefined && onSeek(prevStop)}
          disabled={prevStop === undefined}
          title={pipeline ? "Previous instruction write-back (Page Down)" : "Previous instruction (Page Down)"}
        >
          ⇤
        </button>
      </div>

      <div className="scrubber-body">
        <div
          className="scrubber-readout"
          title={!empty && !complete ? `${readout} (long run: stepping past the end computes more)` : readout}
        >
          {readout}
        </div>
        <div
          ref={trackRef}
          className={empty ? "scrubber-track scrubber-track-empty" : "scrubber-track"}
          role="slider"
          tabIndex={empty ? -1 : 0}
          aria-label={pipeline ? "Clock cycle" : "Execution step"}
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={position}
          aria-valuetext={valueText}
          aria-disabled={empty}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          {drawSegments &&
            segments.map((seg) => {
              const width = seg.length * pxPerFrame;
              const showLabel = seg.label !== "" && width >= seg.label.length * 6 + 6;
              const showTicks = !pipeline && seg.length > 1 && width / seg.length >= 4;
              return (
                <div
                  key={seg.start}
                  className={seg.error ? "scrubber-seg scrubber-seg-error" : "scrubber-seg"}
                  title={seg.title}
                  style={{
                    flexGrow: seg.length,
                    backgroundColor: seg.colour ? `color-mix(in srgb, ${seg.colour} 28%, var(--scrub-mix))` : undefined,
                    backgroundImage: showTicks
                      ? "linear-gradient(to right, var(--scrub-tick) 1px, transparent 1px)"
                      : undefined,
                    backgroundSize: showTicks ? `${100 / seg.length}% 100%` : undefined,
                  }}
                >
                  {showLabel && <span className="scrubber-seg-label">{seg.label}</span>}
                </div>
              );
            })}
          {!empty && (
            <>
              <div className="scrubber-unplayed" style={{ left: `${((position + 1) / count) * 100}%` }} />
              <div
                className="scrubber-cursor"
                style={{ left: `${(position / count) * 100}%`, width: `${100 / count}%` }}
              />
            </>
          )}
        </div>
      </div>

      <div className="scrubber-buttons" role="group" aria-label="Jump">
        <button
          type="button"
          onClick={() => nextStop !== undefined && onSeek(nextStop)}
          disabled={nextStop === undefined}
          title={pipeline ? "Next instruction write-back (Page Up)" : "Next instruction (Page Up)"}
        >
          ⇥
        </button>
        <button type="button" onClick={() => onSeek(last)} disabled={empty || position === last} title="To the end (End)">
          ⏭
        </button>
      </div>
    </div>
  );
}