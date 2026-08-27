#!/usr/bin/env node
// Standalone sc-bridge server.
//
// Runs the `sc` (simple-ai-chat) CLI on a real server so the published glasses
// app can reach it over the network. This mirrors the dev-only Vite plugin in
// vite.config.ts, with two differences that make it safe to expose publicly:
//
//   1. ONE sc process PER SESSION. Each client sends a `session` id; the server
//      keeps a separate sc child (and an isolated HOME for its ~/.simple cookie
//      + settings) per session, so users don't share a login, conversation, or
//      stdin. Output is sent only to that session's clients — never broadcast.
//   2. CORS enabled, since the app and this server are on different origins.
//
// Because the CLI runs here, every request it makes to the Simple AI backend originates
// from this machine — so the backend would record this server's address (127.0.0.1 when
// the two are co-located) for every user. Ordinary messages are therefore tagged with the
// sender's address as `@ip[...]`, in the same in-band style as the CLI's `+image[...]`,
// and the backend reads it off and strips it. See tagWithClientIp.
//
// Endpoints:
//   GET  /                                            -> web/index.html, a terminal page
//   GET  /api/sc/stream?session=<id>                  -> SSE; the CLI's stdout
//   GET  /api/sc/history?session=<id>                 -> the CLI's command history
//   POST /api/sc/send   { session, text }             -> one message to the CLI (may span lines)
//   POST /api/sc/login  { session, username, password } -> `:login <u> <p>`
//   GET  /healthz                                     -> "ok"
//
// Env:
//   PORT             listen port (default 8787)
//   SC_CMD           path to the sc binary (default ./node_modules/.bin/sc)
//   SC_ALLOW_ORIGIN  CORS Access-Control-Allow-Origin (default "*")
//   SC_SESSION_TTL   ms to keep an idle session's process alive after its last
//                    client disconnects, so brief reconnects don't lose the
//                    conversation (default 120000)
//   OPENAI_API_KEY   served to the client via /api/key for client-side Whisper

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { logRequest } from "./src/utils/logUtils.mjs";

const PORT = Number(process.env.PORT) || 8787;
const ROOT = process.cwd();
const SC_CMD = process.env.SC_CMD || join(ROOT, "node_modules", ".bin", "sc");
const ALLOW_ORIGIN = process.env.SC_ALLOW_ORIGIN || "*";
const SESSION_TTL = Number(process.env.SC_SESSION_TTL) || 120000;
// The terminal page and the files it pulls in. A fixed list rather than a static directory:
// this is all there is to serve, so nothing else under web/ is reachable by guessing a path.
// Resolved next to this file, not under cwd, so they are found however the server was started.
const STATIC = new Map([
  ["/", ["web/index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["web/index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["web/style.css", "text/css; charset=utf-8"]],
  ["/boot.js", ["web/boot.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["web/app.js", "text/javascript; charset=utf-8"]],
  // The icon, in the format each consumer asks for: the SVG for the tab, the 180 for iOS's
  // home screen, the manifest and its two PNGs for Android's. The paths are the ones written
  // into index.html and the manifest, so they are absolute and flat like the rest.
  ["/favicon.svg", ["web/favicon.svg", "image/svg+xml"]],
  ["/apple-touch-icon.png", ["web/apple-touch-icon.png", "image/png"]],
  ["/icon-192.png", ["web/icon-192.png", "image/png"]],
  ["/icon-512.png", ["web/icon-512.png", "image/png"]],
  ["/manifest.webmanifest", ["web/manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
]);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

// Strip ANSI escape codes (colors, cursor moves, `ESC c`). Same pattern as
// vite.config.ts (adapted from the `ansi-regex` package).
const ANSI = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)|" +
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PRZcf-ntqry=><~]))",
  "g",
);
const stripAnsi = (s) => s.replace(ANSI, "");

// The idle prompt at the end of a chunk, e.g. "gpt-5.5> ". Model name optional
// (a bare "> " when no model is set), so we still detect the prompt and fire
// `ready`.
const PROMPT_AT_END = /[\r\n]*[A-Za-z0-9_.\-]*>[ \t]$/;

// session id -> { child, clients, buf, prompt, home, killTimer }
const sessions = new Map();

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    // Isolated HOME so each session's sc keeps its own ~/.simple (cookie +
    // settings) instead of clobbering a shared one. Named "sc-home-<unix ms>-
    // <random>": the timestamp is human-readable, and mkdtemp's random suffix
    // guarantees a unique dir even for sessions created in the same millisecond.
    const home = mkdtempSync(join(tmpdir(), `sc-home-${Date.now()}-`));
    s = {
      child: null,
      clients: new Set(),
      buf: "",
      // The prompt the CLI last left on screen, for a client that arrives after it.
      prompt: "",
      home,
      killTimer: null,
    };
    sessions.set(id, s);
  }
  return s;
}

