// Memory trimming for the two webviews.
//
// Most of Coucou's footprint is WebView2 (the Edge engine), not Rust. Two things
// help without changing how the app behaves:
//
// * WebView2's "memory usage target level": set to Low, the engine trims its
//   working set and frees caches. We switch the island to Low while it is folded
//   away and back to Normal when it opens, and the settings window to Low while
//   it is closed.
// * The settings page is unloaded (about:blank) while its window is closed. The
//   window itself stays alive — see create_settings_window for why it must — and
//   the page is reloaded from the URL it had when it is opened again.

use std::sync::Mutex;

use tauri::{Url, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};
use windows_core::Interface;

/// Where the settings page lives, remembered before it is blanked.
static SETTINGS_URL: Mutex<Option<Url>> = Mutex::new(None);

/// Asks WebView2 to keep this webview's memory low (or back to normal).
/// Needs runtime 1.0.2210+; silently does nothing on older ones.
pub fn set_low_memory(win: &WebviewWindow, low: bool) {
    let _ = win.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let Ok(core19) = core.cast::<ICoreWebView2_19>() else { return };
        let level = if low {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        };
        let _ = core19.SetMemoryUsageTargetLevel(level);
    });
}

/// Settings window closed: drop its page and let the engine trim.
pub fn unload_settings(win: &WebviewWindow) {
    if let Ok(current) = win.url() {
        if current.scheme() != "about" {
            *SETTINGS_URL.lock().unwrap() = Some(current);
        }
    }
    if let Ok(blank) = "about:blank".parse::<Url>() {
        let _ = win.navigate(blank);
    }
    set_low_memory(win, true);
}

/// Settings window opening: bring the page back if it was unloaded.
pub fn reload_settings(win: &WebviewWindow) {
    set_low_memory(win, false);
    let blank = win.url().map(|u| u.scheme() == "about").unwrap_or(false);
    if blank {
        if let Some(url) = SETTINGS_URL.lock().unwrap().clone() {
            let _ = win.navigate(url);
        }
    }
}
