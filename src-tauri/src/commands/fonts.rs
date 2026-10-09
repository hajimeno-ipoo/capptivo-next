//! Native font names and the app's private font-file library.
//! Imported files are never installed or registered with the OS font manager.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "macos")]
use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::{CFRelease, CFType, CFTypeRef, TCFType},
    string::{CFString, CFStringRef},
    url::{CFURLRef, CFURL},
};

#[cfg(target_os = "macos")]
#[link(name = "CoreText", kind = "framework")]
unsafe extern "C" {
    fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
    fn CTFontCreateWithName(
        name: CFStringRef,
        size: f64,
        matrix: *const std::ffi::c_void,
    ) -> CFTypeRef;
    fn CTFontCreateWithFontDescriptor(
        descriptor: CFTypeRef,
        size: f64,
        matrix: *const std::ffi::c_void,
    ) -> CFTypeRef;
    fn CTFontCopyLocalizedName(
        font: CFTypeRef,
        key: CFStringRef,
        language: *mut CFStringRef,
    ) -> CFStringRef;
    fn CTFontManagerCreateFontDescriptorsFromURL(url: CFURLRef) -> CFArrayRef;
    static kCTFontFamilyNameKey: CFStringRef;
    static kCTFontFullNameKey: CFStringRef;
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    pub family: String,
    pub display_name: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppFont {
    pub family: String,
    pub display_name: String,
    pub filename: String,
}

#[cfg(target_os = "macos")]
fn localized_name(font: CFTypeRef, key: CFStringRef) -> Option<String> {
    let name = unsafe { CTFontCopyLocalizedName(font, key, std::ptr::null_mut()) };
    if name.is_null() {
        None
    } else {
        Some(unsafe { CFString::wrap_under_create_rule(name) }.to_string())
    }
}

/// Keep the CSS family unchanged while using the font's localized display name.
#[tauri::command]
pub fn list_system_fonts() -> Vec<SystemFont> {
    #[cfg(target_os = "macos")]
    {
        let names = unsafe { CTFontManagerCopyAvailableFontFamilyNames() };
        if names.is_null() {
            return Vec::new();
        }
        let names: CFArray<CFString> = unsafe { CFArray::wrap_under_create_rule(names) };
        names
            .iter()
            .map(|name| {
                let family = name.to_string();
                let font = unsafe {
                    CTFontCreateWithName(name.as_concrete_TypeRef(), 12.0, std::ptr::null())
                };
                let display_name = if font.is_null() {
                    family.clone()
                } else {
                    let name = localized_name(font, unsafe { kCTFontFamilyNameKey })
                        .unwrap_or_else(|| family.clone());
                    unsafe { CFRelease(font) };
                    name
                };
                SystemFont {
                    family,
                    display_name,
                }
            })
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

fn font_directory(app_data: &Path) -> PathBuf {
    app_data.join("fonts")
}

fn valid_filename(filename: &str) -> bool {
    let Some((hash, extension)) = filename.rsplit_once('.') else {
        return false;
    };
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && matches!(extension, "ttf" | "otf")
}

/// Read file metadata without making the font visible to other applications.
#[cfg(target_os = "macos")]
fn font_display_name(path: &Path) -> AppResult<String> {
    let url =
        CFURL::from_path(path, false).ok_or_else(|| AppError::Other("invalid font path".into()))?;
    let descriptors =
        unsafe { CTFontManagerCreateFontDescriptorsFromURL(url.as_concrete_TypeRef()) };
    if descriptors.is_null() {
        return Err(AppError::Other(
            "the selected file is not a valid font".into(),
        ));
    }
    let descriptors: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(descriptors) };
    if descriptors.len() != 1 {
        return Err(AppError::Other(
            "select a single-face .ttf or .otf font".into(),
        ));
    }
    let font = unsafe {
        CTFontCreateWithFontDescriptor(
            descriptors.get(0).unwrap().as_CFTypeRef(),
            12.0,
            std::ptr::null(),
        )
    };
    if font.is_null() {
        return Err(AppError::Other("could not read font metadata".into()));
    }
    let display_name = localized_name(font, unsafe { kCTFontFullNameKey });
    unsafe { CFRelease(font) };
    display_name
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::Other("font has no display name".into()))
}

#[cfg(not(target_os = "macos"))]
fn font_display_name(_path: &Path) -> AppResult<String> {
    Err(AppError::Unsupported)
}

fn app_font(path: &Path, filename: String) -> AppResult<AppFont> {
    let hash = filename.split('.').next().unwrap();
    Ok(AppFont {
        family: format!("CapptivoFont-{hash}"),
        display_name: font_display_name(path)?,
        filename,
    })
}

fn import_font_file(app_data: &Path, source: &Path) -> AppResult<AppFont> {
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "ttf" | "otf") {
        return Err(AppError::Other("select a .ttf or .otf font".into()));
    }
    let bytes = std::fs::read(source)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let directory = font_directory(app_data);
    std::fs::create_dir_all(&directory)?;
    // Reimporting identical bytes also reuses a copy with the other extension.
    for extension in ["ttf", "otf"] {
        let filename = format!("{hash}.{extension}");
        let path = directory.join(&filename);
        if path.is_file() && !std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return app_font(&path, filename);
        }
    }
    let filename = format!("{hash}.{extension}");
    let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, bytes)?;
    let result = (|| {
        let font = app_font(&temporary, filename.clone())?;
        std::fs::rename(&temporary, directory.join(filename))?;
        Ok(font)
    })();
    if temporary.exists() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[tauri::command(async)]
