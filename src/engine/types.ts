import type { TrimSegment } from "./trimSegments";
import type { ZoomFragment } from "./zoomMotion";
import type { PerspectiveFragment } from "./perspectiveMotion";
import type { SpeedRange } from "./speedMotion";
import type { BlurRegion } from "./blurRegions";
import type { TextClip } from "./textClips";

export type { TrimSegment, ZoomFragment, PerspectiveFragment };
export type { SpeedRange, BlurRegion };
export type { TextClip };

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PreviewInteraction =
  | {
      mode: "drag";
      element: "facecam";
      startCompX: number;
      startCompY: number;
      startElX: number;
      startElY: number;
      currentCompX: number;
      currentCompY: number;
    }
  | {
      mode: "resize";
      element: "facecam";
      handle: string;
      startCompX: number;
      startCompY: number;
      startElX: number;
      startElY: number;
      startElW: number;
      startElH: number;
      currentElX: number;
      currentElY: number;
      currentElW: number;
      currentElH: number;
    }
  | null;

export type TimelineSnapshot = {
  segments: TrimSegment[];
  zoomFragments: ZoomFragment[];
  perspectiveFragments: PerspectiveFragment[];
  blurRegions: BlurRegion[];
  speedRanges: SpeedRange[];
  textClips: TextClip[];
  globalSpeed: number;
  selectedSegmentId: string | null;
  selectedZoomFragmentId: string | null;
  selectedPerspectiveFragmentId: string | null;
  selectedBlurRegionId: string | null;
  selectedSpeedRangeId: string | null;
  selectedTextClipId: string | null;
  currentTime: number;
};
