// Integration cards shown in the overview's left card — DOM ports of
// IntegrationCardView and friends from IslandViewContent.swift.
//
// Cal.com is the one simplification: macOS shows a three-level calendar
// (month → day → booking); here it is the list of upcoming bookings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";
import { Pomodoro } from "../island/pomodoro";
import { CalendarStore } from "../island/calendar";

/** Same shape as the Swift `timeAgo` computed properties. */
export function timeAgo(value: unknown): string {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  const diff = (Date.now() - date.getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function header(color: string, name: string, kind: string, extra?: Node): HTMLElement {
  const row = h("div", { class: "int-head" }, dot(color, 7), h("b", { text: name }), h("span", { text: kind }));
  if (extra) row.append(extra);
  return row;
}

/** Highlighted first row + plain rows, the layout every list card shares. */
function listRow(accent: string, first: boolean, ...children: Node[]): HTMLElement {
  const row = h("div", { class: first ? "int-row first" : "int-row" }, dot(accent, 5), ...children);
  if (first) row.style.background = `${accent}14`;
  return row;
}

function get(id: string): Record<string, unknown> {
  return (State.integrations[id]?.data ?? {}) as Record<string, unknown>;
}

function arr(id: string, key: string): Record<string, unknown>[] {
  const v = get(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// ── Not configured / idle ─────────────────────────────────────────────────────

const OPEN_URLS: Record<string, string> = {
  integration_resend: "https://resend.com/emails",
  integration_vercel: "https://vercel.com/dashboard",
  integration_github: "https://github.com",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_notion: "https://notion.so",
  integration_calcom: "https://app.cal.com/bookings",
  integration_calendar: "https://calendar.google.com",
};

function idleCard(task: AgentTask, openSettings: () => void): HTMLElement {
  const info = State.integrations[task.id];
  const configured = info?.configured ?? false;
  const error = info?.error ?? null;
  // The Claude Code pill is about hooks, not a key — the macOS wording would be
  // misleading here.
  const missing = task.id === "integration_claude" ? "Hooks not installed" : "Key not configured";
  const label = error ?? (configured ? "Connected · loading…" : missing);
  const statusColor = error || !configured ? "#F4505E" : "#22C55E";

  const actions = h("div", { class: "int-actions" });
  if (task.id === "integration_claude") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}b3`,
        text: "Open terminal",
        onclick: () => void Bridge.openTerminal(task.sessionCwd ?? null),
      }),
    );
  } else if (task.id === "integration_n8n") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Open n8n",
        onclick: () => void Bridge.openN8n(),
      }),
    );
  } else if (OPEN_URLS[task.id]) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: `Open ${task.name}`,
        onclick: () => void Bridge.openUrl(OPEN_URLS[task.id]),
      }),
    );
  }
  if (configured) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: "Refresh",
        onclick: () => void Bridge.refreshIntegration(task.id),
      }),
    );
  } else {
    actions.append(
      h("button", { class: "link-btn", style: "color:#8e939c", text: "Settings…", onclick: openSettings }),
    );
  }

  return h(
    "div",
    { class: "int-card" },
    header(task.color, task.id === "integration_claude" ? "Claude Code" : task.name, "Integration"),
    h("div", { class: "int-status" }, dot(statusColor, 5), h("span", { text: label })),
    actions,
  );
}

// ── Vercel ────────────────────────────────────────────────────────────────────

function vercelCard(onDetail: () => void): HTMLElement {
  const deployments = arr("integration_vercel", "deployments");
  const rows = h("div", { class: "int-rows" });
  deployments.slice(0, 3).forEach((d, i) => {
    const accent = d.state === "READY" ? "#22C55E" : "#F4505E";
    const name = h("span", { class: "int-name", text: String(d.projectName ?? "") });
    const ago = h("span", { class: "int-ago", text: timeAgo(d.createdAt) });
    if (i === 0) {
      const more = h(
        "button",
        { class: "int-more", title: "Details", onclick: onDetail },
        svg(ICONS.ellipsis, 8),
      );
      rows.append(listRow(accent, true, name, ago, more));
    } else {
      rows.append(listRow(accent, false, name, ago));
    }
  });
  return h("div", { class: "int-card" }, header("#7C5CFF", "Vercel", "Deployments"), rows);
}

function vercelDetail(onBack: () => void): HTMLElement {
  const d = arr("integration_vercel", "deployments")[0] ?? {};
  const success = d.state === "READY";
  const accent = success ? "#22C55E" : "#F4505E";
  const status = success ? "Ready" : d.state === "CANCELED" ? "Canceled" : "Error";
  const body = h("div", { class: "int-detail-body" });
  if (d.commitMessage) body.append(h("div", { class: "int-commit", text: String(d.commitMessage) }));
  const meta = h("div", { class: "int-meta" });
  if (d.branch) meta.append(h("span", { text: String(d.branch) }));
  meta.append(h("span", { text: `${timeAgo(d.createdAt)} ago` }));
  body.append(meta);
  if (d.url) {
    body.append(
      h("button", {
        class: "int-link",
        text: String(d.url),
        onclick: () => void Bridge.openUrl(`https://${d.url}`),
      }),
    );
  }
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: String(d.projectName ?? "Deployment") }),
      h("span", { class: "int-badge", style: `color:${accent};background:${accent}24`, text: status }),
    ),
    body,
  );
}

