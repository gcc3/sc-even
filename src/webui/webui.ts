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
import { t, setLocale, parseLocale } from "../i18n";

// App version, injected at build time from app.json (see vite.config.ts `define`).
declare const __APP_VERSION__: string;

function speechLanguages() {
  return [
    { value: "", label: t("langAuto") },
    { value: "en", label: "English" },
    { value: "ja", label: "日本語" },
    { value: "zh", label: "中文（简体）" },
    { value: "zh-TW", label: "中文（繁體）" },
    { value: "ko", label: "한국어" },
  ];
}

function themes() {
  return [
    { value: "light", label: t("themeLight") },
    { value: "dark", label: t("themeDark") },
    { value: "terminal", label: t("themeTerminal") },
  ];
}

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme || "light";
}

interface Dropdown {
  /** The control's root element — append this where the dropdown should appear. */
  el: HTMLElement;
  /** Selected option value (get/set). Setting it updates the label, no callback. */
  value: string;
  /** Replace all items and refresh the displayed label (for locale switches). */
  relabel(items: Array<{ value: string; label: string }>): void;
}

// A fully app-styled dropdown to replace native <select>, whose option menu the
// webview renders in system style (unstylable). Button shows the current label;
// clicking toggles a styled menu. `onChange` fires only on user selection.
const allDropdownClosers: Array<() => void> = [];

function createDropdown(items: Array<{ value: string; label: string }>, onChange: (value: string) => void): Dropdown {
  const el = document.createElement("div");
  el.className = "select";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "field__input select__button";
  const labelEl = document.createElement("span");
  labelEl.className = "select__label";
  button.appendChild(labelEl);
  el.appendChild(button);

  const menu = document.createElement("ul");
  menu.className = "select__menu";
  el.appendChild(menu);

  let current = items[0]?.value ?? "";
  let optionEls = new Map<string, HTMLLIElement>();

  const buildMenu = (newItems: Array<{ value: string; label: string }>) => {
    menu.innerHTML = "";
    optionEls = new Map();
    for (const item of newItems) {
      const li = document.createElement("li");
      li.className = "select__option";
      li.textContent = item.label;
      li.addEventListener("click", () => {
        setValue(item.value, newItems);
        close();
        onChange(item.value);
      });
      menu.appendChild(li);
      optionEls.set(item.value, li);
    }
  };

  const setValue = (v: string, src: Array<{ value: string; label: string }> = []) => {
    const pool = src.length ? src : [...optionEls.keys()].map((k) => ({ value: k, label: optionEls.get(k)!.textContent ?? "" }));
    const item = pool.find((i) => i.value === v) ?? pool[0];
    current = item?.value ?? "";
    labelEl.textContent = item?.label ?? "";
    for (const [val, li] of optionEls) li.classList.toggle("select__option--active", val === current);
  };

  const close = () => el.classList.remove("select--open");
  allDropdownClosers.push(close);

  buildMenu(items);

  button.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let the document handler immediately close it
    const isOpen = el.classList.contains("select--open");
    allDropdownClosers.forEach((c) => c());
    if (!isOpen) el.classList.add("select--open");
  });
  // Close when clicking/tapping anywhere outside this control.
  document.addEventListener("click", (e) => {
    if (!el.contains(e.target as Node)) close();
  });

  setValue(current, items);

  return {
    el,
    get value() {
      return current;
    },
    set value(v: string) {
      setValue(v);
    },
    relabel(newItems) {
      buildMenu(newItems);
      setValue(current, newItems);
    },
  };
}

export interface WebUI {
  setStatus(text: string): void;
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
  /** User pressed the refresh button to reset the conversation and memory. */
  onRefresh: () => void;
  /** Speech language changed (also fired once with the saved value at startup). */
  onLanguageChange: (language: string) => void;
  /** OpenAI API key changed (also fired once with the saved value at startup). */
  onApiKeyChange: (apiKey: string) => void;
  /** Cursor blink setting changed (also fired once with the saved value at startup). */
  onCursorBlinkChange: (blink: boolean) => void;
  /** Transcription enabled/disabled (also fired once with the saved value at startup). */
  onTranscriptionChange: (enabled: boolean) => void;
}

