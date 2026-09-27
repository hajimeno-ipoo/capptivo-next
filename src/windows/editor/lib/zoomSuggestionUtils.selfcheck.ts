/** Selfcheck the actual click/press-to-zoom scheduler. */
import assert from "node:assert/strict";
import { buildClickZoomSuggestions } from "./zoomSuggestionUtils.ts";

const click = (t: number) => ({ t, x: 0.5, y: 0.5 });
const span = (params: Parameters<typeof buildClickZoomSuggestions>[0]) => {
  const result = buildClickZoomSuggestions(params);
  assert.equal(result.status, "ok");
  assert.equal(result.suggestions.length, 1);
  return result.suggestions[0]!;
};

const single = span({
  clicks: [click(5)],
  pressIntervals: [{ start: 5, end: 5.1 }],
  duration: 20,
});
assert.equal(single.start, 4, "zoom-in starts one second before the click");
assert.ok(Math.abs(single.end - 6.85) < 1e-9, "release, reading pause, then zoom-out");
assert.equal(single.easeIn, 1);
assert.equal(single.easeOut, 1);
assert.ok(5.1 + 0.75 < single.end, "short click has a full-size hold");

const longPress = span({
  clicks: [click(5)],
  pressIntervals: [{ start: 5, end: 8 }],
  duration: 20,
});
assert.equal(longPress.start, 4);
assert.equal(longPress.end, 9.75, "zoom stays on through a drag or long press");

const missingRelease = span({
  clicks: [click(5)],
  pressIntervals: [{ start: 5, end: Number.POSITIVE_INFINITY }],
  duration: 20,
});
assert.equal(missingRelease.end, 6.75, "a missing mouse-up cannot hold zoom to the end");

const burst = span({
  clicks: [click(5), click(6)],
  pressIntervals: [{ start: 5, end: 5.1 }, { start: 6, end: 6.2 }],
  duration: 20,
});
assert.equal(burst.start, 4);
assert.equal(burst.end, 7.95, "nearby actions share one uninterrupted zoom");

const separated = buildClickZoomSuggestions({ clicks: [click(5), click(9)], duration: 20 });
assert.equal(separated.suggestions.length, 2, "a pause returns to full view");
assert.ok(separated.suggestions[0]!.end < separated.suggestions[1]!.start);

const atStart = span({ clicks: [click(0.2)], duration: 20 });
assert.equal(atStart.start, 0);
assert.equal(atStart.easeIn, 0.2, "the click is fully zoomed even near the start");

const atEnd = span({ clicks: [click(19.8)], duration: 20 });
assert.equal(atEnd.end, 20);
assert.equal(atEnd.easeOut, 0, "no zoom-out is scheduled past the recording");

const reserved = buildClickZoomSuggestions({
  clicks: [click(5)],
  duration: 20,
  reservedSpans: [{ start: 4, end: 7 }],
});
assert.equal(reserved.status, "no-slots", "existing edited zooms remain untouched");

console.log("zoomSuggestionUtils.selfcheck: ok");