// ── Resend ────────────────────────────────────────────────────────────────────

function resendCard(): HTMLElement {
  const emails = arr("integration_resend", "emails");
  const total = get("integration_resend").total;
  const extra =
    total != null
      ? h("span", { class: "int-total" }, h("i", { class: "pulse" }), h("span", { text: String(total) }))
      : undefined;
  const rows = h("div", { class: "int-rows" });
  emails.slice(0, 3).forEach((e, i) => {
    const delivered = e.lastEvent === "delivered";
    const accent = delivered ? "#22C55E" : "#F4505E";
    const to = Array.isArray(e.to) ? String(e.to[0] ?? "?") : "?";
    const short = to.split("@")[0];
    const cells: Node[] = [
      h("span", { class: "int-name", text: short }),
      h("span", { class: "int-ago", text: timeAgo(e.createdAt) }),
    ];
    if (i === 0 && e.subject) cells.push(h("span", { class: "int-sub", text: String(e.subject) }));
    rows.append(listRow(accent, i === 0, ...cells));
  });
  return h("div", { class: "int-card" }, header("#22C55E", "Resend", "Emails", extra), rows);
}

// ── GitHub ────────────────────────────────────────────────────────────────────

function statRow(icon: string, color: string, label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "int-stat" },
    h("i", { class: "int-stat-icon", style: `color:${color}` }, svg(icon, 10)),
    h("span", { class: "int-stat-label", text: label }),
    h("span", { class: "int-stat-value", text: value }),
  );
}

/** Pull-request glyph (filled, 24×24 like the other icons). */
const PR_ICON =
  "M6 2.5a2.5 2.5 0 0 1 1 4.8v9.4a2.5 2.5 0 1 1-2 0V7.3a2.5 2.5 0 0 1 1-4.8zM18 16.7V9.5c0-1.1-.9-2-2-2h-2.6l1.8 1.8-1.4 1.4L9.6 6.5l4.2-4.2 1.4 1.4-1.8 1.8H16c2.2 0 4 1.8 4 4v7.2a2.5 2.5 0 1 1-2 0z";

function githubCard(): HTMLElement {
  const d = get("integration_github");
  // null = the search failed; show a dash rather than a fake zero.
  const count = (v: unknown) =>
    typeof v === "number" ? (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)) : "—";
  return h(
    "div",
    { class: "int-card" },
    header("#F4505E", "GitHub", "Pull requests"),
    h(
      "div",
      { class: "int-stats" },
      statRow(PR_ICON, "#22C55E", "Open", count(d.prsOpen)),
      statRow(PR_ICON, "#A371F7", "Closed", count(d.prsClosed)),
    ),
  );
}

// ── Pomodoro ──────────────────────────────────────────────────────────────────

