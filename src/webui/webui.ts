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
import { loadSettings, saveSettings } from "../utils/settingUtils";
import { GEAR_SVG, USER_SVG, REFRESH_SVG } from "../assets/icons";

// Speech-to-text language choices. "" means auto-detect.
const LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "zh", label: "中文" },
];

// UI themes, applied via the `data-theme` attribute on <html> (see styles.css).
const THEMES: Array<{ value: string; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "terminal", label: "Terminal" },
];

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme || "light";
}

export interface WebUI {
  setStatus(text: string): void;
  /** Replace the terminal output with the given text (kept in sync with the glasses). */
  render(text: string): void;
}

export interface WebUIOptions {
  /** User submitted a line in the input box. */
  onSubmit: (text: string) => void;
  /** Input field text changed (fired on every keystroke for live mirroring). */
  onInput: (text: string) => void;
  /** User saved Login credentials. */
  onLogin: (username: string, password: string) => void;
  /** User pressed the refresh button to reset the conversation and memory. */
  onRefresh: () => void;
  /** Speech language changed (also fired once with the saved value at startup). */
  onLanguageChange: (language: string) => void;
  /** OpenAI API key changed (also fired once with the saved value at startup). */
  onApiKeyChange: (apiKey: string) => void;
  /** sc-bridge server URL changed (also fired once with the saved value at startup). */
  onScServerChange: (baseUrl: string) => void;
}

