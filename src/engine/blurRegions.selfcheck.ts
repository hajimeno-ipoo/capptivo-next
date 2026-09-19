import {
  BLUR_REGION_MIN_SIZE,
  blurRegionPlacement,
  blurRegionIsActive,
  clampBlurRegion,
  hexColorWithAlpha,
} from "./blurRegions.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

const full = { ox: 0, oy: 0, rw: 1920, rh: 1080 };
const rect = { x: 100, y: 50, width: 960, height: 540 };

const half = blurRegionPlacement(
  { id: "a", x: 0.5, y: 0.5, width: 0.25, height: 0.25 },
  1920,
  1080,
  full,
  rect,
);
assert(half !== null, "placement inside the frame");
assert(
  close(half!.source.x, 960) && close(half!.source.width, 480),
  "normalized region maps to source pixels",
);
assert(
  close(half!.dest.x, 100 + 480) && close(half!.dest.width, 240),
  "source pixels map to the on-stage rect at half scale",
);

const cropped = { ox: 960, oy: 0, rw: 960, rh: 1080 };
const rightHalfOnly = blurRegionPlacement(
  { id: "b", x: 0, y: 0, width: 0.25, height: 0.25 },
  1920,
  1080,
  cropped,
  rect,
);
assert(
  rightHalfOnly === null,
  "a region cropped entirely out of view yields no placement",
);

const straddling = blurRegionPlacement(
  { id: "c", x: 0.4, y: 0, width: 0.4, height: 0.5 },
  1920,
  1080,
  cropped,
  rect,
);
assert(straddling !== null, "a region straddling the crop edge survives");
assert(
  close(straddling!.source.x, 960) && close(straddling!.dest.x, rect.x),
  "the visible part is clipped to the crop window and anchored to the rect",
);

const clamped = clampBlurRegion({
  id: "d",
  x: 0.95,
  y: -1,
  width: 0.5,
  height: 0,
});
assert(
  clamped.x + clamped.width <= 1 && clamped.y >= 0,
  "regions are clamped inside the frame",
);
assert(
  clamped.height === BLUR_REGION_MIN_SIZE,
  "a collapsed region is grown to the minimum size",
);
const timed = clampBlurRegion({ id: "timed", start: 1, end: 2, kind: "highlight" }, 4);
assert(timed.kind === "highlight", "highlight kind is persisted");
assert(timed.highlightColor === "#ffd166" && timed.highlightOpacity === 0.16, "highlight style defaults are applied");
const styled = clampBlurRegion(
  { ...timed, highlightColor: "#abc", highlightOpacity: 2 },
  4,
);
assert(styled.highlightColor === "#aabbcc" && styled.highlightOpacity === 1, "highlight style values are clamped");
assert(hexColorWithAlpha("#ffd166", 0.16) === "rgba(255, 209, 102, 0.16)", "highlight CSS parses every hex channel");
assert(!blurRegionIsActive(timed, 0.9) && blurRegionIsActive(timed, 1.5), "temporal region activation works");
const movedHighlight = clampBlurRegion(
  { ...timed, x: 0.2, y: 0.3, width: 0.3, height: 0.2 },
  4,
);
assert(
  movedHighlight.kind === "highlight" && movedHighlight.start === 1 && movedHighlight.end === 2,
  "geometry edits preserve the effect kind and timeline interval",
);
assert(clampBlurRegion({ id: "short", start: 0, end: 1 }, 0.02).end === 0.02, "short regions stay within duration");

assert(
  blurRegionPlacement(
    { id: "e", x: 0, y: 0, width: 1, height: 1 },
    0,
    1080,
    full,
    rect,
  ) === null,
  "a zero-sized source yields no placement",
);

console.log("blurRegions.selfcheck: ok");
