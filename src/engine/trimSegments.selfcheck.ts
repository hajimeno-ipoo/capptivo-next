/** Selfcheck: trim-gap helpers. */

import {
  addTrimGap,
  computeTrimGaps,
  createFullSegment,
  moveSegmentEdge,
  resizeTrimGapAtIndex,
  splitSegmentAtTime,
  totalKeptDuration,
} from "./trimSegments.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const duration = 10;
let segs = createFullSegment(duration);
assert(segs.length === 1 && totalKeptDuration(segs) === 10, "full segment");

segs = addTrimGap(segs, 2, 4, duration);
const gaps = computeTrimGaps(segs, duration);
assert(gaps.length === 1 && Math.abs(gaps[0]!.start - 2) < 1e-6, "one gap at 2–4");
assert(Math.abs(totalKeptDuration(segs) - 8) < 1e-6, "kept = 8s");

segs = resizeTrimGapAtIndex(segs, 0, "end", 5, duration);
assert(Math.abs(totalKeptDuration(segs) - 7) < 1e-6, "resized gap → kept 7s");

const split = splitSegmentAtTime(createFullSegment(duration), 5, 0.2);
assert(
  split.length === 2 && split[0]!.end === 5 && split[1]!.start === 5,
  "cut splits the kept clip at the playhead",
);
const edgeTrimmed = moveSegmentEdge(split, split[0]!.id, "start", 1, duration, 0.2);
assert(edgeTrimmed[0]!.start === 1, "clip edge drag trims the selected clip");

console.log("trimSegments.selfcheck: ok");
