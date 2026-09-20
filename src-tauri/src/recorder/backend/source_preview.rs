//! Picker thumbnails: one still frame per display/window.
//!
//! Primary path is `SCScreenshotManager` — the legacy Quartz screenshot APIs
//! (`CGDisplayCreateImage` / `CGWindowListCreateImage`) silently return NULL
//! on macOS 15+, which left the picker with blank numbered tiles. The Quartz
//! path is kept as the fallback for macOS < 14.4, where the manager class
//! doesn't exist.

use super::picker_sources::{
    display_scale_factor, display_for_window_frame, points_to_even_pixels,
};
use super::preview::{SourcePreview, PREVIEW_MAX_WIDTH};
use crate::cursor::CaptureRect;
use crate::recorder::types::CaptureCrop;
use base64::{engine::general_purpose::STANDARD, Engine};
use block::ConcreteBlock;
use core_graphics::display::CGDisplay;
use core_graphics::event::CGEvent;
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::image::CGImageRef;
use core_graphics::window::{
    create_image, kCGNullWindowID, kCGWindowImageBoundsIgnoreFraming,
    kCGWindowImageBestResolution, kCGWindowListOptionIncludingWindow,
    kCGWindowListOptionOnScreenOnly,
};
use foreign_types::ForeignTypeRef;
use image::{ImageBuffer, ImageFormat, RgbaImage};
use objc::runtime::{Class, Object, BOOL, NO};
use objc::{class, msg_send, sel, sel_impl};
use objc_id::Id;
use screencapturekit_sys::content_filter::{UnsafeContentFilter, UnsafeInitParams};
use screencapturekit_sys::shareable_content::UnsafeSCShareableContent;
use std::io::Cursor;
use std::sync::mpsc;
use std::time::Duration;

const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy)]
enum ScreenshotConfigurationKind {
    Display,
    SingleWindow,
}

fn screenshot_pixels(width_points: f64, height_points: f64, scale: u32) -> (u32, u32) {
    ((width_points * scale as f64).round().max(1.0) as u32,
     (height_points * scale as f64).round().max(1.0) as u32)
}

#[cfg(test)]
mod screenshot_tests {
    use super::screenshot_pixels;

    #[test]
    fn screenshot_capture_keeps_odd_pixel_dimensions() {
        assert_eq!(screenshot_pixels(100.5, 200.5, 2), (201, 401));
    }
}

/// Original-resolution still image for a selected display, window or display-local area.
/// Picker thumbnails must not be used here: they are deliberately capped at 240px.
pub fn capture_png(source_id: &str, crop: Option<CaptureCrop>, show_cursor: bool) -> Option<Vec<u8>> {
    let content = UnsafeSCShareableContent::get().ok()?;
    if let Some(id) = source_id.strip_prefix("display:").and_then(|v| v.parse::<u32>().ok()) {
        let display = content.displays().into_iter().find(|d| d.get_display_id() == id)?;
        let frame = display.get_frame();
        let scale = display_scale_factor(id);
        let (w, h) = if let Some(c) = crop {
            if c.width <= 0.0 || c.height <= 0.0 || c.x < 0.0 || c.y < 0.0
                || c.x + c.width > frame.size.width + 0.5
                || c.y + c.height > frame.size.height + 0.5 { return None; }
            screenshot_pixels(c.width, c.height, scale)
        } else {
            screenshot_pixels(frame.size.width, frame.size.height, scale)
        };
        if sck_available() {
            let filter = UnsafeContentFilter::init(UnsafeInitParams::Display(display));
            return sck_png(
                filter,
                w,
                h,
                crop,
                show_cursor,
                ScreenshotConfigurationKind::Display,
            );
        }
        let image = CGDisplay::screenshot(
            CGDisplay::new(id).bounds(),
            kCGWindowListOptionOnScreenOnly,
            kCGNullWindowID,
            kCGWindowImageBestResolution,
        )?;
        let output_rect = crop.map(|c| CGRect::new(
            &CGPoint::new(frame.origin.x + c.x, frame.origin.y + c.y),
            &CGSize::new(c.width, c.height),
        )).unwrap_or_else(|| CGRect::new(
            &CGPoint::new(frame.origin.x, frame.origin.y),
            &CGSize::new(frame.size.width, frame.size.height),
        ));
        return png_legacy(&image, crop.map(|c| {
            let sx = image.width() as f64 / frame.size.width;
            let sy = image.height() as f64 / frame.size.height;
            (c.x * sx, c.y * sy, c.width * sx, c.height * sy)
        }), output_rect, show_cursor);
    }
    if crop.is_some() { return None; }
    let id = source_id.strip_prefix("window:")?.parse::<u32>().ok()?;
    let window = content.windows().into_iter().find(|w| w.get_window_id() == id)?;
    let frame = window.get_frame();
    let rect = CaptureRect { x: frame.origin.x, y: frame.origin.y, width: frame.size.width, height: frame.size.height };
    let scale = display_for_window_frame(&rect, &content.displays())
        .map(display_scale_factor).unwrap_or(1);
    let (w, h) = screenshot_pixels(rect.width, rect.height, scale);
    if sck_available() {
        let filter = UnsafeContentFilter::init(UnsafeInitParams::DesktopIndependentWindow(window));
        return sck_png(
            filter,
            w,
            h,
            None,
            show_cursor,
            ScreenshotConfigurationKind::SingleWindow,
        );
    }
    let bounds = CGRect::new(&CGPoint::new(f64::INFINITY, f64::INFINITY), &CGSize::new(0.0, 0.0));
    let image = create_image(bounds, kCGWindowListOptionIncludingWindow, id,
        kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution)?;
    png_legacy(&image, None, CGRect::new(
        &CGPoint::new(frame.origin.x, frame.origin.y),
        &CGSize::new(frame.size.width, frame.size.height),
    ), show_cursor)
}

