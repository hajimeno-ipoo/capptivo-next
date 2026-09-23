export type OutputPresentationPlan =
  | { kind: "direct"; scaleX: number; scaleY: number }
  | { kind: "resample" };

export type PerspectiveRasterPlan = {
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
};

/**
 * Upscaling renders the logical scene straight into the larger GPU surface so
 * source textures retain their pixels. Downscaling still uses the staged box
 * filter in OutputSurface to avoid aliasing fine UI detail.
 */
export function outputPresentationPlan(
  compositionWidth: number,
  compositionHeight: number,
  outputWidth: number,
  outputHeight: number,
): OutputPresentationPlan {
  if (
    outputWidth >= compositionWidth &&
    outputHeight >= compositionHeight
  ) {
    return {
      kind: "direct",
      scaleX: outputWidth / compositionWidth,
      scaleY: outputHeight / compositionHeight,
    };
  }
  return { kind: "resample" };
}

/**
 * A perspective mesh must retain the same source-pixel density as a direct
 * high-resolution export. Downscaled outputs continue to use the logical
 * composition size because OutputSurface performs their final resampling.
 */
export function perspectiveRasterPlan(
  compositionWidth: number,
  compositionHeight: number,
  outputWidth: number,
  outputHeight: number,
): PerspectiveRasterPlan {
  const presentation = outputPresentationPlan(
    compositionWidth,
    compositionHeight,
    outputWidth,
    outputHeight,
  );
  if (presentation.kind === "direct") {
    return {
      width: outputWidth,
      height: outputHeight,
      scaleX: presentation.scaleX,
      scaleY: presentation.scaleY,
    };
  }
  return {
    width: compositionWidth,
    height: compositionHeight,
    scaleX: 1,
    scaleY: 1,
  };
}
