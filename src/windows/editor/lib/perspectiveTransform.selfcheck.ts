import {
  computePerspectiveCorners,
  hasPerspectiveEffect,
} from "./perspectiveTransform.ts";

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

console.log("perspectiveTransform.selfcheck: ok");
