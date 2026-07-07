import { waitForEvenAppBridge, OsEventTypeList, EventSourceType } from "@evenrealities/even_hub_sdk";
import { createDisplay } from "./glassesui/glasses";
import { createWebUI, type WebUI } from "./webui/webui";
import { connectSc } from "./services/sc";
import { transcribe } from "./utils/transcribe";
import { int16ToFloat32, float32ToInt16 } from "./utils/audio";
import { trailingPrompt, stripTrailingPrompt } from "./utils/text";

const SAMPLE_RATE = 16000;
const TERMINAL_MAX = 4000;
const WEB_LOG_MAX = 100000;

// Push-to-talk: a tap starts recording, a second tap stops it and submits.
// Safety cap so a forgotten mic doesn't record forever — at this point the
// recording is stopped and submitted as if the user had tapped.
const MAX_RECORDING_MS = 60000;
// Discard clips shorter than this (accidental double taps, no real speech).
const MIN_RECORDING_MS = 250;
// Gain multiplier applied before transcription — the glasses mic is quiet.
const GAIN_FACTOR = 20;

async function main() {
  const bridge = await waitForEvenAppBridge();
  const display = await createDisplay(bridge);

  let terminal = "";
  let webLog = "";
  let statusText = "";
  let sttLanguage = ""; // ISO-639-1 hint; "" = auto-detect

  // The CLI prompt (e.g. "gpt-5.5> ") captured from the last reply, so we can keep
  // it on screen when we clear for a new conversation.
  let lastPrompt = "";

  let generating = false;
  let transcriptionEnabled = true;
  let micMuted = false;

  // Set to true on reset so that stale in-flight chunks from the previous
  // generation are discarded until the server's :reset reply arrives.
  let discardChunks = false;

  let draft = "";

  // Assigned once createWebUI resolves. Declared up front (and accessed with `?.`)
  // because callbacks passed to createWebUI can fire during its setup, before this
  // is assigned; the glasses still render in the meantime.
  let ui: WebUI | undefined;

  function renderAll() {
    const preview = draft && !generating;
    const webView = preview ? stripTrailingPrompt(webLog) + `${lastPrompt}${draft}` : webLog;
    let glassesView: string;
    if (preview) glassesView = terminal ? `${terminal}${lastPrompt}${draft}` : `${lastPrompt}${draft}`;
    else if (generating) glassesView = terminal;
    else glassesView = terminal ? `${terminal}${lastPrompt}` : lastPrompt;
    const cursorOn = !generating;
    ui?.setCursor(cursorOn);
    display.setCursor(cursorOn);
    ui?.render(webView);
    void display.render({ status: statusText, text: glassesView, history: webLog });
  }

  function emit(text: string) {
    terminal = (terminal + text).slice(-TERMINAL_MAX);
    webLog = (webLog + text).slice(-WEB_LOG_MAX);
    renderAll();
  }

  function setStatus(text: string) {
    statusText = text;
    ui?.setStatus(text);
    renderAll();
  }

  // --- push-to-talk recorder ----------------------------------------------
  // The mic is off by default. A glasses tap opens it and raw PCM chunks are
  // accumulated here; a second tap (or the MAX_RECORDING_MS cap) closes the mic
  // and the whole clip is transcribed in one request, then submitted.
  let recording = false;
  let recordedChunks: Uint8Array[] = [];
  let recordedBytes = 0;
  let recordingTimer = 0;

  // Status shown when the app is idle and ready for a tap.
  function idleStatus(): string {
    return transcriptionEnabled && !micMuted ? "● tap to talk" : "";
  }

  // Show a transient status, then fall back to the idle hint.
  function flashStatus(text: string, durationMs = 2000) {
    setStatus(text);
    window.setTimeout(() => {
      if (statusText === text && !recording && !generating) setStatus(idleStatus());
    }, durationMs);
  }

  async function startRecording() {
    if (recording || generating || !transcriptionEnabled || micMuted) return;
    recording = true;
    recordedChunks = [];
    recordedBytes = 0;
    setStatus("● recording");
    const isMicReady = await bridge.audioControl(true);
    if (!recording) return; // cancelled while waiting for audioControl
    if (!isMicReady) {
      recording = false;
      flashStatus("● mic failed");
      return;
    }
    recordingTimer = window.setTimeout(() => void finishRecording(), MAX_RECORDING_MS);
  }

  // Stop the mic and submit whatever was captured.
  async function finishRecording() {
    if (!recording) return;
    recording = false;
    window.clearTimeout(recordingTimer);
    void bridge.audioControl(false);

    const pcm = new Uint8Array(recordedBytes);
    let offset = 0;
    for (const chunk of recordedChunks) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }
    recordedChunks = [];
    recordedBytes = 0;

    const minBytes = (MIN_RECORDING_MS / 1000) * SAMPLE_RATE * 2;
    if (pcm.byteLength < minBytes) {
      setStatus(idleStatus());
      return;
    }

    setStatus("● transcribing");
    try {
      const text = await transcribe(applyGain(pcm), SAMPLE_RATE, sttLanguage || undefined);
      // State moved on while transcribing (typed submit, new recording, typing
      // in progress) — typing and newer input take over, so drop the result.
      if (generating || recording) return;
      if (draft) {
        setStatus(idleStatus());
        return;
      }
      if (text) ask(text);
      else flashStatus("● no speech");
    } catch (err) {
      console.error("transcribe error:", err);
      flashStatus("● transcribe failed");
    }
  }

  // Stop the mic and discard the captured audio (typing took over, reset, mute…).
  // Callers set their own status afterwards.
  function cancelRecording() {
    if (!recording) return;
    recording = false;
    window.clearTimeout(recordingTimer);
    recordedChunks = [];
    recordedBytes = 0;
    void bridge.audioControl(false);
  }

  function applyGain(pcm: Uint8Array): Uint8Array {
    const f32 = int16ToFloat32(pcm);
    for (let i = 0; i < f32.length; i++) {
      f32[i] = Math.max(-1, Math.min(1, f32[i] * GAIN_FACTOR));
    }
    return float32ToInt16(f32);
  }

  // Auto-login is deferred until the CLI is ready: a login sent before the `sc`
  // process has started and printed its first prompt is lost, so we hold the saved
  // credentials here and send them on the first `onReady` (when "gpt-5.5>" shows).
  let scReady = false;
  let pendingLogin: { username: string; password: string } | null = null;
  let pendingLangCommand: string | null = null;

  const sc = connectSc({
    onChunk: (text) => {
      if (!discardChunks) emit(text);
    },
    onReady: () => {
      const wasDiscarding = discardChunks;
      discardChunks = false;
      if (!scReady) scReady = true;
      // The CLI just printed its prompt. Remember it (so a cleared screen still shows
      // it), then strip it from the glasses buffer — this is the one moment we know
      // the trailing `>` is a prompt and not part of a reply (e.g. `x -> `).
      const prompt = trailingPrompt(terminal);
      if (prompt) {
        lastPrompt = prompt;
        terminal = stripTrailingPrompt(terminal);
        renderAll();
      }
      if (generating) {
        generating = false;
        if (wasDiscarding) {
          // The reset discarded the server's reply (including the new prompt).
          // Manually append lastPrompt to webLog so the web UI shows it.
          webLog = (webLog + lastPrompt).slice(-WEB_LOG_MAX);
        }
        setStatus(idleStatus()); // clear "● generating", show the tap-to-talk hint
      }
      // Flush any queued login AFTER the prompt is rendered, so echoLogin sees the
      // correct lastPrompt and the "gpt-5.5>" line appears before the :login echo.
      if (pendingLogin) {
        echoLogin(pendingLogin.username, pendingLogin.password);
        void sc.login(pendingLogin.username, pendingLogin.password);
        pendingLogin = null;
      } else if (pendingLangCommand) {
        ask(pendingLangCommand);
        pendingLangCommand = null;
      }
    },
    onUnavailable: () => emit("\n[sc bridge unavailable — run `npm run dev`]\n"),
  });

  function ask(text: string) {
    draft = "";
    display.followLive();
    terminal = (terminal + `${lastPrompt}${text}\n`).slice(-TERMINAL_MAX);
    // Strip any trailing prompt and re-add lastPrompt explicitly — the previous reply
    // usually leaves the prompt at the tail of the log, but not always (e.g. the very
    // first input), and this prevents duplicating it.
    const stripped = stripTrailingPrompt(webLog);
    webLog = (stripped + `${lastPrompt}${text}\n`).slice(-WEB_LOG_MAX);
    generating = true;
    cancelRecording(); // a typed submit while recording discards the mic capture
    setStatus("● generating");
    void sc.send(text);
  }

  function echoLogin(username: string, password: string) {
    const masked = "*".repeat(password.length);
    const line = `:login ${username} ${masked}\n`;
    display.followLive();
    terminal = (terminal + `${lastPrompt}${line}`).slice(-TERMINAL_MAX);
    const stripped = stripTrailingPrompt(webLog);
    webLog = (stripped + `${lastPrompt}${line}`).slice(-WEB_LOG_MAX);
    generating = true;
    cancelRecording();
    setStatus("");
  }

  function echoRegister(username: string, email: string, password: string) {
    const masked = "*".repeat(password.length);
    const line = `:user add ${username} ${email} ${masked}\n`;
    display.followLive();
    terminal = (terminal + `${lastPrompt}${line}`).slice(-TERMINAL_MAX);
    const stripped = stripTrailingPrompt(webLog);
    webLog = (stripped + `${lastPrompt}${line}`).slice(-WEB_LOG_MAX);
    generating = true;
    cancelRecording();
    setStatus("");
  }

  function reset() {
    draft = "";
    terminal = "";
    webLog = "";
    display.followLive();
    generating = true; // suppress lastPrompt appending until onReady fires
    discardChunks = true; // drop in-flight chunks from the previous generation
    cancelRecording();
    setStatus("");
    emit(":help for help\n\n");
    void sc.send(":reset");
  }

  ui = await createWebUI(bridge, {
    onSubmit: (text) => ask(text),
    onRefresh: () => reset(),
    onInput: (text) => {
      draft = text;
      if (text) display.followLive();
      // Typing takes over from the mic: discard an in-progress recording on the
      // first keystroke so a typed message isn't competing with captured speech.
      if (text && recording) {
        cancelRecording();
        setStatus(idleStatus());
      }
      renderAll();
    },
    // Manual login (button) goes through immediately — the CLI is already idle by
    // then. Startup auto-login fires before the CLI is ready, so it's queued and
    // sent on the first onReady above.
    onLogin: (username, password) => {
      if (scReady) {
        echoLogin(username, password);
        void sc.login(username, password);
      } else {
        pendingLogin = { username, password };
      }
    },
    onRegister: (username, email, password) => {
      echoRegister(username, email, password);
      void sc.send(`:user add ${username} ${email} ${password}`);
    },
    onLanguageChange: (language) => {
      sttLanguage = language;
    },
    onLangCommand: (lang) => {
      pendingLangCommand = lang ? `:lang use ${lang}` : `:lang reset`;
    },
    onCursorBlinkChange: (blink) => {
      display.setCursorBlink(blink);
    },
    onTranscriptionChange: (enabled) => {
      transcriptionEnabled = enabled;
      if (!enabled) cancelRecording();
      if (!generating) setStatus(idleStatus());
    },
    onMuteChange: (muted) => {
      micMuted = muted;
      if (muted) cancelRecording();
      if (!generating) setStatus(idleStatus());
    },
  });

  // Callbacks above may have set the status before `ui` existed — sync it now.
  ui.setStatus(statusText);

  // Even app bridge events
  bridge.onEvenHubEvent((event) => {
    const eventType = event.textEvent?.eventType ?? event.listEvent?.eventType ?? event.sysEvent?.eventType;

    // Scroll top
    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      void display.showPreviousView();
      return;
    }

    // Scroll bottom
    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      void display.showNextView();
      return;
    }

    // Single-tap — push-to-talk.
    // Arrives as a sysEvent with only an `eventSource` and no `eventType`
    // — the host doesn't emit CLICK_EVENT for it. (The glasses OS reserves
    // long-press, so a tap is the only press gesture available to the app.)
    //   idle       → start recording
    //   recording  → stop recording, transcribe the clip, submit
    //   generating → ignored
    const eventSource = event.sysEvent?.eventSource;
    if (eventType == null && eventSource != null && eventSource !== EventSourceType.TOUCH_EVENT_FORM_DUMMY_NULL) {
      if (recording) void finishRecording();
      else if (!generating) void startRecording();
      return;
    }

    // Double-tap — reset the conversation (works in any state; also cancels an
    // in-progress recording or generation output).
    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      reset();
      return;
    }

    // System exit
    if (eventType === OsEventTypeList.SYSTEM_EXIT_EVENT || eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      void shutdown();
      return;
    }

    // Audio PCM (Pulse-Code Modulation)
    const pcm = event.audioEvent?.audioPcm;
    if (pcm && pcm.byteLength > 0) {
      if (!recording) return;
      // Copy — the bridge may reuse the underlying buffer between events.
      recordedChunks.push(pcm.slice());
      recordedBytes += pcm.byteLength;
    }
  });

  // Exit — no in-app gesture triggers this anymore (double-tap now resets);
  // the host still fires SYSTEM_EXIT_EVENT when the user exits via the glasses OS.
  async function shutdown() {
    cancelRecording();
    await bridge.audioControl(false);
    await bridge.shutDownPageContainer(0); // 0 = exit immediately (post-confirmation cleanup)
  }
}

main().catch(console.error);
