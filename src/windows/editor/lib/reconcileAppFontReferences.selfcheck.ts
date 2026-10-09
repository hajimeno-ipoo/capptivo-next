import { DEFAULT_TEXT_FONT_FAMILY, type TextClip } from "../../../engine/textClips.ts";
import { DEFAULT_CAPTION_SETTINGS } from "../../../captions/settings.ts";
import { reconcileAppFontReferences } from "./reconcileAppFontReferences.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function clip(id: string, fontFamily: string): TextClip {
  return {
    id, fontFamily, start: 2, end: 7, text: "日本語字幕", color: "#fedcba",
    fontSizePx: 48, x: 0.25, y: 0.6,
  };
}

const clips = [
  clip("removed-a", "CapptivoFont-deleted-a"),
  clip("os-japanese", "Hiragino Sans"),
  clip("retained", "CapptivoFont-retained"),
  clip("removed-b", "CapptivoFont-deleted-b"),
  clip("removed-a-again", "CapptivoFont-deleted-a"),
  clip("system", DEFAULT_TEXT_FONT_FAMILY),
];
const caption = {
  ...DEFAULT_CAPTION_SETTINGS, enabled: true, fontFamily: "CapptivoFont-deleted-a",
  fontSizePx: 64, textColor: "#123456", timingOffsetMs: 250,
};
const before = JSON.stringify({ clips, caption });
const available = ["CapptivoFont-retained"];
const reconciled = reconcileAppFontReferences(clips, caption, available);
assert(reconciled, "multiple deleted references must produce a patch");
assert(reconciled.textClips !== clips, "changed clips need a new array");
for (const index of [0, 3, 4]) {
  const changed = reconciled.textClips[index];
  assert(changed !== clips[index], "each deleted reference needs a new clip");
  assert(changed.fontFamily === DEFAULT_TEXT_FONT_FAMILY, "deleted text fonts use system default");
  assert(
    JSON.stringify({ ...changed, fontFamily: clips[index].fontFamily }) === JSON.stringify(clips[index]),
    "reconciliation must preserve text, timing, color, size, and position",
  );
}
for (const index of [1, 2, 5]) {
  assert(reconciled.textClips[index] === clips[index], "OS and retained font clips keep their references");
}
assert(reconciled.captionSettings !== caption, "a deleted caption font needs new settings");
assert(
  reconciled.captionSettings.fontFamily === DEFAULT_CAPTION_SETTINGS.fontFamily,
  "deleted caption fonts use caption system default",
);
assert(
  JSON.stringify({ ...reconciled.captionSettings, fontFamily: caption.fontFamily }) === JSON.stringify(caption),
  "caption styling and timings must remain unchanged",
);
assert(JSON.stringify({ clips, caption }) === before, "input data must not be modified");
assert(available.length === 1, "available registry must not be modified");
assert(
  reconcileAppFontReferences(reconciled.textClips, reconciled.captionSettings, available) === null,
  "repeated reconciliation must be a no-op",
);
assert(
  reconcileAppFontReferences(clips, caption, [
    ...available, "CapptivoFont-deleted-a", "CapptivoFont-deleted-b",
  ]) === null,
  "all installed font references must be a no-op",
);

const osCaption = { ...caption, fontFamily: '"ヒラギノ明朝 ProN", serif' };
const osClips = [clips[1], clips[5]];
assert(
  reconcileAppFontReferences(osClips, osCaption, []) === null,
  "an empty app-font registry must preserve OS fonts and arbitrary CSS stacks",
);
const captionOnly = reconcileAppFontReferences(osClips, caption, []);
assert(captionOnly, "caption-only deletion must produce a patch");
assert(captionOnly.textClips === osClips, "caption-only changes retain the text array reference");
const textOnly = reconcileAppFontReferences(clips, osCaption, []);
assert(textOnly, "an empty registry must reconcile all app-font clips");
assert(textOnly.captionSettings === osCaption, "text-only changes retain caption settings reference");
assert(textOnly.textClips[2].fontFamily === DEFAULT_TEXT_FONT_FAMILY, "empty registry removes former retained font too");
assert(reconcileAppFontReferences([], osCaption, []) === null, "an empty edit must be a no-op");

console.log("reconcileAppFontReferences.selfcheck: ok");
