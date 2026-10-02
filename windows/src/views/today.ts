// "Meu dia" — what is due, today's meetings, and the daily written for you.
//
// Left: pending items from the Obsidian vault (overdue, today, the week, no
// date), each with ✓ to tick it off. Right: today's calendar and the
// "Gerar daily" button; the generated text can be copied or saved to the vault.

import { h, clear } from "./dom";
import { Bridge, type PendingItem } from "../core/bridge";
import { State } from "../core/state";
import { Sound } from "../core/sound";
import { CalendarStore } from "../island/calendar";
import { localNow } from "../core/reminder";
import type { ViewActions, ViewHost } from "./views";

const AREA_COLORS: Record<string, string> = { Trabalho: "#4285F4", TCC: "#A142F4", Pessoal: "#22C55E" };
const fmtTime = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

function iso(d: Date): string {
  return localNow(d).date;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** The workday before today (Friday on a Monday). */
function previousWorkday(today: Date): Date {
  let d = addDays(today, -1);
  while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, -1);
  return d;
}

function dueLabel(due: string, todayIso: string, tomorrowIso: string): string {
  if (due === todayIso) return "hoje";
  if (due === tomorrowIso) return "amanhã";
  const [, m, d] = due.split("-");
  return `${d}/${m}`;
}

/** Today's meetings, one line each — also what the daily is told. */
function todaysEvents(): string[] {
  const start = new Date();
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  return CalendarStore.between(day, addDays(day, 1)).map((e) =>
    `${e.allDay ? "dia todo" : fmtTime.format(e.start)} ${e.title}`,
  );
}

