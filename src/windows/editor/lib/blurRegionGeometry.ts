import { blurRegionPlacement, clampBlurRegion, type BlurRegion } from "../../../engine/blurRegions.ts";
import { contentRectPixelsFromCrop, type ScreenContentCropNorm } from "../../../engine/zoomMotion.ts";
import type { CameraTransform } from "../../../engine/cameraTransform.ts";
import type { PerspectivePlaneMapping } from "./perspectiveTransform.ts";

type NormRect = { x: number; y: number; width: number; height: number };
export type RegionQuad = Record<"nw" | "ne" | "se" | "sw", { x: number; y: number }>;
type RegionComposition = {
  stageDimensions: { width: number; height: number };
  recordingRect: NormRect;
  screenContentCrop: ScreenContentCropNorm | null;
};

function sourceContentRect(
  sourceVideoSize: { width: number; height: number },
  crop: ScreenContentCropNorm | null,
) {
  return crop
    ? contentRectPixelsFromCrop(sourceVideoSize.width, sourceVideoSize.height, crop)
    : {
        ox: 0,
        oy: 0,
        rw: sourceVideoSize.width,
        rh: sourceVideoSize.height,
      };
}

export function stageRectFromRegion(
  region: BlurRegion,
  sourceVideoSize: { width: number; height: number },
  composition: RegionComposition,
  camera: CameraTransform,
): NormRect | null {
  const placement = blurRegionPlacement(
    region,
    sourceVideoSize.width,
    sourceVideoSize.height,
    sourceContentRect(sourceVideoSize, composition.screenContentCrop),
    composition.recordingRect,
  );
  if (!placement) return null;
  const stageWidth = Math.max(1, composition.stageDimensions.width);
  const stageHeight = Math.max(1, composition.stageDimensions.height);
  return {
    x: (camera.x + placement.dest.x * camera.scale) / stageWidth,
    y: (camera.y + placement.dest.y * camera.scale) / stageHeight,
    width: placement.dest.width * camera.scale / stageWidth,
    height: placement.dest.height * camera.scale / stageHeight,
  };
}

export function regionFromStageRect(
  rect: NormRect,
  current: BlurRegion,
  composition: RegionComposition,
  duration: number,
  camera: CameraTransform,
): BlurRegion {
  const stageWidth = Math.max(1, composition.stageDimensions.width);
  const stageHeight = Math.max(1, composition.stageDimensions.height);
  // Undo the camera before converting from stage space into source space.
  const unzoomed = {
    x: (rect.x - camera.x / stageWidth) / camera.scale,
    y: (rect.y - camera.y / stageHeight) / camera.scale,
    width: rect.width / camera.scale,
    height: rect.height / camera.scale,
  };
  const recording = composition.recordingRect;
  const recordingX = recording.x / stageWidth;
  const recordingY = recording.y / stageHeight;
  const recordingWidth = Math.max(1e-6, recording.width / stageWidth);
  const recordingHeight = Math.max(1e-6, recording.height / stageHeight);
  const crop = composition.screenContentCrop ?? {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };
  return clampBlurRegion(
    {
      ...current,
      x: crop.x + ((unzoomed.x - recordingX) / recordingWidth) * crop.width,
      y: crop.y + ((unzoomed.y - recordingY) / recordingHeight) * crop.height,
      width: (unzoomed.width / recordingWidth) * crop.width,
      height: (unzoomed.height / recordingHeight) * crop.height,
    },
    duration,
  );
}

export function stageQuadFromRect(
  rect: NormRect,
  mapping: PerspectivePlaneMapping | null,
  clipToStage = false,
): RegionQuad | null {
  if (!mapping) return null;
  // The compositor clips the zoomed camera into its stage-sized texture before
  // applying 3D. Clip only the displayed outline, never the authored rectangle.
  const left = clipToStage ? Math.max(0, rect.x) : rect.x;
  const top = clipToStage ? Math.max(0, rect.y) : rect.y;
  const right = clipToStage ? Math.min(1, rect.x + rect.width) : rect.x + rect.width;
  const bottom = clipToStage ? Math.min(1, rect.y + rect.height) : rect.y + rect.height;
  if (!(right > left) || !(bottom > top)) return null;
  const nw = mapping.project({ x: left, y: top });
  const ne = mapping.project({ x: right, y: top });
  const se = mapping.project({ x: right, y: bottom });
  const sw = mapping.project({ x: left, y: bottom });
  return nw && ne && se && sw ? { nw, ne, se, sw } : null;
}