export async function createWebUI(bridge: EvenAppBridge, options: WebUIOptions): Promise<WebUI> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app element not found");

  const langOptions = LANGUAGES.map((l) => `<option value="${l.value}">${l.label}</option>`).join("");
  const themeOptions = THEMES.map((t) => `<option value="${t.value}">${t.label}</option>`).join("");

  root.innerHTML = `
    <div class="app">
      <header class="app__header">
        <div class="app__title">
          Simple AI
          <span class="app__status" data-status></span>
        </div>
        <div class="app__actions">
          <button class="icon-btn" data-refresh aria-label="Reset conversation">${REFRESH_SVG}</button>
          <button class="icon-btn" data-open-login aria-label="Login">${USER_SVG}</button>
          <button class="icon-btn" data-open-settings aria-label="Settings">${GEAR_SVG}</button>
        </div>
      </header>
      <pre class="term" data-term></pre>
      <form class="term-input" data-input-form>
        <span class="term-input__prompt">&gt;</span>
        <input class="term-input__field" data-input-field type="text"
               placeholder="Type a message…" autocomplete="off" />
        <button class="btn btn--primary" type="submit">enter</button>
      </form>
    </div>

    <div class="modal" data-login-modal>
      <div class="modal__box">
        <h2 class="modal__title">Login</h2>
        <label class="field">
          <span class="field__label">Username</span>
          <input class="field__input" data-username type="text" autocomplete="username" />
        </label>
        <label class="field">
          <span class="field__label">Password</span>
          <input class="field__input" data-password type="password" autocomplete="current-password" />
        </label>
        <div class="modal__actions">
          <button class="btn" data-close-login>Cancel</button>
          <button class="btn btn--primary" data-do-login>Login</button>
        </div>
      </div>
    </div>

    <div class="modal" data-settings-modal>
      <div class="modal__box">
        <h2 class="modal__title">Settings</h2>
        <label class="field">
          <span class="field__label">OpenAI API key</span>
          <input class="field__input" data-api-key type="password"
                 placeholder="sk-…" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field__label">SC server URL</span>
          <input class="field__input" data-sc-server type="url"
                 placeholder="https://your-sc-server.example.com" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field__label">Speech language</span>
          <select class="field__input" data-language>${langOptions}</select>
        </label>
        <label class="field">
          <span class="field__label">Theme</span>
          <select class="field__input" data-theme>${themeOptions}</select>
        </label>
        <div class="modal__actions">
          <span class="modal__saved" data-saved>Saved ✓</span>
          <button class="btn" data-close-settings>Cancel</button>
          <button class="btn btn--primary" data-save>Save</button>
        </div>
      </div>
    </div>
  `;

  const statusEl = root.querySelector<HTMLSpanElement>("[data-status]")!;
  const termEl = root.querySelector<HTMLPreElement>("[data-term]")!;
  const inputForm = root.querySelector<HTMLFormElement>("[data-input-form]")!;
  const inputField = root.querySelector<HTMLInputElement>("[data-input-field]")!;

  const loginModal = document.querySelector<HTMLDivElement>("[data-login-modal]")!;
  const usernameInput = loginModal.querySelector<HTMLInputElement>("[data-username]")!;
  const passwordInput = loginModal.querySelector<HTMLInputElement>("[data-password]")!;

  const settingsModal = document.querySelector<HTMLDivElement>("[data-settings-modal]")!;
  const apiKeyInput = settingsModal.querySelector<HTMLInputElement>("[data-api-key]")!;
  const scServerInput = settingsModal.querySelector<HTMLInputElement>("[data-sc-server]")!;
  const languageSelect = settingsModal.querySelector<HTMLSelectElement>("[data-language]")!;
  const themeSelect = settingsModal.querySelector<HTMLSelectElement>("[data-theme]")!;
  const savedNote = settingsModal.querySelector<HTMLSpanElement>("[data-saved]")!;

  // Hold the persisted settings so saving one modal doesn't clobber the other's fields.
  let settings = await loadSettings(bridge);
  options.onLanguageChange(settings.language);
  options.onApiKeyChange(settings.apiKey);
  options.onScServerChange(settings.scServerBaseUrl);
  applyTheme(settings.theme);

  // --- input line ---------------------------------------------------------
  inputForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputField.value.trim();
    if (text) options.onSubmit(text);
    inputField.value = "";
    options.onInput("");
  });

  // Mirror each keystroke to the terminal/glasses so the in-progress line shows
  // live (e.g. "gpt-5.5> hello") before it's submitted.
  inputField.addEventListener("input", () => options.onInput(inputField.value));

  // On iOS the on-screen keyboard overlays the page instead of resizing it, so
  // the bottom-pinned input gets hidden behind the keyboard. Shrink the app to
  // the visible (visual viewport) area so the input stays above the keyboard.
  const appEl = root.querySelector<HTMLDivElement>(".app")!;
  const viewport = window.visualViewport;
  if (viewport) {
    const syncViewport = () => {
      appEl.style.height = `${viewport.height}px`;
      termEl.scrollTop = termEl.scrollHeight;
    };
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
    // After the keyboard finishes animating in, make sure the field is in view.
    inputField.addEventListener("focus", () => {
      window.setTimeout(() => inputField.scrollIntoView({ block: "end" }), 300);
    });
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
  const openLogin = () => {
    usernameInput.value = settings.username;
    passwordInput.value = settings.password;
    loginModal.classList.add("modal--open");
  };
  const closeLogin = () => loginModal.classList.remove("modal--open");

  root.querySelector("[data-open-login]")!.addEventListener("click", openLogin);
  loginModal.querySelector("[data-close-login]")!.addEventListener("click", closeLogin);
  loginModal.addEventListener("click", (e) => {
    if (e.target === loginModal) closeLogin();
  });

  loginModal.querySelector("[data-do-login]")!.addEventListener("click", async () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    settings = { ...settings, username, password };
    await saveSettings(bridge, settings);
    if (username) options.onLogin(username, password);
    closeLogin();
  });

  // --- settings modal (language only) -------------------------------------
  const openSettings = () => {
    apiKeyInput.value = settings.apiKey;
    scServerInput.value = settings.scServerBaseUrl;
    languageSelect.value = settings.language;
    themeSelect.value = settings.theme;
    savedNote.classList.remove("modal__saved--show");
    settingsModal.classList.add("modal--open");
  };
  const closeSettings = () => {
    applyTheme(settings.theme); // discard any unsaved live preview
    settingsModal.classList.remove("modal--open");
  };

  root.querySelector("[data-open-settings]")!.addEventListener("click", openSettings);
  settingsModal.querySelector("[data-close-settings]")!.addEventListener("click", closeSettings);
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  // Preview the theme immediately; revert to the saved one if the modal is cancelled.
  themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));

  settingsModal.querySelector("[data-save]")!.addEventListener("click", async () => {
    const apiKey = apiKeyInput.value.trim();
    const scServerBaseUrl = scServerInput.value.trim();
    const language = languageSelect.value;
    const theme = themeSelect.value;
    settings = { ...settings, apiKey, scServerBaseUrl, language, theme };
    await saveSettings(bridge, settings);
    options.onApiKeyChange(apiKey);
    options.onScServerChange(scServerBaseUrl);
    options.onLanguageChange(language);
    applyTheme(theme);
    savedNote.classList.add("modal__saved--show");
    setTimeout(closeSettings, 600);
  });

  return {
    setStatus(text: string) {
      statusEl.textContent = text;
    },
    render(text: string) {
      termEl.textContent = text;
      termEl.scrollTop = termEl.scrollHeight;
    },
  };
}
