import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Box, Captions, Crop, Gauge, Image as ImageIcon, MousePointer2,
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

/** A compact tool rail and contextual panel; the canvas keeps its full width. */
export function InspectorChrome({
  activeTool, onToolChange, panelOpen, onPanelOpenChange,
  hasFaceCam = false, isScreenshot = false, children,
}: Props) {
  const { t } = useI18n();
  const activeLabel = t(TOOLS.find((item) => item.id === activeTool)?.labelKey ?? "panel.config.title");
  return <div className="relative z-20 flex h-full shrink-0 border-r border-border bg-card text-foreground">
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
    <aside className={cn("absolute left-[94px] top-3 z-30 flex max-h-[calc(100%-1.5rem)] w-[min(340px,calc(100vw-112px))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl shadow-slate-900/15", !panelOpen && "hidden")}>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{activeLabel}</h2>
        <button type="button" onClick={() => onPanelOpenChange(false)} aria-label={t("recorder.close")}
          className="rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" /></button>
      </div>
      <div className="min-h-0 overflow-y-auto p-4">{children}</div>
    </aside>
  </div>;
}
