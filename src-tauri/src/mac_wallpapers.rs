//! Locally installed macOS still wallpapers for the editor's background picker.
//! `.madesktop` entries without a full-resolution image are not selectable.

use crate::backgrounds::{self, CustomBackground};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

const IMPORT_IDS_FILE: &str = "mac-wallpaper-imports.json";

fn saved_import_ids(app_data: &Path) -> HashSet<String> {
    fs::read(app_data.join(IMPORT_IDS_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .collect()
}

fn remember_import(app_data: &Path, id: &str) -> AppResult<()> {
    let mut ids = saved_import_ids(app_data);
    if !ids.insert(id.to_string()) {
        return Ok(());
    }
    fs::create_dir_all(app_data)?;
    let mut ids: Vec<_> = ids.into_iter().collect();
    ids.sort();
    let tmp = app_data.join(format!("{IMPORT_IDS_FILE}.tmp"));
    fs::write(&tmp, serde_json::to_vec(&ids)?)?;
    fs::rename(tmp, app_data.join(IMPORT_IDS_FILE))?;
    Ok(())
}

pub fn known_import_ids(app_data: &Path) -> HashSet<String> {
    let mut ids = saved_import_ids(app_data);
    #[cfg(target_os = "macos")]
    ids.extend(macos::installed_ids());
    ids
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacWallpaper {
    pub id: String,
    pub name: String,
    pub thumbnail_data_url: Option<String>,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use base64::Engine;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    const ROOTS: [&str; 2] = [
        "/System/Library/Desktop Pictures",
        "/Library/Desktop Pictures",
    ];

    struct WallpaperFile {
        id: String,
        name: String,
        path: PathBuf,
    }

    fn is_still_image(path: &Path) -> bool {
        matches!(
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_lowercase())
                .as_deref(),
            Some("heic" | "jpg" | "jpeg" | "png" | "webp")
        )
    }

    fn collect_images(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        if depth > 3 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if entry.file_name() != ".thumbnails" {
                    collect_images(&path, depth + 1, out);
                }
            } else if kind.is_file() && is_still_image(&path) {
                out.push(path);
            }
        }
    }

    fn files() -> Vec<WallpaperFile> {
        let mut paths = Vec::new();
        for root in ROOTS {
            collect_images(Path::new(root), 0, &mut paths);
        }
        let mut wallpapers = Vec::new();
        for path in paths {
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let mut digest = Sha256::new();
            digest.update(path.to_string_lossy().as_bytes());
            digest.update(metadata.len().to_le_bytes());
            if let Ok(modified) = metadata.modified() {
                if let Ok(elapsed) = modified.duration_since(std::time::UNIX_EPOCH) {
                    digest.update(elapsed.as_nanos().to_le_bytes());
                }
            }
            let id = format!("{:x}", digest.finalize())[..32].to_string();
            wallpapers.push(WallpaperFile {
                id,
                name: name.to_string(),
                path,
            });
        }
        wallpapers.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        wallpapers
    }

    pub fn installed_ids() -> HashSet<String> {
        files().into_iter().map(|wallpaper| wallpaper.id).collect()
    }

    fn preview_source(path: &Path) -> PathBuf {
        let Some(parent) = path.parent() else {
            return path.to_path_buf();
        };
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            return path.to_path_buf();
        };
        let system_thumbnail = parent.join(".thumbnails").join(format!("{stem}.heic"));
        if system_thumbnail.is_file() {
            return system_thumbnail;
        }
        let wallpaper_thumbnail = parent.join(format!("{stem} Thumbnail@2x.png"));
        if wallpaper_thumbnail.is_file() {
            return wallpaper_thumbnail;
        }
        path.to_path_buf()
    }

    fn convert_to_jpeg(source: &Path, destination: &Path, max_pixels: u32) -> AppResult<()> {
        let output = Command::new("/usr/bin/sips")
            .args(["-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z"])
            .arg(max_pixels.to_string())
            .arg(source)
            .arg("--out")
            .arg(destination)
            .output()?;
        if !output.status.success() {
            return Err(AppError::Other(format!(
                "could not decode Mac wallpaper {}: {}",
                source.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        let bytes = fs::read(destination)?;
        if bytes.len() < 128 || !bytes.starts_with(&[0xff, 0xd8]) {
            return Err(AppError::Other(format!(
                "Mac wallpaper conversion produced no JPEG: {}",
                source.display()
            )));
        }
        Ok(())
    }

    fn cached_preview(app_data: &Path, wallpaper: &WallpaperFile) -> AppResult<String> {
        let cache = app_data.join("mac-wallpaper-previews");
        fs::create_dir_all(&cache)?;
        let preview = cache.join(format!("{}.jpg", wallpaper.id));
        if !preview.is_file() {
            convert_to_jpeg(&preview_source(&wallpaper.path), &preview, 320)?;
        }
        let bytes = fs::read(preview)?;
        Ok(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    pub fn list(app_data: &Path) -> Vec<MacWallpaper> {
        files()
            .into_iter()
            .map(|wallpaper| MacWallpaper {
                thumbnail_data_url: cached_preview(app_data, &wallpaper).ok(),
                id: wallpaper.id,
                name: wallpaper.name,
            })
            .collect()
    }

    pub fn import(app_data: &Path, id: &str) -> AppResult<CustomBackground> {
        let wallpaper = files()
            .into_iter()
            .find(|candidate| candidate.id == id)
            .ok_or_else(|| AppError::Other("Mac wallpaper is no longer installed".into()))?;
        let file_name = format!("{id}.jpg");
        if backgrounds::dir(app_data).join(&file_name).is_file() {
            remember_import(app_data, id)?;
            return Ok(CustomBackground {
                id: id.to_string(),
                file_name,
                is_mac_wallpaper: true,
            });
        }
        let cache = app_data.join("mac-wallpaper-previews");
        fs::create_dir_all(&cache)?;
        let converted = cache.join(format!("{id}-full.jpg"));
        convert_to_jpeg(&wallpaper.path, &converted, 4096)?;
        let bytes = fs::read(&converted)?;
        let result = backgrounds::save_with_id(app_data, &bytes, "jpg", id);
        let _ = fs::remove_file(converted);
        let mut result = result?;
        remember_import(app_data, id)?;
        result.is_mac_wallpaper = true;
        Ok(result)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn lists_only_real_still_images() {
            let root = std::env::temp_dir().join(format!("mac-wallpapers-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join(".thumbnails")).unwrap();
            fs::write(root.join("Still.heic"), b"image").unwrap();
            fs::write(root.join("Dynamic.madesktop"), b"plist").unwrap();
            fs::write(root.join(".thumbnails/Dynamic.heic"), b"thumbnail").unwrap();
            let mut images = Vec::new();
            collect_images(&root, 0, &mut images);
            assert_eq!(images, vec![root.join("Still.heic")]);
            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn installed_wallpaper_import_produces_a_saved_jpeg() {
            let Some(wallpaper) = files().into_iter().find(|item| {
                item.path.extension().and_then(|ext| ext.to_str()) == Some("heic")
            }) else {
                return;
            };
            let app_data = std::env::temp_dir().join(format!(
                "mac-wallpaper-import-{}",
                uuid::Uuid::new_v4()
            ));
            assert!(cached_preview(&app_data, &wallpaper)
                .unwrap()
                .starts_with("data:image/jpeg;base64,"));
            let imported = import(&app_data, &wallpaper.id).unwrap();
            assert!(imported.is_mac_wallpaper);
            assert!(saved_import_ids(&app_data).contains(&wallpaper.id));
            assert!(known_import_ids(&app_data).contains(&wallpaper.id));
            let jpeg = backgrounds::dir(&app_data).join(imported.file_name);
            assert!(fs::read(jpeg).unwrap().starts_with(&[0xff, 0xd8]));
            fs::remove_dir_all(app_data).unwrap();
        }
    }
}

pub fn list(app_data: &Path) -> Vec<MacWallpaper> {
    #[cfg(target_os = "macos")]
    {
        macos::list(app_data)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_data;
        Vec::new()
    }
}

pub fn import(app_data: &Path, id: &str) -> AppResult<CustomBackground> {
    #[cfg(target_os = "macos")]
    {
        macos::import(app_data, id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app_data, id);
        Err(AppError::Other("Mac wallpapers are available only on macOS".into()))
    }
}
