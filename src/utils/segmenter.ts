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
  /** Trailing silence that flushes a segment, in ms. Starts transcription early. */
  silenceHangoverMs?: number;
  /** Ignore segments shorter than this, in ms (filters out coughs/clicks). */
  minSegmentMs?: number;
  /**
   * Require at least this much *voiced* (above-threshold) audio, in ms, before a
   * segment is emitted. A buffer that's mostly silence with a stray loud blip is
   * dropped — this is what stops Whisper hallucinating "You" / "ご視聴…" on noise.
   */
  minVoicedMs?: number;
  /** Force a flush once a segment reaches this length, in ms. */
  maxSegmentMs?: number;
  /** Called with the segment's PCM bytes when a segment closes. */
  onSegment: (pcm: Uint8Array) => void;
  /**
   * Total silence (measured continuously across segment flushes) after which the
   * utterance is considered complete. Must be >= silenceHangoverMs. Defaults to
   * 1200 ms — long enough that mid-sentence pauses don't cut the user off, but
   * short enough to feel responsive.
   */
  utteranceSilenceMs?: number;
  /**
   * Called once utteranceSilenceMs of continuous silence has elapsed since the
   * last voiced audio. Not called for force-flushes (maxSegmentMs).
   */
  onUtteranceEnd?: () => void;
}

const BYTES_PER_SAMPLE = 2;

export class SpeechSegmenter {
  private readonly sampleRate: number;
  private readonly silenceThreshold: number;
  private readonly silenceHangoverBytes: number;
  private readonly minSegmentBytes: number;
  private readonly minVoicedBytes: number;
  private readonly maxSegmentBytes: number;
  private readonly utteranceSilenceBytes: number;
  private readonly onSegment: (pcm: Uint8Array) => void;
  private readonly onUtteranceEnd: (() => void) | undefined;

  private chunks: Uint8Array[] = [];
  private bufferedBytes = 0;
  private voicedBytes = 0;
  private speaking = false;
  private trailingSilenceBytes = 0;

  // Tracks silence continuously across segment flushes for utterance-end detection.
  private hasSpeech = false;
  private silenceSinceLastVoice = 0;
  private utteranceEndFired = false;

  constructor(opts: SegmenterOptions) {
    this.sampleRate = opts.sampleRate;
    this.silenceThreshold = opts.silenceThreshold ?? 500;
    this.onSegment = opts.onSegment;
    this.onUtteranceEnd = opts.onUtteranceEnd;
    const bytesPerMs = (this.sampleRate * BYTES_PER_SAMPLE) / 1000;
    this.silenceHangoverBytes = Math.round((opts.silenceHangoverMs ?? 700) * bytesPerMs);
    this.minSegmentBytes = Math.round((opts.minSegmentMs ?? 400) * bytesPerMs);
    this.minVoicedBytes = Math.round((opts.minVoicedMs ?? 300) * bytesPerMs);
    this.maxSegmentBytes = Math.round((opts.maxSegmentMs ?? 10000) * bytesPerMs);
    this.utteranceSilenceBytes = Math.round((opts.utteranceSilenceMs ?? 1200) * bytesPerMs);
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const loud = rms(chunk) >= this.silenceThreshold;

    if (loud) {
      this.speaking = true;
      this.hasSpeech = true;
      this.trailingSilenceBytes = 0;
      this.silenceSinceLastVoice = 0;
      this.utteranceEndFired = false;
      this.voicedBytes += chunk.byteLength;
      this.chunks.push(chunk);
      this.bufferedBytes += chunk.byteLength;
      if (this.bufferedBytes >= this.maxSegmentBytes) this.flush();
    } else if (this.speaking) {
      // Trailing silence within an active speaking window — buffer it and check
      // both the segment hangover and the utterance-end threshold.
      this.trailingSilenceBytes += chunk.byteLength;
      this.silenceSinceLastVoice += chunk.byteLength;
      this.chunks.push(chunk);
      this.bufferedBytes += chunk.byteLength;
      if (this.trailingSilenceBytes >= this.silenceHangoverBytes || this.bufferedBytes >= this.maxSegmentBytes) {
        this.flush();
      }
      this.checkUtteranceEnd();
    } else if (this.hasSpeech) {
      // Post-flush silence: don't buffer (no active segment), but keep accumulating
      // silence so the utterance-end timer can fire after silenceHangoverMs has
      // already elapsed and flushed the last segment.
      this.silenceSinceLastVoice += chunk.byteLength;
      this.checkUtteranceEnd();
    }
    // else: leading silence before any speech — discard
  }

  /** Emit whatever is buffered (e.g. when the mic is turned off). */
  flush(): void {
    // Require both enough total audio AND enough voiced audio — a buffer that's
    // long but mostly silence (a stray blip + dead air) is dropped, since that's
    // exactly what makes Whisper hallucinate canned phrases.
    if (this.bufferedBytes >= this.minSegmentBytes && this.voicedBytes >= this.minVoicedBytes) {
      this.onSegment(concatBytes(this.chunks, this.bufferedBytes));
    }
    this.chunks = [];
    this.bufferedBytes = 0;
    this.voicedBytes = 0;
    this.speaking = false;
    this.trailingSilenceBytes = 0;
    // hasSpeech / silenceSinceLastVoice / utteranceEndFired are intentionally
    // preserved — utterance-end detection spans across segment flushes.
  }

  private checkUtteranceEnd(): void {
    if (!this.utteranceEndFired && this.silenceSinceLastVoice >= this.utteranceSilenceBytes) {
      this.utteranceEndFired = true;
      this.hasSpeech = false;
      this.silenceSinceLastVoice = 0;
      this.onUtteranceEnd?.();
    }
  }
}
