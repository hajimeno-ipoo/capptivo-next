import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import {
  BLUR_REGION_MIN_STRENGTH,
  BLUR_REGION_MAX_STRENGTH,
  normalizeBlurStrength,
  blurRegionIsActive,
  computeCameraTransform,
  findActivePerspectiveFragment,
  perspectiveValuesAtTime,
  type BlurRegion,
} from "@/engine";

import { Button } from "@/components/ui/button";
import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/settings";

import { CROP_HANDLE_SIZE } from "../lib/cropHandles";
import { formatTimelineTime } from "../lib/timelineMath";
import { useEditorStore } from "../store";
import {
  containsPoint,
  useRectDrag,
  type NormRect,
  type RectHit,
} from "../lib/useRectDrag";
import type { InspectorCompositionLayout } from "./InspectorCompositionFrame";
import { stageRectFromRegion, regionFromStageRect, stageQuadFromRect } from "../lib/blurRegionGeometry";
import { createPerspectivePlaneMapping, hasPerspectiveEffect } from "../lib/perspectiveTransform";
import { publishPlaybackTime } from "../lib/playback";
import { getZoomPanAtTime } from "../lib/zoomCache";
import { videoRectToLayoutFrac } from "../lib/composition";
import { resolveZoomReactiveState } from "../render/renderFrame";
import { SCREENSHOT_RENDER_TIME } from "../lib/screenshotStaticTimeline";
import { ClipTimingDisplay } from "./ClipTimingDisplay";

