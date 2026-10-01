// Media pill — what is playing right now, through Windows' own media controls
// (Global System Media Transport Controls: the same panel the volume keys show).
// Works with Spotify, browsers, the Media Player app and anything else that
// publishes to it. Nothing leaves the machine.
//
// A background thread polls once a second while the pill is switched on, and
// emits an `integration` update only when something changed. The cover art is
// sent once per track, as a data: URL, because it is far larger than the rest.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use windows::core::Interface;
use windows_future::IAsyncOperation;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::{DataReader, IInputStream};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::integrations::{emit, enabled, IntegrationUpdate, PAUSED};

pub const ID: &str = "integration_media";

/// Biggest cover we forward to the island. Larger ones are skipped.
const MAX_ART_BYTES: u64 = 2 * 1024 * 1024;

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        // WinRT needs an apartment on this thread.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };

        let mut manager: Option<Manager> = None;
        let mut last_state = String::new();
        let mut last_track = String::new();

        loop {
            if PAUSED.load(std::sync::atomic::Ordering::Relaxed) || !enabled(&app, ID) {
                // Forget what was shown, so switching back on repaints at once.
                last_state.clear();
                last_track.clear();
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }

            if manager.is_none() {
                manager = Manager::RequestAsync().and_then(|op| op.get()).ok();
            }
            let session = manager.as_ref().and_then(|m| m.GetCurrentSession().ok());

            let (mut data, track) = match session.as_ref().and_then(read_session) {
                Some(found) => found,
                None => (json!({ "active": false }), String::new()),
            };

            let state = data.to_string();
            let track_changed = track != last_track;
            if state != last_state || track_changed {
                if track_changed {
                    // Only now does the (large) cover travel to the island.
                    let art = session.as_ref().and_then(read_art);
                    data["art"] = art.map(Value::String).unwrap_or(Value::Null);
                    last_track = track;
                }
                last_state = state;
                emit(&app, IntegrationUpdate { id: ID, data, error: None, event: None });
            }

            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Title, artist, app and play state. The second value identifies the track.
fn read_session(session: &Session) -> Option<(Value, String)> {
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
    let app = session
        .SourceAppUserModelId()
        .map(|s| friendly_app(&s.to_string()))
        .unwrap_or_default();
    let playing = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .map(|status| status == Status::Playing)
        .unwrap_or(false);

    let track = format!("{app}\u{1f}{title}\u{1f}{artist}");
    Some((
        json!({ "active": true, "title": title, "artist": artist, "app": app, "playing": playing }),
        track,
    ))
}

/// The cover as a data: URL, or None when the player provides none.
fn read_art(session: &Session) -> Option<String> {
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let reference = props.Thumbnail().ok()?;
    let stream = reference.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > MAX_ART_BYTES {
        return None;
    }
    let content_type = stream
        .ContentType()
        .map(|s| s.to_string())
        .ok()
        .filter(|s| s.starts_with("image/"))
        .unwrap_or_else(|| "image/png".to_string());

    let input: IInputStream = stream.cast().ok()?;
    let reader = DataReader::CreateDataReader(&input).ok()?;
    // LoadAsync returns a DataReaderLoadOperation; wait on it as the plain
    // IAsyncOperation<u32> it implements.
    let load: IAsyncOperation<u32> = reader.LoadAsync(size as u32).ok()?.cast().ok()?;
    let loaded = load.get().ok()?;
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes).ok()?;

    Some(format!("data:{content_type};base64,{}", crate::claude::base64_for(&bytes)))
}

/// "Spotify.exe" → "Spotify", "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" → "Media Player".
fn friendly_app(id: &str) -> String {
    let lower = id.to_lowercase();
    let known = [
        ("spotify", "Spotify"),
        ("chrome", "Chrome"),
        ("msedge", "Edge"),
        ("firefox", "Firefox"),
        ("opera", "Opera"),
        ("brave", "Brave"),
        ("zunemusic", "Media Player"),
        ("vlc", "VLC"),
        ("deezer", "Deezer"),
        ("tidal", "TIDAL"),
        ("applemusic", "Apple Music"),
    ];
    for (needle, name) in known {
        if lower.contains(needle) {
            return name.to_string();
        }
    }
    id.trim_end_matches(".exe").to_string()
}

/// Play/pause, next or previous on whatever is playing. Runs on its own thread
/// so a slow player never stalls the island.
pub fn control(action: String) {
    std::thread::spawn(move || {
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let Some(session) = Manager::RequestAsync()
            .and_then(|op| op.get())
            .and_then(|m| m.GetCurrentSession())
            .ok()
        else {
            return;
        };
        let result = match action.as_str() {
            "toggle" => session.TryTogglePlayPauseAsync(),
            "next" => session.TrySkipNextAsync(),
            "previous" => session.TrySkipPreviousAsync(),
            _ => return,
        };
        let _ = result.and_then(|op| op.get());
    });
}
