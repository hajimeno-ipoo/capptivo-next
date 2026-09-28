//! Display, area and window capture through the shared ScreenCaptureKit filter.
//!
//! Encoder dimensions come from the **first CVPixelBuffer** SCK emits — never from
//! a precomputed guess. That keeps `CaptureHandle` width/height aligned with what
//! FFmpeg actually receives (avoids letterboxing / black bars on the right).

use super::capture_filter;
use super::RawFrame;
use crate::recorder::types::CaptureCrop;
use crate::error::{AppError, AppResult};
use crate::recorder::hw_encoder;
use crossbeam_channel::{Sender, TrySendError};
use objc::{msg_send, sel, sel_impl};
use objc_id::Id;
use screencapturekit_sys::cm_sample_buffer_ref::CMSampleBufferRef;
use screencapturekit_sys::content_filter::UnsafeContentFilter;
use screencapturekit_sys::cv_pixel_buffer_ref::CVPixelBufferRef;
use screencapturekit_sys::os_types::base::{BOOL, CMTime, CMTimeScale};
use screencapturekit_sys::sc_stream_frame_info::SCFrameStatus;
use screencapturekit_sys::stream::UnsafeSCStream;
use screencapturekit_sys::stream_configuration::{
    UnsafeStreamConfiguration, UnsafeStreamConfigurationRef,
};
use screencapturekit_sys::stream_error_handler::UnsafeSCStreamError;
use screencapturekit_sys::stream_output_handler::UnsafeSCStreamOutput;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const OUTPUT_TYPE_SCREEN: u8 = 0;
/// How long `start()` waits for the first frame before failing capture.
pub const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);

struct QuietErrors;
impl UnsafeSCStreamError for QuietErrors {
    fn handle_error(&self) {
        tracing::warn!("SCStream capture error");
    }
}

/// Fires once with the pixel size of the first complete frame (encoder contract).
struct ReadyGate {
    tx: Mutex<Option<Sender<AppResult<([u32; 2], Instant, u64)>>>>,
    epoch: Instant,
    epoch_host_ns: u64,
    done: AtomicBool,
}

impl ReadyGate {
    fn new(
        tx: Sender<AppResult<([u32; 2], Instant, u64)>>,
        epoch: Instant,
        epoch_host_ns: u64,
    ) -> Self {
        Self {
            tx: Mutex::new(Some(tx)),
            epoch,
            epoch_host_ns,
            done: AtomicBool::new(false),
        }
    }

    fn signal(&self, width: u32, height: u32) {
        if self.done.swap(true, Ordering::Relaxed) {
            return;
        }
        let Some(tx) = self.tx.lock().unwrap().take() else {
            return;
        };
        let _ = tx.send(Ok(([width, height], self.epoch, self.epoch_host_ns)));
    }

    fn fail(&self, err: AppError) {
        if self.done.swap(true, Ordering::Relaxed) {
            return;
        }
        let Some(tx) = self.tx.lock().unwrap().take() else {
            return;
        };
        let _ = tx.send(Err(err));
    }
    fn was_signaled(&self) -> bool {
        self.done.load(Ordering::Relaxed)
    }
}

struct VideoOut {
    tx: Sender<RawFrame>,
    dropped: Arc<AtomicU64>,
    epoch_host_ns: u64,
    epoch: Instant,
    ready: Arc<ReadyGate>,
}