const MEDIA_ICONS = {
  play: "M8 5.2v13.6L18.6 12 8 5.2z",
  pause: "M7 5h3.6v14H7V5zm6.4 0H17v14h-3.6V5z",
  next: "M5.5 5.6v12.8l8.8-6.4-8.8-6.4zM15.6 5.6h2.6v12.8h-2.6V5.6z",
  previous: "M18.5 5.6v12.8L9.7 12l8.8-6.4zM5.8 5.6h2.6v12.8H5.8V5.6z",
  reset: "M12 5a7 7 0 1 1-6.6 4.7l1.9.6A5 5 0 1 0 12 7v2.6L8 6l4-3.6V5z",
};

function ctl(icon: string, title: string, onclick: () => void, primary = false): HTMLElement {
  return h(
    "button",
    { class: primary ? "int-ctl primary" : "int-ctl", title, onclick: (e: Event) => { e.stopPropagation(); onclick(); } },
    svg(icon, primary ? 12 : 11),
  );
}

function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function pomodoroCard(): HTMLElement {
  const d = get("integration_pomodoro");
  const phase = String(d.phase ?? "focus");
  const running = d.running === true;
  const remaining = Number(d.remaining ?? 1500);
  const total = Math.max(1, Number(d.total ?? 1500));
  const done = Number(d.done ?? 0);
  const label = phase === "focus" ? "Focus" : phase === "long" ? "Long break" : "Break";
  const color = phase === "focus" ? "#EF6461" : "#22C55E";

  const bar = h("div", { class: "pomo-bar" }, h("i", {
    style: `width:${((total - remaining) / total) * 100}%;background:${color}`,
  }));

  return h(
    "div",
    { class: "int-card" },
    header("#EF6461", "Pomodoro", label, h("span", { class: "int-total", text: `${done} done` })),
    h(
      "div",
      { class: "pomo-row" },
      h("span", { class: "pomo-time", text: mmss(remaining) }),
      h(
        "div",
        { class: "int-ctls" },
        ctl(MEDIA_ICONS.reset, "Reset", () => Pomodoro.reset()),
        ctl(running ? MEDIA_ICONS.pause : MEDIA_ICONS.play, running ? "Pause" : "Start", () => Pomodoro.toggle(), true),
        ctl(MEDIA_ICONS.next, "Skip", () => Pomodoro.skip()),
      ),
    ),
    bar,
  );
}

// ── Music ─────────────────────────────────────────────────────────────────────

/** Cover of the current track (data: URL), kept out of State on purpose. */
let mediaArt: string | null = null;

export function setMediaArt(url: string | null) {
  mediaArt = url;
}

function mediaCard(): HTMLElement {
  const d = get("integration_media");
  if (d.active !== true) {
    return h(
      "div",
      { class: "int-card" },
      header("#1DB954", "Music", "Idle"),
      h("div", { class: "int-status", text: "Nothing playing. Start music in Spotify, a browser or any player." }),
    );
  }
  const playing = d.playing === true;
  const cover = mediaArt
    ? h("img", { class: "media-art", src: mediaArt, alt: "" })
    : h("div", { class: "media-art empty" }, svg(MEDIA_ICONS.play, 14));

  return h(
    "div",
    { class: "int-card" },
    header("#1DB954", "Music", String(d.app || "Playing")),
    h(
      "div",
      { class: "media-row" },
      cover,
      h(
        "div",
        { class: "media-text" },
        h("span", { class: "media-title", text: String(d.title || "Unknown title") }),
        h("span", { class: "media-artist", text: String(d.artist || "") }),
        h(
          "div",
          { class: "int-ctls" },
          ctl(MEDIA_ICONS.previous, "Previous", () => void Bridge.mediaControl("previous")),
          ctl(playing ? MEDIA_ICONS.pause : MEDIA_ICONS.play, playing ? "Pause" : "Play",
            () => void Bridge.mediaControl("toggle"), true),
          ctl(MEDIA_ICONS.next, "Next", () => void Bridge.mediaControl("next")),
        ),
      ),
    ),
  );
}

