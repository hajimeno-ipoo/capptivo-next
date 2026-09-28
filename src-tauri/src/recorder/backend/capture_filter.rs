//! Shared native capture selection for movies and still images.
//! SCK composites the target and ink windows; controls are separate excluded windows.
use super::picker_sources;
use crate::{cursor::CaptureRect, error::{AppError, AppResult}, recorder::types::CaptureCrop, windows};
use objc::{msg_send, sel, sel_impl};
use objc_id::Id;
use screencapturekit_sys::{content_filter::{UnsafeContentFilter, UnsafeInitParams}, shareable_content::UnsafeSCShareableContent};
use tauri::{AppHandle, Manager};

pub struct CapturePlan {
    pub filter: Id<UnsafeContentFilter>,
    pub source_rect: Option<CaptureCrop>,
    pub native_size: (u32, u32),
    pub single_window: bool,
    pub key: Vec<u64>,
}

pub fn visible_ink_id(app: &AppHandle) -> Option<u32> {
    let win = app.get_webview_window(windows::ANNOTATION_LABEL)?;
    if !win.is_visible().ok()? { return None; }
    let ptr = win.ns_window().ok()?;
    let id: isize = unsafe { msg_send![ptr as *mut objc::runtime::Object, windowNumber] };
    (id > 0).then_some(id as u32)
}

pub fn plan(app: &AppHandle, source_id: &str, crop: Option<CaptureCrop>) -> AppResult<CapturePlan> {
    plan_inner(app, source_id, crop, true)
}

pub fn screenshot_plan(app: &AppHandle, source_id: &str, crop: Option<CaptureCrop>) -> AppResult<CapturePlan> {
    // Movies record the camera separately; still images capture the visible bubble.
    plan_inner(app, source_id, crop, false)
}

fn plan_inner(app: &AppHandle, source_id: &str, crop: Option<CaptureCrop>, exclude_camera: bool) -> AppResult<CapturePlan> {
    let content = UnsafeSCShareableContent::get()
        .map_err(|e| AppError::Other(format!("ScreenCaptureKit content: {e}")))?;
    let all_windows = content.windows();
    let displays = content.displays();
    let (kind, id) = source_id.split_once(':').ok_or_else(|| AppError::InvalidSource(source_id.into()))?;
    let id = id.parse::<u32>().map_err(|_| AppError::InvalidSource(source_id.into()))?;
    let ink_id = visible_ink_id(app);
    let ink = ink_id.map(|id| all_windows.iter().find(|w| w.get_window_id() == id).cloned()
        .ok_or_else(|| AppError::Other("ScreenCaptureKit has not published the annotation window yet".into()))).transpose()?;

    if kind == "window" {
        if crop.is_some() { return Err(AppError::InvalidSource(source_id.into())); }
        let window = all_windows.iter().find(|w| w.get_window_id() == id).cloned()
            .ok_or_else(|| AppError::InvalidSource(source_id.into()))?;
        let f = window.get_frame();
        let rect = CaptureRect { x:f.origin.x, y:f.origin.y, width:f.size.width, height:f.size.height };
        let display_id = picker_sources::display_for_window_frame(&rect, &displays)
            .ok_or_else(|| AppError::Other("The capture window has no display".into()))?;
        let scale = picker_sources::display_scale_factor(display_id) as f64;
        let native_size = pixel_size(rect.width, rect.height, scale);
        if let Some(ink) = ink {
            let display = displays.into_iter().find(|d| d.get_display_id() == display_id)
                .ok_or_else(|| AppError::InvalidSource(source_id.into()))?;
            let df = display.get_frame();
            let source_rect = display_local_rect(rect, df.origin.x, df.origin.y);
            let key = vec![1, id as u64, display_id as u64, ink_id.unwrap() as u64,
                source_rect.x.to_bits(), source_rect.y.to_bits(), rect.width.to_bits(), rect.height.to_bits()];
            return Ok(CapturePlan { filter: UnsafeContentFilter::init(UnsafeInitParams::DisplayIncludingWindows(display, vec![window, ink])),
                source_rect:Some(source_rect), native_size, single_window:false, key });
        }
        return Ok(CapturePlan { filter:UnsafeContentFilter::init(UnsafeInitParams::DesktopIndependentWindow(window)),
            source_rect:None, native_size, single_window:true, key:vec![0,id as u64] });
    }
    if kind != "display" { return Err(AppError::InvalidSource(source_id.into())); }
    let display = displays.into_iter().find(|d| d.get_display_id() == id)
        .ok_or_else(|| AppError::InvalidSource(source_id.into()))?;
    let frame = display.get_frame();
    let (width,height) = crop.map(|c|(c.width,c.height)).unwrap_or((frame.size.width,frame.size.height));
    if let Some(c) = crop {
        if !c.x.is_finite() || !c.y.is_finite() || c.x < 0.0 || c.y < 0.0 || c.x+c.width > frame.size.width+0.5 || c.y+c.height > frame.size.height+0.5 {
            return Err(AppError::InvalidSource("Capture area is outside the display".into()));
        }
    }
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err(AppError::InvalidSource("Capture area is empty".into()));
    }
    let mut excluded_ids = windows::overlay_cgwindow_ids(app);
    if !exclude_camera {
        if let Some(camera) = app.get_webview_window(windows::CAMERA_LABEL) {
            if let Ok(ptr) = camera.ns_window() {
                let camera_id: isize = unsafe { msg_send![ptr as *mut objc::runtime::Object, windowNumber] };
                excluded_ids.retain(|id| *id as isize != camera_id);
            }
        }
    }
    let excluded: Vec<_> = all_windows.into_iter().filter(|w| excluded_ids.contains(&w.get_window_id())).collect();
    let mut key = vec![2,id as u64,ink_id.unwrap_or(0) as u64];
    let mut ids: Vec<_> = excluded.iter().map(|w|w.get_window_id() as u64).collect();
    ids.sort_unstable(); key.extend(ids);
    Ok(CapturePlan { filter:UnsafeContentFilter::init(UnsafeInitParams::DisplayExcludingWindows(display,excluded)),
        source_rect:crop, native_size:pixel_size(width,height,picker_sources::display_scale_factor(id) as f64), single_window:false, key })
}

fn pixel_size(width:f64,height:f64,scale:f64)->(u32,u32) {
    ((width*scale).round().max(1.0) as u32,(height*scale).round().max(1.0) as u32)
}

fn display_local_rect(window: CaptureRect, display_x: f64, display_y: f64) -> CaptureCrop {
    CaptureCrop { x: window.x - display_x, y: window.y - display_y,
        width: window.width, height: window.height }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_on_left_display_is_cropped_in_that_displays_coordinates() {
        let crop = display_local_rect(CaptureRect { x: -1800.0, y: 125.0,
            width: 801.5, height: 601.5 }, -1920.0, -100.0);
        assert_eq!((crop.x, crop.y, crop.width, crop.height), (120.0, 225.0, 801.5, 601.5));
        assert_eq!(pixel_size(crop.width, crop.height, 2.0), (1603, 1203));
    }
}