pub fn import_app_font(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<AppFont>> {
    #[cfg(not(target_os = "macos"))]
    return Err(AppError::Unsupported);
    #[cfg(target_os = "macos")]
    {
        let Some(selected) = app
            .dialog()
            .file()
            .add_filter("Fonts", &["ttf", "otf"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let font = import_font_file(state.store.app_data_dir(), &path)?;
        if let Err(error) = app.emit("fonts://changed", ()) {
            tracing::warn!(%error, "could not notify font library change");
        }
        Ok(Some(font))
    }
}

#[tauri::command(async)]
pub fn list_app_fonts(state: State<'_, AppState>) -> AppResult<Vec<AppFont>> {
    list_font_files(state.store.app_data_dir())
}

fn list_font_files(app_data: &Path) -> AppResult<Vec<AppFont>> {
    let directory = font_directory(app_data);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut fonts = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let filename = entry.file_name().to_string_lossy().to_string();
        if valid_filename(&filename) && entry.file_type()?.is_file() {
            fonts.push(app_font(&entry.path(), filename)?);
        }
    }
    fonts.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(fonts)
}

#[tauri::command(async)]
pub fn read_app_font(
    state: State<'_, AppState>,
    filename: String,
) -> AppResult<tauri::ipc::Response> {
    read_font_file(state.store.app_data_dir(), &filename).map(tauri::ipc::Response::new)
}

fn read_font_file(app_data: &Path, filename: &str) -> AppResult<Vec<u8>> {
    Ok(std::fs::read(private_font_path(app_data, filename)?)?)
}

#[tauri::command(async)]
pub fn delete_app_font(
    state: State<'_, AppState>,
    filename: String,
    app: AppHandle,
) -> AppResult<()> {
    delete_font_file(state.store.app_data_dir(), &filename)?;
    if let Err(error) = app.emit("fonts://changed", ()) {
        tracing::warn!(%error, "could not notify font library change");
    }
    Ok(())
}

fn delete_font_file(app_data: &Path, filename: &str) -> AppResult<()> {
    std::fs::remove_file(private_font_path(app_data, filename)?)?;
    Ok(())
}

fn private_font_path(app_data: &Path, filename: &str) -> AppResult<PathBuf> {
    if !valid_filename(filename) {
        return Err(AppError::Other("invalid app font filename".into()));
    }
    let path = font_directory(app_data).join(filename);
    if !std::fs::symlink_metadata(&path)?.file_type().is_file() {
        return Err(AppError::Other("app font must be a regular file".into()));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_filename_cannot_escape_private_directory() {
        let filename = format!("{}.ttf", "a".repeat(64));
        assert!(valid_filename(&filename));
        assert!(!valid_filename(&format!("../{filename}")));
        assert!(!valid_filename(&format!("/tmp/{filename}")));
        assert!(!valid_filename("font.ttf"));
        assert!(!valid_filename(&format!("{}.ttc", "a".repeat(64))));
        assert!(read_font_file(Path::new("/tmp"), "../font.ttf").is_err());
        assert!(delete_font_file(Path::new("/tmp"), "../font.ttf").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn core_text_supplies_japanese_family_names() {
        let fonts = list_system_fonts();
        for (family, localized) in [
            ("Hiragino Sans", "ヒラギノ角ゴシック"),
            ("Hiragino Mincho ProN", "ヒラギノ明朝 ProN"),
            ("Hiragino Maru Gothic ProN", "ヒラギノ丸ゴ ProN"),
        ] {
            let font = fonts.iter().find(|font| font.family == family).unwrap();
            assert_eq!(font.display_name, localized);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn private_font_copy_reloads_and_deduplicates_without_os_registration() {
        struct TemporaryDirectory(PathBuf);
        impl Drop for TemporaryDirectory {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let directory = TemporaryDirectory(
            std::env::temp_dir().join(format!("capptivo-font-test-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&directory.0).unwrap();
        let source = directory.0.join("Monaco.ttf");
        let bytes = std::fs::read("/System/Library/Fonts/Monaco.ttf").unwrap();
        std::fs::write(&source, &bytes).unwrap();
        let os_fonts_before = serde_json::to_value(list_system_fonts()).unwrap();
        let imported = import_font_file(&directory.0, &source).unwrap();
        let imported_filename = imported.filename.clone();
        assert!(imported.family.starts_with("CapptivoFont-"));
        assert!(imported.display_name.contains("Monaco"));
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        assert_eq!(
            read_font_file(&directory.0, &imported.filename).unwrap(),
            bytes
        );
        assert_eq!(import_font_file(&directory.0, &source).unwrap(), imported);
        assert_eq!(list_font_files(&directory.0).unwrap(), vec![imported]);
        assert_eq!(
            serde_json::to_value(list_system_fonts()).unwrap(),
            os_fonts_before
        );
        let invalid = directory.0.join("invalid.ttf");
        std::fs::write(&invalid, b"invalid font data").unwrap();
        assert!(import_font_file(&directory.0, &invalid).is_err());
        assert_eq!(list_font_files(&directory.0).unwrap().len(), 1);
        assert!(std::fs::read_dir(font_directory(&directory.0))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .path()
                .extension()
                .is_some_and(|extension| extension == "tmp")));
        let outside = directory.0.join("outside.ttf");
        std::fs::write(&outside, &bytes).unwrap();
        let link_name = format!("{}.ttf", "b".repeat(64));
        std::os::unix::fs::symlink(&outside, font_directory(&directory.0).join(&link_name))
            .unwrap();
        assert!(read_font_file(&directory.0, &link_name).is_err());
        assert!(delete_font_file(&directory.0, &link_name).is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), bytes);
        assert_eq!(list_font_files(&directory.0).unwrap().len(), 1);
        delete_font_file(&directory.0, &imported_filename).unwrap();
        assert!(list_font_files(&directory.0).unwrap().is_empty());
        assert!(read_font_file(&directory.0, &imported_filename).is_err());
        assert!(delete_font_file(&directory.0, &imported_filename).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
        assert_eq!(
            serde_json::to_value(list_system_fonts()).unwrap(),
            os_fonts_before
        );
    }
}
