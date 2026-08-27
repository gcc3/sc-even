import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

// App version, surfaced in the Settings page. Read from app.json (the single
// source of truth) and injected as a compile-time constant (see `define` below).
const APP_VERSION: string = JSON.parse(readFileSync(new URL("./app.json", import.meta.url), "utf-8")).version;
const SC_VERSION: string = JSON.parse(
  readFileSync(new URL("./node_modules/simple-ai-chat/package.json", import.meta.url), "utf-8"),
).version;

// ---------------------------------------------------------------------------
// sc-bridge: a dev-only backend that drives the `simple-ai-chat` CLI (`sc`).
//
// The browser can't spawn a CLI, so this plugin keeps ONE long-lived interactive
// `sc` process and exposes three endpoints:
//   GET  /api/sc/stream  — Server-Sent Events; streams the CLI's stdout verbatim
//                          (ANSI codes stripped), banner and prompt included
//   POST /api/sc/login   — { username, password } → writes `:login <u> <p>`
//   POST /api/sc/send    — { text }               → writes the line to the CLI
//
// Login/session state persists in ~/.simple (cookie + scratch) the same way the
// CLI does on its own, so it survives dev-server restarts.
// ---------------------------------------------------------------------------

// Strip ANSI escape codes (colors, cursor moves, the `ESC c` screen reset).
// Pattern adapted from the `ansi-regex` package — covers CSI, OSC and `ESC c`.
const ANSI = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)|" +
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PRZcf-ntqry=><~]))",
  "g",
);
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

// Escape for interpolation into the recordings listing page below.
function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

// The interactive prompt looks like `gpt-5.5> ` at the very end of a chunk once
// the CLI is idle and waiting for input. We use it to mark a reply as complete.
// The model name is optional (`*`, not `+`): when no model is set the CLI prints a
// bare `> ` prompt, and we still need to recognize it — otherwise the prompt is never
// detected, `ready` never fires, and the startup output stays held in the buffer
// (leaving the glasses blank until the first reply).
const PROMPT_AT_END = /[\r\n]*[A-Za-z0-9_.\-]*>[ \t]$/;

// Dev capture dump: on unless .env turns it off with SAVE_RECORDINGS=false.
// Set once from the .env read in the config factory below and read directly by
// the recording middleware. Vite restarts the dev server when .env changes, so
// this is re-evaluated on every edit — no stale value to worry about.
let saveRecordings = false;

