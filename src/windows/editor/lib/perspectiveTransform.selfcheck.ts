import {
  computePerspectiveCorners,
  hasPerspectiveEffect,
} from "./perspectiveTransform.ts";
import { PERSPECTIVE_PIVOT_POINTS } from "../../../engine/perspectiveMotion.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const flat = {
  tiltX: 0,
  tiltY: 0,
  tiltZ: 0,
  perspectiveDistance: 0,
  reflectionStrength: 0,
  reflectionStyle: "soft" as const,
};
const identity = computePerspectiveCorners(1920, 1080, flat);
assert(!hasPerspectiveEffect(flat), "zero look is flat");
assert(identity.topLeft.x === 0 && identity.topLeft.y === 0, "identity top-left");
assert(
  identity.bottomRight.x === 1920 && identity.bottomRight.y === 1080,
  "identity bottom-right",
);

const tilted = computePerspectiveCorners(1920, 1080, {
  ...flat,
  tiltX: 24,
  tiltY: -24,
  tiltZ: 0,
  perspectiveDistance: 1800,
});
assert(hasPerspectiveEffect({ ...flat, tiltX: 24 }), "tilt activates effect");
for (const corner of Object.values(tilted)) {
  assert(Number.isFinite(corner.x) && Number.isFinite(corner.y), "corners are finite");
}
assert(
  tilted.topLeft.x !== identity.topLeft.x || tilted.topLeft.y !== identity.topLeft.y,
  "tilt changes the plane",
);

const rolled = computePerspectiveCorners(1920, 1080, {
  ...flat,
  tiltX: 0,
  tiltY: 0,
  tiltZ: 12,
  perspectiveDistance: 0,
});
assert(rolled.topLeft.x > 0 && rolled.topLeft.y < 0, "positive roll rotates top-left");

const cornerPivot = computePerspectiveCorners(1920, 1080, {
  ...flat,
  tiltX: 24,
  tiltY: -24,
  pivot: "bottomLeft",
});
assert(
  Math.abs(cornerPivot.bottomLeft.x) < 1e-6 &&
    Math.abs(cornerPivot.bottomLeft.y - 1080) < 1e-6,
  "selected corner stays fixed during 3D rotation",
);
const edgePivot = computePerspectiveCorners(1920, 1080, {
  ...flat,
  tiltY: -24,
  pivot: "right",
});
assert(
  Math.abs((edgePivot.topRight.x + edgePivot.bottomRight.x) / 2 - 1920) < 1e-6 &&
    Math.abs((edgePivot.topRight.y + edgePivot.bottomRight.y) / 2 - 540) < 1e-6,
  "selected edge midpoint stays fixed during 3D rotation",
);

for (const pivot of PERSPECTIVE_PIVOT_POINTS) {
  const corners = computePerspectiveCorners(1920, 1080, {
    ...flat,
    tiltZ: 20,
    pivot: pivot.id,
  });
  const topX = corners.topLeft.x * (1 - pivot.x) + corners.topRight.x * pivot.x;
  const topY = corners.topLeft.y * (1 - pivot.x) + corners.topRight.y * pivot.x;
  const bottomX = corners.bottomLeft.x * (1 - pivot.x) + corners.bottomRight.x * pivot.x;
  const bottomY = corners.bottomLeft.y * (1 - pivot.x) + corners.bottomRight.y * pivot.x;
  const selectedX = topX * (1 - pivot.y) + bottomX * pivot.y;
  const selectedY = topY * (1 - pivot.y) + bottomY * pivot.y;
  assert(
    Math.abs(selectedX - 1920 * pivot.x) < 1e-6 &&
      Math.abs(selectedY - 1080 * pivot.y) < 1e-6,
    `${pivot.id} stays fixed during Z rotation`,
  );
}

console.log("perspectiveTransform.selfcheck: ok");