// ── Google Calendar ───────────────────────────────────────────────────────────

const fmtCalTime = new Intl.DateTimeFormat(navigator.language || "pt-BR", { hour: "2-digit", minute: "2-digit" });
const fmtCalDay = new Intl.DateTimeFormat(navigator.language || "pt-BR", { weekday: "short" });

function calendarCard(hooks: IntegrationCardHooks): HTMLElement {
  const d = get("integration_calendar");
  const today = Number(d.today ?? 0);
  const upcoming = Array.isArray(d.upcoming)
    ? (d.upcoming as { title: string; start: number; allDay: boolean; color?: string }[])
    : [];
  const rows = h("div", { class: "int-rows" });
  const todayKey = new Date().toDateString();
  upcoming.slice(0, 2).forEach((e, i) => {
    const start = new Date(e.start);
    const sameDay = start.toDateString() === todayKey;
    const when = e.allDay ? (sameDay ? "All day" : fmtCalDay.format(start)) : sameDay
      ? fmtCalTime.format(start)
      : `${fmtCalDay.format(start)} ${fmtCalTime.format(start)}`;
    rows.append(listRow(e.color ?? "#4285F4", i === 0,
      h("span", { class: "int-ago", text: when }),
      h("span", { class: "int-name", text: e.title })));
  });
  if (upcoming.length === 0) rows.append(h("div", { class: "int-status", text: "Nothing in the next 7 days." }));

  const open = h("button", {
    class: "link-btn",
    style: "color:#8ab4f8",
    text: "Open calendar",
    onclick: (e: Event) => { e.stopPropagation(); hooks.openCalendar(); },
  });
  const reload = h("button", {
    class: "link-btn",
    style: "color:#8ab4f8",
    text: "Reload",
    onclick: (e: Event) => {
      e.stopPropagation();
      reload.textContent = "Reloading…";
      void CalendarStore.refresh(true);
    },
  });
  return h(
    "div",
    { class: "int-card" },
    header("#4285F4", "Calendar", today === 1 ? "1 today" : `${today} today`),
    rows,
    h("div", { class: "int-actions" }, open, reload),
  );
}

// ── Stripe ────────────────────────────────────────────────────────────────────

function stripeCard(): HTMLElement {
  const d = get("integration_stripe");
  const balance = (Number(d.balance ?? 0) / 100).toFixed(2);
  const currency = String(d.currency ?? "eur").toUpperCase();
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_stripe", "payments")) {
    const success = p.status === "succeeded";
    const accent = success ? "#22C55E" : "#F4505E";
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot(accent, 5),
        h("span", { class: "int-name", text: String(p.description ?? "Payment") }),
        h("span", {
          class: "int-amount",
          style: "color:#22c55e",
          text: `+${(Number(p.amount ?? 0) / 100).toFixed(2)}`,
        }),
        h("span", { class: "int-ago", text: timeAgo(p.createdAt) }),
      ),
    );
  }
  return h(
    "div",
    { class: "int-card" },
    header("#0570DE", "Stripe", "Payments"),
    h("div", { class: "int-balance" }, h("span", { text: balance }), h("i", { text: currency })),
    rows,
  );
}

// ── Notion ────────────────────────────────────────────────────────────────────

