// Energy-based speech segmenter.
//
// The glasses push a continuous stream of 16 kHz / 16-bit mono PCM chunks. To get
// readable transcripts we don't want to slice on a fixed clock (that cuts words in
// half); instead we accumulate audio while the user is talking and flush a segment
// when they pause (a run of low-energy audio) or when a segment grows too long.

import { rms, concatBytes } from "./audioUtils";

export interface SegmenterOptions {
  sampleRate: number;
  /** RMS below this (on the 0..32767 scale) counts as silence. */
  silenceThreshold?: number;
  /** Trailing silence that closes a segment, in ms. */
  silenceHangoverMs?: number;
  /** Ignore segments shorter than this, in ms (filters out coughs/clicks). */
  minSegmentMs?: number;
  /** Force a flush once a segment reaches this length, in ms. */
  maxSegmentMs?: number;
  /** Called with the segment's PCM bytes when a segment closes. */
  onSegment: (pcm: Uint8Array) => void;
}

const BYTES_PER_SAMPLE = 2;

export class SpeechSegmenter {
  private readonly sampleRate: number;
  private readonly silenceThreshold: number;
  private readonly silenceHangoverBytes: number;
  private readonly minSegmentBytes: number;
  private readonly maxSegmentBytes: number;
  private readonly onSegment: (pcm: Uint8Array) => void;

  private chunks: Uint8Array[] = [];
  private bufferedBytes = 0;
  private speaking = false;
  private trailingSilenceBytes = 0;

  constructor(opts: SegmenterOptions) {
    this.sampleRate = opts.sampleRate;
    this.silenceThreshold = opts.silenceThreshold ?? 500;
    this.onSegment = opts.onSegment;
    const bytesPerMs = (this.sampleRate * BYTES_PER_SAMPLE) / 1000;
    this.silenceHangoverBytes = Math.round((opts.silenceHangoverMs ?? 700) * bytesPerMs);
    this.minSegmentBytes = Math.round((opts.minSegmentMs ?? 400) * bytesPerMs);
    this.maxSegmentBytes = Math.round((opts.maxSegmentMs ?? 10000) * bytesPerMs);
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const loud = rms(chunk) >= this.silenceThreshold;

    if (loud) {
      this.speaking = true;
      this.trailingSilenceBytes = 0;
    } else if (this.speaking) {
      this.trailingSilenceBytes += chunk.byteLength;
    } else {
      // Silence before any speech started — don't buffer leading dead air.
      return;
    }

    this.chunks.push(chunk);
    this.bufferedBytes += chunk.byteLength;

    const longPause = this.trailingSilenceBytes >= this.silenceHangoverBytes;
    const tooLong = this.bufferedBytes >= this.maxSegmentBytes;
    if (longPause || tooLong) this.flush();
  }

  /** Emit whatever is buffered (e.g. when the mic is turned off). */
  flush(): void {
    if (this.bufferedBytes >= this.minSegmentBytes) {
      this.onSegment(concatBytes(this.chunks, this.bufferedBytes));
    }
    this.chunks = [];
    this.bufferedBytes = 0;
    this.speaking = false;
    this.trailingSilenceBytes = 0;
  }
}
