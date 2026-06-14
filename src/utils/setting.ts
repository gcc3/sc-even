// Persisted web-side settings (username / password / speech language).
//
// Stored through the Even bridge's local storage so they survive across sessions on
// the app side. Falls back to window.localStorage when the bridge call is unavailable
// (e.g. running the page in a plain browser during development).

import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

const KEY = "webSettings";

export interface Settings {
  username: string;
  password: string;
  /** OpenAI API key, entered in Settings (kept on-device, not bundled at build time). */
  apiKey: string;
  /** ISO-639-1 speech-to-text hint; "" means auto-detect. */
  speechLanguage: string;
  /** BCP 47 language code (e.g. "en-US") for UI and AI; "" means auto-detect. */
  language: string;
  /** UI theme: "light" | "dark" | "terminal". */
  theme: string;
  /** Whether to remember the username/password (the Login "Save" box). */
  loginSave: boolean;
  /** Whether the idle cursor blinks; false = static block. */
  cursorBlink: boolean;
  /** Whether speech-to-text transcription is enabled. */
  transcription: boolean;
}

const EMPTY: Settings = {
  username: "",
  password: "",
  apiKey: "",
  speechLanguage: "",
  language: "",
  theme: "terminal",
  loginSave: true,
  cursorBlink: false,
  transcription: true,
};

// The bridge's storage calls can hang on the real device (they resolve on the
// simulator but not always on the glasses). loadSettings/saveSettings are awaited
// during startup — before the UI's click handlers are wired and before the first
// glasses render — so a hang freezes the whole app on "Starting…". Cap each call
// so we always fall back to web localStorage instead of blocking forever.
const STORAGE_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("storage timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function loadSettings(bridge: EvenAppBridge): Promise<Settings> {
  let raw = "";
  try {
    raw = await withTimeout(bridge.getLocalStorage(KEY), STORAGE_TIMEOUT_MS);
  } catch {
    // bridge unavailable / errored / timed out
  }
  if (!raw) {
    // Also check web localStorage: the bridge may resolve without error on the
    // simulator but not actually persist anything, so we always mirror writes
    // there (see saveSettings).
    try {
      raw = window.localStorage.getItem(KEY) ?? "";
    } catch {
      raw = "";
    }
  }
  if (!raw) return { ...EMPTY };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings> & { language?: string; uiLocale?: string };
    return {
      username: parsed.username ?? "",
      password: parsed.password ?? "",
      apiKey: parsed.apiKey ?? "",
      speechLanguage: parsed.speechLanguage ?? parsed.language ?? "",
      language: parsed.language ?? parsed.uiLocale ?? "",
      theme: parsed.theme ?? "terminal",
      loginSave: parsed.loginSave ?? true,
      cursorBlink: parsed.cursorBlink ?? false,
      transcription: parsed.transcription ?? true,
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function saveSettings(bridge: EvenAppBridge, settings: Settings): Promise<void> {
  const raw = JSON.stringify(settings);
  try {
    await withTimeout(bridge.setLocalStorage(KEY, raw), STORAGE_TIMEOUT_MS);
  } catch {
    // bridge unavailable / errored / timed out
  }
  // Always mirror to web localStorage: the bridge may resolve without error on
  // the simulator but not actually persist, so we need a reliable fallback that
  // loadSettings can read back.
  try {
    window.localStorage.setItem(KEY, raw);
  } catch {
    /* ignore — nothing else we can do to persist */
  }
}
