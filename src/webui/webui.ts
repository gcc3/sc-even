// Web-side UI rendered into #app:
//   - a header with a Login button and a settings (gear) icon
//   - a Login modal to set/save username + password (also logs `sc` in)
//   - a Settings modal for the OpenAI API key, speech-to-text language, and theme
//   - a terminal panel that prints the `sc` (simple-ai-chat CLI) output stream,
//     fed by a prompt-style input line and by finished voice transcripts
//
// This is a plain terminal view: output is printed as-is, not split into chat
// bubbles. The glasses mirror the exact same text.

import "./styles.css";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { loadSettings } from "../utils/setting";
import { GEAR_SVG, USER_SVG, NEW_CHAT_SVG } from "../assets/icons";
import { setLocale, localeFromLangCode } from "../i18n";
import { userModalHTML, createUserModal } from "./user";
import { settingsModalHTML, createSettingsModal, applyTheme } from "./settings";

// How much the visual viewport has to shrink before we call it the keyboard. Well
// above any chrome the host might slide in or out, well below the shortest iOS
// keyboard, so neither is mistaken for the other.
const KEYBOARD_MIN_SHRINK_PX = 120;

export interface WebUI {
  /** Replace the terminal output with the given text (kept in sync with the glasses). */
  render(text: string): void;
  /** Show or hide the cursor at the end of the terminal output. */
  setCursor(show: boolean): void;
  /** Enable or disable cursor blinking (false = static block). */
  setCursorBlink(blink: boolean): void;
  /** Briefly show a transient message (e.g. a glasses tap arrived). */
  toast(text: string, durationMs?: number): void;
}

export interface WebUIOptions {
  /** User submitted a line in the input box. */
  onSubmit: (text: string) => void;
  /** Input field text changed (fired on every keystroke for live mirroring). */
  onInput: (text: string) => void;
  /** User saved Login credentials. */
  onLogin: (username: string, password: string) => void;
  /** User submitted the register form — sends `:user add` to the server. */
  onRegister: (username: string, email: string, password: string) => void;
  /** User pressed the refresh button to reset the conversation and memory. */
  onRefresh: () => void;
  /** Speech language changed (also fired once with the saved value at startup). */
  onLanguageChange: (language: string) => void;
  /** SC CLI language command to send after login completes (startup only). */
  onLangCommand?: (lang: string) => void;
  /** Cursor blink setting changed (also fired once with the saved value at startup). */
  onCursorBlinkChange: (blink: boolean) => void;
  /** Transcription enabled/disabled (also fired once with the saved value at startup). */
  onTranscriptionChange: (enabled: boolean) => void;
}

