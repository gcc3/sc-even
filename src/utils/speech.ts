// Pre-flight energy check for 16-bit LE mono PCM buffers.
//
// Used to reject near-silent segments before sending to Whisper, which
// hallucinates canned phrases when given non-speech audio.

const BYTES_PER_SAMPLE = 2;
const SPEECH_RMS_THRESHOLD = 0.001;
const MIN_SPEECH_SAMPLES = 1600; // 100 ms at 16 kHz

export function hasSpeech(pcm: Uint8Array, sampleRate: number): boolean {
  const count = Math.floor(pcm.byteLength / BYTES_PER_SAMPLE);
  if (count < Math.floor((sampleRate * MIN_SPEECH_SAMPLES) / 16000)) return false;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sumSq = 0;
  for (let i = 0; i < count; i++) {
    const s = view.getInt16(i * BYTES_PER_SAMPLE, true) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / count) > SPEECH_RMS_THRESHOLD;
}
