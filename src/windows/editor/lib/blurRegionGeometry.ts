import { blurRegionPlacement, clampBlurRegion, type BlurRegion } from "../../../engine/blurRegions.ts";
import { contentRectPixelsFromCrop, type ScreenContentCropNorm } from "../../../engine/zoomMotion.ts";
import type { CameraTransform } from "../../../engine/cameraTransform.ts";

type NormRect = { x: number; y: number; width: number; height: number };
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

