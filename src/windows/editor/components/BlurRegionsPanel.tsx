import { useCallback, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  blurRegionIsActive,
  blurRegionPlacement,
  clampBlurRegion,
  contentRectPixelsFromCrop,
  hexColorWithAlpha,
  type BlurRegion,
  type ScreenContentCropNorm,
} from "@/engine";

import { Button } from "@/components/ui/button";
import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/settings";

import { cornerHandleOverlayStyle, CROP_HANDLE_SIZE } from "../lib/cropHandles";
import {
  containsPoint,
  hitHandleAt,
  useRectDrag,
  type RectHit,
} from "../lib/useRectDrag";
import {
  InspectorCompositionFrame,
  type InspectorCompositionLayout,
} from "./InspectorCompositionFrame";

type BlurRegionsPanelProps = {
  videoUrl: string;
  fileAspect?: number;
  duration?: number;
  disabled?: boolean;
  regions: BlurRegion[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onAdd: (kind?: "blur" | "highlight") => void;
  onChange: (id: string, patch: Partial<Omit<BlurRegion, "id">>) => void;
  onRemove: (id: string) => void;
  seekTo?: number;
  className?: string;
  composition: InspectorCompositionLayout;
  sourceVideoSize: { width: number; height: number } | null;
};

type NormRect = { x: number; y: number; width: number; height: number };

function fullSourceRect(sourceVideoSize: { width: number; height: number } | null, fileAspect?: number) {
  if (sourceVideoSize && sourceVideoSize.width > 0 && sourceVideoSize.height > 0) {
    return sourceVideoSize;
  }
  const aspect = fileAspect && fileAspect > 0 ? fileAspect : 16 / 9;
  return { width: Math.max(1e-3, aspect), height: 1 };
}

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

function stageRectFromRegion(
  region: BlurRegion,
  sourceVideoSize: { width: number; height: number },
  composition: InspectorCompositionLayout,
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
    x: placement.dest.x / stageWidth,
    y: placement.dest.y / stageHeight,
    width: placement.dest.width / stageWidth,
    height: placement.dest.height / stageHeight,
  };
}

function regionFromStageRect(
  rect: NormRect,
  current: BlurRegion,
  composition: InspectorCompositionLayout,
  duration: number,
): BlurRegion {
  const stageWidth = Math.max(1, composition.stageDimensions.width);
  const stageHeight = Math.max(1, composition.stageDimensions.height);
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
      x: crop.x + ((rect.x - recordingX) / recordingWidth) * crop.width,
      y: crop.y + ((rect.y - recordingY) / recordingHeight) * crop.height,
      width: (rect.width / recordingWidth) * crop.width,
      height: (rect.height / recordingHeight) * crop.height,
    },
    duration,
  );
}

