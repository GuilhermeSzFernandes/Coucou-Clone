// Calendar pill — Google Calendar through its secret iCal address.
//
// Rust downloads the feed (the link lives in the Credential Manager); parsing
// happens here, so times land in the PC's own zone. Refreshed every 15 minutes
// while the pill is switched on, and on demand when the calendar view opens.

import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { eventsBetween, parseIcs, type CalEvent, type Calendar } from "../core/ics";

export const CALENDAR_ID = "integration_calendar";
const KEY = "gcal-ics-url";
const REFRESH_MS = 15 * 60 * 1000;

let cal: Calendar | null = null;
let loading = false;
/** Bumped on every successful load, so views know to redraw. */
let version = 0;

function enabled(): boolean {
  return State.settings.activeIntegrations.includes(CALENDAR_ID);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Pill data: today's count and the next few events within a week. */
function publish() {
  if (!cal) return;
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const week = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);

  const todays = eventsBetween(cal, today, tomorrow);
  const upcoming = eventsBetween(cal, now, week)
    .filter((e) => e.allDay || e.end.getTime() > now.getTime())
    .slice(0, 3)
    .map((e) => ({ title: e.title, start: e.start.getTime(), allDay: e.allDay }));

  const previous = State.integrations[CALENDAR_ID];
  State.integrations[CALENDAR_ID] = {
    data: { loaded: true, today: todays.length, upcoming },
    error: null,
    loaded: true,
    configured: previous?.configured ?? true,
  };
  State.notify();
}

export const CalendarStore = {
  get loaded(): boolean {
    return cal != null;
  },
  get loading(): boolean {
    return loading;
  },
  get version(): number {
    return version;
  },

  between(from: Date, to: Date): CalEvent[] {
    return cal ? eventsBetween(cal, from, to) : [];
  },

  async refresh(force = false) {
    if (loading || (!force && !enabled())) return;
    const configured = (await Bridge.secretPresent(KEY)) ?? false;
    const previous = State.integrations[CALENDAR_ID];
    if (!configured) {
      State.integrations[CALENDAR_ID] = { data: {}, error: null, loaded: false, configured: false };
      State.notify();
      return;
    }
    loading = true;
    State.notify();
    try {
      const text = await Bridge.calendarFetch();
      cal = parseIcs(text);
      version++;
      State.integrations[CALENDAR_ID] = { data: {}, error: null, loaded: true, configured: true };
      publish();
    } catch (err) {
      State.integrations[CALENDAR_ID] = {
        data: previous?.data ?? {},
        error: String(err).replace(/^Error:\s*/, ""),
        loaded: previous?.loaded ?? false,
        configured: true,
      };
    } finally {
      loading = false;
      State.notify();
    }
  },
};

export function initCalendar() {
  window.setTimeout(() => void CalendarStore.refresh(), 3000);
  window.setInterval(() => void CalendarStore.refresh(), REFRESH_MS);
  // "Next up" goes stale as time passes even when the feed does not change.
  window.setInterval(publish, 60_000);
}
