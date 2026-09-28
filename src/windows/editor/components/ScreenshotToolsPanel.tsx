import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight, Circle, Highlighter, MousePointer2, PaintBucket,
  Pencil, Pipette, Redo2, Square, Trash2, Undo2, type LucideIcon,
} from "lucide-react";
import { mediaUrl } from "@/lib/platform";
import { toBlobMediaUrl } from "../lib/mediaBlobUrl";
import { useEditorStore } from "../store";
import { DEFAULT_SCREENSHOT_EDITS, drawScreenshotMarks, type Point, type ScreenshotMark } from "../screenshotModel";

type Tool = "select" | "pen" | "highlighter" | "arrow" | "rect" | "ellipse" | "mask";
const TOOLS: { id: Tool; label: string; icon: LucideIcon }[] = [
  { id: "select", label: "選択・移動", icon: MousePointer2 },
  { id: "pen", label: "ペン", icon: Pencil },
  { id: "highlighter", label: "マーカー", icon: Highlighter },
  { id: "arrow", label: "矢印", icon: ArrowUpRight },
  { id: "rect", label: "四角", icon: Square },
  { id: "ellipse", label: "丸", icon: Circle },
  { id: "mask", label: "塗りつぶし", icon: PaintBucket },
];
const COLORS = ["#ef4444", "#eab308", "#22c55e", "#3b82f6", "#ffffff", "#000000"];
const TOOL_HINT: Record<Tool, string> = {
  select: "画像上の注釈をクリックして選択し、ドラッグで移動できます。",
  pen: "画像上をドラッグして線を描きます。",
  highlighter: "画像上をドラッグして半透明の線を描きます。",
  arrow: "始点から終点へドラッグして矢印を描きます。",
  rect: "ドラッグして四角を描きます。",
  ellipse: "ドラッグして丸を描きます。",
  mask: "ドラッグした範囲を黒く塗りつぶします。",
};

function ColorChoices({ value, onChange, label }: { value: string; onChange: (color: string) => void; label: string }) {
  const isCustom = !COLORS.some((swatch) => swatch.toLowerCase() === value.toLowerCase());
  return <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
    {COLORS.map((swatch) => <button key={swatch} type="button" aria-label={`${label} ${swatch}`}
      aria-pressed={swatch.toLowerCase() === value.toLowerCase()} title={swatch}
      onClick={() => onChange(swatch)}
      className={`size-8 rounded-full border border-border ring-offset-2 ring-offset-card transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${swatch.toLowerCase() === value.toLowerCase() ? "ring-2 ring-primary" : ""}`}
      style={{ backgroundColor: swatch }} />)}
    <label title="ほかの色を選ぶ" className={`relative flex size-8 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-border bg-muted ring-offset-2 ring-offset-card focus-within:ring-2 focus-within:ring-primary ${isCustom ? "ring-2 ring-primary" : ""}`}
      style={isCustom ? { backgroundColor: value } : undefined}>
      <Pipette className="pointer-events-none size-4 text-foreground" aria-hidden />
      <input type="color" aria-label={`${label}を自由に選ぶ`} value={value}
        onChange={(event) => onChange(event.target.value)} className="absolute inset-0 size-full cursor-pointer opacity-0" />
    </label>
  </div>;
}
const clamp = (v: number) => Math.max(0, Math.min(1, v));

function move(mark: ScreenshotMark, dx: number, dy: number): ScreenshotMark {
  const point = (p: Point) => ({ x: clamp(p.x + dx), y: clamp(p.y + dy) });
  if (mark.kind === "path") return { ...mark, points: mark.points.map(point) };
  if (mark.kind === "text") return { ...mark, at: point(mark.at) };
  return { ...mark, from: point(mark.from), to: point(mark.to) };
}

function hit(marks: ScreenshotMark[], p: Point): string | null {
  for (const mark of [...marks].reverse()) {
    if (mark.kind === "text" && Math.abs(mark.at.x - p.x) < 0.08 && Math.abs(mark.at.y - p.y) < 0.05) return mark.id;
    if (mark.kind === "shape") {
      const x0 = Math.min(mark.from.x, mark.to.x) - 0.025;
      const x1 = Math.max(mark.from.x, mark.to.x) + 0.025;
      const y0 = Math.min(mark.from.y, mark.to.y) - 0.025;
      const y1 = Math.max(mark.from.y, mark.to.y) + 0.025;
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return mark.id;
    }
    if (mark.kind === "path" && mark.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.025)) return mark.id;
  }
  return null;
}

