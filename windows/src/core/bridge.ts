// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),
  /** "Open terminal" → new Windows Terminal tab in the folder (VS Code / Explorer as fallback). */
  openTerminal: (path: string | null) => call<boolean>("open_terminal", { path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string; sources?: { title: string; path: string }[] }>("chat_send", { query, context }),
  chatReset: () => call<void>("chat_reset"),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Opens the Windows "Open" dialog; null when cancelled. */
  pickFile: () => call<string | null>("pick_file"),
  /** Second brain: classify, write, undo, open in Obsidian. */
  noteClassify: (text: string, now: { date: string; time: string; weekday: string }) =>
    callOrThrow<NotePlan>("note_classify", { text, now }),
  noteWrite: (
    plan: NotePlan,
    original: string,
    now: { date: string; time: string; weekday: string },
    calendarUrl: string | null = null,
  ) => callOrThrow<NoteWritten>("note_write", { plan, original, now, calendarUrl }),
  /** Meu dia: pending items, tick one off, write and save the daily. */
  todayPending: () => callOrThrow<PendingItem[]>("today_pending"),
  todayDone: (item: PendingItem) => callOrThrow<void>("today_done", { item }),
  dailyGenerate: (dates: string[], todayLabel: string, calendar: string) =>
    callOrThrow<string>("daily_generate", { dates, todayLabel, calendar }),
  dailySave: (date: string, text: string) => callOrThrow<string>("daily_save", { date, text }),
  /** Claude Code activity of the day (what was asked, what finished) for the daily. */
  activityAppend: (date: string, entry: { time: string; project: string; kind: string; text: string }) =>
    call<void>("activity_append", { date, entry }),

  noteUndo: (written: NoteWritten) => callOrThrow<void>("note_undo", { written }),
  noteOpen: (path: string) => call<boolean>("note_open", { path }),
  notesDefaultVault: () => call<string>("notes_default_vault"),
  /** Rewrites "Perfil (gerado).md" from the latest notes; returns its path. */
  brainRefreshProfile: (date: string) => callOrThrow<string>("brain_refresh_profile", { date }),
  /** Ctrl+V of a screenshot in the chat: saved into the inbox. */
  savePastedImage: (data: string, ext: string) =>
    callOrThrow<DroppedFile>("save_pasted_image", { data, ext }),
  /** Calendar pill: the iCal text behind the secret link (the link stays in Rust). */
  calendarFetch: (slot = 1) => callOrThrow<string>("calendar_fetch", { slot }),
  /** Media pill: play/pause, next, previous on whatever Windows says is playing. */
  mediaControl: (action: "toggle" | "next" | "previous") => call<void>("media_control", { action }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),
};

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

/** How Groq filed a quick note. */
export interface NotePlan {
  area: "Trabalho" | "TCC" | "Pessoal";
  tipo: string;
  titulo: string;
  resumo: string;
  entidades: { nome: string; tipo: string }[];
  tags: string[];
  chamado: string | null;
  lembrete: { titulo: string; data: string; hora: string | null; duracaoMin: number } | null;
}

/** A to-do from the vault: a note with a due date, or a `- [ ]` line. */
export interface PendingItem {
  kind: "note" | "task";
  title: string;
  path: string;
  line: number;
  text: string;
  due: string | null;
  area: string | null;
}

/** What one save wrote into the vault (enough to undo it). */
export interface NoteWritten {
  path: string;
  relative: string;
  created: string[];
  dailyPath: string;
  dailyLine: string;
}

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