// The address of whoever made this request, as seen through whatever proxy sits in front
// of us. X-Forwarded-For accumulates one hop per proxy, oldest first, so the original
// client is the first entry; X-Real-IP is nginx's single-value equivalent; the socket
// covers a direct connection. "::ffff:1.2.3.4" is an IPv4 address in IPv6 form — unwrap it
// so the backend stores the same dotted-quad it stores for a browser.
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  const forwarded = (Array.isArray(xff) ? xff[0] : xff || "").split(",")[0].trim();
  const ip = forwarded || req.headers["x-real-ip"] || req.socket.remoteAddress || "";
  return String(ip).replace(/^::ffff:/, "");
}

const IP_TAG = /\s*@ip\[[^\]]*\]\s*/g;

// Tag a line with the address it came from, for the backend to record.
//
// Commands (":login ...") and function calls ("!foo()") are parsed by their first
// character and then by argument position, so a tag on one is read as part of the command
// — appending to `:login u p` makes the tag a third argument, and prepending stops it
// being seen as a command at all. Those go through untouched, which is why a bridged
// `:login` is still recorded against this server rather than the user.
//
// Any tag the user typed is dropped first: the address has to be the one we observed, not
// one they can claim by typing it.
function tagWithClientIp(line, ip) {
  const clean = line.replace(IP_TAG, " ").trim();
  if (!ip || !clean || clean.startsWith(":") || clean.startsWith("!")) return clean;
  return `${clean} @ip[${ip}]`;
}

// Where the CLI keeps its command history. node-localstorage (which is what simple-ai-chat
// gives its `localStorage` under Node) writes one file per key into $HOME/.simple/.scratch,
// and the `history` key holds a JSON array of the `:` commands it has run — newest first,
// the latest 100. Each session has its own HOME, so this is that session's history and no
// one else's.
const historyFile = (home) => join(home, ".simple", ".scratch", "history");

// Commands whose arguments are a password. simple-ai-chat means to keep these out of the
// history and doesn't (pushCommandHistory hands isCommandMusked the whole line, which it
// compares against a bare command name, so the test never passes) — its own scratch file
// has `:login <user> <password>` sitting in it in the clear. They are dropped here instead:
// the terminal page masks a password on its way into the scrollback, and handing it one back
// through ↑ would undo that.
const SECRET = /^:(login|user\s+(set\s+pass|add|join))\b/i;

