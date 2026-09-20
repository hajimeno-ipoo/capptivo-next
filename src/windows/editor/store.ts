/**
 * Editor store — look params + playback + trim/zoom timeline (web-compatible shapes).
 * Zoom keyframes live in `lib/zoomCache.ts` so the rAF loop never rebuilds springs.
 */

import { create } from "zustand";
import {
  addTrimGap,
  computeTrimGaps,
  createFullSegment,
  createSegmentId,
  createZoomFragmentId,
  DEFAULT_CURSOR_SETTINGS,
  DEFAULT_FACE_CAM_CORNER,
  DEFAULT_FACE_CAM_MARGIN,
  FACE_CAM_COMPOSITION,
  FACE_CAM_MARGIN_MAX,
  FACE_CAM_MARGIN_MIN,
  FACE_CAM_ROUND_MAX,
  FACE_CAM_ROUND_MIN,
  getNextPlayableTime,
  moveSegmentEdge,
  normalizeSegments,
  parseCursorSettings,
  removeSegmentById,
  resizeTrimGapAtIndex,
  segmentsFromTrimGaps,
  splitSegmentAtTime,
  clampBlurRegion,
  clampScreenContentCropNorm,
  createBlurRegion,
  createBlurRegionId,
  REGION_MIN_DURATION,
  createSpeedRange,
  createSpeedRangeId,
  clampSpeedRange,
  clampPlaybackSpeed,
  detectTypingSpeedRanges,
  DEFAULT_PLAYBACK_SPEED,
  type ClickSoundSettings,
  DEFAULT_CLICK_SOUND_SETTINGS,
  parseClickSoundSettings,
  createPerspectiveFragmentId,
  type BlurRegion,
  type CursorSettings,
  type FaceCamCorner,
  type RecordingMetadata,
  type PerspectiveFragment,
  type ScreenContentCropNorm,
  type TimelineSnapshot,
  type TrimSegment,
  type ZoomFragment,
  type BlurRegionKind,
  type SpeedRange,
  normalizePerspectiveFragments,
  clampTextClip,
  createTextClip,
  createTextClipId,
  TEXT_CLIP_MIN_DURATION,
  type TextClip,
} from "@/engine";
import { translateNow } from "@/lib/i18n";
import { showError } from "@/lib/toast";
import { commands } from "../../ipc/bindings";
import type { Project } from "../../ipc/types";
import { describeError } from "../recorder/store";
import {
  buildColorBackgroundPresets,
  buildGradientBackgroundPresets,
  buildImageBackgroundPresets,
  clampGradientAngle,
  colorToDataUrl,
  gradientToDataUrl,
  type BackgroundPreset,
  type BackgroundType,
  type GradientDefinition,
} from "./lib/backgroundPresets";
import {
  DEFAULT_ASPECT_RATIO_PRESET_ID,
  DEFAULT_LOOK,
  isAspectRatioPresetId,
  type AspectRatioPresetId,
  type PerspectiveLook,
} from "./lib/composition";
import {
  loadLastExportSettings,
  saveLastExportSettings,
  type EditorPresetSnapshot,
} from "./lib/editorPresets";
import { supportsEditorFeature } from "./lib/editorMode";
import { loadRecordingMetadata } from "./lib/cursorLoad";
import {
  computeDefaultZoomRange,
  computeDefaultPerspectiveRange,
  createDefaultPerspectiveTimelineFragment,
  createDefaultZoomFragment,
  createSuggestedZoomFragment,
  HISTORY_LIMIT,
  MIN_SEGMENT_LENGTH,
} from "./lib/timelineMath";
import { invalidateZoomKeyframesCache } from "./lib/zoomCache";
import {
  AUTO_ZOOM_TARGET_SCALE,
  buildClickZoomSuggestions,
  shouldAutoSuggestZoomsForSource,
  type ZoomSuggestionStatus,
} from "./lib/zoomSuggestionUtils";
import type { InspectorPanelId } from "./components/InspectorChrome";
import { parseScreenshotEdits, type ScreenshotMark } from "./screenshotModel";
import type { CaptionSettings, CaptionCue } from "@/captions/types";
import {
  DEFAULT_CAPTION_SETTINGS,
  parseCaptionSettings,
} from "@/captions/types";
import { buildCaptionsFromWhisper } from "@/captions/pipeline";
import { updateCaptionListText } from "@/captions/editCueText";
import { listen } from "@tauri-apps/api/event";

/** Re-export; platform-aware media URL lives in `@/lib/platform`. */
import { customBackgroundUrl, mediaUrl, MEDIA_PROTOCOL_BASE } from "@/lib/platform";
export { mediaUrl };

export interface CustomBackgroundInfo {
  id: string;
  fileName: string;
}

export function customBackgroundPreset(info: CustomBackgroundInfo): BackgroundPreset {
  const src = customBackgroundUrl(info.fileName);
  return {
    id: info.id,
    label: "Custom",
    type: "image",
    src,
    previewCss: `url("${src}")`,
  };
}

export interface LookParams extends PerspectiveLook {
  devicePadding: number;
  cornerRadius: number;
  recordingShadowIntensity: number;
  backgroundBlur: number;
  backgroundDarkness: number;
}

/** Face-cam PiP overlay (Laravel `faceCam*` fields, desktop-shaped). */
export interface FaceCamParams {
  isRound: boolean;
  widthPx: number;
  heightPx: number;
  shadowIntensity: number;
  roundness: number;
  /** Stage corner the PiP is tucked into (used when `position` is null). */
  corner: FaceCamCorner;
  /** Canvas-space top-left; null = anchor to `corner` with `marginPx`. */
  position: { x: number; y: number } | null;
  /** Normalized 0–1 sub-rect of the camera source to show; null = full frame. */
  crop: ScreenContentCropNorm | null;
  /** Horizontal flip (matches the live preview bubble). */
  mirrored: boolean;
  /** Stage-edge inset in px when anchored to a corner. */
  marginPx: number;
}

export const DEFAULT_FACE_CAM: FaceCamParams = {
  isRound: false,
  widthPx: 400,
  heightPx: 300,
  shadowIntensity: 100,
  roundness: 18,
  corner: DEFAULT_FACE_CAM_CORNER,
  position: null,
  crop: null,
  mirrored: true,
  marginPx: DEFAULT_FACE_CAM_MARGIN,
};

const FACE_CAM_CORNERS: readonly FaceCamCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

function parseFaceCamCorner(raw: unknown): FaceCamCorner {
  return FACE_CAM_CORNERS.includes(raw as FaceCamCorner)
    ? (raw as FaceCamCorner)
    : DEFAULT_FACE_CAM_CORNER;
}

/** Persisted background selection (ids/params only; src regenerated on load). */
export interface PersistedBackground {
  type: BackgroundType;
  selection: "none" | "preset" | "custom-image" | "custom-color" | "custom-gradient";
  presetId: string | null;
  customColor: string;
  customGradientStart: string;
  customGradientEnd: string;
  customGradientAngle: number;
}

function snapshotBackground(s: EditorStore): PersistedBackground {
  const src = s.selectedBackground;
  let selection: PersistedBackground["selection"] = "none";
  let presetId: string | null = null;

  if (src) {
    const preset = [...s.imagePresets, ...s.gradientPresets, ...s.colorPresets].find(
      (p) => p.src === src,
    );
    if (preset) {
      selection = "preset";
      presetId = preset.id;
    } else {
      const custom = s.customImageBackgrounds.find((p) => p.src === src);
      if (custom) {
        selection = "custom-image";
        presetId = custom.id;
      } else if (s.backgroundType === "gradient") {
        selection = "custom-gradient";
      } else if (s.backgroundType === "color") {
        selection = "custom-color";
      }
    }
  }

  return {
    type: s.backgroundType,
    selection,
    presetId,
    customColor: s.customBackgroundColor,
    customGradientStart: s.customGradientStart,
    customGradientEnd: s.customGradientEnd,
    customGradientAngle: s.customGradientAngle,
  };
}

const BACKGROUND_SELECTIONS: readonly PersistedBackground["selection"][] = [
  "none",
  "preset",
  "custom-image",
  "custom-color",
  "custom-gradient",
];

function parsePersistedBackground(raw: unknown): PersistedBackground | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  const type = d.type === "image" || d.type === "gradient" || d.type === "color" ? d.type : "image";
  return {
    type,
    selection: BACKGROUND_SELECTIONS.includes(d.selection as PersistedBackground["selection"])
      ? (d.selection as PersistedBackground["selection"])
      : "none",
    presetId: typeof d.presetId === "string" ? d.presetId : null,
    customColor: typeof d.customColor === "string" ? d.customColor : "#22C55E",
    customGradientStart: typeof d.customGradientStart === "string" ? d.customGradientStart : "#8BC6EC",
    customGradientEnd: typeof d.customGradientEnd === "string" ? d.customGradientEnd : "#9599E2",
    customGradientAngle: clampGradientAngle(Number(d.customGradientAngle)),
  };
}

function parseFaceCamCrop(raw: unknown): ScreenContentCropNorm | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.x !== "number" ||
    typeof c.y !== "number" ||
    typeof c.width !== "number" ||
    typeof c.height !== "number"
  ) {
    return null;
  }
  return clampScreenContentCropNorm({ x: c.x, y: c.y, width: c.width, height: c.height });
}

function clampFaceCamNumber(n: unknown, fallback: number, min: number, max: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

export function parseFaceCam(raw: unknown): FaceCamParams {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_FACE_CAM };
  const d = raw as Record<string, unknown>;
  const isRound = d.isRound === true;
  const mirrored = typeof d.mirrored === "boolean" ? d.mirrored : DEFAULT_FACE_CAM.mirrored;
  const marginPx = clampFaceCamNumber(
    d.marginPx,
    DEFAULT_FACE_CAM.marginPx,
    FACE_CAM_MARGIN_MIN,
    FACE_CAM_MARGIN_MAX,
  );
  const position =
    d.position &&
    typeof d.position === "object" &&
    typeof (d.position as { x?: unknown }).x === "number" &&
    typeof (d.position as { y?: unknown }).y === "number"
      ? { x: (d.position as { x: number }).x, y: (d.position as { y: number }).y }
      : null;
  const shared = {
    shadowIntensity: clampFaceCamNumber(d.shadowIntensity, DEFAULT_FACE_CAM.shadowIntensity, 0, 200),
    roundness: clampFaceCamNumber(
      d.roundness,
      DEFAULT_FACE_CAM.roundness,
      0,
      FACE_CAM_COMPOSITION.maxRoundness,
    ),
    corner: parseFaceCamCorner(d.corner),
    crop: parseFaceCamCrop(d.crop),
    position,
    mirrored,
    marginPx,
  };
  if (isRound) {
    const size = clampFaceCamNumber(
      d.widthPx,
      DEFAULT_FACE_CAM.widthPx,
      FACE_CAM_ROUND_MIN,
      FACE_CAM_ROUND_MAX,
    );
    return {
      isRound: true,
      widthPx: size,
      heightPx: size,
      ...shared,
    };
  }
  return {
    isRound: false,
    widthPx: clampFaceCamNumber(
      d.widthPx,
      DEFAULT_FACE_CAM.widthPx,
      FACE_CAM_COMPOSITION.minWidth,
      FACE_CAM_COMPOSITION.maxWidth,
    ),
    heightPx: clampFaceCamNumber(
      d.heightPx,
      DEFAULT_FACE_CAM.heightPx,
      FACE_CAM_COMPOSITION.minHeight,
      FACE_CAM_COMPOSITION.maxHeight,
    ),
    ...shared,
  };
}

