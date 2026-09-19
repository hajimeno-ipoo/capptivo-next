import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import type { ScreenContentCropNorm } from "@/engine";

import { cn } from "@/lib/utils";
import { InspectorVideoPreview } from "./InspectorVideoPreview";

export type InspectorCompositionLayout = {
  stageDimensions: { width: number; height: number };
  recordingRect: { x: number; y: number; width: number; height: number };
  screenContentCrop: ScreenContentCropNorm | null;
  background: string | null;
  cornerRadius: number;
};

type InspectorCompositionFrameProps = InspectorCompositionLayout & {
  videoUrl: string;
  seekTo?: number;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "children">;

/**
 * Inspector stage that uses the same composition coordinate space as the
 * player. The video is placed in the calculated recording rect; overlays
 * supplied by the caller therefore share the player's stage coordinates.
 */
export const InspectorCompositionFrame = forwardRef<
  HTMLDivElement,
  InspectorCompositionFrameProps
>(function InspectorCompositionFrame(
  {
    videoUrl,
    seekTo,
    stageDimensions,
    recordingRect,
    screenContentCrop,
    background,
    cornerRadius,
    children,
    className,
    style,
    ...handlers
  },
  ref,
) {
  const stageWidth = Math.max(1, stageDimensions.width);
  const stageHeight = Math.max(1, stageDimensions.height);
  const stageAspect = stageWidth / stageHeight;
  const recordingWidth = Math.max(1, recordingRect.width);
  const recordingStyle = {
    left: `${(recordingRect.x / stageWidth) * 100}%`,
    top: `${(recordingRect.y / stageHeight) * 100}%`,
    width: `${(recordingRect.width / stageWidth) * 100}%`,
    height: `${(recordingRect.height / stageHeight) * 100}%`,
    borderRadius: `${Math.max(0, Math.min(50, (cornerRadius / recordingWidth) * 100))}%`,
  };
  const videoStyle: React.CSSProperties = screenContentCrop
    ? {
        position: "absolute",
        left: `${(-screenContentCrop.x / screenContentCrop.width) * 100}%`,
        top: `${(-screenContentCrop.y / screenContentCrop.height) * 100}%`,
        width: `${(1 / screenContentCrop.width) * 100}%`,
        height: `${(1 / screenContentCrop.height) * 100}%`,
        maxWidth: "none",
        objectFit: "fill",
      }
    : {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        maxWidth: "none",
        objectFit: "fill",
      };

  return (
    <div
      ref={ref}
      {...handlers}
      className={cn(
        "relative w-full select-none overflow-hidden rounded-lg border border-border bg-muted",
        className,
      )}
      style={{ aspectRatio: stageAspect, touchAction: "none", ...style }}
    >
      <div
        className="absolute inset-0 overflow-hidden bg-black"
        style={{
          backgroundImage: background ? `url("${background}")` : undefined,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        <div className="absolute overflow-hidden" style={recordingStyle}>
          <InspectorVideoPreview src={videoUrl} seekTo={seekTo} style={videoStyle} />
        </div>
      </div>
      {children}
    </div>
  );
});