impl UnsafeSCStreamOutput for VideoOut {
    fn did_output_sample_buffer(&self, sample: Id<CMSampleBufferRef>, of_type: u8) {
        if of_type != OUTPUT_TYPE_SCREEN {
            return;
        }
        match sample.get_frame_info().status() {
            SCFrameStatus::Complete | SCFrameStatus::Started => {}
            _ => return,
        }
        let Some(image_buf) = sample.get_image_buffer() else {
            return;
        };
        let pixel = image_buf.as_pixel_buffer();
        let Some(raw) = copy_bgra_frame(&pixel, &sample, self.epoch_host_ns, self.epoch) else {
            return;
        };
        self.ready.signal(raw.width, raw.height);
        match self.tx.try_send(raw) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

/// Start capturing the selected source. Signals `ready` on the first frame (or `Err`
/// if setup fails / no frames before stop).
pub fn run_capture(
    app: AppHandle,
    source_id: String,
    crop: Option<CaptureCrop>,
    fps: u32,
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    tx: Sender<RawFrame>,
    ready: Sender<AppResult<([u32; 2], Instant, u64)>>,
) {
    if let Err(e) = run_capture_inner(app, source_id, crop, fps, stop, dropped, tx, ready.clone()) {
        let _ = ready.send(Err(e));
    }
}

fn run_capture_inner(
    app: AppHandle,
    source_id: String,
    crop: Option<CaptureCrop>,
    fps: u32,
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    tx: Sender<RawFrame>,
    ready: Sender<AppResult<([u32; 2], Instant, u64)>>,
) -> AppResult<()> {
    let initial = capture_filter::plan(&app, &source_id, crop)?;
    let native = ((initial.native_size.0 & !1).max(2), (initial.native_size.1 & !1).max(2));
    let output_size = hw_encoder::fit_to_hardware_edge(native.0, native.1).unwrap_or(native);
    let config_ref = stream_configuration(output_size, fps, initial.source_rect, initial.single_window, source_id.starts_with("window:"));
    let mut key = initial.key;
    let filter = initial.filter;
    let epoch = Instant::now();
    let epoch_host_ns = host_clock_ns();
    let ready_gate = Arc::new(ReadyGate::new(ready, epoch, epoch_host_ns));
    let stream = UnsafeSCStream::init(filter, config_ref, QuietErrors);
    stream.add_stream_output(
        VideoOut {
            tx,
            dropped,
            epoch_host_ns,
            epoch,
            ready: ready_gate.clone(),
        },
        OUTPUT_TYPE_SCREEN,
    );
    stream
        .start_capture()
        .map_err(|e| AppError::Other(format!("failed to start capture: {e}")))?;

    let mut last_error = None;
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(200));
        if stop.load(Ordering::Relaxed) { break; }
        let result = capture_filter::plan(&app, &source_id, crop).and_then(|next| {
            if next.key == key { return Ok(()); }
            let config = stream_configuration(output_size, fps, next.source_rect, next.single_window, source_id.starts_with("window:"));
            update_stream(&stream, &next.filter, &config)?;
            key = next.key;
            Ok(())
        });
        match result {
            Ok(()) => last_error = None,
            Err(error) => {
                let message = error.to_string();
                if last_error.as_ref() != Some(&message) {
                    tracing::warn!(%source_id, %error, "capture filter update failed");
                    last_error = Some(message);
                }
            }
        }
    }
    // `UnsafeSCStream::drop` calls `stop_capture()`, which can block for seconds.
    // Teardown off-thread so stop→start on the same window does not wedge the
    // next session waiting for SCK to release the window.
    let _ = std::thread::Builder::new()
        .name("sck-window-teardown".into())
        .spawn(move || drop(stream));
    if !ready_gate.was_signaled() {
        ready_gate.fail(AppError::Other(
            "capture stopped before the first frame".into(),
        ));
    }
    Ok(())
}

fn stream_configuration(
    output_size: (u32, u32), fps: u32, crop: Option<CaptureCrop>, single_window: bool, window_source: bool,
) -> Id<UnsafeStreamConfigurationRef> {
    let config: Id<UnsafeStreamConfigurationRef> = UnsafeStreamConfiguration {
        width: output_size.0, height: output_size.1,
        scales_to_fit: 1, shows_cursor: 0,
        minimum_frame_interval: CMTime { value: 1, timescale: fps.max(1) as CMTimeScale, epoch: 0, flags: 1 },
        ..Default::default()
    }.into();
    unsafe {
        let _: () = msg_send![&*config, setQueueDepth: 6usize];
        if window_source {
            if !single_window {
                let supported: BOOL = msg_send![&*config, respondsToSelector: sel!(setIgnoreShadowsDisplay:)];
                if supported != 0 {
                    let _: () = msg_send![&*config, setIgnoreShadowsDisplay: BOOL::from(true)];
                }
            }
        }
        if let Some(crop) = crop {
            let rect = core_graphics::geometry::CGRect::new(
                &core_graphics::geometry::CGPoint::new(crop.x, crop.y),
                &core_graphics::geometry::CGSize::new(crop.width, crop.height));
            let _: () = msg_send![&*config, setSourceRect: rect];
        }
    }
    if single_window { tune_window_stream_config(&config); }
    config
}

fn update_stream(stream: &UnsafeSCStream, filter: &UnsafeContentFilter, config: &UnsafeStreamConfigurationRef) -> AppResult<()> {
    use block::ConcreteBlock;
    use objc::runtime::Object;
    // Wait for each native completion so an unsuccessful update is retried and
    // the selection key never gets ahead of the stream's actual configuration.
    for update_filter in [true, false] {
        let (tx, rx) = std::sync::mpsc::channel();
        let completion = ConcreteBlock::new(move |error: *mut Object| {
            let _ = tx.send(error.is_null());
        }).copy();
        unsafe {
            if update_filter {
                let _: () = msg_send![stream, updateContentFilter: filter completionHandler: &*completion];
            } else {
                let _: () = msg_send![stream, updateConfiguration: config completionHandler: &*completion];
            }
        }
        if rx.recv_timeout(Duration::from_secs(3)) != Ok(true) {
            return Err(AppError::Other(if update_filter { "ScreenCaptureKit filter update failed" } else { "ScreenCaptureKit configuration update failed" }.into()));
        }
    }
    Ok(())
}

