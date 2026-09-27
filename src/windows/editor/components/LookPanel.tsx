/**
 * The "Look" inspector panel — background selection + composition sliders.
 * Mirrors the web editor's `EditorLookPanel` design (tabs, preset grids, effect
 * sliders) using the ported design tokens.
 */

import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Plus } from "lucide-react";
import { getCompositionLayout, PERSPECTIVE_PIVOT_POINTS, perspectiveEditPreviewTime, type PerspectiveFragment, type PerspectivePivot } from "@/engine";

import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/lib/settings";
import type { TranslationKey } from "@/lib/i18n";
import { customBackgroundUrl } from "@/lib/platform";
import { commands } from "@/ipc/bindings";

import { useEditorStore } from "../store";
import { cn } from "../lib/cn";
import { supportsEditorFeature } from "../lib/editorMode";
import { screenPreviewUrl } from "../lib/screenPreviewUrl";
import { computePerspectiveCorners } from "../lib/perspectiveTransform";
import {
  BACKGROUND_TYPE_TABS,
  clampGradientAngle,
  gradientToCss,
  type BackgroundPreset,
  type BackgroundType,
} from "../lib/backgroundPresets";
import {
  maxDevicePaddingFor,
  PERSPECTIVE_LIMITS,
  resolveRecordingLayoutParams,
} from "../lib/composition";
import { useStageDimensions } from "../lib/useStageDimensions";
import { formatTimelineTime } from "../lib/timelineMath";
import { FieldLabel, SectionLabel } from "./ui";
import { ScreenContentCropPanel } from "./ScreenContentCropPanel";
import { BlurRegionsPanel } from "./BlurRegionsPanel";
import { ClipTimingDisplay } from "./ClipTimingDisplay";
import { TextClipsPanel } from "./TextClipsPanel";
import type { InspectorCompositionLayout } from "./InspectorCompositionFrame";

const selectedRing = "border-primary ring-2 ring-primary/40";
const idleRing = "border-border hover:border-foreground/30";

const BG_TAB_LABEL_KEY: Record<BackgroundType, TranslationKey> = {
  image: "bg.image",
  gradient: "bg.gradient",
  color: "bg.color",
};
type BackgroundPanelTab = BackgroundType | "mac-wallpaper";

export type LookSection = "background" | "crop" | "mask" | "text" | "speed" | "perspective";