export function buildTodayView(_actions: ViewActions): ViewHost {
  let items: PendingItem[] = [];
  let loadedAt = 0;
  let loading = false;
  let loadError = "";
  let daily: { phase: "idle" | "loading" | "done" | "error"; text: string } = { phase: "idle", text: "" };
  let renderedKey = "";

  const list = h("div", { class: "today-list" });
  const side = h("div", { class: "today-side" });
  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card today-card" }, h("div", { class: "today" }, list, side)),
  );

  async function load(force = false) {
    if (loading || (!force && Date.now() - loadedAt < 60_000)) return;
    loading = true;
    try {
      items = (await Bridge.todayPending()) ?? [];
      loadError = "";
    } catch (err) {
      loadError = String(err).replace(/^Error:\s*/, "");
    } finally {
      loading = false;
      loadedAt = Date.now();
      renderedKey = "";
      State.notify();
    }
  }

  async function tick(item: PendingItem) {
    try {
      await Bridge.todayDone(item);
      items = items.filter((x) => !(x.path === item.path && x.line === item.line && x.kind === item.kind));
      Sound.play("approve");
    } catch (err) {
      loadError = String(err).replace(/^Error:\s*/, "");
      void load(true);
    }
    renderedKey = "";
    State.notify();
  }

  async function makeDaily() {
    daily = { phase: "loading", text: "" };
    renderedKey = "";
    State.notify();
    const now = new Date();
    const dates = [iso(previousWorkday(now)), iso(now)];
    const label = now.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" });
    try {
      const text = await Bridge.dailyGenerate(dates, label, todaysEvents().join("\n"));
      daily = { phase: "done", text };
      Sound.play("finish");
    } catch (err) {
      daily = { phase: "error", text: String(err).replace(/^Error:\s*/, "") };
    }
    renderedKey = "";
    State.notify();
  }

  function renderList() {
    clear(list);
    if (!State.settings.notesVault) {
      list.append(h("div", { class: "today-empty", text: "Configure o cofre em Settings → Notes para ver suas pendências." }));
      return;
    }
    if (loadError) list.append(h("div", { class: "today-empty warn", text: loadError }));
    if (loading && items.length === 0) {
      list.append(h("div", { class: "today-empty", text: "Lendo suas pendências…" }));
      return;
    }
    const today = new Date();
    const t = iso(today);
    const tomorrow = iso(addDays(today, 1));
    const week = iso(addDays(today, 7));
    const groups: [string, PendingItem[], string][] = [
      ["Atrasadas", items.filter((i) => i.due && i.due < t), "late"],
      ["Hoje", items.filter((i) => i.due === t), "today"],
      ["Próximos 7 dias", items.filter((i) => i.due && i.due > t && i.due <= week), ""],
      ["Mais tarde", items.filter((i) => i.due && i.due > week), ""],
      ["Sem data", items.filter((i) => !i.due), ""],
    ];
    let shown = 0;
    for (const [title, group, cls] of groups) {
      if (group.length === 0) continue;
      list.append(h("div", { class: `today-group ${cls}`, text: `${title} · ${group.length}` }));
      for (const item of group.slice(0, 8)) {
        shown++;
        const check = h("button", { class: "today-check", title: "Marcar como feito" });
        check.addEventListener("click", (e) => {
          e.stopPropagation();
          void tick(item);
        });
        const name = h("button", { class: "today-title", text: item.title, title: "Abrir no Obsidian" });
        name.addEventListener("click", () => void Bridge.noteOpen(item.path));
        const meta = h("span", { class: "today-due", text: item.due ? dueLabel(item.due, t, tomorrow) : "" });
        const color = AREA_COLORS[item.area ?? ""] ?? "#6b7079";
        list.append(
          h("div", { class: "today-item" }, check, h("i", { class: "today-area", style: `background:${color}` }), name, meta),
        );
      }
    }
    if (shown === 0 && !loading) {
      list.append(h("div", { class: "today-empty", text: "Nada pendente. 🎉" }));
    }
  }

  function renderSide() {
    clear(side);
    if (daily.phase === "done" || daily.phase === "error") {
      side.append(h("div", { class: "today-head", text: "Daily" }));
      side.append(h("div", { class: daily.phase === "error" ? "today-empty warn" : "daily-text", text: daily.text }));
      const row = h("div", { class: "int-actions" });
      if (daily.phase === "done") {
        const copy = h("button", { class: "link-btn", text: "Copiar" });
        copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(daily.text);
            copy.textContent = "Copiado ✓";
          } catch {
            copy.textContent = "Não consegui copiar";
          }
        });
        const save = h("button", { class: "link-btn", text: "Salvar no cofre" });
        save.addEventListener("click", async () => {
          try {
            const path = await Bridge.dailySave(localNow().date, daily.text);
            save.textContent = "Salvo ✓";
            save.onclick = () => void Bridge.noteOpen(path);
          } catch (err) {
            save.textContent = String(err).replace(/^Error:\s*/, "");
          }
        });
        row.append(copy, save);
      }
      const redo = h("button", { class: "link-btn", style: "color:var(--dim)", text: "Refazer" });
      redo.addEventListener("click", () => void makeDaily());
      const back = h("button", { class: "link-btn", style: "color:var(--dim)", text: "Voltar" });
      back.addEventListener("click", () => {
        daily = { phase: "idle", text: "" };
        renderedKey = "";
        State.notify();
      });
      row.append(redo, back);
      side.append(row);
      return;
    }

    side.append(h("div", { class: "today-head", text: "Hoje na agenda" }));
    const events = todaysEvents();
    if (!CalendarStore.loaded) side.append(h("div", { class: "today-empty", text: "Calendário não conectado." }));
    else if (events.length === 0) side.append(h("div", { class: "today-empty", text: "Nenhum compromisso." }));
    for (const e of events.slice(0, 5)) side.append(h("div", { class: "today-event", text: e }));

    const btn = h("button", {
      class: "cal-add",
      style: "margin-top:auto",
      text: daily.phase === "loading" ? "Escrevendo a daily…" : "📋 Gerar daily",
    });
    (btn as HTMLButtonElement).disabled = daily.phase === "loading";
    btn.addEventListener("click", () => void makeDaily());
    side.append(btn);
  }

  return {
    el,
    sync() {
      if (State.view === "today") void load();
      const key = [
        items.length, loading, loadError, daily.phase, daily.text.length,
        CalendarStore.version, State.settings.notesVault,
      ].join("|");
      if (key === renderedKey) return;
      renderedKey = key;
      renderList();
      renderSide();
    },
  };
}

/** For the morning flash: anything worth showing today? */
export async function somethingForToday(): Promise<boolean> {
  try {
    const items = (await Bridge.todayPending()) ?? [];
    const t = localNow().date;
    return items.some((i) => i.due != null && i.due <= t) || todaysEvents().length > 0;
  } catch {
    return false;
  }
}
