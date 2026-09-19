import { Type } from "lucide-react";
import type { TextClip } from "@/engine";
import { useI18n } from "@/lib/settings";
import { cn } from "../lib/cn";
import { TimelineResizePill, type TimelineResizeEdge } from "./TimelineResizePill";

type Props = {
  clip: TextClip;
  selected: boolean;
  onResizePointerDown: (edge: TimelineResizeEdge, e: React.PointerEvent) => void;
};

export function TextTimelineBlock({ clip, selected, onResizePointerDown }: Props) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        "group/text relative flex h-full w-full min-w-[2.75rem] items-center justify-center overflow-hidden rounded-[10px] border transition-colors",
        selected
          ? "border-violet-200 bg-violet-600/90"
          : "border-transparent bg-violet-700/65 hover:bg-violet-600/80",
      )}
    >
      <TimelineResizePill edge="start" hoverGroup="text" show={selected} onPointerDown={(e) => onResizePointerDown("start", e)} />
      <TimelineResizePill edge="end" hoverGroup="text" show={selected} onPointerDown={(e) => onResizePointerDown("end", e)} />
      <div className="pointer-events-none flex min-w-0 items-center gap-1 px-2 text-[10px] font-semibold text-white">
        <Type className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{clip.text.trim() || t("text.label")}</span>
      </div>
    </div>
  );
}
