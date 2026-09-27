/**
 * Click/press activity → zoom suggestions (seconds).
 * Start the zoom-in before the first click, stay focused through the last
 * release and a short reading pause, then leave room for the zoom-out.
 */

import type { CursorClickSample, CursorPressInterval } from "../../../engine/zoomMotion.ts";

/** Landscape-ish source required for auto-apply (portrait demos stay manual). */
export const MIN_AUTO_ZOOM_SOURCE_ASPECT = 1.2;

/** Consecutive clicks closer than this join the same cluster. */
export const CLICK_CLUSTER_MERGE_GAP_SEC = 2.5;

/** Time to read the result of the last click before zooming out. */
export const AUTO_ZOOM_AFTER_PRESS_HOLD_SEC = 0.75;

/** Gentle default: readable magnification without disorienting the viewer. */
export const AUTO_ZOOM_TARGET_SCALE = 1.5;

export type SuggestedZoomSpan = {
  start: number;
  end: number;
  easeIn: number;
  easeOut: number;
  /** Normalized focus (strongest click); Capptivo follow-cursor uses live samples. */
  focus: { x: number; y: number };
};

export type ZoomSuggestionStatus =
  | "ok"
  | "no-duration"
  | "no-clicks"
  | "no-slots";

export type ZoomSuggestionResult = {
  status: ZoomSuggestionStatus;
  suggestions: SuggestedZoomSpan[];
};

export function shouldAutoSuggestZoomsForSource(
  sourceWidth?: number,
  sourceHeight?: number,
): boolean {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    (sourceWidth ?? 0) <= 0 ||
    (sourceHeight ?? 0) <= 0
  ) {
    return true;
  }
  return (
    (sourceWidth as number) / (sourceHeight as number) >=
    MIN_AUTO_ZOOM_SOURCE_ASPECT
  );
}

type ClickCandidate = {
  t: number;
  pressEnd: number;
  x: number;
  y: number;
};

function normalizeClicks(
  clicks: CursorClickSample[],
  pressIntervals: CursorPressInterval[],
  duration: number,
): ClickCandidate[] {
  return clicks
    .map((c, index) => ({ click: c, press: pressIntervals[index] }))
    .filter(
      ({ click: c }) =>
        Number.isFinite(c.t) &&
        Number.isFinite(c.x) &&
        Number.isFinite(c.y) &&
        c.t >= 0 &&
        c.t <= duration,
    )
    .map(({ click: c, press }) => ({
      t: Math.max(0, Math.min(duration, c.t)),
      pressEnd:
        press && Math.abs(press.start - c.t) < 0.05 &&
        Number.isFinite(press.end) && press.end >= c.t
          ? Math.min(duration, press.end)
          : c.t,
      x: Math.max(0, Math.min(1, c.x)),
      y: Math.max(0, Math.min(1, c.y)),
    }))
    .sort((a, b) => a.t - b.t);
}

type Cluster = {
  first: number;
  lastPressEnd: number;
  focus: { x: number; y: number };
};

function buildClickClusters(
  clicks: ClickCandidate[],
  mergeGapSec: number,
): Cluster[] {
  if (clicks.length === 0) return [];

  const clusters: Cluster[] = [];
  let first = clicks[0]!.t;
  let lastPressEnd = clicks[0]!.pressEnd;
  let focus = { x: clicks[0]!.x, y: clicks[0]!.y };
  const flush = () => {
    clusters.push({
      first,
      lastPressEnd,
      focus,
    });
  };

  for (let i = 1; i < clicks.length; i++) {
    const click = clicks[i]!;
    if (click.t - lastPressEnd <= mergeGapSec) {
      lastPressEnd = Math.max(lastPressEnd, click.pressEnd);
      // Prefer the latest click in a burst (usually the intentional one).
      focus = { x: click.x, y: click.y };
    } else {
      flush();
      first = click.t;
      lastPressEnd = click.pressEnd;
      focus = { x: click.x, y: click.y };
    }
  }
  flush();
  return clusters;
}

function spansOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.end > b.start && a.start < b.end;
}

/** Preserve the requested easing and reading pause whenever the recording allows it. */
function windowForCluster(
  cluster: Cluster,
  duration: number,
  easeInSec: number,
  easeOutSec: number,
  holdAfterSec: number,
): SuggestedZoomSpan | null {
  const start = Math.max(0, cluster.first - easeInSec);
  const end = Math.min(duration, cluster.lastPressEnd + holdAfterSec + easeOutSec);
  if (end <= start) return null;
  if (end - start < 0.05) return null;
  return {
    start,
    end,
    easeIn: Math.min(easeInSec, cluster.first - start),
    easeOut: Math.min(easeOutSec, Math.max(0, end - cluster.lastPressEnd - holdAfterSec)),
    focus: cluster.focus,
  };
}

/**
 * Build zoom windows from click clusters and recorded button holds.
 * Existing zooms are reserved so suggestions never overlap them.
 */
export function buildClickZoomSuggestions(params: {
  clicks: CursorClickSample[];
  pressIntervals?: CursorPressInterval[];
  duration: number;
  reservedSpans?: Array<{ start: number; end: number }>;
  mergeGapSec?: number;
  easeInSec?: number;
  easeOutSec?: number;
  holdAfterSec?: number;
}): ZoomSuggestionResult {
  const {
    clicks,
    pressIntervals = [],
    duration,
    reservedSpans = [],
    mergeGapSec = CLICK_CLUSTER_MERGE_GAP_SEC,
    easeInSec = 1,
    easeOutSec = 1,
    holdAfterSec = AUTO_ZOOM_AFTER_PRESS_HOLD_SEC,
  } = params;

  if (!(duration > 0)) {
    return { status: "no-duration", suggestions: [] };
  }

  const normalized = normalizeClicks(clicks, pressIntervals, duration);
  if (normalized.length === 0) {
    return { status: "no-clicks", suggestions: [] };
  }

  const clusters = buildClickClusters(normalized, mergeGapSec);
  const reserved = reservedSpans
    .filter((s) => s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start);

  const raw: SuggestedZoomSpan[] = [];

  for (const cluster of clusters) {
    const win = windowForCluster(cluster, duration, easeInSec, easeOutSec, holdAfterSec);
    if (!win) continue;
    if (reserved.some((span) => spansOverlap(win, span))) continue;
    raw.push(win);
  }

  if (raw.length === 0) {
    return { status: "no-slots", suggestions: [] };
  }

  // Nearby windows can overlap because their entrance and exit need time.
  raw.sort((a, b) => a.start - b.start);
  const merged: SuggestedZoomSpan[] = [];
  for (const span of raw) {
    const prev = merged[merged.length - 1];
    if (prev && spansOverlap(prev, span)) {
      if (span.end > prev.end) {
        prev.end = span.end;
        prev.easeOut = span.easeOut;
      }
      prev.focus = span.focus;
    } else {
      merged.push({ ...span, focus: { ...span.focus } });
    }
  }

  return { status: "ok", suggestions: merged };
}
