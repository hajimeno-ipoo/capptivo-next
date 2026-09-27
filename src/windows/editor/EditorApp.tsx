/**
 * Editor root — tool rail and contextual inspector beside a large preview.
 * Time editing opens the timeline below, and Back opens the in-window library.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, RectangleHorizontal, Redo2, Undo2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import { totalKeptDuration } from "@/engine";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { commands } from "@/ipc/bindings";
import { useEditorStore } from "./store";
import { CaptionsPanel } from "./components/CaptionsPanel";
import { CameraPanel } from "./components/CameraPanel";
import { ConfigPanel } from "./components/ConfigPanel";
import { CursorPanel } from "./components/CursorPanel";
import { ExportProgressOverlay } from "./components/ExportProgressOverlay";
import { ExportSettingsDialog } from "./components/ExportSettingsDialog";
import { EditorTitleBar } from "./components/EditorTitleBar";
import { InspectorChrome, type EditorToolId } from "./components/InspectorChrome";
import { LookPanel, type LookSection } from "./components/LookPanel";
import { PreviewStage } from "./components/PreviewStage";
import { RecordingsLibrary } from "./components/RecordingsLibrary";
import { ScreenshotToolsPanel } from "./components/ScreenshotToolsPanel";
import { RATIO_HINT_KEY, Timeline } from "./components/Timeline";
import { ZoomPanel } from "./components/ZoomPanel";
import type { ExportSettings } from "./export/exportSettings";
import { exportProject } from "./export/exportVideo";
import { ExportSink } from "./export/exportSink";
import { useStageDimensions } from "./lib/useStageDimensions";
import { presentableVideoTime } from "./lib/presentableVideoTime";
import { ASPECT_RATIO_PRESETS } from "./lib/composition";
import { dismissEditorSplash } from "./splash";
import { showError } from "@/lib/toast";
import { consumeGpuReloadedBanner } from "./render/gpuLifecycle";

const SHOW_LIBRARY_EVENT = "shell://show-library";

function initialShell(): "editor" | "library" {
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "library") return "library";
  return "editor";
}

export function EditorApp() {
  const { t } = useI18n();
  const init = useEditorStore((s) => s.init);
  const ready = useEditorStore((s) => s.ready);
  const error = useEditorStore((s) => s.error);
  const inspectorPanel = useEditorStore((s) => s.inspectorPanel);
  const setInspectorPanel = useEditorStore((s) => s.setInspectorPanel);
  const cameraUrl = useEditorStore((s) => s.cameraUrl);
  const recordingMetadata = useEditorStore((s) => s.recordingMetadata);
  const zoomFragments = useEditorStore((s) => s.zoomFragments);
  const selectedZoomFragmentId = useEditorStore(
    (s) => s.selectedZoomFragmentId,
  );
  const selectZoomFragment = useEditorStore((s) => s.selectZoomFragment);
  const updateSelectedZoomFragment = useEditorStore(
    (s) => s.updateSelectedZoomFragment,
  );
  const duration = useEditorStore((s) => s.duration);
  const segments = useEditorStore((s) => s.segments);
  const exporting = useEditorStore((s) => s.exporting);
  const exportError = useEditorStore((s) => s.exportError);
  const project = useEditorStore((s) => s.project);
  const projectId = useEditorStore((s) => s.projectId);
  const screenshotId = useEditorStore((s) => s.screenshotId);
  const aspectRatioPresetId = useEditorStore((s) => s.aspectRatioPresetId);
  const backgroundType = useEditorStore((s) => s.backgroundType);
  const historyPast = useEditorStore((s) => s.historyPast);
  const historyFuture = useEditorStore((s) => s.historyFuture);
  const selectedPerspectiveFragmentId = useEditorStore((s) => s.selectedPerspectiveFragmentId);
  const selectedBlurRegionId = useEditorStore((s) => s.selectedBlurRegionId);
  const selectedSpeedRangeId = useEditorStore((s) => s.selectedSpeedRangeId);
  const selectedTextClipId = useEditorStore((s) => s.selectedTextClipId);
  const stage = useStageDimensions();
  const [activeTool, setActiveTool] = useState<EditorToolId>("background");
  const [panelOpen, setPanelOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [canvasHost, setCanvasHost] = useState<HTMLDivElement | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [screenshotExportOpen, setScreenshotExportOpen] = useState(false);
  const [screenshotFormat, setScreenshotFormat] = useState<"png" | "jpeg">("png");
  const [screenshotExporting, setScreenshotExporting] = useState(false);
  const [shell, setShell] = useState<"editor" | "library">(initialShell);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const screenshotFrameRef = useRef<(() => HTMLCanvasElement | null) | null>(null);

  const chooseTool = useCallback((tool: EditorToolId) => {
    if (activeTool === tool && panelOpen) {
      setPanelOpen(false);
      return;
    }
    setActiveTool(tool);
    setPanelOpen(true);
    setInspectorPanel(tool === "image" || tool === "cursor" || tool === "camera"
      || tool === "zoom" || tool === "captions" || tool === "config" ? tool : "look");
  }, [activeTool, panelOpen, setInspectorPanel]);

  useEffect(() => {
    if (inspectorPanel === "zoom" || inspectorPanel === "image" || inspectorPanel === "cursor"
      || inspectorPanel === "camera" || inspectorPanel === "captions" || inspectorPanel === "config") {
      setActiveTool(inspectorPanel);
      setPanelOpen(true);
    }
  }, [inspectorPanel]);

  useEffect(() => {
    if (screenshotId) return;
    const selectedTool = selectedPerspectiveFragmentId ? "perspective"
      : selectedBlurRegionId ? "mask" : selectedSpeedRangeId ? "speed"
        : selectedTextClipId ? "text" : selectedZoomFragmentId ? "zoom" : null;
    if (!selectedTool) return;
    setActiveTool(selectedTool);
    setPanelOpen(true);
  }, [screenshotId, selectedPerspectiveFragmentId, selectedBlurRegionId,
    selectedSpeedRangeId, selectedTextClipId, selectedZoomFragmentId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") === "library") {
      useEditorStore.setState({ ready: true, error: null });
      // Rust already showed this window on the active display — don't re-present
      // (that used to yank to the primary monitor and flash Spaces).
      return;
    }
    const screenshot = params.get("screenshot");
    const id = params.get("project") ?? screenshot;
    if (id) void init(id, screenshot !== null);
    else
      useEditorStore.setState({ ready: true, error: "No project id in URL." });
  }, [init]);

  // One-shot banner after a dead-GPU reload (export reclaim failed).
  useEffect(() => {
    if (consumeGpuReloadedBanner()) {
      showError(t("editor.gpuReloaded"));
    }
  }, [t]);

  // Drop the HTML splash once the shell can paint (library chrome, or editor
  // after `loadProject`). Idempotent — in-window library switches stay splash-free.
  useEffect(() => {
    if (shell === "library" || ready || error) dismissEditorSplash();
  }, [shell, ready, error]);

  useEffect(() => {
    let alive = true;
    const unlisten = listen(SHOW_LIBRARY_EVENT, () => {
      if (alive) setShell("library");
    });
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Closing the editor destroys the webview — a debounced save still in its
  // 400ms window, or an IPC write still in flight, would die with it. Flush on
  // hide/pagehide (best-effort), and on native close *await* the save chain
  // before destroy so the last edit lands.
  //
  // `onCloseRequested` intercepts the close; we `preventDefault`, persist, then
  // `destroy()`. Needs `core:window:allow-destroy` (capabilities/editor.json).
  useEffect(() => {
    const flush = () => useEditorStore.getState().flushEditorPersist();
    const onPageHide = () => {
      void flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);

    let closing = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    void win
      .onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();
        closing = true;
        try {
          await flush();
        } finally {
          await win.destroy().catch(() => undefined);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const unlisten = listen<string>("project://finalized", (e) => {
      if (!alive) return;
      const id = e.payload;
      if (!id) return;
      // Editor often opens on the stub before camera.webm is registered — reload.
      const current = useEditorStore.getState().projectId;
      const urlId = new URLSearchParams(window.location.search).get("project");
      if (id === current || id === urlId) void init(id);
    });
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, [init]);

  useEffect(() => {
    if (shell !== "library") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useEditorStore.getState().projectId) {
        setShell("editor");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shell]);

  const openRecordings = useCallback(() => {
    useEditorStore.getState().setPlaying(false);
    setShell("library");
  }, []);

  const openProject = useCallback(
    async (id: string) => {
      await init(id);
      setTimelineOpen(false);
      setPanelOpen(false);
      setActiveTool("background");
      history.replaceState(null, "", `?project=${encodeURIComponent(id)}`);
      setShell("editor");
    },
    [init],
  );

  const openScreenshot = useCallback(
    async (id: string) => {
      await init(id, true);
      setTimelineOpen(false);
      setPanelOpen(false);
      setActiveTool("background");
      history.replaceState(null, "", `?screenshot=${encodeURIComponent(id)}`);
      setShell("editor");
    },
    [init],
  );

  const kept = segments.length > 0 ? totalKeptDuration(segments) : duration;

  const renameTitle = useCallback((next: string) => {
    const { projectId: pid, project: p } = useEditorStore.getState();
    if (!pid || !p) return;
    const title = next.trim() || null;
    const prev = p.title?.trim() || null;
    if (title === prev) return;
    void commands
      .renameProject(pid, title)
      .then(() => {
        useEditorStore.setState({ project: { ...p, title } });
      })
      .catch(() => undefined);
  }, []);

  const runExport = (settings: ExportSettings) => {
    setExportOpen(false);
    void exportProject(settings);
  };

  const exportScreenshot = async (format: "png" | "jpeg") => {
    if (!screenshotId) return;
    let sink: ExportSink | null = null;
    setScreenshotExporting(true);
    try {
      const canvas = screenshotFrameRef.current?.();
      if (!canvas) throw new Error("画像の描画が完了していません");
      const path = await save({
        defaultPath: `${project?.title?.trim() || "Screenshot"}.${format === "png" ? "png" : "jpg"}`,
        filters: [format === "png"
          ? { name: "PNG image", extensions: ["png"] }
          : { name: "JPEG image", extensions: ["jpg", "jpeg"] }],
      });
      if (!path) return;
      const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
      const jpeg = format === "jpeg";
      if (jpeg ? !["jpg", "jpeg"].includes(extension) : extension !== "png") {
        throw new Error(`選んだ形式とファイル名の拡張子が一致しません（${jpeg ? "JPEG" : "PNG"}）`);
      }
      const output = jpeg ? document.createElement("canvas") : canvas;
      if (jpeg) {
        output.width = canvas.width;
        output.height = canvas.height;
        const context = output.getContext("2d");
        if (!context) throw new Error("JPEGの合成に失敗しました");
        context.fillStyle = "#000000";
        context.fillRect(0, 0, output.width, output.height);
        context.drawImage(canvas, 0, 0);
      }
      const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(
        (value) => value ? resolve(value) : reject(new Error("画像を書き出せませんでした")),
        jpeg ? "image/jpeg" : "image/png", 0.92,
      ));
      sink = await ExportSink.open(path);
      await sink.append(new Uint8Array(await blob.arrayBuffer()));
      await sink.finish();
      sink = null;
    } catch (e) {
      if (sink) await sink.abort(e);
      showError(String(e));
    } finally {
      setScreenshotExporting(false);
    }
  };

  /** Seek the shared <video> and store together (playhead + track clicks). */
  const seek = (time: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = presentableVideoTime(time, video.duration);
    useEditorStore.getState().setCurrentTime(time);
  };

  const lookSection: LookSection = activeTool === "background" || activeTool === "crop"
    || activeTool === "mask" || activeTool === "text" || activeTool === "speed"
    || activeTool === "perspective" ? activeTool : "background";
  const lookActive = panelOpen && inspectorPanel === "look";
  const activeRatio = ASPECT_RATIO_PRESETS.find((preset) => preset.id === aspectRatioPresetId);

  if (shell === "library") {
    return (
      <TooltipProvider delayDuration={200}>
        <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
          <EditorTitleBar
            title={t("recorder.library")}
            onBack={
              ready && !error && project
                ? () => setShell("editor")
                : undefined
            }
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RecordingsLibrary
              currentProjectId={projectId}
              onOpenProject={(id) => void openProject(id)}
              onOpenScreenshot={(id) => void openScreenshot(id)}
            />
          </div>
        </div>
      </TooltipProvider>
    );
  }

  const windowTitle = project?.title?.trim() || (screenshotId ? "Screenshot" : t("app.untitled"));

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
        <EditorTitleBar
          title={windowTitle}
          onBack={openRecordings}
          renameSeed={project?.title?.trim() ?? ""}
          onRename={renameTitle}
          exportError={exportError}
          exporting={exporting || screenshotExporting}
          exportDisabled={kept <= 0}
          showExport
          showPresets
          onExport={() => screenshotId ? setScreenshotExportOpen(true) : setExportOpen(true)}
        />
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-card/70 px-4 py-2 pl-24">
          <div className="flex min-w-0 items-center gap-2">
            {!screenshotId && <div className="inline-flex rounded-xl border border-border bg-muted p-1" role="group" aria-label={t("editor.mode.time")}>
              <button type="button" onClick={() => setTimelineOpen(false)} aria-pressed={!timelineOpen}
                className={`rounded-lg px-4 py-1.5 text-xs font-semibold ${!timelineOpen ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {t("editor.mode.canvas")}
              </button>
              <button type="button" onClick={() => setTimelineOpen(true)} aria-pressed={timelineOpen}
                className={`rounded-lg px-4 py-1.5 text-xs font-semibold ${timelineOpen ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {t("editor.mode.time")}
              </button>
            </div>}
            {screenshotId && <span className="text-xs font-semibold text-muted-foreground">{t("editor.imageEdit")}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="gap-1.5" aria-label={t("ratio.label")}>
                  <RectangleHorizontal className="size-4" />
                  {aspectRatioPresetId === "recording" ? t("ratio.match") : activeRatio?.label}
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {ASPECT_RATIO_PRESETS.filter((preset) => preset.id !== "recording" || backgroundType !== "image").map((preset) => (
                  <DropdownMenuItem key={preset.id} onClick={() => useEditorStore.getState().setAspectRatioPreset(preset.id)}
                    className={cn("flex items-center gap-2", aspectRatioPresetId === preset.id && "bg-accent text-accent-foreground")}>
                    <span className="w-10 shrink-0 font-mono text-xs font-medium">
                      {preset.id === "recording" ? t("ratio.match") : preset.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {t(RATIO_HINT_KEY[preset.id])}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button type="button" variant="outline" size="icon" className="size-8" aria-label={t("timeline.undo")}
              disabled={historyPast.length === 0} onClick={() => useEditorStore.getState().undo()}><Undo2 className="size-4" /></Button>
            <Button type="button" variant="outline" size="icon" className="size-8" aria-label={t("timeline.redo")}
              disabled={historyFuture.length === 0} onClick={() => useEditorStore.getState().redo()}><Redo2 className="size-4" /></Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <InspectorChrome
            activeTool={activeTool}
            onToolChange={chooseTool}
            panelOpen={panelOpen}
            onPanelOpenChange={setPanelOpen}
            hasFaceCam={!!cameraUrl}
            isScreenshot={!!screenshotId}
          >
            <LookPanel visible={lookActive} section={lookSection} canvasHost={lookActive ? canvasHost : null} onSeek={seek} />
            {screenshotId && <ScreenshotToolsPanel visible={panelOpen && activeTool === "image"} canvasHost={canvasHost} />}
            <CursorPanel visible={panelOpen && inspectorPanel === "cursor"} />
            <CameraPanel visible={panelOpen && inspectorPanel === "camera"} />
            <ZoomPanel
              visible={panelOpen && inspectorPanel === "zoom"}
              canvasHost={panelOpen && activeTool === "zoom" ? canvasHost : null}
              recordingMetadata={recordingMetadata}
              zoomFragments={zoomFragments}
              selectedZoomFragmentId={selectedZoomFragmentId}
              onSelectZoomFragmentId={selectZoomFragment}
              onSeek={seek}
              updateSelectedZoomFragment={updateSelectedZoomFragment}
            />
            <CaptionsPanel visible={panelOpen && inspectorPanel === "captions"} />
            <ConfigPanel visible={panelOpen && inspectorPanel === "config"} />
          </InspectorChrome>

          <div className="flex min-w-0 flex-1 flex-col">
            <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {error ? (
                <p className="p-6 text-sm text-destructive">{error}</p>
              ) : !ready ? (
                <p className="p-6 text-sm text-muted-foreground">
                  {t("app.loading")}
                </p>
              ) : (
                <PreviewStage videoRef={videoRef} screenshotFrameRef={screenshotFrameRef} onCanvasHost={setCanvasHost} />
              )}
            </main>
          </div>
        </div>

        {ready && !error && !screenshotId && (
          <div className={timelineOpen ? "max-h-[38vh] min-h-[220px] shrink-0 overflow-y-auto" : "hidden"}>
            <Timeline onSeek={seek} videoRef={videoRef} />
          </div>
        )}

        {!screenshotId && <ExportSettingsDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          stageWidth={stage.width}
          stageHeight={stage.height}
          sourceFps={project?.capture?.fps ?? null}
          exporting={exporting}
          onConfirm={runExport}
        />}
        <Dialog open={screenshotExportOpen} onOpenChange={setScreenshotExportOpen}>
          <DialogContent className="gap-5 border-border bg-card p-5 sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>画像を書き出す</DialogTitle>
              <DialogDescription>保存する画像形式を選んでください。</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-2">
              {(["png", "jpeg"] as const).map((format) => (
                <Button key={format} type="button" variant={screenshotFormat === format ? "default" : "outline"}
                  aria-pressed={screenshotFormat === format} onClick={() => setScreenshotFormat(format)}>
                  {format === "png" ? "PNG" : "JPEG"}
                </Button>
              ))}
            </div>
            <Button type="button" onClick={() => { setScreenshotExportOpen(false); void exportScreenshot(screenshotFormat); }}>
              保存先を選ぶ
            </Button>
          </DialogContent>
        </Dialog>
        <ExportProgressOverlay />
      </div>
    </TooltipProvider>
  );
}
