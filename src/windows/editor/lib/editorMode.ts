export type EditorMediaKind = "video" | "screenshot";

export type EditorFeature =
  | "image-tools"
  | "cursor"
  | "camera"
  | "captions"
  | "source-trim"
  | "speed";

const SCREENSHOT_FEATURES = new Set<EditorFeature>(["image-tools"]);
const VIDEO_FEATURES = new Set<EditorFeature>([
  "cursor",
  "camera",
  "captions",
  "source-trim",
  "speed",
]);

/** One source of truth for controls that only make sense for one media kind. */
export function supportsEditorFeature(
  kind: EditorMediaKind,
  feature: EditorFeature,
): boolean {
  return (kind === "screenshot" ? SCREENSHOT_FEATURES : VIDEO_FEATURES).has(feature);
}

