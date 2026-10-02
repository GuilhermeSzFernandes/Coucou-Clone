// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { localNow } from "../core/reminder";
import { State, type ApprovalInfo, type ClaudeSession } from "../core/state";
import type { BotStateName } from "../core/layout";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** Views where the user is talking to the AI — the only thing Claude Code waits behind. */
const AI_VIEWS = new Set<string>(["prompt", "searching", "result", "capture"]);

/** One timer per waiting approval: after 110 s the terminal has taken it over. */
const approvalTimers = new Map<string, number>();

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

// ── Sessions: one per terminal tab ────────────────────────────────────────────
//
// Every hook event carries the session_id of the Claude Code process that sent
// it, so each Windows Terminal tab is its own session: its own project, steps
// and state. The Claude pill shows the selected session (the latest one to do
// something, unless you picked one in the card), and the Mochi wears the most
// urgent state of all of them.

/** Most urgent first: what the Mochi shows when several tabs are busy. */
const PRIORITY: BotStateName[] = [
  "approval", "question", "error", "ratelimit", "working", "searching", "thinking", "finished", "idle",
];

function claudeTask() {
  return State.tasks.find((x) => x.id === CLAUDE_ID);
}

function sessionFor(payload: HookPayload, projectName: string, cwd: string): ClaudeSession {
  const id = payload.session_id || "default";
  let s = State.claudeSessions.find((x) => x.id === id);
  if (!s) {
    s = { id, project: projectName, cwd, steps: [], state: "idle", updatedAt: Date.now() };
    State.claudeSessions.push(s);
  }
  if (cwd) {
    s.cwd = cwd;
    s.project = projectName;
  }
  s.updatedAt = Date.now();
  return s;
}

function step(s: ClaudeSession, text: string) {
  s.steps.push(text);
  if (s.steps.length > 20) s.steps.shift();
}

/** The card follows the latest busy tab, unless you picked one in the last 2 min. */
function follow(s: ClaudeSession, force = false) {
  if (force || !State.selectedSessionId || Date.now() - State.sessionPickedAt > 120_000) {
    State.selectedSessionId = s.id;
  }
}

