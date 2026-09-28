/**
 * Live annotation overlay with a compact tool dock and contextual properties.
 * Drawing remains owned by the existing AnnotationEngine.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import {
  Circle,
  Eraser,
  GripVertical,
  Highlighter,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Pipette,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { emit, emitTo, listen } from "@tauri-apps/api/event";

import { AnnotationEngine } from "@/annotation/engine";
import type { AnnotationTool, ShapeKind } from "@/annotation/types";
import { Slider } from "@/components/ui/slider";
import { commands } from "@/ipc/bindings";
import { logClientError, logClientInfo } from "@/lib/errorLogging";
import {
  attachCanvas2dContextLoss,
  planOverlayRecovery,
  type OverlayRecoveryState,
} from "./overlayGpuGuard";

/**
 * How often to check that the overlay's drawing context is still alive. Cheap
 * enough to be invisible (one boolean read) and fast enough that a dead
 * fullscreen overlay is not left covering the desktop for long.
 */
const CONTEXT_WATCHDOG_MS = 2_000;
import { cn } from "@/lib/utils";

const IS_INK = new URLSearchParams(window.location.search).get("layer") === "ink";
const SETTINGS_EVENT = "annotation://settings";
const ACTION_EVENT = "annotation://action";
const READY_EVENT = "annotation://ink-ready";
type AnnotationAction = "undo" | "redo" | "clear" | { action: "clear"; nonce: string };
type AnnotationSettings = { tool: AnnotationTool; color: string; shapeKind: ShapeKind; brushSize: number };

const ANNOTATION_ESCAPE_EVENT = "annotation://escape";
const ANNOTATION_DISPLAY_EVENT = "annotation://display";

/** Preset swatches — custom colors come from the picker tile after these. */
const PALETTE = [
  "#EAB308",
  "#f97316",
  "#ef4444",
  "#3b82f6",
  "#22c55e",
  "#ffffff",
  "#000000",
];

const SHAPES: { id: ShapeKind; label: string; icon: ReactNode }[] = [
  { id: "rect", label: "四角形", icon: <Square className="size-5" /> },
  { id: "ellipse", label: "楕円", icon: <Circle className="size-5" /> },
  { id: "line", label: "線", icon: <Minus className="size-5" /> },
  { id: "arrow", label: "矢印", icon: <MoveUpRight className="size-5" /> },
];

type ToolId = AnnotationTool;
type Panel = "properties" | null;

/** Toolbar transform: `translate3d` keeps the bar on its own GPU layer. */
function barTransform(x: number, y: number): string {
  return `translate3d(${x}px, calc(-50% + ${y}px), 0)`;
}

