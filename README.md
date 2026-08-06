
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
returned underneath. Each tap saves two files: `-raw` is straight off the mic, `-clip` is
after conditioning and is the one actually sent, so what you hear in `-clip` is what the
model heard.

The console logs `peak` / `rms` / `clipped%` for both, which is the A/B for the
conditioning.


Mic conditioning
----------------

Clips are run through `enhanceCapture` (`src/utils/audio.ts`) before being sent: a 60 Hz
high-pass, spectral-subtraction noise reduction, then ×1.2 gain and a soft limiter.

The gain is deliberately modest and the limiter is not optional. This mic runs hot — peaks
sit near full scale on normal speech — and an earlier ×20 stage clipped ~15% of samples and
wrecked accuracy. Speech survives distortion well enough for a human ear; transcription
falls off a cliff. So the limiter leaves everything below 0.7 alone (where the ×1.2 is
exact) and bends the curve above it, asymptotic to full scale, which makes clipping
impossible by construction rather than by luck. If `clipped%` is ever non-trivial, look
here first.

Noise is estimated per frequency bin rather than per frame, from a low percentile of each
bin across the whole clip. That matters because push-to-talk clips are often wall-to-wall
speech with no pause to measure a noise floor from — a bin, unlike a frame, still has quiet
moments even then. It also means noise sitting *underneath* speech is removed, which a
frame-level gate cannot do at all.

The trade-off: anything genuinely stationary for the whole clip is treated as noise and
removed, because at that point it is indistinguishable from noise. Real speech is never
stationary, so this only bites on things like a constant tone or fan hum — which is the
intended behaviour.

Measured on synthetic speech-in-noise: speech ×1.13, noise −16 dB, 0% clipped, ~15 ms for a
5 s clip (~200 ms for the 60 s cap).

To stop saving clips, set `SAVE_RECORDINGS=false` in `.env`. The dev server restarts on the
change and the listing stays browsable, so clips captured earlier can still be played.

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
