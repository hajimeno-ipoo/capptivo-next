import { Gauge } from "lucide-react";
import type { SpeedRange } from "@/engine";
import { cn } from "../lib/cn";
import { TimelineResizePill, type TimelineResizeEdge } from "./TimelineResizePill";

type Props = {
  range: SpeedRange;
  selected: boolean;
  onResizePointerDown: (edge: TimelineResizeEdge, e: React.PointerEvent) => void;
};

export function SpeedTimelineBlock({ range, selected, onResizePointerDown }: Props) {
  return (
    <div
      className={cn(
        "group/speed relative flex h-full w-full min-w-[2.75rem] items-center justify-center overflow-hidden rounded-[10px] border transition-colors",
        selected
          ? "border-emerald-200 bg-emerald-600/90"
          : "border-transparent bg-emerald-700/65 hover:bg-emerald-600/80",
      )}
    >
      <TimelineResizePill edge="start" hoverGroup="speed" show={selected} onPointerDown={(e) => onResizePointerDown("start", e)} />
      <TimelineResizePill edge="end" hoverGroup="speed" show={selected} onPointerDown={(e) => onResizePointerDown("end", e)} />
      <div className="pointer-events-none flex items-center gap-1 px-2 text-[10px] font-semibold text-white">
        <Gauge className="size-3.5" aria-hidden />
        <span>{range.rate.toFixed(2)}×</span>
      </div>
    </div>
  );
}
