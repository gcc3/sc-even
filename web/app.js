// The terminal page's behaviour: stream the CLI's output into the box, and send back the
// lines typed into it. The bridge it talks to is the server that served this file:
//
//   GET  /api/sc/stream?session=<id>   `chunk` events, and `ready` at every prompt
//   GET  /api/sc/history?session=<id>  the commands the CLI has run, for ↑
//   POST /api/sc/send   { session, text }   one message to the CLI (may span lines)

const el = document.getElementById("terminal");
const mirror = document.getElementById("mirror");
const notice = document.getElementById("notice");

// The block the src draws at the end of the output (src/webui/styles.css, .term--cursor), and
// like it: static, no blink.
const CURSOR = "█";

// Which sc process on the server this page talks to. Kept in sessionStorage so a reload
// lands back in the same conversation (the server holds an idle process for SC_SESSION_TTL
// after the stream drops).
const KEY = "sc-session";
let session = sessionStorage.getItem(KEY);
if (!session) {
  session = crypto.randomUUID?.() ?? `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  sessionStorage.setItem(KEY, session);
}

// Everything the CLI has printed, plus the lines we echoed for it (its stdin is a pipe, so
// it echoes nothing itself). Append-only — this is the scrollback.
let log = "";
// The line being typed, i.e. everything after the prompt.
let draft = "";
// Waiting on a reply: Enter does nothing until the CLI's prompt is back.
let busy = false;
// The prompt the CLI last left on screen, so an error can put it back.
let prompt = "";
let live = false;
// Whether new output should scroll into view — false while the reader has scrolled up.
let stick = true;

// The commands this session's CLI has run, newest first, as it wrote them down itself
// (simple-ai-chat's pushCommandHistory). Only `:` commands are in it, there as here: what ↑
// brings back is a command, not a sentence said to the model.
let cmdHistory = [];
// How far back ↑ has walked: -1 is the line being typed, 0 the most recent command.
let historyIndex = -1;
// The half-typed line ↑ was pressed on, kept so walking ↓ back off the end returns to it.
let pending = "";
// Whether the CLI has run a command since the history was last read. It changes at no other
// time, so a reply — which is most of what `ready` fires for — is not worth a request.
let historyStale = true;

// Keep the scrollback bounded, cutting at a line break so the top stays readable.
const MAX_CHARS = 200000;
function cap(text) {
  if (text.length <= MAX_CHARS) return text;
  const tail = text.slice(-MAX_CHARS);
  const nl = tail.indexOf("\n");
  return nl === -1 ? tail : tail.slice(nl + 1);
}

/** The `model> ` prompt at the end of the CLI's output, or "" if it isn't idle there. */
function trailingPrompt(text) {
  return text.match(/[A-Za-z0-9_.-]*>[ \t]$/)?.[0] ?? "";
}

// `:login <user> <password>` is forwarded to the CLI as typed, but the line we echo stays on
// screen — so the password doesn't.
function forScrollback(line) {
  const login = line.match(/^(:login\s+\S+\s+)(\S+)(.*)$/i);
  return login ? `${login[1]}${"*".repeat(login[2].length)}${login[3]}` : line;
}

// The CLI's themes (simple-ai-chat's getThemes()). `:theme <name>` is its command, but the
// colours are the page's to change, so the page reads the line as it goes past.
const THEMES = ["light", "dark", "terminal"];
const THEME_KEY = "sc-theme";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // The mobile browser's own chrome, so a dark terminal doesn't end at a white bar.
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked. The theme still applies; it just won't outlive the page.
  }
}

// Whether a line wipes the screen. `:clear` clears the CLI's own with an escape code
// (cli.js writes `\x1Bc`) that the bridge strips out on its way here, so it would otherwise
// pass unnoticed; `:reset` starts the conversation over. The web app treats the two the same
// (pages/index.js: clearInput + clearOutput), and so does this.
function clears(line) {
  return /^:(clear|reset)\b/i.test(line);
}

/** The theme a `:theme <name>` line asks for, or "" for anything else. */
function themeFrom(line) {
  const name = line.match(/^:theme\s+(\S+)\s*$/i)?.[1]?.toLowerCase() ?? "";
  return THEMES.includes(name) ? name : "";
}

function savedTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return THEMES.includes(saved) ? saved : "light";
  } catch {
    return "light";
  }
}

// A `:theme` outlives the page it was typed on. boot.js has already put it on <html> to head
// off the flash; this settles the rest of it.
applyTheme(savedTheme());

// Repeat into #mirror whatever the box holds, plus the cursor — which is there when the CLI
// is idle and waiting for a line, and gone while it is answering, as it is in src.
function sync() {
  mirror.textContent = el.value + (live && !busy ? CURSOR : "");
  mirror.scrollTop = el.scrollTop;
}

function paint() {
  // Rewriting .value parks the caret at the end, which is where a terminal keeps it. A
  // reader who has selected text to copy is left alone.
  const from = el.selectionStart;
  const to = el.selectionEnd;
  const hadRange = from !== to;
  el.value = log + draft;
  if (hadRange) el.setSelectionRange(from, to);
  if (stick) el.scrollTop = el.scrollHeight;
  sync();
}

function append(text) {
  // The CLI puts a blank line before each prompt, which on an empty screen is a blank first
  // line — after a clear, the prompt belongs at the top of the page.
  log = cap(log + (log ? text : text.replace(/^[\r\n]+/, "")));
  const next = trailingPrompt(text);
  if (next) prompt = next;
  paint();
}

function setPhase(phase, message) {
  live = phase === "live";
  el.disabled = !live;
  notice.hidden = live;
  if (!live) notice.textContent = message;
  else if (document.activeElement !== el) el.focus();
  sync();
}

async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, ...body }),
    });
    return res.ok ? {} : { error: `server answered ${res.status}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function loadHistory() {
  try {
    const res = await fetch(`/api/sc/history?session=${encodeURIComponent(session)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.history)) cmdHistory = data.history;
  } catch {
    // A terminal whose history can't be read still types; ↑ is the only thing lost, and
    // saying so on screen would be louder than the miss is worth.
  }
}

/** Walk `step` entries back (+1) or forward (-1) through the command history. */
function recall(step) {
  const next = historyIndex + step;
  // -1 is the line being typed and the end of the list is the end of it: neither wraps.
  if (next < -1 || next >= cmdHistory.length) return;
  // Leaving the typed line: keep it, because ↓ is how it comes back.
  if (historyIndex === -1) pending = draft;
  historyIndex = next;
  draft = next === -1 ? pending : cmdHistory[next];
  stick = true;
  paint();
}

function submit() {
  const line = draft.trim();
  if (!line || busy || !live) return;
  draft = "";
  // The line is spoken for, so ↑ starts again from the newest command — and the draft it was
  // holding on to is gone with it. A command is about to join the history, so re-read it once
  // the CLI is done writing it down (i.e. at the next prompt).
  historyIndex = -1;
  pending = "";
  if (line.startsWith(":")) historyStale = true;
  // Repainted here, and still sent on: the CLI is what remembers the choice (and syncs it to
  // a logged-in account). A name it doesn't know is left for it to complain about.
  const theme = themeFrom(line);
  if (theme) applyTheme(theme);
  // Set before the echo, so the line appears without a cursor after it: from here until the
  // CLI's prompt comes back, it is the CLI's turn.
  busy = true;
  stick = true;
  // A line that clears takes the screen with it, itself included — the way it goes in a
  // terminal. What the CLI prints next, its prompt, is then the whole page.
  if (clears(line)) {
    log = "";
    paint();
  } else {
    append(`${forScrollback(line)}\n`);
  }
  void post("/api/sc/send", { text: line }).then((res) => {
    if (res.error) {
      busy = false;
      append(`[${res.error}]\n${prompt}`);
    }
  });
}

el.addEventListener("input", () => {
  const next = el.value;
  // Only the tail after the prompt is editable; an edit reaching into the scrollback is put
  // back as it was.
  if (!next.startsWith(log)) {
    paint();
    return;
  }
  // Line breaks are kept, in the draft and all the way to the model: the bridge encodes a
  // multi-line message onto one stdin line so the CLI still reads it as a single submission.
  // What is on screen is what gets sent.
  draft = next.slice(log.length);
  // The box already holds the keystroke; this is the mirror catching up with it.
  sync();
});

el.addEventListener("keydown", (e) => {
  // Enter runs the line. A live IME composition keeps it, so committing a candidate with
  // Enter does not submit half a sentence. Shift+Enter is left to the box, whose own default
  // is to break the line — a message can span several, and one still sends as one.
  if (e.key === "Enter" && !e.isComposing && !e.shiftKey) {
    e.preventDefault();
    submit();
  }

  // ↑ and ↓ walk the command history, as they do in a shell. They are taken whether or not
  // there is anything to recall: the box holds the whole scrollback, so the caret moving up
  // into it — what they would otherwise do — is never what was meant. A modifier is left
  // alone, so the browser's own ⌘↑ / Shift↓ still work. An IME uses them to pick a
  // candidate, and gets them while it is composing.
  const arrow = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
  if (arrow && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (live && !busy) recall(arrow);
  }
});

el.addEventListener("scroll", () => {
  stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  mirror.scrollTop = el.scrollTop;
});

const source = new EventSource(`/api/sc/stream?session=${encodeURIComponent(session)}`);

source.addEventListener("chunk", (e) => {
  // Straight into the scrollback, banner and prompt included, exactly as the CLI printed
  // it — this page is a view of the terminal, not a chat transcript.
  setPhase("live");
  append(JSON.parse(e.data));
});

source.addEventListener("ready", () => {
  busy = false;
  setPhase("live");
  // The prompt is back, so whatever command was running has been written to the history by
  // now. The first `ready` always reads it: a reload lands back in the same session, and the
  // commands typed before it are still the ones ↑ should reach.
  if (historyStale) {
    historyStale = false;
    void loadHistory();
  }
});

source.addEventListener("error", () => {
  // EventSource retries a dropped connection itself (readyState CONNECTING) and gives up for
  // good on a reply that is not an event stream (CLOSED). Neither has a CLI behind it, and
  // both have to be said out loud or the page waits forever.
  if (source.readyState !== EventSource.OPEN) setPhase("down", "no answer from the sc server");
});
