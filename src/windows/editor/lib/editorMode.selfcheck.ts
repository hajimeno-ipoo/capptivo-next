import { supportsEditorFeature, type EditorFeature } from "./editorMode.ts";

const screenshotOnly: EditorFeature[] = ["image-tools"];
const videoOnly: EditorFeature[] = [
  "cursor",
  "camera",
  "captions",
  "source-trim",
  "speed",
];

for (const feature of screenshotOnly) {
  if (!supportsEditorFeature("screenshot", feature)) {
    throw new Error(`screenshot must support ${feature}`);
  }
  if (supportsEditorFeature("video", feature)) {
    throw new Error(`video must not support ${feature}`);
  }
}

for (const feature of videoOnly) {
  if (!supportsEditorFeature("video", feature)) {
    throw new Error(`video must support ${feature}`);
  }
  if (supportsEditorFeature("screenshot", feature)) {
    throw new Error(`screenshot must not support ${feature}`);
  }
}

console.log("editorMode.selfcheck: ok");