function scBridge(apiKey: string): Plugin {
  let child: ChildProcessWithoutNullStreams | null = null;
  const clients = new Set<ServerResponse>();
  let buf = "";

  const broadcast = (event: string, data: string) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };

  const handleStdout = (raw: string) => {
    buf += stripAnsi(raw);

    const m = buf.match(PROMPT_AT_END);
    if (m && m.index !== undefined) {
      // Stream everything as-is — including the banner and the `gpt-5.5>` prompt — so
      // the terminal shows exactly what the real `sc` CLI prints. We still use the
      // prompt marker to fire `ready` (idle) for status purposes.
      broadcast("chunk", buf);
      broadcast("ready", "");
      buf = "";
      return;
    }
    // Stream what we have, but hold back a small tail in case a prompt marker is
    // split across two stdout chunks.
    const HOLD = 32;
    if (buf.length > HOLD) {
      broadcast("chunk", buf.slice(0, buf.length - HOLD));
      buf = buf.slice(buf.length - HOLD);
    }
  };

  const ensureChild = (root: string) => {
    if (child) return child;
    const bin = join(root, "node_modules", ".bin", "sc");
    child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], cwd: root });
    child.stdout.on("data", (d: Buffer) => handleStdout(d.toString()));
    child.stderr.on("data", (d: Buffer) => broadcast("chunk", stripAnsi(d.toString())));
    child.on("exit", (code) => {
      broadcast("chunk", `\n[sc exited: ${code}]\n`);
      child = null;
      buf = "";
    });
    return child;
  };

  const readJson = (req: IncomingMessage): Promise<any> =>
    new Promise((resolve) => {
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

  const write = (line: string) => {
    if (child) child.stdin.write(line.endsWith("\n") ? line : line + "\n");
  };

  const configure = (server: ViteDevServer) => {
    const root = server.config.root;

    server.middlewares.use("/api/key", (req, res) => {
      if (req.method !== "GET") return res.writeHead(405).end();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ key: apiKey }));
    });

    server.middlewares.use("/api/sc/stream", (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);
      ensureChild(root); // spawn on first listener
      res.on("close", () => clients.delete(res));
    });

    server.middlewares.use("/api/sc/login", (req, res) => {
      if (req.method !== "POST") return res.writeHead(405).end();
      void readJson(req).then(({ username, password }) => {
        ensureChild(root);
        if (username) write(`:login ${username} ${password ?? ""}`);
        res.writeHead(200, { "Content-Type": "application/json" }).end(`{"ok":true}`);
      });
    });

    server.middlewares.use("/api/sc/send", (req, res) => {
      if (req.method !== "POST") return res.writeHead(405).end();
      void readJson(req).then(({ text }) => {
        ensureChild(root);
        const line = String(text ?? "").trim();
        if (line) write(line);
        res.writeHead(200, { "Content-Type": "application/json" }).end(`{"ok":true}`);
      });
    });

    // Transcription proxy — keeps the OpenAI key server-side, never in the bundle.
    server.middlewares.use("/api/transcribe", (req, res) => {
      if (req.method !== "POST") return res.writeHead(405).end();
      if (!apiKey) {
        res
          .writeHead(503, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "OPENAI_API_KEY not set in .env" }));
        return;
      }
      void readJson(req).then(async ({ wav: wavBase64, language }: { wav?: string; language?: string }) => {
        if (!wavBase64) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "missing wav" }));
          return;
        }
        const wavBuf = Buffer.from(wavBase64, "base64");
        const form = new FormData();
        form.append("file", new Blob([wavBuf], { type: "audio/wav" }), "speech.wav");
        form.append("model", "gpt-4o-transcribe");
        form.append("response_format", "json");
        if (language) form.append("language", language);

        const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => "");
          res
            .writeHead(upstream.status, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: detail.slice(0, 200) }));
          return;
        }
        const data = (await upstream.json()) as {
          text?: string;
          segments?: Array<{ text: string; no_speech_prob: number; avg_logprob: number }>;
        };
        const NO_SPEECH_PROB_MAX = 0.6;
        const AVG_LOGPROB_MIN = -1.0;
        const segments = data.segments ?? [];
        const speech = segments.filter((s) => !(s.no_speech_prob > NO_SPEECH_PROB_MAX && s.avg_logprob < AVG_LOGPROB_MIN));
        const text = (speech.length ? speech.map((s) => s.text).join("") : (data.text ?? "")).trim();
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text }));
      });
    });

    // --- recording dump (dev only) ------------------------------------------
    // The client POSTs every captured clip here and we drop it in `recordings/`,
    // so a bad transcript can be listened to instead of guessed at. Browse and
    // play them at /api/recordings. See src/utils/recorder.ts for the client half.
    //
    // Turned off with SAVE_RECORDINGS=false in .env — the client stops sending
    // and this endpoint stops accepting. The listing stays available either way,
    // so clips captured earlier can still be played back.
    const recordingsDir = join(root, "recordings");
    const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

    if (!saveRecordings) console.log("[recording] off (SAVE_RECORDINGS=false) — clips are not saved");

    const readBody = (req: IncomingMessage): Promise<Buffer> =>
      new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      });

    server.middlewares.use("/api/recording", (req, res) => {
      if (req.method !== "POST") return res.writeHead(405).end();
      if (!saveRecordings) return res.writeHead(403).end('{"error":"SAVE_RECORDINGS=false"}');
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      const name = `${params.get("id") ?? "clip"}-${params.get("tag") ?? "raw"}.${params.get("ext") ?? "wav"}`;
      if (!SAFE_NAME.test(name)) return res.writeHead(400).end();
      void readBody(req).then(async (body) => {
        await mkdir(recordingsDir, { recursive: true });
        await writeFile(join(recordingsDir, name), body);
        console.log(`[recording] recordings/${name} (${(body.byteLength / 1024) | 0} KB)`);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, name }));
      });
    });

    // GET /api/recordings            — index page with a player per clip
    // GET /api/recordings/<file>     — the file itself
    server.middlewares.use("/api/recordings", (req, res) => {
      if (req.method !== "GET") return res.writeHead(405).end();
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\//, "");
      void (async () => {
        const files = await readdir(recordingsDir).catch(() => [] as string[]);

        if (path) {
          if (!SAFE_NAME.test(path) || !files.includes(path)) return res.writeHead(404).end("not found");
          const body = await readFile(join(recordingsDir, path));
          const type = path.endsWith(".wav") ? "audio/wav" : "text/plain; charset=utf-8";
          res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
          return;
        }

        const wavs = files
          .filter((f) => f.endsWith(".wav"))
          .sort()
          .reverse();
        const items = await Promise.all(
          wavs.map(async (f) => {
            const id = f.replace(/-[^-]*\.wav$/, "");
            const size = (await stat(join(recordingsDir, f))).size;
            const note = await readFile(join(recordingsDir, `${id}-text.txt`), "utf-8").catch(() => "");
            return (
              `<li><div class="n">${esc(f)} <span class="s">${(size / 1024) | 0} KB</span></div>` +
              `<audio controls preload="none" src="/api/recordings/${encodeURIComponent(f)}"></audio>` +
              (note ? `<pre class="t">${esc(note)}</pre>` : "") +
              `</li>`
            );
          }),
        );

        const html =
          `<!doctype html><meta charset="utf-8"><title>recordings</title>` +
          `<meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<style>body{font:14px/1.5 ui-monospace,Menlo,monospace;margin:0;padding:16px;` +
          `background:#111;color:#ddd}h1{font-size:16px;margin:0 0 4px}p{color:#888;margin:0 0 16px}` +
          `ul{list-style:none;padding:0;margin:0}li{border-top:1px solid #262626;padding:12px 0}` +
          `.n{margin-bottom:6px}.s{color:#777}audio{width:100%;max-width:520px;display:block}` +
          `.t{white-space:pre-wrap;color:#8fc;margin:8px 0 0;font:inherit}a{color:#6af}</style>` +
          `<h1>recordings <a href="/api/recordings">↻</a></h1>` +
          `<p>${wavs.length} file(s) · <code>-raw</code> off the mic, <code>-clip</code> as sent to the API</p>` +
          (items.length ? `<ul>${items.join("")}</ul>` : `<p>nothing captured yet — hold the glasses touch bar to talk.</p>`);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
      })();
    });

    const cleanup = () => child?.kill();
    server.httpServer?.on("close", cleanup);
    process.on("exit", cleanup);
  };

  return {
    name: "sc-bridge",
    configureServer: configure,
    configurePreviewServer: configure as unknown as Plugin["configurePreviewServer"],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  saveRecordings = !/^(false|0|no|off)$/i.test((env.SAVE_RECORDINGS ?? "").trim());
  return {
    base: "./",
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __SC_VERSION__: JSON.stringify(SC_VERSION),
      __SAVE_RECORDINGS__: JSON.stringify(saveRecordings),
    },
    // The packaged app runs in the device's (older) WebKit, not the modern
    // simulator. Target an older Safari so the build keeps/adds vendor prefixes
    // like -webkit-appearance — without this the minifier drops them and controls
    // (e.g. the input vs. enter button) render at native sizes on-device only.
    build: { cssTarget: "safari13", target: "safari13" },
    server: {
      host: "0.0.0.0",
    },
    plugins: [scBridge(env.OPENAI_API_KEY ?? "")],
  };
});
