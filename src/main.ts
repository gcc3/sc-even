import { waitForEvenAppBridge, OsEventTypeList, EventSourceType } from "@evenrealities/even_hub_sdk";
import { createDisplay } from "./glassesui/glasses";
import { createWebUI, type WebUI } from "./webui/webui";
import { connectSc } from "./services/sc";
import { SpeechSegmenter } from "./utils/segmenter";
import { transcribe } from "./utils/transcribe";
import { trailingPrompt, stripTrailingPrompt } from "./utils/text";

const SAMPLE_RATE = 16000;
const TERMINAL_MAX = 4000;
const WEB_LOG_MAX = 100000;

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
  let listening = false;
  let transcriptionEnabled = true;
  let segmenterReady = false;

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

  async function startListening() {
    if (!transcriptionEnabled) return;
    // Voice transcription needs the OpenAI key. Never enable the mic or show
    // "listening" without one — guard here so every caller (startup, and onReady
    // after a typed exchange) is covered.
    if (!segmenterReady) {
      setStatus("● loading VAD");
      try {
        await segmenter.init();
        segmenterReady = true;
      } catch (err) {
        console.error("Segmenter init failed:", err);
        setStatus("● VAD init failed");
        return;
      }
      if (!transcriptionEnabled) return; // disabled while loading
    }

    const isMicReady = await bridge.audioControl(true);
    if (!transcriptionEnabled) return; // disabled while waiting for audioControl

    listening = isMicReady;
    setStatus(isMicReady ? "● listening" : "● mic failed");
  }

  async function stopListening() {
    listening = false;
    utteranceDone = false;
    pendingSegments.clear();
    setStatus("");
    await bridge.audioControl(false);
  }

  // Auto-login is deferred until the CLI is ready: a login sent before the `sc`
  // process has started and printed its first prompt is lost, so we hold the saved
  // credentials here and send them on the first `onReady` (when "gpt-5.5>" shows).
  let scReady = false;
  let pendingLogin: { username: string; password: string } | null = null;
  let pendingLangCommand: string | null = null;

  // Glasses single-tap confirmation state: first tap shows a prompt, second
  // tap within the window confirms the reset.
  let pendingReset = false;
  let pendingResetTimer = 0;

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
        renderAll(); // show cursor immediately, regardless of whether listening starts
        void startListening();
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
    void stopListening(); // clears the status; set "generating" after so it wins
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
    void stopListening();
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
    void stopListening();
    setStatus("");
  }

  function reset() {
    draft = "";
    terminal = "";
    webLog = "";
    display.followLive();
    generating = true; // suppress lastPrompt appending until onReady fires
    discardChunks = true; // drop in-flight chunks from the previous generation
    void stopListening();
    setStatus("");
    emit(":help for help\n\n");
    void sc.send(":reset");
  }

  // Accumulate transcribed segments and submit them together once all in-flight
  // transcriptions for a single utterance are done.
  let nextSeq = 0;
  let pendingCount = 0;
  let utteranceDone = false; // set by onUtteranceEnd; gates submission
  const pendingSegments = new Map<number, string>(); // seq → transcribed text

  // Submit only when the segmenter has signalled end-of-utterance AND all
  // in-flight transcriptions have completed. This prevents a race where the
  // first segment's transcription finishes before the second segment is even
  // queued, causing a single sentence to be sent as two separate messages.
  function trySubmit() {
    if (pendingCount > 0) return;
    if (!utteranceDone) return;
    utteranceDone = false;
    if (pendingSegments.size > 0) {
      const combined = [...pendingSegments.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, t]) => t)
        .join(" ");
      pendingSegments.clear();
      ask(combined);
      return;
    }
    // Nothing to submit (silence / unintelligible audio) — resume listening
    // unless the AI is already generating a response.
    if (!generating) void startListening();
  }

  const segmenter = new SpeechSegmenter({
    sampleRate: SAMPLE_RATE,
    onSegment: (pcm) => {
      const seq = nextSeq++;
      pendingCount++;
      void handleSegment(pcm, seq);
    },
    onUtteranceEnd: () => {
      // Stop the mic immediately — the utterance is done. Preserve pendingSegments
      // and utteranceDone so in-flight transcriptions can still complete and submit.
      listening = false;
      void bridge.audioControl(false);
      utteranceDone = true;
      trySubmit();
    },
  });

  async function handleSegment(pcm: Uint8Array, seq: number) {
    if (!listening) {
      pendingCount--;
      return;
    }

    setStatus("● transcribing");
    try {
      const text = await transcribe(pcm, SAMPLE_RATE, sttLanguage || undefined);
      if (!listening && !utteranceDone) {
        // Full stop (e.g. user started typing): discard. But if utteranceDone is
        // true we only paused the mic — let this transcription complete and submit.
        pendingCount--;
        if (pendingCount === 0) pendingSegments.clear();
        return;
      }
      if (text) pendingSegments.set(seq, text);
    } catch (err) {
      console.error("transcribe error:", err);
    }

    pendingCount--;
    trySubmit();
  }

  ui = await createWebUI(bridge, {
    onSubmit: (text) => ask(text),
    onRefresh: () => reset(),
    onInput: (text) => {
      draft = text;
      if (text) display.followLive();
      // Typing takes over from the mic: stop listening on the first keystroke so a
      // typed message isn't competing with captured speech. Resume when cleared.
      if (text && listening) void stopListening();
      else if (!text && !listening && !generating) void startListening();
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
      if (enabled) void startListening();
      else void stopListening();
    },
    onMuteChange: (muted) => {
      if (muted) void stopListening();
      else void startListening();
    },
  });

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

    // Single-tap
    // Arrives as a sysEvent with only an `eventSource` and no `eventType`
    // — the host doesn't emit CLICK_EVENT for it. First tap shows a confirmation
    // prompt; a second tap within 3 s confirms the reset.
    const eventSource = event.sysEvent?.eventSource;
    if (eventType == null && eventSource != null && eventSource !== EventSourceType.TOUCH_EVENT_FORM_DUMMY_NULL) {
      if (pendingReset) {
        window.clearTimeout(pendingResetTimer);
        pendingReset = false;
        reset();
      } else {
        pendingReset = true;
        const savedStatus = statusText;
        setStatus("Tap again to reset");
        pendingResetTimer = window.setTimeout(() => {
          pendingReset = false;
          setStatus(savedStatus);
        }, 3000);
      }
      return;
    }

    // Double-tap
    // Asks the host to raise its exit confirmation dialog; actual teardown
    // happens when SYSTEM_EXIT_EVENT fires below.
    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void requestExit();
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
      if (!listening) return;
      segmenter.push(pcm);
    }
  });

  // Exit
  async function requestExit() {
    await bridge.shutDownPageContainer(1); // 1 = show the "exit?" interaction layer
  }

  async function shutdown() {
    await stopListening();
    await bridge.shutDownPageContainer(0); // 0 = exit immediately (post-confirmation cleanup)
  }
}

main().catch(console.error);
