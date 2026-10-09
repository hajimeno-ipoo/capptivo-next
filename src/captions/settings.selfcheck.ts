/** Selfcheck: caption fonts survive saved-project and preset JSON round trips. */

import {
  CAPTION_FONT_OPTIONS,
  DEFAULT_CAPTION_SETTINGS,
  parseCaptionSettings,
} from "./settings.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const families = [
  ...CAPTION_FONT_OPTIONS.map(({ value }) => value),
  '"Hiragino Sans"',
  '"ヒラギノ角ゴシック"',
  '"CapptivoFont-7e39c2a4"',
  '"Poppins", "Hiragino Sans", sans-serif',
  '"Inter", "Noto Sans JP", sans-serif',
  '"International Gothic", serif',
  '"Monotype Japanese", sans-serif',
  '"New Custom Family", serif',
];

for (const fontFamily of families) {
  const raw = {
    ...DEFAULT_CAPTION_SETTINGS,
    enabled: true,
    fontFamily,
    fontSizePx: 52,
    bottomOffsetPx: 72,
  };
  const serialized = JSON.stringify(raw);
  const parsed = parseCaptionSettings(JSON.parse(serialized));
  assert(parsed.fontFamily === fontFamily, `${fontFamily}: saved family must survive parsing`);
  assert(parsed.enabled, `${fontFamily}: enabled setting must survive parsing`);
  assert(parsed.fontSizePx === 52, `${fontFamily}: font size must survive parsing`);
  assert(parsed.bottomOffsetPx === 72, `${fontFamily}: position must survive parsing`);
  assert(JSON.stringify(raw) === serialized, `${fontFamily}: input must remain unchanged`);
  assert(
    parseCaptionSettings(JSON.parse(JSON.stringify(parsed))).fontFamily === fontFamily,
    `${fontFamily}: parsing the saved result must remain stable`,
  );
}

for (const fontFamily of [undefined, null, false, 42, {}, [], "", " \t\n "]) {
  assert(
    parseCaptionSettings({ fontFamily }).fontFamily === DEFAULT_CAPTION_SETTINGS.fontFamily,
    `invalid family ${JSON.stringify(fontFamily)} must use the default`,
  );
}

assert(
  parseCaptionSettings({ fontFamily: '  "Hiragino Sans"  ' }).fontFamily === '"Hiragino Sans"',
  "surrounding whitespace must be trimmed without replacing the family",
);
assert(
  parseCaptionSettings({
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  }).fontFamily === DEFAULT_CAPTION_SETTINGS.fontFamily,
  "the previous default stack must retain its existing migration",
);

console.log("settings.selfcheck: ok");
