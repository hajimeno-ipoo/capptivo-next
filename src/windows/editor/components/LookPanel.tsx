/**
 * The "Look" inspector panel — background selection + composition sliders.
 * Mirrors the web editor's `EditorLookPanel` design (tabs, preset grids, effect
 * sliders) using the ported design tokens.
 */

import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Plus } from "lucide-react";
import { getCompositionLayout, type PerspectiveFragment } from "@/engine";

import { FieldLabelWithHint } from "@/components/ui/field-label-with-hint";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/settings";
import type { TranslationKey } from "@/lib/i18n";

import { useEditorStore } from "../store";
import { cn } from "../lib/cn";
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
import { FieldLabel, SectionLabel } from "./ui";
import { ScreenContentCropPanel } from "./ScreenContentCropPanel";
import { BlurRegionsPanel } from "./BlurRegionsPanel";
import { TextClipsPanel } from "./TextClipsPanel";
import type { InspectorCompositionLayout } from "./InspectorCompositionFrame";

const selectedRing = "border-primary ring-2 ring-primary/40";
const idleRing = "border-border hover:border-foreground/30";

const BG_TAB_LABEL_KEY: Record<BackgroundType, TranslationKey> = {
  image: "bg.image",
  gradient: "bg.gradient",
  color: "bg.color",
};

export function LookPanel({ visible = true }: { visible?: boolean }) {
  const { t } = useI18n();
  const blurRegions = useEditorStore((s) => s.blurRegions);
  const addBlurRegion = useEditorStore((s) => s.addBlurRegion);
  const updateBlurRegion = useEditorStore((s) => s.updateBlurRegion);
  const removeBlurRegion = useEditorStore((s) => s.removeBlurRegion);
  const selectBlurRegion = useEditorStore((s) => s.selectBlurRegion);
  const selectedBlurRegionId = useEditorStore((s) => s.selectedBlurRegionId);
  const duration = useEditorStore((s) => s.duration);
  const backgroundType = useEditorStore((s) => s.backgroundType);
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

  return (
    <div className={cn("flex flex-col gap-7", !visible && "hidden")}>
      <div className="space-y-2">
        <SectionLabel>{t("look.background")}</SectionLabel>

        <div className="inline-flex items-center rounded-xl bg-muted p-1">
          {BACKGROUND_TYPE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setBackgroundType(tab.id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                backgroundType === tab.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(BG_TAB_LABEL_KEY[tab.id])}
            </button>
          ))}
        </div>

        {backgroundType === "image" && <ImageGrid />}
        {backgroundType === "gradient" && <GradientGrid />}
        {backgroundType === "color" && <ColorGrid />}
      </div>

      {selectedBackground && previewUrl && (
        <ScreenContentCropPanel
          key="screen-content-crop"
          videoUrl={previewUrl}
          fileAspect={sourceAspect}
          hasBackground
          value={screenContentCrop}
          onChange={setScreenContentCrop}
          seekTo={cropPreviewTime}
        />
      )}

      {previewUrl && (
        <BlurRegionsPanel
          key="blur-regions"
          videoUrl={previewUrl}
          fileAspect={sourceAspect}
          duration={duration}
          regions={blurRegions}
          selectedId={selectedBlurRegionId}
          onSelect={selectBlurRegion}
          onAdd={addBlurRegion}
          onChange={updateBlurRegion}
          onRemove={removeBlurRegion}
          seekTo={cropPreviewTime}
          composition={composition}
          sourceVideoSize={sourceVideoSize}
        />
      )}

      <SpeedControls />
      <TextClipsPanel composition={composition} />

      {selectedBackground && <LookSliders />}
      {selectedPerspectiveFragment && (
        <ThreeDPerspective
          fragment={selectedPerspectiveFragment}
          updateFragment={updateSelectedPerspectiveFragment}
          stageWidth={stageDimensions.width}
        />
      )}
      {selectedBackground && <BackgroundEffects />}
    </div>
  );
}

function SpeedControls() {
  const { t } = useI18n();
  const speed = useEditorStore((s) => s.globalSpeed);
  const ranges = useEditorStore((s) => s.speedRanges);
  const selectedId = useEditorStore((s) => s.selectedSpeedRangeId);
  const selected = ranges.find((range) => range.id === selectedId) ?? null;
  const setGlobalSpeed = useEditorStore((s) => s.setGlobalSpeed);
  const addSpeedRange = useEditorStore((s) => s.addSpeedRange);
  const updateSpeedRange = useEditorStore((s) => s.updateSpeedRange);
  const autoSpeedTyping = useEditorStore((s) => s.autoSpeedTyping);

  return (
    <section className="space-y-3">
      <SectionLabel>{t("export.gifSpeed")}</SectionLabel>
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t("speed.wholeVideo")}</span>
          <span className="tabular-nums">{speed.toFixed(2)}×</span>
        </div>
        <Slider
          min={0.25}
          max={4}
          step={0.05}
          value={[speed]}
          onValueChange={([value]) => setGlobalSpeed(value ?? speed)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => addSpeedRange()}>
          {t("speed.addRange")}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={autoSpeedTyping}>
          {t("speed.autoTyping")}
        </Button>
      </div>
      {selected ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t(selected.autoTyping ? "speed.typing" : "speed.selectedRange")}</span>
            <span className="tabular-nums">{selected.start.toFixed(2)}s – {selected.end.toFixed(2)}s</span>
          </div>
          <Slider
            min={0.25}
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
      {customs.map((p) => swatch(p, true))}

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
  const drag = useRef<{ id: number; x: number; y: number; tiltX: number; tiltY: number } | null>(null);

  const clampAngle = (value: number, axis: "tiltX" | "tiltY" | "tiltZ") =>
    Math.max(PERSPECTIVE_LIMITS[axis].min, Math.min(PERSPECTIVE_LIMITS[axis].max, value));

  const onPreviewPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      tiltX: fragment.tiltX,
      tiltY: fragment.tiltY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPreviewPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const tiltX = clampAngle(Math.round(start.tiltX - (event.clientY - start.y) * 0.4), "tiltX");
    const tiltY = clampAngle(Math.round(start.tiltY + (event.clientX - start.x) * 0.4), "tiltY");
    updateFragment((current) => ({ ...current, tiltX, tiltY }));
  };

  const applyPreset = (values: PerspectivePreset) => {
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
  const previewGradient = `three-d-reflection-${fragment.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <div className="space-y-4 border-t border-border/60 pt-4">
      <div className="space-y-1">
        <SectionLabel>{t("look.threeD")}</SectionLabel>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("look.threeD.hint")}
        </p>
      </div>

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
        <button
          type="button"
          aria-label={t("look.threeD.drag")}
          title={t("look.threeD.drag")}
          onPointerDown={onPreviewPointerDown}
          onPointerMove={onPreviewPointerMove}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          onKeyDown={(event) => {
            if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            const step = event.shiftKey ? 5 : 1;
            updateFragment((current) => ({
              ...current,
              tiltX: clampAngle(current.tiltX + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0), "tiltX"),
              tiltY: clampAngle(current.tiltY + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), "tiltY"),
            }));
          }}
          className="relative min-h-35 overflow-hidden rounded-lg border border-border bg-muted/50 cursor-grab touch-none active:cursor-grabbing"
        >
          <svg viewBox="0 0 200 150" className="h-full w-full" aria-hidden="true">
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
            {corners.map(({ x, y }, index) => (
              <circle key={index} cx={x} cy={y} r="3.5" fill="white" stroke="currentColor" strokeWidth="1.2" />
            ))}
            <circle cx="100" cy="74" r="7" fill="white" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
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
