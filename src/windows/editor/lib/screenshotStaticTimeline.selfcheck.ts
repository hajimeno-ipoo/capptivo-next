import {
  makeScreenshotTimelineStatic,
  SCREENSHOT_RENDER_TIME,
} from "./screenshotStaticTimeline.ts";

const result = makeScreenshotTimelineStatic(
  {
    zoomFragments: [
      { id: "opening", start: 0, end: 2, mode: "fixed-rect", targetScale: 1.5, easeIn: 0.3, easeOut: 0.3, damping: 4 },
      { id: "latest", start: 3, end: 4, mode: "fixed-rect", targetScale: 2, easeIn: 0.4, easeOut: 0.4, damping: 4 },
    ],
    perspectiveFragments: [
      { id: "3d", start: 2, end: 3, tiltX: 12, tiltY: -18, tiltZ: 0, perspectiveDistance: 1100, reflectionStrength: 0, reflectionStyle: "soft", easeIn: 0.35, easeOut: 0.35 },
    ],
    blurRegions: [
      { id: "mask", x: 0, y: 0, width: 0.2, height: 0.2, start: 2, end: 3, kind: "blur", highlightColor: "#ffd166", highlightOpacity: 0.16 },
    ],
    textClips: [
      { id: "text", start: 4, end: 5, text: "Text", fontFamily: "system-ui", color: "#ffffff", fontSizePx: 38, x: 0.5, y: 0.75 },
    ],
  },
  5,
);

if (SCREENSHOT_RENDER_TIME !== 0) throw new Error("screenshot render time must be fixed");
if (result.zoomFragments.length !== 1 || result.zoomFragments[0]?.id !== "opening") {
  throw new Error("legacy screenshot zoom must preserve the opening-frame appearance");
}
for (const item of [
  ...result.zoomFragments,
  ...result.perspectiveFragments,
  ...result.blurRegions,
  ...result.textClips,
]) {
  if (item.start !== 0 || item.end !== 5) {
    throw new Error("every screenshot edit must cover the complete static image");
  }
}
if (result.zoomFragments[0]?.easeIn !== 0 || result.zoomFragments[0]?.easeOut !== 0) {
  throw new Error("screenshot zoom must not animate");
}
if (result.perspectiveFragments[0]?.easeIn !== 0 || result.perspectiveFragments[0]?.easeOut !== 0) {
  throw new Error("screenshot perspective must not animate");
}

console.log("screenshotStaticTimeline.selfcheck: ok");
