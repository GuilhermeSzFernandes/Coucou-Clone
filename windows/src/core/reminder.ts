// Google Calendar "new event" link for a note that has a date — used by the
// capture view and the inbox, and written into the note so it works on the
// phone too. The Obsidian plugin keeps an identical copy.

import type { NotePlan } from "./bridge";

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const stamp = (d: Date) => `${ymd(d)}T${pad(d.getHours())}${pad(d.getMinutes())}00`;

export function reminderUrl(plan: NotePlan): string | null {
  const r = plan.lembrete;
  if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.data)) return null;
  const [y, m, d] = r.data.split("-").map(Number);
  let dates: string;
  if (r.hora && /^\d{2}:\d{2}$/.test(r.hora)) {
    const [hh, mm] = r.hora.split(":").map(Number);
    const start = new Date(y, m - 1, d, hh, mm);
    const end = new Date(start.getTime() + (r.duracaoMin || 60) * 60_000);
    dates = `${stamp(start)}/${stamp(end)}`;
  } else {
    const start = new Date(y, m - 1, d);
    dates = `${ymd(start)}/${ymd(new Date(y, m - 1, d + 1))}`; // all day
  }
  const params = new URLSearchParams({
    text: r.titulo || plan.titulo,
    dates,
    details: `${plan.resumo}\n\n(anotado pelo Coucou)`,
    ctz: ZONE,
  });
  // Parentheses would end a Markdown link early.
  const query = params.toString().replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `https://calendar.google.com/calendar/r/eventedit?${query}`;
}

/** The PC's date and time for a moment, in the shape the Rust side expects. */
export function localNow(at: Date = new Date()) {
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    weekday: at.toLocaleDateString("pt-BR", { weekday: "long" }),
  };
}
