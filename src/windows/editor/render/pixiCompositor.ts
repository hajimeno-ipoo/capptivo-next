/**
 * GPU frame compositor (Pixi). Preview prefers WebGL on WKWebView.
 * Persistent scene graph with per-layer content keys to minimize per-frame work.
 */

// Installed builds serve from `tauri://` with a strict CSP (no unsafe-eval).
// Pixi v8 otherwise refuses WebGL/WebGPU init — black preview + broken export.
import "pixi.js/unsafe-eval";

import {
  BlurFilter,
  Container,
  Graphics,
  PerspectiveMesh,
  Rectangle,
  RenderTexture,
  Sprite,
  Texture,
  autoDetectRenderer,
  type Renderer,
} from "pixi.js";

import {
  BLUR_REGION_STRENGTH,
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_HIGHLIGHT_OPACITY,
  CAMERA_IDENTITY,
  blurRegionPlacement,
  blurRegionIsActive,
  computeCameraTransform,
  contentRectPixelsFromCrop,
  drawBackgroundLayer,
  parseHexColor,
  faceCamShadowPasses,
  getCompositionLayout,
  renderRoundedRectShadowSprite,
  resolveCursorOverlay,
  resolveFaceCamLayout,
  drawTextClips,
  textClipFrameKey,
  type CameraTransform,
} from "@/engine";
import { captionFrameKey, drawCaptions } from "@/captions/drawCaptions";
import {
  recordingShadowPasses,
  resolveRecordingLayoutParams,
} from "../lib/composition";
import {
  computePerspectiveCorners,
  hasPerspectiveEffect,
} from "../lib/perspectiveTransform";
import type { LookState, RenderFrameInputs } from "./renderFrame";
import type {
  FrameCompositor,
  FrameCompositorCaptions,
  FrameCompositorOptions,
  FrameCompositorSurface,
} from "./frameCompositor";
import {
  hasHadSuccessfulGpuContext,
  markGpuContextSucceeded,
} from "./gpuLifecycle";
import { ComposeProfiler } from "./composeProfiler";
import { CanvasLayer } from "./pixi/canvasLayer";
import { OutputSurface } from "./pixi/outputSurface";
import { PixiCursorOverlay } from "./pixi/pixiCursor";
import { RoundedMask } from "./pixi/roundedMask";
import { ShadowLayer } from "./pixi/shadowLayer";
import { SourceTexture } from "./pixi/sourceTexture";
import { decodedImageFor } from "./decodedFrame";

type Rect = { x: number; y: number; width: number; height: number };

/** Reused so the per-frame path allocates nothing the GC has to chase. */
const scratchCrop = new Rectangle();

