import { clickSamplesBetween, parseClickSoundSettings } from "./clickSound.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const settings = parseClickSoundSettings({ enabled: true, volume: 150 });
assert(settings.enabled && settings.volume === 100, "click settings are clamped");
const clicks = clickSamplesBetween(
  [{ t: 0.1, x: 0, y: 0 }, { t: 0.4, x: 0, y: 0 }, { t: 1, x: 0, y: 0 }],
  0.1,
  0.5,
);
assert(clicks.length === 1 && clicks[0]!.t === 0.4, "crossed click samples are selected");

console.log("clickSound.selfcheck: ok");