export async function createWebUI(bridge: EvenAppBridge, options: WebUIOptions): Promise<WebUI> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app element not found");

  // Load settings and apply locale before building the HTML, so the t() calls in the
  // modal markup below resolve against the right language.
  const settingsRef = { current: await loadSettings(bridge) };
  setLocale(localeFromLangCode(settingsRef.current.language));

  root.innerHTML = `
    <div class="app">
      <header class="app__header">
        <div class="app__actions">
          <button class="bar-btn" data-refresh>${NEW_CHAT_SVG}New chat</button>
          <button class="bar-btn" data-open-login>${USER_SVG}Profile</button>
          <button class="bar-btn" data-open-settings>${GEAR_SVG}Settings</button>
        </div>
      </header>
      <pre class="term" data-term></pre>
      <input class="hidden-input" data-input-field type="text"
             autocomplete="off" enterkeyhint="enter" />
    </div>

    <div class="toast" data-toast></div>

    ${userModalHTML()}
    ${settingsModalHTML()}
  `;

  const termEl = root.querySelector<HTMLPreElement>("[data-term]")!;
  const inputField = root.querySelector<HTMLInputElement>("[data-input-field]")!;
  const toastEl = root.querySelector<HTMLDivElement>("[data-toast]")!;
  let toastTimer = 0; // pending hide timer, so back-to-back toasts don't hide early

  const userModal = createUserModal(root, settingsRef, bridge, {
    onLogin: options.onLogin,
    onRegister: options.onRegister,
  });

  const settingsModal = createSettingsModal(root, settingsRef, bridge, termEl, {
    onLanguageChange: options.onLanguageChange,
    onCursorBlinkChange: options.onCursorBlinkChange,
    onTranscriptionChange: options.onTranscriptionChange,
    onApplyTranslations: () => {
      userModal.applyTranslations();
      settingsModal.applyTranslations();
    },
    onSendCommand: options.onSubmit,
  });

  options.onLanguageChange(settingsRef.current.speechLanguage);
  applyTheme(settingsRef.current.theme);
  termEl.classList.toggle("term--cursor-blink", settingsRef.current.cursorBlink);
  options.onCursorBlinkChange(settingsRef.current.cursorBlink);
  options.onTranscriptionChange(settingsRef.current.transcription);

  // Auto-login at startup if saved credentials exist.
  if (settingsRef.current.username && settingsRef.current.password) {
    options.onLogin(settingsRef.current.username, settingsRef.current.password);
  }

  // Defer the SC CLI language command until after login completes.
  // Always send — empty string means Auto → :lang reset.
  options.onLangCommand?.(settingsRef.current.language);

  // --- input line ---------------------------------------------------------
  // Tap anywhere on the terminal to open the keyboard.
  termEl.addEventListener("click", () => inputField.focus());

  // Submit on the keyboard's Enter/Return key.
  inputField.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const text = inputField.value.trim();
    if (text) options.onSubmit(text);
    inputField.value = "";
    options.onInput("");
  });

  // Mirror each keystroke to the terminal/glasses so the in-progress line shows
  // live (e.g. "gpt-5.5> hello") before it's submitted.
  inputField.addEventListener("input", () => options.onInput(inputField.value));

  // A text input cannot hold a newline: the HTML value sanitization algorithm
  // *strips* them from anything pasted in, which silently glues the last word of
  // one line onto the first word of the next ("第一行第二行"). Flatten them to
  // spaces ourselves instead, so a pasted block at least keeps its word breaks.
  //
  // Flattening rather than preserving, because a real newline could never
  // survive the trip anyway — the sc CLI reads stdin with readline, one line per
  // submission, so an embedded newline arrives as a *second* input (and a line
  // starting with ":" would run as a command). See writeLine in serve.mjs.
  inputField.addEventListener("paste", (e) => {
    const pasted = e.clipboardData?.getData("text") ?? "";
    if (!/[\r\n]/.test(pasted)) return; // single line — let the browser do it
    e.preventDefault();
    const flat = pasted.replace(/\s*[\r\n]+\s*/g, " ").trim();
    const start = inputField.selectionStart ?? inputField.value.length;
    const end = inputField.selectionEnd ?? start;
    inputField.setRangeText(flat, start, end, "end");
    inputField.dispatchEvent(new Event("input")); // setRangeText fires none itself
  });

  // On iOS the on-screen keyboard overlays the page instead of resizing it, so
  // the terminal shrinks to the visible (visual viewport) area and stays readable.
  const appEl = root.querySelector<HTMLDivElement>(".app")!;
  const viewport = window.visualViewport;
  if (viewport) {
    const syncViewport = () => {
      appEl.style.height = `${viewport.height}px`;
      // The keyboard sits over the home-indicator strip while it is up, so the
      // safe-area inset below the terminal stops being a clearance and becomes a
      // gap between the box and the keys. styles.css drops it on this class.
      const keyboardUp = window.innerHeight - viewport.height > KEYBOARD_MIN_SHRINK_PX;
      root.classList.toggle("keyboard-open", keyboardUp);
      termEl.scrollTop = termEl.scrollHeight;
    };
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
  }

  // iOS Safari ignores `user-scalable=no`, so cancel its pinch-zoom gesture
  // events directly. Single-finger scrolling is untouched.
  for (const evt of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(evt, (e) => e.preventDefault(), { passive: false });
  }
  // Block multi-touch pinch on browsers without gesture events.
  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );

  // --- refresh (reset conversation + memory) ------------------------------
  root.querySelector("[data-refresh]")!.addEventListener("click", () => options.onRefresh());

  // --- login modal --------------------------------------------------------
  root.querySelector("[data-open-login]")!.addEventListener("click", () => userModal.open());

  return {
    render(text: string) {
      termEl.textContent = text;
      termEl.scrollTop = termEl.scrollHeight;
    },
    setCursor(show: boolean) {
      termEl.classList.toggle("term--cursor", show);
    },
    setCursorBlink(blink: boolean) {
      termEl.classList.toggle("term--cursor-blink", blink);
    },
    toast(text: string, durationMs = 2000) {
      toastEl.textContent = text;
      toastEl.classList.add("toast--show");
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => toastEl.classList.remove("toast--show"), durationMs);
    },
  };
}