/// Quartz stills do not provide ScreenCaptureKit's `showsCursor` setting.
/// Place the current AppKit cursor at its captured global position for macOS 13.
fn png_legacy(image: &CGImageRef, crop: Option<(f64, f64, f64, f64)>,
    rect: CGRect, show_cursor: bool) -> Option<Vec<u8>> {
    let png = png_full(image, crop)?;
    if !show_cursor { return Some(png); }
    let mut pixels = image::load_from_memory_with_format(&png, ImageFormat::Png).ok()?.to_rgba8();
    let Ok(source) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState) else { return Some(png); };
    let Ok(event) = CGEvent::new(source) else { return Some(png); };
    let location = event.location();
    if location.x < rect.origin.x || location.y < rect.origin.y
        || location.x >= rect.origin.x + rect.size.width
        || location.y >= rect.origin.y + rect.size.height { return Some(png); }
    let scale_x = pixels.width() as f64 / rect.size.width;
    let scale_y = pixels.height() as f64 / rect.size.height;
    objc::rc::autoreleasepool(|| unsafe {
        let cursor: *mut Object = msg_send![class!(NSCursor), currentSystemCursor];
        if cursor.is_null() { return; }
        let ns_image: *mut Object = msg_send![cursor, image];
        if ns_image.is_null() { return; }
        let size: CGSize = msg_send![ns_image, size];
        let hot_spot: CGPoint = msg_send![cursor, hotSpot];
        if size.width <= 0.0 || size.height <= 0.0 { return; }
        let cg_image: *mut Object = msg_send![ns_image,
            CGImageForProposedRect: std::ptr::null_mut::<CGRect>()
            context: std::ptr::null_mut::<Object>()
            hints: std::ptr::null_mut::<Object>()];
        if cg_image.is_null() { return; }
        let Some(cursor_png) = png_full(CGImageRef::from_ptr(cg_image.cast()), None) else { return; };
        let Ok(cursor_image) = image::load_from_memory_with_format(&cursor_png, ImageFormat::Png) else { return; };
        let w = (size.width * scale_x).round().max(1.0) as u32;
        let h = (size.height * scale_y).round().max(1.0) as u32;
        let cursor_image = cursor_image.resize_exact(w, h, image::imageops::FilterType::Lanczos3).to_rgba8();
        let x = ((location.x - rect.origin.x - hot_spot.x) * scale_x).round() as i64;
        let y = ((location.y - rect.origin.y - hot_spot.y) * scale_y).round() as i64;
        image::imageops::overlay(&mut pixels, &cursor_image, x, y);
    });
    let mut output = Vec::new();
    pixels.write_to(&mut Cursor::new(&mut output), ImageFormat::Png).ok()?;
    Some(output)
}

