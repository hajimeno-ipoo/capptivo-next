//! Picker thumbnails use the original Quartz still-image path.
//! Full-resolution screenshot capture below is a separate operation.

use super::preview::{SourcePreview, PREVIEW_MAX_WIDTH};
use crate::recorder::types::CaptureCrop;
use base64::{engine::general_purpose::STANDARD, Engine};
use block::ConcreteBlock;
use core_graphics::display::CGDisplay;
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
use screencapturekit_sys::content_filter::UnsafeContentFilter;
use std::io::Cursor;
use std::sync::mpsc;
use std::time::Duration;

const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy)]
enum ScreenshotConfigurationKind {
    Display,
    SingleWindow,
    WindowWithInk,
}

#[cfg(test)]
mod screenshot_tests {
    use super::{configure_single_window_capture, trim_window_png_to_visible_bounds, ScreenshotConfigurationKind};
    use image::{ImageBuffer, ImageFormat, Rgba};
    use objc::{class, msg_send, sel, sel_impl};
    use objc::runtime::Object;
    use std::io::Cursor;

    #[test]
    fn screenshot_configuration_survives_native_copy() {
        unsafe {
            let config: *mut Object = msg_send![class!(SCStreamConfiguration), new];
            configure_single_window_capture(config, ScreenshotConfigurationKind::WindowWithInk);
            let copied: *mut Object = msg_send![config, copy];
            assert!(!copied.is_null());
            let _: () = msg_send![copied, release];
            let _: () = msg_send![config, release];
        }
    }

    #[test]
    fn window_screenshot_trims_transparent_capture_margins() {
        let mut image = ImageBuffer::from_pixel(6, 5, Rgba([0u8, 0, 0, 0]));
        for y in 0..4 {
            for x in 0..4 {
                image.put_pixel(x, y, Rgba([240, 240, 240, 255]));
            }
        }
        let mut png = Vec::new();
        image.write_to(&mut Cursor::new(&mut png), ImageFormat::Png).unwrap();

        let trimmed = trim_window_png_to_visible_bounds(png).unwrap();
        let decoded = image::load_from_memory_with_format(&trimmed, ImageFormat::Png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (4, 4));
        assert_eq!(decoded.to_rgba8().get_pixel(3, 3).0, [240, 240, 240, 255]);
    }
}

/// Original-resolution still image for a selected display, window or display-local area.
/// Picker thumbnails must not be used here: they are deliberately capped at 240px.
pub fn capture_png(
    app: &tauri::AppHandle,
    source_id: &str,
    crop: Option<CaptureCrop>,
    show_cursor: bool,
) -> Option<Vec<u8>> {
    let plan = super::capture_filter::screenshot_plan(app, source_id, crop).map_err(|error| {
        tracing::warn!(%error, "screenshot capture filter failed");
    }).ok()?;
    let kind = if plan.single_window {
        ScreenshotConfigurationKind::SingleWindow
    } else if source_id.starts_with("window:") {
        ScreenshotConfigurationKind::WindowWithInk
    } else {
        ScreenshotConfigurationKind::Display
    };
    let png = sck_png(plan.filter, plan.native_size.0, plan.native_size.1,
        plan.source_rect, show_cursor, kind)?;
    if source_id.starts_with("window:") { trim_window_png_to_visible_bounds(png) }
    else { Some(png) }
}

/// Single-window stills may reserve clear pixels beyond the visible window.
/// Keep the stored source, rounded clipping and editor shadow on one rect.
fn trim_window_png_to_visible_bounds(png: Vec<u8>) -> Option<Vec<u8>> {
    let image = image::load_from_memory_with_format(&png, ImageFormat::Png).ok()?.to_rgba8();
    let (width, height) = image.dimensions();
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0;
    let mut max_y = 0;
    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel[3] == 0 { continue; }
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }
    if min_x == width { return None; }
    if min_x == 0 && min_y == 0 && max_x == width - 1 && max_y == height - 1 {
        return Some(png);
    }
    let cropped = image::imageops::crop_imm(
        &image, min_x, min_y, max_x - min_x + 1, max_y - min_y + 1,
    ).to_image();
    let mut output = Vec::new();
    cropped.write_to(&mut Cursor::new(&mut output), ImageFormat::Png).ok()?;
    Some(output)
}

