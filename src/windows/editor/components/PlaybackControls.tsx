/**
 * Transport bar — matches the web editor's `EditorPlaybackControls`:
 * play / ±30s / scrubber / time / mute / volume.
 */

import { useMemo, type RefObject } from "react";
import {
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import { snapTimeToKeptRange } from "@/engine";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useI18n } from "@/lib/settings";

import { formatTimelineTime } from "../lib/timelineMath";
import { presentableVideoTime, toggleEditorPlayback } from "../lib/playback";
import { createEditedTimeline } from "../lib/editedTimeline";
import { useEditorStore } from "../store";

export function PlaybackControls({
  videoRef,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const { t } = useI18n();
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const currentTime = useEditorStore((s) => s.currentTime);
  const duration = useEditorStore((s) => s.duration);
  const muted = useEditorStore((s) => s.muted);
  const volume = useEditorStore((s) => s.volume);
  const segments = useEditorStore((s) => s.segments);
  const timeline = useMemo(() => createEditedTimeline(segments, duration), [segments, duration]);
  const editedTime = timeline.toTimeline(currentTime);
  const setMuted = useEditorStore((s) => s.setMuted);
  const setVolume = useEditorStore((s) => s.setVolume);

  const seek = (time: number) => {
    const snapped =
      segments.length > 0 ? snapTimeToKeptRange(segments, time) : time;
    const video = videoRef.current;
    if (video) video.currentTime = presentableVideoTime(snapped, video.duration);
    useEditorStore.getState().setCurrentTime(snapped);
  };

  const skip = (delta: number) => {
    const video = videoRef.current;
    const base = video?.currentTime ?? currentTime;
    seek(timeline.toSource(Math.max(0, Math.min(timeline.duration, timeline.toTimeline(base) + delta))));
  };

  const togglePlay = () => {
    toggleEditorPlayback(videoRef.current);
  };

  const iconBtn =
    "size-8 shrink-0 rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground";

  const sliderTheme =
    "**:data-[slot=slider-range]:bg-muted-foreground **:data-[slot=slider-thumb]:border-border **:data-[slot=slider-thumb]:bg-foreground **:data-[slot=slider-track]:bg-foreground/15";

  return (
    <div className="flex shrink-0 flex-row items-center gap-2 rounded-xl border border-border bg-card px-4 py-2">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={iconBtn}
        onClick={togglePlay}
        disabled={timeline.duration <= 0}
        aria-label={isPlaying ? t("playback.pause") : t("playback.play")}
      >
        {isPlaying ? (
          <Pause className="size-4" />
        ) : (
          <Play className="size-4 translate-x-px" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={iconBtn}
        onClick={() => skip(-30)}
        aria-label={t("playback.back30")}
        title="−30 s"
      >
        <RotateCcw className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={iconBtn}
        onClick={() => skip(30)}
        aria-label={t("playback.forward30")}
        title="+30 s"
      >
        <RotateCw className="size-4" />
      </Button>

      <Slider
        className={`min-w-0 flex-1 ${sliderTheme}`}
        min={0}
        max={timeline.duration || 1}
        step={0.1}
        value={[editedTime]}
        onValueChange={([v]) => seek(timeline.toSource(v ?? 0))}
        disabled={timeline.duration <= 0}
      />

      <span className="min-w-16 shrink-0 text-sm tabular-nums text-muted-foreground">
        {formatTimelineTime(editedTime)} / {formatTimelineTime(timeline.duration)}
      </span>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={iconBtn}
        onClick={() => setMuted(!muted)}
        aria-label={muted ? t("playback.unmute") : t("playback.mute")}
      >
        {muted ? (
          <VolumeX className="size-4" />
        ) : (
          <Volume2 className="size-4" />
        )}
      </Button>

      <Slider
        className={`w-20 shrink-0 ${sliderTheme}`}
        min={0}
        max={100}
        step={1}
        value={[muted ? 0 : volume]}
        onValueChange={([v]) => {
          const next = v ?? 0;
          setVolume(next);
          if (next > 0 && muted) setMuted(false);
          if (next === 0) setMuted(true);
        }}
      />
    </div>
  );
}