fn sck_png(filter: Id<UnsafeContentFilter>, width_px: u32, height_px: u32,
    crop: Option<CaptureCrop>, show_cursor: bool,
    kind: ScreenshotConfigurationKind) -> Option<Vec<u8>> {
    // Current ScreenCaptureKit has a screenshot-specific configuration whose
    // clipping controls apply to single-window stills. Prefer it when present;
    // older systems keep using the original SCStreamConfiguration API below.
    if matches!(kind, ScreenshotConfigurationKind::SingleWindow) {
        if let Ok(result) = sck_png_with_screenshot_configuration(
            &filter,
            width_px,
            height_px,
            show_cursor,
        ) {
            return result;
        }
    }

    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
    unsafe {
        let config: *mut Object = msg_send![class!(SCStreamConfiguration), new];
        let _: () = msg_send![config, setWidth: width_px as usize];
        let _: () = msg_send![config, setHeight: height_px as usize];
        let _: () = msg_send![config, setShowsCursor: show_cursor];
        configure_single_window_capture(config, kind);
        if let Some(c) = crop {
            let rect = CGRect::new(&CGPoint::new(c.x, c.y), &CGSize::new(c.width, c.height));
            let _: () = msg_send![config, setSourceRect: rect];
        }
        let handler = ConcreteBlock::new(move |image: *mut Object, _error: *mut Object| {
            let bytes = if image.is_null() { None } else { png_full(CGImageRef::from_ptr(image.cast()), None) };
            let _ = tx.send(bytes);
        }).copy();
        let _: () = msg_send![class!(SCScreenshotManager), captureImageWithFilter: &*filter
            configuration: config completionHandler: &*handler];
        let _: () = msg_send![config, release];
    }
    rx.recv_timeout(SCREENSHOT_TIMEOUT).ok().flatten()
}

/// Newer ScreenCaptureKit still-image API. `ignoreClipping` is the native
/// single-window equivalent of the stream API's `ignoreGlobalClipSingleWindow`.
/// Everything is runtime-checked so the macOS 13 deployment target stays valid.
fn sck_png_with_screenshot_configuration(
    filter: &UnsafeContentFilter,
    width_px: u32,
    height_px: u32,
    show_cursor: bool,
) -> Result<Option<Vec<u8>>, ()> {
    let config_class = Class::get("SCScreenshotConfiguration").ok_or(())?;
    unsafe {
        let supported: BOOL = msg_send![
            class!(SCScreenshotManager),
            respondsToSelector: sel!(captureScreenshotWithFilter:configuration:completionHandler:)
        ];
        if supported == NO {
            return Err(());
        }

        let config: *mut Object = msg_send![config_class, new];
        if config.is_null() {
            return Ok(None);
        }
        let _: () = msg_send![config, setWidth: width_px as usize];
        let _: () = msg_send![config, setHeight: height_px as usize];
        let _: () = msg_send![config, setShowsCursor: show_cursor];
        let _: () = msg_send![config, setIgnoreClipping: BOOL::from(true)];
        let _: () = msg_send![config, setIgnoreShadows: BOOL::from(true)];

        let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
        let handler = ConcreteBlock::new(move |output: *mut Object, _error: *mut Object| {
            let bytes = if output.is_null() {
                None
            } else {
                let image: *mut Object = msg_send![output, sdrImage];
                if image.is_null() {
                    None
                } else {
                    png_full(CGImageRef::from_ptr(image.cast()), None)
                }
            };
            let _ = tx.send(bytes);
        })
        .copy();
        let _: () = msg_send![
            class!(SCScreenshotManager),
            captureScreenshotWithFilter: filter
            configuration: config
            completionHandler: &*handler
        ];
        let _: () = msg_send![config, release];
        Ok(rx.recv_timeout(SCREENSHOT_TIMEOUT).ok().flatten())
    }
}

