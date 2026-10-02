// Pomodoro pill — 25 min focus, 5 min break, a 15 min break after every fourth
// focus. Lives entirely in the island: no network, nothing stored.
//
// The card re-renders from State.integrations like every other pill, so the
// timer simply publishes its state there once a second while it runs.

import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

export const POMODORO_ID = "integration_pomodoro";

export type PomodoroPhase = "focus" | "break" | "long";

const DURATION: Record<PomodoroPhase, number> = {
  focus: 25 * 60,
  break: 5 * 60,
  long: 15 * 60,
};

let phase: PomodoroPhase = "focus";
let running = false;
let endsAt = 0;
let remaining = DURATION.focus;
/** Focus sessions finished today (since the app started). */
let done = 0;
let timer: number | null = null;
let island: Island | null = null;

/** While the timer runs, the compact island stays up so the countdown is seen. */
function holdIsland(on: boolean) {
  if (!island) return;
  island.fsm.timerHold = on;
  if (on) island.reveal(); // from hidden only; never closes an open island
}

function publish() {
  State.integrations[POMODORO_ID] = {
    data: { phase, running, remaining, done, total: DURATION[phase] },
    error: null,
    loaded: true,
    configured: true,
  };
  const task = State.tasks.find((t) => t.id === POMODORO_ID);
  if (task) task.state = running && phase === "focus" ? "working" : "idle";
  State.notify();
}

function stopTimer() {
  if (timer != null) window.clearInterval(timer);
  timer = null;
}

function tick() {
  remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
  if (remaining === 0) finish(true);
  else publish();
}

/** Ends the current phase and lines up the next one, paused. */
function finish(announce: boolean) {
  stopTimer();
  running = false;
  holdIsland(false);
  if (phase === "focus") {
    done += 1;
    phase = done % 4 === 0 ? "long" : "break";
  } else {
    phase = "focus";
  }
  remaining = DURATION[phase];

  if (announce) {
    Sound.play("finish");
    const task = State.tasks.find((t) => t.id === POMODORO_ID);
    if (task && State.focusId !== POMODORO_ID) task.pillBadge = "finished";
    island?.reveal();
  }
  publish();
}

export const Pomodoro = {
  start() {
    if (running) return;
    running = true;
    endsAt = Date.now() + remaining * 1000;
    stopTimer();
    timer = window.setInterval(tick, 1000);
    Sound.play("tick");
    holdIsland(true);
    publish();
  },

  pause() {
    if (!running) return;
    remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    running = false;
    stopTimer();
    holdIsland(false);
    publish();
  },

  toggle() {
    if (running) Pomodoro.pause();
    else Pomodoro.start();
  },

  /** Back to a fresh 25 min focus. */
  reset() {
    stopTimer();
    running = false;
    holdIsland(false);
    phase = "focus";
    remaining = DURATION.focus;
    publish();
  },

  /** Jump to the next phase without waiting. */
  skip() {
    finish(false);
  },
};

export function initPomodoro(owner: Island) {
  island = owner;
  publish();
}
