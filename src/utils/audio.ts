// Audio helpers for the glasses mic stream: 16-bit little-endian mono PCM.

const BYTES_PER_SAMPLE = 2; // 16-bit
const NUM_CHANNELS = 1; // mono

// --- capture conditioning ---------------------------------------------------
// The glasses mic is thin and picks up a lot of room: clips come back quiet in
// the speech band but with a constant noise bed under them. enhanceCapture runs
// the whole clip through high-pass -> noise reduction -> gain -> soft limit
// before it is sent for transcription.
//
// Order matters. Denoising happens before the gain so the gain lifts speech and
// not the noise bed, and the limiter sits last so nothing can hard-clip: this
// mic already peaks near full scale on normal speech, and clipped samples are
// what wrecked accuracy the last time it saw a gain stage (an earlier x20).

/** Output gain applied to the captured clip — 120% of the mic's own level. */
export const CAPTURE_GAIN = 1.2;

// Where the limiter starts bending the curve instead of scaling linearly.
// Below this the gain is exactly CAPTURE_GAIN, which is most of normal speech.
const LIMIT_KNEE = 0.7;

// One-pole high-pass corner: under the speech band, over mic rumble and DC
// drift. Rumble is inaudible but eats the headroom the gain wants to use.
const HIGHPASS_HZ = 60;

// Noise reduction: spectral subtraction over 32 ms frames, 50% overlap.
const FFT_SIZE = 512; // 32 ms at 16 kHz
const NOISE_PERCENTILE = 0.35; // per-bin magnitude at this rank is the noise floor
// A bin's magnitude scatters a lot frame to frame, so any percentile of it
// lands below the level the noise actually sits at — at the rank above, about
// 0.74 of it. Scale back up, or the subtraction below barely bites.
const NOISE_BIAS = 1.35;
const OVERSUBTRACT = 2.7; // then take somewhat more than the estimate
const GAIN_FLOOR = 0.1; // -20 dB; never fully mute, dead silence misleads the model too
// Smallest overlapped window energy away from the clip edges — Hann at 50%
// overlap sums to between this and 1.
const MIN_WINDOW_ENERGY = 0.5;

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

// Clean up and lift one captured clip. Returns a new buffer; the input is left
// alone. Runs over the assembled clip rather than per chunk, which is what lets
// the noise floor be measured from the recording's own quiet frames.
export function enhanceCapture(pcm: Uint8Array, sampleRate: number, gain = CAPTURE_GAIN): Uint8Array {
  const count = Math.floor(pcm.byteLength / BYTES_PER_SAMPLE);
  if (count === 0) return pcm;

  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * BYTES_PER_SAMPLE, true) / 32768;

  highPass(samples, sampleRate);
  denoise(samples);

  const out = new Uint8Array(count * BYTES_PER_SAMPLE);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    outView.setInt16(i * BYTES_PER_SAMPLE, Math.round(softLimit(samples[i] * gain) * 32767), true);
  }
  return out;
}

// One-pole high-pass, in place.
function highPass(s: Float32Array, sampleRate: number): void {
  const a = Math.exp((-2 * Math.PI * HIGHPASS_HZ) / sampleRate);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < s.length; i++) {
    const x = s[i];
    prevOut = a * (prevOut + x - prevIn);
    prevIn = x;
    s[i] = prevOut;
  }
}

