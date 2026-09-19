/**
 * Timeline under the preview — kept clips, zoom, 3D, masks/highlights, and speed ranges.
 * Pointer drags update the store; playhead seeks source time. The playhead itself
 * is DOM-driven from the source `<video>` so play ticks never reconcile this tree.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Plus,
  Box,
  Focus,
  Gauge,
  RectangleHorizontal,
  Redo2,
  RotateCcw,
  Scissors,
  Shield,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
} from "lucide-react";
import { computeTrimGaps } from "@/engine";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/settings";
import type { TranslationKey } from "@/lib/i18n";

import { cn } from "../lib/cn";
import { ASPECT_RATIO_PRESETS, type AspectRatioPresetId } from "../lib/composition";
import { formatTimelineTime, MIN_SEGMENT_LENGTH } from "../lib/timelineMath";
import { buildTimelineRuler } from "../lib/timelineRuler";
import { useEditorStore } from "../store";
import { VideoTimelineBlock } from "./VideoTimelineBlock";
import { ZoomTimelineBlock } from "./ZoomTimelineBlock";
import { PerspectiveTimelineBlock } from "./PerspectiveTimelineBlock";
import { OverlayTimelineBlock } from "./OverlayTimelineBlock";
import { SpeedTimelineBlock } from "./SpeedTimelineBlock";
import { TextTimelineBlock } from "./TextTimelineBlock";

/** Per-preset hint copy shown in the ratio dropdown ("YouTube / Desktop", …). */
const RATIO_HINT_KEY: Record<AspectRatioPresetId, TranslationKey> = {
  recording: "ratio.hint.recording",
  "16:9": "ratio.hint.16:9",
  "16:10": "ratio.hint.16:10",
  "9:16": "ratio.hint.9:16",
  "4:3": "ratio.hint.4:3",
  "3:4": "ratio.hint.3:4",
  "1:1": "ratio.hint.1:1",
  "4:5": "ratio.hint.4:5",
  "5:4": "ratio.hint.5:4",
  "21:9": "ratio.hint.21:9",
  "9:21": "ratio.hint.9:21",
};

const RULER_H = 28;
const LANE_H = 44;
const BLOCK_INSET = 4;
const BLOCK_H = LANE_H - BLOCK_INSET * 2;
const CLIP_TOP = RULER_H;
const ZOOM_TOP = RULER_H + LANE_H;
const PERSPECTIVE_TOP = RULER_H + LANE_H * 2;
const MASK_TOP = RULER_H + LANE_H * 3;
const HIGHLIGHT_TOP = RULER_H + LANE_H * 4;
const SPEED_TOP = RULER_H + LANE_H * 5;
const TEXT_TOP = RULER_H + LANE_H * 6;
const TRACK_H = RULER_H + LANE_H * 7;
const CLICK_DRAG_PX = 3;

/**
 * Zoom is a multiplier over "fit to the visible width": at MIN the whole
 * recording fits (no scroll); at MAX one second spans many pixels. Track width
 * is simply `containerWidth * zoom`, so positions stay percentage-based.
 */
const MIN_ZOOM = 1;
const MAX_ZOOM = 60;
/** Per-click factor for the −/+ buttons. */
const ZOOM_STEP = 1.6;
/** Trackpad-pinch / ⌘-scroll sensitivity (wheel delta → zoom factor). */
const ZOOM_WHEEL_SENSITIVITY = 0.0025;

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
/** Logarithmic slider mapping so low zooms get more of the travel. */
const zoomToSlider = (zoom: number): number => Math.log(zoom / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM);
const sliderToZoom = (t: number): number => MIN_ZOOM * (MAX_ZOOM / MIN_ZOOM) ** t;

type DragState =
  | { kind: "playhead" }
  | { kind: "gap-move"; gapIndex: number; offset: number; length: number; startX: number }
  | { kind: "gap-edge"; gapIndex: number; edge: "start" | "end" }
  | { kind: "segment-edge"; segmentId: string; edge: "start" | "end" }
  | {
      kind: "zoom-move";
      fragmentId: string;
      offset: number;
      length: number;
      startX: number;
    }
  | { kind: "zoom-edge"; fragmentId: string; edge: "start" | "end" }
  | {
      kind: "perspective-move";
      fragmentId: string;
      offset: number;
      length: number;
      startX: number;
    }
  | { kind: "perspective-edge"; fragmentId: string; edge: "start" | "end" }
  | {
      kind: "overlay-move";
      regionId: string;
      offset: number;
      length: number;
      startX: number;
    }
  | { kind: "overlay-edge"; regionId: string; edge: "start" | "end" }
  | {
      kind: "speed-move";
      rangeId: string;
      offset: number;
      length: number;
      startX: number;
    }
  | { kind: "speed-edge"; rangeId: string; edge: "start" | "end" }
  | {
      kind: "text-move";
      clipId: string;
      offset: number;
      length: number;
      startX: number;
    }
  | { kind: "text-edge"; clipId: string; edge: "start" | "end" };

