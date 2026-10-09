import {
  computePerspectiveCorners,
  hasPerspectiveEffect,
  createPerspectivePlaneMapping,
} from "./perspectiveTransform.ts";
import { PerspectivePlaneGeometry } from "pixi.js";
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


// Compare the selection mapping against the actual compositor mesh, including
// interior vertices (matching only the four corners misses a wrong projection).
for (const pivot of PERSPECTIVE_PIVOT_POINTS) {
  for (const look of [
    flat,
    { ...flat, tiltX: 12, tiltY: -18, tiltZ: -4, perspectiveDistance: 1100 },
    { ...flat, tiltX: 45, tiltY: 45, tiltZ: 30, perspectiveDistance: 1 },
    { ...flat, tiltX: -45, tiltY: -45, tiltZ: -30, perspectiveDistance: 3000 },
  ]) {
    const width = 1920;
    const height = 1080;
    const params = { ...look, pivot: pivot.id };
    const corners = computePerspectiveCorners(width, height, params);
    const mapping = createPerspectivePlaneMapping(width, height, params);
    assert(mapping, "non-degenerate authored plane has a mapping");
    const mesh = new PerspectivePlaneGeometry({ width, height, verticesX: 97, verticesY: 65 });
    mesh.setCorners(
      corners.topLeft.x, corners.topLeft.y, corners.topRight.x, corners.topRight.y,
      corners.bottomRight.x, corners.bottomRight.y, corners.bottomLeft.x, corners.bottomLeft.y,
    );
    const vertices = mesh.getBuffer("aPosition").data;
    for (const row of [0, 1, 13, 32, 63, 64]) {
      for (const column of [0, 1, 17, 48, 80, 96]) {
        const source = { x: column / 96, y: row / 64 };
        const projected = mapping.project(source);
        assert(projected, "mesh point can be projected");
        const index = (row * 97 + column) * 2;
        assert(Math.abs(projected.x * width - vertices[index]) < 0.002 &&
          Math.abs(projected.y * height - vertices[index + 1]) < 0.002,
        "overlay matches actual Pixi mesh at interior vertices and every pivot");
        const restored = mapping.unproject(projected);
        assert(restored && Math.abs(restored.x - source.x) < 1e-9 &&
          Math.abs(restored.y - source.y) < 1e-9, "pointer can return to the authored plane");
      }
    }
    mesh.destroy();
  }
}

console.log("perspectiveTransform.selfcheck: ok");
