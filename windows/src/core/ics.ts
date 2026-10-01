// Minimal iCalendar (.ics) reader for the calendar pill — enough for what Google
// Calendar's "secret address in iCal format" exports:
//
// * VEVENT with DTSTART / DTEND / DURATION / SUMMARY / LOCATION / STATUS / UID;
// * all-day (VALUE=DATE), UTC (…Z), TZID=<IANA zone> and floating times;
// * RRULE with FREQ DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, BYDAY
//   (incl. "2MO" / "-1FR"), BYMONTHDAY, BYMONTH; EXDATE; RECURRENCE-ID overrides.
//
// Times end up as plain JS Dates, so the browser shows them in the PC's zone.

export interface CalEvent {
  uid: string;
  title: string;
  location: string;
  start: Date;
  end: Date;
  allDay: boolean;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface RawEvent {
  uid: string;
  title: string;
  location: string;
  cancelled: boolean;
  start: Date;
  end: Date;
  allDay: boolean;
  rrule: Record<string, string> | null;
  exdates: number[];
  recurrenceId: number | null;
}

// ── Lines and properties ─────────────────────────────────────────────────────

function unfold(text: string): string[] {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

function parseLine(line: string): Prop | null {
  // NAME;PARAM=VAL;PARAM="V:AL":VALUE — the first ':' outside quotes splits.
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

// ── Dates and zones ──────────────────────────────────────────────────────────

/** Offset (ms) of `zone` at the UTC instant `utcMs`. */
function zoneOffset(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - utcMs;
}

/** Wall-clock time in an IANA zone → instant. Two passes handle DST edges. */
function zonedToDate(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): Date {
  const wall = Date.UTC(y, mo, d, h, mi, s);
  try {
    let guess = wall - zoneOffset(wall, zone);
    guess = wall - zoneOffset(guess, zone);
    return new Date(guess);
  } catch {
    return new Date(y, mo, d, h, mi, s); // unknown zone: treat as local
  }
}

function parseDate(prop: Prop): { date: Date; allDay: boolean } | null {
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (m[4] == null || prop.params.VALUE === "DATE") {
    return { date: new Date(y, mo, d), allDay: true };
  }
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (m[7]) return { date: new Date(Date.UTC(y, mo, d, h, mi, s)), allDay: false };
  if (prop.params.TZID) return { date: zonedToDate(y, mo, d, h, mi, s, prop.params.TZID), allDay: false };
  return { date: new Date(y, mo, d, h, mi, s), allDay: false };
}

/** ISO-8601 duration, e.g. PT1H30M or P1D → ms. */
function parseDuration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const n = (i: number) => Number(m[i] ?? 0);
  const ms = ((((n(2) * 7 + n(3)) * 24 + n(4)) * 60 + n(5)) * 60 + n(6)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

// ── Parse ────────────────────────────────────────────────────────────────────

export interface Calendar {
  events: RawEvent[];
}

export function parseIcs(text: string): Calendar {
  const events: RawEvent[] = [];
  let cur: Prop[] | null = null;
  let depth = 0; // VALARM etc. nest inside VEVENT

  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      cur = [];
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (line.startsWith("END:") && depth > 0) {
      depth--;
      continue;
    }
    if (line === "END:VEVENT") {
      const ev = build(cur);
      if (ev) events.push(ev);
      cur = null;
      continue;
    }
    if (depth === 0) {
      const p = parseLine(line);
      if (p) cur.push(p);
    }
  }
  return { events };
}

function build(props: Prop[]): RawEvent | null {
  const one = (n: string) => props.find((p) => p.name === n);
  const startProp = one("DTSTART");
  if (!startProp) return null;
  const start = parseDate(startProp);
  if (!start) return null;

  let end: Date;
  const endProp = one("DTEND");
  const parsedEnd = endProp ? parseDate(endProp) : null;
  const durProp = one("DURATION");
  if (parsedEnd) end = parsedEnd.date;
  else if (durProp) end = new Date(start.date.getTime() + parseDuration(durProp.value));
  else end = new Date(start.date.getTime() + (start.allDay ? 86_400_000 : 0));

  let rrule: Record<string, string> | null = null;
  const rr = one("RRULE");
  if (rr) {
    rrule = {};
    for (const part of rr.value.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0) rrule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
    }
  }

  const exdates: number[] = [];
  for (const p of props.filter((x) => x.name === "EXDATE")) {
    for (const v of p.value.split(",")) {
      const d = parseDate({ ...p, value: v });
      if (d) exdates.push(d.date.getTime());
    }
  }

  const rid = one("RECURRENCE-ID");
  const ridDate = rid ? parseDate(rid) : null;

  return {
    uid: one("UID")?.value ?? "",
    title: unescapeText(one("SUMMARY")?.value ?? "(no title)"),
    location: unescapeText(one("LOCATION")?.value ?? ""),
    cancelled: (one("STATUS")?.value ?? "").toUpperCase() === "CANCELLED",
    start: start.date,
    end,
    allDay: start.allDay,
    rrule,
    exdates,
    recurrenceId: ridDate ? ridDate.date.getTime() : null,
  };
}

// ── Expand into a range ──────────────────────────────────────────────────────

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MAX_STEPS = 5000;

function parseUntil(v: string | undefined): number {
  if (!v) return Infinity;
  const d = parseDate({ name: "UNTIL", params: {}, value: v });
  if (!d) return Infinity;
  // A date-only UNTIL includes that whole day.
  return d.allDay ? d.date.getTime() + 86_400_000 - 1 : d.date.getTime();
}

/** Same wall-clock time as `base`, on another calendar day (local zone). */
function onDay(base: Date, y: number, m: number, d: number): Date {
  return new Date(y, m, d, base.getHours(), base.getMinutes(), base.getSeconds());
}

/** Days of a month matching BYDAY entries such as "MO", "2TU", "-1FR". */
function monthDaysByDay(y: number, m: number, byday: string[]): number[] {
  const days: number[] = [];
  const last = new Date(y, m + 1, 0).getDate();
  for (const spec of byday) {
    const mm = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(spec);
    if (!mm) continue;
    const wd = WEEKDAYS.indexOf(mm[2]);
    const all: number[] = [];
    for (let d = 1; d <= last; d++) if (new Date(y, m, d).getDay() === wd) all.push(d);
    if (!mm[1]) days.push(...all);
    else {
      const n = Number(mm[1]);
      const pick = n > 0 ? all[n - 1] : all[all.length + n];
      if (pick) days.push(pick);
    }
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Every occurrence start of a recurring event, ascending, up to `until`. */
function* occurrences(ev: RawEvent, from: number, until: number): Generator<Date> {
  const r = ev.rrule!;
  const freq = r.FREQ;
  const interval = Math.max(1, Number(r.INTERVAL ?? 1));
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const stop = Math.min(parseUntil(r.UNTIL), until);
  const byday = r.BYDAY ? r.BYDAY.split(",") : [];
  const bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : [];
  const bymonth = r.BYMONTH ? r.BYMONTH.split(",").map((x) => Number(x) - 1) : [];
  const s = ev.start;

  // Without COUNT, nothing before `from` matters: jump close to it instead of
  // walking every period since the series began (a daily event from 2012…).
  let firstStep = 0;
  if (count === Infinity && from > s.getTime()) {
    const DAY = 86_400_000;
    const days = (from - s.getTime()) / DAY;
    if (freq === "DAILY") firstStep = Math.floor(days / interval) - 1;
    else if (freq === "WEEKLY") firstStep = Math.floor(days / 7 / interval) - 1;
    else if (freq === "MONTHLY") firstStep = Math.floor(days / 31 / interval) - 1;
    else if (freq === "YEARLY") firstStep = Math.floor(days / 366 / interval) - 1;
    firstStep = Math.max(0, firstStep);
  }

  let emitted = 0;
  const emit = function* (d: Date) {
    if (d.getTime() < s.getTime()) return;
    emitted++;
    yield d;
  };

  for (let step = firstStep; step < firstStep + MAX_STEPS && emitted < count; step++) {
    let candidates: Date[] = [];
    if (freq === "DAILY") {
      candidates = [onDay(s, s.getFullYear(), s.getMonth(), s.getDate() + step * interval)];
    } else if (freq === "WEEKLY") {
      const weekStart = new Date(s.getFullYear(), s.getMonth(), s.getDate() - s.getDay() + step * interval * 7);
      const days = byday.length ? byday.map((b) => WEEKDAYS.indexOf(b.slice(-2))) : [s.getDay()];
      candidates = [...new Set(days)].sort((a, b) => a - b)
        .map((wd) => onDay(s, weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + wd));
    } else if (freq === "MONTHLY") {
      const first = new Date(s.getFullYear(), s.getMonth() + step * interval, 1);
      const y = first.getFullYear();
      const m = first.getMonth();
      const last = new Date(y, m + 1, 0).getDate();
      let days: number[];
      if (byday.length) days = monthDaysByDay(y, m, byday);
      else if (bymonthday.length) days = bymonthday.map((d) => (d < 0 ? last + d + 1 : d)).filter((d) => d >= 1 && d <= last);
      else days = s.getDate() <= last ? [s.getDate()] : [];
      candidates = days.map((d) => onDay(s, y, m, d));
    } else if (freq === "YEARLY") {
      const y = s.getFullYear() + step * interval;
      const months = bymonth.length ? bymonth : [s.getMonth()];
      for (const m of months) {
        const last = new Date(y, m + 1, 0).getDate();
        const days = byday.length ? monthDaysByDay(y, m, byday) : s.getDate() <= last ? [s.getDate()] : [];
        candidates.push(...days.map((d) => onDay(s, y, m, d)));
      }
    } else {
      yield s; // unsupported FREQ: just the first one
      return;
    }

    for (const c of candidates.sort((a, b) => a.getTime() - b.getTime())) {
      if (c.getTime() > stop || emitted >= count) return;
      yield* emit(c);
    }
    // Past the window: the next period can only be later.
    const firstOfStep = candidates[0];
    if (firstOfStep && firstOfStep.getTime() > stop) return;
  }
}

/** Events (one per occurrence) that overlap [from, to). Sorted by start. */
export function eventsBetween(cal: Calendar, from: Date, to: Date): CalEvent[] {
  const a = from.getTime();
  const b = to.getTime();
  const out: CalEvent[] = [];

  // RECURRENCE-ID entries replace one occurrence of the series with the same UID.
  const overridden = new Map<string, Set<number>>();
  for (const ev of cal.events) {
    if (ev.recurrenceId != null) {
      if (!overridden.has(ev.uid)) overridden.set(ev.uid, new Set());
      overridden.get(ev.uid)!.add(ev.recurrenceId);
    }
  }

  const push = (ev: RawEvent, start: Date) => {
    const duration = ev.end.getTime() - ev.start.getTime();
    const end = new Date(start.getTime() + Math.max(0, duration));
    const overlaps = start.getTime() < b && (end.getTime() > a || (duration === 0 && start.getTime() >= a));
    if (overlaps) {
      out.push({ uid: ev.uid, title: ev.title, location: ev.location, start, end, allDay: ev.allDay });
    }
  };

  for (const ev of cal.events) {
    if (ev.cancelled) continue;
    if (!ev.rrule || ev.recurrenceId != null) {
      push(ev, ev.start);
      continue;
    }
    const skip = new Set(ev.exdates);
    const replaced = overridden.get(ev.uid);
    for (const start of occurrences(ev, a - 31 * 86_400_000, b)) {
      const t = start.getTime();
      if (skip.has(t) || replaced?.has(t)) continue;
      push(ev, start);
    }
  }
  return out.sort((x, y) => x.start.getTime() - y.start.getTime());
}