interface EditorStore {
  projectId: string | null;
  screenshotId: string | null;
  screenshotMarks: ScreenshotMark[];
  project: Project | null;
  /** Original recording — what the exporter reads. */
  screenUrl: string | null;
  /** Low-res preview proxy; `null` until ready (falls back to `screenUrl`). */
  proxyUrl: string | null;
  /** Proxy transcode in flight; cleared on ready/failure/watchdog timeout. */
  proxyPending: boolean;
  /** Separate face-cam track (`camera.webm` / `camera.mp4`), when recorded. */
  cameraUrl: string | null;
  /**
   * Milliseconds the face-cam track lags the screen's first frame (signed).
   * `null` on takes recorded before it was measured — treated as aligned.
   * Preview and export both shift the face-cam by this; see `lib/faceCamSync`.
   */
  cameraOffsetMs: number | null;
  ready: boolean;
  error: string | null;
  /** One-time init guard — proxy hot-swap must not re-parse editor state. */
  mediaInitialized: boolean;

  sourceAspect: number;
  sourceVideoSize: { width: number; height: number } | null;
  recordingMetadata: RecordingMetadata | null;
  /** Composition/export aspect; "recording" follows the source. */
  aspectRatioPresetId: AspectRatioPresetId;

  backgroundType: BackgroundType;
  selectedBackground: string | null;
  backgroundImage: HTMLImageElement | null;
  customBackgroundColor: string;
  customGradientStart: string;
  customGradientEnd: string;
  customGradientAngle: number;

  look: LookParams;

  cursorSettings: CursorSettings;
  clickSoundSettings: ClickSoundSettings;
  faceCam: FaceCamParams;

  /** Normalized 0–1 crop of the source file (null = full frame). */
  screenContentCrop: ScreenContentCropNorm | null;
  inspectorPanel: InspectorPanelId;

  isPlaying: boolean;
  currentTime: number;
  duration: number;
  muted: boolean;
  volume: number;

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
  selectedGapIndex: number | null;
  historyPast: TimelineSnapshot[];
  historyFuture: TimelineSnapshot[];

  exporting: boolean;
  exportProgress: number;
  exportStatus: string | null;
  exportError: string | null;

  captions: CaptionCue[];
  captionSettings: CaptionSettings;
  captionGenerating: boolean;
  captionError: string | null;

  imagePresets: BackgroundPreset[];
  gradientPresets: BackgroundPreset[];
  colorPresets: BackgroundPreset[];
  /** User-uploaded images from the global app-data library. */
  customImageBackgrounds: BackgroundPreset[];

  init: (projectId: string, screenshot?: boolean) => Promise<void>;
  setScreenshotMarks: (marks: ScreenshotMark[]) => void;
  onVideoLoaded: (width: number, height: number, duration: number) => void;
  setBackgroundType: (type: BackgroundType) => void;
  selectBackground: (preset: BackgroundPreset) => void;
  /** Clear the composition background (clicking the active swatch again). */
  clearBackground: () => void;
  uploadCustomBackground: (file: File) => Promise<void>;
  deleteCustomBackground: (id: string) => Promise<void>;
  setCustomColor: (color: string) => void;
  applyCustomGradient: (angle: number, start: string, end: string) => void;
  setLook: <K extends keyof LookParams>(key: K, value: number) => void;
  setAspectRatioPreset: (id: AspectRatioPresetId) => void;
  setCursorSettings: (patch: Partial<CursorSettings>) => void;
  setClickSoundSettings: (patch: Partial<ClickSoundSettings>) => void;
  setFaceCam: (patch: Partial<FaceCamParams>) => void;
  setScreenContentCrop: (crop: ScreenContentCropNorm | null) => void;
  addBlurRegion: (kind?: BlurRegionKind) => void;
  updateBlurRegion: (id: string, patch: Partial<Omit<BlurRegion, "id">>) => void;
  moveBlurRegion: (id: string, start: number, end: number) => void;
  removeBlurRegion: (id: string) => void;
  selectBlurRegion: (id: string | null) => void;
  addSpeedRange: (rate?: number) => void;
  updateSpeedRange: (id: string, patch: Partial<Omit<SpeedRange, "id">>) => void;
  moveSpeedRange: (id: string, start: number, end: number) => void;
  removeSpeedRange: (id: string) => void;
  selectSpeedRange: (id: string | null) => void;
  addTextClip: () => void;
  updateTextClip: (id: string, patch: Partial<Omit<TextClip, "id">>) => void;
  moveTextClip: (id: string, start: number, end: number) => void;
  moveTextClipPosition: (id: string, x: number, y: number) => void;
  removeTextClip: (id: string) => void;
  selectTextClip: (id: string | null) => void;
  setGlobalSpeed: (rate: number) => void;
  autoSpeedTyping: () => void;
  setInspectorPanel: (panel: InspectorPanelId) => void;
  setCaptionSettings: (patch: Partial<CaptionSettings>) => void;
  generateCaptions: () => Promise<void>;
  clearCaptions: () => void;
  /** Fix Whisper typos; timings kept when token count still matches. */
  updateCaptionText: (cueId: string, text: string) => void;
  /** Batch edits from the caption sheet — one persist. */
  updateCaptionTexts: (updates: { id: string; text: string }[]) => void;
  setPlaying: (playing: boolean) => void;
  setCurrentTime: (time: number) => void;
  setMuted: (muted: boolean) => void;
  setVolume: (volume: number) => void;
  setExporting: (exporting: boolean) => void;
  setExportProgress: (progress: number) => void;
  setExportStatus: (status: string | null) => void;
  setExportError: (error: string | null) => void;

  selectGap: (index: number | null) => void;
  selectZoomFragment: (id: string | null) => void;
  selectPerspectiveFragment: (id: string | null) => void;
  selectSegment: (id: string | null) => void;
  addFragment: (
    mode: "zoom" | "trim" | "perspective" | "speed" | "mask" | "highlight" | "overlay" | "text",
  ) => void;
  /**
   * Build follow-cursor zooms from click clusters.
   * `force: false` (default) only runs when the timeline has no zooms yet (fresh).
   */
  suggestZoomsFromClicks: (opts?: {
    force?: boolean;
    selectPanel?: boolean;
  }) => ZoomSuggestionStatus;
  deleteSelected: () => void;
  restoreTrimGap: (start: number, end: number) => void;
  moveTrimGap: (gapIndex: number, start: number, end: number) => void;
  resizeTrimGap: (gapIndex: number, edge: "start" | "end", time: number) => void;
  resizeSegment: (id: string, edge: "start" | "end", time: number) => void;
  moveZoomFragment: (id: string, start: number, end: number) => void;
  updateZoomFragment: (id: string, patch: Partial<ZoomFragment>) => void;
  updateSelectedZoomFragment: (updater: (current: ZoomFragment) => ZoomFragment) => void;
  movePerspectiveFragment: (id: string, start: number, end: number) => void;
  updatePerspectiveFragment: (id: string, patch: Partial<PerspectiveFragment>) => void;
  updateSelectedPerspectiveFragment: (
    updater: (current: PerspectiveFragment) => PerspectiveFragment,
  ) => void;
  splitAt: (
    args:
      | { kind: "trim"; time: number }
      | { kind: "zoom"; fragmentId: string; time: number }
      | { kind: "perspective"; fragmentId: string; time: number }
      | { kind: "speed"; fragmentId: string; time: number }
      | { kind: "overlay"; fragmentId: string; time: number }
      | { kind: "text"; fragmentId: string; time: number },
  ) => boolean;
  cutAtPlayhead: () => boolean;
  beginTimelineEdit: () => void;
  endTimelineEdit: () => void;
  undo: () => void;
  redo: () => void;
  resetTimeline: () => void;
  /** Snapshot + enqueue a save (debounced callers). */
  persistEditorState: () => void;
  /** Flush debounce and await every in-flight save (close / project switch). */
  flushEditorPersist: () => Promise<void>;
  captureEditorPresetSnapshot: () => EditorPresetSnapshot;
  applyEditorPresetSnapshot: (snapshot: EditorPresetSnapshot) => void;
}

let bgLoadToken = 0;
let editSnapshot: TimelineSnapshot | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** One auto-suggest attempt per project open (success or empty). */
let autoSuggestDoneForProject: string | null = null;
let autoSuggestTimer: ReturnType<typeof setTimeout> | null = null;

/** Backstop if `project://proxy-ready` / `proxy-failed` never arrives. */
const PROXY_WAIT_TIMEOUT_MS = 3 * 60 * 1000;
let proxyWaitTimer: ReturnType<typeof setTimeout> | null = null;

/** Stop waiting for a proxy — from either event, the watchdog, or a reset. */
function clearProxyWait(): void {
  if (!proxyWaitTimer) return;
  clearTimeout(proxyWaitTimer);
  proxyWaitTimer = null;
}

/** Arm the backstop for `projectId`; a project switch cancels it. */
function scheduleProxyWaitTimeout(projectId: string, get: () => EditorStore): void {
  clearProxyWait();
  proxyWaitTimer = setTimeout(() => {
    proxyWaitTimer = null;
    if (get().projectId !== projectId) return;
    console.warn(
      `[editor] no proxy after ${PROXY_WAIT_TIMEOUT_MS / 1000}s — ` +
        "falling back to the original recording",
    );
    useEditorStore.setState({ proxyPending: false });
  }, PROXY_WAIT_TIMEOUT_MS);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // media:// is cross-origin on WKWebView; CORS is advertised by the protocol.
    if (src.startsWith(MEDIA_PROTOCOL_BASE) || src.startsWith("media:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load background: ${src}`));
    img.src = src;
  });
}

function extensionFromFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "jpg";
  return name.slice(dot + 1).toLowerCase() || "jpg";
}

function snapshotOf(s: EditorStore): TimelineSnapshot {
  return {
    segments: s.segments.map((seg) => ({ ...seg })),
    zoomFragments: s.zoomFragments.map((z) => ({ ...z, fixedRect: z.fixedRect ? { ...z.fixedRect } : undefined })),
    perspectiveFragments: s.perspectiveFragments.map((fragment) => ({ ...fragment })),
    blurRegions: s.blurRegions.map((region) => ({ ...region })),
    speedRanges: s.speedRanges.map((range) => ({ ...range })),
    textClips: s.textClips.map((clip) => ({ ...clip })),
    globalSpeed: s.globalSpeed,
    selectedSegmentId: s.selectedSegmentId,
    selectedZoomFragmentId: s.selectedZoomFragmentId,
    selectedPerspectiveFragmentId: s.selectedPerspectiveFragmentId,
    selectedBlurRegionId: s.selectedBlurRegionId,
    selectedSpeedRangeId: s.selectedSpeedRangeId,
    selectedTextClipId: s.selectedTextClipId,
    currentTime: s.currentTime,
  };
}

/** Shallow equality with one nested level (zoom `fixedRect`). */
function recordsEqual(a: object, b: object): boolean {
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  for (const k of keys) {
    const av = ao[k];
    const bv = bo[k];
    if (av === bv) continue;
    if (
      av !== null &&
      bv !== null &&
      typeof av === "object" &&
      typeof bv === "object" &&
      recordsEqual(av, bv)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function arraysEqual(a: object[], b: object[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!recordsEqual(a[i], b[i])) return false;
  }
  return true;
}

function timelineChanged(a: TimelineSnapshot, b: TimelineSnapshot): boolean {
  return (
    !arraysEqual(a.segments, b.segments) ||
    !arraysEqual(a.zoomFragments, b.zoomFragments) ||
    !arraysEqual(a.perspectiveFragments, b.perspectiveFragments) ||
    !arraysEqual(a.blurRegions, b.blurRegions) ||
    !arraysEqual(a.speedRanges, b.speedRanges) ||
    !arraysEqual(a.textClips, b.textClips) ||
    a.globalSpeed !== b.globalSpeed ||
    a.selectedSegmentId !== b.selectedSegmentId ||
    a.selectedZoomFragmentId !== b.selectedZoomFragmentId ||
    a.selectedPerspectiveFragmentId !== b.selectedPerspectiveFragmentId ||
    a.selectedBlurRegionId !== b.selectedBlurRegionId ||
    a.selectedSpeedRangeId !== b.selectedSpeedRangeId ||
    a.selectedTextClipId !== b.selectedTextClipId ||
    Math.abs(a.currentTime - b.currentTime) > 1e-6
  );
}

function pushHistory(get: () => EditorStore, set: (p: Partial<EditorStore>) => void, before: TimelineSnapshot) {
  const after = snapshotOf(get());
  if (!timelineChanged(before, after)) return;
  const past = [...get().historyPast, before];
  set({
    historyPast: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    historyFuture: [],
  });
}

const PERSIST_DEBOUNCE_MS = 400;
/** Max wait before a persist fires during sustained edits (debounce alone never would). */
const PERSIST_MAX_WAIT_MS = 3000;

let persistDeadline: number | null = null;
/** Serial chain of saves — close awaits this so destroy can't race IPC. */
let persistChain: Promise<void> = Promise.resolve();

function schedulePersist(get: () => EditorStore) {
  const now = Date.now();
  if (persistDeadline === null) persistDeadline = now + PERSIST_MAX_WAIT_MS;
  const delay = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, persistDeadline - now));
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistDeadline = null;
    enqueuePersist(get);
  }, delay);
}

/**
 * Snapshot editor state now and append a save onto {@link persistChain}.
 * Payload is captured synchronously so a later `init` clear can't empty it.
 */
function enqueuePersist(get: () => EditorStore): void {
  if (!get().mediaInitialized) return;
  const {
    projectId,
    segments,
    zoomFragments,
    perspectiveFragments,
    blurRegions,
    speedRanges,
    textClips,
    globalSpeed,
    clickSoundSettings,
    look,
    screenContentCrop,
    captions,
    captionSettings,
    cursorSettings,
    faceCam,
    aspectRatioPresetId,
  } = get();
  if (!projectId) return;
  const editorState = {
    segments,
    zoomFragments,
    perspectiveFragments,
    blurRegions,
    speedRanges,
    textClips,
    globalSpeed,
    clickSoundSettings,
    look,
    screenContentCrop,
    captions,
    captionSettings,
    cursorSettings,
    faceCam,
    aspectRatioPresetId,
    background: snapshotBackground(get()),
    ...(get().screenshotId ? { marks: get().screenshotMarks } : {}),
  };
  persistChain = persistChain
    .catch(() => undefined)
    .then(() => commands.saveEditorState(projectId, editorState));
}

/**
 * Fire any pending debounced save immediately, then wait for the save chain
 * (including an already in-flight write) to settle.
 */
function flushPersist(get: () => EditorStore): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistDeadline = null;
    enqueuePersist(get);
  }
  return persistChain;
}

/** Debounced auto-suggest after a fresh project has duration + click metadata. */
function scheduleAutoSuggestZooms(get: () => EditorStore) {
  if (autoSuggestTimer) clearTimeout(autoSuggestTimer);
  autoSuggestTimer = setTimeout(() => {
    autoSuggestTimer = null;
    const s = get();
    if (!s.mediaInitialized || !s.projectId) return;
    if (autoSuggestDoneForProject === s.projectId) return;
    if (s.zoomFragments.length > 0) {
      autoSuggestDoneForProject = s.projectId;
      return;
    }
    const rawState = s.project?.editorState;
    if (rawState && typeof rawState === "object" && "zoomFragments" in rawState) {
      autoSuggestDoneForProject = s.projectId;
      return;
    }
    if (!s.recordingMetadata) return;

    const w = s.sourceVideoSize?.width ?? s.recordingMetadata.sourceWidth;
    const h = s.sourceVideoSize?.height ?? s.recordingMetadata.sourceHeight;
    if (!shouldAutoSuggestZoomsForSource(w, h)) {
      autoSuggestDoneForProject = s.projectId;
      return;
    }

    const status = get().suggestZoomsFromClicks({ force: false, selectPanel: false });
    if (status !== "no-duration") {
      autoSuggestDoneForProject = s.projectId;
    }
  }, 450);
}

function applySnapshot(set: (p: Partial<EditorStore>) => void, snap: TimelineSnapshot) {
  invalidateZoomKeyframesCache();
  set({
    segments: snap.segments.map((s) => ({ ...s })),
    zoomFragments: snap.zoomFragments.map((z) => ({ ...z, fixedRect: z.fixedRect ? { ...z.fixedRect } : undefined })),
    perspectiveFragments: snap.perspectiveFragments.map((fragment) => ({ ...fragment })),
    blurRegions: snap.blurRegions.map((region) => ({ ...region })),
    speedRanges: snap.speedRanges.map((range) => ({ ...range })),
    textClips: snap.textClips.map((clip) => ({ ...clip })),
    globalSpeed: snap.globalSpeed,
    selectedSegmentId: snap.selectedSegmentId,
    selectedZoomFragmentId: snap.selectedZoomFragmentId,
    selectedPerspectiveFragmentId: snap.selectedPerspectiveFragmentId,
    selectedBlurRegionId: snap.selectedBlurRegionId,
    selectedSpeedRangeId: snap.selectedSpeedRangeId,
    selectedTextClipId: snap.selectedTextClipId,
    selectedGapIndex: null,
    currentTime: snap.currentTime,
  });
}

