/**
 * Preview column matching the web editor: centered canvas + playback bar,
 * then a full-bleed timeline docked to the bottom of the column.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type MutableRefObject,
} from "react";
import {
  computeCursorLoopReturn,
  clickSamplesBetween,
  playGeneratedClick,
  speedAtTime,
  findActivePerspectiveFragment,
  findSegmentIndexAtTime,
  getNextPlayableTime,
  preloadCursorAssets,
} from "@/engine";
import { useEditorStore } from "../store";
import {
  resolvePerspectiveLook,
  resolveZoomReactiveState,
} from "../render/renderFrame";
import {
  createFrameCompositor,
  type FrameCompositor,
  type FrameCompositorSurface,
} from "../render/createFrameCompositor";
import {
  markPreviewGpuHeld,
  releasePreviewGpu,
} from "../render/previewGpuGate";
import {
  attachContextLossHandlers,
  decideRecovery,
  reclaimGpuAfterLoss,
} from "../render/gpuLifecycle";
import { showError } from "@/lib/toast";
import { translateNow } from "@/lib/i18n";
import { trackVideoFrames, videoFrameStamp } from "../render/videoFrameTrack";
import { useStageDimensions } from "../lib/useStageDimensions";
import { resolveZoomCompositionLayout } from "../lib/composition";
import { getZoomPanAtTime } from "../lib/zoomCache";
import { SCREENSHOT_RENDER_TIME } from "../lib/screenshotStaticTimeline";
import {
  isEditorTypingTarget,
  presentableVideoTime,
  primePausedVideoFrame,
  publishPlaybackTime,
  toggleEditorPlayback,
} from "../lib/playback";
import { PlaybackControls } from "./PlaybackControls";
import { useSameOriginMediaUrl } from "../lib/useSameOriginMediaUrl";
import { mediaDuration } from "../lib/mediaDuration";
import {
  faceCamFrameAt,
  faceCamPlaybackRate,
  screenClockIsRolling,
  shouldSeekFaceCam,
} from "../lib/faceCamSync";
import {
  MEDIA_DIRECT_PREVIEW_LIMIT,
  probeMediaSize,
} from "../lib/mediaBlobUrl";
import { useI18n } from "@/lib/settings";
import { mediaUrl } from "@/lib/platform";
import { toBlobMediaUrl } from "../lib/mediaBlobUrl";
import { DEFAULT_SCREENSHOT_EDITS, drawScreenshotMarks, screenshotStage } from "../screenshotModel";

/** The hidden <video> lives here but is owned by the parent so the full-width
 *  timeline (a sibling, not a child) can seek it too. */