export function AnnotationApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AnnotationEngine | null>(null);
  const propertiesElRef = useRef<HTMLDivElement | null>(null);
  // Pass-through until the user picks a drawing tool — otherwise the overlay
  // steals every click from the Mac.
  const [tool, setTool] = useState<ToolId>("select");
  const [color, setColor] = useState(PALETTE[0]!);
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rect");
  const [brushSize, setBrushSize] = useState(6);
  const [panel, setPanel] = useState<Panel>(null);
  const [barOffset, setBarOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  /** True for the whole grip gesture — read by the click-through poll. */
  const draggingRef = useRef(false);
  const interactingRef = useRef(false);
  /** Latest drag offset, committed to state once on release. */
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const dragRafRef = useRef(0);
  const toolbarElRef = useRef<HTMLDivElement | null>(null);
  const ignoreRef = useRef<boolean | null>(null);
  /**
   * `scaleFactor` / `outerPosition` for the overlay window. Both are fixed for
   * a full-screen overlay and only change when it hops displays, so they are
   * read once and reused instead of costing two IPC round-trips per 80 ms
   * cursor poll — which runs the whole time the user is annotating a live
   * recording. Cleared on `annotation://display`.
   */
  const winMetricsRef = useRef<{ scale: number; x: number; y: number } | null>(
    null,
  );
  // The overlay WebView is reused (Rust show/hide, never closed), so this app
  // stays mounted while hidden. Track native visibility to suspend the idle
  // cursor-poll when off-screen — the window is created to be shown, so `true`.
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [screenshotChromeHidden, setScreenshotChromeHidden] = useState(false);
  // Mirror of `overlayVisible` for the context-loss handler, which is installed
  // once and would otherwise close over the mount-time value.
  const overlayVisibleRef = useRef(true);
  overlayVisibleRef.current = overlayVisible;

  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const register = async () => {
      if (IS_INK) {
        const stop = await listen<{ nonce: string }>("annotation://prepare-capture", ({ payload }) => {
          engineRef.current?.finishTextEditing();
          engineRef.current?.clearSelectedTextSelection();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            void emitTo("annotation-controls", "annotation://capture-ready", payload);
          }));
        });
        if (disposed) stop(); else stops.push(stop);
        return;
      }
      let pendingNonce: string | null = null;
      const ready = await listen<{ nonce: string }>("annotation://capture-ready", ({ payload }) => {
        if (pendingNonce !== payload.nonce) return;
        pendingNonce = null;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          void emit("screenshot://chrome-ready", { nonce: payload.nonce, error: null });
        }));
      });
      if (disposed) { ready(); return; }
      stops.push(ready);
      const chrome = await listen<{ hidden: boolean; nonce: string }>("screenshot://chrome", ({ payload }) => {
        setScreenshotChromeHidden(payload.hidden);
        if (payload.hidden) {
          pendingNonce = payload.nonce;
          void emitTo("annotation", "annotation://prepare-capture", { nonce: payload.nonce });
        } else {
          pendingNonce = null;
          void emit("screenshot://chrome-ready", { nonce: payload.nonce, error: null });
        }
      });
      if (disposed) chrome(); else stops.push(chrome);
    };
    void register();
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, []);

  const settingsRef = useRef<AnnotationSettings>({ tool, color, shapeKind, brushSize });
  settingsRef.current = { tool, color, shapeKind, brushSize };
  useEffect(() => {
    if (!IS_INK) void emitTo("annotation", SETTINGS_EVENT, settingsRef.current);
  }, [tool, color, shapeKind, brushSize, overlayVisible]);

  // The ink window requests the current state after its listeners are installed.
  // This handshake also covers either order of native window creation.
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const register = async () => {
      const stop = IS_INK
        ? await listen<AnnotationSettings>(SETTINGS_EVENT, ({ payload }) => {
            setTool(payload.tool); setColor(payload.color);
            setShapeKind(payload.shapeKind); setBrushSize(payload.brushSize);
          })
        : await listen(READY_EVENT, () => { void emitTo("annotation", SETTINGS_EVENT, settingsRef.current); });
      if (disposed) { stop(); return; }
      stops.push(stop);
      if (IS_INK) {
        const stopAction = await listen<AnnotationAction>(ACTION_EVENT, ({ payload }) => {
          const engine = engineRef.current;
          engine?.finishTextEditing();
          if (payload === "undo") engine?.undo();
          else if (payload === "redo") engine?.redo();
          else if (engine) {
            engine.clearAll();
            if (typeof payload !== "string") {
              requestAnimationFrame(() => requestAnimationFrame(() => {
                void emit("annotation://screenshot-cleared", { nonce: payload.nonce });
              }));
            }
          }
        });
        if (disposed) { stopAction(); return; }
        stops.push(stopAction);
        void emitTo("annotation-controls", READY_EVENT);
      } else {
        void emitTo("annotation", SETTINGS_EVENT, settingsRef.current);
      }
    };
    void register();
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, []);

  const passThrough = tool === "select" && panel === null;

  const closeOverlay = useCallback(() => {
    void emit("annotation://closed");
    void getCurrentWindow().hide();
    void commands.hideAnnotationOverlay().catch(() => undefined);
  }, []);

  /** Escape / cancel — peel layers before closing the whole overlay. */
  const onEscape = useCallback(() => {
    if (panel !== null) {
      setPanel(null);
      return;
    }
    if (tool !== "select") {
      setTool("select");
      return;
    }
    closeOverlay();
  }, [closeOverlay, panel, tool]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (IS_INK) void emitTo("annotation-controls", ANNOTATION_ESCAPE_EVENT);
      else onEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onEscape]);

  useEffect(() => {
    if (IS_INK) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen(ANNOTATION_ESCAPE_EVENT, onEscape).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onEscape]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new AnnotationEngine(canvas);
    engine.color = color;
    engine.brushSize = brushSize;
    engine.highlighterSize = Math.max(12, brushSize * 4);
    engine.eraserSize = Math.max(8, brushSize * 2.5);
    engine.setTool(tool);
    engineRef.current = engine;

    const onDown = (e: PointerEvent) => engine.pointerDown(e);
    const onMove = (e: PointerEvent) => engine.pointerMove(e);
    const onUp = (e: PointerEvent) => engine.pointerUp(e);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    // GPU context loss on a fullscreen transparent always-on-top window is not
    // a rendering glitch — the surface composites opaque and the user's whole
    // desktop goes black mid-recording (#25). Hide first, ask questions after:
    // a hidden window cannot paint over anything, and the ink is history data
    // so nothing is lost by rebuilding.
    let recovery: OverlayRecoveryState = { attempts: 0, lastAttemptAtMs: null };
    let recovering = false;
    const handleContextLoss = () => {
      if (recovering) return;
      recovering = true;
      const win = getCurrentWindow();
      // Hide before anything else — this is the step that gets the black
      // rectangle off the user's desktop. Everything after it is cleanup.
      if (overlayVisibleRef.current) {
        void win.hide().catch(() => undefined);
      }

      const { action, next } = planOverlayRecovery(recovery, Date.now());
      recovery = next;
      logClientError(
        "annotation-overlay",
        new Error(
          `2D context lost (attempt ${next.attempts}); overlay hidden, action=${action}`,
        ),
      );

      if (action === "stayHidden") {
        // Repeated loss means the GPU process is not coming back. Showing the
        // overlay again would just black the desktop out a fourth time, so
        // the take continues without live ink.
        void emit("annotation://closed");
        void commands.hideAnnotationOverlay().catch(() => undefined);
        recovering = false;
        return;
      }

      try {
        engine.recoverContexts();
      } catch (e) {
        logClientError("annotation-overlay", e);
      }
      // Only come back once the context actually took. Showing a still-lost
      // surface is exactly the black screen being defended against.
      if (engine.isContextLost()) {
        void emit("annotation://closed");
        void commands.hideAnnotationOverlay().catch(() => undefined);
      } else if (overlayVisibleRef.current) {
        // Only restore an overlay that was actually on screen. A context can be
        // lost while the user has the overlay closed, and showing it again
        // would put a toolbar back over their screen that they dismissed.
        void win.show().catch(() => undefined);
      }
      recovering = false;
    };

    const detachContextLoss = attachCanvas2dContextLoss(canvas, {
      onLost: handleContextLoss,
      onRestored: () => {
        logClientInfo("annotation-overlay", "2D context restored");
        try {
          engine.recoverContexts();
        } catch (e) {
          logClientError("annotation-overlay", e);
        }
      },
    });

    // The event is the fast path, not the only one. A compositor fault can leave
    // the context dead without our listener ever seeing `contextlost` — and the
    // window whose surface is black is exactly the window that stopped telling
    // us things. Poll cheaply so the desktop is never left covered by a dead
    // overlay waiting for an event that is not coming.
    const watchdog = window.setInterval(() => {
      if (!recovering && engine.isContextLost()) {
        handleContextLoss();
      }
    }, CONTEXT_WATCHDOG_MS);

    return () => {
      window.clearInterval(watchdog);
      detachContextLoss();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      engine.destroy();
      engineRef.current = null;
      void getCurrentWindow()
        .setIgnoreCursorEvents(false)
        .catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setTool(tool);
    canvasRef.current?.classList.toggle(
      "pointer-events-none",
      tool === "select",
    );
  }, [tool]);

  const applyIgnore = (ignore: boolean) => {
    if (ignoreRef.current === ignore) return;
    ignoreRef.current = ignore;
    void getCurrentWindow()
      .setIgnoreCursorEvents(ignore)
      .catch(() => undefined);
  };

  // Native show/hide from Rust (`annotation://visibility`). Keeps `overlayVisible`
  // in sync so the idle poll below can stop while the overlay is off-screen.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<boolean>("annotation://visibility", (e) => {
      ignoreRef.current = null;
      overlayVisibleRef.current = e.payload;
      setOverlayVisible(e.payload);
      if (!IS_INK) setScreenshotChromeHidden(false);
      if (e.payload && IS_INK) void emitTo("annotation-controls", READY_EVENT);
      logClientInfo(
        "annotation:visibility",
        e.payload ? "shown" : "hidden",
      );
      if (!e.payload) {
        interactingRef.current = false;
        setTool("select");
        setPanel(null);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    logClientInfo("annotation", "webview mounted");
  }, []);

  // Tell Rust whether monitor-hopping is safe. The native follow loop (not a
  // WebView timer — those get App-Nap'd once click-through) moves the overlay
  // across displays; skip hops while a tool is armed so the canvas isn't yanked.
  useEffect(() => {
    if (IS_INK || !overlayVisible) return;
    void commands
      .setAnnotationDisplayFollow(passThrough)
      .catch(() => undefined);
  }, [passThrough, overlayVisible]);

  // Overlay hopped displays — drop the drag offset so the bar isn't parked
  // off-screen on a smaller monitor.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen(ANNOTATION_DISPLAY_EVENT, () => {
      winMetricsRef.current = null;
      dragOffsetRef.current = { x: 0, y: 0 };
      setBarOffset({ x: 0, y: 0 });
      const el = toolbarElRef.current;
      if (el) el.style.transform = barTransform(0, 0);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // OS click-through while idle. `setIgnoreCursorEvents` blocks ALL hits (including
  // the toolbar), so we poll the real cursor and temporarily re-enable hits when
  // it's over the bar / left-side menus. Suspended while the overlay is hidden —
  // no point running ~37 IPC round-trips/sec against an off-screen window.
  useEffect(() => {
    if (IS_INK) {
      applyIgnore(tool === "select");
      return;
    }
    if (!overlayVisible) {
      // Only reset click-through when the tool actually allows hits; when merely
      // hidden, leave the ignore state as-is (it's re-evaluated on re-show).
      return;
    }

    // Hide/show can land on another display without `annotation://display`.
    winMetricsRef.current = null;
    let cancelled = false;
    let timer = 0;

    const tick = async () => {
      if (cancelled) return;
      // Never re-evaluate hit-testing mid-drag: the async cursor/rect reads
      // race the moving bar, and one stale "not over the bar" answer flips
      // `setIgnoreCursorEvents(true)` under an active pointer capture —
      // cutting the event stream (the bar stalls) and churning the window's
      // event shadow every 80 ms (the flicker).
      if (draggingRef.current || interactingRef.current) {
        applyIgnore(false);
        timer = window.setTimeout(tick, 80);
        return;
      }
      const el = toolbarElRef.current;
      if (!el) {
        applyIgnore(true);
        timer = window.setTimeout(tick, 80);
        return;
      }
      try {
        const win = getCurrentWindow();
        let metrics = winMetricsRef.current;
        if (!metrics) {
          const [scale, outer] = await Promise.all([
            win.scaleFactor(),
            win.outerPosition(),
          ]);
          if (cancelled) return;
          metrics = { scale, x: outer.x, y: outer.y };
          winMetricsRef.current = metrics;
        }
        const cursor = await cursorPosition();
        if (cancelled) return;
        const x = (cursor.x - metrics.x) / metrics.scale;
        const y = (cursor.y - metrics.y) / metrics.scale;
        const rects = [el, propertiesElRef.current].filter((node): node is HTMLDivElement => node !== null).map((node) => node.getBoundingClientRect());
        const over = !screenshotChromeHidden && rects.some((r) =>
          x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8);
        applyIgnore(!over);
      } catch {
        winMetricsRef.current = null;
        applyIgnore(true);
      }
      timer = window.setTimeout(tick, 80);
    };

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tool, overlayVisible, screenshotChromeHidden]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.color = color;
  }, [color]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.shapeKind = shapeKind;
  }, [shapeKind]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.brushSize = brushSize;
    engine.highlighterSize = Math.max(12, brushSize * 4);
    engine.eraserSize = Math.max(8, brushSize * 2.5);
  }, [brushSize]);

  /** Activate `next`, or return to pass-through if it was already active. */
  const pickTool = (next: ToolId) => {
    const selected = tool === next && next !== "select";
    setTool(selected ? "select" : next);
    setPanel(selected || next === "select" ? null : "properties");
  };

  const pickShape = (kind: ShapeKind) => {
    const selected = tool === "shape" && shapeKind === kind;
    setShapeKind(kind);
    setTool(selected ? "select" : "shape");
    setPanel(selected ? null : "properties");
  };

  /** End the grip gesture: commit the final offset to state (so re-renders
   * keep the position) and release the drag refs. Shared by up/cancel/capture
   * loss so no path can leave the poll pinned in "dragging". */
  const endBarDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    dragRef.current = null;
    if (dragRafRef.current !== 0) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
    setBarOffset(dragOffsetRef.current);
  };

  return (
    // `select-none` is load-bearing: a grip drag otherwise starts a browser
    // *content selection* that sweeps over the full-viewport canvas — WebKit
    // paints the blue selection tint across the selected canvas's entire box,
    // i.e. the whole screen, until mouse-up.
    <div
      className="annotation-shell relative h-screen w-screen overflow-hidden bg-transparent select-none"
      onPointerDownCapture={() => { if (!IS_INK) interactingRef.current = true; }}
      onPointerUpCapture={() => { interactingRef.current = false; }}
      onPointerCancelCapture={() => { interactingRef.current = false; }}
    >
      {IS_INK && <canvas
        ref={canvasRef}
        className={cn(
          "absolute inset-0 h-full w-full touch-none",
          tool === "select"
            ? "pointer-events-none cursor-default"
            : "cursor-crosshair",
        )}
      />}

      {!IS_INK && <div
        ref={toolbarElRef}
        // Keep the dock on its own compositor layer while dragging over the
        // transparent full-screen overlay.
        className={cn(
          "fixed top-1/2 right-6 z-10 flex w-[78px] max-h-[calc(100vh-32px)] flex-col items-center rounded-[24px] border border-border bg-card p-1.5 text-foreground shadow-2xl will-change-transform",
          screenshotChromeHidden && "invisible pointer-events-none",
        )}
        style={{ transform: barTransform(barOffset.x, barOffset.y) }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex h-8 w-full shrink-0 cursor-grab items-center justify-center rounded-xl text-muted-foreground hover:bg-muted active:cursor-grabbing"
          title="ドラッグして移動"
          aria-label="注釈バーを移動"
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            draggingRef.current = true;
            dragOffsetRef.current = barOffset;
            dragRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              origX: barOffset.x,
              origY: barOffset.y,
            };
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            if (!d) return;
            const height = toolbarElRef.current?.offsetHeight ?? 0;
            const travel = Math.max(0, (window.innerHeight - height) / 2 - 12);
            dragOffsetRef.current = {
              x: d.origX + (e.clientX - d.startX),
              y: Math.max(-travel, Math.min(travel, d.origY + (e.clientY - d.startY))),
            };
            if (dragRafRef.current === 0) {
              dragRafRef.current = requestAnimationFrame(() => {
                dragRafRef.current = 0;
                const el = toolbarElRef.current;
                const { x, y } = dragOffsetRef.current;
                if (el) el.style.transform = barTransform(x, y);
              });
            }
          }}
          onPointerUp={endBarDrag}
          onPointerCancel={endBarDrag}
          onLostPointerCapture={endBarDrag}
        >
          <GripVertical className="pointer-events-none size-4" />
        </div>

        <Divider />

        <div className="flex min-h-0 w-full flex-col items-center gap-0.5 overflow-y-auto overscroll-contain">
          <ToolBtn
            label="操作を通す"
            active={passThrough}
            onClick={() => pickTool("select")}
            icon={<MousePointer2 className="size-5" />}
          />
          <ToolBtn
            label="ペン"
            active={tool === "pen"}
            onClick={() => pickTool("pen")}
            icon={<Pencil className="size-5" />}
          />
          <ToolBtn
            label="マーカー"
            active={tool === "highlighter"}
            onClick={() => pickTool("highlighter")}
            icon={<Highlighter className="size-5" />}
          />
          <ToolBtn
            label="消しゴム"
            active={tool === "eraser"}
            onClick={() => pickTool("eraser")}
            icon={<Eraser className="size-5" />}
          />
          {SHAPES.map((shape) => (
            <ToolBtn
              key={shape.id}
              label={shape.label}
              active={tool === "shape" && shapeKind === shape.id}
              onClick={() => pickShape(shape.id)}
              icon={shape.icon}
            />
          ))}
          <ToolBtn
            label="テキスト"
            active={tool === "text"}
            onClick={() => pickTool("text")}
            icon={<Type className="size-5" />}
          />
          <Divider />
          <ToolBtn
            label="元に戻す"
            onClick={() => { void emitTo("annotation", ACTION_EVENT, "undo"); }}
            icon={<Undo2 className="size-5" />}
          />
          <ToolBtn
            label="やり直す"
            onClick={() => { void emitTo("annotation", ACTION_EVENT, "redo"); }}
            icon={<Redo2 className="size-5" />}
          />
          <Divider />
          <ToolBtn
            label="すべて消す"
            title="すべて消す（元に戻せません）"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => { void emitTo("annotation", ACTION_EVENT, "clear"); }}
            icon={<Trash2 className="size-5" />}
          />
        </div>

        <Divider />
        <ToolBtn
          label="閉じる"
          onClick={closeOverlay}
          icon={<X className="size-5" />}
        />

        {panel === "properties" && tool !== "select" && (
          <div
            ref={propertiesElRef}
            role="group"
            aria-label={tool === "shape" ? "図形の設定" : "道具の設定"}
            className="absolute top-1/2 right-[calc(100%+12px)] w-[284px] -translate-y-1/2 rounded-[20px] border border-border bg-popover p-4 text-popover-foreground shadow-2xl"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <strong className="text-sm font-semibold">
                {tool === "shape"
                  ? SHAPES.find((shape) => shape.id === shapeKind)?.label
                  : tool === "pen" ? "ペン" : tool === "highlighter" ? "マーカー" : tool === "eraser" ? "消しゴム" : "テキスト"}の設定
              </strong>
              <button
                type="button"
                aria-label="設定を閉じる"
                title="設定を閉じる"
                onClick={() => setPanel(null)}
                className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            {tool !== "eraser" && (
              <>
                <p className="mb-2 text-xs font-medium text-muted-foreground">色</p>
                <div className="flex flex-wrap gap-2" role="group" aria-label="注釈の色">
                  {PALETTE.map((swatch) => (
                    <button
                      key={swatch}
                      type="button"
                      aria-label={swatch}
                      aria-pressed={swatch.toLowerCase() === color.toLowerCase()}
                      onClick={() => setColor(swatch)}
                      className={cn(
                        "size-8 rounded-full border border-border ring-offset-2 ring-offset-popover transition-transform hover:scale-110",
                        swatch.toLowerCase() === color.toLowerCase() && "ring-2 ring-primary",
                      )}
                      style={{ backgroundColor: swatch }}
                    />
                  ))}
                  <label
                    title="カスタム色"
                    className={cn(
                      "relative flex size-8 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-border bg-muted",
                      !PALETTE.some((swatch) => swatch.toLowerCase() === color.toLowerCase()) && "ring-2 ring-primary ring-offset-2 ring-offset-popover",
                    )}
                    style={!PALETTE.some((swatch) => swatch.toLowerCase() === color.toLowerCase()) ? { backgroundColor: color } : undefined}
                  >
                    <Pipette className="pointer-events-none size-4" />
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#EAB308"}
                      aria-label="カスタム色"
                      className="absolute inset-0 cursor-pointer opacity-0"
                      onChange={(e) => setColor(e.target.value)}
                    />
                  </label>
                </div>
              </>
            )}

            {tool !== "text" && (
              <div className={cn("flex items-center gap-3", tool !== "eraser" && "mt-4 border-t border-border pt-4")}>
                <label htmlFor="annotation-brush-size" className="shrink-0 text-xs font-medium">太さ</label>
                <Slider
                  id="annotation-brush-size"
                  min={2}
                  max={24}
                  step={1}
                  value={[brushSize]}
                  onValueChange={(value) => setBrushSize(value[0] ?? 6)}
                  aria-label="太さ"
                  className="flex-1"
                />
                <span className="min-w-7 text-right text-xs tabular-nums">{brushSize}</span>
              </div>
            )}
          </div>
        )}
      </div>}
    </div>
  );
}

const ToolBtn = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    icon: ReactNode;
    active?: boolean;
  } & ComponentPropsWithoutRef<"button">
>(({ label, icon, active, className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={active}
    className={cn(
      "flex min-h-[50px] w-full shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 text-center text-[10px] font-medium leading-tight text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
      active && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
      className,
    )}
    {...props}
  >
    {icon}
    <span>{label}</span>
  </button>
));

function Divider() {
  return <div className="my-1 h-px w-[80%] shrink-0 bg-border" />;
}
