// OpenAI Whisper (REST) transcriber.
//
// Buffers of glasses PCM are wrapped as WAV and POSTed to the audio transcriptions
// endpoint. This is request/response (not a live socket), so expect a short lag
// after each pause while the segment is transcribed.

import { pcm16ToWav, hasSpeech } from "./audioUtils";

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

const MODEL = "whisper-1";

// No default language — omitting the hint lets Whisper auto-detect the language.

// Whisper hallucinates canned phrases on near-silent / non-speech audio (it was
// trained on subtitled web video). We reject a segment when the model itself is
// unsure it's speech: high no_speech_prob AND low average token logprob. These are
// OpenAI's own decoder defaults for marking a segment silent.
const NO_SPEECH_PROB_MAX = 0.6;
const AVG_LOGPROB_MIN = -1.0;

// The OpenAI API key is supplied at runtime from Settings (stored on-device), not
// baked in at build time — so it never ships inside the .ehpk.
let apiKey = "";

export function setApiKey(key: string): void {
  apiKey = key.trim();
}

export function hasApiKey(): boolean {
  return Boolean(apiKey);
}

// `language` is an optional ISO-639-1 hint chosen in Settings; empty/undefined
// means auto-detect.
export async function transcribe(pcm: Uint8Array, sampleRate: number, language?: string): Promise<string> {
  if (!apiKey) throw new Error("OpenAI API key is not set");
  if (!hasSpeech(pcm, sampleRate)) return "";

  const lang = language || "";
  const form = new FormData();
  form.append("file", pcm16ToWav(pcm, sampleRate), "speech.wav");
  form.append("model", MODEL);
  // verbose_json gives per-segment no_speech_prob / avg_logprob so we can drop
  // non-speech segments instead of letting Whisper hallucinate over them.
  form.append("response_format", "verbose_json");
  if (lang) form.append("language", lang);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Transcription failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    text?: string;
    segments?: Array<{ text: string; no_speech_prob: number; avg_logprob: number }>;
  };

  // Keep only segments the model is reasonably confident contain speech. A segment
  // is treated as silence (and dropped) when no_speech_prob is high AND the average
  // logprob is low — both conditions, to avoid discarding quiet-but-real speech.
  const segments = data.segments ?? [];
  const speech = segments.filter(
    (s) => !(s.no_speech_prob > NO_SPEECH_PROB_MAX && s.avg_logprob < AVG_LOGPROB_MIN),
  );

  // No segments (older response shape) → fall back to the top-level text.
  return (segments.length ? speech.map((s) => s.text).join("") : data.text ?? "").trim();
}
