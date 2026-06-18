import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { Settings } from "../utils/setting";
import { saveSettings } from "../utils/setting";
import { t, setLocale, localeFromLangCode, getLanguages } from "../i18n";

declare const __APP_VERSION__: string;
declare const __SC_VERSION__: string;

function speechLanguages() {
  return [
    { value: "", label: t("langAuto") },
    { value: "af", label: "Afrikaans" },
    { value: "sq", label: "Shqip" },
    { value: "ar", label: "العربية" },
    { value: "hy", label: "Հայերեն" },
    { value: "az", label: "Azərbaycanca" },
    { value: "eu", label: "Euskara" },
    { value: "be", label: "Беларуская" },
    { value: "bn", label: "বাংলা" },
    { value: "bs", label: "Bosanski" },
    { value: "bg", label: "Български" },
    { value: "ca", label: "Català" },
    { value: "hr", label: "Hrvatski" },
    { value: "cs", label: "Čeština" },
    { value: "da", label: "Dansk" },
    { value: "nl", label: "Nederlands" },
    { value: "en", label: "English" },
    { value: "et", label: "Eesti" },
    { value: "fi", label: "Suomi" },
    { value: "fr", label: "Français" },
    { value: "gl", label: "Galego" },
    { value: "ka", label: "ქართული" },
    { value: "de", label: "Deutsch" },
    { value: "el", label: "Ελληνικά" },
    { value: "gu", label: "ગુજરાતી" },
    { value: "ht", label: "Kreyòl ayisyen" },
    { value: "he", label: "עברית" },
    { value: "hi", label: "हिन्दी" },
    { value: "hu", label: "Magyar" },
    { value: "is", label: "Íslenska" },
    { value: "id", label: "Bahasa Indonesia" },
    { value: "it", label: "Italiano" },
    { value: "ja", label: "日本語" },
    { value: "kn", label: "ಕನ್ನಡ" },
    { value: "kk", label: "Қазақша" },
    { value: "ko", label: "한국어" },
    { value: "lv", label: "Latviešu" },
    { value: "lt", label: "Lietuvių" },
    { value: "mk", label: "Македонски" },
    { value: "ms", label: "Bahasa Melayu" },
    { value: "mt", label: "Malti" },
    { value: "mi", label: "Māori" },
    { value: "mr", label: "मराठी" },
    { value: "mn", label: "Монгол" },
    { value: "ne", label: "नेपाली" },
    { value: "no", label: "Norsk" },
    { value: "fa", label: "فارسی" },
    { value: "pl", label: "Polski" },
    { value: "pt", label: "Português" },
    { value: "pa", label: "ਪੰਜਾਬੀ" },
    { value: "ro", label: "Română" },
    { value: "ru", label: "Русский" },
    { value: "sr", label: "Српски" },
    { value: "sk", label: "Slovenčina" },
    { value: "sl", label: "Slovenščina" },
    { value: "es", label: "Español" },
    { value: "sw", label: "Kiswahili" },
    { value: "sv", label: "Svenska" },
    { value: "tl", label: "Filipino" },
    { value: "ta", label: "தமிழ்" },
    { value: "te", label: "తెలుగు" },
    { value: "th", label: "ภาษาไทย" },
    { value: "tr", label: "Türkçe" },
    { value: "uk", label: "Українська" },
    { value: "ur", label: "اردو" },
    { value: "vi", label: "Tiếng Việt" },
    { value: "cy", label: "Cymraeg" },
    { value: "zh", label: "中文（简体）" },
    { value: "zh-TW", label: "中文（繁體）" },
  ];
}

function themes() {
  return [
    { value: "light", label: t("themeLight") },
    { value: "dark", label: t("themeDark") },
    { value: "terminal", label: t("themeTerminal") },
  ];
}

export function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme || "terminal";
}

interface Dropdown {
  el: HTMLElement;
  value: string;
  relabel(items: Array<{ value: string; label: string }>): void;
}

// A fully app-styled dropdown to replace native <select>, whose option menu the
// webview renders in system style (unstylable). Button shows the current label;
// clicking toggles a styled menu. `onChange` fires only on user selection.
const allDropdownClosers: Array<() => void> = [];

