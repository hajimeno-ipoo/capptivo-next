import { useI18n } from "@/lib/settings";

import { formatTimelineTime } from "../lib/timelineMath";

/** The selected timeline block's source interval, updated as its edges move. */
export function ClipTimingDisplay({ start, end }: { start: number; end: number }) {
  const { t } = useI18n();
  const length = Math.max(0, end - start);

  return (
    <dl className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
      <div className="min-w-0">
        <dt className="text-muted-foreground">{t("look.start")}</dt>
        <dd className="mt-0.5 tabular-nums text-foreground">{formatTimelineTime(start, 2)}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-muted-foreground">{t("look.end")}</dt>
        <dd className="mt-0.5 tabular-nums text-foreground">{formatTimelineTime(end, 2)}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-muted-foreground">{t("clip.duration")}</dt>
        <dd className="mt-0.5 tabular-nums text-foreground">{length.toFixed(2)} s</dd>
      </div>
    </dl>
  );
}
