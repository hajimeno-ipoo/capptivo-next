import { MousePointer2, ZoomIn } from "lucide-react";
import type { ZoomFragment } from "@/engine";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { formatZoomScaleLabel } from "../lib/timelineMath";
import { TimelineResizePill, type TimelineResizeEdge } from "./TimelineResizePill";

type Props = {
  fragment: ZoomFragment;
  selected: boolean;
  resizable?: boolean;
  onResizePointerDown: (edge: TimelineResizeEdge, e: React.PointerEvent) => void;
};

/** Purple zoom segment on the timeline (scale + follow mode). */
export function ZoomTimelineBlock({ fragment, selected, resizable = true, onResizePointerDown }: Props) {
  const { t } = useI18n();
  const isAuto = fragment.mode === "follow-cursor";
  const modeLabel = isAuto ? t("timeline.zoomAuto") : t("timeline.zoomManual");

  return (
    <div
      className={cn(
        "group/zoom relative flex h-full w-full min-w-[2.75rem] items-center justify-center overflow-hidden rounded-[10px] transition-[background-color,border-color,box-shadow] duration-150",
        selected
          ? "border border-violet-700 bg-violet-300 shadow-[inset_0_0_0_1px_rgba(109,40,217,0.35)]"
          : "border border-transparent bg-gradient-to-r from-fuchsia-300 via-violet-300 to-violet-400 hover:from-fuchsia-200 hover:via-violet-200 hover:to-violet-300",
      )}
    >
      {resizable && (
        <>
          <TimelineResizePill
            edge="start"
            hoverGroup="zoom"
            show={selected}
            onPointerDown={(e) => onResizePointerDown("start", e)}
          />
          <TimelineResizePill
            edge="end"
            hoverGroup="zoom"
            show={selected}
            onPointerDown={(e) => onResizePointerDown("end", e)}
          />
        </>
      )}

      <div className="pointer-events-none relative z-10 flex max-w-full flex-col items-center justify-center px-3 py-0.5 text-violet-950 select-none">
        <div className="flex items-center gap-1">
          <ZoomIn className="size-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
          <span className="text-[11px] font-semibold tracking-tight tabular-nums">
            {formatZoomScaleLabel(fragment.targetScale)}
          </span>
        </div>
        <div
          className={cn(
            "flex items-center gap-0.5 text-[9px] font-medium tracking-tight text-violet-950/85",
            selected ? "opacity-75" : "opacity-0 transition-opacity group-hover/zoom:opacity-60",
          )}
        >
          <MousePointer2
            className="size-2.5 shrink-0"
            strokeWidth={2}
            fill={isAuto ? "currentColor" : "none"}
            aria-hidden
          />
          <span className="whitespace-nowrap">{modeLabel}</span>
        </div>
      </div>
    </div>
  );
}
