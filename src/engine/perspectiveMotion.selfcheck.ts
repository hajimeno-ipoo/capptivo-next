import {
  PERSPECTIVE_PIVOT_POINTS,
  createDefaultPerspectiveFragment,
  findActivePerspectiveFragment,
  normalizePerspectiveFragments,
  perspectiveValuesAtTime,
} from "./perspectiveMotion.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const flat = perspectiveValuesAtTime(null, 2);
assert(
  flat.tiltX === 0 &&
    flat.tiltY === 0 &&
    flat.tiltZ === 0 &&
    flat.pivot === "center" &&
    flat.perspectiveDistance === 0 &&
    flat.reflectionStrength === 0,
  "no active fragment keeps the recording flat",
);

const fragment = {
  ...createDefaultPerspectiveFragment(2, 6),
  tiltX: 20,
  tiltY: -10,
  tiltZ: 5,
  pivot: "bottomLeft" as const,
  perspectiveDistance: 800,
  reflectionStrength: 60,
  reflectionStyle: "dots" as const,
  easeIn: 0,
  easeOut: 0,
};

assert(findActivePerspectiveFragment([fragment], 1.99) === null, "before the block is flat");
assert(
  findActivePerspectiveFragment([fragment], 4)?.id === fragment.id,
  "inside the block selects the block",
);
assert(findActivePerspectiveFragment([fragment], 6.01) === null, "after the block is flat");

const active = perspectiveValuesAtTime(fragment, 4);
assert(
  active.tiltX === 20 &&
    active.tiltY === -10 &&
    active.tiltZ === 5 &&
    active.pivot === "bottomLeft" &&
    active.perspectiveDistance === 800 &&
    active.reflectionStrength === 60 &&
    active.reflectionStyle === "dots",
  "the selected block supplies its 3D values",
);

const [legacy] = normalizePerspectiveFragments([{ id: "old", start: 2, end: 6, tiltX: 8 }], 8);
assert(legacy.reflectionStrength === 0 && legacy.reflectionStyle === "soft", "old blocks default to no reflection");
assert(legacy.pivot === "center", "old blocks retain the center pivot");
for (const point of PERSPECTIVE_PIVOT_POINTS) {
  const [saved] = normalizePerspectiveFragments([{ ...fragment, pivot: point.id }], 8);
  assert(saved.pivot === point.id, `${point.id} pivot survives project loading`);
}
const [clamped] = normalizePerspectiveFragments([{ ...fragment, reflectionStrength: 150, reflectionStyle: "unknown" }], 8);
assert(clamped.reflectionStrength === 100 && clamped.reflectionStyle === "soft", "invalid reflection settings normalize");

console.log("perspectiveMotion.selfcheck: ok");
