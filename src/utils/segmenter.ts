// Silero-VAD-based speech segmenter.
//
// The glasses push a continuous stream of 16 kHz / 16-bit mono PCM chunks.
// Chunks are buffered into 512-sample (32 ms) frames and fed to the Silero VAD
// neural-network model via onnxruntime-web. The FrameProcessor handles speech
// start/end detection; we layer utterance-end detection and max-segment
// clamping on top.

import { FrameProcessor } from "@ricky0123/vad-web/dist/frame-processor";
import { Message } from "@ricky0123/vad-web/dist/messages";
import { SileroV5 } from "@ricky0123/vad-web/dist/models";
import { defaultModelFetcher } from "@ricky0123/vad-web/dist/default-model-fetcher";
import * as ort from "onnxruntime-web/wasm";
import { int16ToFloat32, float32ToInt16 } from "./audio";

export interface SegmenterOptions {
  sampleRate: number;
  /** Trailing silence that ends a segment, in ms. Default 700 ms. */
  silenceHangoverMs?: number;
  /** Minimum voiced speech to emit a segment, in ms. Default 300 ms. */
  minVoicedMs?: number;
  /** Force-flush a segment at this length, in ms. Default 10 000 ms. */
  maxSegmentMs?: number;
  /**
   * Total silence after the last segment that ends the utterance, in ms.
   * Default 1 200 ms.
   */
  utteranceSilenceMs?: number;
  onSegment: (pcm: Uint8Array) => void;
  onUtteranceEnd?: () => void;
}

// Silero processes exactly 512 samples per frame at 16 kHz (32 ms/frame).
const FRAME_SAMPLES = 512;

export class SpeechSegmenter {
  private processor: FrameProcessor | undefined;
  private readonly frameBuf = new Float32Array(FRAME_SAMPLES);
  private frameOffset = 0;
  private processingChain: Promise<void> = Promise.resolve();

  private speaking = false;
  private speechFrameCount = 0;
  private readonly maxFrames: number;

  private utteranceTimer: ReturnType<typeof setTimeout> | null = null;
  private hasSpeechSinceStart = false;
  private utteranceEndFired = false;
  private readonly utteranceSilenceMs: number;

  private readonly opts: SegmenterOptions;

  constructor(opts: SegmenterOptions) {
    this.opts = opts;
    this.utteranceSilenceMs = opts.utteranceSilenceMs ?? 1200;
    const msPerFrame = (FRAME_SAMPLES / opts.sampleRate) * 1000;
    this.maxFrames = Math.ceil((opts.maxSegmentMs ?? 10000) / msPerFrame);
  }

  async init(): Promise<void> {
    // Single-threaded mode avoids the SharedArrayBuffer / COOP-COEP requirement.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = "./";

    const msPerFrame = (FRAME_SAMPLES / this.opts.sampleRate) * 1000;
    const model = await SileroV5.new(ort, () =>
      defaultModelFetcher("silero_vad_v5.onnx"),
    );

    this.processor = new FrameProcessor(
      (frame) => model.process(frame),
      () => model.reset_state(),
      {
        positiveSpeechThreshold: 0.15,
        negativeSpeechThreshold: 0.1,
        preSpeechPadMs: 800,
        submitUserSpeechOnPause: false,
        redemptionMs: this.opts.silenceHangoverMs ?? 700,
        minSpeechMs: this.opts.minVoicedMs ?? 300,
      },
      msPerFrame,
    );
    this.processor.resume();
  }

  push(chunk: Uint8Array): void {
    if (!this.processor) return;
    const f32 = int16ToFloat32(chunk);
    let offset = 0;
    while (offset < f32.length) {
      const copy = Math.min(FRAME_SAMPLES - this.frameOffset, f32.length - offset);
      this.frameBuf.set(f32.subarray(offset, offset + copy), this.frameOffset);
      this.frameOffset += copy;
      offset += copy;
      if (this.frameOffset === FRAME_SAMPLES) {
        const frame = this.frameBuf.slice();
        this.frameOffset = 0;
        this.processingChain = this.processingChain
          .then(() => this.processFrame(frame))
          .catch((err) => console.error("processFrame error:", err));
      }
    }
  }

  flush(): void {
    if (!this.processor) return;
    if (this.frameOffset > 0) {
      const frame = this.frameBuf.slice();
      frame.fill(0, this.frameOffset);
      this.frameOffset = 0;
      this.processingChain = this.processingChain.then(() => this.processFrame(frame));
    }
    const proc = this.processor;
    this.processingChain = this.processingChain.then(() => {
      proc.endSegment((event) => {
        if (event.msg === Message.SpeechEnd) this.emitSegment(event.audio);
      });
    });
  }

  private async processFrame(frame: Float32Array): Promise<void> {
    if (!this.processor) return;

    await this.processor.process(frame, (event) => {
      if (event.msg === Message.SpeechStart) {
        this.speaking = true;
        this.speechFrameCount = 0;
        this.hasSpeechSinceStart = true;
        this.utteranceEndFired = false;
        if (this.utteranceTimer !== null) {
          clearTimeout(this.utteranceTimer);
          this.utteranceTimer = null;
        }
      } else if (event.msg === Message.SpeechEnd) {
        this.speaking = false;
        this.speechFrameCount = 0;
        this.emitSegment(event.audio);
        this.utteranceTimer = setTimeout(() => {
          this.utteranceTimer = null;
          if (!this.utteranceEndFired && this.hasSpeechSinceStart) {
            this.utteranceEndFired = true;
            this.hasSpeechSinceStart = false;
            this.opts.onUtteranceEnd?.();
          }
        }, this.utteranceSilenceMs);
      } else if (event.msg === Message.VADMisfire) {
        this.speaking = false;
        this.speechFrameCount = 0;
      }
    });

    // Enforce maxSegmentMs: force-end if a single speech burst runs too long.
    if (this.speaking) {
      this.speechFrameCount++;
      if (this.speechFrameCount >= this.maxFrames) {
        this.processor.endSegment((event) => {
          if (event.msg === Message.SpeechEnd) this.emitSegment(event.audio);
        });
        this.speaking = false;
        this.speechFrameCount = 0;
        // Start the utterance timer just like a natural SpeechEnd does. If the
        // user keeps talking a SpeechStart will clear it; if they've stopped it
        // fires onUtteranceEnd so trySubmit() can complete.
        if (this.utteranceTimer !== null) clearTimeout(this.utteranceTimer);
        this.utteranceTimer = setTimeout(() => {
          this.utteranceTimer = null;
          if (!this.utteranceEndFired && this.hasSpeechSinceStart) {
            this.utteranceEndFired = true;
            this.hasSpeechSinceStart = false;
            this.opts.onUtteranceEnd?.();
          }
        }, this.utteranceSilenceMs);
      }
    }
  }

  private emitSegment(audio: Float32Array): void {
    if (audio.length > 0) this.opts.onSegment(float32ToInt16(audio));
  }
}
