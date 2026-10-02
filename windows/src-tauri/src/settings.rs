// Preferences, stored as plain JSON in %APPDATA%\Coucou\settings.json.
// No secret ever lands here — API keys live in the Windows Credential Manager.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// One calendar of the calendar pill. Its secret link is in the Credential
/// Manager under the slot's key; only the name and colour live here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSource {
    pub slot: u8,
    pub name: String,
    pub color: String,
    /// Bumped whenever the link is changed, so the island knows to reload.
    #[serde(default)]
    pub rev: u32,
}

fn default_calendars() -> Vec<CalendarSource> {
    vec![
        CalendarSource { slot: 1, name: "Main".into(), color: "#4285F4".into(), rev: 0 },
        CalendarSource { slot: 2, name: "Birthdays".into(), color: "#22C55E".into(), rev: 0 },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// Which AI answers the chat: "anthropic" (Claude) or "groq".
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Model used when the provider is Groq.
    #[serde(default = "default_groq_model")]
    pub groq_model: String,
    /// Never fold the compact island away, even with nothing running.
    #[serde(default)]
    pub keep_visible: bool,
    /// Calendars of the calendar pill, in display order.
    #[serde(default = "default_calendars")]
    pub calendars: Vec<CalendarSource>,
    /// Second brain: the Obsidian vault folder ("" = not set up yet).
    #[serde(default)]
    pub notes_vault: String,
    /// A note with a date: "ask" shows a button, "auto" opens Google Calendar.
    #[serde(default = "default_reminder_mode")]
    pub reminder_mode: String,
    /// The chat reads the vault (profile, diary, related notes) before answering.
    #[serde(default = "default_true")]
    pub brain_chat: bool,
    /// Once a day, in the morning, "Meu dia" opens by itself.
    #[serde(default = "default_true")]
    pub morning_summary: bool,
}

fn default_true() -> bool {
    true
}

fn default_reminder_mode() -> String {
    "ask".to_string()
}

fn default_provider() -> String {
    "anthropic".to_string()
}

fn default_groq_model() -> String {
    crate::groq::DEFAULT_MODEL.to_string()
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            provider: default_provider(),
            groq_model: default_groq_model(),
            keep_visible: false,
            calendars: default_calendars(),
            notes_vault: String::new(),
            reminder_mode: default_reminder_mode(),
            brain_chat: true,
            morning_summary: true,
        }
    }
}

/// %APPDATA%\Coucou
pub fn config_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Coucou")
}

/// %LOCALAPPDATA%\Coucou — where coucou-hook.exe and the log live.
pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Coucou")
}

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join("coucou-hook.exe")
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
