//! IPC for the global custom-background library (`{app_data}/backgrounds/`).

use crate::backgrounds::{self, CustomBackground};
use crate::error::{AppError, AppResult};
use crate::mac_wallpapers::{self, MacWallpaper};
use crate::state::AppState;
use tauri::State;

const EXT_HEADER: &str = "x-background-ext";

/// Persist a custom background image. The image bytes are the *entire* invoke
/// payload (same raw-body rule as camera/export chunks); the extension rides
/// in `x-background-ext`.
#[tauri::command(async)]
pub fn save_custom_background(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<CustomBackground> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Other(
            "save_custom_background expects a raw byte body".into(),
        ));
    };
    let ext = request
        .headers()
        .get(EXT_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("jpg");
    backgrounds::save(state.store.app_data_dir(), bytes, ext)
}

#[tauri::command(async)]
pub fn list_custom_backgrounds(
    state: State<'_, AppState>,
) -> AppResult<Vec<CustomBackground>> {
    let mut items = backgrounds::list(state.store.app_data_dir())?;
    let wallpaper_ids = mac_wallpapers::known_import_ids(state.store.app_data_dir());
    for item in &mut items {
        item.is_mac_wallpaper = wallpaper_ids.contains(&item.id);
    }
    Ok(items)
}

#[tauri::command(async)]
pub fn delete_custom_background(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    backgrounds::delete(state.store.app_data_dir(), &id)
}

#[tauri::command(async)]
pub fn list_mac_wallpapers(state: State<'_, AppState>) -> Vec<MacWallpaper> {
    mac_wallpapers::list(state.store.app_data_dir())
}

#[tauri::command(async)]
pub fn import_mac_wallpaper(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<CustomBackground> {
    mac_wallpapers::import(state.store.app_data_dir(), &id)
}