/** Copies the selected session into the Claude pill, which the views draw. */
export function mirrorSessions() {
  const t = claudeTask();
  if (!t) return;
  // A tab closed without SessionEnd (killed window) would linger forever.
  const stale = Date.now() - 3 * 3600_000;
  State.claudeSessions = State.claudeSessions.filter(
    (x) => x.updatedAt > stale || (x.state !== "idle" && x.state !== "finished"),
  );
  const list = State.claudeSessions;
  if (list.length === 0) {
    clearSession();
    return;
  }
  const selected =
    list.find((x) => x.id === State.selectedSessionId) ??
    [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  State.selectedSessionId = selected.id;
  t.name = selected.project;
  if (selected.cwd) t.sessionCwd = selected.cwd;
  t.steps = selected.steps;
  t.stepIndex = Math.max(0, selected.steps.length - 1);
  let best: BotStateName = "idle";
  for (const s of list) if (PRIORITY.indexOf(s.state) < PRIORITY.indexOf(best)) best = s.state;
  t.state = best;
}

/** Card chips: show another tab's session. */
export function selectSession(id: string) {
  if (!State.claudeSessions.some((s) => s.id === id)) return;
  State.selectedSessionId = id;
  State.sessionPickedAt = Date.now();
  mirrorSessions();
  State.notify();
}

function clearSession() {
  const t = claudeTask();
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "Claude Code";
  t.pillBadge = null;
  t.state = "idle";
  State.selectedSessionId = null;
}

// ── Activity log (feeds the daily) ────────────────────────────────────────────

function logActivity(kind: "prompt" | "done" | "error", s: ClaudeSession, text: string) {
  const now = localNow();
  void Bridge.activityAppend(now.date, { time: now.time, project: s.project, kind, text: text.slice(0, 300) });
}

// ── Approvals: one on screen, the rest queued ─────────────────────────────────

/**
 * Claude Code comes first: an approval, a question, a finished or failed
 * session takes the island over, whatever pill or view is on screen. The one
 * exception is a conversation with the AI: then the pill is badged and the
 * compact island shown, and the card waits for the chat to be closed.
 */
function takeOver(island: Island, view: Parameters<Island["alert"]>[0], badge: "approval" | "finished" | "error") {
  const inChat = State.mode === "expanded" && AI_VIEWS.has(State.view);
  // An approval on screen is never covered by another tab finishing or asking.
  const approvalUp = State.pendingApproval != null && view !== "approval";
  if (inChat || approvalUp) {
    State.setPillBadge(CLAUDE_ID, badge);
    island.reveal();
    return;
  }
  State.setFocus(CLAUDE_ID); // also clears the pill's badge
  island.alert(view);
}

function showApproval(island: Island, info: ApprovalInfo) {
  State.pendingApproval = info;
  const s = State.claudeSessions.find((x) => x.id === info.sessionId);
  if (s) follow(s, true);
  mirrorSessions();
  State.isPinned = true;
  takeOver(island, "approval", "approval");
}

/** After a decision (or a timeout): the next tab waiting, if any. */
export function showNextApproval(island: Island): boolean {
  while (State.approvalQueue.length > 0) {
    const next = State.approvalQueue.shift()!;
    if (approvalTimers.has(next.requestId)) {
      Sound.play("approval");
      showApproval(island, next);
      return true;
    }
  }
  return false;
}

/** The island answered: that tab gets back to work. */
export function approvalDecided(info: ApprovalInfo) {
  const timer = approvalTimers.get(info.requestId);
  if (timer != null) window.clearTimeout(timer);
  approvalTimers.delete(info.requestId);
  const s = State.claudeSessions.find((x) => x.id === info.sessionId);
  if (s && s.state === "approval") s.state = "working";
  mirrorSessions();
}

function startApprovalTimer(island: Island, info: ApprovalInfo) {
  const old = approvalTimers.get(info.requestId);
  if (old != null) window.clearTimeout(old);
  // Coucou answers within 108 s or not at all; after that the terminal has
  // taken over and the card would be lying.
  approvalTimers.set(
    info.requestId,
    window.setTimeout(() => {
      approvalTimers.delete(info.requestId);
      State.approvalQueue = State.approvalQueue.filter((a) => a.requestId !== info.requestId);
      const s = State.claudeSessions.find((x) => x.id === info.sessionId);
      if (s && s.state === "approval") s.state = "working";
      if (State.pendingApproval?.requestId === info.requestId) {
        State.pendingApproval = null;
        if (!showNextApproval(island)) {
          State.isPinned = false;
          island.dropPin();
          State.setPillBadge(CLAUDE_ID, null);
          if (State.view === "approval") island.setView(State.defaultView());
        }
      }
      mirrorSessions();
      State.notify();
    }, 110_000),
  );
}

// ── Events ────────────────────────────────────────────────────────────────────

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");
  const s = sessionFor(payload, projectName, cwd);

  /** Work events only reveal the compact island. */
  const surface = () => {
    if (State.mode === "hidden") island.reveal();
  };

  switch (name) {
    case "SessionStart":
      follow(s);
      surface();
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      s.state = "thinking";
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) {
        step(s, asked.slice(0, 60));
        logActivity("prompt", s, asked);
      }
      follow(s);
      surface();
      break;
    }

    case "PreToolUse": {
      s.state = "working";
      const tool = payload.tool_name ?? "Tool";
      step(s, stepLabel(tool, payload.tool_input ?? {}));
      follow(s);
      surface();
      break;
    }

    case "PostToolUse":
      if (s.state !== "approval") s.state = "working";
      break;

    case "PostToolUseFailure":
      s.state = "working";
      step(s, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        s.state = "ratelimit";
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        s.state = "question";
        step(s, message);
        follow(s, true);
        mirrorSessions();
        Sound.play("question");
        takeOver(island, "question", "approval");
      }
      break;
    }

    case "Stop": {
      s.state = "finished";
      if (payload.message) step(s, payload.message.slice(0, 60));
      logActivity("done", s, payload.message || s.steps[s.steps.length - 1] || "");
      follow(s, true);
      mirrorSessions();
      Sound.play("finish");
      takeOver(island, "finished", "finished");
      const done = s;
      window.setTimeout(() => {
        if (done.state === "finished") done.state = "idle";
        mirrorSessions();
        State.setPillBadge(CLAUDE_ID, null);
        State.notify();
      }, 5200);
      break;
    }

    case "StopFailure":
      s.state = "error";
      logActivity("error", s, payload.message || "a sessão falhou");
      follow(s, true);
      mirrorSessions();
      Sound.play("error");
      takeOver(island, "error", "error");
      break;

    case "SessionEnd":
      State.claudeSessions = State.claudeSessions.filter((x) => x.id !== s.id);
      if (State.selectedSessionId === s.id) State.selectedSessionId = null;
      break;

    case "SubagentStart":
      step(s, "+ subagent");
      break;

    case "SubagentStop":
      step(s, "• subagent done");
      break;

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";
      const tool = payload.tool_name ?? "Tool";
      const info: ApprovalInfo = {
        requestId,
        sessionId: s.id,
        tool,
        command: approvalTarget(tool, payload.tool_input ?? {}),
        project: s.project,
      };
      // The relay's short ack window closes in 800 ms: every request, shown or
      // queued, is acknowledged right away so its terminal keeps waiting.
      if (requestId) void Bridge.approvalAck(requestId);
      s.state = "approval";
      startApprovalTimer(island, info);
      Sound.play("approval");

      // Another tab is already on screen: this one waits its turn instead of
      // being handed back to its terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (!State.approvalQueue.some((a) => a.requestId === requestId)) State.approvalQueue.push(info);
        break;
      }
      showApproval(island, info);
      break;
    }

    default:
      break;
  }
  mirrorSessions();
  State.notify();
}
