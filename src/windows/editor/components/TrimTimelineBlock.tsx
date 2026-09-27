import { Scissors } from "lucide-react";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { formatTimelineTime } from "../lib/timelineMath";
import { TimelineResizePill, type TimelineResizeEdge } from "./TimelineResizePill";

type Props = {
  start: number;
  end: number;
  selected: boolean;
  onResizePointerDown: (edge: TimelineResizeEdge, e: React.PointerEvent) => void;
};

/** Trim-gap segment — same chrome as zoom, different palette. */
export function TrimTimelineBlock({ start, end, selected, onResizePointerDown }: Props) {
  const { t } = useI18n();
  const range = `${formatTimelineTime(start)}–${formatTimelineTime(end)}`;

  return (
    <div
      className={cn(
        "group/trim relative flex h-full w-full min-w-[2.75rem] items-center justify-center overflow-hidden rounded-[10px] transition-[background-color,border-color,box-shadow] duration-150",
        selected
          ? "border border-orange-700 bg-orange-200 shadow-[inset_0_0_0_1px_rgba(194,65,12,0.35)]"
          : "border border-transparent bg-gradient-to-r from-orange-200 via-orange-300 to-rose-300 hover:from-orange-100 hover:via-orange-200 hover:to-rose-200",
      )}
    >
      <TimelineResizePill
        edge="start"
        hoverGroup="trim"
        show={selected}
        onPointerDown={(e) => onResizePointerDown("start", e)}
      />
      <TimelineResizePill
        edge="end"
        hoverGroup="trim"
        show={selected}
        onPointerDown={(e) => onResizePointerDown("end", e)}
      />

      <div className="pointer-events-none relative z-10 flex max-w-full flex-col items-center justify-center px-3 py-0.5 text-orange-950 select-none">
        <div className="flex items-center gap-1">
          <Scissors className="size-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
          <span className="text-[11px] font-semibold tracking-tight">{t("timeline.trim")}</span>
        </div>
        <div
          className={cn(
            "text-[9px] font-medium tracking-tight tabular-nums text-orange-950/85",
            selected ? "opacity-75" : "opacity-0 transition-opacity group-hover/trim:opacity-60",
          )}
        >
          <span className="whitespace-nowrap">{range}</span>
        </div>
      </div>
    </div>
  );
}