function createDropdown(
  items: Array<{ value: string; label: string }>,
  onChange: (value: string) => void,
  opts: { searchable?: boolean } = {},
): Dropdown {
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

  let searchInput: HTMLInputElement | null = null;
  if (opts.searchable) {
    const searchWrap = document.createElement("li");
    searchWrap.className = "select__search-wrap";
    searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "select__search field__input";
    searchInput.placeholder = "Search…";
    searchWrap.appendChild(searchInput);
    menu.appendChild(searchWrap);

    searchInput.addEventListener("input", () => {
      const q = searchInput!.value.toLowerCase();
      for (const [, li] of optionEls) {
        li.style.display = (li.textContent?.toLowerCase() ?? "").includes(q) ? "" : "none";
      }
    });
    searchInput.addEventListener("click", (e) => e.stopPropagation());
  }

  let current = items[0]?.value ?? "";
  let optionEls = new Map<string, HTMLLIElement>();

  const buildMenu = (newItems: Array<{ value: string; label: string }>) => {
    for (const [, li] of optionEls) li.remove();
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

  const close = () => {
    el.classList.remove("select--open");
    if (searchInput) {
      searchInput.value = "";
      for (const [, li] of optionEls) li.style.display = "";
    }
  };
  allDropdownClosers.push(close);

  buildMenu(items);

  button.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let the document handler immediately close it
    const isOpen = el.classList.contains("select--open");
    allDropdownClosers.forEach((c) => c());
    if (!isOpen) {
      el.classList.add("select--open");
      if (searchInput) requestAnimationFrame(() => searchInput!.focus());
    }
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

export function settingsModalHTML(): string {
  return `
    <div class="modal" data-settings-modal>
      <div class="modal__box">
        <h2 class="modal__title" data-i18n-settings-title>${t("settingsTitle")}</h2>
        <div class="field">
          <span class="field__label" data-i18n-ui-language>${t("fieldLanguage")}</span>
          <div data-ui-locale></div>
        </div>
        <label class="switch">
          <span data-i18n-transcription><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>${t("toggleTranscription")}</span>
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
        <div class="modal__version" data-i18n-version>${t("versionPrefix")} ${__APP_VERSION__} (sc ${__SC_VERSION__})</div>
      </div>
    </div>
  `;
}

export interface SettingsModalCallbacks {
  onLanguageChange: (language: string) => void;
  onCursorBlinkChange: (blink: boolean) => void;
  onTranscriptionChange: (enabled: boolean) => void;
  onApplyTranslations: () => void;
  onSendCommand: (command: string) => void;
}

export function createSettingsModal(
  root: HTMLElement,
  settingsRef: { current: Settings },
  bridge: EvenAppBridge,
  termEl: HTMLPreElement,
  callbacks: SettingsModalCallbacks,
) {
  const settingsModal = root.querySelector<HTMLDivElement>("[data-settings-modal]")!;
  const languageSelect = createDropdown(getLanguages(), () => {}, { searchable: true });
  const speechLanguageSelect = createDropdown(speechLanguages(), () => {}, { searchable: true });
  // Preview the theme live as the user picks (reverted on Cancel via closeSettings).
  const themeSelect = createDropdown(themes(), (value) => applyTheme(value));
  settingsModal.querySelector<HTMLDivElement>("[data-ui-locale]")!.appendChild(languageSelect.el);
  settingsModal.querySelector<HTMLDivElement>("[data-language]")!.appendChild(speechLanguageSelect.el);
  settingsModal.querySelector<HTMLDivElement>("[data-theme]")!.appendChild(themeSelect.el);
  const savedNote = settingsModal.querySelector<HTMLSpanElement>("[data-saved]")!;
  const cursorBlinkCheckbox = settingsModal.querySelector<HTMLInputElement>("[data-cursor-blink]")!;
  const transcriptionCheckbox = settingsModal.querySelector<HTMLInputElement>("[data-transcription]")!;

  const open = () => {
    languageSelect.value = settingsRef.current.language;
    speechLanguageSelect.value = settingsRef.current.speechLanguage;
    themeSelect.value = settingsRef.current.theme;
    cursorBlinkCheckbox.checked = settingsRef.current.cursorBlink;
    transcriptionCheckbox.checked = settingsRef.current.transcription;
    savedNote.classList.remove("modal__saved--show");
    settingsModal.classList.add("modal--open");
  };

  const close = () => {
    applyTheme(settingsRef.current.theme); // discard any unsaved live preview
    settingsModal.classList.remove("modal--open");
  };

  root.querySelector("[data-open-settings]")!.addEventListener("click", open);
  settingsModal.querySelector("[data-close-settings]")!.addEventListener("click", close);
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) close();
  });

  settingsModal.querySelector("[data-save]")!.addEventListener("click", async () => {
    const language = languageSelect.value;
    const speechLanguage = speechLanguageSelect.value;
    const theme = themeSelect.value;
    const cursorBlink = cursorBlinkCheckbox.checked;
    const transcription = transcriptionCheckbox.checked;
    settingsRef.current = { ...settingsRef.current, language, speechLanguage, theme, cursorBlink, transcription };
    await saveSettings(bridge, settingsRef.current);
    setLocale(localeFromLangCode(language));
    // Notify the server of the selected language
    callbacks.onSendCommand(language ? `:lang use ${language}` : `:lang reset`);
    callbacks.onLanguageChange(speechLanguage);
    applyTheme(theme);
    termEl.classList.toggle("term--cursor-blink", cursorBlink);
    callbacks.onCursorBlinkChange(cursorBlink);
    callbacks.onTranscriptionChange(transcription);
    callbacks.onApplyTranslations();
    savedNote.classList.add("modal__saved--show");
    setTimeout(close, 600);
  });

  return {
    open,
    applyTranslations() {
      settingsModal.querySelector("[data-i18n-settings-title]")!.textContent = t("settingsTitle");
      settingsModal.querySelector("[data-i18n-ui-language]")!.textContent = t("fieldLanguage");
      settingsModal.querySelector("[data-i18n-speech-lang]")!.textContent = t("fieldSpeechLang");
      settingsModal.querySelector("[data-i18n-theme]")!.textContent = t("fieldTheme");
      settingsModal.querySelector("[data-i18n-cursor-blink]")!.textContent = t("toggleCursorBlink");
      settingsModal.querySelector("[data-i18n-transcription]")!.textContent = t("toggleTranscription");
      settingsModal.querySelector("[data-i18n-saved]")!.textContent = t("savedNote");
      settingsModal.querySelector("[data-i18n-cancel-settings]")!.textContent = t("btnCancel");
      settingsModal.querySelector("[data-i18n-save]")!.textContent = t("btnSave");
      settingsModal.querySelector("[data-i18n-version]")!.textContent = `${t("versionPrefix")} ${__APP_VERSION__} (sc ${__SC_VERSION__})`;
      languageSelect.relabel(getLanguages());
      speechLanguageSelect.relabel(speechLanguages());
      themeSelect.relabel(themes());
    },
  };
}
