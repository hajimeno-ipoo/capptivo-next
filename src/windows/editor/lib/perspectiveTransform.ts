/** 3D-look values are authored in degrees and composition pixels. */
import { PERSPECTIVE_PIVOT_POINTS, type PerspectivePivot, type ReflectionStyle } from "../../../engine/perspectiveMotion.ts";

export interface PerspectiveLook {
  /** Rotation around the horizontal axis, in degrees. */
  tiltX: number;
  /** Rotation around the vertical axis, in degrees. */
  tiltY: number;
  /** Roll around the viewing axis, in degrees. */
  tiltZ: number;
  /** Point of the recording plane that remains fixed during rotation. */
  pivot?: PerspectivePivot;
  /** Perspective focal distance in composition pixels; 0 uses a gentle default. */
  perspectiveDistance: number;
  reflectionStrength: number;
  reflectionStyle: ReflectionStyle;
}

export { PERSPECTIVE_LIMITS } from "../../../engine/perspectiveMotion.ts";
import { PERSPECTIVE_LIMITS } from "../../../engine/perspectiveMotion.ts";

export type PerspectiveCorner = { x: number; y: number };

export type PerspectiveCorners = {
  topLeft: PerspectiveCorner;
  topRight: PerspectiveCorner;
  bottomRight: PerspectiveCorner;
  bottomLeft: PerspectiveCorner;
};

const IDENTITY_EPSILON = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function projectPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  params: PerspectiveLook,
): PerspectiveCorner {
  const tiltX = degreesToRadians(
    clamp(
      finiteOr(params.tiltX, 0),
      PERSPECTIVE_LIMITS.tiltX.min,
      PERSPECTIVE_LIMITS.tiltX.max,
    ),
  );
  const tiltY = degreesToRadians(
    clamp(
      finiteOr(params.tiltY, 0),
      PERSPECTIVE_LIMITS.tiltY.min,
      PERSPECTIVE_LIMITS.tiltY.max,
    ),
  );
  const tiltZ = degreesToRadians(
    clamp(
      finiteOr(params.tiltZ, 0),
      PERSPECTIVE_LIMITS.tiltZ.min,
      PERSPECTIVE_LIMITS.tiltZ.max,
    ),
  );

  const pivot = PERSPECTIVE_PIVOT_POINTS.find((point) => point.id === params.pivot)
    ?? PERSPECTIVE_PIVOT_POINTS[8];
  const cx = width * pivot.x;
  const cy = height * pivot.y;
  const localX = x - cx;
  const localY = y - cy;

  // Rotate the plane around X, then Y, then Z. The plane starts at z = 0.
  const cosX = Math.cos(tiltX);
  const sinX = Math.sin(tiltX);
  const cosY = Math.cos(tiltY);
  const sinY = Math.sin(tiltY);
  const cosZ = Math.cos(tiltZ);
  const sinZ = Math.sin(tiltZ);

  const yAfterX = localY * cosX;
  const zAfterX = localY * sinX;
  const xAfterY = localX * cosY + zAfterX * sinY;
  const zAfterY = -localX * sinY + zAfterX * cosY;
  const rotatedX = xAfterY * cosZ - yAfterX * sinZ;
  const rotatedY = xAfterY * sinZ + yAfterX * cosZ;

  // A zero distance means "use the gentle automatic distance", not a singular
  // camera. This keeps a tilt-only control useful while all-zero remains flat.
  const requestedDistance = finiteOr(params.perspectiveDistance, 0);
  const automaticDistance = Math.max(width, height) * 4;
  const focalDistance = Math.max(
    Math.max(width, height) * 0.75,
    requestedDistance > 0 ? requestedDistance : automaticDistance,
  );
  const denominator = Math.max(focalDistance * 0.25, focalDistance - zAfterY);
  const perspectiveScale = focalDistance / denominator;

  return {
    x: cx + rotatedX * perspectiveScale,
    y: cy + rotatedY * perspectiveScale,
  };
}

/** True when the recorded plane needs a perspective render pass. */
export function hasPerspectiveEffect(params: PerspectiveLook): boolean {
  return (
    Math.abs(finiteOr(params.tiltX, 0)) > IDENTITY_EPSILON ||
    Math.abs(finiteOr(params.tiltY, 0)) > IDENTITY_EPSILON ||
    Math.abs(finiteOr(params.tiltZ, 0)) > IDENTITY_EPSILON
  );
}

/**
 * Projects the composition rectangle into four clockwise corners for Pixi's
 * PerspectiveMesh. All calculations stay in composition-pixel coordinates.
 */
export function computePerspectiveCorners(
  width: number,
  height: number,
  params: PerspectiveLook,
): PerspectiveCorners {
  const safeWidth = Math.max(1, finiteOr(width, 1));
  const safeHeight = Math.max(1, finiteOr(height, 1));
  if (!hasPerspectiveEffect(params)) {
    return {
      topLeft: { x: 0, y: 0 },
      topRight: { x: safeWidth, y: 0 },
      bottomRight: { x: safeWidth, y: safeHeight },
      bottomLeft: { x: 0, y: safeHeight },
    };
  }

  return {
    topLeft: projectPoint(0, 0, safeWidth, safeHeight, params),
    topRight: projectPoint(safeWidth, 0, safeWidth, safeHeight, params),
    bottomRight: projectPoint(safeWidth, safeHeight, safeWidth, safeHeight, params),
    bottomLeft: projectPoint(0, safeHeight, safeWidth, safeHeight, params),
  };
}
