import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { drawTextClips, type TextClip } from "@/engine";
import { commands } from "@/ipc/bindings";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useI18n } from "@/lib/settings";
import { useEditorStore } from "../store";
import { screenPreviewUrl } from "../lib/screenPreviewUrl";
import {
  InspectorCompositionFrame,
  type InspectorCompositionLayout,
} from "./InspectorCompositionFrame";
import { FieldLabel, SectionLabel } from "./ui";

let systemFontsRequest: Promise<string[]> | null = null;

function loadSystemFonts(): Promise<string[]> {
  if (!systemFontsRequest) {
    systemFontsRequest = commands.listSystemFonts().then((fonts) =>
      fonts
        .filter((font) => typeof font === "string" && font.trim().length > 0)
        .map((font) => font.trim()),
    );
  }
  return systemFontsRequest;
}

export function TextClipsPanel({ composition }: { composition: InspectorCompositionLayout }) {
  const { t } = useI18n();
  const clips = useEditorStore((s) => s.textClips);
  const selectedId = useEditorStore((s) => s.selectedTextClipId);
  const selected = clips.find((clip) => clip.id === selectedId) ?? null;
  const addTextClip = useEditorStore((s) => s.addTextClip);
  const updateTextClip = useEditorStore((s) => s.updateTextClip);
  const moveTextClipPosition = useEditorStore((s) => s.moveTextClipPosition);
  const removeTextClip = useEditorStore((s) => s.removeTextClip);
  const selectTextClip = useEditorStore((s) => s.selectTextClip);
  const beginTimelineEdit = useEditorStore((s) => s.beginTimelineEdit);
  const endTimelineEdit = useEditorStore((s) => s.endTimelineEdit);
  const previewUrl = useEditorStore((s) => screenPreviewUrl(s.proxyUrl, s.screenUrl));
  const duration = useEditorStore((s) => s.duration);
  const previewTime = useEditorStore((s) =>
    s.isPlaying ? undefined : s.currentTime,
  );
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSystemFonts()
      .then((fonts) => {
        if (!cancelled) setSystemFonts(fonts);
      })
      .catch(() => {
        // A browser-only dev session has no native command bridge. The editor
        // keeps the current OS-backed family instead of inventing a font list.
        if (!cancelled) setSystemFonts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="space-y-3">
      <SectionLabel>{t("text.label")}</SectionLabel>
      <Button type="button" size="sm" variant="secondary" onClick={addTextClip}>
        {t("text.add")}
      </Button>

      {selected && previewUrl && (
        <TextClipPreview
          videoUrl={previewUrl}
          duration={duration}
          seekTo={previewTime}
          clips={clips}
          selectedId={selected.id}
          onSelect={selectTextClip}
          onMove={moveTextClipPosition}
          onBeginMove={beginTimelineEdit}
          onEndMove={endTimelineEdit}
          composition={composition}
        />
      )}

      {selected && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("text.selected")}</span>
            <span className="tabular-nums">
              {selected.start.toFixed(2)}s – {selected.end.toFixed(2)}s
            </span>
          </div>

          <div className="space-y-1.5">
            <FieldLabel htmlFor="text-clip-content" hint={t("text.content.hint")}>
              {t("text.content")}
            </FieldLabel>
            <textarea
              id="text-clip-content"
              value={selected.text}
              onChange={(e) => updateTextClip(selected.id, { text: e.target.value })}
              rows={3}
              className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm text-foreground"
            />
          </div>

          <label className="space-y-1.5 text-sm font-medium text-foreground">
            <span>{t("text.font")}</span>
            <select
              value={selected.fontFamily}
              disabled={systemFonts === null}
              onChange={(e) => updateTextClip(selected.id, { fontFamily: e.target.value })}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
            >
              {systemFonts === null ? (
                <option value={selected.fontFamily}>{selected.fontFamily}</option>
              ) : (
                <>
                  {!systemFonts.includes(selected.fontFamily) && (
                    <option value={selected.fontFamily} style={{ fontFamily: selected.fontFamily }}>
                      {selected.fontFamily}
                    </option>
                  )}
                  {systemFonts.map((font) => (
                    <option key={font} value={font} style={{ fontFamily: font }}>
                      {font}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-foreground">{t("text.color")}</span>
            <input
              type="color"
              value={selected.color}
              onChange={(e) => updateTextClip(selected.id, { color: e.target.value })}
              className="h-8 w-14 cursor-pointer rounded border border-input bg-transparent p-0.5"
              aria-label={t("text.color")}
            />
          </div>

          <TextSlider
            label={t("text.fontSize")}
            value={selected.fontSizePx}
            min={12}
            max={160}
            step={1}
            suffix="px"
            onChange={(value) => updateTextClip(selected.id, { fontSizePx: value })}
          />
          <TextSlider
            label={t("text.positionX")}
            value={Math.round(selected.x * 100)}
            min={0}
            max={100}
            step={1}
            suffix="%"
            hint={t("text.position.hint")}
            onChange={(value) => updateTextClip(selected.id, { x: value / 100 })}
          />
          <TextSlider
            label={t("text.positionY")}
            value={Math.round(selected.y * 100)}
            min={0}
            max={100}
            step={1}
            suffix="%"
            hint={t("text.position.hint")}
            onChange={(value) => updateTextClip(selected.id, { y: value / 100 })}
          />

          <button
            type="button"
            className="inline-flex items-center gap-2 text-xs text-destructive hover:underline"
            onClick={() => removeTextClip(selected.id)}
          >
            <Trash2 className="size-3.5" aria-hidden />
            {t("text.remove")}
          </button>
        </div>
      )}
    </section>
  );
}

function TextClipPreview({
  videoUrl,
  duration,
  seekTo,
  clips,
  selectedId,
  onSelect,
  onMove,
  onBeginMove,
  onEndMove,
  composition,
}: {
  videoUrl: string;
  duration: number;
  seekTo?: number;
  clips: TextClip[];
  selectedId: string;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onBeginMove: () => void;
  onEndMove: () => void;
  composition: InspectorCompositionLayout;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const textCanvasRef = useRef<HTMLCanvasElement>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
  } | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => setStageWidth(stage.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = textCanvasRef.current;
    if (!canvas) return;
    const { width, height } = composition.stageDimensions;
    if (width <= 0 || height <= 0) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    drawTextClips(ctx, clips, width, height, (seekTo ?? 0) * 1000);
  }, [clips, seekTo, composition.stageDimensions.height, composition.stageDimensions.width]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, clip: TextClip) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      onSelect(clip.id);
      onBeginMove();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        id: clip.id,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startX: clip.x,
        startY: clip.y,
      };
    },
    [onBeginMove, onSelect],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const stage = stageRef.current;
      if (!drag || drag.pointerId !== e.pointerId || !stage) return;
      const bounds = stage.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const x = Math.min(
        1,
        Math.max(0, drag.startX + (e.clientX - drag.startClientX) / bounds.width),
      );
      const y = Math.min(
        1,
        Math.max(0, drag.startY + (e.clientY - drag.startClientY) / bounds.height),
      );
      onMove(drag.id, x, y);
    },
    [onMove],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    onEndMove();
  }, [onEndMove]);

  const scale =
    stageWidth > 0 && composition.stageDimensions.width > 0
      ? stageWidth / composition.stageDimensions.width
      : 0.25;

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] text-muted-foreground">{t("text.position.hint")}</div>
      <InspectorCompositionFrame
        ref={stageRef}
        videoUrl={videoUrl}
        seekTo={seekTo}
        {...composition}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onSelect(null);
        }}
      >
        <canvas
          ref={textCanvasRef}
          className="pointer-events-none absolute inset-0 z-10 h-full w-full"
          aria-hidden="true"
        />
        {clips.map((clip) => {
          const selected = clip.id === selectedId;
          return (
            <div
              key={clip.id}
              className={
                selected
                  ? "absolute z-20 max-w-[92%] rounded border-2 border-primary bg-primary/10 px-2 py-1"
                  : "absolute z-20 max-w-[92%] rounded border border-primary/40 bg-transparent px-2 py-1"
              }
              style={{
                left: `${clip.x * 100}%`,
                top: `${clip.y * 100}%`,
                transform: "translate(-50%, -50%)",
                color: "transparent",
                fontFamily: clip.fontFamily,
                fontSize: `${Math.max(10, clip.fontSizePx * scale)}px`,
                lineHeight: 1.2,
                textAlign: "center",
                textShadow: "none",
                whiteSpace: "pre-wrap",
                cursor: "move",
                touchAction: "none",
              }}
              onPointerDown={(e) => onPointerDown(e, clip)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {clip.text.trim() || t("text.label")}
            </div>
          );
        })}
      </InspectorCompositionFrame>
      {duration > 0 && (
        <div className="text-right text-[10px] tabular-nums text-muted-foreground">
          {t("text.selected")}: {clips.find((clip) => clip.id === selectedId)?.start.toFixed(2)}s –{" "}
          {clips.find((clip) => clip.id === selectedId)?.end.toFixed(2)}s
        </div>
      )}
    </div>
  );
}

function TextSlider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <FieldLabel hint={hint}>{label}</FieldLabel>
        <span className="text-xs tabular-nums text-muted-foreground">
          {value}{suffix}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => onChange(next ?? value)}
      />
    </div>
  );
}
