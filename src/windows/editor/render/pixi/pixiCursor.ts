/**
 * Cursor glyphs as Pixi sprites, parented under the camera container.
 *
 * Tip position is always in *unzoomed* recording-rect space; the camera's
 * scale/translate is the only zoom. A spring chases the recorded tip between
 * frames; clicks and seeks snap so the tip still lands on the button.
 */

import { Container, Graphics, Sprite, Texture } from "pixi.js";
import {
  CursorMotionState,
  cursorBounceScale,
  cursorClickFxProgress,
  nearCursorClick,
  type CursorClickEffectId,
} from "@/engine/cursorMotion";
import type { CursorAsset, CursorPlacementFrame } from "@/engine";
import { RoundedMask } from "./roundedMask";

export type PixiCursorUpdate = {
  placement: CursorPlacementFrame | null;
  timeSec: number;
  /** Seek / scrub / pause — snap the spring. */
  freeze: boolean;
  videoRect: { x: number; y: number; width: number; height: number };
  videoCornerRadius: number;
  flashPoint: { x: number; y: number } | null;
  smoothness: number;
  sway: number;
  motionBlur: number;
  /** 0–0.4 bounce intensity (settings.clickShrink). */
  clickShrink: number;
  clickEffect: CursorClickEffectId;
  pressIntervals: readonly { start: number; end: number }[] | undefined;
};

export class PixiCursorOverlay {
  readonly container = new Container({ label: "cursor" });

  private readonly motion = new CursorMotionState();
  private readonly pool: Sprite[] = [];
  private readonly flashLayer = new Container({ label: "cursor-flash" });
  private readonly flashDim = new Graphics({ label: "cursor-flash-dim" });
  private readonly flashMask = new RoundedMask();
  private readonly flashGlow = new Sprite(createFlashGlowTexture());
  private readonly flashRing = new Graphics({ label: "cursor-flash-ring" });
  private readonly fx = new Graphics({ label: "cursor-fx" });
  private readonly textures = new WeakMap<object, Texture>();

  constructor() {
    this.flashGlow.anchor.set(0.5);
    this.flashLayer.addChild(this.flashDim, this.flashGlow, this.flashRing);
    this.flashLayer.mask = this.flashMask.graphics;
    this.flashLayer.visible = false;
    this.container.addChild(this.flashLayer, this.flashMask.graphics, this.fx);
  }

  update(input: PixiCursorUpdate): void {
    const { placement } = input;
    if (!placement || placement.stamps.length === 0) {
      this.hide();
      return;
    }

    this.container.visible = true;
    const { videoRect: rect } = input;
    const rw = Math.max(1e-9, rect.width);
    const rh = Math.max(1e-9, rect.height);

    const heads = headStamps(placement.stamps);
    const head = heads[heads.length - 1]!;
    const targetNdc = {
      x: (head.x - rect.x) / rw,
      y: (head.y - rect.y) / rh,
    };

    const smoothed = this.motion.update(targetNdc, input.timeSec, {
      smoothness: input.smoothness,
      sway: input.sway,
      motionBlur: input.motionBlur,
      freeze: input.freeze,
      nearClick: nearCursorClick(input.pressIntervals, input.timeSec),
    });

    const bounce = cursorBounceScale(
      input.pressIntervals,
      input.timeSec,
      input.clickShrink,
    );

    const tipX = rect.x + smoothed.x * rw;
    const tipY = rect.y + smoothed.y * rh;

    const rendered: CursorPlacementFrame["stamps"] = [];
    const trailLen = smoothed.trail.length;
    for (let i = trailLen - 1; i >= 0; i -= 1) {
      const p = smoothed.trail[i]!;
      const age = (i + 1) / (trailLen + 1);
      rendered.push({
        x: rect.x + p.x * rw,
        y: rect.y + p.y * rh,
        alpha:
          head.alpha * 0.22 * (1 - age) * Math.min(1, input.motionBlur + 0.15),
        rotate: 0,
        pressScale: 1,
        asset: head.asset,
      });
    }
    for (const s of heads) {
      rendered.push({
        x: tipX,
        y: tipY,
        alpha: s.alpha,
        rotate: smoothed.rotation,
        pressScale: bounce,
        asset: s.asset,
      });
    }

    this.drawStamps(placement.height, rendered);
    const progress = cursorClickFxProgress(
      input.pressIntervals,
      input.timeSec,
      input.clickEffect,
    );
    this.drawFlash(
      rect,
      input.videoCornerRadius,
      input.flashPoint,
      placement.height,
      progress,
      input.clickEffect,
    );
    this.drawFx(
      tipX,
      tipY,
      placement.height * bounce,
      progress,
      input.clickEffect,
    );
  }

  hide(): void {
    for (const s of this.pool) s.visible = false;
    this.flashLayer.visible = false;
    this.fx.clear();
    this.container.visible = false;
  }

  destroy(): void {
    for (const s of this.pool) s.destroy();
    this.pool.length = 0;
    this.flashGlow.destroy({ texture: true, textureSource: true });
    this.flashDim.destroy();
    this.flashRing.destroy();
    this.flashMask.destroy();
    this.flashLayer.destroy({ children: false });
    this.fx.destroy();
    this.container.destroy({ children: false });
  }

