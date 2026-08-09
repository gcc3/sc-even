
Development
===========

Requirements: Node ≥ 22, npm ≥ 10.9. The
[evenhub CLI](https://hub.evenrealities.com/docs/getting-started/overview)
(`npm i -g @evenrealities/evenhub-cli`) is needed for the QR code and for packaging.


Setup
-----

```bash
./setup.sh
```

Installs dependencies, copies `.env.example` → `.env` if there isn't one, makes the helper
scripts executable, and reports whether `evenhub` is on PATH.

Then put your key in `.env`:

```
PORT=8787
PM2_NAME=sc-bridge
OPENAI_API_KEY=sk-...
SAVE_RECORDINGS=false
```

`setup.sh` also recovers from an incomplete Rolldown install. Vite 8 bundles with Rolldown, and
an interrupted install (or npm's optional-deps bug) can leave `@rolldown/*` missing, at which
point Vite won't start — `npm ci` from the lockfile fixes it.


Running
-------

| Command | What it does |
| --- | --- |
| `./develop.sh` | Vite dev server on `0.0.0.0:5173`, plus a QR code to open the app on the glasses |
| `./simulate.sh` | Even Hub simulator pointed at the dev server (run `./develop.sh` first) |
| `./serve.sh` | sc-bridge backend in the foreground on `:8787` |
| `./start.sh` | sc-bridge under PM2 (`ecosystem.config.cjs`) |
| `./stop.sh` | Stop it — `--delete` also drops it from the PM2 list |
| `./restart.sh` | `git pull` + `npm install` + `pm2 restart` |

`develop.sh` detects a LAN IP (macOS and Linux) so the glasses and the simulator can reach the
dev server; it falls back to `localhost` and says so if it can't find one.

The dev server carries its own copies of the bridge routes as a Vite plugin
(`vite.config.ts`) — `/api/sc/*`, `/api/key`, `/api/transcribe`, `/api/recording[s]` — so
frontend work needs nothing else running. `serve.mjs` is the production half; see
[Bridge-API.md](Bridge-API.md).

For PM2 across reboots: `pm2 save && pm2 startup`. Logs are `pm2 logs sc-bridge`, or
`logs/sc-bridge.{out,err}.log`.


Release
-------

1. Bump `version` in `app.json`.
2. `./login.sh` (once — or `./login.sh you@example.com`) to authenticate with the Even Hub.
3. `./package.sh` — runs `npm run build`, then `evenhub pack` into
   `com.gcc3.g2sc-<version>.ehpk`.
4. Upload the `.ehpk` at [Even G2 Portal](https://hub.evenrealities.com/).

Manage the listing on the
[Even Hub plugin page](https://hub.evenrealities.com/hub/com.gcc3.g2sc).

`app.json` also declares the permissions the app is reviewed against — network access
(whitelisted to `https://api.openai.com` and `https://cli.simple-ai.io`) and `g2-microphone`.
Changing the bridge host means changing the whitelist.


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

To stop saving clips, set `SAVE_RECORDINGS=false` in `.env`. The dev server restarts on the
change and the listing stays browsable, so clips captured earlier can still be played.

Dev-only — the code is compiled out of the packaged build (`import.meta.env.DEV`).


Mic conditioning
----------------

Clips are run through `enhanceCapture` ([src/utils/audio.ts](../src/utils/audio.ts)) before
being sent: a 60 Hz high-pass, spectral-subtraction noise reduction, then ×1.2 gain and a soft
limiter.

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


Troubleshooting
---------------

**SSE behind a reverse proxy.** Buffering has to be off, or the stream is delivered only once
the buffer fills. See [Bridge-API.md](Bridge-API.md#behind-a-reverse-proxy) for the header the
server sends and the matching nginx block.

**Vite won't start (`ERR_MODULE_NOT_FOUND` for `@rolldown/*`).** Incomplete install — re-run
`./setup.sh`, or `npm ci` directly.

**No QR code from `develop.sh`.** `evenhub` isn't on PATH. The script prints the app URL
instead and carries on; open that URL on the device.

**The app hangs on "Starting…".** Settings are read through the Even bridge's storage, which
can hang on real hardware. Each call is capped at 1.5 s and falls back to `window.localStorage`
([src/utils/setting.ts](../src/utils/setting.ts)) — if it still hangs, look for a new awaited
bridge call in the startup path.
