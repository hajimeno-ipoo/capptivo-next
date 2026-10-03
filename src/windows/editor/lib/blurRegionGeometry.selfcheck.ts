import { computeCameraTransform, CAMERA_IDENTITY } from "../../../engine/cameraTransform.ts";
import { clampBlurRegion } from "../../../engine/blurRegions.ts";
import { stageRectFromRegion, regionFromStageRect } from "./blurRegionGeometry.ts";

function assert(ok: boolean, message: string): void {
  if (!ok) throw new Error(message);
}
function close(a: number, b: number): boolean { return Math.abs(a - b) < 1e-9; }
const source = { width: 2400, height: 1600 };
const composition = {
  stageDimensions: { width: 1920, height: 1080 },
  recordingRect: { x: 240, y: 90, width: 1440, height: 900 },
  screenContentCrop: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
};
for (const kind of ["blur", "highlight"] as const) {
  const region = clampBlurRegion({
    id: kind, kind, x: 0.3, y: 0.35, width: 0.2, height: 0.15,
    start: 2, end: 9, highlightColor: "#ff9900", highlightOpacity: 0.4,
  }, 12);
  for (const scale of [1, 1.01, 1.25, 1.5, 2]) {
    const camera = computeCameraTransform({
      stageWidth: 1920, stageHeight: 1080, videoRect: composition.recordingRect,
      focus: { x: 0.65, y: 0.3 }, scale, targetScale: 2,
    });
    const rect = stageRectFromRegion(region, source, composition, camera)!;
    // Expected crop mapping: x=(.3-.1)/.8, y=(.35-.2)/.6.
    // Compare to the renderer's scale-then-translate in absolute stage pixels.
    assert(close(rect.x * 1920, camera.x + 600 * camera.scale), "effect and frame x agree");
    assert(close(rect.y * 1080, camera.y + 315 * camera.scale), "effect and frame y agree");
    assert(close(rect.width * 1920, 360 * camera.scale), "frame width follows magnification");
    assert(close(rect.height * 1080, 225 * camera.scale), "frame height follows magnification");
    const saved = regionFromStageRect(rect, region, composition, 12, camera);
    for (const key of ["x", "y", "width", "height"] as const)
      assert(close(saved[key], region[key]), `stationary edit preserves ${key}`);
    assert(saved.kind === kind && saved.start === 2 && saved.end === 9
      && saved.highlightColor === "#ff9900" && saved.highlightOpacity === 0.4,
    "geometry edits preserve effect and timing");
    // A 48px displayed drag must stay 48px regardless of magnification.
    const moved = regionFromStageRect({ ...rect, x: rect.x + 48 / 1920 }, region, composition, 12, camera);
    const movedRect = stageRectFromRegion(moved, source, composition, camera)!;
    assert(close((movedRect.x - rect.x) * 1920, 48), "drag follows pointer at every scale");
    const resized = regionFromStageRect({ ...rect, width: rect.width + 30 / 1920 }, region, composition, 12, camera);
    const resizedRect = stageRectFromRegion(resized, source, composition, camera)!;
    assert(close((resizedRect.width - rect.width) * 1920, 30), "resize follows pointer at every scale");
  }
}
const hidden = clampBlurRegion({ id: "hidden", x: 0, y: 0, width: 0.05, height: 0.05 });
assert(stageRectFromRegion(hidden, source, composition, CAMERA_IDENTITY) === null, "crop excludes hidden effects");
const partial = clampBlurRegion({ id: "partial", x: 0.05, y: 0.3, width: 0.2, height: 0.1 });
const partialRect = stageRectFromRegion(partial, source, composition, CAMERA_IDENTITY)!;
assert(close(partialRect.x * 1920, 240) && close(partialRect.width * 1920, 270), "partly cropped frame matches visible effect");
console.log("blurRegionGeometry.selfcheck: ok");
