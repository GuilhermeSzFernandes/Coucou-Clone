// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";

let nextId = 1;

/** Paperclip (stroke icon). */
const PAPERCLIP =
  "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48";

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply", text: message.content });
  if (!message.sources?.length) return h("div", { class: "chat-row" }, reply);
  // Which notes of the second brain this was answered from — click to open.
  const notes = h("div", { class: "reply-sources" }, h("span", { text: "📓 " }));
  message.sources.slice(0, 6).forEach((s, i) => {
    if (i > 0) notes.append(h("span", { text: " · " }));
    const link = h("button", { class: "src-link", text: s.title, title: "Abrir no Obsidian" });
    link.addEventListener("click", () => void Bridge.noteOpen(s.path));
    notes.append(link);
  });
  return h("div", { class: "chat-row col" }, reply, notes);
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a file or a screenshot). */
function contextChip(label: string, preview?: string): HTMLElement {
  const lead = preview ? h("img", { class: "chip-thumb", src: preview, alt: "" }) : h("i", { class: "chip-dot" });
  const chip = h("div", { class: "chip" }, lead, h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything… (Ctrl+V pastes a screenshot)",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const attach = h(
    "button",
    { class: "attach-btn", title: "Attach a file" },
    svg(PAPERCLIP, 14, { stroke: 2 }),
  );
  const bar = h("div", { class: "chat-bar" }, attach, input, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, log, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    sending = true;
    Sound.play("send");

    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      const reply = await Bridge.chatSend(query, context);
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text, sources: reply.sources });
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  /**
   * The alternative to dragging: pick a file with the Windows dialog. It lands
   * in the inbox like a dropped file and starts a fresh conversation about it.
   */
  async function attachFile() {
    if (sending) return;
    State.isPinned = true; // keep the island open while the dialog is up
    try {
      const path = await Bridge.pickFile();
      if (!path) return;
      const file = await Bridge.ingestFile(path);
      State.droppedFile = { name: file.name, path: file.path };
      State.promptContext = { kind: "file", name: file.name, path: file.path };
      State.chatHistory = [];
      void Bridge.chatReset();
      Sound.play("approve");
    } catch (err) {
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      State.isPinned = false;
      State.notify();
      onHeightChange();
      // The dialog took the keyboard; give it back so typing just works.
      void Bridge.focusWindow(true);
      input.focus();
    }
  }

  /** Ctrl+V with an image on the clipboard (Win+Shift+S, Print Screen…). */
  async function pasteImage(blob: Blob) {
    if (sending) return;
    const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Could not read the pasted image."));
        reader.readAsDataURL(blob);
      });
      const file = await Bridge.savePastedImage(data, ext);
      const previous = State.droppedFile?.preview;
      if (previous) URL.revokeObjectURL(previous);
      const time = new Date().toLocaleTimeString(navigator.language || "pt-BR", { hour: "2-digit", minute: "2-digit" });
      State.droppedFile = { name: `Screenshot ${time}`, path: file.path, preview: URL.createObjectURL(blob) };
      State.promptContext = { kind: "file", name: file.name, path: file.path };
      State.chatHistory = [];
      void Bridge.chatReset();
      Sound.play("approve");
    } catch (err) {
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  input.addEventListener("paste", (e) => {
    const items = (e as ClipboardEvent).clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (!blob) continue;
        e.preventDefault(); // an image, not text: handle it ourselves
        void pasteImage(blob);
        return;
      }
    }
    // Plain text: let the input paste it as usual.
  });

  attach.addEventListener("click", () => void attachFile());
  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file ? `${file.name}|${file.preview ?? ""}` : "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (file) chipRow.append(contextChip(file.name, file.preview));
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      input.placeholder = State.chatHistory.length === 0 ? "Ask me anything…" : "Continue…";
      input.disabled = sending;
      (attach as HTMLButtonElement).disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
