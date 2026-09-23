/** Timeline-owned 3D perspective effects. */

export const PERSPECTIVE_LIMITS = {
  tiltX: { min: -45, max: 45 },
  tiltY: { min: -45, max: 45 },
  tiltZ: { min: -30, max: 30 },
  perspectiveDistance: { min: 0, max: 3000 },
} as const;

export const PERSPECTIVE_DEFAULT_DURATION = 3;
export const PERSPECTIVE_DEFAULT_EASE = 0.35;

export const PERSPECTIVE_PIVOT_POINTS = [
  { id: "topLeft", x: 0, y: 0 },
  { id: "top", x: 0.5, y: 0 },
  { id: "topRight", x: 1, y: 0 },
  { id: "right", x: 1, y: 0.5 },
  { id: "bottomRight", x: 1, y: 1 },
  { id: "bottom", x: 0.5, y: 1 },
  { id: "bottomLeft", x: 0, y: 1 },
  { id: "left", x: 0, y: 0.5 },
  { id: "center", x: 0.5, y: 0.5 },
] as const;

export type PerspectivePivot = (typeof PERSPECTIVE_PIVOT_POINTS)[number]["id"];

export function isPerspectivePivot(value: unknown): value is PerspectivePivot {
  return PERSPECTIVE_PIVOT_POINTS.some((point) => point.id === value);
}

export type PerspectiveFragment = {
  id: string;
  start: number;
  end: number;
  tiltX: number;
  tiltY: number;
  tiltZ: number;
  pivot?: PerspectivePivot;
  perspectiveDistance: number;
  reflectionStrength: number;
  reflectionStyle: ReflectionStyle;
  easeIn: number;
  easeOut: number;
};

export type ReflectionStyle = "soft" | "sharp" | "dots";

export function isReflectionStyle(value: unknown): value is ReflectionStyle {
  return value === "soft" || value === "sharp" || value === "dots";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function easeOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

export function createPerspectiveFragmentId(): string {
  return `perspective-${Math.random().toString(36).slice(2, 10)}`;
}

/** A moderate 3D hit that is visible as soon as a timeline block is added. */
export function createDefaultPerspectiveFragment(
  start: number,
  end: number,
): PerspectiveFragment {
  return {
    id: createPerspectiveFragmentId(),
    start,
    end: Math.max(start + 0.2, end),
    tiltX: 12,
    tiltY: -18,
    tiltZ: -4,
    pivot: "center",
    perspectiveDistance: 1100,
    reflectionStrength: 0,
    reflectionStyle: "soft",
    easeIn: PERSPECTIVE_DEFAULT_EASE,
    easeOut: PERSPECTIVE_DEFAULT_EASE,
  };
}

/** Clamp and discard malformed persisted perspective blocks. */
export function normalizePerspectiveFragments(
  raw: unknown,
  duration: number,
  minLength = 0.2,
): PerspectiveFragment[] {
  if (!Array.isArray(raw) || duration <= 0) return [];

  return raw
    .flatMap((value): PerspectiveFragment[] => {
      if (!value || typeof value !== "object") return [];
      const d = value as Record<string, unknown>;
      const start = clamp(finiteOr(d.start, 0), 0, duration);
      const end = clamp(finiteOr(d.end, 0), 0, duration);
      if (end - start < minLength) return [];
      return [
        {
          id:
            typeof d.id === "string" && d.id.length > 0
              ? d.id
              : createPerspectiveFragmentId(),
          start,
          end,
          tiltX: clamp(
            finiteOr(d.tiltX, 0),
            PERSPECTIVE_LIMITS.tiltX.min,
            PERSPECTIVE_LIMITS.tiltX.max,
          ),
          tiltY: clamp(
            finiteOr(d.tiltY, 0),
            PERSPECTIVE_LIMITS.tiltY.min,
            PERSPECTIVE_LIMITS.tiltY.max,
          ),
          tiltZ: clamp(
            finiteOr(d.tiltZ, 0),
            PERSPECTIVE_LIMITS.tiltZ.min,
            PERSPECTIVE_LIMITS.tiltZ.max,
          ),
          pivot: isPerspectivePivot(d.pivot) ? d.pivot : "center",
          perspectiveDistance: clamp(
            finiteOr(d.perspectiveDistance, 0),
            PERSPECTIVE_LIMITS.perspectiveDistance.min,
            PERSPECTIVE_LIMITS.perspectiveDistance.max,
          ),
          reflectionStrength: clamp(finiteOr(d.reflectionStrength, 0), 0, 100),
          reflectionStyle: isReflectionStyle(d.reflectionStyle) ? d.reflectionStyle : "soft",
          easeIn: clamp(finiteOr(d.easeIn, PERSPECTIVE_DEFAULT_EASE), 0, (end - start) / 2),
          easeOut: clamp(finiteOr(d.easeOut, PERSPECTIVE_DEFAULT_EASE), 0, (end - start) / 2),
        },
      ];
    })
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}

/** First matching block wins, matching the existing zoom timeline semantics. */
export function findActivePerspectiveFragment(
  fragments: PerspectiveFragment[],
  time: number,
): PerspectiveFragment | null {
  return fragments.find((fragment) => time >= fragment.start && time <= fragment.end) ?? null;
}

export function computePerspectiveEnvelope(
  fragment: PerspectiveFragment,
  time: number,
): number {
  const total = Math.max(1e-6, fragment.end - fragment.start);
  const local = clamp(time - fragment.start, 0, total);
  const easeIn = clamp(fragment.easeIn, 0, total / 2);
  const easeOut = clamp(fragment.easeOut, 0, total / 2);

  if (easeIn > 0 && local < easeIn) return easeOutCubic(local / easeIn);
  if (easeOut > 0 && local > total - easeOut) {
    return 1 - easeOutCubic((local - (total - easeOut)) / easeOut);
  }
  return 1;
}

/** Values to apply to the recording plane for one source timestamp. */
export function perspectiveValuesAtTime(
  fragment: PerspectiveFragment | null,
  time: number,
): { tiltX: number; tiltY: number; tiltZ: number; pivot: PerspectivePivot; perspectiveDistance: number; reflectionStrength: number; reflectionStyle: ReflectionStyle } {
  if (!fragment) {
    return { tiltX: 0, tiltY: 0, tiltZ: 0, pivot: "center", perspectiveDistance: 0, reflectionStrength: 0, reflectionStyle: "soft" };
  }

  const amount = computePerspectiveEnvelope(fragment, time);
  return {
    tiltX: fragment.tiltX * amount,
    tiltY: fragment.tiltY * amount,
    tiltZ: fragment.tiltZ * amount,
    pivot: fragment.pivot ?? "center",
    perspectiveDistance: fragment.perspectiveDistance * amount,
    reflectionStrength: fragment.reflectionStrength * amount,
    reflectionStyle: fragment.reflectionStyle,
  };
}
