// Client for the dev-only `sc` bridge (see vite.config.ts).
//
// Connects to the SSE stream for the CLI's output and posts user input / login
// credentials back. Only works while `npm run dev` is running, since the bridge
// needs Node to spawn the CLI; in a static build the stream simply never opens
// and `onUnavailable` fires.

export interface ScHandlers {
  onChunk: (text: string) => void; // a piece of CLI output arrived
  onReady: () => void; // CLI finished a reply and is idle again
  onUnavailable?: () => void; // no backend (e.g. static build)
}

export interface ScClient {
  login(username: string, password: string): Promise<void>;
  send(text: string): Promise<void>;
}

export function connectSc(handlers: ScHandlers): ScClient {
  const source = new EventSource("/api/sc/stream");

  source.addEventListener("chunk", (e) => handlers.onChunk(JSON.parse((e as MessageEvent).data)));
  source.addEventListener("ready", () => handlers.onReady());
  source.addEventListener("error", () => {
    // EventSource auto-retries; if it never connected at all, surface it once.
    if (source.readyState === EventSource.CONNECTING) handlers.onUnavailable?.();
  });

  const post = async (path: string, body: unknown) => {
    await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  return {
    login: (username, password) => post("/api/sc/login", { username, password }),
    send: (text) => post("/api/sc/send", { text }),
  };
}
