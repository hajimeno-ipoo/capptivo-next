export type TextClip = {
  id: string;
  /** Source-time interval in seconds. */
  start: number;
  end: number;
  text: string;
  /** CSS font-family value. */
  fontFamily: string;
  /** Six-digit CSS hex color. */
  color: string;
  /** Font size in composition-reference pixels. */
  fontSizePx: number;
  /** Normalized center position within the composition. */
  x: number;
  y: number;
};

export const TEXT_CLIP_MIN_DURATION = 0.05;
export const DEFAULT_TEXT_FONT_FAMILY = "system-ui, -apple-system, sans-serif";
export const DEFAULT_TEXT_COLOR = "#ffffff";
export const DEFAULT_TEXT_FONT_SIZE_PX = 38;
export const DEFAULT_TEXT_X = 0.5;
export const DEFAULT_TEXT_Y = 0.75;

/** A deliberately small, cross-platform set of fonts available in macOS and browsers. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed.slice(1).split("").map((part) => `${part}${part}`).join("")}`.toLowerCase();
  }
  return fallback;
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 4000) : "";
}

export function createTextClipId(): string {
  return `text-${Math.random().toString(36).slice(2, 10)}`;
}

export function clampTextClip(
  clip: Partial<TextClip> & Pick<TextClip, "id">,
  duration = Number.POSITIVE_INFINITY,
): TextClip {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const start = clamp(
    typeof clip.start === "number" && Number.isFinite(clip.start) ? clip.start : 0,
    0,
    safeDuration,
  );
  const minimumEnd = Math.min(safeDuration, start + TEXT_CLIP_MIN_DURATION);
  const end = clamp(
    typeof clip.end === "number" && Number.isFinite(clip.end) ? clip.end : safeDuration,
    minimumEnd,
    safeDuration,
  );
  return {
    id: clip.id,
    start,
    end: end >= minimumEnd ? end : safeDuration,
    text: safeText(clip.text ?? "Text"),
    fontFamily:
      typeof clip.fontFamily === "string" && clip.fontFamily.trim().length > 0
        ? clip.fontFamily
        : DEFAULT_TEXT_FONT_FAMILY,
    color: normalizeHexColor(clip.color, DEFAULT_TEXT_COLOR),
    fontSizePx: clamp(
      typeof clip.fontSizePx === "number" && Number.isFinite(clip.fontSizePx)
        ? clip.fontSizePx
        : DEFAULT_TEXT_FONT_SIZE_PX,
      12,
      160,
    ),
    x: clamp(typeof clip.x === "number" && Number.isFinite(clip.x) ? clip.x : DEFAULT_TEXT_X, 0, 1),
    y: clamp(typeof clip.y === "number" && Number.isFinite(clip.y) ? clip.y : DEFAULT_TEXT_Y, 0, 1),
  };
}

export function createTextClip(duration = Number.POSITIVE_INFINITY, currentTime = 0): TextClip {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 3;
  const length = Math.min(3, safeDuration);
  const start = clamp(currentTime - length / 2, 0, Math.max(0, safeDuration - length));
  return clampTextClip(
    {
      id: createTextClipId(),
      start,
      end: start + length,
      text: "Text",
      fontFamily: DEFAULT_TEXT_FONT_FAMILY,
      color: DEFAULT_TEXT_COLOR,
      fontSizePx: DEFAULT_TEXT_FONT_SIZE_PX,
      x: DEFAULT_TEXT_X,
      y: DEFAULT_TEXT_Y,
    },
    duration,
  );
}

export function textClipIsActive(clip: TextClip, time: number): boolean {
  return time >= clip.start && time <= clip.end;
}
