// Capture view — the second brain's front door (Ctrl+Alt+N, or the 🧠 tab).
//
// Type what happened ("fechei o chamado 4521…", "regra: …", "TCC: …"), Enter,
// and Groq files it: area, type, title, links. The note lands in the Obsidian
// vault; the card shows where, with Open / Undo, and — when the note has a date
// — a ready-made Google Calendar event to confirm (or opens it by itself).

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type NotePlan, type NoteWritten } from "../core/bridge";
import { State } from "../core/state";
import { Sound } from "../core/sound";
import { localNow as now, reminderUrl } from "../core/reminder";
import type { ViewActions, ViewHost } from "./views";

const AREA_COLORS: Record<string, string> = {
  Trabalho: "#4285F4",
  TCC: "#A142F4",
  Pessoal: "#22C55E",
};

const TYPE_LABELS: Record<string, string> = {
  chamado: "Chamado",
  regra: "Regra",
  decisao: "Decisão",
  reuniao: "Reunião",
  estudo: "Estudo",
  ideia: "Ideia",
  lembrete: "Lembrete",
  nota: "Nota",
};

export function buildCaptureView(_actions: ViewActions): ViewHost {
  type Phase = "idle" | "thinking" | "done" | "error";
  let phase: Phase = "idle";
  let lastPlan: NotePlan | null = null;
  let lastWritten: NoteWritten | null = null;
  let errorText = "";
  let renderedKey = "";

  const input = h("textarea", {
    class: "cap-input",
    rows: "2",
    placeholder: "O que aconteceu? Ex.: fechei o chamado 4521 da Acme… · regra: … · TCC: … · lembrar de…",
    spellcheck: "true",
  }) as HTMLTextAreaElement;
  const save = h("button", { class: "send-btn", title: "Salvar (Enter)" }, svg(ICONS.arrowUp, 11));
  const form = h("div", { class: "cap-form" }, input, save);
  const result = h("div", { class: "cap-result" });
  const hint = h("div", { class: "cap-hint", text: "Enter salva · Shift+Enter quebra linha · tudo vai para o seu cofre do Obsidian" });

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card cap-card" }, h("div", { class: "cap" }, form, result, hint)),
  );

  async function submit() {
    const text = input.value.trim();
    if (!text || phase === "thinking") return;
    if (!State.settings.notesVault) {
      phase = "error";
      errorText = "Escolha a pasta do cofre em Settings → Notes (Obsidian).";
      render();
      return;
    }
    phase = "thinking";
    render();
    const when = now();
    try {
      const plan = await Bridge.noteClassify(text, when);
      const written = await Bridge.noteWrite(plan, text, when, reminderUrl(plan));
      lastPlan = plan;
      lastWritten = written;
      phase = "done";
      input.value = "";
      Sound.play("approve");
      const url = reminderUrl(plan);
      if (url && State.settings.reminderMode === "auto") void Bridge.openUrl(url);
    } catch (err) {
      phase = "error";
      errorText = String(err).replace(/^Error:\s*/, "");
      Sound.play("error");
    }
    render();
    input.focus();
  }

  function render() {
    renderedKey = "";
    sync();
  }

  function sync() {
    const key = `${phase}|${errorText}|${lastWritten?.path ?? ""}`;
    if (key === renderedKey) return;
    renderedKey = key;
    clear(result);
    input.disabled = phase === "thinking";
    (save as HTMLButtonElement).disabled = phase === "thinking";

    if (phase === "thinking") {
      result.append(h("div", { class: "cap-status", text: "Organizando no seu cofre…" }));
      return;
    }
    if (phase === "error") {
      result.append(h("div", { class: "cap-status err", text: errorText }));
      return;
    }
    if (phase !== "done" || !lastPlan || !lastWritten) return;

    const plan = lastPlan;
    const written = lastWritten;
    const color = AREA_COLORS[plan.area] ?? "#9398a1";
    const links = h("div", { class: "cap-links" });
    for (const e of plan.entidades.slice(0, 6)) links.append(h("span", { class: "cap-link", text: e.nome }));

    const open = h("button", { class: "link-btn", text: "Abrir no Obsidian" });
    open.addEventListener("click", () => void Bridge.noteOpen(written.path));
    const undo = h("button", { class: "link-btn", style: "color:var(--dim)", text: "Desfazer" });
    undo.addEventListener("click", async () => {
      try {
        await Bridge.noteUndo(written);
        lastWritten = null;
        lastPlan = null;
        phase = "idle";
        render();
      } catch (err) {
        phase = "error";
        errorText = String(err);
        render();
      }
    });
    const actionsRow = h("div", { class: "int-actions" }, open, undo);

    const url = reminderUrl(plan);
    if (url) {
      const r = plan.lembrete!;
      const when = `${r.data.split("-").reverse().join("/")}${r.hora ? ` ${r.hora}` : ""}`;
      const cal = h("button", {
        class: "link-btn",
        style: "color:#8ab4f8",
        text: State.settings.reminderMode === "auto" ? `Agenda aberta (${when})` : `+ Google Agenda (${when})`,
      });
      cal.addEventListener("click", () => void Bridge.openUrl(url));
      actionsRow.append(cal);
    }

    result.append(
      h(
        "div",
        { class: "cap-saved" },
        h("span", { class: "cap-area", style: `background:${color}22;color:${color}`, text: plan.area }),
        h("span", { class: "cap-type", text: TYPE_LABELS[plan.tipo] ?? plan.tipo }),
        h("span", { class: "cap-title", text: plan.titulo }),
      ),
      links,
      actionsRow,
    );
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // typing must not trigger island shortcuts
  });
  save.addEventListener("click", () => void submit());

  return {
    el,
    sync,
    focus() {
      input.focus();
    },
  };
}
