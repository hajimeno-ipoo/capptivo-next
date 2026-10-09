import { createEditedTimeline } from "./editedTimeline.ts";
import { buildSpeedParts, planWarpedFrameTimes } from "../../../engine/speedMotion.ts";
import type { TrimSegment } from "../../../engine/trimSegments.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function close(actual: number, expected: number, message: string): void {
  assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);
}

const full = createEditedTimeline([{ id: "full", start: 0, end: 20 }], 20);
close(full.duration, 20, "uncut duration");
close(full.toTimeline(8.5), 8.5, "uncut source projection");
close(full.toSource(8.5), 8.5, "uncut seek");

// Omit the beginning, two interior ranges, and the end of the recording.
const segments: TrimSegment[] = [
  { id: "a", start: 2, end: 5 },
  { id: "b", start: 8, end: 12 },
  { id: "c", start: 15, end: 18 },
];
const original = JSON.stringify(segments);
const edited = createEditedTimeline(segments, 20);
close(edited.duration, 10, "deleted time is removed from displayed duration");
close(edited.toTimeline(8), 3, "second clip immediately follows first");
close(edited.toTimeline(15), 7, "multiple removed ranges accumulate");
close(edited.toSource(0), 2, "beginning deletion seeks first kept frame");
close(edited.toSource(10), 18, "ending deletion seeks last kept end");
close(edited.toSource(3), 8, "cut defaults to next clip's start");
close(edited.toSource(3, "before"), 5, "left end handle resolves preceding source end");
close(edited.toSource(7, "after"), 15, "second cut resolves next source start");
close(edited.toSource(7, "before"), 12, "second cut resolves preceding source end");
for (const time of [-10, 0, 1, 2]) close(edited.toTimeline(time), 0, "deleted beginning collapses");
for (const time of [5, 6, 7.99, 8]) close(edited.toTimeline(time), 3, "interior gap collapses");
for (const time of [18, 19, 20, 100]) close(edited.toTimeline(time), 10, "deleted ending collapses");
close(edited.toSource(-100), 2, "pointer before track clamps to first kept start");
close(edited.toSource(100), 18, "pointer after track clamps to last kept end");

for (const segment of segments) {
  for (const fraction of [0.01, 0.25, 0.5, 0.75, 0.99]) {
    const source = segment.start + (segment.end - segment.start) * fraction;
    close(edited.toSource(edited.toTimeline(source)), source, "kept-frame source roundtrip");
  }
}
for (const time of [0, 0.5, 3, 3.001, 6.5, 7, 7.01, 10]) {
  for (const bias of ["before", "after"] as const) {
    close(edited.toTimeline(edited.toSource(time, bias)), time, "edited-time roundtrip including cuts");
  }
}
assert(JSON.stringify(segments) === original, "projection preserves all stored source times and IDs");

const normalized = createEditedTimeline([
  { id: "later", start: 12, end: 25 },
  { id: "early", start: -3, end: 4 },
  { id: "overlap", start: 3, end: 6 },
  { id: "empty", start: 7, end: 7 },
  { id: "reverse", start: 11, end: 8 },
  { id: "invalid", start: Number.NaN, end: 9 },
], 20);
close(normalized.duration, 14, "sort, clip, merge overlaps and discard invalid ranges");
close(normalized.toSource(6), 12, "normalized gap chooses following range");
close(normalized.toSource(6, "before"), 6, "normalized gap retains preceding end");

const adjacent = createEditedTimeline([
  { id: "left", start: 0, end: 4 },
  { id: "right", start: 4, end: 9 },
], 9);
close(adjacent.toSource(4, "after"), 4, "split without removal keeps cut timestamp");
close(adjacent.toSource(4, "before"), 4, "both sides of contiguous source cut coincide");

// DOM percentages and pointer positions add rounding. Both signs of that
// rounding must preserve which side of the cut a resize handle belongs to.
for (const total of [8, 10.3, 12.7]) {
  const seam = 1.1;
  const decimal = createEditedTimeline([
    { id: "left", start: 0, end: seam },
    { id: "right", start: 4, end: 4 + total - seam },
  ], 4 + total);
  const pixels = seam / decimal.duration * 100 * 1100 / 100;
  const pointerTime = pixels / 1100 * decimal.duration;
  close(decimal.toSource(pointerTime, "before"), seam, "pixel roundtrip keeps left source end");
  close(decimal.toSource(pointerTime, "after"), 4, "pixel roundtrip keeps right source start");
  close(decimal.toSource(seam + 1e-6, "before"), 4 + 1e-6, "actual movement across cut stays on next clip");
  close(decimal.toSource(seam - 1e-6, "after"), seam - 1e-6, "actual movement before cut stays on preceding clip");
}

for (const model of [createEditedTimeline([], 20), createEditedTimeline(segments, 0), createEditedTimeline(segments, Number.NaN)]) {
  close(model.duration, 0, "all removed or no source produces zero edited duration");
  close(model.toTimeline(8), 0, "empty source projection is finite");
  close(model.toSource(8), 0, "empty seek is finite and does not restore full recording");
}

// At normal speed, the existing export planner must sample the same source
// frames as seeking each output-frame centre through the new timeline.
const times = planWarpedFrameTimes(segments, 30);
assert(times.length === 300, "export has only the ten kept seconds");
times.forEach((source, index) => close(source, edited.toSource((index + 0.5) / 30), "export and timeline agree on source frame"));

// This mapping changes gap presentation only. Speed effects keep their source
// timestamps; their existing output clock continues to calculate rate changes.
const speedParts = buildSpeedParts(segments, [{ id: "speed", start: 9, end: 11, rate: 2 }]);
close(speedParts[speedParts.length - 1]!.outputEnd, 9, "speed output duration is independently preserved");
close(edited.duration, 10, "speed does not redefine existing lane width convention");

console.log("editedTimeline.selfcheck: ok");
