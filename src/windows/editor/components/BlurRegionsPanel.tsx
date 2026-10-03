import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import {
  blurRegionIsActive,
  computeCameraTransform,
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

import { cornerHandleOverlayStyle, CROP_HANDLE_SIZE } from "../lib/cropHandles";
import { formatTimelineTime } from "../lib/timelineMath";
import { useEditorStore } from "../store";
import {
  containsPoint,
  hitHandleAt,
  useRectDrag,
  type RectHit,
} from "../lib/useRectDrag";
import type { InspectorCompositionLayout } from "./InspectorCompositionFrame";
import { stageRectFromRegion, regionFromStageRect } from "../lib/blurRegionGeometry";
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

type NormRect = { x: number; y: number; width: number; height: number };

function fullSourceRect(sourceVideoSize: { width: number; height: number } | null, fileAspect?: number) {
  if (sourceVideoSize && sourceVideoSize.width > 0 && sourceVideoSize.height > 0) {
    return sourceVideoSize;
  }
  const aspect = fileAspect && fileAspect > 0 ? fileAspect : 16 / 9;
  return { width: Math.max(1e-3, aspect), height: 1 };
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
        const handle = hitHandleAt(x, y, selectedRect, w, h);
        if (handle) return { key: selected.id, rect: selectedRect, handle };
      }
      const hit = [...visibleRegions]
        .reverse()
        .map((region) => ({
          region,
          rect: stageRectFromRegion(region, sourceSize, composition, camera),
        }))
        .find(({ rect }) => rect && containsPoint(x, y, rect, w, h));
      return hit?.rect
        ? { key: hit.region.id, rect: hit.rect, handle: null }
        : null;
    },
    [camera, composition, selected, sourceSize, visibleRegions],
  );

  const { cursor, handlers } = useRectDrag({
    stageRef,
    disabled,
    pick,
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
            {visibleRegions.map((region) => {
              const rect = stageRectFromRegion(region, sourceSize, composition, camera);
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
                }}
              />
              );
            })}
          </div>
          {selected && stageRectFromRegion(selected, sourceSize, composition, camera) && (
            <div className="pointer-events-none absolute inset-0 z-10">
              {(["nw", "ne", "se", "sw"] as const).map((h) => (
                <div
                  key={h}
                  className="pointer-events-none absolute border-2 border-background bg-primary shadow-[0_0_0_1px_rgba(255,255,255,0.4),0_1px_4px_rgba(0,0,0,0.5)]"
                  style={cornerHandleOverlayStyle(
                    stageRectFromRegion(selected, sourceSize, composition, camera) as NormRect,
                    h,
                    CROP_HANDLE_SIZE,
                  )}
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
