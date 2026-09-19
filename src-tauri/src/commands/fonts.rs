//! System font discovery for the editor's text clips.
//!
//! macOS already owns the list of fonts that are visible to applications. Use
//! Core Text instead of keeping a second, stale list inside the web editor.

#[cfg(target_os = "macos")]
use core_foundation::array::{CFArray, CFArrayRef};
#[cfg(target_os = "macos")]
use core_foundation::base::TCFType;
#[cfg(target_os = "macos")]
use core_foundation::string::CFString;

#[cfg(target_os = "macos")]
#[link(name = "CoreText", kind = "framework")]
unsafe extern "C" {
    /// Returns a retained CFArray<CFStringRef> of visible font families.
    fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
}

/// Return the font families currently visible to the operating system.
///
/// Core Text returns names in the order intended for a font picker. The
/// non-macOS build keeps the command available so the shared editor can still
/// compile; the editor then keeps its system-font default when no native list
/// is available.
#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let names = unsafe { CTFontManagerCopyAvailableFontFamilyNames() };
        if names.is_null() {
            return Vec::new();
        }

        // Core Text returns a Create-rule reference, so this wrapper releases
        // it exactly once when it leaves scope.
        let names: CFArray<CFString> = unsafe { CFArray::wrap_under_create_rule(names) };
        names.iter().map(|name| name.to_string()).collect()
    }

    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}
