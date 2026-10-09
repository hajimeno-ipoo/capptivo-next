import { DEFAULT_TEXT_FONT_FAMILY, type TextClip } from "../../../engine/textClips.ts";
import { DEFAULT_CAPTION_SETTINGS, type CaptionSettings } from "../../../captions/settings.ts";

/** Reconcile only the current edit after app-local font resources have changed. */
export function reconcileAppFontReferences(
  textClips: TextClip[],
  captionSettings: CaptionSettings,
  availableFamilies: string[],
): { textClips: TextClip[]; captionSettings: CaptionSettings } | null {
  const available = new Set(availableFamilies);
  const isMissing = (family: string) =>
    family.startsWith("CapptivoFont-") && !available.has(family);

  let textChanged = false;
  const nextTextClips = textClips.map((clip) => {
    if (!isMissing(clip.fontFamily)) return clip;
    textChanged = true;
    return { ...clip, fontFamily: DEFAULT_TEXT_FONT_FAMILY };
  });
  const captionChanged = isMissing(captionSettings.fontFamily);
  if (!textChanged && !captionChanged) return null;

  return {
    textClips: textChanged ? nextTextClips : textClips,
    captionSettings: captionChanged
      ? { ...captionSettings, fontFamily: DEFAULT_CAPTION_SETTINGS.fontFamily }
      : captionSettings,
  };
}
