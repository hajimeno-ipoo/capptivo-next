export type BlurRegionKind = "blur" | "highlight";

/** A rectangle that can be active for only part of the source timeline. */
export type BlurRegion = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Source-time interval in seconds. Missing values in old projects mean full video. */
  start: number;
  end: number;
  /** `blur` preserves the original privacy behavior; `highlight` draws an accent box. */
  kind: BlurRegionKind;
  /** Highlight color as a six-digit CSS hex value. Ignored for masks. */
  highlightColor: string;
  /** Highlight opacity from 0 (invisible) to 1 (opaque). Ignored for masks. */
  highlightOpacity: number;
};

export type BlurRegionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BlurRegionPlacement = {
  source: BlurRegionRect;
  dest: BlurRegionRect;
};

export const BLUR_REGION_MIN_SIZE = 0.02;

export const REGION_MIN_DURATION = 0.05;

export const BLUR_REGION_STRENGTH = 18;

export const DEFAULT_HIGHLIGHT_COLOR = "#ffd166";
export const DEFAULT_HIGHLIGHT_OPACITY = 0.16;

export function createBlurRegionId(): string {
  return `blur-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeHexColor(value: unknown, fallback = DEFAULT_HIGHLIGHT_COLOR): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed.slice(1).split("").map((part) => `${part}${part}`).join("")}`.toLowerCase();
  }
  return fallback;
}

export function parseHexColor(value: unknown, fallback = DEFAULT_HIGHLIGHT_COLOR): number {
  const normalized = normalizeHexColor(value, fallback);
  return Number.parseInt(normalized.slice(1), 16);
}

export function hexColorWithAlpha(
  value: unknown,
  alpha: number,
  fallback = DEFAULT_HIGHLIGHT_COLOR,
): string {
  const normalized = normalizeHexColor(value, fallback);
  const safeAlpha = clamp(Number.isFinite(alpha) ? alpha : DEFAULT_HIGHLIGHT_OPACITY, 0, 1);
  return `rgba(${Number.parseInt(normalized.slice(1, 3), 16)}, ${Number.parseInt(
    normalized.slice(3, 5),
    16,
  )}, ${Number.parseInt(normalized.slice(5, 7), 16)}, ${safeAlpha})`;
}

export function clampBlurRegion(
  region: Partial<BlurRegion> & Pick<BlurRegion, "id">,
  duration = Number.POSITIVE_INFINITY,
): BlurRegion {
  const safeDuration =
    Number.isFinite(duration) && duration > 0
      ? duration
      : Number.POSITIVE_INFINITY;
  const width = clamp(
    typeof region.width === "number" && Number.isFinite(region.width)
      ? region.width
      : BLUR_REGION_MIN_SIZE,
    BLUR_REGION_MIN_SIZE,
    1,
  );
  const height = clamp(
    typeof region.height === "number" && Number.isFinite(region.height)
      ? region.height
      : BLUR_REGION_MIN_SIZE,
    BLUR_REGION_MIN_SIZE,
    1,
  );
  const start = clamp(
    typeof region.start === "number" && Number.isFinite(region.start)
      ? region.start
      : 0,
    0,
    safeDuration,
  );
  // A very short recording can be shorter than the minimum editable span.
  // In that case the whole recording is the only valid interval.
  const minimumEnd = Math.min(safeDuration, start + REGION_MIN_DURATION);
  const end = clamp(
    typeof region.end === "number" && Number.isFinite(region.end)
      ? region.end
      : safeDuration,
    minimumEnd,
    safeDuration,
  );
  return {
    id: region.id,
    x: clamp(
      typeof region.x === "number" && Number.isFinite(region.x)
        ? region.x
        : 0,
      0,
      1 - width,
    ),
    y: clamp(
      typeof region.y === "number" && Number.isFinite(region.y)
        ? region.y
        : 0,
      0,
      1 - height,
    ),
    width,
    height,
    start,
    end: end >= minimumEnd ? end : safeDuration,
    kind: region.kind === "highlight" ? "highlight" : "blur",
    highlightColor: normalizeHexColor(region.highlightColor),
    highlightOpacity: clamp(
      typeof region.highlightOpacity === "number" && Number.isFinite(region.highlightOpacity)
        ? region.highlightOpacity
        : DEFAULT_HIGHLIGHT_OPACITY,
      0,
      1,
    ),
  };
}

export function createBlurRegion(
  duration = Number.POSITIVE_INFINITY,
  kind: BlurRegionKind = "blur",
): BlurRegion {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 3;
  const end = Math.min(safeDuration, 3);
  return {
    id: createBlurRegionId(),
    x: 0.3,
    y: 0.4,
    width: 0.25,
    height: 0.12,
    start: 0,
    // A recording shorter than the minimum editable span uses its full length.
    end,
    kind,
    highlightColor: DEFAULT_HIGHLIGHT_COLOR,
    highlightOpacity: DEFAULT_HIGHLIGHT_OPACITY,
  };
}

export function blurRegionIsActive(region: BlurRegion, time: number): boolean {
  const start = Number.isFinite(region.start) ? region.start : 0;
  const end = Number.isFinite(region.end) ? region.end : Number.POSITIVE_INFINITY;
  return time >= start && time <= end;
}

export function blurRegionPlacement(
  region: Partial<BlurRegion> & Pick<BlurRegion, "id">,
  sourceWidth: number,
  sourceHeight: number,
  content: { ox: number; oy: number; rw: number; rh: number },
  rect: BlurRegionRect,
): BlurRegionPlacement | null {
  if (
    !(sourceWidth > 0) ||
    !(sourceHeight > 0) ||
    !(content.rw > 0) ||
    !(content.rh > 0) ||
    !(rect.width > 0) ||
    !(rect.height > 0)
  ) {
    return null;
  }

  const safe = clampBlurRegion(region);
  const left = Math.max(safe.x * sourceWidth, content.ox);
  const top = Math.max(safe.y * sourceHeight, content.oy);
  const right = Math.min(
    (safe.x + safe.width) * sourceWidth,
    content.ox + content.rw,
  );
  const bottom = Math.min(
    (safe.y + safe.height) * sourceHeight,
    content.oy + content.rh,
  );

  if (!(right > left) || !(bottom > top)) {
    return null;
  }

  const scaleX = rect.width / content.rw;
  const scaleY = rect.height / content.rh;

  return {
    source: { x: left, y: top, width: right - left, height: bottom - top },
    dest: {
      x: rect.x + (left - content.ox) * scaleX,
      y: rect.y + (top - content.oy) * scaleY,
      width: (right - left) * scaleX,
      height: (bottom - top) * scaleY,
    },
  };
}