export function LookPanel({ visible = true, section = "background", canvasHost, onSeek }: {
  visible?: boolean;
  section?: LookSection;
  canvasHost?: HTMLDivElement | null;
  onSeek: (time: number) => void;
}) {
  const { t } = useI18n();
  const blurRegions = useEditorStore((s) => s.blurRegions);
  const addBlurRegion = useEditorStore((s) => s.addBlurRegion);
  const updateBlurRegion = useEditorStore((s) => s.updateBlurRegion);
  const removeBlurRegion = useEditorStore((s) => s.removeBlurRegion);
  const selectBlurRegion = useEditorStore((s) => s.selectBlurRegion);
  const selectedBlurRegionId = useEditorStore((s) => s.selectedBlurRegionId);
  const duration = useEditorStore((s) => s.duration);
  const backgroundType = useEditorStore((s) => s.backgroundType);
  const [backgroundTab, setBackgroundTab] = useState<BackgroundPanelTab>(backgroundType);
  useEffect(() => {
    setBackgroundTab((current) =>
      backgroundType === "image" && current === "mac-wallpaper" ? current : backgroundType,
    );
  }, [backgroundType]); // Mac wallpapers use the image renderer, but keep their own visible tab.
  const isScreenshot = useEditorStore((s) => s.screenshotId !== null);
  const setBackgroundType = useEditorStore((s) => s.setBackgroundType);
  const selectedBackground = useEditorStore((s) => s.selectedBackground);
  const previewUrl = useEditorStore((s) =>
    screenPreviewUrl(s.proxyUrl, s.screenUrl),
  );
  const sourceAspect = useEditorStore((s) => s.sourceAspect);
  const sourceVideoSize = useEditorStore((s) => s.sourceVideoSize);
  const aspectRatioPresetId = useEditorStore((s) => s.aspectRatioPresetId);
  const look = useEditorStore((s) => s.look);
  const screenContentCrop = useEditorStore((s) => s.screenContentCrop);
  const setScreenContentCrop = useEditorStore((s) => s.setScreenContentCrop);
  // Freeze preview frame while playing — continuous seeks thrash media:// decode.
  // Selector returns a stable `undefined` during play so clock ticks do not
  // re-render this panel.
  const cropPreviewTime = useEditorStore((s) =>
    s.isPlaying ? undefined : s.currentTime,
  );
  const selectedPerspectiveFragment = useEditorStore((s) =>
    s.perspectiveFragments.find((fragment) => fragment.id === s.selectedPerspectiveFragmentId) ?? null,
  );
  const perspectiveFragments = useEditorStore((s) => s.perspectiveFragments);
  const selectPerspectiveFragment = useEditorStore((s) => s.selectPerspectiveFragment);
  const updateSelectedPerspectiveFragment = useEditorStore(
    (s) => s.updateSelectedPerspectiveFragment,
  );
  const stageDimensions = useStageDimensions();
  const layoutParams = resolveRecordingLayoutParams({
    presetId: aspectRatioPresetId,
    sourceAspect,
    sourceVideoSize,
    hasSelectedBackground: selectedBackground !== null,
    hasImageBackground: selectedBackground !== null && backgroundType === "image",
    devicePadding: look.devicePadding,
    screenContentCrop,
  });
  const composition: InspectorCompositionLayout = {
    stageDimensions,
    recordingRect: getCompositionLayout(
      layoutParams.sourceAspect,
      stageDimensions.width,
      stageDimensions.height,
      layoutParams.devicePadding,
    ).video,
    screenContentCrop,
    background: selectedBackground,
    cornerRadius: look.cornerRadius,
  };
  const sortedPerspectiveFragments = [...perspectiveFragments].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id),
  );
  const selectPerspectiveAndSeek = (id: string) => {
    const fragment = perspectiveFragments.find((candidate) => candidate.id === id);
    if (!fragment) return;
    const { isPlaying, setPlaying } = useEditorStore.getState();
    if (isPlaying) setPlaying(false);
    selectPerspectiveFragment(id);
    onSeek(perspectiveEditPreviewTime(fragment));
  };

  return (
    <div className={cn("flex flex-col gap-7", !visible && "hidden")}>
      {section === "background" && <div className="space-y-2">
        <SectionLabel>{t("look.background")}</SectionLabel>

        <div className="grid w-full grid-cols-4 items-center rounded-xl bg-muted p-1">
          {[...BACKGROUND_TYPE_TABS, { id: "mac-wallpaper" as const }].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setBackgroundTab(tab.id);
                setBackgroundType(tab.id === "mac-wallpaper" ? "image" : tab.id);
              }}
              className={cn(
                "rounded-lg px-1.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
                backgroundTab === tab.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(tab.id === "mac-wallpaper" ? "bg.macWallpaper" : BG_TAB_LABEL_KEY[tab.id])}
            </button>
          ))}
        </div>

        {backgroundTab === "image" && <ImageGrid />}
        {backgroundTab === "mac-wallpaper" && <MacWallpaperGrid />}
        {backgroundTab === "gradient" && <GradientGrid />}
        {backgroundTab === "color" && <ColorGrid />}
      </div>}

      {section === "crop" && previewUrl && (selectedBackground || isScreenshot) && (
        <ScreenContentCropPanel
          key="screen-content-crop"
          videoUrl={previewUrl}
          fileAspect={sourceAspect}
          hasBackground={selectedBackground !== null || isScreenshot}
          value={screenContentCrop}
          onChange={setScreenContentCrop}
          seekTo={cropPreviewTime}
          canvasHost={canvasHost}
        />
      )}

      {section === "mask" && previewUrl && (
        <BlurRegionsPanel
          key="blur-regions"
          fileAspect={sourceAspect}
          duration={duration}
          regions={blurRegions}
          selectedId={selectedBlurRegionId}
          onSelect={selectBlurRegion}
          onSeek={onSeek}
          onAdd={addBlurRegion}
          onChange={updateBlurRegion}
          onRemove={removeBlurRegion}
          seekTo={cropPreviewTime}
          composition={composition}
          sourceVideoSize={sourceVideoSize}
          canvasHost={canvasHost}
        />
      )}

      {section === "speed" && <SpeedControls onSeek={onSeek} />}
      {section === "text" && <TextClipsPanel composition={composition} canvasHost={canvasHost} onSeek={onSeek} />}

      {section === "background" && selectedBackground && <LookSliders />}
      {section === "perspective" && sortedPerspectiveFragments.length > 0 && (
        <div className="space-y-2">
          <FieldLabel htmlFor="inspector-perspective-fragment">{`${t("look.threeD")} · ${t("clip.fragment.label")}`}</FieldLabel>
          <Select
            value={selectedPerspectiveFragment?.id}
            onValueChange={selectPerspectiveAndSeek}
          >
            <SelectTrigger id="inspector-perspective-fragment" className="h-9 w-full">
              <SelectValue placeholder={t("clip.fragment.placeholder")} />
            </SelectTrigger>
            <SelectContent>
              {sortedPerspectiveFragments.map((fragment, index) => (
                <SelectItem key={fragment.id} value={fragment.id}
                  onPointerUp={() => { if (selectedPerspectiveFragment?.id === fragment.id) selectPerspectiveAndSeek(fragment.id); }}
                  onKeyDown={(event) => { if (event.key === "Enter" && selectedPerspectiveFragment?.id === fragment.id) selectPerspectiveAndSeek(fragment.id); }}>
                  {`${index + 1}. ${formatTimelineTime(fragment.start)} – ${formatTimelineTime(fragment.end)} · ${t("look.threeD")}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {section === "perspective" && !selectedPerspectiveFragment && (
        <Button type="button" variant="secondary" size="sm" onClick={() => useEditorStore.getState().addFragment("perspective")}>
          {t("timeline.addFragment")} · {t("look.threeD")}
        </Button>
      )}
      {section === "perspective" && selectedPerspectiveFragment && (
        <ThreeDPerspective
          fragment={selectedPerspectiveFragment}
          updateFragment={updateSelectedPerspectiveFragment}
          stageWidth={stageDimensions.width}
        />
      )}
      {section === "background" && selectedBackground && <BackgroundEffects />}
    </div>
  );
}

function SpeedControls({ onSeek }: { onSeek: (time: number) => void }) {
  const { t } = useI18n();
  const isScreenshot = useEditorStore((s) => s.screenshotId !== null);
  const speedEnabled = supportsEditorFeature(isScreenshot ? "screenshot" : "video", "speed");
  const speed = useEditorStore((s) => s.globalSpeed);
  const ranges = useEditorStore((s) => s.speedRanges);
  const selectedId = useEditorStore((s) => s.selectedSpeedRangeId);
  const selected = ranges.find((range) => range.id === selectedId) ?? null;
  const selectSpeedRange = useEditorStore((s) => s.selectSpeedRange);
  const setGlobalSpeed = useEditorStore((s) => s.setGlobalSpeed);
  const addSpeedRange = useEditorStore((s) => s.addSpeedRange);
  const updateSpeedRange = useEditorStore((s) => s.updateSpeedRange);
  const autoSpeedTyping = useEditorStore((s) => s.autoSpeedTyping);
  const sortedRanges = [...ranges].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id),
  );
  const selectRangeAndSeek = (id: string) => {
    const range = ranges.find((candidate) => candidate.id === id);
    if (!range) return;
    const { isPlaying, setPlaying } = useEditorStore.getState();
    if (isPlaying) setPlaying(false);
    selectSpeedRange(id);
    onSeek(range.start);
  };

  return (
    <section className={cn("space-y-3", !speedEnabled && "opacity-40")} aria-disabled={!speedEnabled}>
      <SectionLabel>{t("export.gifSpeed")}</SectionLabel>
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t("speed.wholeVideo")}</span>
          <span className="tabular-nums">{speed.toFixed(2)}×</span>
        </div>
        <Slider
          min={0.25}
          disabled={!speedEnabled}
          max={4}
          step={0.05}
          value={[speed]}
          onValueChange={([value]) => setGlobalSpeed(value ?? speed)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={!speedEnabled} onClick={() => addSpeedRange()}>
          {t("speed.addRange")}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={!speedEnabled} onClick={autoSpeedTyping}>
          {t("speed.autoTyping")}
        </Button>
      </div>
      {sortedRanges.length > 0 && (
        <div className="space-y-2">
          <FieldLabel htmlFor="inspector-speed-range">{`${t("speed.selectedRange")} · ${t("clip.fragment.label")}`}</FieldLabel>
          <Select value={selected?.id} onValueChange={selectRangeAndSeek} disabled={!speedEnabled}>
            <SelectTrigger id="inspector-speed-range" className="h-9 w-full">
              <SelectValue placeholder={t("clip.fragment.placeholder")} />
            </SelectTrigger>
            <SelectContent>
              {sortedRanges.map((range, index) => (
                <SelectItem key={range.id} value={range.id}
                  onPointerUp={() => { if (selected?.id === range.id) selectRangeAndSeek(range.id); }}
                  onKeyDown={(event) => { if (event.key === "Enter" && selected?.id === range.id) selectRangeAndSeek(range.id); }}>
                  {`${index + 1}. ${formatTimelineTime(range.start)} – ${formatTimelineTime(range.end)}`}
                  {` · ${t(range.autoTyping ? "speed.typing" : "speed.selectedRange")} ${range.rate.toFixed(2)}×`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {selected ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-2">
          <div className="text-xs text-muted-foreground">{t(selected.autoTyping ? "speed.typing" : "speed.selectedRange")}</div>
          <ClipTimingDisplay start={selected.start} end={selected.end} />
          <Slider
            min={0.25}
            disabled={!speedEnabled}
            max={4}
            step={0.05}
            value={[selected.rate]}
            onValueChange={([value]) => updateSpeedRange(selected.id, { rate: value ?? selected.rate })}
          />
          <div className="text-right text-xs tabular-nums text-muted-foreground">{selected.rate.toFixed(2)}×</div>
        </div>
      ) : null}
    </section>
  );
}

function ImageGrid() {
  const { t } = useI18n();
  const presets = useEditorStore((s) => s.imagePresets);
  const selected = useEditorStore((s) => s.selectedBackground);
  const select = useEditorStore((s) => s.selectBackground);
  const customs = useEditorStore((s) => s.customImageBackgrounds);
  const uploadCustomBackground = useEditorStore((s) => s.uploadCustomBackground);
  const deleteCustomBackground = useEditorStore((s) => s.deleteCustomBackground);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void uploadCustomBackground(file);
    e.target.value = ""; // let the same file be re-picked
  };

  const closeMenu = () => setMenu(null);

  const swatch = (preset: BackgroundPreset, custom: boolean) => (
    <button
      key={preset.id}
      type="button"
      title={preset.label}
      onClick={() => {
        closeMenu();
        select(preset);
      }}
      onContextMenu={
        custom
          ? (e) => {
              e.preventDefault();
              setMenu({ id: preset.id, x: e.clientX, y: e.clientY });
            }
          : undefined
      }
      className={cn(
        "relative aspect-4/3 w-full overflow-hidden rounded-lg border text-left transition-colors",
        selected === preset.src ? selectedRing : idleRing,
      )}
    >
      {/* Inner layer: bg must not share the bordered box — avoids 1px edge blur in WKWebView. */}
      {custom ? (
        <img
          src={preset.src}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <span
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: preset.previewCss }}
          aria-hidden
        />
      )}
    </button>
  );

  return (
    <div className="grid grid-cols-6 gap-1.5">
      {presets.map((p) => swatch(p, false))}
      {customs.filter((p) => !p.isMacWallpaper).map((p) => swatch(p, true))}

      <label
        title={t("look.uploadImage")}
        className={cn(
          "relative flex aspect-4/3 w-full cursor-pointer items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:text-foreground",
          idleRing,
        )}
      >
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          onChange={onPickFile}
          className="sr-only"
        />
        <Plus className="size-5" strokeWidth={2} />
        <span className="sr-only">{t("look.uploadImage")}</span>
      </label>

      {menu ? (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={closeMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMenu();
            }}
          />
          <div
            role="menu"
            className="fixed z-50 min-w-32 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full cursor-default items-center rounded-sm px-2 py-1.5 text-sm text-destructive outline-none hover:bg-accent"
              onClick={() => {
                const id = menu.id;
                closeMenu();
                void deleteCustomBackground(id);
              }}
            >
              {t("look.deleteImage")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function MacWallpaperGrid() {
  const { t } = useI18n();
  const selected = useEditorStore((s) => s.selectedBackground);
  const importWallpaper = useEditorStore((s) => s.importMacWallpaper);
  const [wallpapers, setWallpapers] = useState<Awaited<ReturnType<typeof commands.listMacWallpapers>>>([]);
  const [loading, setLoading] = useState(true);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void commands.listMacWallpapers()
      .then((items) => {
        if (active) setWallpapers(items);
      })
      .catch(() => {
        if (active) setError(t("bg.macWallpaper.loadFailed"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [t]);

  if (loading) return <p className="text-xs text-muted-foreground">{t("app.loading")}</p>;
  if (error && wallpapers.length === 0) return <p role="alert" className="text-xs text-destructive">{error}</p>;
  if (wallpapers.length === 0) return <p className="text-xs text-muted-foreground">{t("bg.macWallpaper.empty")}</p>;

  return (
    <div className="space-y-2">
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="grid grid-cols-6 gap-1.5">
        {wallpapers.map((wallpaper) => {
          const isSelected = selected === customBackgroundUrl(`${wallpaper.id}.jpg`);
          return (
            <button
              key={wallpaper.id}
              type="button"
              title={wallpaper.name}
              aria-label={wallpaper.name}
              aria-pressed={isSelected}
              disabled={importingId !== null}
              onClick={() => {
                setError(null);
                setImportingId(wallpaper.id);
                void importWallpaper(wallpaper.id)
                  .catch(() => setError(t("bg.macWallpaper.importFailed")))
                  .finally(() => setImportingId(null));
              }}
              className={cn(
                "relative aspect-4/3 w-full overflow-hidden rounded-lg border transition-colors disabled:opacity-60",
                isSelected ? selectedRing : idleRing,
              )}
            >
              {wallpaper.thumbnailDataUrl ? (
                <img src={wallpaper.thumbnailDataUrl} alt="" className="h-full w-full object-cover" draggable={false} />
              ) : (
                <span className="flex h-full w-full items-center justify-center bg-muted px-1 text-center text-[10px] text-muted-foreground">
                  {wallpaper.name}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GradientGrid() {
  const { t } = useI18n();
  const presets = useEditorStore((s) => s.gradientPresets);
  const selected = useEditorStore((s) => s.selectedBackground);
  const select = useEditorStore((s) => s.selectBackground);
  const angle = useEditorStore((s) => s.customGradientAngle);
  const start = useEditorStore((s) => s.customGradientStart);
  const end = useEditorStore((s) => s.customGradientEnd);
  const applyCustom = useEditorStore((s) => s.applyCustomGradient);
  const [showCustom, setShowCustom] = useState(false);

  const customCss = gradientToCss({
    id: "c",
    label: "c",
    angle,
    stops: [
      { offset: 0, color: start },
      { offset: 100, color: end },
    ],
  });

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-6 gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            title={preset.label}
            onClick={() => select(preset)}
            className={cn(
              "relative aspect-[4/3] w-full overflow-hidden rounded-lg border",
              selected === preset.src ? selectedRing : idleRing,
            )}
          >
            <span
              className="absolute inset-0"
              style={{ backgroundImage: preset.previewCss }}
            />
          </button>
        ))}
        <button
          type="button"
          title={t("look.custom")}
          onClick={() => {
            setShowCustom((v) => !v);
            applyCustom(angle, start, end);
          }}
          className={cn(
            "relative aspect-[4/3] w-full overflow-hidden rounded-lg border",
            idleRing,
          )}
        >
          <span
            className="absolute inset-0"
            style={{ backgroundImage: customCss }}
          />
          <span className="absolute inset-0 grid place-items-center">
            <span className="rounded bg-black/55 px-1 py-0.5 text-[10px] font-medium leading-none text-white">
              {t("look.custom")}
            </span>
          </span>
        </button>
      </div>

      {showCustom && (
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-card/40 p-3">
          <ColorField
            label={t("look.start")}
            value={start}
            onChange={(c) => applyCustom(angle, c, end)}
          />
          <ColorField
            label={t("look.end")}
            value={end}
            onChange={(c) => applyCustom(angle, start, c)}
          />
          <div className="space-y-1">
            <FieldLabel>{t("look.angle")}</FieldLabel>
            <input
              type="number"
              min={0}
              max={360}
              value={angle}
              onChange={(e) =>
                applyCustom(
                  clampGradientAngle(Number(e.target.value)),
                  start,
                  end,
                )
              }
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ColorGrid() {
  const { t } = useI18n();
  const presets = useEditorStore((s) => s.colorPresets);
  const selected = useEditorStore((s) => s.selectedBackground);
  const select = useEditorStore((s) => s.selectBackground);
  const customColor = useEditorStore((s) => s.customBackgroundColor);
  const setCustomColor = useEditorStore((s) => s.setCustomColor);

  return (
    <div className="grid grid-cols-6 gap-1.5">
      {presets.map((preset) => (
        <button
          key={preset.id}
          type="button"
          title={preset.label}
          onClick={() => select(preset)}
          className={cn(
            "relative aspect-[4/3] w-full overflow-hidden rounded-lg border",
            selected === preset.src ? selectedRing : idleRing,
          )}
        >
          <span
            className="absolute inset-0"
            style={{ backgroundColor: preset.previewCss }}
          />
        </button>
      ))}
      <label
        className={cn(
          "relative aspect-[4/3] w-full cursor-pointer overflow-hidden rounded-lg border",
          idleRing,
        )}
        title={t("look.custom")}
      >
        <input
          type="color"
          value={customColor}
          onChange={(e) => setCustomColor(e.target.value)}
          className="sr-only"
        />
        <span
          className="absolute inset-0"
          style={{ backgroundColor: customColor }}
        />
        <span className="absolute inset-0 grid place-items-center">
          <span className="rounded bg-black/55 px-1 py-0.5 text-[10px] font-medium leading-none text-white">
            {t("look.custom")}
          </span>
        </span>
      </label>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="space-y-1">
      <FieldLabel>{label}</FieldLabel>
      <label className="relative block h-9 cursor-pointer overflow-hidden rounded-md border border-input">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="sr-only"
        />
        <span className="absolute inset-0" style={{ backgroundColor: value }} />
      </label>
    </div>
  );
}

function LookSliders() {
  const { t } = useI18n();
  const look = useEditorStore((s) => s.look);
  const setLook = useEditorStore((s) => s.setLook);
  const stage = useStageDimensions();
  const maxPadding = maxDevicePaddingFor(stage.width, stage.height);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <FieldLabelWithHint
          htmlFor="device-padding"
          hint={t("look.padding.hint")}
        >
          {t("look.padding")}
        </FieldLabelWithHint>
        <Slider
          id="device-padding"
          min={0}
          max={maxPadding}
          step={1}
          value={[Math.min(look.devicePadding, maxPadding)]}
          onValueChange={([v]) => setLook("devicePadding", v ?? 0)}
        />
      </div>
      <div className="space-y-2">
        <FieldLabelWithHint
          htmlFor="corner-radius"
          hint={t("look.radius.hint")}
        >
          {t("look.radius")}
        </FieldLabelWithHint>
        <Slider
          id="corner-radius"
          min={0}
          max={300}
          step={1}
          value={[look.cornerRadius]}
          onValueChange={([v]) => setLook("cornerRadius", v ?? 0)}
        />
      </div>
      <div className="space-y-2">
        <FieldLabelWithHint htmlFor="shadow" hint={t("look.shadow.hint")}>
          {t("look.shadow")}
        </FieldLabelWithHint>
        <Slider
          id="shadow"
          min={0}
          max={200}
          step={1}
          value={[look.recordingShadowIntensity]}
          onValueChange={([v]) => setLook("recordingShadowIntensity", v ?? 0)}
        />
      </div>
    </div>
  );
}

type PerspectivePreset = {
  tiltX: number;
  tiltY: number;
  tiltZ: number;
  perspectiveDistance: number;
};

const PERSPECTIVE_PRESETS: readonly {
  id: string;
  values: PerspectivePreset;
  labelKey?: TranslationKey;
  axis?: "tiltX" | "tiltY";
}[] = [
  {
    id: "flat",
    values: { tiltX: 0, tiltY: 0, tiltZ: 0, perspectiveDistance: 0 },
    labelKey: "look.threeD.flat",
  },
  {
    id: "left",
    values: { tiltX: 0, tiltY: -30, tiltZ: 0, perspectiveDistance: 1100 },
    axis: "tiltY",
  },
  {
    id: "right",
    values: { tiltX: 0, tiltY: 30, tiltZ: 0, perspectiveDistance: 1100 },
    axis: "tiltY",
  },
  {
    id: "isometric",
    values: { tiltX: -22, tiltY: 24, tiltZ: 0, perspectiveDistance: 1800 },
    labelKey: "look.threeD.isometric",
  },
  {
    id: "floating",
    values: { tiltX: 12, tiltY: -18, tiltZ: -4, perspectiveDistance: 1100 },
    labelKey: "look.threeD.floating",
  },
  {
    id: "top",
    values: { tiltX: -30, tiltY: 0, tiltZ: 0, perspectiveDistance: 1100 },
    axis: "tiltX",
  },
] as const;

function ThreeDPerspective({
  fragment,
  updateFragment,
  stageWidth,
}: {
  fragment: PerspectiveFragment;
  updateFragment: (
    updater: (current: PerspectiveFragment) => PerspectiveFragment,
  ) => void;
  stageWidth: number;
}) {
  const { t } = useI18n();
  const previewRef = useRef<HTMLDivElement>(null);
  const previewSvgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<
    | {
        kind: "xy";
        id: number;
        x: number;
        y: number;
        knobX: number;
        knobY: number;
        tiltX: number;
        tiltY: number;
      }
    | {
        kind: "z";
        id: number;
        angle: number;
        pivotX: number;
        pivotY: number;
        tiltZ: number;
      }
    | null
  >(null);
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    setDragPoint(null);
  }, [fragment.id, fragment.pivot]);

  const clampAngle = (value: number, axis: "tiltX" | "tiltY" | "tiltZ") =>
    Math.max(PERSPECTIVE_LIMITS[axis].min, Math.min(PERSPECTIVE_LIMITS[axis].max, value));

  const previewPoint = (clientX: number, clientY: number) => {
    const svg = previewSvgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    const pointer = svg.createSVGPoint();
    pointer.x = clientX;
    pointer.y = clientY;
    return pointer.matrixTransform(matrix.inverse());
  };

  const handlePoint = (handle: PerspectivePivot) => {
    const point = PERSPECTIVE_PIVOT_POINTS.find((candidate) => candidate.id === handle)!;
    return { x: 30 + 140 * point.x, y: 24 + 100 * point.y };
  };

  const initialKnobPoint = (handle: PerspectivePivot) => {
    const base = handlePoint(handle);
    if (handle === "center") return { x: base.x + 27, y: base.y + 27 };
    const point = PERSPECTIVE_PIVOT_POINTS.find((candidate) => candidate.id === handle)!;
    const xDirection = point.x === 0 ? 1 : point.x === 1 ? -1 : 0;
    const yDirection = point.y === 0 ? 1 : point.y === 1 ? -1 : 0;
    return {
      x: base.x + xDirection * (yDirection === 0 ? 30 : 24),
      y: base.y + yDirection * (xDirection === 0 ? 30 : 24),
    };
  };

  const beginXYDrag = (event: ReactPointerEvent<SVGGElement>, knob: { x: number; y: number }) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const pointer = previewPoint(event.clientX, event.clientY);
    if (!pointer) return;
    drag.current = {
      kind: "xy",
      id: event.pointerId,
      x: pointer.x,
      y: pointer.y,
      knobX: knob.x,
      knobY: knob.y,
      tiltX: fragment.tiltX,
      tiltY: fragment.tiltY,
    };
    previewRef.current?.setPointerCapture(event.pointerId);
  };

  const beginZDrag = (event: ReactPointerEvent<SVGGElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const pointer = previewPoint(event.clientX, event.clientY);
    if (!pointer) return;
    const pivot = handlePoint(fragment.pivot ?? "center");
    drag.current = {
      kind: "z",
      id: event.pointerId,
      angle: Math.atan2(pointer.y - pivot.y, pointer.x - pivot.x),
      pivotX: pivot.x,
      pivotY: pivot.y,
      tiltZ: fragment.tiltZ,
    };
    previewRef.current?.setPointerCapture(event.pointerId);
  };

  const onHandlePointerDown = (event: ReactPointerEvent<SVGGElement>, handle: PerspectivePivot) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    drag.current = null;
    setDragPoint(null);
    if (fragment.pivot !== handle) updateFragment((current) => ({ ...current, pivot: handle }));
  };

  const onPreviewPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const point = previewPoint(event.clientX, event.clientY);
    if (!point) return;
    if (start.kind === "z") {
      if (Math.hypot(point.x - start.pivotX, point.y - start.pivotY) < 6) return;
      const angle = Math.atan2(point.y - start.pivotY, point.x - start.pivotX);
      const delta = Math.atan2(Math.sin(angle - start.angle), Math.cos(angle - start.angle));
      const tiltZ = clampAngle(Math.round(start.tiltZ + delta * (180 / Math.PI)), "tiltZ");
      updateFragment((current) => ({ ...current, tiltZ }));
      return;
    }
    setDragPoint({
      x: Math.max(6, Math.min(194, start.knobX + point.x - start.x)),
      y: Math.max(6, Math.min(144, start.knobY + point.y - start.y)),
    });
    const tiltX = clampAngle(Math.round(start.tiltX - (point.y - start.y) * 0.9), "tiltX");
    const tiltY = clampAngle(Math.round(start.tiltY + (point.x - start.x) * 0.65), "tiltY");
    updateFragment((current) => ({ ...current, tiltX, tiltY }));
  };

  const applyPreset = (values: PerspectivePreset) => {
    setDragPoint(null);
    updateFragment((current) => ({
      ...current,
      tiltX: values.tiltX,
      tiltY: values.tiltY,
      tiltZ: values.tiltZ,
      perspectiveDistance: values.perspectiveDistance,
    }));
  };

  const previewCorners = computePerspectiveCorners(140, 100, {
    ...fragment,
    perspectiveDistance: fragment.perspectiveDistance * (140 / Math.max(1, stageWidth)),
  });
  const corners = [
    previewCorners.topLeft,
    previewCorners.topRight,
    previewCorners.bottomRight,
    previewCorners.bottomLeft,
  ].map(({ x, y }) => ({ x: x + 30, y: y + 24 }));
  const point = (a: number, b: number, amount: number) => ({
    x: corners[a].x + (corners[b].x - corners[a].x) * amount,
    y: corners[a].y + (corners[b].y - corners[a].y) * amount,
  });
  const points = corners.map(({ x, y }) => `${x},${y}`).join(" ");
  const selectedHandle = fragment.pivot ?? "center";
  const selectedPoint = handlePoint(selectedHandle);
  const knob = dragPoint ?? initialKnobPoint(selectedHandle);
  const initialKnob = initialKnobPoint(selectedHandle);
  const knobDirection = Math.atan2(initialKnob.y - selectedPoint.y, initialKnob.x - selectedPoint.x);
  const zArcRadius = 17;
  const zArcStart = knobDirection + Math.PI / 4;
  const zArcEnd = zArcStart + Math.PI * 1.5;
  const arcPoint = (angle: number) => ({
    x: selectedPoint.x + zArcRadius * Math.cos(angle),
    y: selectedPoint.y + zArcRadius * Math.sin(angle),
  });
  const zArcFrom = arcPoint(zArcStart);
  const zArcTo = arcPoint(zArcEnd);
  const zArcPath = `M ${zArcFrom.x} ${zArcFrom.y} A ${zArcRadius} ${zArcRadius} 0 1 1 ${zArcTo.x} ${zArcTo.y}`;
  const zIndicator = arcPoint(knobDirection + Math.PI + fragment.tiltZ * (Math.PI / 180));
  const previewGradient = `three-d-reflection-${fragment.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <div className="space-y-4 border-t border-border/60 pt-4">
      <div className="space-y-1">
        <SectionLabel>{t("look.threeD")}</SectionLabel>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("look.threeD.hint")}
        </p>
      </div>

      <ClipTimingDisplay start={fragment.start} end={fragment.end} />

      <div className="grid grid-cols-6 gap-1.5">
        {PERSPECTIVE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            title={preset.labelKey
              ? t(preset.labelKey)
              : `${t(preset.axis === "tiltX" ? "look.threeD.tiltX" : "look.threeD.tiltY")} ${preset.axis === "tiltX" ? preset.values.tiltX : preset.values.tiltY}°`}
            aria-label={preset.labelKey
              ? t(preset.labelKey)
              : `${t(preset.axis === "tiltX" ? "look.threeD.tiltX" : "look.threeD.tiltY")} ${preset.axis === "tiltX" ? preset.values.tiltX : preset.values.tiltY}°`}
            aria-pressed={
              fragment.tiltX === preset.values.tiltX &&
              fragment.tiltY === preset.values.tiltY &&
              fragment.tiltZ === preset.values.tiltZ &&
              fragment.perspectiveDistance === preset.values.perspectiveDistance
            }
            onClick={() => applyPreset(preset.values)}
            className={cn(
              "flex h-10 items-center justify-center rounded-md border transition-colors",
              fragment.tiltX === preset.values.tiltX &&
                fragment.tiltY === preset.values.tiltY &&
                fragment.tiltZ === preset.values.tiltZ &&
                fragment.perspectiveDistance === preset.values.perspectiveDistance
                ? selectedRing
                : idleRing,
            )}
          >
            <PresetGlyph values={preset.values} />
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] gap-3">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {(["tiltX", "tiltY", "tiltZ"] as const).map((axis) => (
              <PerspectiveNumberField
                key={axis}
                axis={axis}
                label={t(`look.threeD.${axis}`)}
                value={fragment[axis]}
                onChange={(number) =>
                  updateFragment((current) => ({ ...current, [axis]: clampAngle(number, axis) }))
                }
              />
            ))}
          </div>
          <FieldLabel htmlFor="three-d-reflection">{t("look.threeD.reflection")}</FieldLabel>
          <Slider
            id="three-d-reflection"
            min={0}
            max={100}
            step={1}
            value={[fragment.reflectionStrength]}
            onValueChange={([value]) =>
              updateFragment((current) => ({ ...current, reflectionStrength: value ?? 0 }))
            }
          />
          <div className="flex gap-1">
            {(["soft", "sharp", "dots"] as const).map((style) => (
              <button
                key={style}
                type="button"
                title={t(`look.threeD.${style}`)}
                aria-label={t(`look.threeD.${style}`)}
                aria-pressed={fragment.reflectionStyle === style}
                onClick={() => updateFragment((current) => ({ ...current, reflectionStyle: style }))}
                className={cn(
                  "flex h-8 flex-1 items-center justify-center rounded-md border text-xs",
                  fragment.reflectionStyle === style ? selectedRing : idleRing,
                )}
              >
                {style === "soft" ? "◐" : style === "sharp" ? "◩" : "⠿"}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <div
            ref={previewRef}
            role="group"
            aria-label={t("look.threeD.drag")}
            title={t("look.threeD.drag")}
            onPointerMove={onPreviewPointerMove}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
            onLostPointerCapture={() => { drag.current = null; }}
            className="relative min-h-35 overflow-hidden rounded-lg border border-border bg-muted/50 touch-none"
          >
            <svg ref={previewSvgRef} viewBox="0 0 200 150" className="h-full w-full">
              <defs>
                <pattern id={previewGradient} width="9" height="9" patternUnits="userSpaceOnUse">
                  <circle cx="2" cy="2" r="0.7" fill="currentColor" opacity="0.25" />
                </pattern>
                <linearGradient id={`${previewGradient}-shine`} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="white" stopOpacity={fragment.reflectionStrength / 100 * 0.75} />
                  <stop offset={fragment.reflectionStyle === "sharp" ? "28%" : "75%"} stopColor="white" stopOpacity="0" />
                  {fragment.reflectionStyle === "sharp" && (
                    <stop offset="65%" stopColor="white" stopOpacity={fragment.reflectionStrength / 100 * 0.5} />
                  )}
                  <stop offset="100%" stopColor="white" stopOpacity="0" />
                </linearGradient>
              </defs>
              <rect width="200" height="150" rx="12" fill="currentColor" opacity="0.08" />
              <polygon points={points} fill="currentColor" opacity="0.12" />
              <polygon points={points} fill={`url(#${previewGradient})`} stroke="currentColor" strokeWidth="1.5" />
              <polygon points={points} fill={`url(#${previewGradient}-shine)`} />
              {[0.27, 0.42, 0.57].map((ratio) => {
                const left = point(0, 3, ratio);
                const right = point(1, 2, ratio);
                return <line key={ratio} x1={left.x + 14} y1={left.y} x2={right.x - 14} y2={right.y} stroke="currentColor" strokeWidth="3" opacity="0.35" />;
              })}
              <g
                role="button"
                tabIndex={0}
                aria-label={t("look.threeD.tiltZ")}
                className="cursor-grab text-blue-500"
                onPointerDown={beginZDrag}
                onKeyDown={(event) => {
                  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const step = event.shiftKey ? 5 : 1;
                  const direction = event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1;
                  updateFragment((current) => ({ ...current, tiltZ: clampAngle(current.tiltZ + direction * step, "tiltZ") }));
                }}
              >
                <path d={zArcPath} fill="none" stroke="currentColor" strokeWidth="12" opacity="0" />
                <path d={zArcPath} fill="none" stroke="currentColor" strokeWidth="2.5" pointerEvents="none" />
                <circle cx={zIndicator.x} cy={zIndicator.y} r="4" fill="currentColor" pointerEvents="none" />
              </g>
              <line x1={selectedPoint.x} y1={selectedPoint.y} x2={knob.x} y2={knob.y} stroke="currentColor" strokeWidth="1.5" opacity="0.5" pointerEvents="none" />
              <g
                className="cursor-grab"
                role="button"
                tabIndex={0}
                aria-label={`${t("look.threeD.tiltX")} / ${t("look.threeD.tiltY")}`}
                onPointerDown={(event) => beginXYDrag(event, knob)}
                onKeyDown={(event) => {
                  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const step = event.shiftKey ? 5 : 1;
                  updateFragment((current) => ({
                    ...current,
                    tiltX: clampAngle(current.tiltX + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0), "tiltX"),
                    tiltY: clampAngle(current.tiltY + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), "tiltY"),
                  }));
                }}
              >
                <circle cx={knob.x} cy={knob.y} r="11" fill="transparent" />
                <circle cx={knob.x} cy={knob.y} r="7" fill="white" stroke="currentColor" strokeWidth="1.5" pointerEvents="none" />
              </g>
              {PERSPECTIVE_PIVOT_POINTS.map(({ id }) => {
                const { x, y } = handlePoint(id);
                return (
                  <g
                    key={id}
                    className={cn("cursor-pointer", selectedHandle === id && "text-primary")}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedHandle === id}
                    aria-label={`${t("look.threeD")} ${id}`}
                    onPointerDown={(event) => onHandlePointerDown(event, id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      setDragPoint(null);
                      updateFragment((current) => ({ ...current, pivot: id }));
                    }}
                  >
                    <circle cx={x} cy={y} r="11" fill="transparent" />
                    {selectedHandle === id && <circle cx={x} cy={y} r="9" fill="none" stroke="currentColor" strokeWidth="1.5" pointerEvents="none" />}
                    <circle
                      cx={x}
                      cy={y}
                      r={selectedHandle === id ? "6" : "4"}
                      fill="white"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      pointerEvents="none"
                    />
                  </g>
                );
              })}
            </svg>
          </div>
          <div aria-hidden="true" className="flex justify-between px-1 text-[10px] font-medium text-muted-foreground">
            <span>X/Y ○</span>
            <span className="text-blue-500">Z ◌</span>
          </div>
        </div>
      </div>
      <PerspectiveSlider
        id="three-d-distance"
        label={t("look.threeD.distance")}
        value={fragment.perspectiveDistance}
        min={PERSPECTIVE_LIMITS.perspectiveDistance.min}
        max={PERSPECTIVE_LIMITS.perspectiveDistance.max}
        step={50}
        setValue={(value) =>
          updateFragment((current) => ({ ...current, perspectiveDistance: value }))
        }
      />
    </div>
  );
}

function PerspectiveNumberField({
  axis,
  label,
  value,
  onChange,
}: {
  axis: "tiltX" | "tiltY" | "tiltZ";
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(value)));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(Math.round(value)));
  }, [editing, value]);

  return (
    <label className="flex items-center gap-1 rounded-md border border-input px-2 py-1.5 text-xs">
      <span className="text-muted-foreground" title={label}>{axis.slice(-1).toUpperCase()}</span>
      <input
        aria-label={label}
        type="text"
        inputMode="numeric"
        value={draft}
        onFocus={() => setEditing(true)}
        onChange={(event) => {
          const next = event.target.value;
          if (!/^-?\d*$/.test(next)) return;
          setDraft(next);
          if (next !== "" && next !== "-") onChange(Number(next));
        }}
        onBlur={() => {
          if (draft !== "" && draft !== "-") onChange(Number(draft));
          setDraft(String(Math.round(value)));
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="min-w-0 w-full bg-transparent text-right tabular-nums outline-none"
      />
      <span aria-hidden="true">°</span>
    </label>
  );
}

function PresetGlyph({ values }: { values: PerspectivePreset }) {
  const corners = computePerspectiveCorners(24, 18, { ...values, perspectiveDistance: 35, reflectionStrength: 0, reflectionStyle: "soft" });
  const points = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft]
    .map(({ x, y }) => `${x},${y}`).join(" ");
  return (
    <svg viewBox="-5 -5 34 28" className="size-6" aria-hidden="true">
      <polygon points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function PerspectiveSlider({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  setValue,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  setValue: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <span className="text-xs tabular-nums text-muted-foreground">
          {Math.round(value)}{id === "three-d-distance" ? "" : "°"}
        </span>
      </div>
      <Slider
        id={id}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => setValue(next ?? 0)}
      />
    </div>
  );
}

function BackgroundEffects() {
  const { t } = useI18n();
  const look = useEditorStore((s) => s.look);
  const setLook = useEditorStore((s) => s.setLook);

  return (
    <div className="space-y-4 border-t border-border/60 pt-4">
      <SectionLabel>{t("look.effects")}</SectionLabel>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <FieldLabelWithHint htmlFor="bg-blur" hint={t("look.blur.hint")}>
            {t("look.blur")}
          </FieldLabelWithHint>
          <Slider
            id="bg-blur"
            min={0}
            max={60}
            step={1}
            value={[look.backgroundBlur]}
            onValueChange={([v]) => setLook("backgroundBlur", v ?? 0)}
          />
        </div>
        <div className="space-y-2">
          <FieldLabelWithHint htmlFor="bg-dark" hint={t("look.darkness.hint")}>
            {t("look.darkness")}
          </FieldLabelWithHint>
          <Slider
            id="bg-dark"
            min={0}
            max={100}
            step={1}
            value={[look.backgroundDarkness]}
            onValueChange={([v]) => setLook("backgroundDarkness", v ?? 0)}
          />
        </div>
      </div>
    </div>
  );
}
