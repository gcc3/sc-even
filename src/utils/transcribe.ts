// OpenAI transcriber — calls OpenAI directly from the client.
//
// The API key is fetched once from the sc-bridge backend (never shipped in the
// bundle) and cached for the lifetime of the page. Subsequent transcription
// requests go straight to OpenAI, skipping the backend hop.

import { pcm16ToWav } from "./audio";
import { hasSpeech } from "./speech";

const SC_SERVER_BASE_URL = "http://159.223.204.39:8787";

const NO_SPEECH_PROB_MAX = 0.6;
const AVG_LOGPROB_MIN = -1.0;

let cachedApiKey: string | null = null;

async function fetchApiKey(): Promise<string> {
  const res = await fetch(`${SC_SERVER_BASE_URL}/api/key`);
  const data = (await res.json()) as { key?: string };
  cachedApiKey = data.key ?? "";
  return cachedApiKey;
}

async function getApiKey(): Promise<string> {
  if (cachedApiKey !== null) return cachedApiKey;
  return fetchApiKey();
}

export async function transcribe(pcm: Uint8Array, sampleRate: number, language?: string): Promise<string> {
  if (!hasSpeech(pcm, sampleRate)) return "";

  const apiKey = await getApiKey();
  if (!apiKey) return "";

  const wavBlob = pcm16ToWav(pcm, sampleRate);

  const makeForm = () => {
    const form = new FormData();
    form.append("file", wavBlob, "speech.wav");
    form.append("model", "gpt-4o-transcribe");
    form.append("response_format", "json");
    if (language) form.append("language", language);
    return form;
  };

  let res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: makeForm(),
  });

  if (res.status === 401) {
    const retryKey = await fetchApiKey();
    if (!retryKey) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Transcription failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${retryKey}` },
      body: makeForm(),
    });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Transcription failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    text?: string;
    segments?: Array<{ text: string; no_speech_prob: number; avg_logprob: number }>;
  };

  const segments = data.segments ?? [];
  const speech = segments.filter(
    (s) => !(s.no_speech_prob > NO_SPEECH_PROB_MAX && s.avg_logprob < AVG_LOGPROB_MIN),
  );
  const text = (speech.length ? speech.map((s) => s.text).join("") : data.text ?? "").trim();
  console.log("[transcribe] result:", JSON.stringify({ text, segments: segments.length, kept: speech.length }));
  return text;
}