export function BlurRegionsPanel({
  videoUrl,
  fileAspect,
  duration = 0,
  disabled = false,
  regions,
  selectedId: selectedIdProp,
  onSelect,
  onAdd,
  onChange,
  onRemove,
  seekTo,
  className,
  composition,
  sourceVideoSize,
}: BlurRegionsPanelProps) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);

  const selectedId = selectedIdProp !== undefined ? selectedIdProp : localSelectedId;
  const selected = regions.find((r) => r.id === selectedId) ?? null;
  const sourceSize = fullSourceRect(sourceVideoSize, fileAspect);
  const previewTime = seekTo ?? 0;
  const visibleRegions = regions.filter((region) =>
    blurRegionIsActive(region, previewTime),
  );
  const setSelectedId = (id: string | null) => {
    setLocalSelectedId(id);
    onSelect?.(id);
  };

  const pick = useCallback(
    (x: number, y: number, w: number, h: number): RectHit | null => {
      const selectedRect = selected
        ? stageRectFromRegion(selected, sourceSize, composition)
        : null;
      if (selected && selectedRect) {
        const handle = hitHandleAt(x, y, selectedRect, w, h);
        if (handle) return { key: selected.id, rect: selectedRect, handle };
      }
      const hit = [...visibleRegions]
        .reverse()
        .map((region) => ({
          region,
          rect: stageRectFromRegion(region, sourceSize, composition),
        }))
        .find(({ rect }) => rect && containsPoint(x, y, rect, w, h));
      return hit?.rect
        ? { key: hit.region.id, rect: hit.rect, handle: null }
        : null;
    },
    [composition, selected, sourceSize, visibleRegions],
  );

  const { cursor, handlers } = useRectDrag({
    stageRef,
    disabled,
    pick,
    onPick: setSelectedId,
    onChange: (id, next) => {
      // useRectDrag reports geometry only. Merge it with the selected region
      // before clamping so a geometry edit cannot reset the effect kind or its
      // timeline interval to the legacy defaults.
      const current = regions.find((region) => region.id === id);
      if (!current) return;
      onChange(id, regionFromStageRect(next, current, composition, duration));
    },
  });

  return (
    <div className={cn("space-y-2", className)}>
      <FieldLabelWithHint
        className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
        hint={t("blur.hint")}
      >
        {t("blur.label")}
      </FieldLabelWithHint>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => onAdd("blur")}
        >
          {t("blur.add")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => onAdd("highlight")}
        >
          {t("blur.addHighlight")}
        </Button>
        {selected && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => {
              onRemove(selected.id);
              setSelectedId(null);
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            {t("blur.remove")}
          </Button>
        )}
      </div>

      {regions.length > 0 && (
        <div
          className="relative w-full"
          style={{ cursor }}
        >
          <InspectorCompositionFrame
            ref={stageRef}
            videoUrl={videoUrl}
            seekTo={seekTo}
            {...composition}
            className="border-0"
            {...handlers}
          >
            {visibleRegions.map((region) => {
              const rect = stageRectFromRegion(region, sourceSize, composition);
              if (!rect) return null;
              return (
              <div
                key={region.id}
                className={cn(
                  "pointer-events-none absolute border-2",
                  region.id === selectedId
                    ? "border-primary"
                    : "border-primary/40",
                  region.kind === "highlight" && "border-amber-400",
                )}
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.width * 100}%`,
                  height: `${rect.height * 100}%`,
                  backdropFilter: region.kind === "blur" ? "blur(6px)" : undefined,
                  background:
                    region.kind === "highlight"
                      ? hexColorWithAlpha(region.highlightColor, region.highlightOpacity)
                      : undefined,
                }}
              />
              );
            })}
          </InspectorCompositionFrame>
          {selected && stageRectFromRegion(selected, sourceSize, composition) && (
            <div className="pointer-events-none absolute inset-0 z-10">
              {(["nw", "ne", "se", "sw"] as const).map((h) => (
                <div
                  key={h}
                  className="pointer-events-none absolute border-2 border-background bg-primary shadow-[0_0_0_1px_rgba(255,255,255,0.4),0_1px_4px_rgba(0,0,0,0.5)]"
                  style={cornerHandleOverlayStyle(
                    stageRectFromRegion(selected, sourceSize, composition) as NormRect,
                    h,
                    CROP_HANDLE_SIZE,
                  )}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {selected && duration > 0 ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-2">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{selected.kind === "highlight" ? t("blur.highlight") : t("blur.mask")}</span>
            <span className="tabular-nums">
              {selected.start.toFixed(2)}s – {selected.end.toFixed(2)}s
            </span>
          </div>
          <label className="block text-[11px] text-muted-foreground">
            {t("look.start")}
            <input
              type="range"
              min={0}
              max={Math.max(0, duration - 0.05)}
              step={0.01}
              value={Math.min(selected.start, Math.max(0, duration - 0.05))}
              onChange={(e) => onChange(selected.id, { start: Number(e.target.value) })}
              className="mt-1 w-full"
            />
          </label>
          <label className="block text-[11px] text-muted-foreground">
            {t("look.end")}
            <input
              type="range"
              min={Math.min(duration, selected.start + 0.05)}
              max={duration}
              step={0.01}
              value={selected.end}
              onChange={(e) => onChange(selected.id, { end: Number(e.target.value) })}
              className="mt-1 w-full"
            />
          </label>
          {selected.kind === "highlight" && (
            <>
              <label className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>{t("highlight.color")}</span>
                <input
                  type="color"
                  value={selected.highlightColor}
                  onChange={(e) => onChange(selected.id, { highlightColor: e.target.value })}
                  className="h-7 w-12 cursor-pointer rounded border border-input bg-transparent p-0.5"
                  aria-label={t("highlight.color")}
                />
              </label>
              <label className="block text-[11px] text-muted-foreground">
                <span className="flex items-center justify-between">
                  <span>{t("highlight.opacity")}</span>
                  <span className="tabular-nums">{Math.round(selected.highlightOpacity * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={selected.highlightOpacity}
                  onChange={(e) => onChange(selected.id, { highlightOpacity: Number(e.target.value) })}
                  className="mt-1 w-full"
                  aria-label={t("highlight.opacity")}
                />
              </label>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
