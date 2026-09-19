import { Focus, Shield } from "lucide-react";
import { hexColorWithAlpha, type BlurRegion } from "@/engine";
import { useI18n } from "@/lib/settings";
import { cn } from "../lib/cn";
import { TimelineResizePill, type TimelineResizeEdge } from "./TimelineResizePill";

type Props = {
  region: BlurRegion;
  selected: boolean;
  onResizePointerDown: (edge: TimelineResizeEdge, e: React.PointerEvent) => void;
};

export function OverlayTimelineBlock({ region, selected, onResizePointerDown }: Props) {
  const { t } = useI18n();
  const highlight = region.kind === "highlight";
  return (
    <div
      style={
        highlight
          ? {
              background: hexColorWithAlpha(region.highlightColor, Math.max(0.35, region.highlightOpacity)),
              borderColor: region.highlightColor,
            }
          : undefined
      }
      className={cn(
        "group/overlay relative flex h-full w-full min-w-[2.75rem] items-center justify-center overflow-hidden rounded-[10px] border transition-colors",
        highlight
          ? selected
            ? "border-amber-200 bg-amber-500/80"
            : "border-transparent bg-amber-500/55 hover:bg-amber-500/70"
          : selected
            ? "border-sky-200 bg-sky-600/85"
            : "border-transparent bg-sky-700/65 hover:bg-sky-600/75",
      )}
    >
      <TimelineResizePill edge="start" hoverGroup="overlay" show={selected} onPointerDown={(e) => onResizePointerDown("start", e)} />
      <TimelineResizePill edge="end" hoverGroup="overlay" show={selected} onPointerDown={(e) => onResizePointerDown("end", e)} />
      <div className="pointer-events-none flex items-center gap-1 px-2 text-[10px] font-semibold text-white">
        {highlight ? <Focus className="size-3.5" aria-hidden /> : <Shield className="size-3.5" aria-hidden />}
        <span>{t(highlight ? "blur.highlight" : "blur.mask")}</span>
      </div>
    </div>
  );
}