type BlurRegionsPanelProps = {
  fileAspect?: number;
  duration?: number;
  disabled?: boolean;
  regions: BlurRegion[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onSeek?: (time: number) => void;
  onAdd: (kind?: "blur" | "highlight") => void;
  onChange: (id: string, patch: Partial<Omit<BlurRegion, "id">>) => void;
  onRemove: (id: string) => void;
  seekTo?: number;
  className?: string;
  composition: InspectorCompositionLayout;
  sourceVideoSize: { width: number; height: number } | null;
  canvasHost?: HTMLDivElement | null;
};

function fullSourceRect(sourceVideoSize: { width: number; height: number } | null, fileAspect?: number) {
  if (sourceVideoSize && sourceVideoSize.width > 0 && sourceVideoSize.height > 0) {
    return sourceVideoSize;
  }
  const aspect = fileAspect && fileAspect > 0 ? fileAspect : 16 / 9;
  return { width: Math.max(1e-3, aspect), height: 1 };
}

function cornerIsVisible(rect: NormRect, corner: string, clipToStage: boolean): boolean {
  if (!clipToStage) return true;
  const x = rect.x + (corner.includes("e") ? rect.width : 0);
  const y = rect.y + (corner.includes("s") ? rect.height : 0);
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

export function BlurRegionsPanel({
  fileAspect,
  duration = 0,
  disabled = false,
  regions,
  selectedId: selectedIdProp,
  onSelect,
  onSeek,
  onAdd,
  onChange,
  onRemove,
  seekTo,
  className,
  composition,
  sourceVideoSize,
  canvasHost,
}: BlurRegionsPanelProps) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const [localKind, setLocalKind] = useState<"blur" | "highlight">("blur");

  const selectedId = selectedIdProp !== undefined ? selectedIdProp : localSelectedId;
  const selected = regions.find((r) => r.id === selectedId) ?? null;
  const activeKind = selected?.kind ?? localKind;
  const activeRegions = regions
    .filter((region) => region.kind === activeKind)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  const sourceSize = fullSourceRect(sourceVideoSize, fileAspect);
  const currentTime = useEditorStore((s) => s.currentTime);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const [frameTime, setFrameTime] = useState(currentTime);
  useEffect(() => {
    if (!canvasHost) return;
    const onFrame = (event: Event) => setFrameTime((event as CustomEvent<number>).detail);
    canvasHost.addEventListener("preview-frame-time", onFrame);
    return () => canvasHost.removeEventListener("preview-frame-time", onFrame);
  }, [canvasHost]);
  const isScreenshot = useEditorStore((s) => s.screenshotId !== null);
  const zoomFragments = useEditorStore((s) => s.zoomFragments);
  const perspectiveFragments = useEditorStore((s) => s.perspectiveFragments);
  const recordingMetadata = useEditorStore((s) => s.recordingMetadata);
  const previewTime = isScreenshot
    ? SCREENSHOT_RENDER_TIME
    : isPlaying ? frameTime : seekTo ?? currentTime;
  const zoom = getZoomPanAtTime(
    zoomFragments, recordingMetadata, composition.screenContentCrop, previewTime,
    { video: videoRectToLayoutFrac(
      composition.recordingRect, composition.stageDimensions.width, composition.stageDimensions.height,
    ) },
  );
  const activeZoom = zoomFragments.find((f) => previewTime >= f.start && previewTime <= f.end) ?? null;
  const camera = computeCameraTransform({
    stageWidth: composition.stageDimensions.width,
    stageHeight: composition.stageDimensions.height,
    videoRect: composition.recordingRect,
    focus: zoom,
    scale: zoom.scale,
    targetScale: resolveZoomReactiveState(activeZoom, previewTime).zoomTargetScale,
  });
  const perspective = perspectiveValuesAtTime(findActivePerspectiveFragment(perspectiveFragments, previewTime), previewTime);
  const clipToStage = hasPerspectiveEffect(perspective);
  const mapping = createPerspectivePlaneMapping(
    composition.stageDimensions.width,
    composition.stageDimensions.height,
    perspective,
  );
  const visibleRegions = regions.filter((region) =>
    blurRegionIsActive(region, previewTime),
  );
  const setSelectedId = (id: string | null) => {
    setLocalSelectedId(id);
    onSelect?.(id);
  };
  const showKind = (kind: "blur" | "highlight") => {
    setLocalKind(kind);
    setSelectedId(regions.find((region) => region.kind === kind)?.id ?? null);
  };
  const selectRegion = (id: string) => {
    const region = activeRegions.find((candidate) => candidate.id === id);
    if (!region) return;
    const { isPlaying, setPlaying } = useEditorStore.getState();
    if (isPlaying) setPlaying(false);
    setSelectedId(id);
    onSeek?.(region.start);
  };

  const pick = useCallback(
    (x: number, y: number, w: number, h: number): RectHit | null => {
      const selectedRect = selected
        ? stageRectFromRegion(selected, sourceSize, composition, camera)
        : null;
      if (selected && selectedRect) {
        const quad = stageQuadFromRect(selectedRect, mapping);
        if (quad) {
          const handle = (["nw", "ne", "se", "sw"] as const).find((corner) =>
            cornerIsVisible(selectedRect, corner, clipToStage) &&
            Math.abs(x - quad[corner].x * w) <= CROP_HANDLE_SIZE / 2 &&
            Math.abs(y - quad[corner].y * h) <= CROP_HANDLE_SIZE / 2,
          );
          if (handle) return { key: selected.id, rect: selectedRect, handle };
        }
      }
      const point = mapping?.unproject({ x: x / w, y: y / h });
      if (!point) return null;
      if (clipToStage && (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) return null;
      const hit = [...visibleRegions]
        .reverse()
        .map((region) => ({
          region,
          rect: stageRectFromRegion(region, sourceSize, composition, camera),
        }))
        .find(({ rect }) => rect && containsPoint(point.x * w, point.y * h, rect, w, h));
      return hit?.rect
        ? { key: hit.region.id, rect: hit.rect, handle: null }
        : null;
    },
    [camera, clipToStage, composition, mapping, selected, sourceSize, visibleRegions],
  );

  const { cursor, handlers } = useRectDrag({
    stageRef,
    disabled,
    pick,
    mapPointer: (x, y, w, h) => {
      const point = mapping?.unproject({ x: x / w, y: y / h });
      return point ? { x: point.x * w, y: point.y * h } : null;
    },
    onPick: (id) => {
      if (id && useEditorStore.getState().isPlaying) {
        useEditorStore.getState().setPlaying(false);
        publishPlaybackTime(previewTime, { force: true });
      }
      setSelectedId(id);
    },
    onChange: (id, next) => {
      // useRectDrag reports geometry only. Merge it with the selected region
      // before clamping so a geometry edit cannot reset the effect kind or its
      // timeline interval to the legacy defaults.
      const current = regions.find((region) => region.id === id);
      if (!current) return;
      onChange(id, regionFromStageRect(next, current, composition, duration, camera));
    },
  });

  const selectedRect = selected
    ? stageRectFromRegion(selected, sourceSize, composition, camera)
    : null;
  const selectedQuad = selectedRect ? stageQuadFromRect(selectedRect, mapping) : null;

  return (
    <div className={cn("space-y-2", className)}>
      <FieldLabelWithHint
        className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
        hint={t("blur.hint")}
      >
        {t("blur.label")}
      </FieldLabelWithHint>

      <div className="inline-flex items-center rounded-xl bg-muted p-1" role="group" aria-label={t("blur.label")}>
        {(["blur", "highlight"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={activeKind === kind}
            onClick={() => showKind(kind)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              activeKind === kind
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(kind === "blur" ? "blur.mask" : "blur.highlight")}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        <Label htmlFor="inspector-blur-fragment" className="text-muted-foreground">
          {t("clip.fragment.label")}
        </Label>
        <Select
          value={selected && selected.kind === activeKind ? selected.id : undefined}
          onValueChange={selectRegion}
          disabled={activeRegions.length === 0}
        >
          <SelectTrigger id="inspector-blur-fragment" className="h-9 w-full">
            <SelectValue placeholder={t("clip.fragment.placeholder")} />
          </SelectTrigger>
          <SelectContent>
            {activeRegions.map((region, index) => (
              <SelectItem key={region.id} value={region.id}
                onPointerUp={() => { if (selectedId === region.id) selectRegion(region.id); }}
                onKeyDown={(event) => { if (event.key === "Enter" && selectedId === region.id) selectRegion(region.id); }}>
                {`${index + 1}. ${formatTimelineTime(region.start)} – ${formatTimelineTime(region.end)}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => onAdd(activeKind)}
        >
          {t(activeKind === "blur" ? "blur.add" : "blur.addHighlight")}
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

      {/* The compositor already draws the effects; this layer only handles selection. */}
      {regions.length > 0 && canvasHost && createPortal(
        <div
          className="pointer-events-auto absolute inset-0 overflow-hidden"
          style={{ cursor }}
        >
          <div
            ref={stageRef}
            className="relative h-full w-full touch-none select-none"
            {...handlers}
          >
            <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {visibleRegions.map((region) => {
              const rect = stageRectFromRegion(region, sourceSize, composition, camera);
              const quad = rect ? stageQuadFromRect(rect, mapping, clipToStage) : null;
              if (!quad) return null;
              return (
              <polygon
                key={region.id}
                className={cn(
                  "fill-none",
                  region.id === selectedId
                    ? "stroke-primary"
                    : "stroke-primary/40",
                  region.kind === "highlight" && "stroke-amber-400",
                )}
                points={Object.values(quad).map((point) => `${point.x * 100},${point.y * 100}`).join(" ")}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
              );
            })}
            </svg>
          </div>
          {selectedQuad && (
            <div className="pointer-events-none absolute inset-0 z-10">
              {(["nw", "ne", "se", "sw"] as const).filter((h) => selectedRect && cornerIsVisible(selectedRect, h, clipToStage)).map((h) => (
                <div
                  key={h}
                  className="pointer-events-none absolute border-2 border-background bg-primary shadow-[0_0_0_1px_rgba(255,255,255,0.4),0_1px_4px_rgba(0,0,0,0.5)]"
                  style={{
                    left: `${selectedQuad[h].x * 100}%`,
                    top: `${selectedQuad[h].y * 100}%`,
                    width: CROP_HANDLE_SIZE,
                    height: CROP_HANDLE_SIZE,
                    transform: "translate(-50%, -50%)",
                  }}
                />
              ))}
            </div>
          )}
        </div>, canvasHost
      )}
      {selected && duration > 0 ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-2">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{selected.kind === "highlight" ? t("blur.highlight") : t("blur.mask")}</span>
          </div>
          <ClipTimingDisplay start={selected.start} end={selected.end} />
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
          {selected.kind !== "highlight" && (
            <label className="block text-[11px] text-muted-foreground">
              <span className="flex items-center justify-between">
                <span>{t("blur.strength")}</span>
                <span className="tabular-nums">{normalizeBlurStrength(selected.blurStrength)}</span>
              </span>
              <input
                type="range"
                min={BLUR_REGION_MIN_STRENGTH}
                max={BLUR_REGION_MAX_STRENGTH}
                step={1}
                value={normalizeBlurStrength(selected.blurStrength)}
                onChange={(e) => onChange(selected.id, { blurStrength: Number(e.target.value) })}
                className="mt-1 w-full"
                aria-label={t("blur.strength")}
              />
            </label>
          )}
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
