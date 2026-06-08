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
// Endpoints (all under /api/sc):
//   GET  /api/sc/stream?session=<id>                  -> SSE; the CLI's stdout
//   POST /api/sc/send   { session, text }             -> write a line to the CLI
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

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const PORT = Number(process.env.PORT) || 8787;
const ROOT = process.cwd();
const SC_CMD = process.env.SC_CMD || join(ROOT, "node_modules", ".bin", "sc");
const ALLOW_ORIGIN = process.env.SC_ALLOW_ORIGIN || "*";
const SESSION_TTL = Number(process.env.SC_SESSION_TTL) || 120000;

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

// session id -> { child, clients, buf, home, killTimer }
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
      home,
      killTimer: null,
    };
    sessions.set(id, s);
  }
  return s;
}

function broadcast(session, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of session.clients) res.write(payload);
}

function handleStdout(session, raw) {
  session.buf += stripAnsi(raw);

  const m = session.buf.match(PROMPT_AT_END);
  if (m && m.index !== undefined) {
    // Stream everything as-is (banner + prompt included) and use the prompt
    // marker to fire `ready` (the CLI is idle).
    broadcast(session, "chunk", session.buf);
    broadcast(session, "ready", "");
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

function writeLine(session, line) {
  if (session.child) session.child.stdin.write(line.endsWith("\n") ? line : line + "\n");
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
  cors(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  if (path === "/healthz") return void res.writeHead(200).end("ok");

  // SSE stream for one session's CLI output.
  if (path === "/api/sc/stream") {
    const id = url.searchParams.get("session");
    if (!id) return void res.writeHead(400).end("missing session");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");

    const s = ensureChild(id);
    s.clients.add(res);
    if (s.killTimer) {
      clearTimeout(s.killTimer);
      s.killTimer = null;
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

  if (path === "/api/sc/send" && req.method === "POST") {
    const { session, text } = await readJson(req);
    if (session) {
      const s = ensureChild(session);
      const line = String(text ?? "").trim();
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
