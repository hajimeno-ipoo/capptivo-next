import { drawTextClips, getCompositionLayout, type BlurRegion, type ScreenContentCropNorm, type TextClip } from "@/engine";
import { DEFAULT_LOOK, resolveRecordingLayoutParams, resolveStageSize, type AspectRatioPresetId } from "./lib/composition";
import type { LookState } from "./render/renderFrame";

export type Point = { x: number; y: number };
export type ScreenshotMark =
  | { id: string; kind: "path"; points: Point[]; color: string; width: number; highlighter: boolean }
  | { id: string; kind: "shape"; shape: "arrow" | "rect" | "ellipse" | "mask"; from: Point; to: Point; color: string; width: number }
  | { id: string; kind: "text"; at: Point; text: string; color: string; fontSize: number };

export type ScreenshotEdits = {
  backgroundId: string | null;
  aspectRatioPresetId: AspectRatioPresetId;
  look: LookState;
  crop: ScreenContentCropNorm;
  blurRegions: BlurRegion[];
  marks: ScreenshotMark[];
};

export const DEFAULT_SCREENSHOT_EDITS: ScreenshotEdits = {
  backgroundId: null,
  aspectRatioPresetId: "recording",
  look: { ...DEFAULT_LOOK, devicePadding: 0 },
  crop: { x: 0, y: 0, width: 1, height: 1 },
  blurRegions: [],
  marks: [],
};

export function parseScreenshotEdits(value: unknown): ScreenshotEdits {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_SCREENSHOT_EDITS);
  const raw = value as Partial<ScreenshotEdits>;
  const n = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const crop = raw.crop;
  const x = n(crop?.x, 0, 0, 0.98);
  const y = n(crop?.y, 0, 0, 0.98);
  return {
    backgroundId: typeof raw.backgroundId === "string" ? raw.backgroundId : null,
    aspectRatioPresetId: ["recording", "16:9", "9:16", "1:1", "4:3"].includes(raw.aspectRatioPresetId ?? "")
      ? raw.aspectRatioPresetId! : "recording",
    look: {
      ...DEFAULT_SCREENSHOT_EDITS.look,
      devicePadding: n(raw.look?.devicePadding, 0, 0, 400),
      cornerRadius: n(raw.look?.cornerRadius, 18, 0, 200),
      recordingShadowIntensity: n(raw.look?.recordingShadowIntensity, 75, 0, 200),
      backgroundBlur: n(raw.look?.backgroundBlur, 9, 0, 100),
      backgroundDarkness: n(raw.look?.backgroundDarkness, 15, 0, 100),
    },
    crop: {
      x, y,
      width: n(crop?.width, 1, 0.02, 1 - x),
      height: n(crop?.height, 1, 0.02, 1 - y),
    },
    blurRegions: Array.isArray(raw.blurRegions) ? raw.blurRegions : [],
    marks: Array.isArray(raw.marks) ? raw.marks : [],
  };
}

export function screenshotStage(source: { width: number; height: number }, edits: ScreenshotEdits) {
  const stage = resolveStageSize(edits.aspectRatioPresetId, source);
  const scale = Math.max(source.width, source.height) / Math.max(stage.width, stage.height);
  const output = edits.aspectRatioPresetId === "recording"
    ? source
    : { width: Math.max(2, Math.round(stage.width * scale)), height: Math.max(2, Math.round(stage.height * scale)) };
  return { stage, output };
}

export function screenshotRecordingRect(
  source: { width: number; height: number }, edits: ScreenshotEdits,
  hasBackground: boolean, backgroundType: "image" | "gradient" | "color",
) {
  const { stage, output } = screenshotStage(source, edits);
  const params = resolveRecordingLayoutParams({
    presetId: edits.aspectRatioPresetId,
    sourceAspect: source.width / source.height,
    sourceVideoSize: source,
    hasSelectedBackground: hasBackground || edits.look.devicePadding > 0,
    hasImageBackground: hasBackground && backgroundType === "image" || edits.look.devicePadding > 0,
    devicePadding: edits.look.devicePadding,
    screenContentCrop: edits.crop,
  });
  const rect = getCompositionLayout(params.sourceAspect, stage.width, stage.height, params.devicePadding).video;
  return {
    x: rect.x * output.width / stage.width,
    y: rect.y * output.height / stage.height,
    width: rect.width * output.width / stage.width,
    height: rect.height * output.height / stage.height,
  };
}

export function drawScreenshotMarks(
  canvas: HTMLCanvasElement,
  source: { width: number; height: number },
  edits: ScreenshotEdits,
  hasBackground: boolean,
  backgroundType: "image" | "gradient" | "color",
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const rect = screenshotRecordingRect(source, edits, hasBackground, backgroundType);
  const crop = edits.crop;
  const map = (p: Point) => ({
    x: rect.x + (p.x - crop.x) / crop.width * rect.width,
    y: rect.y + (p.y - crop.y) / crop.height * rect.height,
  });
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  const text: TextClip[] = [];
  for (const mark of edits.marks) {
    if (mark.kind === "text") {
      const at = map(mark.at);
      text.push({ id: mark.id, start: 0, end: 1, text: mark.text,
        fontFamily: "system-ui", color: mark.color, fontSizePx: mark.fontSize,
        x: at.x / canvas.width, y: at.y / canvas.height });
      continue;
    }
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = mark.width * canvas.width / source.width;
    ctx.strokeStyle = mark.color;
    if (mark.kind === "path") {
      if (mark.highlighter) ctx.globalAlpha = 0.35;
      const points = mark.points.map(map);
      if (points.length < 2) { ctx.restore(); continue; }
      ctx.beginPath();
      ctx.moveTo(points[0]!.x, points[0]!.y);
      points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    } else {
      const a = map(mark.from), b = map(mark.to);
      if (mark.shape === "mask") {
        ctx.fillStyle = mark.color;
        ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      } else if (mark.shape === "rect") {
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      } else if (mark.shape === "ellipse") {
        ctx.beginPath();
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2,
          Math.max(1, Math.abs(b.x - a.x) / 2), Math.max(1, Math.abs(b.y - a.y) / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const head = Math.max(12, ctx.lineWidth * 4);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  drawTextClips(ctx, text, canvas.width, canvas.height, 0);
  ctx.restore();
}
