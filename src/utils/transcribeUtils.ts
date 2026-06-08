// OpenAI Whisper (REST) transcriber.
//
// Buffers of glasses PCM are wrapped as WAV and POSTed to the audio transcriptions
// endpoint. This is request/response (not a live socket), so expect a short lag
// after each pause while the segment is transcribed.

import { pcm16ToWav } from "./audioUtils";

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

const API_KEY = import.meta.env.VITE_OPENAI_API_KEY as string | undefined;
const MODEL = (import.meta.env.VITE_OPENAI_MODEL as string | undefined) ?? "whisper-1";
// Default ISO-639-1 hint (e.g. "en", "ja", "zh"). Used when the caller doesn't pass
// one. Leave unset for auto-detect.
const DEFAULT_LANGUAGE = import.meta.env.VITE_STT_LANGUAGE as string | undefined;

export function hasApiKey(): boolean {
  return Boolean(API_KEY);
}

// `language` is an optional ISO-639-1 hint chosen in Settings; empty/undefined
// means auto-detect.
export async function transcribe(
  pcm: Uint8Array,
  sampleRate: number,
  language?: string,
): Promise<string> {
  if (!API_KEY) throw new Error("VITE_OPENAI_API_KEY is not set");

  const lang = language || DEFAULT_LANGUAGE;
  const form = new FormData();
  form.append("file", pcm16ToWav(pcm, sampleRate), "speech.wav");
  form.append("model", MODEL);
  form.append("response_format", "json");
  if (lang) form.append("language", lang);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Transcription failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}