export async function createWebUI(bridge: EvenAppBridge, options: WebUIOptions): Promise<WebUI> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app element not found");

  // Load settings and apply locale before building the HTML so t() is ready.
  let settings = await loadSettings(bridge);
  setLocale(parseLocale(""));

  root.innerHTML = `
    <div class="app">
      <header class="app__header">
        <div class="app__title">
          ${t("appTitle")}
          <span class="app__status" data-status></span>
        </div>
        <div class="app__actions">
          <button class="icon-btn" data-refresh>${REFRESH_SVG}</button>
          <button class="icon-btn" data-open-login>${USER_SVG}</button>
          <button class="icon-btn" data-open-settings>${GEAR_SVG}</button>
        </div>
      </header>
      <pre class="term" data-term></pre>
      <input class="hidden-input" data-input-field type="text"
             autocomplete="off" enterkeyhint="enter" />
    </div>

    <div class="toast" data-toast></div>

    <div class="modal" data-login-modal>
      <div class="modal__box">
        <h2 class="modal__title" data-i18n-login-title>${t("loginTitle")}</h2>
        <label class="field">
          <span class="field__label" data-i18n-username>${t("fieldUsername")}</span>
          <input class="field__input" data-username type="text" autocomplete="username" />
        </label>
        <label class="field">
          <span class="field__label" data-i18n-password>${t("fieldPassword")}</span>
          <input class="field__input" data-password type="password" autocomplete="current-password" />
        </label>
        <label class="checkbox">
          <input type="checkbox" data-login-save />
          <span data-i18n-save-creds>${t("saveCredentials")}</span>
        </label>
        <div class="modal__actions">
          <button class="btn" data-close-login data-i18n-cancel>${t("btnCancel")}</button>
          <button class="btn btn--primary" data-do-login data-i18n-login-btn>${t("btnLogin")}</button>
        </div>
      </div>
    </div>

    <div class="modal" data-settings-modal>
      <div class="modal__box">
        <h2 class="modal__title" data-i18n-settings-title>${t("settingsTitle")}</h2>
        <label class="field">
          <span class="field__label" data-i18n-api-key>${t("fieldApiKey")}</span>
          <input class="field__input" data-api-key type="password"
                 placeholder="sk-" autocomplete="off" />
        </label>
        <label class="switch">
          <span data-i18n-transcription>${t("toggleTranscription")}</span>
          <input type="checkbox" data-transcription />
          <span class="switch__track"><span class="switch__thumb"></span></span>
        </label>
        <div class="field" data-speech-lang-field>
          <span class="field__label" data-i18n-speech-lang>${t("fieldSpeechLang")}</span>
          <div data-language></div>
        </div>
        <div class="field">
          <span class="field__label" data-i18n-theme>${t("fieldTheme")}</span>
          <div data-theme></div>
        </div>
        <label class="switch">
          <span data-i18n-cursor-blink>${t("toggleCursorBlink")}</span>
          <input type="checkbox" data-cursor-blink />
          <span class="switch__track"><span class="switch__thumb"></span></span>
        </label>
        <div class="modal__actions">
          <span class="modal__saved" data-saved data-i18n-saved>${t("savedNote")}</span>
          <button class="btn" data-close-settings data-i18n-cancel-settings>${t("btnCancel")}</button>
          <button class="btn btn--primary" data-save data-i18n-save>${t("btnSave")}</button>
        </div>
        <div class="modal__version" data-i18n-version>${t("versionPrefix")} ${__APP_VERSION__}</div>
      </div>
    </div>
  `;

  const statusEl = root.querySelector<HTMLSpanElement>("[data-status]")!;
  const termEl = root.querySelector<HTMLPreElement>("[data-term]")!;
  const inputField = root.querySelector<HTMLInputElement>("[data-input-field]")!;
  const toastEl = root.querySelector<HTMLDivElement>("[data-toast]")!;
  let toastTimer = 0; // pending hide timer, so back-to-back toasts don't hide early

  const loginModal = document.querySelector<HTMLDivElement>("[data-login-modal]")!;
  const usernameInput = loginModal.querySelector<HTMLInputElement>("[data-username]")!;
  const passwordInput = loginModal.querySelector<HTMLInputElement>("[data-password]")!;
  const loginSaveCheckbox = loginModal.querySelector<HTMLInputElement>("[data-login-save]")!;

  const settingsModal = document.querySelector<HTMLDivElement>("[data-settings-modal]")!;
  const apiKeyInput = settingsModal.querySelector<HTMLInputElement>("[data-api-key]")!;
  const languageSelect = createDropdown(speechLanguages(), () => {});
  // Preview the theme live as the user picks (reverted on Cancel via closeSettings).
  const themeSelect = createDropdown(themes(), (value) => applyTheme(value));
  settingsModal.querySelector<HTMLDivElement>("[data-language]")!.appendChild(languageSelect.el);
  settingsModal.querySelector<HTMLDivElement>("[data-theme]")!.appendChild(themeSelect.el);
  const savedNote = settingsModal.querySelector<HTMLSpanElement>("[data-saved]")!;
  const cursorBlinkCheckbox = settingsModal.querySelector<HTMLInputElement>("[data-cursor-blink]")!;
  const transcriptionCheckbox = settingsModal.querySelector<HTMLInputElement>("[data-transcription]")!;
  const speechLangField = settingsModal.querySelector<HTMLDivElement>("[data-speech-lang-field]")!;

  const setApiKeyDependentState = (hasKey: boolean) => {
    transcriptionCheckbox.disabled = !hasKey;
    if (!hasKey) transcriptionCheckbox.checked = false;
    speechLangField.classList.toggle("field--disabled", !hasKey);
  };

  // Updates all translatable text nodes after a locale switch.
  const applyTranslations = () => {
    loginModal.querySelector("[data-i18n-login-title]")!.textContent = t("loginTitle");
    loginModal.querySelector("[data-i18n-username]")!.textContent = t("fieldUsername");
    loginModal.querySelector("[data-i18n-password]")!.textContent = t("fieldPassword");
    loginModal.querySelector("[data-i18n-save-creds]")!.textContent = t("saveCredentials");
    loginModal.querySelector("[data-i18n-cancel]")!.textContent = t("btnCancel");
    loginModal.querySelector("[data-i18n-login-btn]")!.textContent = t("btnLogin");
    settingsModal.querySelector("[data-i18n-settings-title]")!.textContent = t("settingsTitle");
    settingsModal.querySelector("[data-i18n-api-key]")!.textContent = t("fieldApiKey");
    settingsModal.querySelector("[data-i18n-speech-lang]")!.textContent = t("fieldSpeechLang");
    settingsModal.querySelector("[data-i18n-theme]")!.textContent = t("fieldTheme");
    settingsModal.querySelector("[data-i18n-cursor-blink]")!.textContent = t("toggleCursorBlink");
    settingsModal.querySelector("[data-i18n-transcription]")!.textContent = t("toggleTranscription");
    settingsModal.querySelector("[data-i18n-saved]")!.textContent = t("savedNote");
    settingsModal.querySelector("[data-i18n-cancel-settings]")!.textContent = t("btnCancel");
    settingsModal.querySelector("[data-i18n-save]")!.textContent = t("btnSave");
    settingsModal.querySelector("[data-i18n-version]")!.textContent = `${t("versionPrefix")} ${__APP_VERSION__}`;
    languageSelect.relabel(speechLanguages());
    themeSelect.relabel(themes());
  };

  options.onLanguageChange(settings.language);
  options.onApiKeyChange(settings.apiKey);
  applyTheme(settings.theme);
  termEl.classList.toggle("term--cursor-blink", settings.cursorBlink);
  options.onCursorBlinkChange(settings.cursorBlink);
  setApiKeyDependentState(!!settings.apiKey);
  options.onTranscriptionChange(settings.transcription);
  // Auto-login at startup if saved credentials exist.
  if (settings.username && settings.password) {
    options.onLogin(settings.username, settings.password);
  }

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

  // On iOS the on-screen keyboard overlays the page instead of resizing it, so
  // the terminal shrinks to the visible (visual viewport) area and stays readable.
  const appEl = root.querySelector<HTMLDivElement>(".app")!;
  const viewport = window.visualViewport;
  if (viewport) {
    const syncViewport = () => {
      appEl.style.height = `${viewport.height}px`;
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
  const openLogin = () => {
    usernameInput.value = settings.username;
    passwordInput.value = settings.password;
    loginSaveCheckbox.checked = settings.loginSave;
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
    const save = loginSaveCheckbox.checked;
    // Persist the credentials only when "Save" is checked; otherwise forget any
    // previously stored ones so this is a one-session login (no auto-login next time).
    settings = save
      ? { ...settings, username, password, loginSave: true }
      : { ...settings, username: "", password: "", loginSave: false };
    await saveSettings(bridge, settings);
    // Log in with the entered values regardless of whether we stored them.
    if (username) options.onLogin(username, password);
    closeLogin();
  });

  // --- settings modal -----------------------------------------------------
  const openSettings = () => {
    apiKeyInput.value = settings.apiKey;
    languageSelect.value = settings.language;
    themeSelect.value = settings.theme;
    cursorBlinkCheckbox.checked = settings.cursorBlink;
    transcriptionCheckbox.checked = settings.transcription;
    setApiKeyDependentState(!!settings.apiKey);
    savedNote.classList.remove("modal__saved--show");
    settingsModal.classList.add("modal--open");
  };
  apiKeyInput.addEventListener("input", () => {
    setApiKeyDependentState(!!apiKeyInput.value.trim());
  });
  const closeSettings = () => {
    applyTheme(settings.theme); // discard any unsaved live preview
    settingsModal.classList.remove("modal--open");
  };

  root.querySelector("[data-open-settings]")!.addEventListener("click", openSettings);
  settingsModal.querySelector("[data-close-settings]")!.addEventListener("click", closeSettings);
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  settingsModal.querySelector("[data-save]")!.addEventListener("click", async () => {
    const apiKey = apiKeyInput.value.trim();
    const language = languageSelect.value;
    const theme = themeSelect.value;
    const cursorBlink = cursorBlinkCheckbox.checked;
    const transcription = transcriptionCheckbox.checked;
    settings = { ...settings, apiKey, language, theme, cursorBlink, transcription };
    await saveSettings(bridge, settings);
    options.onApiKeyChange(apiKey);
    options.onLanguageChange(language);
    applyTheme(theme);
    termEl.classList.toggle("term--cursor-blink", cursorBlink);
    options.onCursorBlinkChange(cursorBlink);
    setApiKeyDependentState(!!apiKey);
    options.onTranscriptionChange(transcription);
    applyTranslations();
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
