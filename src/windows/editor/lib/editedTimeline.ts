import { normalizeSegments, type TrimSegment } from "../../../engine/trimSegments.ts";

export type EditedTimeline = {
  /** Duration after removed source ranges have been omitted; speed stays separate. */
  duration: number;
  /** Project a source timestamp onto the contiguous editing timeline. */
  toTimeline: (sourceTime: number) => number;
  /** At a cut, choose the next clip's start or the preceding clip's end. */
  toSource: (timelineTime: number, bias?: "after" | "before") => number;
};

/**
 * Kept clips retain their original media timestamps. Only their displayed
 * positions change, so effects, camera footage and recorded cursor samples
 * continue to resolve against the same source frames.
 */
export function createEditedTimeline(
  segments: TrimSegment[],
  sourceDuration: number,
): EditedTimeline {
  const safeDuration = Number.isFinite(sourceDuration) ? Math.max(0, sourceDuration) : 0;
  const kept = normalizeSegments(
    segments.filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end)),
    safeDuration,
    0,
  );
  let duration = 0;
  const spans = kept.map((segment) => {
    const start = duration;
    duration += segment.end - segment.start;
    return { sourceStart: segment.start, sourceEnd: segment.end, start, end: duration };
  });

  return {
    duration,
    toTimeline(sourceTime) {
      const time = Number.isNaN(sourceTime) ? 0 : sourceTime;
      for (const span of spans) {
        if (time < span.sourceStart) return span.start;
        if (time <= span.sourceEnd) return span.start + time - span.sourceStart;
      }
      return duration;
    },
    toSource(timelineTime, bias = "after") {
      if (spans.length === 0) return 0;
      const time = Math.min(duration, Math.max(0, Number.isNaN(timelineTime) ? 0 : timelineTime));
      // Percentage -> pixel -> time arithmetic can land a few floating-point
      // units either side of a cut. Keep its requested side stable there.
      const roundoff = Number.EPSILON * Math.max(1, duration) * 4;
      for (let index = 0; index < spans.length; index += 1) {
        const span = spans[index]!;
        if (Math.abs(time - span.end) <= roundoff) {
          return bias === "before" || index === spans.length - 1
            ? span.sourceEnd
            : spans[index + 1]!.sourceStart;
        }
        if (time < span.end) {
          return span.sourceStart + time - span.start;
        }
      }
      return spans[spans.length - 1]!.sourceEnd;
    },
  };
}
