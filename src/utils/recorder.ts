// Dev-only capture dump — for debugging speech recognition.
//
// Bad transcripts have two very different causes: the mic capture is poor, or
// the capture is fine and the model got it wrong. You can't tell them apart by
// reading the text, so in dev every clip is POSTed to the vite dev server,
// which writes it under `recordings/` (see the /api/recording middleware in
// vite.config.ts). Listen to them at http://<dev-host>:5173/api/recordings
//
// The clip is saved exactly as it goes to the transcription API, so what you
// hear is what the model heard.
//
// `import.meta.env.DEV` is a compile-time constant, so this whole module is
// eliminated from the packaged build.

import { pcm16ToWav } from "./audio";

const BYTES_PER_SAMPLE = 2;

// Sortable, human-readable clip id: 20260807-143012.
export function newRecordingId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function clipSeconds(pcm: Uint8Array, sampleRate: number): number {
  return pcm.byteLength / BYTES_PER_SAMPLE / sampleRate;
}

// Peak / RMS of a 16-bit LE PCM buffer, both normalized to [0, 1]. A peak
// pinned at 1.0 with a non-trivial clipped-sample count means the waveform is
// being destroyed before it ever reaches the API — speech survives distortion
// well enough for a human ear, but transcription accuracy falls off a cliff.
function levels(pcm: Uint8Array): { peak: number; rms: number; clipped: number } {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const count = Math.floor(pcm.byteLength / BYTES_PER_SAMPLE);
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  for (let i = 0; i < count; i++) {
    const s = view.getInt16(i * BYTES_PER_SAMPLE, true) / 32768;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sumSq += s * s;
  }
  return { peak, rms: count ? Math.sqrt(sumSq / count) : 0, clipped: count ? clipped / count : 0 };
}

async function post(path: string, contentType: string, body: BodyInit): Promise<void> {
  await fetch(path, { method: "POST", headers: { "Content-Type": contentType }, body });
}

// Save one clip as `recordings/<id>-clip.wav`. Never throws: a failed dump
// must not break the transcription it was meant to help debug.
export async function saveRecording(id: string, pcm: Uint8Array, sampleRate: number): Promise<void> {
  if (!import.meta.env.DEV) return;
  try {
    const wav = pcm16ToWav(pcm, sampleRate);
    const { peak, rms, clipped } = levels(pcm);
    await post(`/api/recording?id=${encodeURIComponent(id)}&tag=clip&ext=wav`, "audio/wav", wav);
    console.log(
      `[recording] ${id}-clip.wav ` +
        `${clipSeconds(pcm, sampleRate).toFixed(1)}s ${(wav.size / 1024) | 0}KB ` +
        `peak=${peak.toFixed(3)} rms=${rms.toFixed(4)} clipped=${(clipped * 100).toFixed(1)}%`,
    );
  } catch (err) {
    console.warn("[recording] save failed:", err);
  }
}

// Sidecar `recordings/<id>-text.txt`, shown next to the player in the listing —
// so the audio and what came back from the API sit side by side.
export async function saveRecordingNote(id: string, note: string): Promise<void> {
  if (!import.meta.env.DEV) return;
  try {
    await post(`/api/recording?id=${encodeURIComponent(id)}&tag=text&ext=txt`, "text/plain", note);
  } catch (err) {
    console.warn("[recording] note failed:", err);
  }
}
