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
          ? "border border-amber-700 bg-amber-200 shadow-[inset_0_0_0_1px_rgba(180,83,9,0.35)]"
          : "border border-transparent bg-gradient-to-r from-yellow-200 via-amber-200 to-amber-300 hover:from-yellow-100 hover:via-amber-100 hover:to-amber-200",
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
      <div className="pointer-events-none relative z-10 flex items-center gap-1 px-3 py-0.5 text-amber-950 select-none">
        <Box className="size-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
        <span className="text-[11px] font-semibold tracking-tight">3D</span>
      </div>
    </div>
  );
}
