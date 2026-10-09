import { useSyncExternalStore } from "react";
import { commands, type AppFont, type SystemFont } from "@/ipc/bindings";

type FontCatalog = {
  systemFonts: SystemFont[];
  appFonts: AppFont[];
  ready: boolean;
  error: string | null;
};

let catalog: FontCatalog = { systemFonts: [], appFonts: [], ready: false, error: null };
const subscribers = new Set<() => void>();
const loadedFaces = new Map<string, Promise<FontFace>>();
let pending: Promise<void> | null = null;
let refreshRequested = false;

function publish(next: FontCatalog) {
  catalog = next;
  subscribers.forEach((notify) => notify());
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

async function loadFont(font: AppFont): Promise<void> {
  let pendingFace = loadedFaces.get(font.family);
  if (!pendingFace) {
    pendingFace = (async () => {
      const data = await commands.readAppFont(font.filename);
      const face = await new FontFace(font.family, data).load();
      document.fonts.add(face);
      return face;
    })();
    loadedFaces.set(font.family, pendingFace);
    void pendingFace.catch(() => loadedFaces.delete(font.family));
  }
  await pendingFace;
}

/** FontFace registration is local to each editor WebView. Await it before drawing. */
export function refreshFontCatalog(): Promise<void> {
  if (pending) {
    refreshRequested = true;
    return pending;
  }
  pending = (async () => {
    try {
      do {
        refreshRequested = false;
        try {
          const [systemFonts, appFonts] = await Promise.all([
            commands.listSystemFonts(), commands.listAppFonts(),
          ]);
          await Promise.all(appFonts.map(loadFont));
          // A change notification invalidates the snapshot being loaded. Reread
          // before publishing it or reconciling the current edit's references.
          if (refreshRequested) continue;
          const available = new Set(appFonts.map((font) => font.family));
          for (const [family, face] of loadedFaces) {
            if (!available.has(family)) {
              document.fonts.delete(await face);
              loadedFaces.delete(family);
            }
          }
          if (!refreshRequested) {
            publish({ systemFonts, appFonts, ready: true, error: null });
          }
        } catch (error) {
          // The file may have been deleted during this read. A queued change
          // request must resolve from the new list rather than the stale read.
          if (refreshRequested) continue;
          publish({ ...catalog, ready: true, error: describe(error) });
          throw error;
        }
      } while (refreshRequested);
    } finally {
      pending = null;
    }
  })();
  return pending;
}

export async function ensureFontsLoaded(): Promise<void> {
  if (pending) await pending;
  if (!catalog.ready || catalog.error) await refreshFontCatalog();
}

export async function importAppFont(): Promise<AppFont | null> {
  const font = await commands.importAppFont();
  if (!font) return null;
  await loadFont(font);
  // The native change event may already be refreshing the catalog. Finish that
  // request first, then reread so the imported file is certainly in the list.
  if (pending) await pending;
  await refreshFontCatalog();
  return font;
}

export async function deleteAppFont(font: AppFont): Promise<void> {
  await commands.deleteAppFont(font.filename);
  if (pending) await pending;
  await refreshFontCatalog();
}

export function useFontCatalog(): FontCatalog {
  return useSyncExternalStore(
    (notify) => { subscribers.add(notify); return () => { subscribers.delete(notify); }; },
    () => catalog,
  );
}
