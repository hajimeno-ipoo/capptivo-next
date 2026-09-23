import {
  outputPresentationPlan,
  perspectiveRasterPlan,
} from "./outputSizing.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const unchanged = outputPresentationPlan(1920, 1080, 1920, 1080);
assert(unchanged.kind === "direct", "equal-size output must render directly");
assert(unchanged.scaleX === 1 && unchanged.scaleY === 1, "equal-size scale must be 1");

const retina = outputPresentationPlan(1920, 1080, 3840, 2160);
assert(retina.kind === "direct", "high-resolution screenshots must render directly");
assert(retina.scaleX === 2 && retina.scaleY === 2, "4K output must use a 2x root transform");

assert(
  outputPresentationPlan(1920, 1080, 800, 450).kind === "resample",
  "smaller exports must retain the downscale path",
);
assert(
  outputPresentationPlan(1920, 1080, 2560, 720).kind === "resample",
  "mixed-axis resizing must use the resample path",
);

const highResolutionPerspective = perspectiveRasterPlan(
  1920,
  1080,
  3840,
  2160,
);
assert(
  highResolutionPerspective.width === 3840 &&
    highResolutionPerspective.height === 2160,
  "perspective must rasterize at the high-resolution output size",
);
assert(
  highResolutionPerspective.scaleX === 2 &&
    highResolutionPerspective.scaleY === 2,
  "perspective camera must fill the high-resolution texture",
);

const downscaledPerspective = perspectiveRasterPlan(
  1920,
  1080,
  800,
  450,
);
assert(
  downscaledPerspective.width === 1920 &&
    downscaledPerspective.height === 1080,
  "downscaled perspective must retain the logical composition size",
);
assert(
  downscaledPerspective.scaleX === 1 &&
    downscaledPerspective.scaleY === 1,
  "downscaled perspective must not pre-scale the camera subtree",
);

console.log("outputSizing.selfcheck: ok");
