// Audio helpers for the glasses mic stream: 16-bit little-endian mono PCM.

const BYTES_PER_SAMPLE = 2; // 16-bit
const NUM_CHANNELS = 1; // mono

// Wrap raw 16-bit LE mono PCM in a minimal WAV container so it can be POSTed
// to a REST transcription endpoint.
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Blob {
  const blockAlign = NUM_CHANNELS * BYTES_PER_SAMPLE;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  writeStr(36, "data");
  view.setUint32(40, pcm.byteLength, true);

  new Uint8Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: "audio/wav" });
}
