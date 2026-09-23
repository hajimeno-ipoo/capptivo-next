//! Raise the exact window chosen in the source menu using its macOS window ID.
//! Ask macOS for Accessibility permission when it is needed to focus a source.

use super::window_prepare;
use crate::error::{AppError, AppResult};
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use std::ffi::c_void;
use std::ptr;
use std::time::Duration;

type CfRef = *const c_void;
const AX_SUCCESS: i32 = 0;
type AxWindowId = unsafe extern "C" fn(CfRef, *mut u32) -> i32;

struct OwnedCf(CfRef);
impl Drop for OwnedCf {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}

pub fn focus(window_id: u32) -> AppResult<()> {
    let prompt_key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt.cast()) };
    let options = CFDictionary::from_CFType_pairs(&[(prompt_key, CFBoolean::true_value())]);
    if unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef().cast()) } == 0 {
        return Err(AppError::Other(
            "macOS の確認画面で Capptivo のアクセシビリティを許可し、ウィンドウをもう一度選択してください。".into(),
        ));
    }
    let (pid, _, _, _) = window_prepare::window_meta(window_id)?;
    if pid <= 0 {
        return Err(AppError::InvalidSource(
            "Selected window has no owning app".into(),
        ));
    }

    let app = OwnedCf(unsafe { AXUIElementCreateApplication(pid) });
    if app.0.is_null() {
        return Err(AppError::InvalidSource(
            "Selected app is no longer available".into(),
        ));
    }
    let windows = attribute(app.0, "AXWindows")?;
    if unsafe { CFGetTypeID(windows.0) } != unsafe { CFArrayGetTypeID() } {
        return Err(AppError::Other(
            "Selected app did not provide a window list".into(),
        ));
    }

    // Resolve the private AX-to-CG window ID accessor at runtime so an OS that
    // lacks it reports an error instead of preventing Capptivo from launching.
    let get_window_id = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            b"_AXUIElementGetWindow\0".as_ptr().cast(),
        )
    };
    if get_window_id.is_null() {
        return Err(AppError::Other(
            "macOS did not provide the window ID lookup function".into(),
        ));
    }
    let get_window_id: AxWindowId = unsafe { std::mem::transmute(get_window_id) };

    let count = unsafe { CFArrayGetCount(windows.0) };
    let mut chosen = None;
    let mut lookup_error = None;
    for index in 0..count {
        let ax_window = unsafe { CFArrayGetValueAtIndex(windows.0, index) };
        if ax_window.is_null()
            || unsafe { CFGetTypeID(ax_window) } != unsafe { AXUIElementGetTypeID() }
        {
            continue;
        }
        let mut ax_window_id = 0;
        let result = unsafe { get_window_id(ax_window, &mut ax_window_id) };
        if result != AX_SUCCESS {
            lookup_error = Some(result);
            continue;
        }
        if ax_window_id == window_id {
            if chosen.replace(ax_window).is_some() {
                return Err(AppError::Other(
                    "The selected window ID was reported more than once".into(),
                ));
            }
        }
    }
    let chosen = chosen.ok_or_else(|| {
        if let Some(error) = lookup_error {
            AppError::Other(format!(
                "Could not read the selected window ID from Accessibility (AX error {error})"
            ))
        } else {
            AppError::InvalidSource(
                "Selected window is unavailable in its app's Accessibility window list".into(),
            )
        }
    })?;

    let action = CFString::new("AXRaise");
    let result = unsafe { AXUIElementPerformAction(chosen, action.as_concrete_TypeRef().cast()) };
    if result != AX_SUCCESS && wait_until_front(window_id, pid)? {
        return Ok(());
    }
    if let Err(error) = set_true(chosen, "AXMain") {
        if wait_until_front(window_id, pid)? {
            return Ok(());
        }
        return Err(error);
    }
    if let Err(error) = set_true(app.0, "AXFrontmost") {
        if wait_until_front(window_id, pid)? {
            return Ok(());
        }
        return Err(error);
    }
    window_prepare::activate_app(pid);
    if wait_until_front(window_id, pid)? {
        Ok(())
    } else if result != AX_SUCCESS {
        Err(AppError::Other(format!(
            "Could not raise the selected window (AX error {result})"
        )))
    } else {
        Err(AppError::Other(
            "The selected window did not become frontmost".into(),
        ))
    }
}

fn wait_until_front(window_id: u32, pid: i32) -> AppResult<bool> {
    for attempt in 0..5 {
        if window_prepare::selected_window_is_front(window_id, pid)? {
            return Ok(true);
        }
        if attempt < 4 {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    Ok(false)
}

fn attribute(element: CfRef, name: &str) -> AppResult<OwnedCf> {
    let key = CFString::new(name);
    let mut value: CfRef = ptr::null();
    let result = unsafe {
        AXUIElementCopyAttributeValue(element, key.as_concrete_TypeRef().cast(), &mut value)
    };
    if result == AX_SUCCESS && !value.is_null() {
        Ok(OwnedCf(value))
    } else {
        Err(AppError::Other(format!(
            "Could not read {name} from the selected app (AX error {result})"
        )))
    }
}

fn set_true(element: CfRef, name: &str) -> AppResult<()> {
    let key = CFString::new(name);
    let result = unsafe {
        AXUIElementSetAttributeValue(
            element,
            key.as_concrete_TypeRef().cast(),
            CFBoolean::true_value().as_concrete_TypeRef().cast(),
        )
    };
    if result == AX_SUCCESS {
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "Could not set {name} on the selected app or window (AX error {result})"
        )))
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    static kAXTrustedCheckOptionPrompt: CfRef;
    fn AXIsProcessTrustedWithOptions(options: CfRef) -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> CfRef;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementCopyAttributeValue(element: CfRef, name: CfRef, value: *mut CfRef) -> i32;
    fn AXUIElementSetAttributeValue(element: CfRef, name: CfRef, value: CfRef) -> i32;
    fn AXUIElementPerformAction(element: CfRef, action: CfRef) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: CfRef);
    fn CFGetTypeID(value: CfRef) -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(array: CfRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CfRef, index: isize) -> CfRef;
}
