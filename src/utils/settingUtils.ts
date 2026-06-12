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
  language: string;
  /** UI theme: "light" | "dark" | "terminal". */
  theme: string;
  /** Whether to remember the username/password (the Login "Save" box). */
  loginSave: boolean;
  /** Whether the idle cursor blinks; false = static block. */
  cursorBlink: boolean;
}

const EMPTY: Settings = {
  username: "",
  password: "",
  apiKey: "",
  language: "",
  theme: "light",
  loginSave: true,
  cursorBlink: false,
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
    // bridge unavailable / errored / timed out — fall back to web localStorage.
    try {
      raw = window.localStorage.getItem(KEY) ?? "";
    } catch {
      raw = "";
    }
  }
  if (!raw) return { ...EMPTY };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      username: parsed.username ?? "",
      password: parsed.password ?? "",
      apiKey: parsed.apiKey ?? "",
      language: parsed.language ?? "",
      theme: parsed.theme ?? "light",
      loginSave: parsed.loginSave ?? true,
      cursorBlink: parsed.cursorBlink ?? false,
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
    try {
      window.localStorage.setItem(KEY, raw);
    } catch {
      /* ignore — nothing else we can do to persist */
    }
  }
}
