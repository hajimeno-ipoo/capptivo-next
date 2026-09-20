//! Single-frame capture and still-image project commands.

use crate::error::{AppError, AppResult};
use crate::project::{ScreenshotProject, ScreenshotSummary};
use crate::recorder::types::CaptureCrop;
use crate::state::AppState;
use serde_json::Value;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};

struct BusyGuard<'a>(&'a std::sync::atomic::AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) { self.0.store(false, Ordering::Release); }
}

fn finish_with_restored_capture_ui<T>(
    result: AppResult<T>,
    restore_errors: Vec<String>,
) -> AppResult<T> {
    if restore_errors.is_empty() {
        return result;
    }
    let restore = restore_errors.join("; ");
    match result {
        Ok(_) => Err(AppError::Other(format!(
            "screenshot was captured, but capture controls could not be restored: {restore}"
        ))),
        Err(error) => Err(AppError::Other(format!(
            "{error}; capture controls could not be restored: {restore}"
        ))),
    }
}

#[tauri::command(async)]
pub fn capture_screenshot(
    app: AppHandle,
    state: State<AppState>,
    source_id: String,
    crop: Option<CaptureCrop>,
    show_cursor: bool,
) -> AppResult<String> {
    if state.screenshot_busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return Err(AppError::Busy("screenshot".into()));
    }
    let _busy = BusyGuard(&state.screenshot_busy);
    if state.current_project.lock().is_some() || state.recorder.state().is_active() {
        return Err(AppError::Busy("recording".into()));
    }
    if !state.recorder.has_permission() { return Err(AppError::PermissionDenied); }

    #[cfg(all(target_os = "macos", feature = "scap-capture"))]
    {
        if !(source_id.starts_with("display:") || source_id.starts_with("window:")) {
            return Err(AppError::InvalidSource(source_id));
        }
        // Hide only chrome. The camera bubble and full-screen ink remain visible
        // for display/area shots, while the window filter captures only its window.
        let recorder = app.get_webview_window(crate::windows::RECORDER_LABEL);
        let was_visible = recorder.as_ref().and_then(|w| w.is_visible().ok()).unwrap_or(false);
        if was_visible { recorder.as_ref().unwrap().hide().map_err(|e| AppError::Other(e.to_string()))?; }
        crate::area_picker::hide_area_frame_guide(&app);
        // WindowServer must commit the hidden toolbar before SCK samples a frame.
        std::thread::sleep(std::time::Duration::from_millis(80));
        let result = (|| {
            if let Some(window_id) = source_id.strip_prefix("window:").and_then(|id| id.parse::<u32>().ok()) {
                crate::recorder::backend::prepare_for_screenshot(window_id)?;
            }
            let png = crate::recorder::backend::source_preview::capture_png(&source_id, crop, show_cursor)
                .ok_or_else(|| AppError::Other("screenshot capture failed or source disappeared".into()))?;
            state.store.create_screenshot(&png, source_id.clone()).map(|p| p.id)
        })();
        let mut restore_errors = Vec::new();
        if was_visible {
            if let Err(error) = crate::windows::show_recorder_popover(&app) {
                restore_errors.push(format!("recorder bar: {error}"));
            }
        }
        if let Some(c) = crop {
            let selection = crate::recorder::types::CaptureAreaSelection { source_id: source_id.clone(), crop: c };
            if let Err(error) = crate::area_picker::show_area_frame_guide(&app, &selection) {
                restore_errors.push(format!("area frame: {error}"));
            }
        }
        finish_with_restored_capture_ui(result, restore_errors)
    }
    #[cfg(not(all(target_os = "macos", feature = "scap-capture")))]
    {
        let _ = (app, source_id, crop, show_cursor);
        Err(AppError::Unsupported)
    }
}

#[tauri::command(async)]
pub fn list_screenshots(state: State<AppState>) -> AppResult<Vec<ScreenshotSummary>> {
    state.store.list_screenshots()
}

#[tauri::command(async)]
pub fn load_screenshot(state: State<AppState>, id: String) -> AppResult<ScreenshotProject> {
    state.store.load_screenshot(&id)
}

#[tauri::command(async)]
pub fn save_screenshot_state(state: State<AppState>, id: String, editor_state: Value) -> AppResult<()> {
    state.store.save_screenshot_state(&id, editor_state)
}

#[tauri::command(async)]
pub fn rename_screenshot(state: State<AppState>, id: String, title: Option<String>) -> AppResult<()> {
    state.store.rename_screenshot(&id, title)
}

#[cfg(test)]
mod tests {
    use super::finish_with_restored_capture_ui;
    use crate::error::AppError;

    #[test]
    fn returns_capture_result_when_ui_restores() {
        assert_eq!(
            finish_with_restored_capture_ui::<String>(Ok("shot".into()), vec![])
                .expect("capture should succeed"),
            "shot"
        );
    }

    #[test]
    fn successful_capture_reports_restore_failure() {
        let error = finish_with_restored_capture_ui::<String>(
            Ok("shot".into()),
            vec!["recorder bar: failed".into()],
        )
        .expect_err("restore failure must not be reported as success");
        assert!(error.to_string().contains("recorder bar: failed"));
    }

    #[test]
    fn capture_and_restore_failures_are_both_preserved() {
        let error = finish_with_restored_capture_ui::<String>(
            Err(AppError::Other("capture failed".into())),
            vec!["area frame: failed".into()],
        )
        .expect_err("both failures must be reported");
        let message = error.to_string();
        assert!(message.contains("capture failed"));
        assert!(message.contains("area frame: failed"));
    }
}
