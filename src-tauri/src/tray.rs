//! The macOS menubar tray (`NSStatusItem`). Left-click toggles the recorder
//! popover; right-click shows a native menu that swaps with recorder state
//! (idle setup items ↔ live pause / stop / annotate).
//!
//! macOS uses a dedicated monochrome Capptivo glyph as a template image (tints
//! with the menubar). Windows keeps the full-color app icon.

use crate::recorder::types::RecorderState;
use crate::state::AppState;
use crate::windows;
use parking_lot::Mutex;
use serde::Deserialize;
#[cfg(target_os = "macos")]
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub const TRAY_ID: &str = "capptivo-tray";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    open_recorder: String,
    annotate_screen: String,
    open_library: String,
    settings: String,
    check_updates: String,
    quit: String,
    pause: String,
    resume: String,
    stop: String,
    open_annotation: String,
    finalizing: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open_recorder: "Open Recorder".into(),
            annotate_screen: "Annotate Screen…".into(),
            open_library: "Open Library…".into(),
            settings: "Settings…".into(),
            check_updates: "Check for Updates…".into(),
            quit: "Quit Capptivo_Next".into(),
            pause: "Pause".into(),
            resume: "Resume".into(),
            stop: "Stop".into(),
            open_annotation: "Show annotations".into(),
            finalizing: "Finalizing…".into(),
        }
    }
}

struct TrayMenuState(Mutex<TrayLabels>);

fn labels(app: &AppHandle) -> TrayLabels {
    app.state::<TrayMenuState>().0.lock().clone()
}

/// The recorder sends translations from the same language catalog as its UI.
#[tauri::command]
pub fn set_tray_labels(app: AppHandle, labels: TrayLabels) {
    *app.state::<TrayMenuState>().0.lock() = labels;
    let state = app.state::<AppState>().recorder.state();
    sync_for_state(&app, &state);
}

/// Flat mark for NSStatusItem — black + alpha only (`icon_as_template`).
#[cfg(target_os = "macos")]
const TRAY_TEMPLATE_PNG: &[u8] = include_bytes!("../icons/tray-template@2x.png");

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    app.manage(TrayMenuState(Mutex::new(TrayLabels::default())));
    let menu = idle_menu(app)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // Left-click drives the popover ourselves; the menu is right-click only.
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event);

    builder = apply_tray_icon(app, builder)?;
    builder.build(app)?;
    Ok(())
}

/// Rebuild the tray menu when the recorder state machine changes.
/// Cheap: only runs on start / pause / resume / stop (not on elapsed ticks).
pub fn sync_for_state(app: &AppHandle, state: &RecorderState) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let menu = match menu_for_state(app, state) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(%e, "failed to build tray menu");
            return;
        }
    };
    if let Err(e) = tray.set_menu(Some(menu)) {
        tracing::warn!(%e, "failed to update tray menu");
    }
}

