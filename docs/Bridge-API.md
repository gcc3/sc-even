
sc-bridge API
=============

`serve.mjs` runs the `sc` ([simple-ai-chat](https://www.npmjs.com/package/simple-ai-chat)) CLI
behind HTTP/SSE so the glasses app can reach it over the network. One `sc` process per session,
each with an isolated `HOME` for its `~/.simple` cookie and settings — sessions never share a
login, a conversation, or stdin, and output goes only to that session's clients.

Default port `8787`. CORS is on (`SC_ALLOW_ORIGIN`, default `*`) because the app and this
server sit on different origins.

The public instance the published app talks to is `https://cli.simple-ai.io/`
(`SC_SERVER_BASE_URL` in [src/services/sc.ts:12](../src/services/sc.ts#L12)).


Endpoints
---------

`GET /`  
The terminal page. Open `http://localhost:8787/`.

`GET /healthz`  
Health check. Returns `ok`.

`GET /api/key`  
Returns `{ key }` — the server's `OPENAI_API_KEY`, used by the client for Whisper
transcription. Returns an empty string when unset.

`GET /api/sc/stream?session=<id>`  
SSE stream of the CLI's output for the given session. Emits `chunk` events with text and a
`ready` event when the CLI is idle.

A client joining a session whose CLI is already running has missed the banner, so the stream
replays the last prompt to that client alone. A freshly spawned CLI prints its own, so nothing
is replayed there.

`GET /api/sc/history?session=<id>`  
The `:` commands the session's CLI has run, newest first — what ↑ walks back through on the
terminal page. Returns `{ history: [...] }`. Read from the CLI's own scratch file
(`$HOME/.simple/.scratch/history`, which is per-session); commands carrying a password
(`:login`, `:user add`, `:user set pass`, `:user join`) are left out.

`POST /api/sc/send`  
Send a message to the CLI. Body: `{ session, text }`.

`text` may span several lines. The CLI reads stdin with readline, so a newline there is a
submission boundary — a multi-line message is JSON-encoded onto a single line behind a marker
byte and unpacked on the way in. The convention is defined in `simple-ai-chat`'s
`utils/stdin.js`; `writeLine` in `serve.mjs` is the encoding half. Single-line messages go
through untouched, so this needs `simple-ai-chat` new enough to decode **only** for multi-line.

On the terminal page, Shift+Enter breaks a line and Enter sends.

`POST /api/sc/login`  
Log in to the sc account. Body: `{ session, username, password }`. Writes `:login <u> <p>` to
that session's CLI.


Sessions
--------

A session id is chosen by the client and passed on every call. The server spawns one `sc` child
per id, with `HOME` pointed at a fresh `sc-home-<random>/` under the system temp dir — so the
cookie and settings of one session are invisible to another. The directory is removed when the
session is reaped.

When a session's last client disconnects the process is kept alive for `SC_SESSION_TTL` ms
(default 120000) so a reload or a brief network drop resumes the same conversation, then reaped.


Client IP tagging
-----------------

Because the CLI runs on the server, every request it makes to the Simple AI backend originates
from that machine — the backend would otherwise record the server's address (`127.0.0.1` when
the two are co-located) for every user. Ordinary messages are therefore tagged with the sender's
address as `@ip[...]`, in the same in-band style as the CLI's `+image[...]`, and the backend
reads it off and strips it. See `tagWithClientIp` in `serve.mjs`.


Environment
-----------

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `SC_CMD` | `./node_modules/.bin/sc` | Path to the `sc` binary |
| `SC_ALLOW_ORIGIN` | `*` | CORS `Access-Control-Allow-Origin` |
| `SC_SESSION_TTL` | `120000` | ms an idle session's process survives its last client |
| `OPENAI_API_KEY` | — | Served to the client via `/api/key` for Whisper |

`PM2_NAME` (default `sc-bridge`) is read from `.env` by `ecosystem.config.cjs`, not by the
server itself.


Running it
----------

```bash
./serve.sh          # foreground, http://localhost:8787
./start.sh          # under PM2, via ecosystem.config.cjs
./stop.sh           # stop it (--delete to drop it from the PM2 list)
./restart.sh        # git pull + npm install + pm2 restart
```

See [Development.md](Development.md) for the full loop.


Behind a reverse proxy
----------------------

The output is SSE, so buffering has to be off — a buffered stream is delivered only once the
buffer fills, and a prompt-sized chunk never fills it. The server says so itself
(`X-Accel-Buffering: no`, which nginx honours) and sends a comment every 20s so an idle
stream isn't mistaken for a dead one.

If a proxy still holds it back, say it in the config too:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_buffering off;      # SSE: pass each chunk straight through
    proxy_read_timeout 1h;    # a stream waiting for input is not a dead one
    proxy_set_header Host $host;
    proxy_set_header Connection "";   # SSE is not a WebSocket upgrade
}
```