function notionCard(): HTMLElement {
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_notion", "pages").slice(0, 3)) {
    rows.append(
      h(
        "button",
        {
          class: "int-page",
          onclick: () => {
            if (typeof p.url === "string") void Bridge.openUrl(p.url);
          },
        },
        p.emoji
          ? h("span", { class: "int-emoji", text: String(p.emoji) })
          : h("i", { class: "int-emoji" }, svg(ICONS.doc, 9)),
        h("span", { class: "int-name", text: String(p.title ?? "Untitled") }),
        h("span", { class: "int-ago", text: timeAgo(p.lastEditedAt) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#E8E8E8", "Notion", "Recent"), rows);
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

function calcomCard(): HTMLElement {
  const bookings = arr("integration_calcom", "bookings")
    .slice()
    .sort((a, b) => new Date(String(a.start)).getTime() - new Date(String(b.start)).getTime());
  const rows = h("div", { class: "int-rows tight" });
  if (bookings.length === 0) {
    rows.append(h("div", { class: "int-empty", text: "No calls scheduled" }));
  }
  for (const b of bookings.slice(0, 3)) {
    const when = new Date(String(b.start));
    const day = when.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
    const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#C9956A", 4),
        h("span", { class: "int-time", text: `${day} ${time}` }),
        h("span", { class: "int-name", text: String(b.title ?? "Meeting") }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#C9956A", "Cal.com", "Schedule"), rows);
}

// ── n8n ───────────────────────────────────────────────────────────────────────

function n8nCard(task: AgentTask, onDetail: () => void, openSettings: () => void): HTMLElement {
  const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
  if (!hasActivity) return idleCard(task, openSettings);
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  return h(
    "div",
    { class: "int-card" },
    header("#F29B38", "n8n", "Workflow"),
    h(
      "div",
      { class: "int-actions" },
      h(
        "button",
        {
          class: "int-pill",
          style: `background:${accent}1a;border-color:${accent}38`,
          onclick: onDetail,
        },
        dot(accent, 5),
        h("span", { class: "int-name", text: task.steps[0] ?? "Workflow" }),
        svg(ICONS.ellipsis, 8),
      ),
    ),
  );
}

function n8nDetail(task: AgentTask, onBack: () => void): HTMLElement {
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  const detail = task.steps[1];
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: task.steps[0] ?? "Workflow" }),
      h("span", {
        class: "int-badge",
        style: `color:${accent};background:${accent}24`,
        text: success ? "Success" : "Failed",
      }),
    ),
    detail
      ? h("pre", { class: "int-detail-text", text: detail })
      : h("div", {
          class: "int-status",
          text: success ? "Completed successfully." : "No error details available.",
        }),
  );
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface IntegrationCardHooks {
  openCalendar(): void;
  detailOpen: boolean;
  openDetail(): void;
  closeDetail(): void;
  openSettings(): void;
}

/** True when this integration has data worth showing instead of the idle card. */
export function hasIntegrationData(id: string): boolean {
  // Local pills: always have something to show, no key involved.
  if (id === "integration_pomodoro" || id === "integration_media") return true;
  const info = State.integrations[id];
  if (!info || info.error) return false;
  switch (id) {
    case "integration_vercel":
      return arr(id, "deployments").length > 0;
    case "integration_resend":
      return arr(id, "emails").length > 0;
    case "integration_github":
      return "prsOpen" in get(id);
    case "integration_stripe":
      return info.loaded;
    case "integration_notion":
      return arr(id, "pages").length > 0;
    case "integration_calcom":
      return info.loaded;
    case "integration_calendar":
      return info.loaded && get(id).loaded === true;
    default:
      return false;
  }
}

export function renderIntegrationCard(task: AgentTask, hooks: IntegrationCardHooks): HTMLElement {
  if (task.id === "integration_n8n") {
    const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
    return hooks.detailOpen && hasActivity
      ? n8nDetail(task, hooks.closeDetail)
      : n8nCard(task, hooks.openDetail, hooks.openSettings);
  }
  if (task.id === "integration_vercel" && hasIntegrationData(task.id)) {
    return hooks.detailOpen ? vercelDetail(hooks.closeDetail) : vercelCard(hooks.openDetail);
  }
  if (!hasIntegrationData(task.id)) return idleCard(task, hooks.openSettings);

  switch (task.id) {
    case "integration_resend":
      return resendCard();
    case "integration_github":
      return githubCard();
    case "integration_stripe":
      return stripeCard();
    case "integration_notion":
      return notionCard();
    case "integration_calcom":
      return calcomCard();
    case "integration_pomodoro":
      return pomodoroCard();
    case "integration_media":
      return mediaCard();
    case "integration_calendar":
      return calendarCard(hooks);
    default:
      return idleCard(task, hooks.openSettings);
  }
}

export { clear };
