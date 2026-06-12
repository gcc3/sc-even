import { waitForEvenAppBridge, OsEventTypeList, EventSourceType } from "@evenrealities/even_hub_sdk";
import { createDisplay } from "./glassesui/glasses";
import { createWebUI, type WebUI } from "./webui/webui";
import { connectSc } from "./utils/scUtils";
import { SpeechSegmenter } from "./utils/speechUtils";
import { hasApiKey, setApiKey, transcribe } from "./utils/transcribeUtils";
import { trailingPrompt, stripTrailingPrompt } from "./utils/textUtils";
import { msg } from "./i18n";

// The glasses mic streams single-channel 16 kHz / 16-bit PCM.
const SAMPLE_RATE = 16000;

// Keep the terminal buffer bounded; the glasses only show the tail anyway.
const TERMINAL_MAX = 4000;

// The web view keeps the full conversation history, so it gets a larger buffer.
const WEB_LOG_MAX = 100000;

async function main() {
  const bridge = await waitForEvenAppBridge();
  const display = await createDisplay(bridge);

  // The glasses show only the current exchange (`terminal`), while the web view
  // keeps the full scrollback (`webLog`). Both are fed from the same output.
  let terminal = "";
  let webLog = "";
  let statusText = "";
  let sttLanguage = ""; // ISO-639-1 hint from Settings; "" = auto-detect.
  // The CLI prompt (e.g. "gpt-5.5> ") captured from the last reply, so we can keep
  // it on screen when we clear for a new conversation.
  let lastPrompt = "";

  // While `sc` is producing a reply we stop listening and follow the newest output
  // on the glasses; `listening` gates audio so nothing is captured meanwhile.
  let generating = false;
  let listening = false;
  let transcriptionEnabled = true;

  // The in-progress line typed in the web input box. Mirrored live to both views
  // (prefixed with the prompt) so the glasses show what's being typed before submit.
  let draft = "";

  // Assigned once createWebUI resolves. Declared up front (and accessed with `?.`)
  // because callbacks passed to createWebUI — e.g. onApiKeyChange — can fire during
  // its setup, before this is assigned; the glasses still render in the meantime.
  let ui: WebUI | undefined;

  // Render both views from the current buffers, overlaying the live draft line.
  // While idle and typing, we preview the line exactly as `ask` would echo it:
  // the model prompt followed by the in-progress text. During generation we leave
  // the streaming reply alone.
  function renderAll() {
    const preview = draft && !generating;
    const webView = preview ? stripTrailingPrompt(webLog) + `${lastPrompt}${draft}` : webLog;
    // On the glasses: show the in-progress draft while typing, the raw stream while
    // generating, and otherwise the conversation with the waiting prompt (e.g.
    // "gpt-5.5>") pinned at the end. The prompt is stripped from `terminal` once the CLI
    // is idle, so re-add it here — this also shows the model name before the first
    // exchange, when `terminal` is still empty.
    let glassesView: string;
    if (preview) glassesView = terminal ? `${terminal}${lastPrompt}${draft}` : `${lastPrompt}${draft}`;
    else if (generating) glassesView = terminal;
    else glassesView = terminal ? `${terminal}${lastPrompt}` : lastPrompt;
    const cursorOn = !generating;
    ui?.setCursor(cursorOn);
    display.setCursor(cursorOn);
    ui?.render(webView);
    // The glasses always render the last screenful, so the streaming reply stays in
    // view while generating and the tail — ending in the waiting "gpt-5.5>" prompt —
    // stays pinned to the bottom instead of jumping back to the top.
    // `webLog` is the full session transcript (cleared only on reset); hand it over as
    // the scrollback the touch bar pages through while `glassesView` is the live view.
    void display.render({ status: statusText, text: glassesView, history: webLog });
  }

  // Append CLI output to both buffers. They're independent: `terminal` is kept tidy
  // for the small glasses display (rendered as-is, no extra cleanup), while `webLog`
  // keeps the full raw scrollback for the web view.
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
    // Voice recognition needs the OpenAI key. Never enable the mic or show
    // "listening" without one — guard here so every caller (startup, and onReady
    // after a typed exchange) is covered.
    if (!hasApiKey()) {
      listening = false;
      setStatus("");
      return;
    }
    const ok = await bridge.audioControl(true);
    if (!transcriptionEnabled) return; // disabled while waiting for audioControl
    listening = ok;
    setStatus(ok ? "● listening" : "⚠ mic failed");
  }

  async function stopListening() {
    listening = false;
    setStatus(""); // clear the listening indicator while the mic is off
    await bridge.audioControl(false);
  }

  // Auto-login is deferred until the CLI is ready: a login sent before the `sc`
  // process has started and printed its first prompt is lost, so we hold the saved
  // credentials here and send them on the first `onReady` (when "gpt-5.5>" shows).
  let scReady = false;
  let pendingLogin: { username: string; password: string } | null = null;

  // The `sc` CLI bridge: stream its output into the terminal as it arrives.
  const sc = connectSc({
    onChunk: (text) => emit(text),
    onReady: () => {
      if (!scReady) scReady = true;
      // The CLI is idle, having just printed its prompt. Remember it (so a cleared
      // screen still shows it), then drop it from the glasses buffer — this is the
      // one moment we know the trailing `>` is the prompt and not part of a reply
      // (e.g. code like `x -> `), so it's safe to strip without a render-time guard.
      const prompt = trailingPrompt(terminal);
      if (prompt) {
        lastPrompt = prompt;
        // Strip the trailing prompt from the buffer (stored separately in lastPrompt).
        // Preserving the rest (e.g. ":help for help" banner at startup) so glasses
        // shows the same content as the web UI.
        terminal = stripTrailingPrompt(terminal);
        renderAll(); // re-render with the waiting prompt pinned at the end
      }
      // A reply finished: resume listening for the next utterance.
      if (generating) {
        generating = false;
        renderAll(); // show cursor immediately, regardless of whether listening starts
        void startListening();
      }
      // Flush any queued login AFTER the prompt is rendered, so echoLogin sees the
      // correct lastPrompt and the "gpt-5.5>" line appears before the :login echo.
      if (pendingLogin) {
        echoLogin(pendingLogin.username, pendingLogin.password);
        void sc.login(pendingLogin.username, pendingLogin.password);
        pendingLogin = null;
      }
    },
    onUnavailable: () => emit("\n[sc bridge unavailable — run `npm run dev`]\n"),
  });

  // Send user input: echo it after the prompt and continue the view, then send to
  // `sc` and switch to "generating" (stops listening) until the reply completes.
  function ask(text: string) {
    draft = ""; // the line is committed now; stop previewing it
    display.followLive(); // a new exchange pulls the glasses back to the live view
    terminal = (terminal + `${lastPrompt}${text}\n`).slice(-TERMINAL_MAX);
    // Echo the input after the model prompt. The previous reply usually leaves the
    // prompt at the tail of the log, but not always (e.g. the very first input), so
    // strip any trailing prompt and re-add `lastPrompt` explicitly — this keeps the
    // `gpt-5.5>` tag in front of every input without ever duplicating it.
    const stripped = stripTrailingPrompt(webLog);
    webLog = (stripped + `${lastPrompt}${text}\n`).slice(-WEB_LOG_MAX);
    generating = true;
    void stopListening(); // clears the status; set "generating" after so it wins
    setStatus(""); // re-renders both views
    void sc.send(text);
  }

  // Echo a login command to both views with the password masked, then flip to
  // generating state so the response streams in on the next line.
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

  // Reset the conversation and memory: tell `sc` to drop its session memory
  // (`:reset` also clears role/store/node), and wipe our local buffers so both
  // views start clean. The CLI's "Reset." reply and fresh prompt arrive via the
  // normal output stream.
  function reset() {
    draft = "";
    terminal = "";
    webLog = "";
    display.followLive();
    generating = true; // suppress lastPrompt appending until onReady fires
    void stopListening();
    setStatus("");
    emit(":help for help\n");
    void sc.send(":reset");
  }

  ui = await createWebUI(bridge, {
    onSubmit: (text) => ask(text),
    onRefresh: () => reset(),
    onInput: (text) => {
      draft = text;
      // Jump back to the live view as soon as the user starts typing so they
      // can see the prompt they're replying to.
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
    onLanguageChange: (language) => {
      sttLanguage = language;
    },
    onApiKeyChange: (apiKey) => {
      setApiKey(apiKey);
      // Voice recognition needs the OpenAI key, so the mic follows the key: start
      // listening when one is present (also on startup, with the saved key), stop
      // when it's missing or removed. With no key we never start listening.
      if (apiKey) void startListening();
      else void stopListening();
    },
    onCursorBlinkChange: (blink) => {
      display.setCursorBlink(blink);
    },
    onTranscriptionChange: (enabled) => {
      transcriptionEnabled = enabled;
      if (enabled) void startListening();
      else void stopListening();
    },
  });

  if (!hasApiKey()) {
    setStatus("");
    ui?.toast(msg("noApiKey"), 5000);
  }

  // Each closed segment is sent off for transcription. We tag segments so a slow
  // response can't append out of order.
  let nextSeq = 0;
  let lastShownSeq = -1;

  const segmenter = new SpeechSegmenter({
    sampleRate: SAMPLE_RATE,
    onSegment: (pcm) => {
      const seq = nextSeq++;
      void handleSegment(pcm, seq);
    },
  });

  async function handleSegment(pcm: Uint8Array, seq: number) {
    if (!listening) return;
    setStatus("● transcribing");
    try {
      const text = await transcribe(pcm, SAMPLE_RATE, sttLanguage || undefined);
      if (text && seq > lastShownSeq) {
        lastShownSeq = seq;
        ask(text); // echo the transcript and forward it to sc (flips to "generating")
        return;
      }
    } catch (err) {
      console.error("transcribe error:", err);
    }
    // Nothing usable — keep listening (only if still in listening mode).
    if (listening) setStatus("● listening");
  }

  // Ask the host to show its exit confirmation layer (mode 1). The user decides whether
  // to actually quit; if they confirm, the host fires SYSTEM_EXIT_EVENT and `shutdown`
  // does the real teardown. We leave the mic running here since the exit may be cancelled.
  async function requestExit() {
    await bridge.shutDownPageContainer(1); // 1 = show the "exit?" interaction layer
  }

  // Release resources and tear down the glasses page container. Called when the host
  // signals the app is exiting (the user confirmed exit, or an abnormal exit) so the mic
  // is freed and the container is shut down cleanly rather than left dangling.
  async function shutdown() {
    await stopListening();
    await bridge.shutDownPageContainer(0); // 0 = exit immediately (post-confirmation cleanup)
  }

  // Events from the glasses. The caption container captures touch-bar scrolls
  // (isEventCapture), which arrive as SCROLL_TOP/BOTTOM and page through the saved
  // session transcript: up shows the previous (older) view, down the next (newer) one,
  // and scrolling past the bottom resumes following the live output. Audio arrives as
  // audioEvent PCM bytes; ignore it while generating so the reply isn't interrupted by
  // stray speech.
  bridge.onEvenHubEvent((event) => {
    const eventType = event.textEvent?.eventType ?? event.listEvent?.eventType ?? event.sysEvent?.eventType;
    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      void display.showPreviousView();
      return;
    }
    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      void display.showNextView();
      return;
    }
    // Single-tap arrives as a sysEvent carrying only an `eventSource` (the touch origin:
    // glasses L/R or ring) with no `eventType` — the host doesn't emit CLICK_EVENT for it.
    // Treat any such touch-sourced event without a type as a single tap: start a fresh
    // conversation, and flash a confirmation on the web view.
    const eventSource = event.sysEvent?.eventSource;
    if (eventType == null && eventSource != null && eventSource !== EventSourceType.TOUCH_EVENT_FORM_DUMMY_NULL) {
      reset();
      return;
    }
    // Double-tap on the glasses asks the host to raise its exit confirmation dialog.
    // It does NOT exit directly — the user confirms there, then SYSTEM_EXIT_EVENT below
    // drives the actual teardown.
    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void requestExit();
      return;
    }
    // The host is closing the app (or it exited abnormally): free the mic and shut the
    // page container down cleanly.
    if (eventType === OsEventTypeList.SYSTEM_EXIT_EVENT || eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      void shutdown();
      return;
    }
    if (!listening) return;
    const pcm = event.audioEvent?.audioPcm;
    if (pcm && pcm.byteLength > 0) segmenter.push(pcm);
  });

  // Listening is driven by onApiKeyChange (fired with the saved key while
  // createWebUI ran above): it starts the mic when a key is present and stops it
  // otherwise — so with no API key we never start listening.
}

main().catch(console.error);
