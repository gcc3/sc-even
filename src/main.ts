import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createDisplay } from "./glasses";
import { createWebUI } from "./ui";
import { connectSc } from "./sc";
import { SpeechSegmenter } from "./segmenter";
import { hasApiKey, transcribe } from "./transcribe";

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
  let statusText = "starting…";
  let sttLanguage = ""; // ISO-639-1 hint from Settings; "" = auto-detect.
  // The CLI prompt (e.g. "gpt-5.5> ") captured from the last reply, so we can keep
  // it on screen when we clear for a new conversation.
  let lastPrompt = "";

  // While `sc` is producing a reply we stop listening and follow the newest output
  // on the glasses; `listening` gates audio so nothing is captured meanwhile.
  let generating = false;
  let listening = false;

  // The in-progress line typed in the web input box. Mirrored live to both views
  // (prefixed with the prompt) so the glasses show what's being typed before submit.
  let draft = "";

  // Render both views from the current buffers, overlaying the live draft line.
  // While idle and typing, we preview the line exactly as `ask` would echo it:
  // the model prompt followed by the in-progress text. During generation we leave
  // the streaming reply alone.
  function renderAll() {
    const preview = draft && !generating;
    const webView = preview
      ? webLog.replace(/(^|\n)[^\n]*?>[ \t]*$/, "$1") + `${lastPrompt}${draft}`
      : webLog;
    const glassesView = preview ? `${lastPrompt}${draft}` : terminal;
    ui.render(webView);
    void display.render({ status: statusText, text: glassesView });
  }

  // Append CLI output to both buffers. They're independent: `terminal` is kept tidy
  // for the small glasses display (rendered as-is, no extra cleanup), while `webLog`
  // keeps the full raw scrollback for the web view.
  function emit(text: string) {
    // The ":help for help" banner hint is noise on the glasses; drop it on the way
    // in (it's a whole line and never part of a reply).
    terminal = (terminal + text).replace(/^.*:help.*\n?/gim, "").slice(-TERMINAL_MAX);
    webLog = (webLog + text).slice(-WEB_LOG_MAX);
    renderAll();
  }

  function setStatus(text: string) {
    statusText = text;
    ui.setStatus(text);
    renderAll();
  }

  async function startListening() {
    const ok = await bridge.audioControl(true);
    listening = ok;
    setStatus(ok ? "● listening" : "⚠ mic failed");
  }

  async function stopListening() {
    listening = false;
    await bridge.audioControl(false);
  }

  // The `sc` CLI bridge: stream its output into the terminal as it arrives.
  const sc = connectSc({
    onChunk: (text) => emit(text),
    onReady: () => {
      // The CLI is idle, having just printed its prompt. Remember it (so a cleared
      // screen still shows it), then drop it from the glasses buffer — this is the
      // one moment we know the trailing `>` is the prompt and not part of a reply
      // (e.g. code like `x -> `), so it's safe to strip without a render-time guard.
      const prompt = trailingPrompt(terminal);
      if (prompt) {
        lastPrompt = prompt;
        terminal = terminal.replace(/\n*[^\n]*?>[ \t]*$/, "");
        void display.render({ status: statusText, text: terminal });
      }
      // A reply finished: resume listening for the next utterance.
      if (generating) {
        generating = false;
        void startListening();
      }
    },
    onUnavailable: () => emit("\n[sc bridge unavailable — run `npm run dev`]\n"),
  });

  // Start a new conversation: clear the screen so only this exchange is shown, keep
  // the CLI prompt, and echo the input after it. Then send to `sc` and switch to
  // "generating" (stops listening) until the reply completes.
  function ask(text: string) {
    draft = ""; // the line is committed now; stop previewing it
    terminal = `${lastPrompt}${text}\n`;
    // Echo the input after the model prompt. The previous reply usually leaves the
    // prompt at the tail of the log, but not always (e.g. the very first input), so
    // strip any trailing prompt and re-add `lastPrompt` explicitly — this keeps the
    // `gpt-5.5>` tag in front of every input without ever duplicating it.
    const stripped = webLog.replace(/(^|\n)[^\n]*?>[ \t]*$/, "$1");
    webLog = (stripped + `${lastPrompt}${text}\n`).slice(-WEB_LOG_MAX);
    generating = true;
    setStatus("● generating…"); // re-renders both views
    void stopListening();
    void sc.send(text);
  }

  const ui = await createWebUI(bridge, {
    onSubmit: (text) => ask(text),
    onInput: (text) => {
      draft = text;
      renderAll();
    },
    onLogin: (username, password) => void sc.login(username, password),
    onLanguageChange: (language) => {
      sttLanguage = language;
    },
  });

  if (!hasApiKey()) {
    setStatus("⚠ No API key");
    emit("Set VITE_OPENAI_API_KEY in .env and rebuild.\n");
    return;
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
    setStatus("● transcribing…");
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
    // Nothing usable — keep listening.
    setStatus("● listening");
  }

  // Audio arrives as audioEvent PCM bytes. Ignore it while generating so the reply
  // isn't interrupted by stray speech. (Scrolling is handled natively by the device.)
  bridge.onEvenHubEvent((event) => {
    if (!listening) return;
    const pcm = event.audioEvent?.audioPcm;
    if (pcm && pcm.byteLength > 0) segmenter.push(pcm);
  });

  await startListening();
}

// Extract the trailing CLI prompt (e.g. "gpt-5.5> ") from the output, if any.
function trailingPrompt(text: string): string {
  const m = text.match(/(?:^|\n)([^\n]*?>[ \t]*)$/);
  return m ? m[1] : "";
}

main().catch(console.error);