export async function createPixiFrameCompositor(
  options: FrameCompositorOptions,
): Promise<FrameCompositor> {
  let width = options.width;
  let height = options.height;
  let outputWidth = options.outputWidth ?? width;
  let outputHeight = options.outputHeight ?? height;

  const profiler = new ComposeProfiler(options.profile === true);
  const { renderer, offscreen } = await createRenderer(
    options,
    outputWidth,
    outputHeight,
  );
  const pixiCanvas = renderer.canvas as unknown as FrameCompositorSurface;
  const output = new OutputSurface(
    renderer,
    width,
    height,
    outputWidth,
    outputHeight,
  );
  const stageLongEdge = Math.max(width, height);
  const mipmaps = options.mipmaps === true;
  const perspectiveAntialias = options.antialias !== false;

  const stage = new Container({ label: "stage" });

  const backdrop = new Graphics().rect(0, 0, 1, 1).fill(0x000000);
  backdrop.scale.set(width, height);

  const background = new CanvasLayer("background");
  const recordingShadow = new ShadowLayer("recording-shadow");
  const reflection = new CanvasLayer("recording-reflection");
  const cursorOverlay = new PixiCursorOverlay();
  const captionsLayer = new CanvasLayer("captions");
  const textClipsLayer = new CanvasLayer("text-clips");

  const screenTexture = new SourceTexture("screen", stageLongEdge, { mipmaps });
  const screenSprite = new Sprite();
  const screenMask = new RoundedMask();
  screenSprite.mask = screenMask.graphics;

  /** Recording-anchored subtree — zoom is a transform on this container. */
  const camera = new Container({ label: "camera" });

  /**
   * PerspectiveMesh operates on a texture, not on an arbitrary Container.
   * The camera subtree is therefore rendered into this reusable texture only
   * while a 3D look is active; the other stage layers remain untouched.
   */
  let perspectiveTexture: RenderTexture | null = null;
  let perspectiveTextureWidth = width;
  let perspectiveTextureHeight = height;
  const perspectiveMesh = new PerspectiveMesh({
    // Keep the default (flat) path allocation-free. The full-size render
    // texture is created only after a non-zero 3D look is selected.
    texture: Texture.EMPTY,
    verticesX: 12,
    verticesY: 8,
    x0: 0,
    y0: 0,
    x1: width,
    y1: 0,
    x2: width,
    y2: height,
    x3: 0,
    y3: height,
  });
  perspectiveMesh.visible = false;

  const faceRoot = new Container({ label: "face-cam" });
  const faceShadow = new ShadowLayer("face-shadow");
  const faceTexture = new SourceTexture("camera", stageLongEdge, { mipmaps });
  const faceSprite = new Sprite();
  const faceMask = new RoundedMask();
  faceSprite.mask = faceMask.graphics;
  faceRoot.addChild(faceShadow.sprite, faceSprite, faceMask.graphics);

  const blurLayer = new Container({ label: "blur-regions" });
  const blurMask = new RoundedMask();
  blurLayer.mask = blurMask.graphics;
  const blurSprites: Sprite[] = [];
  const highlightLayer = new Container({ label: "highlight-regions" });
  const highlightGraphics: Graphics[] = [];

  camera.addChild(
    recordingShadow.sprite,
    screenSprite,
    screenMask.graphics,
    reflection.sprite,
    blurLayer,
    blurMask.graphics,
    highlightLayer,
    cursorOverlay.container,
  );
  stage.addChild(
    backdrop,
    background.sprite,
    camera,
    perspectiveMesh,
    faceRoot,
    captionsLayer.sprite,
    textClipsLayer.sprite,
  );

  let readbackCanvas: HTMLCanvasElement | null = null;
  let readbackCtx: CanvasRenderingContext2D | null = null;
  if (options.cpuReadback) {
    readbackCanvas = document.createElement("canvas");
    readbackCanvas.width = outputWidth;
    readbackCanvas.height = outputHeight;
    readbackCtx = readbackCanvas.getContext("2d", { willReadFrequently: true });
    if (!readbackCtx)
      throw new Error("pixi compositor: readback context unavailable");
  }

  function resize(
    nextWidth: number,
    nextHeight: number,
    nextOutputWidth = nextWidth,
    nextOutputHeight = nextHeight,
  ): void {
    if (
      nextWidth === width &&
      nextHeight === height &&
      nextOutputWidth === outputWidth &&
      nextOutputHeight === outputHeight
    ) {
      return;
    }
    width = nextWidth;
    height = nextHeight;
    outputWidth = nextOutputWidth;
    outputHeight = nextOutputHeight;
    resizePerspectiveTexture(nextWidth, nextHeight);
    renderer.resize(outputWidth, outputHeight);
    output.resize(width, height, outputWidth, outputHeight);
    backdrop.scale.set(width, height);
    if (readbackCanvas) {
      readbackCanvas.width = outputWidth;
      readbackCanvas.height = outputHeight;
    }
  }

  function compose(
    inputs: RenderFrameInputs,
    captions?: FrameCompositorCaptions | null,
  ): void {
    // Preview paints can race ahead of the React resize effect; keep the
    // composition buffer aligned with the frame inputs. Preserve output size
    // so GIF/export downscale isn't reset by a stray preview paint.
    if (
      inputs.width > 0 &&
      inputs.height > 0 &&
      (inputs.width !== width || inputs.height !== height)
    ) {
      resize(inputs.width, inputs.height, outputWidth, outputHeight);
    }
    const w = width;
    const h = height;
    const look = inputs.look;
    const zoomScale = inputs.zoomScale ?? 1;
    const zoomFocus = inputs.zoomFocus ?? { x: 0.5, y: 0.5 };
    const zoomTargetScale = inputs.zoomTargetScale;
    const crop = inputs.screenContentCrop ?? null;
    const backgroundImage = inputs.background;

    profiler.begin();

    setCameraTransform(CAMERA_IDENTITY);
    camera.visible = true;
    perspectiveMesh.visible = false;

    background.update({
      key: backgroundImage
        ? `${imageId(backgroundImage)}|${w}x${h}|${look.backgroundBlur}|${look.backgroundDarkness}`
        : null,
      x: 0,
      y: 0,
      width: w,
      height: h,
      draw: (ctx) =>
        drawBackgroundLayer(
          ctx,
          backgroundImage as CanvasImageSource,
          w,
          h,
          look.backgroundBlur,
          look.backgroundDarkness,
        ),
    });
    backdrop.visible = !backgroundImage;
    profiler.mark("background");

    const screenSize = screenTexture.bind(decodedImageFor(inputs.video));
    profiler.mark("screenUpload");

    if (screenSize) {
      const hasSelectedBackground = backgroundImage !== null;
      const hasImageBackground =
        hasSelectedBackground && (inputs.backgroundType ?? "image") === "image";
      const { sourceAspect, devicePadding: basePadding } =
        resolveRecordingLayoutParams({
          presetId: inputs.aspectRatioPresetId ?? "recording",
          sourceAspect: inputs.sourceAspect,
          sourceVideoSize: inputs.sourceVideoSize ?? {
            width: screenSize.width,
            height: screenSize.height,
          },
          hasSelectedBackground,
          hasImageBackground,
          devicePadding: look.devicePadding,
          screenContentCrop: crop,
        });
      const { video: rect } = getCompositionLayout(
        sourceAspect,
        w,
        h,
        basePadding,
      );
      const radius = Math.max(
        0,
        Math.min(look.cornerRadius, Math.min(rect.width, rect.height) / 2),
      );

      updateRecordingShadow(rect, radius, look, !!backgroundImage);
      profiler.mark("shadow");

      const content = crop
        ? contentRectPixelsFromCrop(screenSize.width, screenSize.height, crop)
        : { ox: 0, oy: 0, rw: screenSize.width, rh: screenSize.height };

      screenSprite.visible = true;
      scratchCrop.x = content.ox;
      scratchCrop.y = content.oy;
      scratchCrop.width = content.rw;
      scratchCrop.height = content.rh;
      screenSprite.texture = screenTexture.crop(scratchCrop);
      screenSprite.position.set(rect.x, rect.y);
      screenSprite.setSize(rect.width, rect.height);
      screenMask.set(rect.x, rect.y, rect.width, rect.height, radius);
      updateReflection(rect, radius, look);
      profiler.mark("screenGeometry");

      updateBlurRegions(inputs, screenSize, content, rect, radius, inputs.cursorTime ?? 0);
      profiler.mark("blurRegions");

      updateCursor(inputs, rect);
      profiler.mark("cursor");

      setCameraTransform(
        computeCameraTransform({
          stageWidth: w,
          stageHeight: h,
          videoRect: rect,
          focus: zoomFocus,
          scale: zoomScale,
          targetScale: zoomTargetScale,
        }),
      );
      updateCameraPerspective(look);
    } else {
      screenSprite.texture = Texture.EMPTY;
      screenSprite.visible = false;
      recordingShadow.sprite.visible = false;
      reflection.sprite.visible = false;
      blurLayer.visible = false;
      highlightLayer.visible = false;
      cursorOverlay.hide();
      camera.visible = true;
      perspectiveMesh.visible = false;
    }

    updateFaceCam(inputs, w, h);
    profiler.mark("faceCam");

    captionsLayer.update({
      key: captions
        ? captionFrameKey(
            captions.captions,
            captions.settings,
            w,
            h,
            captions.timeMs,
          )
        : null,
      x: 0,
      y: 0,
      width: w,
      height: h,
      draw: (ctx) =>
        drawCaptions(
          ctx,
          captions!.captions,
          captions!.settings,
          w,
          h,
          captions!.timeMs,
        ),
    });
    profiler.mark("captions");

    textClipsLayer.update({
      key: captions?.textClips
        ? textClipFrameKey(captions.textClips, w, h, captions.timeMs)
        : null,
      x: 0,
      y: 0,
      width: w,
      height: h,
      draw: (ctx) =>
        drawTextClips(ctx, captions?.textClips ?? [], w, h, captions?.timeMs ?? 0),
    });
    profiler.mark("textClips");

    output.present(stage);
    profiler.mark("render");

    if (readbackCtx && readbackCanvas) {
      readbackCtx.clearRect(0, 0, outputWidth, outputHeight);
      readbackCtx.drawImage(pixiCanvas as CanvasImageSource, 0, 0);
      profiler.mark("readback");
    }
  }

  function setCameraTransform(transform: CameraTransform): void {
    camera.scale.set(transform.scale);
    camera.position.set(transform.x, transform.y);
  }

  function updateReflection(rect: Rect, radius: number, look: LookState): void {
    const strength = Math.max(0, Math.min(100, look.reflectionStrength));
    reflection.update({
      key: strength > 0
        ? `${rect.width}:${rect.height}:${radius}:${strength.toFixed(1)}:${look.reflectionStyle}`
        : null,
      ...rect,
      draw: (ctx) => {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(rect.x + radius, rect.y);
        ctx.lineTo(rect.x + rect.width - radius, rect.y);
        ctx.quadraticCurveTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + radius);
        ctx.lineTo(rect.x + rect.width, rect.y + rect.height - radius);
        ctx.quadraticCurveTo(rect.x + rect.width, rect.y + rect.height, rect.x + rect.width - radius, rect.y + rect.height);
        ctx.lineTo(rect.x + radius, rect.y + rect.height);
        ctx.quadraticCurveTo(rect.x, rect.y + rect.height, rect.x, rect.y + rect.height - radius);
        ctx.lineTo(rect.x, rect.y + radius);
        ctx.quadraticCurveTo(rect.x, rect.y, rect.x + radius, rect.y);
        ctx.closePath();
        ctx.clip();
        const alpha = (strength / 100) * 0.38;
        if (look.reflectionStyle === "sharp") {
          const band = ctx.createLinearGradient(
            rect.x, rect.y, rect.x + rect.width, rect.y + rect.height,
          );
          band.addColorStop(0, `rgba(255,255,255,${alpha})`);
          band.addColorStop(0.38, "rgba(255,255,255,0)");
          band.addColorStop(0.64, `rgba(255,255,255,${alpha * 0.65})`);
          band.addColorStop(0.85, "rgba(255,255,255,0)");
          ctx.fillStyle = band;
        } else {
          const glow = ctx.createRadialGradient(
            rect.x + rect.width * 0.24, rect.y + rect.height * 0.02, 0,
            rect.x + rect.width * 0.24, rect.y + rect.height * 0.02,
            Math.max(rect.width, rect.height) * 0.95,
          );
          glow.addColorStop(0, `rgba(255,255,255,${alpha})`);
          glow.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = glow;
        }
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        if (look.reflectionStyle === "dots") {
          const step = Math.max(18, Math.min(rect.width, rect.height) / 20);
          ctx.fillStyle = `rgba(255,255,255,${alpha * 0.65})`;
          for (let y = rect.y + step / 2; y < rect.y + rect.height; y += step) {
            for (let x = rect.x + step / 2; x < rect.x + rect.width; x += step) {
              ctx.beginPath();
              ctx.arc(x, y, step * 0.055, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        ctx.restore();
      },
    });
  }

  function updateCameraPerspective(look: LookState): void {
    if (!hasPerspectiveEffect(look)) {
      camera.visible = true;
      perspectiveMesh.visible = false;
      return;
    }

    const corners = computePerspectiveCorners(width, height, look);
    const target = ensurePerspectiveTexture();
    perspectiveMesh.setCorners(
      corners.topLeft.x,
      corners.topLeft.y,
      corners.topRight.x,
      corners.topRight.y,
      corners.bottomRight.x,
      corners.bottomRight.y,
      corners.bottomLeft.x,
      corners.bottomLeft.y,
    );

    // Render the already-zoomed camera subtree into a transparent texture.
    // The stage renders the mesh afterwards, so face-cam and captions stay flat.
    camera.visible = true;
    renderer.render({
      container: camera,
      target,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
    camera.visible = false;
    perspectiveMesh.visible = true;
  }

  function ensurePerspectiveTexture(): RenderTexture {
    if (perspectiveTexture) return perspectiveTexture;

    perspectiveTexture = createPerspectiveTexture(
      perspectiveTextureWidth,
      perspectiveTextureHeight,
      perspectiveAntialias,
    );
    perspectiveMesh.texture = perspectiveTexture;
    perspectiveMesh.setCorners(
      0,
      0,
      perspectiveTextureWidth,
      0,
      perspectiveTextureWidth,
      perspectiveTextureHeight,
      0,
      perspectiveTextureHeight,
    );
    return perspectiveTexture;
  }

  function resizePerspectiveTexture(nextWidth: number, nextHeight: number): void {
    const changed =
      nextWidth !== perspectiveTextureWidth ||
      nextHeight !== perspectiveTextureHeight;
    perspectiveTextureWidth = nextWidth;
    perspectiveTextureHeight = nextHeight;
    if (!changed || !perspectiveTexture) return;

    const nextTexture = createPerspectiveTexture(
      nextWidth,
      nextHeight,
      perspectiveAntialias,
    );
    const previousTexture = perspectiveTexture;
    perspectiveTexture = nextTexture;
    perspectiveMesh.texture = nextTexture;
    perspectiveMesh.setCorners(
      0,
      0,
      nextWidth,
      0,
      nextWidth,
      nextHeight,
      0,
      nextHeight,
    );
    previousTexture.destroy(true);
  }

  function updateRecordingShadow(
    rect: Rect,
    radius: number,
    look: LookState,
    hasBackground: boolean,
  ): void {
    const intensity = look.recordingShadowIntensity;
    if (!hasBackground || intensity <= 0) {
      recordingShadow.sprite.visible = false;
      return;
    }

    const shortEdge = Math.min(width, height);
    recordingShadow.update({
      key: `${rect.width}x${rect.height}|${radius}|${intensity}|${shortEdge}`,
      bake: (reuse) =>
        renderRoundedRectShadowSprite(
          reuse,
          rect.width,
          rect.height,
          radius,
          recordingShadowPasses(intensity, shortEdge),
        ),
      x: rect.x,
      y: rect.y,
      scaleX: 1,
      scaleY: 1,
    });
  }

  function updateBlurRegions(
    inputs: RenderFrameInputs,
    source: { width: number; height: number },
    content: { ox: number; oy: number; rw: number; rh: number },
    rect: Rect,
    radius: number,
    sourceTime: number,
  ): void {
    const textureSource = screenSprite.texture.source;
    const activeRegions = (inputs.blurRegions ?? []).filter((region) =>
      blurRegionIsActive(region, sourceTime),
    );
    const placements = activeRegions
      .map((region) => ({
        region,
        placement: blurRegionPlacement(region, source.width, source.height, content, rect),
      }))
      .filter((entry) => entry.placement !== null);
    const blurPlacements = placements.filter((entry) => entry.region.kind !== "highlight");
    const highlightPlacements = placements.filter((entry) => entry.region.kind === "highlight");

    blurLayer.visible = blurPlacements.length > 0;
    highlightLayer.visible = highlightPlacements.length > 0;
    if (blurPlacements.length === 0) {
      for (const sprite of blurSprites) sprite.visible = false;
    }

    blurMask.set(rect.x, rect.y, rect.width, rect.height, radius);

    while (blurSprites.length < blurPlacements.length) {
      const sprite = new Sprite();
      sprite.filters = [new BlurFilter({ strength: BLUR_REGION_STRENGTH })];
      blurSprites.push(sprite);
      blurLayer.addChild(sprite);
    }

    blurSprites.forEach((sprite, index) => {
      const placement = blurPlacements[index]?.placement;
      if (!placement) {
        sprite.visible = false;
        return;
      }
      const { x, y, width, height } = placement.source;
      const current = sprite.texture;
      if (current === Texture.EMPTY || current.source !== textureSource) {
        if (current !== Texture.EMPTY) current.destroy(false);
        sprite.texture = new Texture({
          source: textureSource,
          frame: new Rectangle(x, y, width, height),
          label: "blur-region",
          dynamic: true,
        });
      } else {
        const frame = current.frame;
        if (
          frame.x !== x ||
          frame.y !== y ||
          frame.width !== width ||
          frame.height !== height
        ) {
          frame.x = x;
          frame.y = y;
          frame.width = width;
          frame.height = height;
          current.update();
        }
      }
      sprite.visible = true;
      sprite.position.set(placement.dest.x, placement.dest.y);
      sprite.setSize(placement.dest.width, placement.dest.height);
    });

    while (highlightGraphics.length < highlightPlacements.length) {
      const graphic = new Graphics();
      highlightGraphics.push(graphic);
      highlightLayer.addChild(graphic);
    }
    highlightGraphics.forEach((graphic, index) => {
      const entry = highlightPlacements[index];
      const placement = entry?.placement;
      graphic.clear();
      if (!placement) {
        graphic.visible = false;
        return;
      }
      graphic.visible = true;
      const opacity =
        typeof entry.region.highlightOpacity === "number" &&
        Number.isFinite(entry.region.highlightOpacity)
          ? Math.min(1, Math.max(0, entry.region.highlightOpacity))
          : DEFAULT_HIGHLIGHT_OPACITY;
      const color = parseHexColor(entry.region.highlightColor, DEFAULT_HIGHLIGHT_COLOR);
      graphic.rect(
        placement.dest.x,
        placement.dest.y,
        placement.dest.width,
        placement.dest.height,
      ).fill({ color, alpha: opacity }).stroke({
        width: Math.max(2, Math.min(4, rect.width / 480)),
        color,
        alpha: opacity,
      });
    });
  }

  function updateCursor(inputs: RenderFrameInputs, rect: Rect): void {
    const settings = inputs.cursorSettings;
    if (inputs.cursorTime == null || !settings || !inputs.recordingMetadata) {
      cursorOverlay.hide();
      return;
    }

    const frame = resolveCursorOverlay({
      time: inputs.cursorTime,
      settings,
      metadata: inputs.recordingMetadata,
      videoRect: rect,
      screenContentCrop: inputs.screenContentCrop ?? null,
      loopReturn: inputs.cursorLoopReturn ?? null,
    });
    cursorOverlay.update({
      placement: frame?.placement ?? null,
      timeSec: inputs.cursorTime,
      freeze: inputs.cursorFreeze === true,
      videoRect: rect,
      smoothness: settings.smoothness,
      sway: settings.sway,
      motionBlur: settings.motionBlur,
      clickShrink: settings.clickShrink,
      clickEffect: settings.clickEffect,
      pressIntervals: inputs.recordingMetadata.cursorPressIntervals,
    });
  }

  function updateFaceCam(
    inputs: RenderFrameInputs,
    w: number,
    h: number,
  ): void {
    const cameraSize = faceTexture.bind(decodedImageFor(inputs.cameraVideo));
    const faceCam = inputs.faceCam;

    const layout = cameraSize
      ? resolveFaceCamLayout(cameraSize.width, cameraSize.height, w, h, {
          shadowIntensity: faceCam?.shadowIntensity ?? 100,
          forceCircle: faceCam?.isRound === true,
          cornerRoundness: faceCam?.isRound ? undefined : faceCam?.roundness,
          widthPx: faceCam?.widthPx,
          heightPx: faceCam?.isRound ? faceCam?.widthPx : faceCam?.heightPx,
          corner: faceCam?.corner,
          crop: faceCam?.crop ?? null,
          positionOverride: faceCam?.position ?? null,
          presenceScale: inputs.faceCamPresenceScale,
          marginPx: faceCam?.marginPx,
        })
      : null;

    if (!layout) {
      faceRoot.visible = false;
      // Same as screen: `bind` can destroy the crop texture underneath us.
      faceSprite.texture = Texture.EMPTY;
      faceShadow.sprite.visible = false;
      return;
    }

    const {
      x,
      y,
      camWidth,
      camHeight,
      corner,
      presenceScale,
      cornerRadius,
      shadow,
    } = layout;
    faceRoot.visible = true;

    const anchorX =
      corner === "top-left" || corner === "bottom-left" ? 0 : camWidth;
    const anchorY =
      corner === "top-left" || corner === "top-right" ? 0 : camHeight;
    faceRoot.position.set(x + anchorX, y + anchorY);
    faceRoot.pivot.set(anchorX, anchorY);
    faceRoot.scale.set(presenceScale);

    faceShadow.update({
      key: `${shadow.w}x${shadow.h}|${shadow.r}|${faceCam?.shadowIntensity ?? 100}`,
      bake: (reuse) =>
        renderRoundedRectShadowSprite(
          reuse,
          shadow.w,
          shadow.h,
          shadow.r,
          faceCamShadowPasses(shadow),
        ),
      x: 0,
      y: 0,
    });

    scratchCrop.x = layout.sourceX;
    scratchCrop.y = layout.sourceY;
    scratchCrop.width = layout.sourceWidth;
    scratchCrop.height = layout.sourceHeight;
    faceSprite.texture = faceTexture.crop(scratchCrop);
    faceSprite.setSize(camWidth, camHeight);
    const mirrored = faceCam?.mirrored !== false;
    if (mirrored) {
      faceSprite.scale.x = -Math.abs(faceSprite.scale.x);
      faceSprite.position.set(camWidth, 0);
    } else {
      faceSprite.scale.x = Math.abs(faceSprite.scale.x);
      faceSprite.position.set(0, 0);
    }
    faceMask.set(0, 0, camWidth, camHeight, cornerRadius);
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // After CONTEXT_LOST, Pixi destroy can spam
    // INVALID_OPERATION: loseContext: context already lost — swallow and move on.
    try {
      // Before the renderer goes: an outstanding fence or pack buffer would
      // otherwise pin GPU memory for the life of the editor session.
      releaseAllPackSlots();
      screenTexture.destroy();
      faceTexture.destroy();
      background.destroy();
      cursorOverlay.destroy();
      captionsLayer.destroy();
      recordingShadow.destroy();
      reflection.destroy();
      faceShadow.destroy();
      screenMask.destroy();
      faceMask.destroy();
      output.destroy();
      stage.removeChild(perspectiveMesh);
      perspectiveMesh.destroy();
      perspectiveTexture?.destroy(true);
      perspectiveTexture = null;
      stage.destroy({ children: true });
      renderer.destroy();
    } catch (e) {
      console.warn("[compositor] dispose after GPU loss (ignored)", e);
    }
  }

  console.info(
    `[compositor] pixi ready: gpu=${renderer.type === 2 ? "webgpu" : "webgl"} ` +
      `surface=${offscreen ? "offscreen" : "canvas"} antialias=${options.antialias !== false} ` +
      `mipmaps=${mipmaps} composition=${width}x${height} ` +
      `output=${outputWidth}x${outputHeight} downscale=${output.needsDownscale}`,
  );

  /**
   * Pixi's WebGL2 context.
   *
   * `GlContextSystem` assigns it onto the renderer (`this._renderer.gl = gl`)
   * and Pixi's own `GlTextureSystem.getPixels` reads it back exactly this way,
   * but it is absent from the published type definitions — hence the cast.
   * Feature-detected rather than assumed: a WebGPU backend, or a future Pixi
   * that stops exposing it, makes `readPixelsInto` return false and the caller
   * falls back instead of the export breaking.
   */
  function glContext(): WebGL2RenderingContext | null {
    if (typeof WebGL2RenderingContext === "undefined") return null;
    const candidate = (renderer as unknown as { gl?: unknown }).gl;
    return candidate instanceof WebGL2RenderingContext ? candidate : null;
  }

  function readPixelsInto(target: Uint8Array): boolean {
    const gl = glContext();
    if (!gl) return false;
    if (target.length !== outputWidth * outputHeight * 4) return false;

    // `compose()` ends with a render to the canvas, which is the default
    // framebuffer (Pixi's back buffer is off by default and export does not
    // enable it). Pixi may still have a render target bound afterwards, so bind
    // the default explicitly — and restore whatever was there, because Pixi
    // caches its own binding state and would not expect us to have changed it.
    const previous = gl.getParameter(
      gl.FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(
      0,
      0,
      outputWidth,
      outputHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      target,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    return true;
  }

  /**
   * One outstanding asynchronous read: a pixel-pack buffer holding the pixels
   * and a fence that says when the GPU has actually finished writing them.
   */
  type PackSlot = {
    pbo: WebGLBuffer;
    sync: WebGLSync;
    /** Bytes the slot was sized for — a resize mid-export invalidates it. */
    byteLength: number;
  };
  const packSlots = new Map<number, PackSlot>();
  let nextTicket = 1;

  function releaseSlot(gl: WebGL2RenderingContext, ticket: number): void {
    const slot = packSlots.get(ticket);
    if (!slot) return;
    packSlots.delete(ticket);
    gl.deleteSync(slot.sync);
    gl.deleteBuffer(slot.pbo);
  }

  function beginReadPixels(): number | null {
    const gl = glContext();
    if (!gl) return null;

    const byteLength = outputWidth * outputHeight * 4;
    const pbo = gl.createBuffer();
    if (!pbo) return null;

    const previousFbo = gl.getParameter(
      gl.FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLength, gl.STREAM_READ);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // With a pack buffer bound, the last argument is a byte *offset* into it,
    // not a CPU array — this returns without waiting for the transfer.
    gl.readPixels(
      0,
      0,
      outputWidth,
      outputHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      0,
    );
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    // Restore Pixi's bindings: it caches its own state and does not expect us
    // to have changed either the framebuffer or the pack buffer.
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFbo);

    if (!sync) {
      gl.deleteBuffer(pbo);
      return null;
    }

    // Without an explicit flush, ANGLE/WebView2 often never submits the pack +
    // fence when nothing is presenting — `clientWaitSync` then stays
    // TIMEOUT_EXPIRED forever and export dies on the stall watchdog.
    gl.flush();

    const ticket = nextTicket++;
    packSlots.set(ticket, { pbo, sync, byteLength });
    return ticket;
  }

  function tryFinishReadPixels(
    ticket: number,
    target: Uint8Array,
    force = false,
  ): "pending" | "done" | "failed" {
    const gl = glContext();
    if (!gl) return "failed";
    const slot = packSlots.get(ticket);
    if (!slot) return "failed";
    if (target.length !== slot.byteLength) {
      releaseSlot(gl, ticket);
      return "failed";
    }

    if (!force) {
      // Timeout 0 — poll, never block. A non-zero timeout here would put the
      // synchronous stall straight back into the loop.
      const status = gl.clientWaitSync(slot.sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) return "pending";
      if (status === gl.WAIT_FAILED) {
        releaseSlot(gl, ticket);
        return "failed";
      }
      // ALREADY_SIGNALED / CONDITION_SATISFIED — the pixels are there.
    } else {
      // Rare WebView2 path: fence never polls as signalled. `finish()` drains
      // the queue so the pack buffer is safe to map; caller latches to sync
      // readback after this so we only pay the stall once.
      gl.finish();
    }

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, target);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    releaseSlot(gl, ticket);
    return "done";
  }

  /** Drop every outstanding pack buffer and fence — called from `dispose`. */
  function releaseAllPackSlots(): void {
    const gl = glContext();
    if (!gl) {
      packSlots.clear();
      return;
    }
    for (const ticket of [...packSlots.keys()]) releaseSlot(gl, ticket);
  }

  return {
    get canvas() {
      return readbackCanvas ?? pixiCanvas;
    },
    get readback() {
      return readbackCtx;
    },
    readPixelsInto,
    beginReadPixels,
    tryFinishReadPixels,
    backend: "pixi",
    resize,
    compose,
    stats: () => profiler.report(),
    uploadStats: () => {
      const screen = screenTexture.stats();
      const face = faceTexture.stats();
      return {
        uploads: screen.uploads + face.uploads,
        skipped: screen.skipped + face.skipped,
      };
    },
    dispose,
  };
}

function createPerspectiveTexture(
  width: number,
  height: number,
  antialias: boolean,
): RenderTexture {
  return RenderTexture.create({
    width: Math.max(1, width),
    height: Math.max(1, height),
    antialias,
    autoGenerateMipmaps: false,
    label: "camera-perspective",
  });
}

/** Build renderer; export requires offscreen (`requireOffscreen`). */
async function createRenderer(
  options: FrameCompositorOptions,
  width: number,
  height: number,
): Promise<{ renderer: Renderer; offscreen: boolean }> {
  const preferences = options.gpuPreference?.length
    ? options.gpuPreference
    : (["webgpu", "webgl"] as const);

  const base = {
    width,
    height,
    antialias: options.antialias !== false,
    background: 0x000000,
    backgroundAlpha: 1,
    resolution: 1,
    autoDensity: false,
    preserveDrawingBuffer:
      options.preserveDrawingBuffer === true || options.cpuReadback === true,
    hello: false,
    // Prefer a context even when the driver looks "slow" — export would
    // otherwise fail with a misleading "browser does not support WebGL".
    failIfMajorPerformanceCaveat: false,
    powerPreference: "high-performance" as const,
  };

  const tryPreferences = async (
    canvas?: HTMLCanvasElement,
  ): Promise<Renderer> => {
    const errors: string[] = [];
    for (const preference of preferences) {
      if (
        preference === "webgpu" &&
        !(typeof navigator !== "undefined" && "gpu" in navigator)
      ) {
        errors.push("webgpu: navigator.gpu unavailable");
        continue;
      }
      try {
        return (await autoDetectRenderer({
          ...base,
          preference,
          ...(canvas ? { canvas } : {}),
        })) as Renderer;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        errors.push(`${preference}: ${detail}`);
        console.warn(
          `[compositor] ${preference} init failed; trying next backend`,
          e,
        );
      }
    }
    if (hasHadSuccessfulGpuContext()) {
      throw new Error(
        "GPU context unavailable after a graphics reset (WebGL context was lost). " +
          `Reclaim or reload the editor, then retry. (${errors.join(" | ") || "no preferences"})`,
      );
    }
    throw new Error(
      `no GPU renderer available (${errors.join(" | ") || "no preferences"})`,
    );
  };

  if (options.offscreen && typeof OffscreenCanvas !== "undefined") {
    try {
      const renderer = await tryPreferences(
        new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement,
      );
      markGpuContextSucceeded();
      return { renderer, offscreen: true };
    } catch (e) {
      if (options.requireOffscreen) {
        const detail = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line preserve-caught-error -- ErrorOptions.cause not in this TS lib target
        throw new Error(
          "export requires an OffscreenCanvas GPU surface (presentation-path " +
            `fallback would pace encode to the display refresh): ${detail}`,
        );
      }
      console.warn(
        "[compositor] offscreen surface unavailable; rendering through the " +
          "presentation path (may be paced by the display refresh)",
        e,
      );
    }
  } else if (options.requireOffscreen) {
    throw new Error(
      "export requires OffscreenCanvas, which is unavailable in this environment",
    );
  }

  const renderer = await tryPreferences();
  markGpuContextSucceeded();
  return { renderer, offscreen: false };
}

/** WeakMap identity keys for per-frame cache invalidation. */
function identityKeyer(): (value: object) => number {
  const ids = new WeakMap<object, number>();
  let next = 1;
  return (value) => {
    let id = ids.get(value);
    if (id === undefined) {
      id = next++;
      ids.set(value, id);
    }
    return id;
  };
}

const imageIdOf = identityKeyer();

function imageId(image: CanvasImageSource): number {
  return imageIdOf(image as unknown as object);
}
