/**
 * In-editor recordings grid. Posters are small JPEGs written at record-time
 * (`thumbnail.jpg`); the library never decodes screen.mp4.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Clapperboard, ImageIcon, LoaderCircle, MoreHorizontal, RefreshCw, Search, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { commands } from "@/ipc/bindings";
import type { ProjectSummary, ScreenshotSummary } from "@/ipc/types";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { mediaUrl } from "../store";

function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(d);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

type LibraryItem = (ProjectSummary & { kind: "video" }) | (ScreenshotSummary & { kind: "screenshot" });

function displayTitle(p: LibraryItem): string {
  return p.title?.trim() || (p.kind === "screenshot" ? "Screenshot" : "Untitled recording");
}

function matchesNameFilter(project: LibraryItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return displayTitle(project).toLowerCase().includes(needle);
}

/** Poster from `thumbnail.jpg` only — backfill once if the file is missing. */
function RecordingThumb({ projectId, thumbnail, screenshot, japanese }: { projectId: string; thumbnail: string | null; screenshot: boolean; japanese: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<string | null>(thumbnail);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFile(thumbnail);
    setFailed(false);
  }, [projectId, thumbnail]);

  useEffect(() => {
    if (file || failed || screenshot) return;
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        void commands
          .ensureThumbnail(projectId)
          .then((name) => {
            if (!cancelled && name) setFile(name);
            else if (!cancelled) setFailed(true);
          })
          .catch(() => {
            if (!cancelled) setFailed(true);
          });
      },
      { rootMargin: "200px" },
    );
    io.observe(host);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [projectId, file, failed, screenshot]);

  return (
    <div ref={hostRef} className="aspect-video w-full overflow-hidden bg-secondary">
      {file ? (
        <img
          src={mediaUrl(projectId, file)}
          alt=""
          className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.025] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
          loading="lazy"
          decoding="async"
          onError={() => {
            setFile(null);
            setFailed(true);
          }}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          {failed ? <ImageIcon className="size-6" aria-hidden /> : <LoaderCircle className="size-6 animate-spin motion-reduce:animate-none" aria-hidden />}
          <span className="text-xs font-medium">
            {failed
              ? (japanese ? "プレビューを表示できません" : "Preview unavailable")
              : (japanese ? "プレビューを準備中" : "Preparing preview")}
          </span>
        </div>
      )}
    </div>
  );
}

type RecordingsLibraryProps = {
  currentProjectId: string | null;
  onOpenProject: (id: string) => void;
  onOpenScreenshot: (id: string) => void;
};

