import { textClipIsActive, type TextClip } from "./textClips";

function colorToCss(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#ffffff";
}

function fontFamilyForCanvas(value: string): string {
  const family = value.trim();
  if (!family) return "system-ui";
  // Existing projects may contain a complete CSS fallback stack. A single
  // Core Text family name, however, needs quotes when it contains spaces.
  if (family.includes(",") || family.includes("\"") || family.includes("'")) {
    return family;
  }
  return JSON.stringify(family);
}

/** Draw free-form text clips in composition coordinates. */
export function drawTextClips(
  ctx: CanvasRenderingContext2D,
  clips: TextClip[],
  width: number,
  height: number,
  timeMs: number,
): void {
  const active = clips.filter((clip) => textClipIsActive(clip, timeMs / 1000) && clip.text.trim());
  if (active.length === 0) return;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0, 0, 0, 0.38)";
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;
  for (const clip of active) {
    const fontSize = Math.max(12, clip.fontSizePx);
    const lineHeight = fontSize * 1.2;
    const lines = clip.text.split(/\r?\n/).slice(0, 20);
    const centerX = Math.max(0, Math.min(width, clip.x * width));
    const centerY = Math.max(0, Math.min(height, clip.y * height));
    ctx.font = `${fontSize}px ${fontFamilyForCanvas(clip.fontFamily)}`;
    ctx.fillStyle = colorToCss(clip.color);
    const firstY = centerY - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, index) => ctx.fillText(line, centerX, firstY + index * lineHeight));
  }
  ctx.restore();
}

export function textClipFrameKey(
  clips: TextClip[],
  width: number,
  height: number,
  timeMs: number,
): string | null {
  const active = clips
    .filter((clip) => textClipIsActive(clip, timeMs / 1000) && clip.text.trim())
    .map((clip) => ({
      id: clip.id,
      text: clip.text,
      fontFamily: clip.fontFamily,
      color: clip.color,
      fontSizePx: clip.fontSizePx,
      x: clip.x,
      y: clip.y,
    }));
  return active.length > 0 ? `${width}x${height}|${JSON.stringify(active)}` : null;
}
