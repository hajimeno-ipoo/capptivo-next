import {
  clampTextClip,
  createTextClip,
  textClipIsActive,
} from "./textClips.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const clip = createTextClip(10, 5);
assert(clip.end - clip.start === 3, "text clips use a three-second default interval");
assert(textClipIsActive(clip, 5) && !textClipIsActive(clip, 0), "text clip activation follows source time");

const clamped = clampTextClip(
  {
    id: "styled",
    start: -1,
    end: 99,
    text: "Hello",
    color: "#abc",
    fontSizePx: 999,
    x: 2,
    y: -1,
  },
  4,
);
assert(clamped.start === 0 && clamped.end === 4, "text interval stays inside the video");
assert(clamped.color === "#aabbcc" && clamped.fontSizePx === 160, "text style values are normalized");
assert(clamped.x === 1 && clamped.y === 0, "text position stays inside the composition");

console.log("textClips.selfcheck: ok");
