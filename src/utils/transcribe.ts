// OpenAI Whisper (REST) transcriber — proxied through the sc-bridge backend.
//
// The client sends a base64-encoded WAV to the server's /api/transcribe endpoint,
// which holds the OpenAI API key and forwards the request to Whisper. The key is
// never shipped in the client bundle.

import { pcm16ToWav } from "./audio";
import { hasSpeech } from "./speech";

// Same fixed server the sc bridge uses (see src/services/sc.ts).
const SC_SERVER_BASE_URL = "http://159.223.204.39:8787";

// `language` is an optional ISO-639-1 hint chosen in Settings; empty/undefined
// means auto-detect.
export async function transcribe(pcm: Uint8Array, sampleRate: number, language?: string): Promise<string> {
  if (!hasSpeech(pcm, sampleRate)) return "";

  const wavBlob = pcm16ToWav(pcm, sampleRate);
  const wavBytes = new Uint8Array(await wavBlob.arrayBuffer());
  const binary = Array.from(wavBytes, (b) => String.fromCharCode(b)).join("");
  const wavBase64 = btoa(binary);

  const res = await fetch(`${SC_SERVER_BASE_URL}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wav: wavBase64, language: language || undefined }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Transcription failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { text?: string; error?: string };
  return data.text ?? "";
}