export function PreviewStage({
  videoRef,
  screenshotFrameRef,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  screenshotFrameRef?: MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<HTMLVideoElement | null>(null);
  /** Requests a single paused-state repaint; assigned by the render effect. */
  const requestPaintRef = useRef<() => void>(() => {});
  const compositorRef = useRef<FrameCompositor | null>(null);
  const screenshotSourceRef = useRef<HTMLCanvasElement | null>(null);
  const screenshotImageRef = useRef<HTMLImageElement | null>(null);
  const screenshotId = useEditorStore((s) => s.screenshotId);
  const screenshotMarks = useEditorStore((s) => s.screenshotMarks);
  const screenshotSourceSize = useEditorStore((s) => s.sourceVideoSize);

  useEffect(() => {
    screenshotSourceRef.current = null;
    screenshotImageRef.current = null;
    if (!screenshotId) return;
    let cancelled = false;
    let revoke: (() => void) | null = null;
    void (async () => {
      try {
        const blob = await toBlobMediaUrl(mediaUrl(screenshotId, "original.png"));
        revoke = blob.revoke;
        const image = new Image();
        image.src = blob.src;
        await image.decode();
        if (cancelled) return;
        screenshotImageRef.current = image;
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        screenshotSourceRef.current = canvas;
        canvas.getContext("2d")?.drawImage(image, 0, 0);
        drawScreenshotMarks(canvas, { width: canvas.width, height: canvas.height },
          { ...DEFAULT_SCREENSHOT_EDITS, marks: useEditorStore.getState().screenshotMarks }, false, "color");
        requestPaintRef.current();
      } catch (error) {
        if (!cancelled) showError(String(error));
      }
    })();
    return () => { cancelled = true; revoke?.(); };
  }, [screenshotId]);

  useEffect(() => {
    const image = screenshotImageRef.current;
    const canvas = screenshotSourceRef.current;
    if (!image || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    drawScreenshotMarks(canvas, { width: canvas.width, height: canvas.height },
      { ...DEFAULT_SCREENSHOT_EDITS, marks: screenshotMarks }, false, "color");
    requestPaintRef.current();
  }, [screenshotMarks]);

  const { t: translate } = useI18n();
  const screenUrl = useEditorStore((s) => s.screenUrl);
  const proxyUrl = useEditorStore((s) => s.proxyUrl);
  const proxyPending = useEditorStore((s) => s.proxyPending);
  const cameraUrl = useEditorStore((s) => s.cameraUrl);

  /**
   * `null` until probed. `true` = the original is small enough to preview
   * directly while the proxy transcodes; `false` = wait for the proxy instead.
   */
  const [originalIsSmall, setOriginalIsSmall] = useState<boolean | null>(null);

  useEffect(() => {
    if (!screenUrl) {
      setOriginalIsSmall(null);
      return;
    }
    const ac = new AbortController();
    setOriginalIsSmall(null);
    void probeMediaSize(screenUrl, { signal: ac.signal })
      .then((size) => {
        if (!ac.signal.aborted) {
          setOriginalIsSmall(
            size === null || size <= MEDIA_DIRECT_PREVIEW_LIMIT,
          );
        }
      })
      .catch(() => {
        if (!ac.signal.aborted) setOriginalIsSmall(true);
      });
    return () => ac.abort();
  }, [screenUrl]);

  const waitingForProxy = proxyPending && originalIsSmall === false;
  const previewUrl = proxyUrl ?? (waitingForProxy ? null : screenUrl);
  const playbackUrl = useSameOriginMediaUrl(previewUrl);
  const playbackCameraUrl = useSameOriginMediaUrl(cameraUrl);

  const isPlaying = useEditorStore((s) => s.isPlaying);
  const muted = useEditorStore((s) => s.muted);
  const volume = useEditorStore((s) => s.volume);

  /**
   * The cam source actually mounted, which lags `playbackCameraUrl` on purpose.
   *
   * The first time a fresh take is opened, `ensure_camera_track` finds no
   * normalized MP4, transcodes on a background thread and republishes the
   * face-cam through `project://camera-ready` — mid-session, and usually mid
   * play. Feeding that straight to `key` remounts the element cold: it reports
   * no duration until the new file loads, so `faceCamFrameAt` withholds it from
   * the compositor, and it re-enters at the live position once decoded. That
   * drop-and-re-enter is what reads as the face-cam starting twice, and it
   * happens exactly once per recording because the MP4 is cached afterwards.
   */
  const [mountedCameraUrl, setMountedCameraUrl] = useState<string | null>(null);

  useEffect(() => {
    if (playbackCameraUrl === mountedCameraUrl) return;
    const camera = cameraRef.current;
    // Only an element presenting samples has a picture worth protecting. A cam
    // that never composited (the duration-less WebM on WKWebView) has nothing
    // to lose, so it takes the normalized track immediately.
    const showingPicture =
      mountedCameraUrl !== null &&
      camera !== null &&
      videoFrameStamp(camera)?.presentedFrames != null;
    if (playbackCameraUrl === null || !isPlaying || !showingPicture) {
      setMountedCameraUrl(playbackCameraUrl);
    }
  }, [playbackCameraUrl, mountedCameraUrl, isPlaying]);

  /**
   * Face-cam sync — the only writer to the cam element.
   *
   * Driven by the store clock, which moves at `PLAYBACK_UI_HZ` and is flushed
   * on every seek and pause. Driving it from `paint()` instead meant mutating a
   * media element at display rate, so every transient it passes through got
   * sampled and acted on: the pre-seek `currentTime` WKWebView reports while
   * `seeking` holds, a readyState dip, a seek still in flight. The store clock
   * has none of those states — it changes once per thing that actually asked
   * for a new time.
   */
  const currentTime = useEditorStore((s) => s.currentTime);
  const cameraOffsetMs = useEditorStore((s) => s.cameraOffsetMs);
  /** Previous synced timeline time; `null` = new source, so align outright. */
  const camSyncTimeRef = useRef<number | null>(null);
  const lastClickSourceTimeRef = useRef<number>(0);
  const speedRanges = useEditorStore((s) => s.speedRanges);
  const globalSpeed = useEditorStore((s) => s.globalSpeed);

  const syncFaceCam = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const frame = faceCamFrameAt(
      currentTime,
      cameraOffsetMs,
      mediaDuration(camera),
    );
    // No duration yet — nothing to align against; the load handler retries.
    if (frame.state === "before") return;

    if (
      shouldSeekFaceCam({
        desiredTime: frame.mediaTime,
        isPlaying,
        isSeeking: camera.seeking,
        previousTimelineTime: camSyncTimeRef.current,
        timelineTime: currentTime,
        cameraCurrentTime: camera.currentTime,
      })
    ) {
      camera.currentTime = frame.mediaTime;
    }
    camSyncTimeRef.current = currentTime;

    // Outside the recorded span the timeline maps to one pinned frame, and the
    // cam must not roll against a screen clock that is not rolling either.
    const shouldPlay =
      isPlaying &&
      frame.state === "active" &&
      screenClockIsRolling(videoRef.current);
    if (!shouldPlay) {
      camera.playbackRate = 1;
      camera.pause();
      return;
    }
    // Absorb drift a few percent at a time. Letting it accumulate and settling
    // it on pause rewinds the cam, and the resumed cam replays that stretch.
    camera.playbackRate = faceCamPlaybackRate(
      camera.currentTime,
      frame.mediaTime,
    ) * speedAtTime(speedRanges, currentTime, globalSpeed);
    void camera.play().catch(() => undefined);
  }, [currentTime, cameraOffsetMs, isPlaying, videoRef, speedRanges, globalSpeed]);

  useEffect(() => {
    syncFaceCam();
  }, [syncFaceCam]);

  const stage = useStageDimensions();
  const screenshotOutput = screenshotId ? screenshotStage(
    screenshotSourceSize ?? { width: 1920, height: 1080 },
    { ...DEFAULT_SCREENSHOT_EDITS, aspectRatioPresetId: useEditorStore.getState().aspectRatioPresetId },
  ).output : stage;
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const outputSizeRef = useRef(screenshotOutput);
  outputSizeRef.current = screenshotOutput;

  useEffect(() => {
    preloadCursorAssets();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let loopRaf = 0;
    let paintRaf = 0;
    let playing = useEditorStore.getState().isPlaying;
    let compositor: FrameCompositor | null = null;
    let remounting = false;
    let recoverAttempts = 0;
    let lastRecoverAtMs: number | null = null;
    let notifiedGpuFailure = false;
    let initReclaimTried = false;
    let detachContextLoss: (() => void) | null = null;
    /** Bumped to cancel in-flight Pixi init when export takes the GPU. */
    let generation = 0;

    const notifyGpuFailureOnce = () => {
      if (notifiedGpuFailure) return;
      notifiedGpuFailure = true;
      showError(translateNow("editor.previewGpuLost"));
    };

    const mountCanvas = (canvas: FrameCompositorSurface) => {
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("preview compositor produced a non-DOM surface");
      }
      canvas.className = "block h-full w-full";
      host.replaceChildren(canvas);
    };

    const attachCompositor = (comp: FrameCompositor) => {
      const { width, height } = stageRef.current;
      const output = outputSizeRef.current;
      // The compositor may finish initialising after React's resize effect has
      // already run. Always attach with the latest screenshot output size so
      // that asynchronous initialisation cannot reset a 4K still to 1920.
      comp.resize(width, height, output.width, output.height);
      compositor = comp;
      compositorRef.current = comp;
      mountCanvas(comp.canvas);
      detachContextLoss?.();
      detachContextLoss = attachContextLossHandlers(comp.canvas, () => {
        console.warn("[preview] webglcontextlost — remounting compositor");
        recoverCompositor();
      });
      console.info(`[preview] compositor backend=${comp.backend}`);
    };

    const compositorOptions = () => {
      const composition = stageRef.current;
      const output = outputSizeRef.current;
      return {
        width: composition.width,
        height: composition.height,
        outputWidth: output.width,
        outputHeight: output.height,
        preserveDrawingBuffer: useEditorStore.getState().screenshotId !== null,
        mipmaps: false,
        gpuPreference: ["webgl", "webgpu"] as const,
      };
    };

    const paint = () => {
      const comp = compositor;
      if (!comp) return false;
      const store = useEditorStore.getState();
      const {
        sourceAspect,
        backgroundImage,
        look,
        zoomFragments,
        perspectiveFragments,
        recordingMetadata,
        currentTime,
        isPlaying: nowPlaying,
        screenContentCrop: crop,
        captions,
        captionSettings,
        textClips,
        aspectRatioPresetId,
        backgroundType,
        sourceVideoSize,
        cameraOffsetMs,
      } = store;

      const video = videoRef.current;
      const camera = cameraRef.current;
      // One clock, one owner. A rolling element's own position is the truth —
      // it advances between store publishes. The moment it stops rolling that
      // position is stale (WKWebView reports the pre-seek time for as long as
      // `seeking` holds), and the requested time is what the frame means.
      const screenRolling = screenClockIsRolling(video);
      const t = store.screenshotId
        ? SCREENSHOT_RENDER_TIME
        : screenRolling && video
          ? video.currentTime
          : currentTime;

      // Read-only: `syncFaceCam` owns the element. All this decides is whether
      // the cam has a picture for `t` at all — the compositor is handed nothing
      // when the timeline sits outside the recorded span.
      const camHasPicture =
        camera !== null &&
        faceCamFrameAt(t, cameraOffsetMs, mediaDuration(camera)).state !==
          "before";
      const cameraForFrame = camHasPicture ? camera : null;

      const hasSelectedBackground = backgroundImage !== null;
      const hasImageBackground =
        hasSelectedBackground && backgroundType === "image";
      const zoomLayout = resolveZoomCompositionLayout({
        stageWidth: stageRef.current.width,
        stageHeight: stageRef.current.height,
        presetId: aspectRatioPresetId,
        sourceAspect,
        sourceVideoSize,
        hasSelectedBackground,
        hasImageBackground,
        devicePadding: look.devicePadding,
        screenContentCrop: crop,
      });
      const zoom = getZoomPanAtTime(
        zoomFragments,
        recordingMetadata,
        crop,
        t,
        zoomLayout,
      );
      const active =
        zoomFragments.find((f) => t >= f.start && t <= f.end) ?? null;
      const activePerspective = findActivePerspectiveFragment(perspectiveFragments, t);

      try {
        comp.compose(
          {
            width: stageRef.current.width,
            height: stageRef.current.height,
            video: store.screenshotId ? screenshotSourceRef.current : video,
            cameraVideo: cameraForFrame,
            sourceAspect,
            background: backgroundImage,
            look: resolvePerspectiveLook(look, activePerspective, t),
            aspectRatioPresetId,
            backgroundType,
            sourceVideoSize,
            zoomScale: zoom.scale,
            zoomFocus: { x: zoom.x, y: zoom.y },
            ...resolveZoomReactiveState(active, t),
            screenContentCrop: crop,
            blurRegions: store.blurRegions,
            cursorTime: t,
            cursorFreeze: !nowPlaying,
            cursorSettings: store.cursorSettings,
            cursorLoopReturn: store.cursorSettings.loopCursor
              ? computeCursorLoopReturn(store.segments, store.duration)
              : null,
            recordingMetadata,
            faceCam: store.faceCam,
          },
          {
            captions,
            settings: captionSettings,
            timeMs: t * 1000,
            textClips,
          },
        );
        recoverAttempts = 0;
        return true;
      } catch (e) {
        console.error("[preview] compose failed — remounting compositor", e);
        recoverCompositor();
        return false;
      }
    };

    const advancePlayback = () => {
      const { segments, duration } = useEditorStore.getState();
      const video = videoRef.current;
      if (!video || segments.length === 0) return;
      if (findSegmentIndexAtTime(segments, video.currentTime) >= 0) return;

      const next = getNextPlayableTime(segments, video.currentTime);
      if (next != null && next < duration) {
        video.currentTime = next;
        publishPlaybackTime(next, { force: true });
      } else {
        video.pause();
        useEditorStore.getState().setPlaying(false);
        const last = segments[segments.length - 1];
        if (last) {
          video.currentTime = last.end;
          publishPlaybackTime(last.end, { force: true });
        }
      }
    };

    const syncPlaybackRate = () => {
      const video = videoRef.current;
      if (!video) return;
      const state = useEditorStore.getState();
      const rate = state.isPlaying
        ? speedAtTime(state.speedRanges, video.currentTime, state.globalSpeed)
        : 1;
      if (Math.abs(video.playbackRate - rate) > 1e-3) video.playbackRate = rate;
    };

    const playClickSounds = () => {
      const video = videoRef.current;
      if (!video) return;
      const state = useEditorStore.getState();
      const now = video.currentTime;
      const previous = lastClickSourceTimeRef.current;
      if (!state.clickSoundSettings.enabled || !state.recordingMetadata?.cursorClickSamples) {
        lastClickSourceTimeRef.current = now;
        return;
      }
      if (now < previous - 0.2) {
        lastClickSourceTimeRef.current = now;
        return;
      }
      for (const sample of clickSamplesBetween(
        state.recordingMetadata.cursorClickSamples,
        previous,
        now,
      ).filter((sample) =>
        state.segments.length === 0 ||
        state.segments.some((segment) => sample.t >= segment.start && sample.t <= segment.end),
      )) {
        playGeneratedClick(state.clickSoundSettings.volume);
      }
      lastClickSourceTimeRef.current = now;
    };

    /**
     * Paced by rAF, not by the screen track's `requestVideoFrameCallback`.
     * RVFC only fires once the screen decoder presents a sample, so pacing on
     * it stalled the *whole* stage — face-cam included — for as long as that
     * element took to spin up after a play or a seek. The compositor already
     * skips redundant GPU uploads per element (see `videoStampNeedsUpload`),
     * so a display-rate loop costs no extra texture traffic.
     */
    const loop = () => {
      syncPlaybackRate();
      advancePlayback();
      playClickSounds();
      paint();
      if (!playing) {
        loopRaf = 0;
        return;
      }
      loopRaf = requestAnimationFrame(loop);
    };

    const startLoop = () => {
      if (loopRaf) return;
      if (paintRaf) {
        cancelAnimationFrame(paintRaf);
        paintRaf = 0;
      }
      loopRaf = requestAnimationFrame(loop);
    };

    const stopLoop = () => {
      if (!loopRaf) return;
      cancelAnimationFrame(loopRaf);
      loopRaf = 0;
    };

    const requestPaint = () => {
      if (loopRaf || paintRaf) return;
      // Skip paints while export owns the GPU (host is empty).
      if (!compositor || useEditorStore.getState().exporting) return;
      paintRaf = requestAnimationFrame(() => {
        paintRaf = 0;
        paint();
      });
    };
    requestPaintRef.current = requestPaint;
    if (screenshotFrameRef) screenshotFrameRef.current = () => {
      if (!screenshotSourceRef.current) return null;
      if (!paint()) return null;
      return compositor?.canvas instanceof HTMLCanvasElement ? compositor.canvas : null;
    };

    const dropCompositor = () => {
      generation += 1;
      stopLoop();
      if (paintRaf) {
        cancelAnimationFrame(paintRaf);
        paintRaf = 0;
      }
      detachContextLoss?.();
      detachContextLoss = null;
      const dead = compositor;
      compositor = null;
      compositorRef.current = null;
      dead?.dispose();
      host.replaceChildren();
      // In-flight init still holds the gate until its then/catch runs.
      if (!remounting) releasePreviewGpu();
    };

    const startCompositor = () => {
      if (
        disposed ||
        remounting ||
        compositor ||
        useEditorStore.getState().exporting
      ) {
        return;
      }
      remounting = true;
      const gen = generation;
      markPreviewGpuHeld();
      void createFrameCompositor(compositorOptions())
        .then((comp) => {
          remounting = false;
          if (
            disposed ||
            gen !== generation ||
            useEditorStore.getState().exporting
          ) {
            comp.dispose();
            // dropCompositor skips release while remounting — free the gate here.
            releasePreviewGpu();
            return;
          }
          attachCompositor(comp);
          const v = videoRef.current;
          if (!playing && v && !v.paused) v.pause();
          if (playing) startLoop();
          else requestPaint();
        })
        .catch(async (err) => {
          remounting = false;
          releasePreviewGpu();
          console.error("[preview] compositor init failed", err);
          // One reclaim+retry before telling the user — covers post-export TDR.
          if (
            !initReclaimTried &&
            !disposed &&
            gen === generation &&
            !useEditorStore.getState().exporting
          ) {
            initReclaimTried = true;
            const { ok } = await reclaimGpuAfterLoss();
            if (
              ok &&
              !disposed &&
              gen === generation &&
              !useEditorStore.getState().exporting &&
              !compositor
            ) {
              startCompositor();
              return;
            }
          }
          notifyGpuFailureOnce();
        });
    };

    const recoverCompositor = () => {
      if (disposed || remounting || useEditorStore.getState().exporting) {
        return;
      }
      const now = performance.now();
      const { decision, nextAttempts } = decideRecovery({
        attempts: recoverAttempts,
        lastAttemptAtMs: lastRecoverAtMs,
        nowMs: now,
      });
      recoverAttempts = nextAttempts;
      lastRecoverAtMs = now;
      if (decision === "giveUp") {
        notifyGpuFailureOnce();
        return;
      }
      dropCompositor();
      startCompositor();
    };

    const suspendForExport = () => {
      useEditorStore.getState().setPlaying(false);
      dropCompositor();
      console.info("[preview] GPU released for export");
    };

    if (useEditorStore.getState().exporting) {
      releasePreviewGpu();
    } else {
      startCompositor();
    }

    /**
     * Fields `paint()` reads — skip repaints for unrelated store mutations.
     * Reference equality; anything added to `paint()` must be listed here.
     */
    type FramePaintState = Parameters<
      Parameters<typeof useEditorStore.subscribe>[0]
    >[0];
    const framePaintInputsChanged = (
      next: FramePaintState,
      prev: FramePaintState,
    ): boolean =>
      next.sourceAspect !== prev.sourceAspect ||
      next.sourceVideoSize !== prev.sourceVideoSize ||
      next.aspectRatioPresetId !== prev.aspectRatioPresetId ||
      next.backgroundImage !== prev.backgroundImage ||
      next.backgroundType !== prev.backgroundType ||
      next.screenshotId !== prev.screenshotId ||
      next.look !== prev.look ||
      next.zoomFragments !== prev.zoomFragments ||
      next.perspectiveFragments !== prev.perspectiveFragments ||
      next.recordingMetadata !== prev.recordingMetadata ||
      next.currentTime !== prev.currentTime ||
      next.isPlaying !== prev.isPlaying ||
      next.screenContentCrop !== prev.screenContentCrop ||
      next.blurRegions !== prev.blurRegions ||
      next.captions !== prev.captions ||
      next.captionSettings !== prev.captionSettings ||
      next.textClips !== prev.textClips ||
      next.cursorSettings !== prev.cursorSettings ||
      next.segments !== prev.segments ||
      next.duration !== prev.duration ||
      next.faceCam !== prev.faceCam ||
      next.cameraOffsetMs !== prev.cameraOffsetMs;

    const unsubscribe = useEditorStore.subscribe((state, prev) => {
      if (state.exporting !== prev.exporting) {
        if (state.exporting) suspendForExport();
        else startCompositor();
        return;
      }
      if (state.exporting) return;
      if (state.isPlaying !== playing) {
        playing = state.isPlaying;
        const video = videoRef.current;
        lastClickSourceTimeRef.current = video?.currentTime ?? state.currentTime;
        syncPlaybackRate();
        if (playing) startLoop();
        else {
          stopLoop();
          const v = videoRef.current;
          if (v) publishPlaybackTime(v.currentTime, { force: true });
          requestPaint();
        }
        return;
      }
      if (!playing && framePaintInputsChanged(state, prev)) requestPaint();
    });

    return () => {
      disposed = true;
      generation += 1;
      stopLoop();
      if (paintRaf) cancelAnimationFrame(paintRaf);
      unsubscribe();
      requestPaintRef.current = () => {};
      if (screenshotFrameRef) screenshotFrameRef.current = null;
      detachContextLoss?.();
      detachContextLoss = null;
      compositor?.dispose();
      compositor = null;
      compositorRef.current = null;
      host.replaceChildren();
      releasePreviewGpu();
    };
  }, [screenshotFrameRef, videoRef]);

  useEffect(() => {
    const comp = compositorRef.current;
    if (!comp) return;
    comp.resize(stage.width, stage.height, screenshotOutput.width, screenshotOutput.height);
    requestPaintRef.current();
  }, [
    stage.width,
    stage.height,
    screenshotId,
    screenshotOutput.width,
    screenshotOutput.height,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const stopTrack = trackVideoFrames(video, () => requestPaintRef.current());
    const onFrameReady = () => requestPaintRef.current();
    video.addEventListener("seeked", onFrameReady);
    video.addEventListener("loadeddata", onFrameReady);
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      void primePausedVideoFrame(video).then(onFrameReady);
    }
    return () => {
      stopTrack();
      video.removeEventListener("seeked", onFrameReady);
      video.removeEventListener("loadeddata", onFrameReady);
    };
  }, [playbackUrl, videoRef]);

  useEffect(() => {
    // A replaced source has no baseline, so its first sync counts as a jump
    // and aligns outright instead of measuring drift against the old file.
    camSyncTimeRef.current = null;
    const camera = cameraRef.current;
    if (!camera) return;
    const stopTrack = trackVideoFrames(camera, () => requestPaintRef.current());
    const onFrameReady = () => requestPaintRef.current();
    camera.addEventListener("seeked", onFrameReady);
    return () => {
      stopTrack();
      camera.removeEventListener("seeked", onFrameReady);
    };
  }, [mountedCameraUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = isPlaying
      ? speedAtTime(speedRanges, video.currentTime, globalSpeed)
      : 1;
    if (isPlaying)
      video.play().catch(() => useEditorStore.getState().setPlaying(false));
    else video.pause();
  }, [isPlaying, playbackUrl, speedRanges, globalSpeed, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    video.volume = Math.max(0, Math.min(1, volume / 100));
  }, [muted, volume, videoRef]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditorTypingTarget()) return;
      if (e.code !== "Space" && e.key !== " " && e.key !== "Spacebar") return;
      e.preventDefault();
      toggleEditorPlayback(videoRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [videoRef]);

  useEffect(() => {
    return useEditorStore.subscribe((state, prev) => {
      if (state.isPlaying) return;
      if (Math.abs(state.currentTime - prev.currentTime) < 1e-3) return;
      const video = videoRef.current;
      if (video && Math.abs(video.currentTime - state.currentTime) > 0.04) {
        video.currentTime = presentableVideoTime(
          state.currentTime,
          video.duration,
        );
      }
      // The cam is not touched here. `paint()` owns it, and a paused
      // `currentTime` change always schedules one — two writers reading the
      // clock from different places is what let a seek pull the cam both ways.
    });
  }, [videoRef]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-hidden p-4">
      <div className="@container-size relative min-h-0 flex-1">
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="relative overflow-hidden rounded-xl border border-border bg-black"
            style={{
              aspectRatio: `${stage.width} / ${stage.height}`,
              width: `min(100cqw, calc(100cqh * ${stage.width} / ${stage.height}))`,
              maxHeight: "100cqh",
            }}
          >
            <div ref={hostRef} className="block h-full w-full" />
            {playbackUrl === null && proxyPending ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-white/80">
                {translate("preview.preparing")}
              </div>
            ) : null}
            <video
              ref={videoRef}
              // Fresh element per source — WKWebView errors on blob src reuse after proxy swap.
              key={playbackUrl ?? "no-source"}
              src={playbackUrl ?? undefined}
              className="hidden"
              playsInline
              preload="auto"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                useEditorStore
                  .getState()
                  .onVideoLoaded(v.videoWidth, v.videoHeight, v.duration);
                const { currentTime, isPlaying: playing } =
                  useEditorStore.getState();
                if (
                  currentTime > 0.01 &&
                  Math.abs(v.currentTime - currentTime) > 0.05
                ) {
                  v.currentTime = presentableVideoTime(currentTime, v.duration);
                }
                if (playing) void v.play().catch(() => undefined);
              }}
              onLoadedData={(e) => {
                if (useEditorStore.getState().isPlaying) return;
                void primePausedVideoFrame(e.currentTarget).then(() =>
                  requestPaintRef.current(),
                );
              }}
              onTimeUpdate={(e) =>
                publishPlaybackTime(e.currentTarget.currentTime)
              }
              onEnded={() => useEditorStore.getState().setPlaying(false)}
              onError={(e) =>
                console.error(
                  "[preview] screen media failed to load",
                  e.currentTarget.error?.code,
                  e.currentTarget.error?.message,
                )
              }
            />
            {mountedCameraUrl ? (
              <video
                ref={cameraRef}
                key={mountedCameraUrl}
                src={mountedCameraUrl}
                className="hidden"
                muted
                playsInline
                preload="auto"
                // A duration only exists once metadata lands, so this is the
                // first point `syncFaceCam` can align anything — before it, it
                // sees `before` and returns.
                onLoadedMetadata={syncFaceCam}
                onLoadedData={(e) => {
                  syncFaceCam();
                  if (useEditorStore.getState().isPlaying) return;
                  void primePausedVideoFrame(e.currentTarget).then(() =>
                    requestPaintRef.current(),
                  );
                }}
                onError={(e) =>
                  console.error(
                    "[preview] camera media failed to load",
                    e.currentTarget.error?.code,
                    e.currentTarget.error?.message,
                  )
                }
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="w-full shrink-0">
        <PlaybackControls videoRef={videoRef} />
      </div>
    </div>
  );
}