export function Timeline({
  onSeek,
  videoRef,
}: {
  /** Seek the hidden source video to source-time `t`. */
  onSeek: (t: number) => void;
  /** Source element — playhead tracks `currentTime` via DOM, not React state. */
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const { t } = useI18n();
  const duration = useEditorStore((s) => s.duration);
  const segments = useEditorStore((s) => s.segments);
  const zoomFragments = useEditorStore((s) => s.zoomFragments);
  const perspectiveFragments = useEditorStore((s) => s.perspectiveFragments);
  const blurRegions = useEditorStore((s) => s.blurRegions);
  const speedRanges = useEditorStore((s) => s.speedRanges);
  const textClips = useEditorStore((s) => s.textClips);
  const selectedGapIndex = useEditorStore((s) => s.selectedGapIndex);
  const selectedSegmentId = useEditorStore((s) => s.selectedSegmentId);
  const selectedZoomFragmentId = useEditorStore((s) => s.selectedZoomFragmentId);
  const selectedPerspectiveFragmentId = useEditorStore(
    (s) => s.selectedPerspectiveFragmentId,
  );
  const selectedBlurRegionId = useEditorStore((s) => s.selectedBlurRegionId);
  const selectedSpeedRangeId = useEditorStore((s) => s.selectedSpeedRangeId);
  const selectedTextClipId = useEditorStore((s) => s.selectedTextClipId);
  const historyPast = useEditorStore((s) => s.historyPast);
  const historyFuture = useEditorStore((s) => s.historyFuture);

  const addFragment = useEditorStore((s) => s.addFragment);
  const deleteSelected = useEditorStore((s) => s.deleteSelected);
  const restoreTrimGap = useEditorStore((s) => s.restoreTrimGap);
  const moveTrimGap = useEditorStore((s) => s.moveTrimGap);
  const resizeTrimGap = useEditorStore((s) => s.resizeTrimGap);
  const resizeSegment = useEditorStore((s) => s.resizeSegment);
  const moveZoomFragment = useEditorStore((s) => s.moveZoomFragment);
  const movePerspectiveFragment = useEditorStore((s) => s.movePerspectiveFragment);
  const moveBlurRegion = useEditorStore((s) => s.moveBlurRegion);
  const moveSpeedRange = useEditorStore((s) => s.moveSpeedRange);
  const moveTextClip = useEditorStore((s) => s.moveTextClip);
  const selectGap = useEditorStore((s) => s.selectGap);
  const selectZoomFragment = useEditorStore((s) => s.selectZoomFragment);
  const selectPerspectiveFragment = useEditorStore(
    (s) => s.selectPerspectiveFragment,
  );
  const selectBlurRegion = useEditorStore((s) => s.selectBlurRegion);
  const selectSpeedRange = useEditorStore((s) => s.selectSpeedRange);
  const selectTextClip = useEditorStore((s) => s.selectTextClip);
  const selectSegment = useEditorStore((s) => s.selectSegment);
  const cutAtPlayhead = useEditorStore((s) => s.cutAtPlayhead);
  const splitAt = useEditorStore((s) => s.splitAt);
  const beginTimelineEdit = useEditorStore((s) => s.beginTimelineEdit);
  const endTimelineEdit = useEditorStore((s) => s.endTimelineEdit);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const resetTimeline = useEditorStore((s) => s.resetTimeline);
  const aspectRatioPresetId = useEditorStore((s) => s.aspectRatioPresetId);
  const backgroundType = useEditorStore((s) => s.backgroundType);
  const setAspectRatioPreset = useEditorStore((s) => s.setAspectRatioPreset);
  const aspectRatioPresets = useMemo(
    () =>
      ASPECT_RATIO_PRESETS.filter(
        (preset) => preset.id !== "recording" || backgroundType !== "image",
      ),
    [backgroundType],
  );
  const activeRatioPreset =
    aspectRatioPresets.find((p) => p.id === aspectRatioPresetId) ??
    ASPECT_RATIO_PRESETS.find((p) => p.id === aspectRatioPresetId) ??
    ASPECT_RATIO_PRESETS[0];

  const [uiZoom, setUiZoom] = useState(MIN_ZOOM);
  const [containerWidth, setContainerWidth] = useState(0);
  const [splitTool, setSplitTool] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const committedZoomRef = useRef(MIN_ZOOM);
  const targetZoomRef = useRef(MIN_ZOOM);
  const pendingScrollRef = useRef<number | null>(null);

  const safeDuration = duration > 0 ? duration : 1;
  const ready = duration > 0;
  const trackWidth = Math.max(1, Math.round(containerWidth * uiZoom));

  /** Set an absolute zoom, keeping the time under `anchorClientX` (or the
   *  viewport centre) pinned. Anchor math uses the committed layout, so it stays
   *  correct even when several wheel events land in one frame. */
  const zoomToValue = useCallback((nextZoomRaw: number, anchorClientX?: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const width = el.clientWidth;
    if (width <= 0) return;
    const nextZoom = clampZoom(nextZoomRaw);
    const oldZoom = committedZoomRef.current;
    const rect = el.getBoundingClientRect();
    const anchorX = anchorClientX != null ? anchorClientX - rect.left : width / 2;
    const contentFraction = (el.scrollLeft + anchorX) / (width * oldZoom);
    targetZoomRef.current = nextZoom;
    const nextTrackWidth = width * nextZoom;
    pendingScrollRef.current = Math.max(
      0,
      Math.min(contentFraction * nextTrackWidth - anchorX, nextTrackWidth - width),
    );
    setUiZoom(nextZoom);
  }, []);

  const zoomBy = useCallback((factor: number) => zoomToValue(targetZoomRef.current * factor), [zoomToValue]);

  useLayoutEffect(() => {
    committedZoomRef.current = uiZoom;
    const el = scrollRef.current;
    if (el && pendingScrollRef.current != null) {
      el.scrollLeft = pendingScrollRef.current;
      pendingScrollRef.current = null;
    }
  }, [uiZoom, containerWidth]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setContainerWidth(width);
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomToValue(targetZoomRef.current * Math.exp(-e.deltaY * ZOOM_WHEEL_SENSITIVITY), e.clientX);
        return;
      }
      if (el.scrollWidth <= el.clientWidth) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 0.5) return;
      e.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ready, zoomToValue]);

  const gaps = useMemo(
    () => computeTrimGaps(segments, safeDuration),
    [segments, safeDuration],
  );

  const clientToTime = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || duration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const x = Math.min(Math.max(0, clientX - rect.left), rect.width);
      return (x / rect.width) * duration;
    },
    [duration],
  );

  const selectedExists =
    selectedGapIndex !== null ||
    (!!selectedSegmentId && segments.some((segment) => segment.id === selectedSegmentId)) ||
    (!!selectedZoomFragmentId &&
      zoomFragments.some((f) => f.id === selectedZoomFragmentId)) ||
    (!!selectedPerspectiveFragmentId &&
      perspectiveFragments.some((f) => f.id === selectedPerspectiveFragmentId)) ||
    (!!selectedBlurRegionId && blurRegions.some((region) => region.id === selectedBlurRegionId)) ||
    (!!selectedSpeedRangeId && speedRanges.some((range) => range.id === selectedSpeedRangeId)) ||
    (!!selectedTextClipId && textClips.some((clip) => clip.id === selectedTextClipId));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "Escape") {
        setSplitTool(false);
        setAddOpen(false);
        return;
      }
      if (e.key === "z" || e.key === "Z") {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        addFragment("zoom");
        return;
      }
      if (!e.metaKey && !e.ctrlKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        cutAtPlayhead();
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        if (selectedExists) {
          e.preventDefault();
          deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addFragment, cutAtPlayhead, deleteSelected, redo, selectedExists, undo]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const active = dragRef.current;
      if (!active) return;
      const t = clientToTime(e.clientX);

      if (active.kind === "playhead") {
        onSeek(t);
        return;
      }
      if (active.kind === "gap-edge") {
        resizeTrimGap(active.gapIndex, active.edge, t);
        return;
      }
      if (active.kind === "segment-edge") {
        resizeSegment(active.segmentId, active.edge, t);
        return;
      }
      if (active.kind === "gap-move") {
        if (Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX) return;
        let nextStart = t - active.offset;
        let nextEnd = nextStart + active.length;
        if (nextStart < 0) {
          nextEnd -= nextStart;
          nextStart = 0;
        }
        if (nextEnd > duration) {
          const over = nextEnd - duration;
          nextStart = Math.max(0, nextStart - over);
          nextEnd = duration;
        }
        moveTrimGap(active.gapIndex, nextStart, nextEnd);
        return;
      }
      if (active.kind === "zoom-edge") {
        const frag = zoomFragments.find((f) => f.id === active.fragmentId);
        if (!frag) return;
        if (active.edge === "start") {
          moveZoomFragment(frag.id, t, frag.end);
        } else {
          moveZoomFragment(frag.id, frag.start, t);
        }
        return;
      }
      if (active.kind === "zoom-move") {
        if (Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX) return;
        let nextStart = t - active.offset;
        let nextEnd = nextStart + active.length;
        if (nextStart < 0) {
          nextEnd -= nextStart;
          nextStart = 0;
        }
        if (nextEnd > duration) {
          const over = nextEnd - duration;
          nextStart = Math.max(0, nextStart - over);
          nextEnd = duration;
        }
        moveZoomFragment(active.fragmentId, nextStart, nextEnd);
        return;
      }
      if (active.kind === "perspective-edge") {
        const fragment = perspectiveFragments.find((f) => f.id === active.fragmentId);
        if (!fragment) return;
        if (active.edge === "start") {
          movePerspectiveFragment(fragment.id, t, fragment.end);
        } else {
          movePerspectiveFragment(fragment.id, fragment.start, t);
        }
        return;
      }
      if (active.kind === "perspective-move") {
        if (Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX) return;
        let nextStart = t - active.offset;
        let nextEnd = nextStart + active.length;
        if (nextStart < 0) {
          nextEnd -= nextStart;
          nextStart = 0;
        }
        if (nextEnd > duration) {
          const over = nextEnd - duration;
          nextStart = Math.max(0, nextStart - over);
          nextEnd = duration;
        }
        movePerspectiveFragment(active.fragmentId, nextStart, nextEnd);
        return;
      }
      if (active.kind === "overlay-edge") {
        const region = blurRegions.find((candidate) => candidate.id === active.regionId);
        if (!region) return;
        if (active.edge === "start") moveBlurRegion(region.id, t, region.end);
        else moveBlurRegion(region.id, region.start, t);
        return;
      }
      if (active.kind === "overlay-move") {
        if (Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX) return;
        let nextStart = t - active.offset;
        let nextEnd = nextStart + active.length;
        if (nextStart < 0) {
          nextEnd -= nextStart;
          nextStart = 0;
        }
        if (nextEnd > duration) {
          const over = nextEnd - duration;
          nextStart = Math.max(0, nextStart - over);
          nextEnd = duration;
        }
        moveBlurRegion(active.regionId, nextStart, nextEnd);
        return;
      }
      if (active.kind === "speed-edge") {
        const range = speedRanges.find((candidate) => candidate.id === active.rangeId);
        if (!range) return;
        if (active.edge === "start") moveSpeedRange(range.id, t, range.end);
        else moveSpeedRange(range.id, range.start, t);
        return;
      }
      if (active.kind === "speed-move") {
        if (Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX) return;
        let nextStart = t - active.offset;
        let nextEnd = nextStart + active.length;
        if (nextStart < 0) {
          nextEnd -= nextStart;
          nextStart = 0;
        }
        if (nextEnd > duration) {
          const over = nextEnd - duration;
          nextStart = Math.max(0, nextStart - over);
          nextEnd = duration;
        }
        moveSpeedRange(active.rangeId, nextStart, nextEnd);
        return;
      }
      if (active.kind === "text-edge") {
        const clip = textClips.find((candidate) => candidate.id === active.clipId);
        if (!clip) return;
        if (active.edge === "start") moveTextClip(clip.id, t, clip.end);
        else moveTextClip(clip.id, clip.start, t);
        return;
      }
      if (active.kind === "text-move") {
        if (Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX) return;
        let nextStart = t - active.offset;
        let nextEnd = nextStart + active.length;
        if (nextStart < 0) {
          nextEnd -= nextStart;
          nextStart = 0;
        }
        if (nextEnd > duration) {
          const over = nextEnd - duration;
          nextStart = Math.max(0, nextStart - over);
          nextEnd = duration;
        }
        moveTextClip(active.clipId, nextStart, nextEnd);
      }
    },
    [
      clientToTime,
      duration,
      moveTrimGap,
      moveZoomFragment,
      movePerspectiveFragment,
      onSeek,
      resizeSegment,
      resizeTrimGap,
      zoomFragments,
      perspectiveFragments,
      blurRegions,
      speedRanges,
      textClips,
      moveBlurRegion,
      moveSpeedRange,
      moveTextClip,
    ],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const active = dragRef.current;
      dragRef.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);

      if (!active) return;

      if (active.kind === "gap-move" && Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX) {
        selectGap(active.gapIndex);
        endTimelineEdit();
        return;
      }
      if (active.kind === "zoom-move" && Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX) {
        selectZoomFragment(active.fragmentId);
        endTimelineEdit();
        return;
      }
      if (
        active.kind === "perspective-move" &&
        Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX
      ) {
        selectPerspectiveFragment(active.fragmentId);
        endTimelineEdit();
        return;
      }
      if (active.kind === "overlay-move" && Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX) {
        selectBlurRegion(active.regionId);
        endTimelineEdit();
        return;
      }
      if (active.kind === "speed-move" && Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX) {
        selectSpeedRange(active.rangeId);
        endTimelineEdit();
        return;
      }
      if (active.kind === "text-move" && Math.abs(e.clientX - active.startX) < CLICK_DRAG_PX) {
        selectTextClip(active.clipId);
        endTimelineEdit();
        return;
      }
      if (active.kind !== "playhead") endTimelineEdit();
    },
    [
      endTimelineEdit,
      selectBlurRegion,
      selectGap,
      selectPerspectiveFragment,
      selectSpeedRange,
      selectTextClip,
      selectZoomFragment,
    ],
  );

  const startDrag = (e: React.PointerEvent, state: DragState) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = state;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (state.kind !== "playhead") {
      beginTimelineEdit();
      return;
    }
    // Moving the playhead means "take me here and let me look at it". Landing
    // it in a running preview leaves the frame that was asked for already gone
    // by the time it draws, so stop before the seek rather than after it.
    const { isPlaying, setPlaying } = useEditorStore.getState();
    if (isPlaying) setPlaying(false);
  };

  const onTrackClick = (e: React.MouseEvent) => {
    const t = clientToTime(e.clientX);

    if (splitTool) {
      const rect = trackRef.current?.getBoundingClientRect();
      const laneY = rect ? e.clientY - rect.top : CLIP_TOP;
      if (laneY < CLIP_TOP) return;

      if (laneY >= CLIP_TOP && laneY < ZOOM_TOP) {
        if (splitAt({ kind: "trim", time: t })) setSplitTool(false);
        return;
      }

      if (laneY >= ZOOM_TOP && laneY < PERSPECTIVE_TOP) {
        const zoomHit = zoomFragments.find((f) => t >= f.start && t <= f.end);
        if (zoomHit && splitAt({ kind: "zoom", fragmentId: zoomHit.id, time: t })) {
          setSplitTool(false);
        }
        return;
      }

      if (laneY >= PERSPECTIVE_TOP && laneY < MASK_TOP) {
        const perspectiveHit = perspectiveFragments.find(
          (fragment) => t >= fragment.start && t <= fragment.end,
        );
        if (
          perspectiveHit &&
          splitAt({ kind: "perspective", fragmentId: perspectiveHit.id, time: t })
        ) {
          setSplitTool(false);
        }
        return;
      }

      if (laneY >= MASK_TOP && laneY < HIGHLIGHT_TOP) {
        const maskHit = blurRegions.find(
          (region) => region.kind === "blur" && t >= region.start && t <= region.end,
        );
        if (maskHit && splitAt({ kind: "overlay", fragmentId: maskHit.id, time: t })) {
          setSplitTool(false);
        }
        return;
      }

      if (laneY >= HIGHLIGHT_TOP && laneY < SPEED_TOP) {
        const highlightHit = blurRegions.find(
          (region) => region.kind === "highlight" && t >= region.start && t <= region.end,
        );
        if (
          highlightHit &&
          splitAt({ kind: "overlay", fragmentId: highlightHit.id, time: t })
        ) {
          setSplitTool(false);
        }
        return;
      }
      if (laneY >= SPEED_TOP && laneY < TEXT_TOP) {
        const speedHit = speedRanges.find((range) => t >= range.start && t <= range.end);
        if (speedHit && splitAt({ kind: "speed", fragmentId: speedHit.id, time: t })) {
          setSplitTool(false);
        }
        return;
      }
      if (laneY >= TEXT_TOP && laneY < TRACK_H) {
        const textHit = textClips.find((clip) => t >= clip.start && t <= clip.end);
        if (textHit && splitAt({ kind: "text", fragmentId: textHit.id, time: t })) {
          setSplitTool(false);
        }
        return;
      }

      return;
    }

    selectGap(null);
    selectZoomFragment(null);
    selectPerspectiveFragment(null);
    selectBlurRegion(null);
    selectSpeedRange(null);
    selectTextClip(null);
    selectSegment(null);
    onSeek(t);
  };

  // Playhead is DOM-driven — no React reconcile on every media tick.
  useLayoutEffect(() => {
    const apply = (time: number) => {
      const el = playheadRef.current;
      if (!el) return;
      const pct = Math.min(100, Math.max(0, (time / safeDuration) * 100));
      el.style.transform = `translate3d(${pct}%, 0, 0)`;
    };

    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      if (useEditorStore.getState().isPlaying && video) {
        apply(video.currentTime);
        raf = requestAnimationFrame(tick);
        return;
      }
      raf = 0;
      apply(useEditorStore.getState().currentTime);
    };

    apply(useEditorStore.getState().currentTime);
    if (useEditorStore.getState().isPlaying) raf = requestAnimationFrame(tick);

    const unsub = useEditorStore.subscribe((state, prev) => {
      if (state.isPlaying && !prev.isPlaying) {
        if (!raf) raf = requestAnimationFrame(tick);
        return;
      }
      if (!state.isPlaying) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        if (state.currentTime !== prev.currentTime || prev.isPlaying) {
          apply(state.currentTime);
        }
      }
    });

    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [safeDuration, videoRef]);

  const pixelsPerSecond = trackWidth / safeDuration;
  const rulerTicks = useMemo(
    () => buildTimelineRuler(safeDuration, pixelsPerSecond),
    [safeDuration, pixelsPerSecond],
  );

  if (duration <= 0) {
    return (
      <div className="flex h-40 w-full flex-col items-center justify-center border-t border-border bg-card p-6 text-sm text-muted-foreground">
        {t("timeline.loading")}
      </div>
    );
  }

  const canUndo = historyPast.length > 0;
  const canRedo = historyFuture.length > 0;

  return (
    <div className="flex w-full min-w-0 flex-col overflow-x-hidden border-t border-border bg-card select-none">
      <div className="flex shrink-0 items-center gap-3 overflow-x-auto p-4">
        <div className="flex h-9 shrink-0 items-center rounded-lg border border-border bg-muted">
          <DropdownMenu open={addOpen} onOpenChange={setAddOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 gap-2 rounded-lg px-4 font-medium shadow-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 data-[state=open]:bg-foreground/5 data-[state=open]:ring-0"
              >
                <Plus className="size-4 text-muted-foreground" strokeWidth={2.5} />
                {t("timeline.addFragment")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuItem onClick={() => addFragment("zoom")}>
                <ZoomIn className="size-4 text-muted-foreground" />
                {t("timeline.zoom")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addFragment("perspective")}>
                <Box className="size-4 text-muted-foreground" />
                {t("look.threeD")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addFragment("mask")}>
                <Shield className="size-4 text-muted-foreground" />
                {t("blur.mask")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addFragment("highlight")}>
                <Focus className="size-4 text-muted-foreground" />
                {t("blur.highlight")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addFragment("speed")}>
                <Gauge className="size-4 text-muted-foreground" />
                {t("speed.addRange")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => addFragment("text")}>
                <Type className="size-4 text-muted-foreground" />
                {t("text.add")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={cutAtPlayhead}>
                <Scissors className="size-4 text-muted-foreground" />
                {t("timeline.cut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex h-9 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-muted">
          <button
            type="button"
            aria-pressed={splitTool}
            title={splitTool ? t("timeline.split.on") : t("timeline.split.off")}
            onClick={() => setSplitTool((v) => !v)}
            disabled={duration <= 0}
            className={cn(
              "flex h-full items-center justify-center border-r border-border px-3.5 transition-colors",
              splitTool
                ? "bg-background text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
              duration <= 0 && "cursor-not-allowed text-muted-foreground/40 hover:bg-transparent",
            )}
          >
            <Scissors className="size-4.5" strokeWidth={2} />
          </button>
          <button
            type="button"
            disabled={!selectedExists}
            onClick={() => {
              if (selectedGapIndex !== null) {
                const gap = gaps[selectedGapIndex];
                if (gap) restoreTrimGap(gap.start, gap.end);
                return;
              }
              deleteSelected();
            }}
            className="flex h-full items-center justify-center px-3.5 text-muted-foreground transition-colors hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={t("timeline.deleteSelected")}
          >
            <Trash2 className="size-4.5" strokeWidth={2} />
          </button>
        </div>

        <div className="flex h-9 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-muted">
          <button
            type="button"
            disabled={!canUndo}
            onClick={undo}
            className={cn(
              "flex h-full items-center justify-center border-r border-border px-3.5 transition-colors",
              canUndo
                ? "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                : "cursor-not-allowed text-muted-foreground/40",
            )}
            aria-label={t("timeline.undo")}
          >
            <Undo2 className="size-4.5" strokeWidth={2} />
          </button>
          <button
            type="button"
            disabled={!canRedo}
            onClick={redo}
            className={cn(
              "flex h-full items-center justify-center px-3.5 transition-colors",
              canRedo
                ? "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                : "cursor-not-allowed text-muted-foreground/40",
            )}
            aria-label={t("timeline.redo")}
          >
            <Redo2 className="size-4.5" strokeWidth={2} />
          </button>
        </div>

        <button
          type="button"
          onClick={resetTimeline}
          className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-foreground/5"
        >
          <RotateCcw className="size-4.5 text-muted-foreground" strokeWidth={2} />
          {t("timeline.reset")}
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("ratio.label")}
              className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-foreground/5 data-[state=open]:bg-foreground/5"
            >
              <RectangleHorizontal className="size-4 text-muted-foreground" strokeWidth={2} />
              {activeRatioPreset.id === "recording" ? t("ratio.match") : activeRatioPreset.label}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {aspectRatioPresets.map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                onClick={() => setAspectRatioPreset(preset.id)}
                className={cn(
                  "flex items-center gap-2",
                  aspectRatioPresetId === preset.id && "bg-accent text-accent-foreground",
                )}
              >
                <span className="w-10 shrink-0 font-mono text-xs font-medium">
                  {preset.id === "recording" ? t("ratio.match") : preset.label}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {t(RATIO_HINT_KEY[preset.id])}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="min-w-5 flex-1" />

        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            className="p-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            disabled={uiZoom <= MIN_ZOOM + 1e-3}
            aria-label={`${t("timeline.zoomControl")} −`}
          >
            <span className="-mt-0.5 inline-block text-xl leading-none">−</span>
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={zoomToSlider(uiZoom)}
            onChange={(e) => zoomToValue(sliderToZoom(Number(e.target.value)))}
            className="h-1.5 w-24 cursor-grab appearance-none rounded-full bg-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40 [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-border [&::-webkit-slider-thumb]:bg-foreground"
            aria-label={t("timeline.zoomControl")}
          />
          <button
            type="button"
            onClick={() => zoomBy(ZOOM_STEP)}
            className="p-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            disabled={uiZoom >= MAX_ZOOM - 1e-3}
            aria-label={`${t("timeline.zoomControl")} +`}
          >
            <span className="-mt-0.5 inline-block text-xl leading-none">+</span>
          </button>
        </div>
      </div>

      <div className="w-full max-w-full min-w-0 px-4 pb-4">
        <div className="flex w-full min-w-0 items-stretch">
          <div
            className="w-2 shrink-0 border border-r-0 border-border bg-muted"
            aria-hidden
          />
          <div
            ref={scrollRef}
            className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain border-y border-border bg-muted"
          >
            <div
              ref={trackRef}
              className={cn(
                "relative overflow-hidden bg-muted",
                splitTool ? "cursor-crosshair" : "cursor-default",
              )}
              style={{ width: trackWidth, minWidth: "100%", height: TRACK_H }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest("[data-block]")) return;
                startDrag(e, { kind: "playhead" });
              }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("[data-block]")) return;
                onTrackClick(e);
              }}
            >
          {/* Ruler — major labels + minor ticks scale with zoom */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 border-b border-border"
            style={{ height: RULER_H }}
          >
            {rulerTicks.map((tick) => {
              const pct = (tick.time / safeDuration) * 100;
              const nearEnd = pct > 92;
              return (
                <div
                  key={`${tick.major ? "M" : "m"}-${tick.time}`}
                  className="absolute top-0 bottom-0"
                  style={{ left: `${pct}%` }}
                >
                  <div
                    className={cn(
                      "absolute bottom-0 w-px bg-border",
                      tick.major ? "top-2 opacity-100" : "top-4 opacity-60",
                    )}
                  />
                  {tick.label != null && (
                    <span
                      className={cn(
                        "absolute top-1 text-[10px] whitespace-nowrap text-muted-foreground tabular-nums",
                        nearEnd ? "right-1 left-auto" : "left-1.5",
                      )}
                    >
                      {tick.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Lane backgrounds + empty hints */}
          <div
            className="pointer-events-none absolute inset-x-0 bg-foreground/4"
            style={{ top: CLIP_TOP, height: LANE_H }}
          />
          <div
            className="pointer-events-none absolute inset-x-0 bg-foreground/2"
            style={{ top: ZOOM_TOP, height: LANE_H }}
          />
          <div
            className="pointer-events-none absolute inset-x-0 bg-foreground/4"
            style={{ top: PERSPECTIVE_TOP, height: LANE_H }}
          />
          <div
            className="pointer-events-none absolute inset-x-0 bg-foreground/2"
            style={{ top: MASK_TOP, height: LANE_H }}
          />
          <div
            className="pointer-events-none absolute inset-x-0 bg-foreground/4"
            style={{ top: HIGHLIGHT_TOP, height: LANE_H }}
          />
          <div
            className="pointer-events-none absolute inset-x-0 bg-foreground/2"
            style={{ top: SPEED_TOP, height: LANE_H }}
          />
          <div
            className="pointer-events-none absolute inset-x-0 bg-foreground/4"
            style={{ top: TEXT_TOP, height: LANE_H }}
          />
          {segments.length === 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 z-1 flex items-center justify-center text-[11px] text-muted-foreground"
              style={{ top: CLIP_TOP, height: LANE_H }}
            >
              {t("timeline.pressC")}
            </div>
          )}
          {zoomFragments.length === 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 z-1 flex items-center justify-center text-[11px] text-muted-foreground"
              style={{ top: ZOOM_TOP, height: LANE_H }}
            >
              {t("timeline.pressZ")}
            </div>
          )}
          {perspectiveFragments.length === 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 z-1 flex items-center justify-center text-[11px] text-muted-foreground"
              style={{ top: PERSPECTIVE_TOP, height: LANE_H }}
            >
              {t("look.threeD")}
            </div>
          )}
          {!blurRegions.some((region) => region.kind === "blur") && (
            <div
              className="pointer-events-none absolute inset-x-0 z-1 flex items-center justify-center text-[11px] text-muted-foreground"
              style={{ top: MASK_TOP, height: LANE_H }}
            >
              {t("blur.mask")}
            </div>
          )}
          {!blurRegions.some((region) => region.kind === "highlight") && (
            <div
              className="pointer-events-none absolute inset-x-0 z-1 flex items-center justify-center text-[11px] text-muted-foreground"
              style={{ top: HIGHLIGHT_TOP, height: LANE_H }}
            >
              {t("blur.highlight")}
            </div>
          )}
          {speedRanges.length === 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 z-1 flex items-center justify-center text-[11px] text-muted-foreground"
              style={{ top: SPEED_TOP, height: LANE_H }}
            >
              {t("export.gifSpeed")}
            </div>
          )}
          {textClips.length === 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 z-1 flex items-center justify-center text-[11px] text-muted-foreground"
              style={{ top: TEXT_TOP, height: LANE_H }}
            >
              {t("text.add")}
            </div>
          )}

          {gaps.map((gap) => (
            <div
              key={`cut-${gap.start.toFixed(3)}-${gap.end.toFixed(3)}`}
              className="pointer-events-none absolute z-1 border-y border-dashed border-foreground/10 bg-background/35"
              style={{
                top: CLIP_TOP + BLOCK_INSET,
                height: BLOCK_H,
                left: `${(gap.start / safeDuration) * 100}%`,
                width: `${((gap.end - gap.start) / safeDuration) * 100}%`,
              }}
            />
          ))}

          {/* Primary kept-video clips */}
          {segments.map((segment) => {
            const selected = selectedSegmentId === segment.id;
            return (
              <div
                key={segment.id}
                data-block
                className="absolute z-10 cursor-pointer"
                style={{
                  top: CLIP_TOP + BLOCK_INSET,
                  height: BLOCK_H,
                  left: `${(segment.start / safeDuration) * 100}%`,
                  width: `${((segment.end - segment.start) / safeDuration) * 100}%`,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (splitTool) {
                    if (splitAt({ kind: "trim", time: clientToTime(e.clientX) })) {
                      setSplitTool(false);
                    }
                    return;
                  }
                  selectSegment(segment.id);
                }}
              >
                <VideoTimelineBlock
                  segment={segment}
                  selected={selected}
                  onResizePointerDown={(edge, e) =>
                    startDrag(e, { kind: "segment-edge", segmentId: segment.id, edge })
                  }
                />
              </div>
            );
          })}

          {/* Zoom fragments */}
          {zoomFragments.map((frag) => {
            const selected = frag.id === selectedZoomFragmentId;
            return (
              <div
                key={frag.id}
                data-block
                className="absolute z-10 cursor-pointer"
                style={{
                  top: ZOOM_TOP + BLOCK_INSET,
                  height: BLOCK_H,
                  left: `${(frag.start / safeDuration) * 100}%`,
                  width: `${((frag.end - frag.start) / safeDuration) * 100}%`,
                }}
                onPointerDown={(e) => {
                  if (splitTool) return;
                  if ((e.target as HTMLElement).closest("[data-handle]")) return;
                  const pointerTime = clientToTime(e.clientX);
                  startDrag(e, {
                    kind: "zoom-move",
                    fragmentId: frag.id,
                    offset: Math.max(0, pointerTime - frag.start),
                    length: Math.max(MIN_SEGMENT_LENGTH, frag.end - frag.start),
                    startX: e.clientX,
                  });
                }}
                onClick={(e) => {
                  if (!splitTool) return;
                  e.stopPropagation();
                  if (splitAt({ kind: "zoom", fragmentId: frag.id, time: clientToTime(e.clientX) })) {
                    setSplitTool(false);
                  }
                }}
              >
                <ZoomTimelineBlock
                  fragment={frag}
                  selected={selected}
                  onResizePointerDown={(edge, e) =>
                    startDrag(e, {
                      kind: "zoom-edge",
                      fragmentId: frag.id,
                      edge,
                    })
                  }
                />
              </div>
            );
          })}

          {/* Perspective fragments */}
          {perspectiveFragments.map((fragment) => {
            const selected = fragment.id === selectedPerspectiveFragmentId;
            return (
              <div
                key={fragment.id}
                data-block
                className="absolute z-10 cursor-pointer"
                style={{
                  top: PERSPECTIVE_TOP + BLOCK_INSET,
                  height: BLOCK_H,
                  left: `${(fragment.start / safeDuration) * 100}%`,
                  width: `${((fragment.end - fragment.start) / safeDuration) * 100}%`,
                }}
                onPointerDown={(e) => {
                  if (splitTool) return;
                  if ((e.target as HTMLElement).closest("[data-handle]")) return;
                  const pointerTime = clientToTime(e.clientX);
                  startDrag(e, {
                    kind: "perspective-move",
                    fragmentId: fragment.id,
                    offset: Math.max(0, pointerTime - fragment.start),
                    length: Math.max(MIN_SEGMENT_LENGTH, fragment.end - fragment.start),
                    startX: e.clientX,
                  });
                }}
                onClick={(e) => {
                  if (!splitTool) return;
                  e.stopPropagation();
                  if (
                    splitAt({
                      kind: "perspective",
                      fragmentId: fragment.id,
                      time: clientToTime(e.clientX),
                    })
                  ) {
                    setSplitTool(false);
                  }
                }}
              >
                <PerspectiveTimelineBlock
                  fragment={fragment}
                  selected={selected}
                  onResizePointerDown={(edge, e) =>
                    startDrag(e, {
                      kind: "perspective-edge",
                      fragmentId: fragment.id,
                      edge,
                    })
                  }
                />
              </div>
            );
          })}

          {/* Time-bounded masks and highlights, each in its own lane */}
          {blurRegions.map((region) => {
            const selected = region.id === selectedBlurRegionId;
            const laneTop = region.kind === "highlight" ? HIGHLIGHT_TOP : MASK_TOP;
            return (
              <div
                key={region.id}
                data-block
                className="absolute z-10 cursor-pointer"
                style={{
                  top: laneTop + BLOCK_INSET,
                  height: BLOCK_H,
                  left: `${(region.start / safeDuration) * 100}%`,
                  width: `${((region.end - region.start) / safeDuration) * 100}%`,
                }}
                onPointerDown={(e) => {
                  if (splitTool) return;
                  if ((e.target as HTMLElement).closest("[data-handle]")) return;
                  const pointerTime = clientToTime(e.clientX);
                  startDrag(e, {
                    kind: "overlay-move",
                    regionId: region.id,
                    offset: Math.max(0, pointerTime - region.start),
                    length: Math.max(0.05, region.end - region.start),
                    startX: e.clientX,
                  });
                }}
                onClick={(e) => {
                  if (splitTool) {
                    e.stopPropagation();
                    if (splitAt({ kind: "overlay", fragmentId: region.id, time: clientToTime(e.clientX) })) {
                      setSplitTool(false);
                    }
                  } else {
                    e.stopPropagation();
                    selectBlurRegion(region.id);
                  }
                }}
              >
                <OverlayTimelineBlock
                  region={region}
                  selected={selected}
                  onResizePointerDown={(edge, e) =>
                    startDrag(e, { kind: "overlay-edge", regionId: region.id, edge })
                  }
                />
              </div>
            );
          })}

          {/* Variable-speed ranges */}
          {speedRanges.map((range) => {
            const selected = range.id === selectedSpeedRangeId;
            return (
              <div
                key={range.id}
                data-block
                className="absolute z-10 cursor-pointer"
                style={{
                  top: SPEED_TOP + BLOCK_INSET,
                  height: BLOCK_H,
                  left: `${(range.start / safeDuration) * 100}%`,
                  width: `${((range.end - range.start) / safeDuration) * 100}%`,
                }}
                onPointerDown={(e) => {
                  if (splitTool) return;
                  if ((e.target as HTMLElement).closest("[data-handle]")) return;
                  const pointerTime = clientToTime(e.clientX);
                  startDrag(e, {
                    kind: "speed-move",
                    rangeId: range.id,
                    offset: Math.max(0, pointerTime - range.start),
                    length: Math.max(0.05, range.end - range.start),
                    startX: e.clientX,
                  });
                }}
                onClick={(e) => {
                  if (splitTool) {
                    e.stopPropagation();
                    if (splitAt({ kind: "speed", fragmentId: range.id, time: clientToTime(e.clientX) })) {
                      setSplitTool(false);
                    }
                  } else {
                    e.stopPropagation();
                    selectSpeedRange(range.id);
                  }
                }}
              >
                <SpeedTimelineBlock
                  range={range}
                  selected={selected}
                  onResizePointerDown={(edge, e) =>
                    startDrag(e, { kind: "speed-edge", rangeId: range.id, edge })
                  }
                />
              </div>
            );
          })}

          {/* User-authored text clips */}
          {textClips.map((clip) => {
            const selected = clip.id === selectedTextClipId;
            return (
              <div
                key={clip.id}
                data-block
                className="absolute z-10 cursor-pointer"
                style={{
                  top: TEXT_TOP + BLOCK_INSET,
                  height: BLOCK_H,
                  left: `${(clip.start / safeDuration) * 100}%`,
                  width: `${((clip.end - clip.start) / safeDuration) * 100}%`,
                }}
                onPointerDown={(e) => {
                  if (splitTool) return;
                  if ((e.target as HTMLElement).closest("[data-handle]")) return;
                  const pointerTime = clientToTime(e.clientX);
                  startDrag(e, {
                    kind: "text-move",
                    clipId: clip.id,
                    offset: Math.max(0, pointerTime - clip.start),
                    length: Math.max(0.05, clip.end - clip.start),
                    startX: e.clientX,
                  });
                }}
                onClick={(e) => {
                  if (splitTool) {
                    e.stopPropagation();
                    if (splitAt({ kind: "text", fragmentId: clip.id, time: clientToTime(e.clientX) })) {
                      setSplitTool(false);
                    }
                  } else {
                    e.stopPropagation();
                    selectTextClip(clip.id);
                  }
                }}
              >
                <TextTimelineBlock
                  clip={clip}
                  selected={selected}
                  onResizePointerDown={(edge, e) =>
                    startDrag(e, { kind: "text-edge", clipId: clip.id, edge })
                  }
                />
              </div>
            );
          })}

          {/* Playhead — full-width transform layer so % is of the track. */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-20"
            style={{ height: TRACK_H }}
          >
            <div
              ref={playheadRef}
              className="absolute top-0 left-0 h-full w-full will-change-transform"
              style={{ transform: "translate3d(0%, 0, 0)" }}
            >
              <div className="absolute top-0 left-0 h-full w-px bg-red-500">
                <div className="absolute -top-0 -left-1.5 size-0 border-x-[6px] border-t-[8px] border-x-transparent border-t-red-500" />
              </div>
            </div>
          </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
