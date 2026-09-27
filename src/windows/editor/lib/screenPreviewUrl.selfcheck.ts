/** Selfcheck: screen preview URL prefers the original recording. */
import { screenPreviewUrl } from "./screenPreviewUrl.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(
  screenPreviewUrl("media://proxy", "media://screen") === "media://screen",
  "original wins when present",
);
assert(
  screenPreviewUrl("media://proxy", null) === "media://proxy",
  "falls back to proxy when original is missing",
);
assert(screenPreviewUrl(null, null) === null, "both missing → null");

console.log("screenPreviewUrl.selfcheck: ok");