fn png_full(image: &CGImageRef, crop: Option<(f64, f64, f64, f64)>) -> Option<Vec<u8>> {
    let (w, h) = (image.width() as u32, image.height() as u32);
    if w == 0 || h == 0 { return None; }
    let stride = image.bytes_per_row() as usize;
    let bpp = (image.bits_per_pixel() as usize / 8).max(1);
    if bpp != 3 && bpp != 4 { return None; }
    let bytes = image.data();
    let raw = bytes.bytes();
    let mut rgba = vec![0u8; w as usize * h as usize * 4];
    for y in 0..h as usize {
        for x in 0..w as usize {
            let i = y * stride + x * bpp;
            if i + bpp > raw.len() { return None; }
            let o = (y * w as usize + x) * 4;
            if bpp == 4 {
                rgba[o] = raw[i + 2]; rgba[o + 1] = raw[i + 1]; rgba[o + 2] = raw[i]; rgba[o + 3] = raw[i + 3];
            } else {
                rgba[o] = raw[i]; rgba[o + 1] = raw[i + 1]; rgba[o + 2] = raw[i + 2]; rgba[o + 3] = 255;
            }
        }
    }
    let image = RgbaImage::from_raw(w, h, rgba)?;
    let image = if let Some((x, y, cw, ch)) = crop {
        let (x, y) = (x.round().max(0.0) as u32, y.round().max(0.0) as u32);
        let (cw, ch) = (cw.round().max(1.0) as u32, ch.round().max(1.0) as u32);
        if x.checked_add(cw)? > w || y.checked_add(ch)? > h { return None; }
        image::imageops::crop_imm(&image, x, y, cw, ch).to_image()
    } else { image };
    let mut out = Vec::new();
    image.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).ok()?;
    Some(out)
}

fn sck_available() -> bool {
    Class::get("SCScreenshotManager").is_some()
}

pub fn display_thumbnail(display_id: u32) -> Option<SourcePreview> {
    if !sck_available() {
        return legacy_display_thumbnail(display_id);
    }
    let content = UnsafeSCShareableContent::get().ok()?;
    let display = content
        .displays()
        .into_iter()
        .find(|d| d.get_display_id() == display_id)?;
    let frame = display.get_frame();
    let (w, h) = points_to_even_pixels(
        frame.size.width,
        frame.size.height,
        display_scale_factor(display_id),
    );
    let filter = UnsafeContentFilter::init(UnsafeInitParams::Display(display));
    sck_screenshot(filter, w, h, ScreenshotConfigurationKind::Display)
}

pub fn window_thumbnail(window_id: u32) -> Option<SourcePreview> {
    if !sck_available() {
        return legacy_window_thumbnail(window_id);
    }
    let content = UnsafeSCShareableContent::get().ok()?;
    let displays = content.displays();
    let window = content
        .windows()
        .into_iter()
        .find(|w| w.get_window_id() == window_id)?;
    let frame = window.get_frame();
    let rect = CaptureRect {
        x: frame.origin.x,
        y: frame.origin.y,
        width: frame.size.width,
        height: frame.size.height,
    };
    let scale = display_for_window_frame(&rect, &displays)
        .map(display_scale_factor)
        .unwrap_or(1);
    let (w, h) = points_to_even_pixels(rect.width, rect.height, scale);
    let filter =
        UnsafeContentFilter::init(UnsafeInitParams::DesktopIndependentWindow(window));
    sck_screenshot(
        filter,
        w,
        h,
        ScreenshotConfigurationKind::SingleWindow,
    )
}

/// One frame through `SCScreenshotManager`. The completion handler lands on an
/// SCK-internal queue, so blocking on the channel here is safe from any thread.
fn sck_screenshot(
    filter: Id<UnsafeContentFilter>,
    width_px: u32,
    height_px: u32,
    kind: ScreenshotConfigurationKind,
) -> Option<SourcePreview> {
    let (tx, rx) = mpsc::channel::<Option<SourcePreview>>();
    unsafe {
        let config: *mut Object = msg_send![class!(SCStreamConfiguration), new];
        let _: () = msg_send![config, setWidth: width_px as usize];
        let _: () = msg_send![config, setHeight: height_px as usize];
        let _: () = msg_send![config, setShowsCursor: NO as BOOL];
        configure_single_window_capture(config, kind);
        let handler = ConcreteBlock::new(move |image: *mut Object, _error: *mut Object| {
            let preview = if image.is_null() {
                None
            } else {
                encode_preview(CGImageRef::from_ptr(image.cast()))
            };
            let _ = tx.send(preview);
        })
        .copy();
        let _: () = msg_send![
            class!(SCScreenshotManager),
            captureImageWithFilter: &*filter
            configuration: config
            completionHandler: &*handler
        ];
        let _: () = msg_send![config, release];
    }
    rx.recv_timeout(SCREENSHOT_TIMEOUT).ok().flatten()
}

