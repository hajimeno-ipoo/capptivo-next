/** Timeline speed ranges and the source/output clock used by preview/export. */

import type { RecordingMetadata } from "./zoomMotion";
import type { TrimSegment } from "./trimSegments";

export const MIN_PLAYBACK_SPEED = 0.25;
export const MAX_PLAYBACK_SPEED = 4;
export const DEFAULT_PLAYBACK_SPEED = 1;
export const TYPING_PLAYBACK_SPEED = 2;
export const MIN_SPEED_RANGE_DURATION = 0.05;

export type SpeedRange = {
  id: string;
  start: number;
  end: number;
  rate: number;
  /** True when created by the text-cursor typing helper. */
  autoTyping?: boolean;
};

export type SpeedPart = {
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  rate: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createSpeedRangeId(): string {
  return `speed-${Math.random().toString(36).slice(2, 10)}`;
}

export function clampPlaybackSpeed(value: number): number {
  return clamp(
    Number.isFinite(value) ? value : DEFAULT_PLAYBACK_SPEED,
    MIN_PLAYBACK_SPEED,
    MAX_PLAYBACK_SPEED,
  );
}

export function clampSpeedRange(
  range: Partial<SpeedRange> & Pick<SpeedRange, "id">,
  duration = Number.POSITIVE_INFINITY,
): SpeedRange {
  const safeDuration =
    Number.isFinite(duration) && duration > 0
      ? duration
      : Number.POSITIVE_INFINITY;
  const start = clamp(
    typeof range.start === "number" && Number.isFinite(range.start)
      ? range.start
      : 0,
    0,
    safeDuration,
  );
  const minEnd = Math.min(safeDuration, start + MIN_SPEED_RANGE_DURATION);
  const end = clamp(
    typeof range.end === "number" && Number.isFinite(range.end)
      ? range.end
      : safeDuration,
    minEnd,
    safeDuration,
  );
  return {
    id: range.id,
    start,
    end: end >= minEnd ? end : safeDuration,
    rate: clampPlaybackSpeed(range.rate ?? DEFAULT_PLAYBACK_SPEED),
    ...(range.autoTyping ? { autoTyping: true } : {}),
  };
}

export function createSpeedRange(
  duration: number,
  at = 0,
  rate = DEFAULT_PLAYBACK_SPEED,
): SpeedRange {
  const safeDuration =
    Number.isFinite(duration) && duration > 0
      ? duration
      : MIN_SPEED_RANGE_DURATION;
  const start = clamp(at, 0, Math.max(0, safeDuration - MIN_SPEED_RANGE_DURATION));
  const span = Math.min(3, Math.max(0, safeDuration - start));
  return {
    id: createSpeedRangeId(),
    start,
    // A recording shorter than the minimum editable span uses its full length.
    end: span < MIN_SPEED_RANGE_DURATION ? safeDuration : start + span,
    rate: clampPlaybackSpeed(rate),
  };
}

/** First matching range wins, matching zoom/trim fragment selection rules. */
export function speedAtTime(
  ranges: SpeedRange[],
  time: number,
  globalRate = DEFAULT_PLAYBACK_SPEED,
): number {
  const range = ranges.find((candidate) => time >= candidate.start && time <= candidate.end);
  return clampPlaybackSpeed(range?.rate ?? globalRate);
}

/** Split kept segments at every speed boundary and attach output-clock spans. */
export function buildSpeedParts(
  segments: TrimSegment[],
  ranges: SpeedRange[],
  globalRate = DEFAULT_PLAYBACK_SPEED,
): SpeedPart[] {
  const parts: SpeedPart[] = [];
  let outputCursor = 0;
  const global = clampPlaybackSpeed(globalRate);
  for (const segment of segments) {
    if (!(segment.end > segment.start)) continue;
    const boundaries = [
      segment.start,
      ...ranges.flatMap((range) =>
        [range.start, range.end].filter(
          (t) => t > segment.start && t < segment.end,
        ),
      ),
      segment.end,
    ].sort((a, b) => a - b);
    const unique: number[] = [];
    for (const boundary of boundaries) {
      if (unique.length === 0 || Math.abs(boundary - unique[unique.length - 1]!) > 1e-7) {
        unique.push(boundary);
      }
    }
    for (let i = 0; i < unique.length - 1; i += 1) {
      const sourceStart = unique[i]!;
      const sourceEnd = unique[i + 1]!;
      if (!(sourceEnd > sourceStart)) continue;
      const rate = speedAtTime(ranges, (sourceStart + sourceEnd) / 2, global);
      const outputDuration = (sourceEnd - sourceStart) / rate;
      parts.push({
        sourceStart,
        sourceEnd,
        outputStart: outputCursor,
        outputEnd: outputCursor + outputDuration,
        rate,
      });
      outputCursor += outputDuration;
    }
  }
  return parts;
}

export function outputDurationForSegments(
  segments: TrimSegment[],
  ranges: SpeedRange[] = [],
  globalRate = DEFAULT_PLAYBACK_SPEED,
): number {
  const parts = buildSpeedParts(segments, ranges, globalRate);
  return parts.length === 0 ? 0 : parts[parts.length - 1]!.outputEnd;
}

/** Sample one source timestamp at the centre of each output frame slot. */
export function planWarpedFrameTimes(
  segments: TrimSegment[],
  fps: number,
  ranges: SpeedRange[] = [],
  globalRate = DEFAULT_PLAYBACK_SPEED,
): number[] {
  const safeFps = Math.max(1, fps);
  const parts = buildSpeedParts(segments, ranges, globalRate);
  if (parts.length === 0) return [];
  const outputDuration = parts[parts.length - 1]!.outputEnd;
  const frameCount = Math.max(1, Math.round(outputDuration * safeFps));
  const times: number[] = [];
  let partIndex = 0;
  for (let i = 0; i < frameCount; i += 1) {
    const outputTime = Math.min(outputDuration - 1e-6, (i + 0.5) / safeFps);
    while (partIndex < parts.length - 1 && outputTime >= parts[partIndex]!.outputEnd) {
      partIndex += 1;
    }
    const part = parts[partIndex]!;
    times.push(
      Math.min(
        part.sourceEnd - 1e-4,
        part.sourceStart + (outputTime - part.outputStart) * part.rate,
      ),
    );
  }
  return times;
}

/** Infer typing spans from the only keyboard-related signal retained today: the text cursor shape. */
export function detectTypingSpeedRanges(
  metadata: RecordingMetadata | null | undefined,
  duration: number,
): SpeedRange[] {
  const samples = [...(metadata?.cursorSamples ?? [])].sort((a, b) => a.t - b.t);
  const safeDuration = Math.max(0, duration);
  if (samples.length < 2 || safeDuration <= 0) return [];
  const runs: Array<{ start: number; end: number }> = [];
  let start: number | null = null;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    const isText = sample.shape === "text";
    if (isText && start === null) start = Math.max(0, sample.t);
    const next = samples[i + 1];
    const end = next ? Math.min(safeDuration, Math.max(sample.t, next.t)) : safeDuration;
    if (!isText && start !== null) {
      const runStart = start;
      if (end - runStart >= 0.2) runs.push({ start: runStart, end });
      start = null;
    } else if (isText && next && next.shape !== "text") {
      const runStart = start;
      if (runStart !== null && end - runStart >= 0.2) {
        runs.push({ start: runStart, end });
      }
      start = null;
    }
  }
  if (start !== null) {
    const runStart = start;
    const end = safeDuration;
    if (end - runStart >= 0.2) runs.push({ start: runStart, end });
  }

  // Merge tiny probe gaps so one typing burst remains one editable block.
  const merged: Array<{ start: number; end: number }> = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && run.start - previous.end <= 0.15) previous.end = run.end;
    else merged.push({ ...run });
  }
  return merged.map((run) => ({
    id: createSpeedRangeId(),
    start: run.start,
    end: run.end,
    rate: TYPING_PLAYBACK_SPEED,
    autoTyping: true,
  }));
}
