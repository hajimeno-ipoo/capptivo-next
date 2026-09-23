import { useEffect, useRef, useState, type PointerEvent } from "react";
import { mediaUrl } from "@/lib/platform";
import { toBlobMediaUrl } from "../lib/mediaBlobUrl";
import { useEditorStore } from "../store";
import { DEFAULT_SCREENSHOT_EDITS, drawScreenshotMarks, type Point, type ScreenshotMark } from "../screenshotModel";

type Tool = "select" | "pen" | "highlighter" | "arrow" | "rect" | "ellipse" | "mask";
const TOOLS: { id: Tool; label: string }[] = [
  { id: "select", label: "選択・移動" }, { id: "pen", label: "ペン" },
  { id: "highlighter", label: "マーカー" }, { id: "arrow", label: "矢印" },
  { id: "rect", label: "四角" }, { id: "ellipse", label: "丸" },
  { id: "mask", label: "塗りつぶし" },
];
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

export function ScreenshotToolsPanel({ visible }: { visible: boolean }) {
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

  useEffect(() => {
    if (!id) return;
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
  }, [id]);

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
  return <div className={visible ? "space-y-5" : "hidden"}>
    <p className="text-xs text-muted-foreground">元画像上の描画です。背景・範囲のマスクとハイライト・文字は共通の編集機能を使います。</p>
    <canvas ref={canvasRef} className="w-full touch-none rounded-lg border border-border bg-black"
      style={{ cursor: tool === "select" ? "move" : "crosshair" }}
      onPointerDown={down} onPointerMove={movePointer} onPointerUp={up} onPointerCancel={up} />
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="grid grid-cols-2 gap-1">{TOOLS.map((item) => <button type="button" key={item.id}
      onClick={() => setTool(item.id)} aria-pressed={tool === item.id}
      className={`rounded-md border px-2 py-1.5 text-left text-xs ${tool === item.id
        ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted"}`}>{item.label}</button>)}</div>
    <div className="flex items-center gap-2"><input type="color" aria-label="描画色" value={color}
      onChange={(event) => setColor(event.target.value)} /><span className="text-xs">描画色</span></div>
    <label className="block text-xs">線の太さ {width}<input type="range" min={1} max={32} value={width}
      onChange={(event) => {
        const nextWidth = Number(event.target.value);
        setWidth(nextWidth);
        if (selectedMarkHasWidth) changeSelected((mark) => mark.kind === "path"
          || (mark.kind === "shape" && mark.shape !== "mask") ? { ...mark, width: nextWidth } : mark);
      }} className="w-full accent-primary" /></label>
    {selectedMark && <div className="space-y-2 border-t border-border pt-4">
      <p className="text-xs font-semibold">選択中の注釈</p>
      {selectedMark.kind === "text" && <>
        <textarea aria-label="文字" value={selectedMark.text}
          onChange={(event) => changeSelected((mark) => mark.kind === "text"
            ? { ...mark, text: event.target.value } : mark)}
          className="w-full rounded border border-border bg-background p-2 text-sm" />
        <label className="block text-xs">文字サイズ {selectedMark.fontSize}
          <input type="range" min={12} max={160} value={selectedMark.fontSize}
            onChange={(event) => changeSelected((mark) => mark.kind === "text"
              ? { ...mark, fontSize: Number(event.target.value) } : mark)}
            className="w-full accent-primary" /></label>
      </>}
      <input type="color" aria-label="選択した注釈の色" value={selectedMark.color}
        onChange={(event) => changeSelected((mark) => ({ ...mark, color: event.target.value }))} />
      <button type="button" className="block rounded border border-destructive px-2 py-1 text-xs text-destructive"
        onClick={() => { commit(marks.filter((mark) => mark.id !== selected)); setSelected(null); }}>削除</button>
    </div>}
    <div className="flex gap-2 border-t border-border pt-4 text-xs">
      <button type="button" disabled={past.current.length === 0} className="rounded border px-2 py-1 disabled:opacity-40"
        onClick={() => { const prev = past.current.pop(); if (!prev) return;
          future.current.push(structuredClone(marks)); setMarks(prev); }}>元に戻す</button>
      <button type="button" disabled={future.current.length === 0} className="rounded border px-2 py-1 disabled:opacity-40"
        onClick={() => { const next = future.current.pop(); if (!next) return;
          past.current.push(structuredClone(marks)); setMarks(next); }}>やり直す</button>
    </div>
  </div>;
}