/// Configure Apple's single-window capture behavior when the running macOS
/// version exposes it. Both selectors were added after the app's macOS 13
/// deployment target, so availability must be checked at runtime.
fn configure_single_window_capture(
    config: *mut Object,
    kind: ScreenshotConfigurationKind,
) {
    if !matches!(kind, ScreenshotConfigurationKind::SingleWindow) {
        return;
    }

    unsafe {
        let supports_shadow_exclusion: BOOL =
            msg_send![config, respondsToSelector: sel!(setIgnoreShadowsSingleWindow:)];
        if supports_shadow_exclusion {
            let _: () =
                msg_send![config, setIgnoreShadowsSingleWindow: BOOL::from(true)];
        }

        let supports_global_clip: BOOL =
            msg_send![config, respondsToSelector: sel!(setIgnoreGlobalClipSingleWindow:)];
        if supports_global_clip {
            let _: () =
                msg_send![config, setIgnoreGlobalClipSingleWindow: BOOL::from(true)];
        }
    }
}

fn legacy_display_thumbnail(display_id: u32) -> Option<SourcePreview> {
    let display = CGDisplay::new(display_id);
    let bounds = display.bounds();
    let image = CGDisplay::screenshot(
        bounds,
        kCGWindowListOptionOnScreenOnly,
        kCGNullWindowID,
        kCGWindowImageBestResolution,
    )?;
    encode_preview(&image)
}

fn legacy_window_thumbnail(window_id: u32) -> Option<SourcePreview> {
    // CGRectNull — required for single-window capture.
    let bounds = CGRect::new(
        &CGPoint::new(f64::INFINITY, f64::INFINITY),
        &CGSize::new(0.0, 0.0),
    );
    let image = create_image(
        bounds,
        kCGWindowListOptionIncludingWindow,
        window_id,
        kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution,
    )?;
    encode_preview(&image)
}

fn encode_preview(image: &CGImageRef) -> Option<SourcePreview> {
    let width = image.width() as u32;
    let height = image.height() as u32;
    if width == 0 || height == 0 {
        return None;
    }
    let png_base64 = png_base64(image)?;
    Some(SourcePreview {
        png_base64,
    })
}

fn png_base64(image: &CGImageRef) -> Option<String> {
    let w = image.width() as u32;
    let h = image.height() as u32;
    let tw = PREVIEW_MAX_WIDTH.min(w).max(1);
    let th = ((h as u64 * tw as u64) / w as u64).max(1) as u32;
    let stride = image.bytes_per_row() as usize;
    let bpp = (image.bits_per_pixel() as usize / 8).max(1);
    let data = image.data();
    let raw = data.bytes();

    let mut rgba = vec![0u8; (tw * th * 4) as usize];
    for y in 0..th {
        let sy = (y as u64 * h as u64 / th as u64) as usize;
        for x in 0..tw {
            let sx = (x as u64 * w as u64 / tw as u64) as usize;
            let i = sy * stride + sx * bpp;
            if i + bpp > raw.len() {
                continue;
            }
            let o = ((y * tw + x) * 4) as usize;
            match bpp {
                4 => {
                    rgba[o] = raw[i + 2];
                    rgba[o + 1] = raw[i + 1];
                    rgba[o + 2] = raw[i];
                    rgba[o + 3] = raw[i + 3];
                }
                3 => {
                    rgba[o] = raw[i];
                    rgba[o + 1] = raw[i + 1];
                    rgba[o + 2] = raw[i + 2];
                    rgba[o + 3] = 255;
                }
                _ => {}
            }
        }
    }

    let buf: RgbaImage = ImageBuffer::from_raw(tw, th, rgba)?;
    let mut out = Vec::new();
    buf.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).ok()?;
    Some(STANDARD.encode(out))
}
