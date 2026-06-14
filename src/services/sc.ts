// Client for the `sc` bridge.
//
// Talks to a sc-bridge server over SSE + POST. The server runs the `sc`
// (simple-ai-chat) CLI; this client just streams its output and posts input back.
// The backend is the standalone serve.mjs / serve.sh, hosted at the hardcoded
// SC_SERVER_BASE_URL below.
//
// Each client gets its own `session` id, sent with every request, so multiple
// users never share one sc process / login / conversation on the server.

/** Fixed sc-bridge server. The published app always talks to this host. */
const SC_SERVER_BASE_URL = "http://159.223.204.39:8787/";

export interface ScHandlers {
  onChunk: (text: string) => void; // a piece of CLI output arrived
  onReady: () => void; // CLI finished a reply and is idle again
  onUnavailable?: () => void; // no backend reachable (e.g. server down)
}

export interface ScClient {
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
  const baseUrl = SC_SERVER_BASE_URL.replace(/\/+$/, ""); // trim trailing slash(es)
  let source: EventSource | null = null;

  const connect = () => {
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

  connect(); // open the stream immediately against the fixed server

  return {
    login: (username, password) => post("/api/sc/login", { username, password }),
    send: (text) => post("/api/sc/send", { text }),
  };
}
