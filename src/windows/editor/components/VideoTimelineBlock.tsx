import { Clapperboard } from "lucide-react";
import type { TrimSegment } from "@/engine";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { formatTimelineTime } from "../lib/timelineMath";
import { TimelineResizePill, type TimelineResizeEdge } from "./TimelineResizePill";

type Props = {
  segment: TrimSegment;
  selected: boolean;
  resizable?: boolean;
  onResizePointerDown: (edge: TimelineResizeEdge, e: React.PointerEvent) => void;
};

/** Primary kept-video clip on the standard timeline track. */
export function VideoTimelineBlock({ segment, selected, resizable = true, onResizePointerDown }: Props) {
  const { t } = useI18n();
  const range = `${formatTimelineTime(segment.start)}–${formatTimelineTime(segment.end)}`;

  return (
    <div
      className={cn(
        "group/clip relative flex h-full w-full min-w-[2.75rem] items-center justify-center overflow-hidden rounded-[10px] transition-[background-color,border-color,box-shadow] duration-150",
        selected
          ? "border border-sky-700 bg-sky-300 shadow-[inset_0_0_0_1px_rgba(3,105,161,0.35)]"
          : "border border-transparent bg-gradient-to-r from-cyan-300 via-sky-300 to-sky-400 hover:from-cyan-200 hover:via-sky-200 hover:to-sky-300",
      )}
      title={range}
    >
      {resizable && (
        <>
          <TimelineResizePill
            edge="start"
            hoverGroup="clip"
            show={selected}
            onPointerDown={(e) => onResizePointerDown("start", e)}
          />
          <TimelineResizePill
            edge="end"
            hoverGroup="clip"
            show={selected}
            onPointerDown={(e) => onResizePointerDown("end", e)}
          />
        </>
      )}
      <div className="pointer-events-none relative z-10 flex max-w-full flex-col items-center justify-center px-3 py-0.5 text-sky-950 select-none">
        <div className="flex items-center gap-1">
          <Clapperboard className="size-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
          <span className="text-[11px] font-semibold tracking-tight">{t("timeline.clip")}</span>
        </div>
        <span
          className={cn(
            "text-[9px] font-medium tracking-tight tabular-nums text-sky-950/85",
            selected ? "opacity-75" : "opacity-0 transition-opacity group-hover/clip:opacity-60",
          )}
        >
          {range}
        </span>
      </div>
    </div>
  );
}
