import { TRANSLATIONS, type Locale, type Translations } from "./translations";

export type { Locale };

const LOCALES = Object.keys(TRANSLATIONS) as Locale[];

function detectLocale(): Locale {
  const lang = navigator.language.toLowerCase();
  // Map browser tags that won't match our custom locale keys directly.
  if (lang.startsWith("zh-tw") || lang.startsWith("zh-hant")) return "zt";
  if (lang.startsWith("zh")) return "zh";
  return (LOCALES.find((l) => lang.startsWith(l)) as Locale | undefined) ?? "en";
}

export function parseLocale(value: string): Locale {
  return (LOCALES.find((l) => l === value) as Locale | undefined) ?? detectLocale();
}

let current: Translations = TRANSLATIONS.en;

export function setLocale(locale: Locale): void {
  current = TRANSLATIONS[locale];
}

export function t(key: keyof Translations): string {
  return current[key] as string;
}

export function getLanguages(): Array<{ value: string; label: string }> {
  return [
    { value: "", label: "Auto (system)" },
    { value: "ar-EG", label: "العربية (مصر)" },
    { value: "ar-IQ", label: "العربية (العراق)" },
    { value: "ar-MA", label: "العربية (المغرب)" },
    { value: "ar-SA", label: "العربية (السعودية)" },
    { value: "ar-SY", label: "العربية (سوريا)" },
    { value: "bn-BD", label: "বাংলা" },
    { value: "de-DE", label: "Deutsch" },
    { value: "en-US", label: "English (US)" },
    { value: "en-GB", label: "English (UK)" },
    { value: "es-ES", label: "Español" },
    { value: "fr-CA", label: "Français (Canada)" },
    { value: "fr-FR", label: "Français (France)" },
    { value: "hi-IN", label: "हिन्दी" },
    { value: "id-ID", label: "Bahasa Indonesia" },
    { value: "it-IT", label: "Italiano" },
    { value: "ja-JP", label: "日本語" },
    { value: "ko-KR", label: "한국어" },
    { value: "nl-BE", label: "Nederlands (België)" },
    { value: "nl-NL", label: "Nederlands" },
    { value: "pl-PL", label: "Polski" },
    { value: "pt-BR", label: "Português (Brasil)" },
    { value: "pt-PT", label: "Português (Portugal)" },
    { value: "ru-RU", label: "Русский" },
    { value: "sv-FI", label: "Svenska (Finland)" },
    { value: "sv-SE", label: "Svenska (Sverige)" },
    { value: "tr-TR", label: "Türkçe" },
    { value: "zh-CN", label: "中文(简体)" },
    { value: "zh-HK", label: "中文(香港)" },
    { value: "zh-TW", label: "中文(繁體)" },
  ];
}

export function localeFromLangCode(code: string): Locale {
  if (!code) return detectLocale();
  const lower = code.toLowerCase();
  if (lower.startsWith("zh-tw") || lower.startsWith("zh-hant") || lower.startsWith("zh-hk")) return "zt";
  if (lower.startsWith("zh")) return "zh";
  const base = lower.split("-")[0];
  return (LOCALES.find((l) => l === base) as Locale | undefined) ?? "en";
}
