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
  /** ISO-639-1 speech-to-text hint; "" means auto-detect. */
  language: string;
  /** UI theme: "terminal" | "light" | "terminal". */
  theme: string;
}

const EMPTY: Settings = { username: "", password: "", language: "", theme: "terminal" };

export async function loadSettings(bridge: EvenAppBridge): Promise<Settings> {
  let raw = "";
  try {
    raw = await bridge.getLocalStorage(KEY);
  } catch {
    raw = window.localStorage.getItem(KEY) ?? "";
  }
  if (!raw) return { ...EMPTY };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      username: parsed.username ?? "",
      password: parsed.password ?? "",
      language: parsed.language ?? "",
      theme: parsed.theme ?? "dark",
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function saveSettings(bridge: EvenAppBridge, settings: Settings): Promise<void> {
  const raw = JSON.stringify(settings);
  try {
    await bridge.setLocalStorage(KEY, raw);
  } catch {
    window.localStorage.setItem(KEY, raw);
  }
}