/// macOS 14+: exclude window shadow and keep portions outside the display
/// bounds in single-window capture. Without the latter, SCK fills the clipped
/// portion of a partially off-screen window with black pixels.
pub(super) fn tune_window_stream_config(config_ref: &UnsafeStreamConfigurationRef) {
    unsafe {
        let supports_shadow_exclusion: BOOL =
            msg_send![config_ref, respondsToSelector: sel!(setIgnoreShadowsSingleWindow:)];
        if supports_shadow_exclusion != 0 {
            let _: () =
                msg_send![config_ref, setIgnoreShadowsSingleWindow: BOOL::from(true)];
        }
        let supports_global_clip: BOOL =
            msg_send![config_ref, respondsToSelector: sel!(setIgnoreGlobalClipSingleWindow:)];
        if supports_global_clip != 0 {
            let _: () =
                msg_send![config_ref, setIgnoreGlobalClipSingleWindow: BOOL::from(true)];
        }
    }
}

fn copy_bgra_frame(
    pixel: &CVPixelBufferRef,
    sample: &CMSampleBufferRef,
    epoch_host_ns: u64,
    epoch: Instant,
) -> Option<RawFrame> {
    const READ_ONLY: u64 = 1;
    unsafe {
        if pixel.lock_base_address(READ_ONLY) != 0 {
            return None;
        }
        let base = pixel.get_base_address();
        let pb = pixel as *const CVPixelBufferRef as *mut c_void;
        let width = CVPixelBufferGetWidth(pb) as u32;
        let height = CVPixelBufferGetHeight(pb) as u32;
        let bytes_per_row = CVPixelBufferGetBytesPerRow(pb) as u32;

        let data = if base.is_null() || width == 0 || height == 0 {
            None
        } else {
            let len = bytes_per_row as usize * height as usize;
            let mut buf = Vec::<u8>::with_capacity(len);
            std::ptr::copy_nonoverlapping(base as *const u8, buf.as_mut_ptr(), len);
            buf.set_len(len);
            Some(buf)
        };
        pixel.unlock_base_address(READ_ONLY);
        let data = data?;

        let pts_ns = cmtime_to_ns(sample.get_presentation_timestamp());
        let timestamp = if pts_ns > 0 {
            Duration::from_nanos(pts_ns.saturating_sub(epoch_host_ns))
        } else {
            epoch.elapsed()
        };

        Some(RawFrame {
            width,
            height,
            bytes_per_row,
            data,
            timestamp,
        })
    }
}

fn cmtime_to_ns(ts: CMTime) -> u64 {
    if ts.timescale == 0 {
        return 0;
    }
    let num = ts.value as i128 * 1_000_000_000;
    let den = ts.timescale as i128;
    (num / den).max(0) as u64
}

fn host_clock_ns() -> u64 {
    extern "C" {
        fn clock_gettime_nsec_np(clock_id: u32) -> u64;
    }
    const CLOCK_UPTIME_RAW: u32 = 8;
    unsafe { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }
}

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferGetWidth(pb: *mut c_void) -> usize;
    fn CVPixelBufferGetHeight(pb: *mut c_void) -> usize;
    fn CVPixelBufferGetBytesPerRow(pb: *mut c_void) -> usize;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_configuration_survives_native_copy() {
        let config = stream_configuration((640, 480), 30, None, false, true);
        let copied: *mut objc::runtime::Object = unsafe { msg_send![&*config, copy] };
        assert!(!copied.is_null());
        unsafe { let _: () = msg_send![copied, release]; }
    }

    #[test]
    fn cmtime_to_ns_converts_seconds() {
        let ts = CMTime {
            value: 2,
            timescale: 1,
            epoch: 0,
            flags: 1,
        };
        assert_eq!(cmtime_to_ns(ts), 2_000_000_000);
    }

    #[test]
    fn ready_gate_signals_once() {
        let (tx, rx) = crossbeam_channel::bounded(1);
        let epoch = Instant::now();
        let gate = ReadyGate::new(tx, epoch, 0);
        gate.signal(640, 480);
        gate.signal(800, 600);
        let (size, got_epoch, host_ns) = rx.recv().unwrap().unwrap();
        assert_eq!(size, [640, 480]);
        assert_eq!(got_epoch, epoch);
        assert_eq!(host_ns, 0);
    }
}
