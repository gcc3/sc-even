import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

// App version, surfaced in the Settings page. Read from app.json (the single
// source of truth) and injected as a compile-time constant (see `define` below).
const APP_VERSION: string = JSON.parse(readFileSync(new URL("./app.json", import.meta.url), "utf-8")).version;

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

// The interactive prompt looks like `gpt-5.5> ` at the very end of a chunk once
// the CLI is idle and waiting for input. We use it to mark a reply as complete.
// The model name is optional (`*`, not `+`): when no model is set the CLI prints a
// bare `> ` prompt, and we still need to recognize it — otherwise the prompt is never
// detected, `ready` never fires, and the startup output stays held in the buffer
// (leaving the glasses blank until the first reply).
const PROMPT_AT_END = /[\r\n]*[A-Za-z0-9_.\-]*>[ \t]$/;

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
        res.writeHead(503, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: "OPENAI_API_KEY not set in .env" }),
        );
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
        form.append("model", "whisper-1");
        form.append("response_format", "verbose_json");
        if (language) form.append("language", language);

        const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        });
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => "");
          res.writeHead(upstream.status, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: detail.slice(0, 200) }),
          );
          return;
        }
        const data = (await upstream.json()) as {
          text?: string;
          segments?: Array<{ text: string; no_speech_prob: number; avg_logprob: number }>;
        };
        const NO_SPEECH_PROB_MAX = 0.6;
        const AVG_LOGPROB_MIN = -1.0;
        const segments = data.segments ?? [];
        const speech = segments.filter(
          (s) => !(s.no_speech_prob > NO_SPEECH_PROB_MAX && s.avg_logprob < AVG_LOGPROB_MIN),
        );
        const text = (speech.length ? speech.map((s) => s.text).join("") : data.text ?? "").trim();
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text }));
      });
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
  return {
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  // The packaged app runs in the device's (older) WebKit, not the modern
  // simulator. Target an older Safari so the build keeps/adds vendor prefixes
  // like -webkit-appearance — without this the minifier drops them and controls
  // (e.g. the input vs. enter button) render at native sizes on-device only.
  build: { cssTarget: "safari13", target: "safari13" },
  server: {
    host: "0.0.0.0",
    // SharedArrayBuffer (needed by onnxruntime-web's threaded WASM) requires
    // these cross-origin isolation headers. Without them, numThreads=1 still
    // fails to load the WASM binary.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  plugins: [scBridge(env.OPENAI_API_KEY ?? "")],
  };
});
