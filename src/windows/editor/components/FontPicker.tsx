import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/settings";
import {
  importAppFont,
  deleteAppFont,
  refreshFontCatalog,
  useFontCatalog,
} from "../lib/fontCatalog";

const DEFAULT_FONT_FAMILY = "system-ui, -apple-system, sans-serif";
const JAPANESE_NAME = /[\u3040-\u30ff\u3400-\u9fff]/u;

export function FontPicker({ value, onChange, id }: {
  value: string;
  onChange: (family: string) => void;
  id: string;
}) {
  const { t, language } = useI18n();
  const { systemFonts, appFonts, ready, error } = useFontCatalog();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const systemOptions = useMemo(() => {
    return systemFonts
      .filter((font) => font.family !== DEFAULT_FONT_FAMILY)
      .map((font) => ({
        ...font,
        label: language === "ja" ? font.displayName : font.family,
      }))
      .sort((a, b) => {
        if (language === "ja") {
          const japaneseFirst = Number(JAPANESE_NAME.test(b.label)) - Number(JAPANESE_NAME.test(a.label));
          if (japaneseFirst !== 0) return japaneseFirst;
        }
        return a.label.localeCompare(b.label, language);
      });
  }, [systemFonts, language]);
  const appOptions = useMemo(
    () => [...appFonts].sort((a, b) => a.displayName.localeCompare(b.displayName, language)),
    [appFonts, language],
  );
  const currentIsListed = value === DEFAULT_FONT_FAMILY ||
    systemOptions.some((font) => font.family === value) ||
    appOptions.some((font) => font.family === value);
  const displayedError = actionError ?? error;
  const selectedAppFont = appFonts.find((font) => font.family === value);
  const disabled = !ready || busy;

  async function runAction(action: "register" | "refresh" | "delete") {
    setBusy(true);
    setActionError(null);
    try {
      if (action === "register") {
        const font = await importAppFont();
        if (font) onChange(font.family);
      } else if (action === "delete" && selectedAppFont) {
        await deleteAppFont(selectedAppFont);
        onChange(DEFAULT_FONT_FAMILY);
      } else {
        await refreshFontCatalog();
      }
    } catch (cause) {
      setActionError(
        cause && typeof cause === "object" && "message" in cause
          ? String(cause.message)
          : String(cause),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" aria-busy={disabled}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
      >
        <option value={DEFAULT_FONT_FAMILY}>{t("fonts.default")}</option>
        {!currentIsListed && (
          <option value={value}>{value}</option>
        )}
        <optgroup label={t("fonts.system")}>
          {systemOptions.map((font) => (
            <option key={font.family} value={font.family}>
              {font.label}
            </option>
          ))}
        </optgroup>
        <optgroup label={t("fonts.app")}>
          {appOptions.map((font) => (
            <option key={font.family} value={font.family}>
              {font.displayName}
            </option>
          ))}
        </optgroup>
      </select>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={disabled}
          onClick={() => void runAction("register")}>
          {t("fonts.register")}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled}
          onClick={() => void runAction("refresh")}>
          {t("fonts.refresh")}
        </Button>
        {selectedAppFont && (
          <Button type="button" size="sm" variant="outline" disabled={disabled}
            className="text-destructive" onClick={() => void runAction("delete")}>
            {t("fonts.delete")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("fonts.appOnly")}</p>
      {selectedAppFont && <p className="text-xs text-muted-foreground">{t("fonts.deleteHint")}</p>}
      {displayedError && (
        <p className="text-xs text-destructive" role="alert">
          {t("fonts.error")} {displayedError}
        </p>
      )}
    </div>
  );
}
