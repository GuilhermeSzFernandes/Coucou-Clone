// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus } from "../core/bridge";
import { DEFAULT_CALENDARS, DEFAULT_SETTINGS, type CalendarSource, type Settings } from "../core/state";
import { calendarKey, MAX_CALENDARS } from "../island/calendar";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: hasKey ? "Key saved in the Windows Credential Manager." : "No key yet — the chat needs one." });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? "Key saved in the Windows Credential Manager."
      : "No key yet — the chat needs one.";
    field.placeholder = present ? "••••••••••••  (stored)" : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    feedback,
  );
}

// ── Chat provider + Groq section ──────────────────────────────────────────────

const GROQ_MODELS: [string, string][] = [
  ["openai/gpt-oss-120b", "GPT-OSS 120B"],
  ["openai/gpt-oss-20b", "GPT-OSS 20B (faster)"],
  ["qwen/qwen3.8-27b", "Qwen 3.8 27B (reads images)"],
];

function providerSection(): HTMLElement {
  const select = h("select", {}) as HTMLSelectElement;
  select.append(
    h("option", { value: "anthropic", text: "Claude (Anthropic)" }),
    h("option", { value: "groq", text: "Groq" }),
  );
  select.value = settings.provider ?? "anthropic";
  select.addEventListener("change", () => {
    settings.provider = select.value === "groq" ? "groq" : "anthropic";
    void save();
  });
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Chat" })),
    h("span", {
      class: "hint",
      text: "Which AI answers when you chat or drop a file. Switching starts a new conversation.",
    }),
    h("div", { class: "row" }, h("label", { text: "Provider" }), select),
  );
}

function groqSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: "" });

  const field = h("input", {
    type: "password",
    placeholder: "gsk_...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  function paint(present: boolean) {
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? "Key saved in the Windows Credential Manager."
      : "No Groq key yet. Get one at console.groq.com/keys.";
    field.placeholder = present ? "••••••••••••  (stored)" : "gsk_...";
    clearBtn.style.display = present ? "" : "none";
  }

  async function refresh() {
    paint((await Bridge.secretPresent("groq-api-key")) ?? false);
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("groq-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("groq-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  // Free text with suggestions: Groq's model list changes often.
  const listId = "groq-models";
  const datalist = h("datalist", { id: listId });
  for (const [id, label] of GROQ_MODELS) datalist.append(h("option", { value: id, text: label }));
  const model = h("input", {
    type: "text",
    list: listId,
    style: "flex:1 1 auto;min-width:0",
    spellcheck: "false",
  }) as HTMLInputElement;
  model.value = settings.groqModel ?? "openai/gpt-oss-120b";
  model.addEventListener("change", () => {
    const v = model.value.trim();
    if (!v) return;
    settings.groqModel = v;
    void save();
  });

  paint(hasKey);

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Groq" })),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model, datalist),
    h("span", {
      class: "hint",
      text: "Model ids: console.groq.com/docs/models. Images need a vision model; PDFs are not supported.",
    }),
    feedback,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
  // No key: these two run entirely on this PC.
  { id: "integration_pomodoro", name: "Pomodoro", color: "#EF6461", fields: [] },
  { id: "integration_media", name: "Music", color: "#1DB954", fields: [] },
  // Links, names and colours are in the Calendars section below.
  { id: "integration_calendar", name: "Google Calendar", color: "#4285F4", fields: [] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── Calendars section ─────────────────────────────────────────────────────────

const CAL_PALETTE = ["#4285F4", "#22C55E", "#F4511E", "#A142F4", "#F6BF26", "#E67C73", "#039BE5", "#8E24AA"];

function calendarsSection(present: Record<string, boolean>): HTMLElement {
  if (!Array.isArray(settings.calendars) || settings.calendars.length === 0) {
    settings.calendars = DEFAULT_CALENDARS.map((c) => ({ ...c }));
  }
  const list = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
  const addBtn = h("button", { text: "+ Add calendar" });
  const feedback = h("div", {});

  function render() {
    clear(list);
    for (const cal of settings.calendars) list.append(row(cal));
    addBtn.style.display = settings.calendars.length >= MAX_CALENDARS ? "none" : "";
  }

  function row(cal: CalendarSource): HTMLElement {
    const key = calendarKey(cal.slot);
    const color = h("input", { type: "color", value: cal.color, title: "Colour of this calendar's events" }) as HTMLInputElement;
    color.addEventListener("change", () => {
      cal.color = color.value;
      void save(); // the island repaints, no reload needed
    });

    const name = h("input", { type: "text", value: cal.name, spellcheck: "false", style: "width:110px" }) as HTMLInputElement;
    name.addEventListener("change", () => {
      cal.name = name.value.trim() || "Calendar";
      name.value = cal.name;
      void save();
    });

    const link = h("input", {
      type: "password",
      placeholder: present[key] ? "••••••••  (stored)" : "secret iCal link (…/basic.ics)",
      autocomplete: "off",
      spellcheck: "false",
      style: "flex:1 1 auto;min-width:0",
    }) as HTMLInputElement;
    const dotEl = statusDot(present[key] ?? false);
    const saveBtn = h("button", { text: "Save" });
    saveBtn.addEventListener("click", async () => {
      const value = link.value.trim();
      clear(feedback);
      if (value && !value.startsWith("https://")) {
        feedback.append(h("div", { class: "notice err", text: "The link must start with https://" }));
        return;
      }
      try {
        await Bridge.secretSet(key, value);
        present[key] = value.length > 0;
        link.value = "";
        link.placeholder = value ? "••••••••  (stored)" : "secret iCal link (…/basic.ics)";
        dotEl.style.background = value ? "#22c55e" : "#f4505e";
        cal.rev = (cal.rev ?? 0) + 1; // tells the island to download it again
        void save();
      } catch (err) {
        feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
      }
    });

    const removeBtn = h("button", { class: "danger", text: "Remove", title: "Remove this calendar and forget its link" });
    removeBtn.addEventListener("click", async () => {
      try {
        await Bridge.secretClear(key);
      } catch {
        /* nothing stored */
      }
      present[key] = false;
      settings.calendars = settings.calendars.filter((c) => c.slot !== cal.slot);
      void save();
      render();
    });

    return h("div", { class: "row" }, color, name, link, saveBtn, dotEl, removeBtn);
  }

  addBtn.addEventListener("click", () => {
    const used = new Set(settings.calendars.map((c) => c.slot));
    let slot = 1;
    while (used.has(slot) && slot <= MAX_CALENDARS) slot++;
    if (slot > MAX_CALENDARS) return;
    const colour = CAL_PALETTE.find((c) => !settings.calendars.some((x) => x.color.toLowerCase() === c.toLowerCase()))
      ?? CAL_PALETTE[slot % CAL_PALETTE.length];
    settings.calendars = [...settings.calendars, { slot, name: `Calendar ${settings.calendars.length + 1}`, color: colour, rev: 0 }];
    void save();
    render();
  });

  render();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Calendars" })),
    h("div", {
      class: "hint",
      text: `Up to ${MAX_CALENDARS}. In Google Calendar: ⚙ Settings → pick the calendar → Integrate calendar → Secret address in iCal format. Each calendar's events use its colour. Links are stored in the Windows Credential Manager.`,
    }),
    list,
    h("div", { class: "row" }, addBtn),
    feedback,
  );
}

// ── Notes (Obsidian) section ──────────────────────────────────────────────────

function notesSection(): HTMLElement {
  const path = h("input", {
    type: "text",
    value: settings.notesVault ?? "",
    placeholder: "C:\\Users\\você\\Documents\\Obsidian\\Segundo Cérebro",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  path.addEventListener("change", () => {
    settings.notesVault = path.value.trim();
    void save();
  });

  const useDefault = h("button", { text: "Usar pasta padrão" });
  useDefault.addEventListener("click", async () => {
    const def = (await Bridge.notesDefaultVault()) ?? "";
    if (!def) return;
    path.value = def;
    settings.notesVault = def;
    void save();
  });

  const mode = h("select", {}) as HTMLSelectElement;
  mode.append(
    h("option", { value: "ask", text: "Mostrar um botão para eu confirmar" }),
    h("option", { value: "auto", text: "Abrir o Google Agenda automaticamente" }),
  );
  mode.value = settings.reminderMode ?? "ask";
  mode.addEventListener("change", () => {
    settings.reminderMode = mode.value === "auto" ? "auto" : "ask";
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Notes (Obsidian)" })),
    h("span", {
      class: "hint",
      text: "Ctrl+Alt+N anota qualquer coisa: o Groq classifica (Trabalho, TCC, Pessoal), cria a nota com links e registra no diário. Depois, no Obsidian: Open folder as vault → esta pasta.",
    }),
    h("div", { class: "row" }, h("label", { text: "Pasta do cofre" }), path, useDefault),
    h("div", { class: "row" }, h("label", { text: "Notas com data" }), mode),
    h("div", { class: "row" },
      h("label", { text: "Chat me conhece" }),
      toggle(settings.brainChat !== false, (v) => { settings.brainChat = v; void save(); }),
      h("span", { class: "hint", text: "antes de responder, o chat lê seu perfil, o diário da semana e as notas sobre o assunto" }),
    ),
    profileRow(),
    h("div", { class: "row" },
      h("label", { text: "Resumo da manhã" }),
      toggle(settings.morningSummary !== false, (v) => { settings.morningSummary = v; void save(); }),
      h("span", { class: "hint", text: "uma vez por dia, de manhã, \"Meu dia\" abre sozinho com as pendências e a agenda" }),
    ),
    h("span", {
      class: "hint",
      text: "A classificação usa a chave e o modelo da seção Groq. O texto das notas é enviado ao Groq para isso.",
    }),
  );
}

/** "Update my profile": the AI rewrites Perfil (gerado).md from the notes. */
function profileRow(): HTMLElement {
  const btn = h("button", { text: "Atualizar meu perfil agora" });
  const status = h("span", { class: "hint", text: "o perfil é o resumo de quem você é que o chat sempre lê" });
  let lastPath = "";
  const open = h("button", { text: "Abrir perfil" });
  open.style.display = "none";
  open.addEventListener("click", () => { if (lastPath) void Bridge.noteOpen(lastPath); });
  btn.addEventListener("click", async () => {
    (btn as HTMLButtonElement).disabled = true;
    status.textContent = "Lendo suas notas e escrevendo o perfil…";
    try {
      const d = new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      lastPath = await Bridge.brainRefreshProfile(date);
      status.textContent = "Perfil atualizado. Corrija ou complete à mão no Perfil.md (esse nunca é reescrito).";
      open.style.display = "";
    } catch (err) {
      status.textContent = String(err).replace(/^Error:\s*/, "");
    } finally {
      (btn as HTMLButtonElement).disabled = false;
    }
  });
  return h("div", { class: "row" }, h("label", { text: "Perfil" }), btn, open, status);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Always show the island" }),
      toggle(settings.keepVisible === true, (v) => { settings.keepVisible = v; void save(); }),
      h("span", { class: "hint", text: "the compact island stays on screen when nothing is running" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const hasGroqKey = (await Bridge.secretPresent("groq-api-key")) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  for (let slot = 1; slot <= MAX_CALENDARS; slot++) keys.push(calendarKey(slot));
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    providerSection(),
    apiSection(hasKey),
    groqSection(hasGroqKey),
    integrationsSection(present),
    calendarsSection(present),
    notesSection(),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
