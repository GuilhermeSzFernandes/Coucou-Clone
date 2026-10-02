// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { initPomodoro } from "./island/pomodoro";
import { CalendarStore, initCalendar } from "./island/calendar";
import { somethingForToday } from "./views/today";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "ask":
        // Ctrl+Alt+Space: straight into the chat, keyboard ready.
        setPaused(false);
        island.openAsk();
        break;
      case "note":
        // Ctrl+Alt+N: quick note into the Obsidian vault.
        setPaused(false);
        island.openAsk("capture");
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
    CalendarStore.settingsChanged(); // pill switched on, a link or a colour changed
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);
  initPomodoro(island);
  initCalendar();

  // Morning summary: the first time the PC is on after 7:00 each day, "Meu
  // dia" opens for 12 s — if anything is due or scheduled. Checked every 5 min,
  // so it also works on a PC that stayed on overnight.
  const morning = async () => {
    if (!State.settings.morningSummary || !State.settings.notesVault) return;
    const now = new Date();
    if (now.getHours() < 7 || now.getHours() >= 12) return;
    const day = now.toDateString();
    let last = "";
    try { last = localStorage.getItem("coucou.morning") ?? ""; } catch { /* storage off */ }
    if (last === day) return;
    if (!(await somethingForToday())) return;
    try { localStorage.setItem("coucou.morning", day); } catch { /* storage off */ }
    island.flashView("today", 12_000);
  };
  window.setTimeout(() => void morning(), 25_000);
  window.setInterval(() => void morning(), 5 * 60_000);

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