// Spectral subtraction, in place. Estimate how much noise sits in each
// frequency bin, then scale every bin of every frame by how far it stands above
// its own noise level.
//
// The estimate is per bin rather than per frame, and that is the whole point: a
// steady noise bed is present in its bins in *every* frame, while speech only
// ever occupies a bin some of the time. So the noise floor can be read off the
// clip without needing to find a silent stretch first — which matters here,
// because push-to-talk clips are often wall-to-wall speech with no pause to
// measure. It also means noise sitting *underneath* speech is removed, which a
// frame-level gate cannot do at all: a gate can only squelch the pauses.
function denoise(s: Float32Array): void {
  const n = FFT_SIZE;
  const hop = n / 2;
  const bins = n / 2 + 1;
  const frames = Math.ceil((s.length - n) / hop) + 1;
  if (frames < 4) return; // too little to estimate from; leave the clip alone

  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);

  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const mag = new Float32Array(frames * bins);

  for (let f = 0; f < frames; f++) {
    loadFrame(s, f * hop, win, re, im);
    fft(re, im);
    for (let b = 0; b < bins; b++) mag[f * bins + b] = Math.hypot(re[b], im[b]);
  }

  // A percentile rather than the minimum, so one freak frame doesn't set the
  // floor for the whole bin.
  const noise = new Float32Array(bins);
  const column = new Float32Array(frames);
  const rank = Math.floor((frames - 1) * NOISE_PERCENTILE);
  for (let b = 0; b < bins; b++) {
    for (let f = 0; f < frames; f++) column[f] = mag[f * bins + b];
    column.sort();
    noise[b] = column[rank] * NOISE_BIAS;
  }

  const out = new Float32Array(s.length);
  const norm = new Float32Array(s.length);
  const gain = new Float32Array(bins);
  const smoothed = new Float32Array(bins);

  for (let f = 0; f < frames; f++) {
    for (let b = 0; b < bins; b++) {
      const m = mag[f * bins + b];
      const power = m * m;
      const noisePower = OVERSUBTRACT * noise[b] * noise[b];
      const g = power > 0 ? Math.sqrt(Math.max(0, power - noisePower) / power) : 0;
      gain[b] = Math.min(1, Math.max(GAIN_FLOOR, g));
    }
    // Smear the gain across neighbouring bins. Bins that swing independently
    // frame to frame leave behind "musical noise" — little tones warbling in
    // the background — which is more distracting than the hiss it replaced.
    for (let b = 0; b < bins; b++) {
      smoothed[b] = (gain[Math.max(0, b - 1)] + gain[b] + gain[Math.min(bins - 1, b + 1)]) / 3;
    }

    const start = f * hop;
    loadFrame(s, start, win, re, im);
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      re[b] *= smoothed[b];
      im[b] *= smoothed[b];
      // Mirror as a conjugate so the inverse transform comes back real.
      if (b > 0 && b < n / 2) {
        re[n - b] = re[b];
        im[n - b] = -im[b];
      }
    }
    inverseFft(re, im);

    // Weighted overlap-add. Dividing by the accumulated window energy at the
    // end makes this exact everywhere, including the partial frames at each
    // edge of the clip.
    for (let j = 0; j < n; j++) {
      const i = start + j;
      if (i >= s.length) break;
      out[i] += re[j] * win[j];
      norm[i] += win[j] * win[j];
    }
  }

  // Overlapping frames sum to at least MIN_WINDOW_ENERGY everywhere except the
  // first and last half-frame, where only one frame reaches and the sum tails
  // off to nothing. Clamping the divisor there fades those few ms in and out
  // instead of dividing by ~0 and firing a loud transient into the clip.
  for (let i = 0; i < s.length; i++) s[i] = out[i] / Math.max(norm[i], MIN_WINDOW_ENERGY);
}

// Window one frame into the FFT buffers, zero-padding past the end of the clip.
function loadFrame(s: Float32Array, start: number, win: Float32Array, re: Float32Array, im: Float32Array): void {
  for (let j = 0; j < win.length; j++) {
    const i = start + j;
    re[j] = i < s.length ? s[i] * win[j] : 0;
    im[j] = 0;
  }
}

// In-place iterative radix-2 FFT; length must be a power of two.
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < half; j++) {
        const k = i + j + half;
        const vr = re[k] * cr - im[k] * ci;
        const vi = re[k] * ci + im[k] * cr;
        re[k] = re[i + j] - vr;
        im[k] = im[i + j] - vi;
        re[i + j] += vr;
        im[i + j] += vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function inverseFft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

// Soft limiter. Untouched below the knee — so the gain really is the gain for
// ordinary speech — then the curve bends and asymptotes at full scale, so a hot
// peak compresses instead of clipping.
function softLimit(x: number): number {
  const a = Math.abs(x);
  if (a <= LIMIT_KNEE) return x;
  const y = LIMIT_KNEE + (1 - LIMIT_KNEE) * Math.tanh((a - LIMIT_KNEE) / (1 - LIMIT_KNEE));
  return x < 0 ? -y : y;
}
