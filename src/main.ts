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

  // The glasses follow the newest output by default; the display keeps its own scroll
  // position so the user can page back with the Up/Down buttons (see below).
  function emit(text: string) {
    terminal = (terminal + text).slice(-TERMINAL_MAX);
    webLog = (webLog + text).slice(-WEB_LOG_MAX);
    ui.render(webLog);
    void display.render({ status: statusText, text: terminal });
  }

  function setStatus(text: string) {
    statusText = text;
    ui.setStatus(text);
    void display.render({ status: statusText, text: terminal });
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
      // Remember the trailing CLI prompt so a cleared screen still shows it.
      const prompt = trailingPrompt(terminal);
      if (prompt) lastPrompt = prompt;
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
    terminal = `${lastPrompt}${text}\n`;
    // Echo the input after the model prompt. The previous reply usually leaves the
    // prompt at the tail of the log, but not always (e.g. the very first input), so
    // strip any trailing prompt and re-add `lastPrompt` explicitly — this keeps the
    // `gpt-5.5>` tag in front of every input without ever duplicating it.
    const stripped = webLog.replace(/(^|\n)[^\n]*?>[ \t]*$/, "$1");
    webLog = (stripped + `${lastPrompt}${text}\n`).slice(-WEB_LOG_MAX);
    ui.render(webLog);
    generating = true;
    setStatus("● generating…");
    void stopListening();
    void sc.send(text);
  }

  const ui = await createWebUI(bridge, {
    onSubmit: (text) => ask(text),
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
