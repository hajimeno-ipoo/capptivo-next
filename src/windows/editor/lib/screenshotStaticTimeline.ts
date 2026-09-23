import type { BlurRegion } from "../../../engine/blurRegions.ts";
import type { PerspectiveFragment } from "../../../engine/perspectiveMotion.ts";
import type { TextClip } from "../../../engine/textClips.ts";
import type { ZoomFragment } from "../../../engine/zoomMotion.ts";

/** A screenshot has no source-time frame. The shared editor always paints it at this fixed time. */
export const SCREENSHOT_RENDER_TIME = 0;

export type ScreenshotStaticTimeline = {
  zoomFragments: ZoomFragment[];
  perspectiveFragments: PerspectiveFragment[];
  blurRegions: BlurRegion[];
  textClips: TextClip[];
};

/**
 * Convert legacy screenshot projects that used video-style time ranges into a
 * static composition. Masks, highlights, and text can coexist. Zoom and 3D are
 * single composition transforms. Legacy data keeps the transform that applied
 * at the opening frame; if none covered that frame, it keeps the first value.
 */
export function makeScreenshotTimelineStatic(
  state: ScreenshotStaticTimeline,
  duration: number,
): ScreenshotStaticTimeline {
  if (!(duration > 0)) {
    return {
      zoomFragments: [],
      perspectiveFragments: [],
      blurRegions: [],
      textClips: [],
    };
  }

  const zoom =
    state.zoomFragments.find(
      (fragment) =>
        SCREENSHOT_RENDER_TIME >= fragment.start &&
        SCREENSHOT_RENDER_TIME <= fragment.end,
    ) ?? state.zoomFragments[0];
  const perspective =
    state.perspectiveFragments.find(
      (fragment) =>
        SCREENSHOT_RENDER_TIME >= fragment.start &&
        SCREENSHOT_RENDER_TIME <= fragment.end,
    ) ?? state.perspectiveFragments[0];

  return {
    zoomFragments: zoom
      ? [{ ...zoom, start: 0, end: duration, easeIn: 0, easeOut: 0 }]
      : [],
    perspectiveFragments: perspective
      ? [{ ...perspective, start: 0, end: duration, easeIn: 0, easeOut: 0 }]
      : [],
    blurRegions: state.blurRegions.map((region) => ({
      ...region,
      start: 0,
      end: duration,
    })),
    textClips: state.textClips.map((clip) => ({
      ...clip,
      start: 0,
      end: duration,
    })),
  };
}