export function RecordingsLibrary({ currentProjectId, onOpenProject, onOpenScreenshot }: RecordingsLibraryProps) {
  const { t, language } = useI18n();
  const japanese = language === "ja";
  const [projects, setProjects] = useState<LibraryItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [, startTransition] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);

  const filteredProjects = useMemo(
    () => projects.filter((p) => matchesNameFilter(p, nameFilter)),
    [projects, nameFilter],
  );

  const applyNameFilter = useCallback(() => {
    setNameFilter(searchDraft.trim());
  }, [searchDraft]);

  const clearNameFilter = useCallback(() => {
    setSearchDraft("");
    setNameFilter("");
    searchRef.current?.focus();
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [videos, screenshots] = await Promise.all([commands.listProjects(), commands.listScreenshots()]);
      const list: LibraryItem[] = [
        ...videos.map((p) => ({ ...p, kind: "video" as const })),
        ...screenshots.map((p) => ({ ...p, kind: "screenshot" as const })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      startTransition(() => {
        setProjects(list);
        setLoading(false);
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load recordings");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (id: string, title: string) => {
    if (!window.confirm(japanese ? `「${title}」を削除しますか？この操作は取り消せません。` : `Delete “${title}”? This cannot be undone.`)) return;
    setBusyId(id);
    setActionError(null);
    try {
      await commands.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <header className="mx-auto w-full max-w-[1600px] shrink-0 px-6 pb-1 pt-9 sm:px-10 sm:pt-11">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-[38px]">{japanese ? "ライブラリ" : "Library"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {japanese ? "録画とスクリーンショット" : "Recordings and screenshots"}
        </p>
      </header>

      <div className="mx-auto w-full max-w-[1600px] flex-1 px-6 pb-12 pt-6 sm:px-10">
        <form
          className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(e) => {
            e.preventDefault();
            applyNameFilter();
          }}
        >
          <div className="relative min-w-0 flex-1 sm:max-w-[450px]">
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              ref={searchRef}
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder={t("library.search.placeholder")}
              aria-label={t("library.search.placeholder")}
              className={cn(
                "h-11 w-full rounded-xl border border-border bg-card py-2 pr-9 pl-10 text-sm text-foreground shadow-sm",
                "placeholder:text-muted-foreground outline-none transition-colors",
                "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25",
              )}
            />
            {nameFilter ? (
              <button
                type="button"
                onClick={clearNameFilter}
                className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                aria-label={t("library.search.clear")}
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
          <Button type="submit" className="h-11 shrink-0 rounded-xl px-7 font-medium sm:w-auto">
            {japanese ? "検索" : t("library.search.filter")}
          </Button>
        </form>

        {actionError ? (
          <div className="mb-4 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
            {japanese ? "削除できませんでした。" : "Could not delete the item."} {actionError}
          </div>
        ) : null}

        {loadError && projects.length > 0 ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
            <span>{japanese ? "一覧を更新できませんでした。表示中の作品は前回の結果です。" : "Could not refresh. Showing the previous list."}</span>
            <button type="button" onClick={() => void refresh()} className="shrink-0 font-medium underline underline-offset-2">{japanese ? "再読み込み" : "Retry"}</button>
          </div>
        ) : null}

        {loading && projects.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card text-muted-foreground" role="status">
            <LoaderCircle className="size-6 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
            <p className="text-sm">{japanese ? "作品を読み込んでいます" : "Loading your items"}</p>
          </div>
        ) : loadError && projects.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border border-destructive/25 bg-card px-6 text-center" role="alert">
            <p className="font-medium">{japanese ? "作品を読み込めませんでした" : "Could not load your items"}</p>
            <p className="max-w-lg text-xs text-muted-foreground">{loadError}</p>
            <Button type="button" onClick={() => void refresh()} variant="outline" className="gap-2">
              <RefreshCw className="size-4" aria-hidden />{japanese ? "再読み込み" : "Retry"}
            </Button>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card px-6 text-center">
            <Clapperboard className="size-7 text-muted-foreground" aria-hidden />
            <p className="font-medium">{japanese ? "まだ作品がありません" : "No items yet"}</p>
            <p className="text-sm text-muted-foreground">{japanese ? "メニューバーから撮影すると、ここに表示されます。" : "Capture from the menu bar to see it here."}</p>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card px-6 text-center">
            <Search className="size-7 text-muted-foreground" aria-hidden />
            <p className="font-medium">{t("library.search.noMatch")}</p>
            <Button type="button" variant="outline" onClick={clearNameFilter}>{t("library.search.clear")}</Button>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {filteredProjects.map((p) => {
              const title = displayTitle(p);
              const busy = busyId === p.id;
              const isCurrent = p.id === currentProjectId;
              return (
                <li key={p.id}>
                  <article
                    aria-busy={busy}
                    className={cn(
                      "group overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-[border-color,box-shadow] hover:border-primary/35 hover:shadow-md",
                      isCurrent && "ring-2 ring-primary/60",
                    )}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => p.kind === "screenshot" ? onOpenScreenshot(p.id) : onOpenProject(p.id)}
                      aria-label={japanese ? `${title}を編集` : `Edit ${title}`}
                      className="block w-full cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <RecordingThumb projectId={p.id} thumbnail={p.thumbnail} screenshot={p.kind === "screenshot"} japanese={japanese} />
                    </button>

                    <div className="flex items-start gap-2 px-4 py-3.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => p.kind === "screenshot" ? onOpenScreenshot(p.id) : onOpenProject(p.id)}
                        className="min-w-0 flex-1 cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <span className="block truncate text-[15px] font-semibold text-card-foreground">
                          {title}
                        </span>
                        <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                          {p.kind === "screenshot" ? <ImageIcon className="size-3.5" aria-hidden /> : <Clapperboard className="size-3.5" aria-hidden />}
                          {p.kind === "screenshot" ? (japanese ? "スクリーンショット" : "Screenshot") : (japanese ? "録画" : "Recording")}
                          {busy ? <span className="ml-auto shrink-0">{japanese ? "削除中…" : "Deleting…"}</span> : null}
                          {!busy && p.kind === "video" ? <span className="ml-auto shrink-0 rounded-full bg-secondary px-2 py-0.5 font-medium tabular-nums text-secondary-foreground">{formatDuration(p.durationSeconds)}</span> : null}
                        </span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">
                          {formatCreatedAt(p.createdAt)}
                        </span>
                      </button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0 text-muted-foreground"
                            disabled={busy}
                            aria-label={japanese ? `${title}の操作` : `Actions for ${title}`}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => void remove(p.id, title)}
                          >
                            <Trash2 className="size-4" />
                            {japanese ? "削除" : "Delete"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