function parseEditorState(raw: unknown, duration: number): {
  segments: TrimSegment[];
  zoomFragments: ZoomFragment[];
  perspectiveFragments: PerspectiveFragment[];
  blurRegions?: BlurRegion[];
  speedRanges?: SpeedRange[];
  textClips?: TextClip[];
  globalSpeed?: number;
  clickSoundSettings?: ClickSoundSettings;
  look?: Partial<LookParams>;
  screenContentCrop?: ScreenContentCropNorm | null;
  captions?: CaptionCue[];
  captionSettings?: Partial<CaptionSettings>;
  cursorSettings?: Partial<CursorSettings>;
  faceCam?: FaceCamParams;
  aspectRatioPresetId?: AspectRatioPresetId;
  background?: PersistedBackground;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const segments = Array.isArray(data.segments)
    ? normalizeSegments(data.segments as TrimSegment[], duration, MIN_SEGMENT_LENGTH)
    : null;
  const zoomFragments = Array.isArray(data.zoomFragments)
    ? (data.zoomFragments as ZoomFragment[])
    : [];
  const perspectiveFragments = normalizePerspectiveFragments(data.perspectiveFragments, duration);
  const blurRegions = Array.isArray(data.blurRegions)
    ? (data.blurRegions as BlurRegion[])
        .filter((region) => region && typeof region.id === "string")
        .map((region) => clampBlurRegion(region, duration))
    : [];
  const speedRanges = Array.isArray(data.speedRanges)
    ? (data.speedRanges as SpeedRange[])
        .filter((range) => range && typeof range.id === "string")
        .map((range) => clampSpeedRange(range, duration))
    : [];
  const textClips = Array.isArray(data.textClips)
    ? (data.textClips as TextClip[])
        .filter((clip) => clip && typeof clip.id === "string")
        .map((clip) => clampTextClip(clip, duration))
    : [];
  const globalSpeed = clampPlaybackSpeed(data.globalSpeed as number);
  const clickSoundSettings = parseClickSoundSettings(data.clickSoundSettings);
  const look =
    data.look && typeof data.look === "object" ? (data.look as Partial<LookParams>) : undefined;
  const screenContentCrop =
    data.screenContentCrop && typeof data.screenContentCrop === "object"
      ? (data.screenContentCrop as ScreenContentCropNorm)
      : data.screenContentCrop === null
        ? null
        : undefined;
  const captions = Array.isArray(data.captions) ? (data.captions as CaptionCue[]) : undefined;
  const captionSettingsRaw =
    data.captionSettings && typeof data.captionSettings === "object"
      ? parseCaptionSettings(data.captionSettings)
      : undefined;
  const cursorSettings =
    data.cursorSettings && typeof data.cursorSettings === "object"
      ? parseCursorSettings(data.cursorSettings)
      : undefined;
  const faceCam = data.faceCam != null ? parseFaceCam(data.faceCam) : undefined;
  const aspectRatioPresetId = isAspectRatioPresetId(data.aspectRatioPresetId)
    ? data.aspectRatioPresetId
    : undefined;
  return {
    segments: segments && segments.length > 0 ? segments : createFullSegment(duration),
    zoomFragments,
    perspectiveFragments,
    blurRegions,
    speedRanges,
    textClips,
    globalSpeed,
    clickSoundSettings,
    look,
    screenContentCrop,
    captions,
    captionSettings: captionSettingsRaw,
    cursorSettings,
    faceCam,
    aspectRatioPresetId,
    background: parsePersistedBackground(data.background),
  };
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  projectId: null,
  screenshotId: null,
  screenshotMarks: [],
  project: null,
  screenUrl: null,
  proxyUrl: null,
  proxyPending: false,
  cameraUrl: null,
  cameraOffsetMs: null,
  ready: false,
  error: null,
  mediaInitialized: false,

  sourceAspect: 16 / 9,
  sourceVideoSize: null,
  recordingMetadata: null,

  backgroundType: "image",
  selectedBackground: null,
  backgroundImage: null,
  customBackgroundColor: "#22C55E",
  customGradientStart: "#8BC6EC",
  customGradientEnd: "#9599E2",
  customGradientAngle: 135,

  look: { ...DEFAULT_LOOK },
  aspectRatioPresetId: DEFAULT_ASPECT_RATIO_PRESET_ID,

  cursorSettings: { ...DEFAULT_CURSOR_SETTINGS },
  clickSoundSettings: { ...DEFAULT_CLICK_SOUND_SETTINGS },
  faceCam: { ...DEFAULT_FACE_CAM },

  screenContentCrop: null,
  inspectorPanel: "look",

  isPlaying: false,
  currentTime: 0,
  duration: 0,
  muted: false,
  volume: 100,

  segments: [],
  zoomFragments: [],
  perspectiveFragments: [],
  blurRegions: [],
  speedRanges: [],
  textClips: [],
  globalSpeed: DEFAULT_PLAYBACK_SPEED,
  selectedSegmentId: null,
  selectedZoomFragmentId: null,
  selectedPerspectiveFragmentId: null,
  selectedBlurRegionId: null,
  selectedSpeedRangeId: null,
  selectedTextClipId: null,
  selectedGapIndex: null,
  historyPast: [],
  historyFuture: [],

  exporting: false,
  exportProgress: 0,
  exportStatus: null,
  exportError: null,

  captions: [],
  captionSettings: { ...DEFAULT_CAPTION_SETTINGS },
  captionGenerating: false,
  captionError: null,

  imagePresets: buildImageBackgroundPresets(),
  gradientPresets: buildGradientBackgroundPresets(),
  colorPresets: buildColorBackgroundPresets(),
  customImageBackgrounds: [],

  async init(projectId, screenshot = false) {
    await flushPersist(get);
    if (autoSuggestTimer) {
      clearTimeout(autoSuggestTimer);
      autoSuggestTimer = null;
    }
    clearProxyWait();
    autoSuggestDoneForProject = null;
    set({
      ready: false,
      error: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      screenUrl: null,
      screenshotId: screenshot ? projectId : null,
      screenshotMarks: [],
      proxyUrl: null,
      proxyPending: false,
      cameraUrl: null,
      cameraOffsetMs: null,
      mediaInitialized: false,
      recordingMetadata: null,
      sourceVideoSize: null,
      segments: [],
      zoomFragments: [],
      perspectiveFragments: [],
      blurRegions: [],
      speedRanges: [],
      textClips: [],
      globalSpeed: DEFAULT_PLAYBACK_SPEED,
      selectedSegmentId: null,
      selectedZoomFragmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedBlurRegionId: null,
      selectedSpeedRangeId: null,
      selectedTextClipId: null,
      selectedGapIndex: null,
      historyPast: [],
      historyFuture: [],
      captions: [],
      captionSettings: { ...DEFAULT_CAPTION_SETTINGS },
      captionGenerating: false,
      captionError: null,
      faceCam: { ...DEFAULT_FACE_CAM },
      clickSoundSettings: { ...DEFAULT_CLICK_SOUND_SETTINGS },
      aspectRatioPresetId: DEFAULT_ASPECT_RATIO_PRESET_ID,
      backgroundType: "image",
      selectedBackground: null,
      backgroundImage: null,
      customBackgroundColor: "#22C55E",
      customGradientStart: "#8BC6EC",
      customGradientEnd: "#9599E2",
      customGradientAngle: 135,
      customImageBackgrounds: [],
      inspectorPanel: get().inspectorPanel === "camera"
        || (screenshot && (get().inspectorPanel === "cursor" || get().inspectorPanel === "captions"))
        || (!screenshot && get().inspectorPanel === "image")
        ? "look" : get().inspectorPanel,
    });
    invalidateZoomKeyframesCache();
    try {
      const [project, customs] = await Promise.all([
        commands.loadProject(projectId),
        commands.listCustomBackgrounds().catch(() => [] as CustomBackgroundInfo[]),
      ]);
      set({
        projectId,
        project,
        screenUrl: mediaUrl(projectId, project.files.screen),
        cameraUrl: project.files.camera
          ? mediaUrl(projectId, project.files.camera)
          : null,
        customImageBackgrounds: customs.map(customBackgroundPreset),
        ready: true,
        error: null,
      });
      void loadRecordingMetadata(projectId, null).then((meta) => {
        if (meta && get().projectId === projectId) {
          invalidateZoomKeyframesCache();
          set({ recordingMetadata: meta });
          scheduleAutoSuggestZooms(get);
        }
      });
      void commands.ensureProxy(projectId).then((info) => {
        if (get().projectId !== projectId) return;
        const patch: Partial<EditorStore> = {};
        if (info.width > 0 && info.height > 0) {
          patch.sourceVideoSize = { width: info.width, height: info.height };
          patch.sourceAspect = info.width / info.height;
        }
        if (info.proxy) patch.proxyUrl = mediaUrl(projectId, info.proxy);
        patch.proxyPending = !info.proxy;
        if (patch.proxyPending) scheduleProxyWaitTimeout(projectId, get);
        set(patch);
      }).catch(() => undefined);
      // The recorded face-cam is a duration-less VP9 WebM that WKWebView will
      // not upload to the GPU (see `project/camera_track.rs`). Swap in the
      // normalized H.264 track as soon as it exists; until then the recorded
      // file stays mounted so the face-cam panel and its controls keep working.
      void commands.ensureCameraTrack(projectId).then((info) => {
        if (get().projectId !== projectId) return;
        // The offset is known even while the transcode is still running — it is
        // a property of the take, not of the file the editor happens to play.
        const patch: Partial<EditorStore> = { cameraOffsetMs: info.offsetMs };
        if (info.camera) patch.cameraUrl = mediaUrl(projectId, info.camera);
        set(patch);
      }).catch(() => undefined);
    } catch (e) {
      set({ error: describeError(e), ready: true });
    }
  },

  onVideoLoaded(width, height, duration) {
    if (get().mediaInitialized) {
      if (duration > 0 && Math.abs(get().duration - duration) > 0.05) {
        set({ duration });
      }
      return;
    }
    const aspect = height > 0 ? width / height : 16 / 9;
    const isScreenshot = get().screenshotId !== null;
    const rawState = get().project?.editorState;
    const legacyImageState = isScreenshot && rawState && typeof rawState === "object" && !("segments" in rawState)
      ? parseScreenshotEdits(rawState) : null;
    const parsed = parseEditorState(rawState, duration);
    // A screenshot uses the shared timeline as an editing surface, but its
    // source image itself is never trimmable.  Discard trim/speed state that
    // may have been persisted by older builds so an image always opens with
    // one intact source segment at normal speed.
    const segments = isScreenshot
      ? createFullSegment(duration)
      : parsed?.segments ?? createFullSegment(duration);
    const zoomFragments = parsed?.zoomFragments ?? [];
    const perspectiveFragments = parsed?.perspectiveFragments ?? [];
    const blurRegions = legacyImageState
      ? legacyImageState.blurRegions.map((region) => ({ ...region, start: 0, end: duration }))
      : parsed?.blurRegions ?? [];
    const speedRanges = isScreenshot ? [] : parsed?.speedRanges ?? [];
    const textClips = parsed?.textClips ?? [];
    const globalSpeed = isScreenshot
      ? DEFAULT_PLAYBACK_SPEED
      : parsed?.globalSpeed ?? DEFAULT_PLAYBACK_SPEED;
    const clickSoundSettings = parsed?.clickSoundSettings ?? {
      ...DEFAULT_CLICK_SOUND_SETTINGS,
    };
    const look = parsed?.look ? { ...get().look, ...parsed.look } : get().look;
    const screenContentCrop =
      parsed?.screenContentCrop !== undefined ? parsed.screenContentCrop : legacyImageState?.crop ?? get().screenContentCrop;
    const captions = parsed?.captions ?? [];
    const captionSettings = parseCaptionSettings({
      ...DEFAULT_CAPTION_SETTINGS,
      ...(parsed?.captionSettings ?? {}),
      enabled:
        captions.length > 0 &&
        (parsed?.captionSettings?.enabled ?? DEFAULT_CAPTION_SETTINGS.enabled),
    });
    const cursorSettings = parsed?.cursorSettings
      ? { ...DEFAULT_CURSOR_SETTINGS, ...parsed.cursorSettings }
      : {
          ...DEFAULT_CURSOR_SETTINGS,
          showCursor: get().project?.capture?.showsSystemCursor === false,
        };
    const faceCam = parsed?.faceCam ?? { ...DEFAULT_FACE_CAM };

    const existingSize = get().sourceVideoSize;
    const size = existingSize ?? { width, height };

    const bg = parsed?.background;
    if (bg) {
      if (bg.selection === "preset" && bg.presetId) {
        const { imagePresets, gradientPresets, colorPresets } = get();
        const preset = [...imagePresets, ...gradientPresets, ...colorPresets].find(
          (p) => p.id === bg.presetId,
        );
        if (preset) get().selectBackground(preset);
        else {
          const first = get().imagePresets[0];
          if (first) get().selectBackground(first);
        }
      } else if (bg.selection === "custom-image" && bg.presetId) {
        const custom = get().customImageBackgrounds.find((p) => p.id === bg.presetId);
        if (custom) get().selectBackground(custom);
        else {
          const first = get().imagePresets[0];
          if (first) get().selectBackground(first);
        }
      } else if (bg.selection === "custom-color") {
        get().setCustomColor(bg.customColor);
      } else if (bg.selection === "custom-gradient") {
        get().applyCustomGradient(bg.customGradientAngle, bg.customGradientStart, bg.customGradientEnd);
      }
      set({
        backgroundType: bg.type,
        customBackgroundColor: bg.customColor,
        customGradientStart: bg.customGradientStart,
        customGradientEnd: bg.customGradientEnd,
        customGradientAngle: bg.customGradientAngle,
      });
    } else if (legacyImageState?.backgroundId) {
      const preset = [...get().imagePresets, ...get().gradientPresets, ...get().colorPresets]
        .find((candidate) => candidate.id === legacyImageState.backgroundId);
      if (preset) get().selectBackground(preset);
    } else {
      const first = get().imagePresets[0];
      if (first) get().selectBackground(first);
    }

    invalidateZoomKeyframesCache();
    const bgType = bg?.type ?? get().backgroundType;
    let aspectRatioPresetId = parsed?.aspectRatioPresetId ?? legacyImageState?.aspectRatioPresetId
      ?? DEFAULT_ASPECT_RATIO_PRESET_ID;
    if (bgType === "image" && get().selectedBackground && aspectRatioPresetId === "recording") {
      aspectRatioPresetId = "16:9";
    }
    set({
      sourceVideoSize: size,
      sourceAspect: size.height > 0 ? size.width / size.height : aspect,
      duration,
      segments,
      zoomFragments,
      perspectiveFragments,
      blurRegions,
      speedRanges,
      textClips,
      globalSpeed,
      clickSoundSettings,
      look,
      screenContentCrop,
      captions,
      captionSettings,
      cursorSettings,
      faceCam,
      aspectRatioPresetId,
      mediaInitialized: true,
      screenshotMarks: isScreenshot && rawState && typeof rawState === "object"
        ? parseScreenshotEdits(rawState).marks : [],
    });

    const projectId = get().projectId;
    if (projectId) {
      scheduleAutoSuggestZooms(get);
      void loadRecordingMetadata(projectId, { width, height }).then((meta) => {
        if (meta && get().projectId === projectId) {
          invalidateZoomKeyframesCache();
          set({ recordingMetadata: meta });
          scheduleAutoSuggestZooms(get);
        }
      });
    }
  },

  setBackgroundType(type) {
    set({ backgroundType: type });
    schedulePersist(get);
  },

  setScreenshotMarks(marks) {
    if (!get().screenshotId) return;
    set({ screenshotMarks: marks });
    schedulePersist(get);
  },

  selectBackground(preset) {
    if (get().selectedBackground === preset.src) {
      get().clearBackground();
      return;
    }
    const token = ++bgLoadToken;
    set({
      selectedBackground: preset.src,
      backgroundType: preset.type,
      ...(preset.type === "image" ? { aspectRatioPresetId: "16:9" as const } : {}),
    });
    schedulePersist(get);
    loadImage(preset.src)
      .then((img) => {
        if (token === bgLoadToken) set({ backgroundImage: img });
      })
      .catch(() => {
        if (token === bgLoadToken) set({ backgroundImage: null });
      });
  },

  clearBackground() {
    ++bgLoadToken;
    set({
      selectedBackground: null,
      backgroundImage: null,
    });
    schedulePersist(get);
  },

  uploadCustomBackground(file) {
    const ext = extensionFromFileName(file.name);
    return file.arrayBuffer().then(async (buf) => {
      const saved = await commands.saveCustomBackground(new Uint8Array(buf), ext);
      const preset = customBackgroundPreset(saved);
      set((s) => ({
        customImageBackgrounds: [
          preset,
          ...s.customImageBackgrounds.filter((p) => p.id !== preset.id),
        ],
      }));
      get().selectBackground(preset);
    });
  },

  async deleteCustomBackground(id) {
    await commands.deleteCustomBackground(id);
    const removed = get().customImageBackgrounds.find((p) => p.id === id);
    set((s) => ({
      customImageBackgrounds: s.customImageBackgrounds.filter((p) => p.id !== id),
    }));
    if (removed && get().selectedBackground === removed.src) {
      get().clearBackground();
    } else {
      schedulePersist(get);
    }
  },

  setCustomColor(color) {
    const src = colorToDataUrl(color);
    const token = ++bgLoadToken;
    set({ customBackgroundColor: color, selectedBackground: src, backgroundType: "color" });
    schedulePersist(get);
    loadImage(src).then((img) => token === bgLoadToken && set({ backgroundImage: img }));
  },

  applyCustomGradient(angle, start, end) {
    const definition: GradientDefinition = {
      id: "g-custom",
      label: "Custom",
      angle,
      stops: [
        { offset: 0, color: start },
        { offset: 100, color: end },
      ],
    };
    const src = gradientToDataUrl(definition);
    const token = ++bgLoadToken;
    set({
      customGradientAngle: angle,
      customGradientStart: start,
      customGradientEnd: end,
      selectedBackground: src,
      backgroundType: "gradient",
    });
    schedulePersist(get);
    loadImage(src).then((img) => token === bgLoadToken && set({ backgroundImage: img }));
  },

  setLook(key, value) {
    set((s) => ({ look: { ...s.look, [key]: value } }));
    schedulePersist(get);
  },
  setAspectRatioPreset(id) {
    set({ aspectRatioPresetId: id });
    schedulePersist(get);
  },
  setCursorSettings(patch) {
    set((s) => ({
      cursorSettings: { ...s.cursorSettings, ...patch },
    }));
    schedulePersist(get);
  },
  setClickSoundSettings(patch) {
    set((s) => ({
      clickSoundSettings: parseClickSoundSettings({ ...s.clickSoundSettings, ...patch }),
    }));
    schedulePersist(get);
  },
  setFaceCam(patch) {
    set((s) => {
      const next = { ...s.faceCam, ...patch };
      if (typeof next.marginPx === "number") {
        next.marginPx = Math.max(
          FACE_CAM_MARGIN_MIN,
          Math.min(FACE_CAM_MARGIN_MAX, next.marginPx),
        );
      }
      if (next.isRound) {
        const size = Math.max(
          FACE_CAM_ROUND_MIN,
          Math.min(FACE_CAM_ROUND_MAX, Math.max(next.widthPx, next.heightPx)),
        );
        next.widthPx = size;
        next.heightPx = size;
      }
      return { faceCam: next };
    });
    schedulePersist(get);
  },
  setScreenContentCrop(screenContentCrop) {
    invalidateZoomKeyframesCache();
    set({ screenContentCrop });
    schedulePersist(get);
  },
  addBlurRegion(kind = "blur") {
    const { duration, currentTime } = get();
    if (!(duration > 0)) return;
    const region = createBlurRegion(duration, kind);
    const length = Math.max(REGION_MIN_DURATION, region.end - region.start);
    const start = Math.max(0, Math.min(Math.max(0, duration - length), currentTime - length / 2));
    const next = clampBlurRegion({ ...region, start, end: start + length }, duration);
    set((s) => ({
      blurRegions: [...s.blurRegions, next],
      selectedBlurRegionId: next.id,
      selectedGapIndex: null,
      selectedSegmentId: null,
      selectedZoomFragmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedSpeedRangeId: null,
      selectedTextClipId: null,
    }));
    schedulePersist(get);
  },
  selectBlurRegion(id) {
    set({
      selectedBlurRegionId: id,
      selectedGapIndex: null,
      selectedSegmentId: null,
      selectedZoomFragmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedTextClipId: null,
      inspectorPanel: id ? "look" : get().inspectorPanel,
    });
  },
  updateBlurRegion(id, patch) {
    const duration = get().duration;
    set((s) => ({
      blurRegions: s.blurRegions.map((region) =>
        region.id === id ? clampBlurRegion({ ...region, ...patch }, duration) : region,
      ),
    }));
    schedulePersist(get);
  },
  moveBlurRegion(id, start, end) {
    const duration = get().duration;
    if (!(duration > 0)) return;
    set((s) => ({
      blurRegions: s.blurRegions.map((region) =>
        region.id === id
          ? clampBlurRegion({ ...region, start, end }, duration)
          : region,
      ),
    }));
  },
  removeBlurRegion(id) {
    set((s) => ({
      blurRegions: s.blurRegions.filter((region) => region.id !== id),
      selectedBlurRegionId: s.selectedBlurRegionId === id ? null : s.selectedBlurRegionId,
    }));
    schedulePersist(get);
  },
  addTextClip() {
    const { duration, currentTime } = get();
    if (!(duration > 0)) return;
    const clip = createTextClip(duration, currentTime);
    const before = snapshotOf(get());
    set({
      textClips: [...get().textClips, clip],
      selectedTextClipId: clip.id,
      selectedGapIndex: null,
      selectedSegmentId: null,
      selectedZoomFragmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedBlurRegionId: null,
      selectedSpeedRangeId: null,
      inspectorPanel: "look",
    });
    pushHistory(get, set, before);
    schedulePersist(get);
  },
  updateTextClip(id, patch) {
    const duration = get().duration;
    set((s) => ({
      textClips: s.textClips.map((clip) =>
        clip.id === id ? clampTextClip({ ...clip, ...patch }, duration) : clip,
      ),
    }));
    schedulePersist(get);
  },
  moveTextClip(id, start, end) {
    const duration = get().duration;
    if (!(duration > 0)) return;
    set((s) => ({
      textClips: s.textClips.map((clip) =>
        clip.id === id ? clampTextClip({ ...clip, start, end }, duration) : clip,
      ),
    }));
  },
  moveTextClipPosition(id, x, y) {
    const duration = get().duration;
    set((s) => ({
      textClips: s.textClips.map((clip) =>
        clip.id === id ? clampTextClip({ ...clip, x, y }, duration) : clip,
      ),
    }));
  },
  removeTextClip(id) {
    set((s) => ({
      textClips: s.textClips.filter((clip) => clip.id !== id),
      selectedTextClipId: s.selectedTextClipId === id ? null : s.selectedTextClipId,
    }));
    schedulePersist(get);
  },
  selectTextClip(id) {
    set({
      selectedTextClipId: id,
      selectedGapIndex: null,
      selectedSegmentId: null,
      selectedZoomFragmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedBlurRegionId: null,
      selectedSpeedRangeId: null,
      inspectorPanel: id ? "look" : get().inspectorPanel,
    });
  },
  addSpeedRange(rate = DEFAULT_PLAYBACK_SPEED) {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "speed")) return;
    const { duration, currentTime } = get();
    if (!(duration > 0)) return;
    const range = createSpeedRange(duration, currentTime, rate);
    const before = snapshotOf(get());
    set({
      speedRanges: [...get().speedRanges, range],
      selectedSpeedRangeId: range.id,
      selectedGapIndex: null,
      selectedSegmentId: null,
      selectedZoomFragmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedBlurRegionId: null,
      selectedTextClipId: null,
    });
    pushHistory(get, set, before);
    schedulePersist(get);
  },
  updateSpeedRange(id, patch) {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "speed")) return;
    const duration = get().duration;
    set((s) => ({
      speedRanges: s.speedRanges.map((range) =>
        range.id === id ? clampSpeedRange({ ...range, ...patch }, duration) : range,
      ),
    }));
    schedulePersist(get);
  },
  moveSpeedRange(id, start, end) {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "speed")) return;
    const duration = get().duration;
    if (!(duration > 0)) return;
    set((s) => ({
      speedRanges: s.speedRanges.map((range) =>
        range.id === id ? clampSpeedRange({ ...range, start, end }, duration) : range,
      ),
    }));
  },
  removeSpeedRange(id) {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "speed")) return;
    set((s) => ({
      speedRanges: s.speedRanges.filter((range) => range.id !== id),
      selectedSpeedRangeId: s.selectedSpeedRangeId === id ? null : s.selectedSpeedRangeId,
    }));
    schedulePersist(get);
  },
  selectSpeedRange(id) {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "speed")) return;
    set({
      selectedSpeedRangeId: id,
      selectedGapIndex: null,
      selectedSegmentId: null,
      selectedZoomFragmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedBlurRegionId: null,
      selectedTextClipId: null,
      inspectorPanel: id ? "look" : get().inspectorPanel,
    });
  },
  setGlobalSpeed(rate) {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "speed")) return;
    set({ globalSpeed: clampPlaybackSpeed(rate) });
    schedulePersist(get);
  },
  autoSpeedTyping() {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "speed")) return;
    const { duration, recordingMetadata } = get();
    const detected = detectTypingSpeedRanges(recordingMetadata, duration);
    if (detected.length === 0) return;
    const before = snapshotOf(get());
    set((s) => ({
      speedRanges: [
        ...s.speedRanges.filter((range) => !range.autoTyping),
        ...detected,
      ],
      selectedSpeedRangeId: detected[0]?.id ?? s.selectedSpeedRangeId,
    }));
    pushHistory(get, set, before);
    schedulePersist(get);
  },
  setInspectorPanel(inspectorPanel) {
    set({ inspectorPanel });
  },

  setCaptionSettings(patch) {
    set((s) => ({
      captionSettings: { ...s.captionSettings, ...patch },
    }));
    schedulePersist(get);
  },

  async generateCaptions() {
    const { projectId, captionSettings } = get();
    if (!projectId) return;
    set({ captionGenerating: true, captionError: null });
    try {
      const artifacts = await commands.generateCaptions(
        projectId,
        captionSettings.language,
      );
      const cues = buildCaptionsFromWhisper({
        srt: artifacts.srt,
        json: artifacts.json,
        silences: artifacts.silences,
      });
      if (cues.length === 0) {
        throw new Error(translateNow("captions.error.noSpeech"));
      }
      set({
        captions: cues,
        captionSettings: { ...get().captionSettings, enabled: true },
        captionGenerating: false,
      });
      schedulePersist(get);
    } catch (e) {
      set({
        captionGenerating: false,
        captionError: describeError(e),
      });
    }
  },

  clearCaptions() {
    set({
      captions: [],
      captionSettings: { ...get().captionSettings, enabled: false },
      captionError: null,
    });
    schedulePersist(get);
  },

  updateCaptionText(cueId, text) {
    const captions = updateCaptionListText(get().captions, cueId, text);
    if (captions === get().captions) return;
    set({ captions });
    schedulePersist(get);
  },

  updateCaptionTexts(updates) {
    if (updates.length === 0) return;
    let captions = get().captions;
    let changed = false;
    for (const { id, text } of updates) {
      const next = updateCaptionListText(captions, id, text);
      if (next !== captions) {
        captions = next;
        changed = true;
      }
    }
    if (!changed) return;
    set({ captions });
    schedulePersist(get);
  },

  setPlaying(isPlaying) {
    set({ isPlaying });
  },
  setCurrentTime(currentTime) {
    set({ currentTime });
  },
  setMuted(muted) {
    set({ muted });
  },
  setVolume(volume) {
    set({ volume });
  },
  setExporting(exporting) {
    set({ exporting, exportProgress: exporting ? 0 : get().exportProgress });
  },
  setExportProgress(exportProgress) {
    set({ exportProgress });
  },
  setExportStatus(exportStatus) {
    set({ exportStatus });
  },
  setExportError(exportError) {
    set({ exportError });
    if (exportError) showError(exportError);
  },

  selectGap(index) {
    set({
      selectedGapIndex: index,
      selectedSegmentId: null,
      selectedZoomFragmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedBlurRegionId: null,
      selectedSpeedRangeId: null,
      selectedTextClipId: null,
    });
  },
  selectZoomFragment(id) {
    set({
      selectedZoomFragmentId: id,
      selectedGapIndex: null,
      selectedSegmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedBlurRegionId: null,
      selectedSpeedRangeId: null,
      selectedTextClipId: null,
      inspectorPanel: id ? "zoom" : get().inspectorPanel,
    });
  },
  selectPerspectiveFragment(id) {
    set({
      selectedPerspectiveFragmentId: id,
      selectedGapIndex: null,
      selectedSegmentId: null,
      selectedZoomFragmentId: null,
      inspectorPanel: id ? "look" : get().inspectorPanel,
      selectedBlurRegionId: null,
      selectedSpeedRangeId: null,
      selectedTextClipId: null,
    });
  },
  selectSegment(id) {
    set({
      selectedSegmentId: id,
      selectedGapIndex: null,
      selectedZoomFragmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedBlurRegionId: null,
      selectedSpeedRangeId: null,
      selectedTextClipId: null,
    });
  },

  addFragment(mode) {
    if (get().screenshotId && (mode === "speed" || mode === "trim")) return;
    const { duration, currentTime, segments, recordingMetadata } = get();
    if (duration <= 0) return;
    const before = snapshotOf(get());

    if (mode === "zoom") {
      const containing =
        segments.find((seg) => currentTime >= seg.start && currentTime < seg.end) ?? null;
      const { start, end } = computeDefaultZoomRange(
        currentTime,
        containing?.start ?? 0,
        containing?.end ?? duration,
        MIN_SEGMENT_LENGTH,
      );
      const fragment = createDefaultZoomFragment(start, end, recordingMetadata);
      invalidateZoomKeyframesCache();
      set({
        zoomFragments: [...get().zoomFragments, fragment],
        selectedZoomFragmentId: fragment.id,
        selectedGapIndex: null,
        selectedSegmentId: null,
        selectedPerspectiveFragmentId: null,
        selectedBlurRegionId: null,
        selectedSpeedRangeId: null,
        selectedTextClipId: null,
        inspectorPanel: "zoom",
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return;
    }

    if (mode === "perspective") {
      const containing =
        segments.find((seg) => currentTime >= seg.start && currentTime < seg.end) ?? null;
      const { start, end } = computeDefaultPerspectiveRange(
        currentTime,
        containing?.start ?? 0,
        containing?.end ?? duration,
        MIN_SEGMENT_LENGTH,
      );
      const fragment = createDefaultPerspectiveTimelineFragment(start, end);
      set({
        perspectiveFragments: [...get().perspectiveFragments, fragment],
        selectedPerspectiveFragmentId: fragment.id,
        selectedZoomFragmentId: null,
        selectedGapIndex: null,
        selectedBlurRegionId: null,
        selectedSpeedRangeId: null,
        selectedTextClipId: null,
        selectedSegmentId: null,
        inspectorPanel: "look",
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return;
    }

    if (mode === "speed") {
      const range = createSpeedRange(duration, currentTime, DEFAULT_PLAYBACK_SPEED);
      set({
        speedRanges: [...get().speedRanges, range],
        selectedSpeedRangeId: range.id,
        selectedGapIndex: null,
        selectedSegmentId: null,
        selectedZoomFragmentId: null,
        selectedPerspectiveFragmentId: null,
        selectedBlurRegionId: null,
        selectedTextClipId: null,
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return;
    }

    if (mode === "text") {
      const clip = createTextClip(duration, currentTime);
      set({
        textClips: [...get().textClips, clip],
        selectedTextClipId: clip.id,
        selectedGapIndex: null,
        selectedSegmentId: null,
        selectedZoomFragmentId: null,
        selectedPerspectiveFragmentId: null,
        selectedBlurRegionId: null,
        selectedSpeedRangeId: null,
        inspectorPanel: "look",
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return;
    }

    if (mode === "mask" || mode === "highlight" || mode === "overlay") {
      // `overlay` remains a compatibility alias for the former single menu
      // item; new callers choose the semantic effect explicitly.
      const kind = mode === "mask" ? "blur" : "highlight";
      const region = createBlurRegion(duration, kind);
      const length = Math.max(REGION_MIN_DURATION, region.end - region.start);
      const start = Math.max(0, Math.min(Math.max(0, duration - length), currentTime - length / 2));
      const next = clampBlurRegion({ ...region, start, end: start + length }, duration);
      set({
        blurRegions: [...get().blurRegions, next],
        selectedBlurRegionId: next.id,
        selectedGapIndex: null,
        selectedSegmentId: null,
        selectedZoomFragmentId: null,
        selectedPerspectiveFragmentId: null,
        selectedSpeedRangeId: null,
        selectedTextClipId: null,
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return;
    }

    const cutLength = Math.min(duration, Math.max(1.5, Math.min(4, duration * 0.15)));
    const cutStart = Math.max(0, currentTime - cutLength / 2);
    const cutEnd = Math.min(duration, cutStart + cutLength);
    const base =
      before.segments.length > 0
        ? normalizeSegments(before.segments, duration, MIN_SEGMENT_LENGTH)
        : createFullSegment(duration);
    const nextSegments = addTrimGap(base, cutStart, cutEnd, duration);
    const nextPlayable = getNextPlayableTime(nextSegments, cutStart) ?? cutStart;
    set({
      segments: nextSegments,
      currentTime: nextPlayable,
      isPlaying: false,
      selectedZoomFragmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedTextClipId: null,
      selectedBlurRegionId: null,
      selectedSpeedRangeId: null,
      selectedGapIndex: null,
    });
    pushHistory(get, set, before);
    schedulePersist(get);
  },

  suggestZoomsFromClicks(opts) {
    const force = opts?.force === true;
    const selectPanel = opts?.selectPanel === true;
    const { duration, recordingMetadata, zoomFragments } = get();

    if (!(duration > 0)) return "no-duration";
    if (!force && zoomFragments.length > 0) return "no-slots";

    const clicks = recordingMetadata?.cursorClickSamples ?? [];
    const result = buildClickZoomSuggestions({
      clicks,
      duration,
      reservedSpans: force
        ? zoomFragments.map((z) => ({ start: z.start, end: z.end }))
        : [],
    });

    if (result.status !== "ok" || result.suggestions.length === 0) {
      return result.status === "ok" ? "no-slots" : result.status;
    }

    const before = snapshotOf(get());
    const added = result.suggestions.map((span) =>
      createSuggestedZoomFragment(
        span.start,
        span.end,
        recordingMetadata,
        AUTO_ZOOM_TARGET_SCALE,
      ),
    );

    invalidateZoomKeyframesCache();
    set({
      zoomFragments: force ? [...get().zoomFragments, ...added] : added,
      selectedZoomFragmentId: selectPanel ? (added[0]?.id ?? null) : get().selectedZoomFragmentId,
      selectedGapIndex: null,
      selectedSegmentId: null,
      ...(selectPanel ? { inspectorPanel: "zoom" as const } : {}),
    });
    pushHistory(get, set, before);
    schedulePersist(get);
    return "ok";
  },

  deleteSelected() {
    const before = snapshotOf(get());
    const {
      selectedGapIndex,
      duration,
      segments,
      selectedZoomFragmentId,
      selectedPerspectiveFragmentId,
      selectedBlurRegionId,
      selectedSpeedRangeId,
      selectedTextClipId,
      selectedSegmentId,
    } =
      get();

    if (selectedGapIndex !== null) {
      if (get().screenshotId) {
        set({ selectedGapIndex: null });
        return;
      }
      const gaps = computeTrimGaps(segments, duration);
      const gap = gaps[selectedGapIndex];
      if (!gap) {
        set({ selectedGapIndex: null });
        return;
      }
      const nextSegments = normalizeSegments(
        [...segments, { id: createSegmentId(), start: gap.start, end: gap.end }],
        duration,
        MIN_SEGMENT_LENGTH,
      );
      set({
        segments: nextSegments,
        selectedGapIndex: null,
        currentTime: Math.max(0, Math.min(duration, gap.start)),
        isPlaying: false,
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return;
    }

    if (selectedZoomFragmentId) {
      const next = get().zoomFragments.filter((f) => f.id !== selectedZoomFragmentId);
      if (next.length === get().zoomFragments.length) return;
      invalidateZoomKeyframesCache();
      set({
        zoomFragments: next,
        selectedZoomFragmentId: null,
        selectedPerspectiveFragmentId: null,
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return;
    }

    if (selectedPerspectiveFragmentId) {
      const next = get().perspectiveFragments.filter(
        (fragment) => fragment.id !== selectedPerspectiveFragmentId,
      );
      if (next.length === get().perspectiveFragments.length) return;
      set({ perspectiveFragments: next, selectedPerspectiveFragmentId: null });
      pushHistory(get, set, before);
      schedulePersist(get);
      return;
    }

    if (selectedBlurRegionId) {
      const next = get().blurRegions.filter((region) => region.id !== selectedBlurRegionId);
      if (next.length === get().blurRegions.length) return;
      set({ blurRegions: next, selectedBlurRegionId: null });
      pushHistory(get, set, before);
      schedulePersist(get);
      return;
    }

    if (selectedSpeedRangeId) {
      if (get().screenshotId) {
        set({ selectedSpeedRangeId: null });
        return;
      }
      const next = get().speedRanges.filter((range) => range.id !== selectedSpeedRangeId);
      if (next.length === get().speedRanges.length) return;
      set({ speedRanges: next, selectedSpeedRangeId: null });
      pushHistory(get, set, before);
      schedulePersist(get);
      return;
    }

    if (selectedTextClipId) {
      const next = get().textClips.filter((clip) => clip.id !== selectedTextClipId);
      if (next.length === get().textClips.length) return;
      set({ textClips: next, selectedTextClipId: null });
      pushHistory(get, set, before);
      schedulePersist(get);
      return;
    }

    if (selectedSegmentId) {
      if (get().screenshotId) {
        set({ selectedSegmentId: null });
        return;
      }
      const next = removeSegmentById(segments, selectedSegmentId);
      if (next.length === segments.length) return;
      set({ segments: next, selectedSegmentId: null });
      pushHistory(get, set, before);
      schedulePersist(get);
    }
  },

  restoreTrimGap(start, end) {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "source-trim")) return;
    const { duration, segments } = get();
    if (duration <= 0) return;
    const before = snapshotOf(get());
    const nextSegments = normalizeSegments(
      [...segments, { id: createSegmentId(), start, end }],
      duration,
      MIN_SEGMENT_LENGTH,
    );
    set({
      segments: nextSegments,
      currentTime: Math.max(0, Math.min(duration, start)),
      selectedGapIndex: null,
      isPlaying: false,
    });
    pushHistory(get, set, before);
    schedulePersist(get);
  },

  moveTrimGap(gapIndex, start, end) {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "source-trim")) return;
    const { duration, segments } = get();
    if (duration <= 0) return;
    const s = Math.max(0, Math.min(start, end));
    const e = Math.min(duration, Math.max(start, end));
    if (!(e > s + 1e-3)) return;
    const base = editSnapshot?.segments ?? segments;
    const gaps = computeTrimGaps(base, duration);
    const nextGaps = gaps.map((gap, i) => (i === gapIndex ? { start: s, end: e } : gap));
    set({ segments: segmentsFromTrimGaps(nextGaps, duration) });
  },

  resizeTrimGap(gapIndex, edge, time) {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "source-trim")) return;
    const { duration, segments } = get();
    if (duration <= 0) return;
    set({ segments: resizeTrimGapAtIndex(segments, gapIndex, edge, time, duration) });
  },

  resizeSegment(id, edge, time) {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "source-trim")) return;
    const { duration, segments } = get();
    if (duration <= 0) return;
    set({
      segments: moveSegmentEdge(
        segments,
        id,
        edge,
        time,
        duration,
        MIN_SEGMENT_LENGTH,
      ),
    });
  },

  moveZoomFragment(id, start, end) {
    const { duration } = get();
    if (duration <= 0) return;
    let nextStart = Math.max(0, Math.min(duration, start));
    let nextEnd = Math.max(0, Math.min(duration, end));
    if (nextEnd < nextStart) [nextStart, nextEnd] = [nextEnd, nextStart];
    if (nextEnd - nextStart < MIN_SEGMENT_LENGTH) {
      nextEnd = Math.min(duration, nextStart + MIN_SEGMENT_LENGTH);
      nextStart = Math.max(0, nextEnd - MIN_SEGMENT_LENGTH);
    }
    invalidateZoomKeyframesCache();
    set({
      zoomFragments: get().zoomFragments.map((f) =>
        f.id === id ? { ...f, start: nextStart, end: nextEnd } : f,
      ),
    });
  },

  updateZoomFragment(id, patch) {
    invalidateZoomKeyframesCache();
    set({
      zoomFragments: get().zoomFragments.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    });
    schedulePersist(get);
  },

  updateSelectedZoomFragment(updater) {
    const id = get().selectedZoomFragmentId;
    if (!id) return;
    invalidateZoomKeyframesCache();
    set({
      zoomFragments: get().zoomFragments.map((f) => (f.id === id ? updater(f) : f)),
    });
    schedulePersist(get);
  },

  movePerspectiveFragment(id, start, end) {
    const { duration } = get();
    if (duration <= 0) return;
    let nextStart = Math.max(0, Math.min(duration, start));
    let nextEnd = Math.max(0, Math.min(duration, end));
    if (nextEnd < nextStart) [nextStart, nextEnd] = [nextEnd, nextStart];
    if (nextEnd - nextStart < MIN_SEGMENT_LENGTH) {
      nextEnd = Math.min(duration, nextStart + MIN_SEGMENT_LENGTH);
      nextStart = Math.max(0, nextEnd - MIN_SEGMENT_LENGTH);
    }
    set({
      perspectiveFragments: get().perspectiveFragments.map((fragment) =>
        fragment.id === id ? { ...fragment, start: nextStart, end: nextEnd } : fragment,
      ),
    });
  },

  updatePerspectiveFragment(id, patch) {
    set({
      perspectiveFragments: get().perspectiveFragments.map((fragment) =>
        fragment.id === id ? { ...fragment, ...patch } : fragment,
      ),
    });
    schedulePersist(get);
  },

  updateSelectedPerspectiveFragment(updater) {
    const id = get().selectedPerspectiveFragmentId;
    if (!id) return;
    set({
      perspectiveFragments: get().perspectiveFragments.map((fragment) =>
        fragment.id === id ? updater(fragment) : fragment,
      ),
    });
    schedulePersist(get);
  },

  splitAt(args) {
    const kind = get().screenshotId ? "screenshot" : "video";
    if (args.kind === "trim" && !supportsEditorFeature(kind, "source-trim")) return false;
    if (args.kind === "speed" && !supportsEditorFeature(kind, "speed")) return false;
    const { duration, segments, zoomFragments, perspectiveFragments } = get();
    if (duration <= 0) return false;
    const before = snapshotOf(get());
    const t = Math.max(0, Math.min(duration, args.time));

    if (args.kind === "trim") {
      const next = splitSegmentAtTime(segments, t, MIN_SEGMENT_LENGTH);
      if (next.length === segments.length) return false;
      const selectedSegmentId =
        next.find((segment) => Math.abs(segment.start - t) < 1e-6)?.id ?? null;
      set({
        segments: next,
        selectedSegmentId,
        selectedZoomFragmentId: null,
        selectedPerspectiveFragmentId: null,
        selectedGapIndex: null,
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return true;
    }

    if (args.kind === "speed") {
      const range = get().speedRanges.find((candidate) => candidate.id === args.fragmentId);
      if (!range || t <= range.start + MIN_SEGMENT_LENGTH || t >= range.end - MIN_SEGMENT_LENGTH) {
        return false;
      }
      const left = { ...range, id: createSpeedRangeId(), end: t };
      const right = { ...range, id: createSpeedRangeId(), start: t };
      set({
        speedRanges: get().speedRanges.flatMap((candidate) =>
          candidate.id === range.id ? [left, right] : [candidate],
        ),
        selectedSpeedRangeId: left.id,
        selectedBlurRegionId: null,
        currentTime: t,
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return true;
    }

    if (args.kind === "overlay") {
      const region = get().blurRegions.find((candidate) => candidate.id === args.fragmentId);
      if (!region || t <= region.start + REGION_MIN_DURATION || t >= region.end - REGION_MIN_DURATION) {
        return false;
      }
      const left = { ...region, id: createBlurRegionId(), end: t };
      const right = { ...region, id: createBlurRegionId(), start: t };
      set({
        blurRegions: get().blurRegions.flatMap((candidate) =>
          candidate.id === region.id ? [left, right] : [candidate],
        ),
        selectedBlurRegionId: left.id,
        selectedSpeedRangeId: null,
        currentTime: t,
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return true;
    }

    if (args.kind === "text") {
      const clip = get().textClips.find((candidate) => candidate.id === args.fragmentId);
      if (!clip || t <= clip.start + TEXT_CLIP_MIN_DURATION || t >= clip.end - TEXT_CLIP_MIN_DURATION) {
        return false;
      }
      const left = { ...clip, id: createTextClipId(), end: t };
      const right = { ...clip, id: createTextClipId(), start: t };
      set({
        textClips: get().textClips.flatMap((candidate) =>
          candidate.id === clip.id ? [left, right] : [candidate],
        ),
        selectedTextClipId: left.id,
        selectedBlurRegionId: null,
        selectedSpeedRangeId: null,
        currentTime: t,
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return true;
    }

    const frag = zoomFragments.find((f) => f.id === args.fragmentId);
    if (args.kind === "zoom") {
      if (!frag) return false;
      if (t <= frag.start + MIN_SEGMENT_LENGTH || t >= frag.end - MIN_SEGMENT_LENGTH) return false;
      const left = { ...frag, id: createZoomFragmentId(), end: t };
      const right = { ...frag, id: createZoomFragmentId(), start: t };
      invalidateZoomKeyframesCache();
      set({
        zoomFragments: zoomFragments.flatMap((f) => (f.id === frag.id ? [left, right] : [f])),
        selectedZoomFragmentId: left.id,
        selectedPerspectiveFragmentId: null,
        currentTime: t,
      });
      pushHistory(get, set, before);
      schedulePersist(get);
      return true;
    }

    const perspective = perspectiveFragments.find((f) => f.id === args.fragmentId);
    if (!perspective) return false;
    if (
      t <= perspective.start + MIN_SEGMENT_LENGTH ||
      t >= perspective.end - MIN_SEGMENT_LENGTH
    ) {
      return false;
    }
    const left = { ...perspective, id: createPerspectiveFragmentId(), end: t };
    const right = { ...perspective, id: createPerspectiveFragmentId(), start: t };
    set({
      perspectiveFragments: perspectiveFragments.flatMap((f) =>
        f.id === perspective.id ? [left, right] : [f],
      ),
      selectedPerspectiveFragmentId: left.id,
      selectedZoomFragmentId: null,
      currentTime: t,
    });
    pushHistory(get, set, before);
    schedulePersist(get);
    return true;
  },

  cutAtPlayhead() {
    if (!supportsEditorFeature(get().screenshotId ? "screenshot" : "video", "source-trim")) return false;
    return get().splitAt({ kind: "trim", time: get().currentTime });
  },

  beginTimelineEdit() {
    if (!editSnapshot) editSnapshot = snapshotOf(get());
  },

  endTimelineEdit() {
    if (!editSnapshot) return;
    pushHistory(get, set, editSnapshot);
    editSnapshot = null;
    schedulePersist(get);
  },

  undo() {
    const past = get().historyPast;
    if (past.length === 0) return;
    const current = snapshotOf(get());
    const target = past[past.length - 1]!;
    const future = [current, ...get().historyFuture];
    set({
      historyPast: past.slice(0, -1),
      historyFuture: future.length > HISTORY_LIMIT ? future.slice(0, HISTORY_LIMIT) : future,
    });
    applySnapshot(set, target);
    schedulePersist(get);
  },

  redo() {
    const future = get().historyFuture;
    if (future.length === 0) return;
    const [target, ...rest] = future;
    const current = snapshotOf(get());
    const past = [...get().historyPast, current];
    set({
      historyFuture: rest,
      historyPast: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    });
    applySnapshot(set, target!);
    schedulePersist(get);
  },

  resetTimeline() {
    const { duration } = get();
    if (duration <= 0) return;
    const before = snapshotOf(get());
    invalidateZoomKeyframesCache();
    set({
      segments: createFullSegment(duration),
      zoomFragments: [],
      perspectiveFragments: [],
      blurRegions: [],
      speedRanges: [],
      textClips: [],
      globalSpeed: DEFAULT_PLAYBACK_SPEED,
      selectedGapIndex: null,
      selectedZoomFragmentId: null,
      selectedPerspectiveFragmentId: null,
      selectedTextClipId: null,
      selectedBlurRegionId: null,
      selectedSpeedRangeId: null,
      selectedSegmentId: null,
      currentTime: 0,
      isPlaying: false,
    });
    pushHistory(get, set, before);
    schedulePersist(get);
  },

  persistEditorState() {
    enqueuePersist(get);
  },

  flushEditorPersist() {
    return flushPersist(get);
  },

  captureEditorPresetSnapshot() {
    const s = get();
    return {
      look: { ...s.look },
      background: snapshotBackground(s),
      faceCam: {
        ...s.faceCam,
        crop: s.faceCam.crop ? { ...s.faceCam.crop } : null,
        position: s.faceCam.position ? { ...s.faceCam.position } : null,
      },
      cursorSettings: { ...s.cursorSettings },
      captionSettings: { ...s.captionSettings },
      screenContentCrop: s.screenContentCrop ? { ...s.screenContentCrop } : null,
      aspectRatioPresetId: s.aspectRatioPresetId,
      exportSettings: loadLastExportSettings(),
    };
  },

  applyEditorPresetSnapshot(snapshot) {
    const bg = snapshot.background;
    const { imagePresets, gradientPresets, colorPresets, customImageBackgrounds } = get();

    let selectedBackground: string | null = null;
    let backgroundSrcToLoad: string | null = null;

    if (bg.selection === "preset" && bg.presetId) {
      const preset = [...imagePresets, ...gradientPresets, ...colorPresets].find(
        (p) => p.id === bg.presetId,
      );
      if (preset) {
        selectedBackground = preset.src;
        backgroundSrcToLoad = preset.src;
      }
    } else if (bg.selection === "custom-image" && bg.presetId) {
      const custom = customImageBackgrounds.find((p) => p.id === bg.presetId);
      if (custom) {
        selectedBackground = custom.src;
        backgroundSrcToLoad = custom.src;
      }
    } else if (bg.selection === "custom-color") {
      selectedBackground = colorToDataUrl(bg.customColor);
      backgroundSrcToLoad = selectedBackground;
    } else if (bg.selection === "custom-gradient") {
      selectedBackground = gradientToDataUrl({
        id: "g-custom",
        label: "Custom",
        angle: bg.customGradientAngle,
        stops: [
          { offset: 0, color: bg.customGradientStart },
          { offset: 100, color: bg.customGradientEnd },
        ],
      });
      backgroundSrcToLoad = selectedBackground;
    }

    // Single store write so React doesn't re-render mid-apply.
    set({
      backgroundType: bg.type,
      selectedBackground,
      backgroundImage: backgroundSrcToLoad ? get().backgroundImage : null,
      customBackgroundColor: bg.customColor,
      customGradientStart: bg.customGradientStart,
      customGradientEnd: bg.customGradientEnd,
      customGradientAngle: bg.customGradientAngle,
      look: { ...snapshot.look },
      faceCam: parseFaceCam(snapshot.faceCam),
      cursorSettings: parseCursorSettings(snapshot.cursorSettings),
      captionSettings: parseCaptionSettings(snapshot.captionSettings),
      screenContentCrop: snapshot.screenContentCrop
        ? clampScreenContentCropNorm(snapshot.screenContentCrop)
        : null,
      aspectRatioPresetId: snapshot.aspectRatioPresetId,
    });

    if (backgroundSrcToLoad) {
      const token = ++bgLoadToken;
      const src = backgroundSrcToLoad;
      loadImage(src)
        .then((img) => {
          if (token === bgLoadToken && get().selectedBackground === src) {
            set({ backgroundImage: img });
          }
        })
        .catch(() => {
          if (token === bgLoadToken && get().selectedBackground === src) {
            set({ backgroundImage: null });
          }
        });
    }

    invalidateZoomKeyframesCache();
    saveLastExportSettings(snapshot.exportSettings);
    schedulePersist(get);
  },
}));

// `project://proxy-ready` — swap transcoded proxy into the open project.
void listen<{ projectId: string; proxy: string }>("project://proxy-ready", (e) => {
  if (useEditorStore.getState().projectId === e.payload.projectId) {
    clearProxyWait();
    useEditorStore.setState({
      proxyUrl: mediaUrl(e.payload.projectId, e.payload.proxy),
      proxyPending: false,
    });
  }
});

void listen<{ projectId: string; reason: string }>("project://proxy-failed", (e) => {
  if (useEditorStore.getState().projectId === e.payload.projectId) {
    console.warn("[editor] preview proxy failed", e.payload.reason);
    clearProxyWait();
    useEditorStore.setState({ proxyPending: false });
  }
});

// `project://camera-ready` — swap the normalized face-cam track into the open
// project. Preview and export both read `cameraUrl`, so they stay in step.
void listen<{ projectId: string; camera: string }>("project://camera-ready", (e) => {
  if (useEditorStore.getState().projectId === e.payload.projectId) {
    useEditorStore.setState({
      cameraUrl: mediaUrl(e.payload.projectId, e.payload.camera),
    });
  }
});

void listen<{ projectId: string; reason: string }>("project://camera-failed", (e) => {
  if (useEditorStore.getState().projectId === e.payload.projectId) {
    // Keep playing the recorded WebM — degraded on WKWebView, but a face-cam
    // that may not composite beats no face-cam at all.
    console.warn("[editor] face-cam normalization failed", e.payload.reason);
  }
});
