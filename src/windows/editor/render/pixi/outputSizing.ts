export type OutputPresentationPlan =
  | { kind: "direct"; scaleX: number; scaleY: number }
  | { kind: "resample" };

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