export function ScreenshotToolsPanel({ visible, canvasHost }: { visible: boolean; canvasHost?: HTMLDivElement | null }) {
  const id = useEditorStore((s) => s.screenshotId);
  const marks = useEditorStore((s) => s.screenshotMarks);
  const setMarks = useEditorStore((s) => s.setScreenshotMarks);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const gesture = useRef<{ before: ScreenshotMark[]; start: Point; markId?: string } | null>(null);
  const past = useRef<ScreenshotMark[][]>([]);
  const future = useRef<ScreenshotMark[][]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<string | null>(null);
  const [color, setColor] = useState("#ef4444");
  const [width, setWidth] = useState(6);
  const [error, setError] = useState<string | null>(null);
  const [imageAspect, setImageAspect] = useState(16 / 9);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const refreshHistory = () => setHistory({ undo: past.current.length, redo: future.current.length });

  useEffect(() => {
    past.current = [];
    future.current = [];
    gesture.current = null;
    setHistory({ undo: 0, redo: 0 });
    setSelected(null);
    setTool("select");
    setError(null);
  }, [id]);

  useEffect(() => {
    if (!id || !visible || !canvasHost) return;
    let cancelled = false;
    let revoke: (() => void) | null = null;
    void (async () => {
      try {
        const blob = await toBlobMediaUrl(mediaUrl(id, "original.png"));
        revoke = blob.revoke;
        const image = new Image();
        image.src = blob.src;
        await image.decode();
        if (cancelled) return;
        setImageAspect(image.naturalWidth / Math.max(1, image.naturalHeight));
        imageRef.current = image;
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext("2d")?.drawImage(image, 0, 0);
          drawScreenshotMarks(canvas, { width: canvas.width, height: canvas.height },
            { ...DEFAULT_SCREENSHOT_EDITS, marks: useEditorStore.getState().screenshotMarks }, false, "color");
        }
      } catch (e) { if (!cancelled) setError(String(e)); }
    })();
    return () => { cancelled = true; imageRef.current = null; revoke?.(); };
  }, [id, visible, canvasHost]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    drawScreenshotMarks(canvas, { width: canvas.width, height: canvas.height },
      { ...DEFAULT_SCREENSHOT_EDITS, marks }, false, "color");
  }, [marks]);

  const point = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height) };
  };
  const commit = (next: ScreenshotMark[], before = marks) => {
    past.current.push(structuredClone(before));
    future.current = [];
    refreshHistory();
    setMarks(next);
  };
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    const p = point(event);
    const before = structuredClone(marks);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "select") {
      const markId = hit(before, p);
      setSelected(markId);
      gesture.current = markId ? { before, start: p, markId } : null;
      return;
    }
    const markId = crypto.randomUUID();
    gesture.current = { before, start: p, markId };
    if (tool === "pen" || tool === "highlighter") {
      setMarks([...before, { id: markId, kind: "path", points: [p], color, width,
        highlighter: tool === "highlighter" }]);
    }
  };
  const movePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g) return;
    const p = point(event);
    if (tool === "select" && g.markId) {
      setMarks(g.before.map((mark) => mark.id === g.markId
        ? move(mark, p.x - g.start.x, p.y - g.start.y) : mark));
    } else if ((tool === "pen" || tool === "highlighter") && g.markId) {
      const active = useEditorStore.getState().screenshotMarks.find((mark) => mark.id === g.markId);
      if (active?.kind === "path") setMarks(useEditorStore.getState().screenshotMarks.map((mark) =>
        mark.id === g.markId ? { ...active, points: [...active.points, p] } : mark));
    } else if (tool === "arrow" || tool === "rect" || tool === "ellipse" || tool === "mask") {
      setMarks([...g.before, { id: g.markId!, kind: "shape", shape: tool, from: g.start, to: p,
        color: tool === "mask" ? "#000000" : color, width }]);
    }
  };
  const up = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (JSON.stringify(g.before) !== JSON.stringify(useEditorStore.getState().screenshotMarks)) {
      past.current.push(g.before);
      future.current = [];
      refreshHistory();
    }
    gesture.current = null;
  };
  const selectedMark = marks.find((mark) => mark.id === selected);
  const selectedMarkWidth = selectedMark?.kind === "path"
    || (selectedMark?.kind === "shape" && selectedMark.shape !== "mask") ? selectedMark.width : null;
  const selectedMarkHasWidth = selectedMarkWidth !== null;
  useEffect(() => {
    if (selectedMarkWidth !== null) setWidth(selectedMarkWidth);
  }, [selectedMarkWidth]);
  const changeSelected = (update: (mark: ScreenshotMark) => ScreenshotMark) =>
    commit(marks.map((mark) => mark.id === selected ? update(mark) : mark));
  const canUndo = history.undo > 0;
  const canRedo = history.redo > 0;
  return <div className={visible ? "space-y-5" : "hidden"}>
    <p className="text-xs leading-relaxed text-muted-foreground">画像に線や図形を直接描き込めます。</p>
    {visible && canvasHost && createPortal(
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/85">
        <canvas ref={canvasRef} className="pointer-events-auto max-h-full max-w-full touch-none rounded-lg border border-primary/40 bg-black shadow-lg"
          style={{ cursor: tool === "select" ? "move" : "crosshair", aspectRatio: imageAspect,
            width: `min(100%, calc(100cqh * ${imageAspect}))` }}
          onPointerDown={down} onPointerMove={movePointer} onPointerUp={up} onPointerCancel={up} />
      </div>, canvasHost)}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <section className="space-y-2.5" aria-label="描画ツール">
      <h3 className="text-xs font-semibold text-foreground">道具を選ぶ</h3>
      <div className="grid grid-cols-2 gap-2">{TOOLS.map(({ id: toolId, label, icon: Icon }) => <button type="button" key={toolId}
        onClick={() => { setTool(toolId); setSelected(null); }} aria-pressed={tool === toolId}
        className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${tool === toolId
          ? "border-primary bg-primary/10 text-primary shadow-sm" : "border-border bg-background text-foreground hover:bg-muted"}`}>
        <Icon className="size-4 shrink-0" strokeWidth={1.8} aria-hidden />{label}
      </button>)}</div>
      <p className="min-h-8 text-xs leading-relaxed text-muted-foreground" aria-live="polite">{TOOL_HINT[tool]}</p>
    </section>
    {tool !== "select" && tool !== "mask" && <section className="space-y-4 border-t border-border pt-4" aria-label="これから描く注釈の設定">
      <div className="space-y-2.5">
        <h3 className="text-xs font-semibold text-foreground">描画色</h3>
        <ColorChoices value={color} onChange={setColor} label="描画色" />
      </div>
      <label className="block space-y-2 text-xs font-semibold text-foreground">
        <span className="flex items-center justify-between"><span>線の太さ</span><span className="tabular-nums text-muted-foreground">{width} px</span></span>
        <input type="range" min={1} max={32} value={width} aria-label="これから描く線の太さ"
          onChange={(event) => setWidth(Number(event.target.value))} className="w-full accent-primary" />
      </label>
    </section>}
    {tool === "select" && selectedMark && <section className="space-y-4 rounded-xl border border-border bg-muted/30 p-3" aria-label="選択中の注釈の設定">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground">選択中の注釈</h3>
        <button type="button" aria-label="選択中の注釈を削除" title="選択中の注釈を削除"
          className="flex size-8 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => { commit(marks.filter((mark) => mark.id !== selected)); setSelected(null); }}>
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
      {selectedMark.kind === "text" && <>
        <label className="block space-y-1.5 text-xs font-medium">文字
          <textarea value={selectedMark.text}
            onChange={(event) => changeSelected((mark) => mark.kind === "text"
              ? { ...mark, text: event.target.value } : mark)}
            className="w-full rounded-lg border border-border bg-background p-2 text-sm" />
        </label>
        <label className="block space-y-2 text-xs font-medium">
          <span className="flex justify-between"><span>文字サイズ</span><span className="tabular-nums">{selectedMark.fontSize} px</span></span>
          <input type="range" min={12} max={160} value={selectedMark.fontSize}
            onChange={(event) => changeSelected((mark) => mark.kind === "text"
              ? { ...mark, fontSize: Number(event.target.value) } : mark)}
            className="w-full accent-primary" />
        </label>
      </>}
      <div className="space-y-2">
        <h4 className="text-xs font-medium">色</h4>
        <ColorChoices value={selectedMark.color}
          onChange={(nextColor) => changeSelected((mark) => ({ ...mark, color: nextColor }))} label="選択中の注釈の色" />
      </div>
      {selectedMarkHasWidth && <label className="block space-y-2 text-xs font-medium">
        <span className="flex justify-between"><span>線の太さ</span><span className="tabular-nums">{selectedMarkWidth} px</span></span>
        <input type="range" min={1} max={32} value={selectedMarkWidth ?? 1}
          onChange={(event) => { const nextWidth = Number(event.target.value); setWidth(nextWidth);
            changeSelected((mark) => mark.kind === "path" || (mark.kind === "shape" && mark.shape !== "mask")
              ? { ...mark, width: nextWidth } : mark); }} className="w-full accent-primary" />
      </label>}
    </section>}
    <div className="grid grid-cols-2 gap-2 border-t border-border pt-4 text-xs">
      <button type="button" disabled={!canUndo} className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => { const prev = past.current.pop(); if (!prev) return;
          future.current.push(structuredClone(marks)); setMarks(prev); refreshHistory(); }}>
        <Undo2 className="size-4" aria-hidden />元に戻す
      </button>
      <button type="button" disabled={!canRedo} className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => { const next = future.current.pop(); if (!next) return;
          past.current.push(structuredClone(marks)); setMarks(next); refreshHistory(); }}>
        <Redo2 className="size-4" aria-hidden />やり直す
      </button>
    </div>
  </div>;
}
