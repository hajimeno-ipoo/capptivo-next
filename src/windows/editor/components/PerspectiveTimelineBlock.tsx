import { Box } from "lucide-react";
import type { PerspectiveFragment } from "@/engine";
import { cn } from "@/lib/utils";
import { formatTimelineTime } from "../lib/timelineMath";
import { TimelineResizePill, type TimelineResizeEdge } from "./TimelineResizePill";

type Props = {
  fragment: PerspectiveFragment;
  selected: boolean;
  resizable?: boolean;
  onResizePointerDown: (edge: TimelineResizeEdge, e: React.PointerEvent) => void;
};

/** Amber timeline block for a local 3D perspective effect. */
export function PerspectiveTimelineBlock({
  fragment,
  selected,
  resizable = true,
  onResizePointerDown,
}: Props) {
  return (
    <div
      className={cn(
        "group/perspective relative flex h-full w-full min-w-[2.75rem] items-center justify-center overflow-hidden rounded-[10px] transition-[background-color,border-color,box-shadow] duration-150",
        selected
          ? "border border-amber-300/80 bg-[#8a5a16] shadow-[inset_0_0_0_1px_rgba(253,230,138,0.45)]"
          : "border border-transparent bg-gradient-to-r from-[#684411] via-[#7a5015] to-[#8a5a16] hover:from-[#7a5015] hover:via-[#8a5a16] hover:to-[#9b681b]",
      )}
      title={`${formatTimelineTime(fragment.start)} – ${formatTimelineTime(fragment.end)}`}
    >
      {resizable && (
        <>
          <TimelineResizePill
            edge="start"
            hoverGroup="perspective"
            show={selected}
            onPointerDown={(e) => onResizePointerDown("start", e)}
          />
          <TimelineResizePill
            edge="end"
            hoverGroup="perspective"
            show={selected}
            onPointerDown={(e) => onResizePointerDown("end", e)}
          />
        </>
      )}
      <div className="pointer-events-none relative z-10 flex items-center gap-1 px-3 py-0.5 text-white select-none">
        <Box className="size-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
        <span className="text-[11px] font-semibold tracking-tight">3D</span>
      </div>
    </div>
  );
}
