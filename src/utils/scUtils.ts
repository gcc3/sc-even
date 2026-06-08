// Client for the `sc` bridge.
//
// Talks to a sc-bridge server over SSE + POST. The server runs the `sc`
// (simple-ai-chat) CLI; this client just streams its output and posts input back.
// Two backends speak this protocol:
//   - the dev-only Vite plugin in vite.config.ts (relative paths, same origin)
//   - the standalone server.mjs / serve.sh (an absolute URL, set in the published
//     app via Settings → SC server URL)
//
// `connect(baseUrl)` (re)opens the stream against a server:
//   - "" (empty)  -> relative paths — the dev server's built-in bridge
//   - "https://…" -> a standalone server reachable from the device
//
// Each client gets its own `session` id, sent with every request, so multiple
// users never share one sc process / login / conversation on the server.

export interface ScHandlers {
  onChunk: (text: string) => void; // a piece of CLI output arrived
  onReady: () => void; // CLI finished a reply and is idle again
  onUnavailable?: () => void; // no backend reachable (e.g. URL unset/wrong)
}

export interface ScClient {
  /** (Re)connect the output stream to a bridge server. Safe to call repeatedly. */
  connect(baseUrl: string): void;
  login(username: string, password: string): Promise<void>;
  send(text: string): Promise<void>;
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

export function connectSc(handlers: ScHandlers): ScClient {
  const session = randomId();
  let baseUrl = "";
  let source: EventSource | null = null;

  const connect = (url: string) => {
    baseUrl = (url || "").replace(/\/+$/, ""); // trim trailing slash(es)
    source?.close();
    source = new EventSource(`${baseUrl}/api/sc/stream?session=${encodeURIComponent(session)}`);
    source.addEventListener("chunk", (e) => handlers.onChunk(JSON.parse((e as MessageEvent).data)));
    source.addEventListener("ready", () => handlers.onReady());
    source.addEventListener("error", () => {
      // EventSource auto-retries; if it never connected at all, surface it once.
      if (source && source.readyState === EventSource.CONNECTING) handlers.onUnavailable?.();
    });
  };

  const post = async (path: string, body: Record<string, unknown>) => {
    await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, ...body }),
    });
  };

  return {
    connect,
    login: (username, password) => post("/api/sc/login", { username, password }),
    send: (text) => post("/api/sc/send", { text }),
  };
}