function readHistory(home) {
  try {
    const parsed = JSON.parse(readFileSync(historyFile(home), "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c) => typeof c === "string" && !SECRET.test(c));
  } catch {
    // No file yet (this session has run no commands), or something that isn't the array we
    // expect. Either way there is no history to offer.
    return [];
  }
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(session, event, data) {
  for (const res of session.clients) writeEvent(res, event, data);
}

// A stream waiting for the user to type sends nothing, and a proxy in front of this server
// reads that as a dead upstream (nginx cuts it after 60s by default). An SSE comment every
// HEARTBEAT ms is ignored by the client and keeps the connection accounted for as alive.
const HEARTBEAT = 20000;
const heartbeat = setInterval(() => {
  for (const s of sessions.values()) for (const res of s.clients) res.write(": ping\n\n");
}, HEARTBEAT);
heartbeat.unref();

function handleStdout(session, raw) {
  session.buf += stripAnsi(raw);

  const m = session.buf.match(PROMPT_AT_END);
  if (m && m.index !== undefined) {
    // Stream everything as-is (banner + prompt included) and use the prompt
    // marker to fire `ready` (the CLI is idle).
    broadcast(session, "chunk", session.buf);
    broadcast(session, "ready", "");
    // Remembered without the newlines that precede it, so it can be handed to a client
    // that connects later as the one line it needs.
    session.prompt = m[0].replace(/^[\r\n]+/, "");
    session.buf = "";
    return;
  }
  // Hold back a small tail in case a prompt marker is split across two chunks.
  const HOLD = 32;
  if (session.buf.length > HOLD) {
    broadcast(session, "chunk", session.buf.slice(0, session.buf.length - HOLD));
    session.buf = session.buf.slice(session.buf.length - HOLD);
  }
}

function ensureChild(id) {
  const s = getSession(id);
  if (s.child) return s;
  const child = spawn(SC_CMD, [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: ROOT,
    env: { ...process.env, HOME: s.home, USERPROFILE: s.home },
  });
  child.stdout.on("data", (d) => handleStdout(s, d.toString()));
  child.stderr.on("data", (d) => broadcast(s, "chunk", stripAnsi(d.toString())));
  child.on("exit", (code) => {
    broadcast(s, "chunk", `\n[sc exited: ${code}]\n`);
    s.child = null;
    s.buf = "";
  });
  s.child = child;
  return s;
}

// One call, one submission. The CLI reads stdin with readline, so a message containing
// newlines cannot travel as itself — it would arrive as several inputs, and a second line
// starting with ":" would run as a command. A multi-line message therefore goes JSON-encoded
// onto a single line behind a marker byte, which the CLI unpacks on the way in.
//
// The convention is defined, with both halves and the reasoning, in the CLI's own
// utils/stdin.js. This is the encoding half written out again rather than imported from
// there: importing would tie the bridge's ability to *start* to the CLI being new enough,
// which would take the whole bridge down on a version it could otherwise serve perfectly
// well. A single-line message is passed through untouched, so against a CLI too old to
// decode, only multi-line — which could not be sent at all before — is affected.
const STDIN_MULTILINE_MARK = "\x02"; // STX; a control byte, so no typed line can begin with it

function writeLine(session, line) {
  if (!session.child) return;
  const text = String(line).replace(/\r?\n$/, "");
  const wire = /[\r\n]/.test(text) ? STDIN_MULTILINE_MARK + JSON.stringify(text) : text;
  session.child.stdin.write(wire + "\n");
}

function destroySession(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.killTimer) clearTimeout(s.killTimer);
  s.child?.kill();
  try {
    rmSync(s.home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  sessions.delete(id);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (status, ...rest) => {
    logRequest(req.method, req.url, status, Date.now() - t0);
    return originalWriteHead(status, ...rest);
  };

  cors(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  if (path === "/healthz") return void res.writeHead(200).end("ok");

  // The terminal page. Read per request (they are small files) so editing one doesn't need a
  // restart.
  const asset = req.method === "GET" ? STATIC.get(path) : undefined;
  if (asset) {
    const [file, type] = asset;
    try {
      const body = readFileSync(new URL(`./${file}`, import.meta.url));
      return void res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" }).end(body);
    } catch {
      return void res.writeHead(404).end("not found");
    }
  }

  if (path === "/api/key" && req.method === "GET") {
    return void res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ key: OPENAI_API_KEY }));
  }

  // SSE stream for one session's CLI output.
  if (path === "/api/sc/stream") {
    const id = url.searchParams.get("session");
    if (!id) return void res.writeHead(400).end("missing session");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // For a reverse proxy in front of this server (nginx buffers upstream responses by
      // default): a buffered event stream is delivered only once the buffer fills, and a
      // prompt-sized chunk never fills it — so the client would wait forever. nginx honours
      // this header per response, which saves configuring the location itself.
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");

    // Whether this client is joining a CLI that is already up, in which case its banner is
    // long gone — it went to the page that has since been closed or reloaded.
    const resumed = Boolean(sessions.get(id)?.child);
    const s = ensureChild(id);
    s.clients.add(res);
    if (s.killTimer) {
      clearTimeout(s.killTimer);
      s.killTimer = null;
    }
    // So give it the prompt the CLI last printed, and only to it. Everything a freshly
    // spawned CLI prints arrives on its own, so there is nothing to say in that case — and
    // nothing for the client to guess at either.
    if (resumed && s.prompt) {
      writeEvent(res, "chunk", s.prompt);
      writeEvent(res, "ready", "");
    }
    req.on("close", () => {
      s.clients.delete(res);
      // Keep the process alive briefly so an auto-reconnect resumes the same
      // session; reap it if nobody comes back.
      if (s.clients.size === 0 && !s.killTimer) {
        s.killTimer = setTimeout(() => destroySession(id), SESSION_TTL);
      }
    });
    return;
  }

  // The session's command history, newest first — what ↑ walks back through on the terminal
  // page. Read off disk per request rather than tracked here: the CLI is the one that decides
  // what counts as a command and what a repeat collapses to, and it has already written the
  // answer down. An unknown session is not an error, just an empty history; the process is
  // spawned by /api/sc/stream, and asking about one that never started is answerable.
  if (path === "/api/sc/history" && req.method === "GET") {
    const id = url.searchParams.get("session");
    const s = id ? sessions.get(id) : undefined;
    return void res
      .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify({ history: s ? readHistory(s.home) : [] }));
  }

  if (path === "/api/sc/send" && req.method === "POST") {
    const { session, text } = await readJson(req);
    if (session) {
      const s = ensureChild(session);
      const line = tagWithClientIp(String(text ?? "").trim(), clientIp(req));
      if (line) writeLine(s, line);
    }
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(`{"ok":true}`);
  }

  if (path === "/api/sc/login" && req.method === "POST") {
    const { session, username, password } = await readJson(req);
    if (session && username) {
      const s = ensureChild(session);
      writeLine(s, `:login ${username} ${password ?? ""}`);
    }
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(`{"ok":true}`);
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, () => {
  console.log(`sc-bridge listening on http://0.0.0.0:${PORT} (sc: ${SC_CMD})`);
});

function shutdown() {
  for (const id of [...sessions.keys()]) destroySession(id);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
