// Global shortcut: Ctrl+Alt+Space opens the chat ("Ask") from anywhere.
//
// Plain Win32 RegisterHotKey on a thread of its own, so no extra dependency.
// Windows hands the foreground to whoever receives WM_HOTKEY, which is what lets
// the island take keyboard focus even though it never steals it otherwise.

use tauri::{AppHandle, Emitter};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, VK_SPACE,
};
use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

use crate::island::WINDOW_LABEL;

const ASK_ID: i32 = 0xC0C0;
/// Ctrl+Alt+N — quick note into the Obsidian vault.
const NOTE_ID: i32 = 0xC0C1;
const VK_N: u32 = 0x4E;

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        // The hotkey belongs to this thread: WM_HOTKEY lands in its queue.
        let registered = unsafe {
            RegisterHotKey(None, ASK_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_SPACE.0 as u32)
        };
        if let Err(err) = registered {
            crate::log::line(format!(
                "Ctrl+Alt+Space is taken by another app — quick Ask unavailable ({err})"
            ));
            return;
        }
        crate::log::line("quick Ask ready on Ctrl+Alt+Space".to_string());
        let note = unsafe { RegisterHotKey(None, NOTE_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_N) };
        match note {
            Ok(()) => crate::log::line("quick note ready on Ctrl+Alt+N".to_string()),
            Err(err) => crate::log::line(format!("Ctrl+Alt+N is taken by another app ({err})")),
        }

        let mut msg = MSG::default();
        loop {
            let got = unsafe { GetMessageW(&mut msg, None, 0, 0) };
            if got.0 <= 0 {
                break; // WM_QUIT or error
            }
            if msg.message == WM_HOTKEY {
                // Same channel as the tray menu, handled in main.ts.
                match msg.wParam.0 as i32 {
                    ASK_ID => { let _ = app.emit_to(WINDOW_LABEL, "tray", "ask"); }
                    NOTE_ID => { let _ = app.emit_to(WINDOW_LABEL, "tray", "note"); }
                    _ => {}
                }
            }
        }
    });
}