  private drawFlash(
    rect: PixiCursorUpdate["videoRect"],
    cornerRadius: number,
    point: PixiCursorUpdate["flashPoint"],
    cursorSize: number,
    progress: number,
    effect: CursorClickEffectId,
  ): void {
    if (effect !== "flash" || progress <= 0 || !point) {
      this.flashLayer.visible = false;
      return;
    }

    this.flashLayer.visible = true;
    this.flashMask.set(rect.x, rect.y, rect.width, rect.height, cornerRadius);
    this.flashDim.clear().rect(rect.x, rect.y, rect.width, rect.height).fill({
      color: 0x000000,
      alpha: progress * 0.58,
    });

    const radius = Math.min(
      Math.max(72, cursorSize * 2.2),
      Math.min(rect.width, rect.height) * 0.22,
    );
    this.flashGlow.position.set(point.x, point.y);
    this.flashGlow.setSize(radius * 2, radius * 2);
    this.flashGlow.alpha = progress;
    this.flashRing.clear().circle(
      point.x,
      point.y,
      Math.max(24, cursorSize * 0.65),
    ).stroke({ color: 0xffffff, width: 2.5, alpha: progress * 0.9 });
  }

  private drawStamps(
    height: number,
    stamps: CursorPlacementFrame["stamps"],
  ): void {
    while (this.pool.length < stamps.length) {
      const sprite = new Sprite();
      this.pool.push(sprite);
      this.container.addChild(sprite);
    }
    if (this.fx.parent === this.container) {
      this.container.setChildIndex(this.fx, 0);
    }

    for (let i = 0; i < this.pool.length; i += 1) {
      const sprite = this.pool[i]!;
      const stamp = stamps[i];
      if (!stamp) {
        sprite.visible = false;
        continue;
      }

      const texture = this.textureFor(stamp.asset);
      if (sprite.texture !== texture) sprite.texture = texture;

      const aspect =
        stamp.asset.image.naturalHeight > 0
          ? stamp.asset.image.naturalWidth / stamp.asset.image.naturalHeight
          : 1;
      const h = height * stamp.pressScale;
      const w = h * aspect;

      sprite.anchor.set(stamp.asset.anchorX, stamp.asset.anchorY);
      sprite.setSize(w, h);
      sprite.alpha = stamp.alpha;
      sprite.rotation = stamp.rotate;
      sprite.position.set(stamp.x, stamp.y);
      sprite.visible = true;
    }
  }

  private drawFx(
    px: number,
    py: number,
    cursorSize: number,
    progress: number,
    effect: CursorClickEffectId,
  ): void {
    this.fx.clear();
    if (effect === "none" || effect === "flash" || progress <= 0) return;

    const reveal = 1 - progress;
    const baseRadius = Math.max(12, cursorSize * 0.55);

    if (effect === "ripple") {
      // One clear cyan wave travels outward from the press.
      const radius = baseRadius * 0.4 + reveal * cursorSize * 1.8;
      this.fx.circle(px, py, radius);
      this.fx.stroke({
        width: Math.max(2.5, cursorSize * 0.08),
        color: 0x06b6d4,
        alpha: progress * 0.9,
      });
      return;
    }

    if (effect === "spotlight") {
      // Filled amber layers illuminate the target instead of drawing rings.
      const glowRadius = baseRadius + reveal * cursorSize * 0.45;
      this.fx.circle(px, py, glowRadius * 1.35);
      this.fx.fill({ color: 0xf59e0b, alpha: progress * 0.1 });
      this.fx.circle(px, py, glowRadius);
      this.fx.fill({ color: 0xf59e0b, alpha: progress * 0.18 });
      this.fx.circle(px, py, glowRadius * 0.55);
      this.fx.fill({ color: 0xf59e0b, alpha: progress * 0.25 });
      return;
    }

    // Three violet waves begin at different times, like repeated echoes.
    for (const delay of [0, 0.25, 0.5]) {
      const phase = (reveal - delay) / (1 - delay);
      if (phase < 0 || phase >= 1) continue;
      this.fx.circle(px, py, baseRadius * 0.45 + phase * cursorSize * 1.5);
      this.fx.stroke({
        width: Math.max(2, cursorSize * 0.065),
        color: 0xa855f7,
        alpha: (1 - phase) * 0.75,
      });
    }
  }

  private textureFor(asset: CursorAsset): Texture {
    const key = asset.image as object;
    const hit = this.textures.get(key);
    if (hit) return hit;
    const texture = Texture.from(asset.image);
    this.textures.set(key, texture);
    return texture;
  }
}

function createFlashGlowTexture(): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("cursor flash: canvas context unavailable");
  const glow = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  glow.addColorStop(0, "rgba(255,255,255,0.98)");
  glow.addColorStop(0.24, "rgba(255,250,225,0.7)");
  glow.addColorStop(0.55, "rgba(255,250,225,0.15)");
  glow.addColorStop(1, "rgba(255,250,225,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 128, 128);
  return Texture.from(canvas);
}

/** Last stamp, or last two when they share a tip (shape crossfade). */
function headStamps(
  stamps: CursorPlacementFrame["stamps"],
): CursorPlacementFrame["stamps"] {
  const n = stamps.length;
  if (n === 0) return [];
  if (
    n >= 2 &&
    stamps[n - 1]!.x === stamps[n - 2]!.x &&
    stamps[n - 1]!.y === stamps[n - 2]!.y &&
    stamps[n - 1]!.asset !== stamps[n - 2]!.asset
  ) {
    return stamps.slice(n - 2);
  }
  return stamps.slice(n - 1);
}
