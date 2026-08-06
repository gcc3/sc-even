
sc-even
=======


Connects Even G2 to the Simple AI CLI.  


Publish
-------

Bump the version in `app.json`.  
Run `./package.sh`  

Upload the generated `.ehpk` file to  
[Even G2 Protal](https://hub.evenrealities.com/)  

Manage  
[Even Hub plugin page](https://hub.evenrealities.com/hub/com.gcc3.g2sc)


sc-bridge API
-------------

`GET /`  
The terminal page.  
Open `http://localhost:8787/`.  

`GET /healthz`  
Health check. Returns `ok`.

`GET /api/sc/stream?session=<id>`  
SSE stream of the CLI's output for the given session. Emits `chunk` events with text and a `ready` event when the CLI is idle.

`GET /api/sc/history?session=<id>`  
The `:` commands the session's CLI has run, newest first — what ↑ walks back through on the
terminal page. Returns `{ history: [...] }`. Read from the CLI's own scratch file
(`$HOME/.simple/.scratch/history`, which is per-session); commands carrying a password
(`:login`, `:user add`, `:user set pass`, `:user join`) are left out.

`POST /api/sc/send`  
Send a message to the CLI. Body: `{ session, text }`.

`POST /api/sc/login`  
Log in to the sc account. Body: `{ session, username, password }`.


Debugging speech recognition
----------------------------

While running `./develop.sh`, every clip captured by the glasses mic is saved to
`recordings/` (git-ignored) so a bad transcript can be listened to instead of guessed at.

Open `http://<dev-host>:5173/api/recordings` — a player per clip, with the text the API
returned underneath. The clip is saved exactly as it is sent for transcription, so what you
hear is what the model heard.

The console also logs `peak` / `rms` / `clipped%` per clip. The mic runs hot (peaks near
full scale on normal speech), so no gain is applied — an earlier ×20 stage clipped ~15% of
samples and wrecked accuracy. If `clipped%` is ever non-trivial, that is the problem.

Dev-only — the code is compiled out of the packaged build (`import.meta.env.DEV`).


Troubleshooting
---------------

Behind a reverse proxy  
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
