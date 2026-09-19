import {
  buildSpeedParts,
  createSpeedRange,
  detectTypingSpeedRanges,
  outputDurationForSegments,
  planWarpedFrameTimes,
  type SpeedRange,
} from "./speedMotion.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const segments = [{ id: "s", start: 0, end: 4 }];
const ranges: SpeedRange[] = [{ id: "r", start: 1, end: 3, rate: 2 }];
const parts = buildSpeedParts(segments, ranges, 1);
assert(parts.length === 3, "speed boundary creates three source parts");
assert(Math.abs(outputDurationForSegments(segments, ranges) - 3) < 1e-6, "speed shortens output clock");
const times = planWarpedFrameTimes(segments, 10, ranges);
assert(times.length === 30, "frame count follows warped duration");
assert(times[9]! < 1 && times[10]! > 1, "source sampling crosses the speed boundary");
assert(createSpeedRange(0.02).end === 0.02, "short speed ranges stay within duration");

const shortRanges: SpeedRange[] = Array.from({ length: 80 }, (_, index) => ({
  id: `short-${index}`,
  start: index * 0.05,
  end: (index + 1) * 0.05,
  rate: 4,
}));
const shortTimes = planWarpedFrameTimes(segments, 30, shortRanges);
assert(shortTimes.length === 30, "short ranges share the total output frame budget");
assert(shortTimes[0]! > 0 && shortTimes[shortTimes.length - 1]! > 3.9, "output frames cover the entire source");
const trimmedTimes = planWarpedFrameTimes(
  [{ id: "first", start: 0, end: 0.05 }, { id: "last", start: 3, end: 3.06 }],
  30,
  [],
  2,
);
assert(trimmedTimes.length === 2 && trimmedTimes[1]! >= 3, "frame slots cross trimmed segment boundaries");

const detected = detectTypingSpeedRanges(
  {
    schemaVersion: 2,
    sourceWidth: 100,
    sourceHeight: 100,
    cursorSamples: [
      { t: 0, x: 0, y: 0, shape: "default" },
      { t: 1, x: 0, y: 0, shape: "text" },
      { t: 2, x: 0, y: 0, shape: "text" },
      { t: 2.2, x: 0, y: 0, shape: "default" },
    ],
  },
  3,
);
assert(detected.length === 1 && detected[0]!.rate === 2, "text cursor run becomes typing speed range");

console.log("speedMotion.selfcheck: ok");
