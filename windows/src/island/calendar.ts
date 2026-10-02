// Calendar pill — Google Calendar (or any calendar) through secret iCal links.
//
// Settings → Calendars holds up to eight calendars, each with a name and a
// colour; their links live in the Credential Manager, one key per slot. Rust
// downloads a feed, parsing happens here so times land in the PC's own zone.
// Feeds reload every 15 minutes, when a link changes, and on the reload button;
// a colour or name change only repaints.

import { Bridge } from "../core/bridge";
import { DEFAULT_CALENDARS, State, type CalendarSource } from "../core/state";
import { eventsBetween, parseIcs, type CalEvent, type Calendar } from "../core/ics";

export const CALENDAR_ID = "integration_calendar";
export const MAX_CALENDARS = 8;
const REFRESH_MS = 15 * 60 * 1000;

/** Credential Manager key of a slot. Slot 1 keeps its original name. */
export function calendarKey(slot: number): string {
  return slot === 1 ? "gcal-ics-url" : `gcal-ics-url-${slot}`;
}

/** An occurrence plus the calendar it came from. */
export type ColoredEvent = CalEvent & { color: string; calendar: string };

const cals = new Map<number, Calendar>();
/** One line per calendar that failed, shown without hiding the others. */
let errors: string[] = [];
let loading = false;
/** Bumped whenever what is shown may have changed, so views redraw. */
let version = 0;
/** Slots + link revisions last fetched; a change means "download again". */
let fetchedSignature = "";

function sources(): CalendarSource[] {
  const list = State.settings.calendars;
  return Array.isArray(list) && list.length ? list : DEFAULT_CALENDARS;
}

function signature(): string {
  return sources().map((c) => `${c.slot}:${c.rev ?? 0}`).join("|");
}

function enabled(): boolean {
  return State.settings.activeIntegrations.includes(CALENDAR_ID);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function merged(from: Date, to: Date): ColoredEvent[] {
  const out: ColoredEvent[] = [];
  for (const src of sources()) {
    const cal = cals.get(src.slot);
    if (!cal) continue;
    for (const ev of eventsBetween(cal, from, to)) {
      out.push({ ...ev, color: src.color, calendar: src.name });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Pill data: today's count and the next few events within a week. */
function publish() {
  if (cals.size === 0) return;
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const week = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);

  const todays = merged(today, tomorrow);
  const upcoming = merged(now, week)
    .filter((e) => e.allDay || e.end.getTime() > now.getTime())
    .slice(0, 3)
    .map((e) => ({ title: e.title, start: e.start.getTime(), allDay: e.allDay, color: e.color }));

  State.integrations[CALENDAR_ID] = {
    data: { loaded: true, today: todays.length, upcoming, errors },
    error: null,
    loaded: true,
    configured: true,
  };
  State.notify();
}

export const CalendarStore = {
  get loaded(): boolean {
    return cals.size > 0;
  },
  get loading(): boolean {
    return loading;
  },
  get version(): number {
    return version;
  },
  /** Problems with individual calendars, e.g. "Birthdays: link refused (404)". */
  get errors(): string[] {
    return errors;
  },

  between(from: Date, to: Date): ColoredEvent[] {
    return merged(from, to);
  },

  async refresh(force = false) {
    if (loading || (!force && !enabled())) return;
    const list = sources();
    const present = new Map<number, boolean>();
    for (const src of list) present.set(src.slot, (await Bridge.secretPresent(calendarKey(src.slot))) ?? false);
    const previous = State.integrations[CALENDAR_ID];

    // Calendars removed in Settings, or whose link was cleared, disappear.
    const wanted = new Set(list.filter((s) => present.get(s.slot)).map((s) => s.slot));
    for (const slot of [...cals.keys()]) if (!wanted.has(slot)) cals.delete(slot);

    if (wanted.size === 0) {
      errors = [];
      fetchedSignature = signature();
      version++;
      State.integrations[CALENDAR_ID] = { data: {}, error: null, loaded: false, configured: false };
      State.notify();
      return;
    }

    loading = true;
    State.notify();
    const failed: string[] = [];
    for (const src of list) {
      if (!wanted.has(src.slot)) continue;
      try {
        cals.set(src.slot, parseIcs(await Bridge.calendarFetch(src.slot)));
      } catch (err) {
        failed.push(`${src.name || "Calendar"}: ${String(err).replace(/^Error:\s*/, "")}`);
      }
    }
    loading = false;
    errors = failed;
    fetchedSignature = signature();
    version++;

    if (cals.size > 0) {
      publish();
    } else {
      State.integrations[CALENDAR_ID] = {
        data: previous?.data ?? {},
        error: failed[0] ?? "Could not load the calendars",
        loaded: false,
        configured: true,
      };
    }
    State.notify();
  },

  /** Settings changed: reload if a calendar or link changed, else repaint. */
  settingsChanged() {
    if (!enabled()) return;
    if (signature() !== fetchedSignature || cals.size === 0) {
      void CalendarStore.refresh();
    } else {
      version++; // colours or names: same events, new paint
      publish();
    }
  },
};

export function initCalendar() {
  window.setTimeout(() => void CalendarStore.refresh(), 3000);
  window.setInterval(() => void CalendarStore.refresh(), REFRESH_MS);
  // "Next up" goes stale as time passes even when the feeds do not change.
  window.setInterval(publish, 60_000);
}
