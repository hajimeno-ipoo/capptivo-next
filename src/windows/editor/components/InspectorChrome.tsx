import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Box, Captions, Crop, Gauge, GripVertical, Image as ImageIcon, MousePointer2,
  Settings, Shield, Type, Video, Wallpaper, X, ZoomIn,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/settings";
import type { TranslationKey } from "@/lib/i18n";
import { supportsEditorFeature } from "../lib/editorMode";

export const INSPECTOR_PANEL_IDS = ["look", "image", "cursor", "camera", "zoom", "captions", "config"] as const;
export type InspectorPanelId = (typeof INSPECTOR_PANEL_IDS)[number];

export type EditorToolId =
  | "background" | "crop" | "mask" | "text" | "zoom" | "perspective"
  | "speed" | "image" | "cursor" | "camera" | "captions" | "config";

const TOOLS: { id: EditorToolId; icon: LucideIcon; labelKey: TranslationKey }[] = [
  { id: "background", icon: Wallpaper, labelKey: "look.background" },
  { id: "crop", icon: Crop, labelKey: "crop.label" },
  { id: "mask", icon: Shield, labelKey: "blur.label" },
  { id: "text", icon: Type, labelKey: "text.label" },
  { id: "zoom", icon: ZoomIn, labelKey: "panel.zoom.title" },
  { id: "perspective", icon: Box, labelKey: "look.threeD" },
  { id: "speed", icon: Gauge, labelKey: "export.gifSpeed" },
  { id: "image", icon: ImageIcon, labelKey: "panel.image.title" },
  { id: "cursor", icon: MousePointer2, labelKey: "panel.cursor.title" },
  { id: "camera", icon: Video, labelKey: "panel.camera.title" },
  { id: "captions", icon: Captions, labelKey: "panel.captions.title" },
  { id: "config", icon: Settings, labelKey: "panel.config.title" },
];

type Props = {
  activeTool: EditorToolId;
  onToolChange: (id: EditorToolId) => void;
  panelOpen: boolean;
  onPanelOpenChange: (open: boolean) => void;
  hasFaceCam?: boolean;
  isScreenshot?: boolean;
  children: ReactNode;
};

type PanelPosition = { x: number; y: number };

function keepPanelInEditor(position: PanelPosition, rail: HTMLElement, panel: HTMLElement): PanelPosition {
  const editor = rail.getBoundingClientRect();
  const minX = editor.right + 8;
  const minY = editor.top + 12;
  const maxX = Math.max(minX, window.innerWidth - panel.offsetWidth - 8);
  const maxY = Math.max(minY, editor.bottom - panel.offsetHeight - 12);
  return {
    x: Math.max(minX, Math.min(position.x, maxX)),
    y: Math.max(minY, Math.min(position.y, maxY)),
  };
}

/** A compact tool rail and contextual panel; the canvas keeps its full width. */
export function InspectorChrome({
  activeTool, onToolChange, panelOpen, onPanelOpenChange,
  hasFaceCam = false, isScreenshot = false, children,
}: Props) {
  const { t } = useI18n();
  const activeLabel = t(TOOLS.find((item) => item.id === activeTool)?.labelKey ?? "panel.config.title");
  const railRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: PanelPosition } | null>(null);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!panelOpen) return;
    const rail = railRef.current;
    const panel = panelRef.current;
    if (!rail || !panel) return;
    const updateBounds = () => {
      const editor = rail.getBoundingClientRect();
      setMaxHeight(Math.max(120, Math.min(editor.height - 24, window.innerHeight * 0.8)));
      setPosition((current) => {
        const next = keepPanelInEditor(current ?? { x: editor.right + 8, y: editor.top + 12 }, rail, panel);
        return current?.x === next.x && current.y === next.y ? current : next;
      });
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(rail);
    observer.observe(panel);
    window.addEventListener("resize", updateBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [panelOpen, activeTool]);

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !railRef.current || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      origin: { x: rect.left, y: rect.top },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const rail = railRef.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !rail || !panel) return;
    setPosition(keepPanelInEditor({
      x: drag.origin.x + event.clientX - drag.startX,
      y: drag.origin.y + event.clientY - drag.startY,
    }, rail, panel));
  };
  const stopDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const moveWithKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    const offsets: Record<string, PanelPosition> = {
      ArrowLeft: { x: -20, y: 0 }, ArrowRight: { x: 20, y: 0 },
      ArrowUp: { x: 0, y: -20 }, ArrowDown: { x: 0, y: 20 },
    };
    const offset = offsets[event.key];
    const rail = railRef.current;
    const panel = panelRef.current;
    if (!offset || !rail || !panel) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    setPosition(keepPanelInEditor({ x: rect.left + offset.x, y: rect.top + offset.y }, rail, panel));
  };

  return <div ref={railRef} className="relative z-20 flex h-full shrink-0 border-r border-border bg-card text-foreground">
    <nav aria-label={t("editor.tools")} className="flex w-[86px] shrink-0 flex-col items-center overflow-y-auto px-1 py-3">
      <div className="flex w-full flex-1 flex-col gap-1">
        {TOOLS.map(({ id, icon: Icon, labelKey }) => {
          const label = t(labelKey);
          const disabled = (id === "image" && !supportsEditorFeature(isScreenshot ? "screenshot" : "video", "image-tools"))
            || ((id === "cursor" || id === "camera" || id === "captions" || id === "speed") && isScreenshot)
            || (id === "camera" && !hasFaceCam);
          return <button key={id} type="button" disabled={disabled} title={disabled && id === "camera" ? t("panel.camera.disabled") : label}
            aria-label={label} aria-pressed={panelOpen && activeTool === id}
            onClick={() => onToolChange(id)}
            className={cn("flex min-h-12 w-full flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-center text-[10px] leading-tight transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              disabled ? "cursor-not-allowed opacity-35" : panelOpen && activeTool === id
                ? "bg-primary/12 text-primary ring-1 ring-primary/25"
                : "text-muted-foreground hover:bg-accent hover:text-foreground")}
          >
            <Icon className="size-[18px] shrink-0" strokeWidth={1.8} aria-hidden />
            <span>{label}</span>
          </button>;
        })}
      </div>
    </nav>
    <aside ref={panelRef} style={{ left: position?.x ?? 94, top: position?.y ?? 132, maxHeight: maxHeight ?? undefined }}
      className={cn("fixed z-30 flex max-h-[80vh] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl shadow-slate-900/15", activeTool === "perspective" ? "w-[min(500px,calc(100vw-112px))]" : "w-[min(340px,calc(100vw-112px))]", !panelOpen && "hidden")}>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <button type="button" aria-label={`${activeLabel}の設定を移動（ドラッグまたは矢印キー）`}
          title="ドラッグして設定を移動" onPointerDown={startDrag} onPointerMove={moveDrag}
          onPointerUp={stopDrag} onPointerCancel={stopDrag} onKeyDown={moveWithKeys}
          className="flex min-w-0 flex-1 touch-none select-none items-center gap-2 rounded-lg text-left cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <GripVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate text-sm font-semibold">{activeLabel}</span>
        </button>
        <button type="button" onClick={() => onPanelOpenChange(false)} aria-label={t("recorder.close")}
          className="rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" /></button>
      </div>
      <div className="min-h-0 overflow-y-auto p-4">{children}</div>
    </aside>
  </div>;
}
