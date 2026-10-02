// Calendar view — the month at a glance, from the Google Calendar pill.
//
// * a dot under every day that has something (up to three);
// * hovering a day lists what it is on the right;
// * clicking a day opens Google Calendar's own "new event" page on that day,
//   so creating and editing stays in Google, where it belongs.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { CalendarStore, type ColoredEvent } from "../island/calendar";
import type { ViewActions, ViewHost } from "./views";

const LOCALE = navigator.language || "pt-BR";
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const fmtMonth = new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric" });
const fmtDay = new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long" });
const fmtTime = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });
const fmtWeekday = new Intl.DateTimeFormat(LOCALE, { weekday: "narrow" });

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Google Calendar's "new event" page, prefilled with 09:00–10:00 that day. */
function newEventUrl(d: Date): string {
  const day = ymd(d);
  return `https://calendar.google.com/calendar/r/eventedit?dates=${day}T090000/${day}T100000&ctz=${encodeURIComponent(ZONE)}`;
}

function dayUrl(d: Date): string {
  return `https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function buildCalendarView(_actions: ViewActions): ViewHost {
  const today = new Date();
  let year = today.getFullYear();
  let month = today.getMonth();
  /** The day the side panel returns to when the mouse leaves the grid. */
  let anchor: Date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  /** The day the side panel is showing right now (hovered, or the anchor). */
  let shown: Date = anchor;
  let lastTry = 0;
  let byDay = new Map<string, ColoredEvent[]>();
  let renderedKey = "";

  const title = h("span", { class: "cal-title" });
  const prev = h("button", { class: "cal-nav", title: "Previous month" }, svg(ICONS.chevronLeft, 11, { stroke: 2 }));
  const next = h("button", { class: "cal-nav", title: "Next month" }, svg(ICONS.chevronRight, 11, { stroke: 2 }));
  const todayBtn = h("button", { class: "cal-today", text: "Today" });
  const reloadBtn = h("button", { class: "cal-nav cal-reload", title: "Reload calendar" }, svg(ICONS.reload, 12));
  const weekdays = h("div", { class: "cal-weekdays" });
  const grid = h("div", { class: "cal-grid" });

  // Sunday-first, like Google Calendar in Brazil.
  for (let i = 0; i < 7; i++) {
    weekdays.append(h("span", { text: fmtWeekday.format(new Date(2026, 1, i + 1)) })); // 1 Feb 2026 is a Sunday
  }

  const sideTitle = h("div", { class: "cal-side-title" });
  const sideList = h("div", { class: "cal-side-list" });
  const addBtn = h("button", { class: "cal-add" }, svg(ICONS.plus, 10), h("span", { text: "New event" }));
  const side = h("div", { class: "cal-side" }, sideTitle, sideList, addBtn);

  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card cal-card" },
      h(
        "div",
        { class: "cal" },
        h(
          "div",
          { class: "cal-month" },
          h("div", { class: "cal-head" }, prev, title, next, h("div", { class: "grow" }), reloadBtn, todayBtn),
          weekdays,
          grid,
        ),
        side,
      ),
    ),
  );

  function load() {
    const first = new Date(year, month, 1);
    const gridStart = new Date(year, month, 1 - first.getDay());
    const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 42);
    byDay = new Map();
    for (const ev of CalendarStore.between(gridStart, gridEnd)) {
      // Spread multi-day events over each day they touch (capped at 42).
      const startDay = new Date(ev.start.getFullYear(), ev.start.getMonth(), ev.start.getDate());
      const last = new Date(ev.end.getTime() - (ev.allDay ? 1 : 0));
      for (let i = 0; i < 42; i++) {
        const d = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + i);
        if (d.getTime() > last.getTime() && i > 0) break;
        if (d < gridStart || d >= gridEnd) continue;
        const k = keyOf(d);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k)!.push(ev);
      }
    }
    return gridStart;
  }

  function renderGrid() {
    const gridStart = load();
    title.textContent = capitalise(fmtMonth.format(new Date(year, month, 1)));
    clear(grid);
    const todayKey = keyOf(new Date());
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const events = byDay.get(keyOf(d)) ?? [];
      const dots = h("span", { class: "cal-dots" });
      // One dot per calendar colour first (so a birthday always shows), then
      // more dots up to three.
      const colors = [...new Set(events.map((e) => e.color))];
      for (const e of events) if (colors.length < 3) colors.push(e.color);
      for (const c of colors.slice(0, Math.min(3, events.length))) {
        dots.append(h("i", { style: `background:${c}` }));
      }
      const cls = ["cal-day"];
      if (d.getMonth() !== month) cls.push("out");
      if (keyOf(d) === todayKey) cls.push("today");
      if (keyOf(d) === keyOf(shown)) cls.push("shown");
      const cell = h(
        "button",
        { class: cls.join(" "), title: "Click to add an event in Google Calendar" },
        h("span", { class: "cal-num", text: String(d.getDate()) }),
        dots,
      );
      cell.addEventListener("mouseenter", () => showDay(d));
      cell.addEventListener("click", () => {
        anchor = d;
        void Bridge.openUrl(newEventUrl(d));
      });
      grid.append(cell);
    }
    showDay(anchor);
  }

  function showDay(d: Date) {
    shown = d;
    for (const cell of grid.children) cell.classList.remove("shown");
    const first = new Date(year, month, 1);
    const index = Math.round(
      (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
        new Date(year, month, 1 - first.getDay()).getTime()) / 86_400_000,
    );
    grid.children[index]?.classList.add("shown");

    sideTitle.textContent = capitalise(fmtDay.format(d));
    clear(sideList);
    const info = State.integrations.integration_calendar;

    if (!CalendarStore.loaded) {
      const msg = info?.error
        ? info.error
        : info?.configured === false
          ? "Paste your Google Calendar secret iCal link in Settings → Integrations."
          : "Loading your calendar…";
      sideList.append(h("div", { class: "cal-empty", text: msg }));
      return;
    }

    const events = byDay.get(keyOf(d)) ?? [];
    if (events.length === 0) {
      sideList.append(h("div", { class: "cal-empty", text: "Nothing scheduled." }));
      for (const e of CalendarStore.errors) sideList.append(h("div", { class: "cal-empty warn", text: e }));
      return;
    }
    for (const ev of events.slice(0, 5)) {
      const when = ev.allDay ? "All day" : `${fmtTime.format(ev.start)}–${fmtTime.format(ev.end)}`;
      sideList.append(
        h(
          "button",
          {
            class: "cal-event",
            title: [ev.calendar, ev.location].filter(Boolean).join(" · ") || ev.title,
            style: `border-left-color:${ev.color};background:${ev.color}1f`,
            onclick: () => void Bridge.openUrl(dayUrl(d)),
          },
          h("span", { class: "cal-event-time", text: when }),
          h("span", { class: "cal-event-title", text: ev.title }),
        ),
      );
    }
    if (events.length > 5) {
      sideList.append(h("div", { class: "cal-empty", text: `+${events.length - 5} more` }));
    }
    for (const e of CalendarStore.errors) sideList.append(h("div", { class: "cal-empty warn", text: e }));
  }

  prev.addEventListener("click", () => {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    anchor = new Date(year, month, 1);
    renderedKey = "";
    sync();
  });
  next.addEventListener("click", () => {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
    anchor = new Date(year, month, 1);
    renderedKey = "";
    sync();
  });
  todayBtn.addEventListener("click", () => {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth();
    anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    renderedKey = "";
    sync();
  });
  addBtn.addEventListener("click", () => void Bridge.openUrl(newEventUrl(shown)));
  reloadBtn.addEventListener("click", () => {
    lastTry = Date.now();
    void CalendarStore.refresh(true);
  });
  // Leaving the grid goes back to the day that was last shown, not a blank.
  grid.addEventListener("mouseleave", () => showDay(anchor));

  function sync() {
    reloadBtn.classList.toggle("spinning", CalendarStore.loading);
    // First open (or a link just pasted in Settings): try to load, at most
    // every 30 s so a missing link cannot turn into a request loop.
    if (!CalendarStore.loaded && !CalendarStore.loading && Date.now() - lastTry > 30_000) {
      lastTry = Date.now();
      void CalendarStore.refresh(true);
    }
    const info = State.integrations.integration_calendar;
    const key = `${year}-${month}-${CalendarStore.version}-${info?.error ?? ""}-${info?.configured}`;
    if (key === renderedKey) return;
    renderedKey = key;
    renderGrid();
  }

  return { el, sync };
}