fn sck_png(filter: Id<UnsafeContentFilter>, width_px: u32, height_px: u32,
    crop: Option<CaptureCrop>, show_cursor: bool,
    kind: ScreenshotConfigurationKind) -> Option<Vec<u8>> {
    // Current ScreenCaptureKit has a screenshot-specific configuration whose
    // clipping controls apply to single-window stills. Prefer it when present;
    // older systems keep using the original SCStreamConfiguration API below.
    if !sck_available() {
        return sck_stream_png(filter, width_px, height_px, crop, show_cursor, kind);
    }
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

/// macOS 13 has ScreenCaptureKit streams but no SCScreenshotManager. Capture
/// one complete frame with the identical content filter and crop configuration.
fn sck_stream_png(
    filter: Id<UnsafeContentFilter>, width: u32, height: u32,
    crop: Option<CaptureCrop>, show_cursor: bool, kind: ScreenshotConfigurationKind,
) -> Option<Vec<u8>> {
    use screencapturekit_sys::cm_sample_buffer_ref::CMSampleBufferRef;
    use screencapturekit_sys::sc_stream_frame_info::SCFrameStatus;
    use screencapturekit_sys::stream::UnsafeSCStream;
    use screencapturekit_sys::stream_configuration::{UnsafeStreamConfiguration, UnsafeStreamConfigurationRef};
    use screencapturekit_sys::stream_error_handler::UnsafeSCStreamError;
    use screencapturekit_sys::stream_output_handler::UnsafeSCStreamOutput;
    use std::sync::Mutex;

    struct OneFrame(Mutex<Option<mpsc::Sender<Option<Vec<u8>>>>>);
    impl UnsafeSCStreamOutput for OneFrame {
        fn did_output_sample_buffer(&self, sample: Id<CMSampleBufferRef>, of_type: u8) {
            if of_type != 0 || !matches!(sample.get_frame_info().status(), SCFrameStatus::Complete) {
                return;
            }
            let Some(image) = sample.get_image_buffer() else { return; };
            let Some(tx) = self.0.lock().unwrap_or_else(|error| error.into_inner()).take() else { return; };
            let pixel = image.as_pixel_buffer();
            let png = unsafe {
                extern "C" {
                    fn CVPixelBufferGetWidth(buffer: *mut std::ffi::c_void) -> usize;
                    fn CVPixelBufferGetHeight(buffer: *mut std::ffi::c_void) -> usize;
                    fn CVPixelBufferGetBytesPerRow(buffer: *mut std::ffi::c_void) -> usize;
                }
                if pixel.lock_base_address(1) != 0 { let _ = tx.send(None); return; }
                let ptr = &*pixel as *const _ as *mut std::ffi::c_void;
                let width = CVPixelBufferGetWidth(ptr);
                let height = CVPixelBufferGetHeight(ptr);
                let stride = CVPixelBufferGetBytesPerRow(ptr);
                let base = pixel.get_base_address();
                let rgba = if base.is_null() || width == 0 || height == 0 || stride < width * 4 {
                    None
                } else {
                    let bytes = std::slice::from_raw_parts(base as *const u8, stride * height);
                    let mut rgba = vec![0u8; width * height * 4];
                    for y in 0..height {
                        for x in 0..width {
                            let input = y * stride + x * 4;
                            let output = (y * width + x) * 4;
                            rgba[output..output + 4].copy_from_slice(&[
                                bytes[input + 2], bytes[input + 1], bytes[input], bytes[input + 3],
                            ]);
                        }
                    }
                    RgbaImage::from_raw(width as u32, height as u32, rgba)
                };
                pixel.unlock_base_address(1);
                rgba.and_then(|image| {
                    let mut png = Vec::new();
                    image.write_to(&mut Cursor::new(&mut png), ImageFormat::Png).ok()?;
                    Some(png)
                })
            };
            let _ = tx.send(png);
        }
    }
    struct StreamError;
    impl UnsafeSCStreamError for StreamError {
        fn handle_error(&self) { tracing::warn!("screenshot SCStream error"); }
    }
    let config: Id<UnsafeStreamConfigurationRef> = UnsafeStreamConfiguration {
        width, height, shows_cursor: show_cursor.into(), queue_depth: 3, ..Default::default()
    }.into();
    unsafe {
        let raw = &*config as *const _ as *mut Object;
        configure_single_window_capture(raw, kind);
        if let Some(crop) = crop {
            let rect = CGRect::new(&CGPoint::new(crop.x, crop.y), &CGSize::new(crop.width, crop.height));
            let _: () = msg_send![raw, setSourceRect: rect];
        }
    }
    let (tx, rx) = mpsc::channel();
    let stream = UnsafeSCStream::init(filter, config, StreamError);
    stream.add_stream_output(OneFrame(Mutex::new(Some(tx))), 0);
    stream.start_capture().map_err(|error| tracing::warn!(%error, "screenshot stream start failed")).ok()?;
    let result = rx.recv_timeout(SCREENSHOT_TIMEOUT).ok().flatten();
    if let Err(error) = stream.stop_capture() { tracing::warn!(%error, "screenshot stream stop failed"); }
    result
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
    legacy_display_thumbnail(display_id)
}

pub fn window_thumbnail(window_id: u32) -> Option<SourcePreview> {
    legacy_window_thumbnail(window_id)
}

/// Configure Apple's single-window capture behavior when the running macOS
/// version exposes it. Both selectors were added after the app's macOS 13
/// deployment target, so availability must be checked at runtime.
fn configure_single_window_capture(
    config: *mut Object,
    kind: ScreenshotConfigurationKind,
) {
    unsafe {
        if matches!(kind, ScreenshotConfigurationKind::Display) { return; }
        if matches!(kind, ScreenshotConfigurationKind::WindowWithInk) {
            let supported: BOOL = msg_send![config, respondsToSelector: sel!(setIgnoreShadowsDisplay:)];
            if supported { let _: () = msg_send![config, setIgnoreShadowsDisplay: BOOL::from(true)]; }
            return;
        }
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
