import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";

export type TimelineResizeEdge = "start" | "end";

type TimelineResizePillProps = {
  edge: TimelineResizeEdge;
  show: boolean;
  /** Tailwind group name used by the parent timeline block. */
  hoverGroup: "clip" | "zoom" | "trim" | "perspective" | "overlay" | "speed" | "text";
  onPointerDown: (e: React.PointerEvent) => void;
};

/** Thin white edge handle shared by all editable timeline blocks. */
export function TimelineResizePill({
  edge,
  show,
  hoverGroup,
  onPointerDown,
}: TimelineResizePillProps) {
  const { t } = useI18n();
  const hoverVisible =
    hoverGroup === "clip"
      ? "group-hover/clip:opacity-100 group-hover/clip:pointer-events-auto"
      : hoverGroup === "zoom"
        ? "group-hover/zoom:opacity-100 group-hover/zoom:pointer-events-auto"
        : hoverGroup === "trim"
          ? "group-hover/trim:opacity-100 group-hover/trim:pointer-events-auto"
          : hoverGroup === "perspective"
            ? "group-hover/perspective:opacity-100 group-hover/perspective:pointer-events-auto"
            : hoverGroup === "overlay"
              ? "group-hover/overlay:opacity-100 group-hover/overlay:pointer-events-auto"
              : hoverGroup === "speed"
                ? "group-hover/speed:opacity-100 group-hover/speed:pointer-events-auto"
                : "group-hover/text:opacity-100 group-hover/text:pointer-events-auto";

  return (
    <button
      type="button"
      data-handle
      aria-label={edge === "start" ? t("timeline.resizeStart") : t("timeline.resizeEnd")}
      onPointerDown={onPointerDown}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "absolute top-1/2 z-20 h-[70%] w-1 -translate-y-1/2 cursor-ew-resize rounded-full bg-white/90 shadow-sm transition-opacity",
        edge === "start" ? "left-1.5" : "right-1.5",
        show ? "opacity-100" : cn("pointer-events-none opacity-0", hoverVisible),
      )}
    />
  );
}