fn menu_for_state(app: &AppHandle, state: &RecorderState) -> tauri::Result<Menu<tauri::Wry>> {
    match tray_kind(state) {
        TrayKind::Idle => idle_menu(app),
        TrayKind::Live { paused } => live_menu(app, paused),
        TrayKind::Finalizing => finalizing_menu(app),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayKind {
    Idle,
    Live { paused: bool },
    Finalizing,
}

fn tray_kind(state: &RecorderState) -> TrayKind {
    match state {
        RecorderState::Recording | RecorderState::Countdown { .. } => TrayKind::Live { paused: false },
        RecorderState::Paused => TrayKind::Live { paused: true },
        RecorderState::Finalizing => TrayKind::Finalizing,
        RecorderState::Idle | RecorderState::Error { .. } => TrayKind::Idle,
    }
}

fn idle_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let text = labels(app);
    // "Open Recorder" first: on most Linux DEs (appindicator) tray left-click
    // never fires, so the popover must be reachable from the menu. It's also a
    // discoverable fallback on Windows for users who expect click = menu.
    let open_recorder =
        MenuItem::with_id(app, "open_recorder", &text.open_recorder, true, None::<&str>)?;
    let annotate =
        MenuItem::with_id(app, "annotate", &text.annotate_screen, true, None::<&str>)?;
    let open_library = MenuItem::with_id(app, "open_library", &text.open_library, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", &text.settings, true, None::<&str>)?;
    // ponytail: "Open Logs…" disabled with file logging for release — uncomment with init_tracing.
    // let open_logs =
    //     MenuItem::with_id(app, "open_logs", "Open Logs…", true, None::<&str>)?;
    let check_updates =
        MenuItem::with_id(app, "check_updates", &text.check_updates, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", &text.quit, true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &open_recorder,
            &annotate,
            &open_library,
            &settings,
            &separator,
            // &open_logs,
            &check_updates,
            &separator,
            &quit,
        ],
    )
}

/// In-session menu: pause/resume + stop first, then annotate / HUD / library.
fn live_menu(app: &AppHandle, paused: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let text = labels(app);
    let pause_or_resume = if paused {
        MenuItem::with_id(app, "resume", &text.resume, true, None::<&str>)?
    } else {
        MenuItem::with_id(app, "pause", &text.pause, true, None::<&str>)?
    };
    let stop = MenuItem::with_id(app, "stop", &text.stop, true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let annotate =
        MenuItem::with_id(app, "annotate", &text.open_annotation, true, None::<&str>)?;
    let open_recorder =
        MenuItem::with_id(app, "open_recorder", &text.open_recorder, true, None::<&str>)?;
    let open_library = MenuItem::with_id(app, "open_library", &text.open_library, true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    // Quit while recording would leave a half-written project on disk — stop first.
    Menu::with_items(
        app,
        &[
            &pause_or_resume,
            &stop,
            &sep1,
            &annotate,
            &open_recorder,
            &open_library,
            &sep2,
        ],
    )
}

fn finalizing_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let text = labels(app);
    let status = MenuItem::with_id(app, "finalizing", &text.finalizing, false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let open_library = MenuItem::with_id(app, "open_library", &text.open_library, true, None::<&str>)?;
    // No Quit while a take is being finalized — same data-loss risk as mid-record quit.
    Menu::with_items(app, &[&status, &separator, &open_library])
}

#[cfg(target_os = "macos")]
fn apply_tray_icon(
    _app: &AppHandle,
    builder: TrayIconBuilder<tauri::Wry>,
) -> tauri::Result<TrayIconBuilder<tauri::Wry>> {
    let icon = Image::from_bytes(TRAY_TEMPLATE_PNG)?;
    Ok(builder.icon(icon).icon_as_template(true))
}

#[cfg(not(target_os = "macos"))]
fn apply_tray_icon(
    app: &AppHandle,
    mut builder: TrayIconBuilder<tauri::Wry>,
) -> tauri::Result<TrayIconBuilder<tauri::Wry>> {
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    Ok(builder)
}

fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        "quit" => {
            if recording_active(app) {
                tracing::warn!("tray quit ignored while a recording is active");
                return;
            }
            app.exit(0);
        }
        "open_recorder" => {
            if let Err(e) = windows::show_recorder_popover(app) {
                tracing::warn!(%e, "failed to open recorder popover from menu");
            }
        }
        "annotate" => {
            if let Err(e) = windows::toggle_annotation_overlay(app) {
                tracing::warn!(%e, "failed to toggle annotation overlay from menu");
            }
        }
        "open_library" => {
            if let Err(e) = windows::open_library(app.clone()) {
                tracing::warn!(%e, "failed to open recordings library");
            }
        }
        // ponytail: disabled with file logging for release.
        // "open_logs" => {
        //     if let Err(e) = crate::error_log::reveal_dir() {
        //         tracing::error!(%e, "failed to reveal logs folder");
        //     }
        // }
        "settings" => {
            if let Err(e) = windows::show_recorder_settings(app) {
                tracing::warn!(%e, "failed to open recorder settings from menu");
            }
        }
        "check_updates" => {
            crate::updater::spawn_check(app.clone(), crate::updater::Prompt::Interactive);
        }
        "pause" => {
            if let Some(state) = app.try_state::<AppState>() {
                if let Err(e) = state.recorder.pause() {
                    tracing::warn!(%e, "tray pause failed");
                }
            }
        }
        "resume" => {
            if let Some(state) = app.try_state::<AppState>() {
                if let Err(e) = state.recorder.resume() {
                    tracing::warn!(%e, "tray resume failed");
                }
            }
        }
        "stop" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let Some(state) = app.try_state::<AppState>() else {
                    return;
                };
                if let Err(e) =
                    crate::commands::recording::stop_recording(app.clone(), state).await
                {
                    tracing::warn!(%e, "tray stop failed");
                }
            });
        }
        other => tracing::debug!(id = other, "unhandled tray menu item"),
    }
}

fn recording_active(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .map(|s| s.current_project.lock().is_some())
        .unwrap_or(false)
}

fn on_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        if let Err(e) = windows::toggle_recorder_popover(tray.app_handle()) {
            tracing::warn!(%e, "failed to toggle recorder popover");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_kind_follows_recorder_state() {
        assert_eq!(tray_kind(&RecorderState::Idle), TrayKind::Idle);
        assert_eq!(
            tray_kind(&RecorderState::Recording),
            TrayKind::Live { paused: false }
        );
        assert_eq!(
            tray_kind(&RecorderState::Paused),
            TrayKind::Live { paused: true }
        );
        assert_eq!(tray_kind(&RecorderState::Finalizing), TrayKind::Finalizing);
        assert_eq!(
            tray_kind(&RecorderState::Error {
                message: "x".into(),
                fatal: false
            }),
            TrayKind::Idle
        );
    }
}
