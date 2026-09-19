/** Click-sound settings, hit testing, and a tiny generated preview sound. */

import type { CursorClickSample } from "./zoomMotion";

export type ClickSoundSettings = {
  enabled: boolean;
  /** 0–100, applied as a gain multiplier. */
  volume: number;
};

export const DEFAULT_CLICK_SOUND_SETTINGS: ClickSoundSettings = {
  enabled: false,
  volume: 55,
};

export function parseClickSoundSettings(raw: unknown): ClickSoundSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CLICK_SOUND_SETTINGS };
  const data = raw as Record<string, unknown>;
  const volume = typeof data.volume === "number" && Number.isFinite(data.volume)
    ? Math.min(100, Math.max(0, data.volume))
    : DEFAULT_CLICK_SOUND_SETTINGS.volume;
  return { enabled: data.enabled === true, volume };
}

export function clickSamplesBetween(
  samples: CursorClickSample[] | undefined,
  from: number,
  to: number,
): CursorClickSample[] {
  if (!samples || to <= from) return [];
  return samples.filter((sample) => sample.t > from && sample.t <= to);
}

let audioContext: AudioContext | null = null;

/** Browser-only, no external asset or network request. */
export function playGeneratedClick(volume: number): void {
  if (typeof window === "undefined") return;
  const AudioContextCtor = window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;
  audioContext ??= new AudioContextCtor();
  if (audioContext.state === "suspended") void audioContext.resume();
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(1050, now);
  oscillator.frequency.exponentialRampToValueAtTime(500, now + 0.045);
  gain.gain.setValueAtTime(Math.min(1, Math.max(0, volume / 100)) * 0.16, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.065);
}
