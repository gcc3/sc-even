
sc-even
=======


Connects Even G2 to the Simple AI CLI.

Talk to the glasses, the speech is transcribed and sent to `sc`
([simple-ai-chat](https://www.npmjs.com/package/simple-ai-chat)) running on a server, and the
reply is displayed on the lens. The phone-side page is a terminal you can also type into.


Quick start
-----------

**1. Install the app**

Get *Simple AI* from the [Even Hub](https://hub.evenrealities.com/hub/com.gcc3.g2sc) and open
it from the Even app with the G2 connected.

**2. Log in (optional)**

Tap the person icon in the app header and enter your Simple AI username and password — this
ties the session to your account, so your conversation and CLI settings are yours rather than
the session's. "Save" remembers the credentials on the device.

**3. Talk**

| On the glasses | |
| --- | --- |
| Press and hold | Start recording — the lens shows `● recording · release to send` |
| Release | Stop, transcribe, and send |
| Scroll up / down | Page back and forward through a long reply |
| Double-tap | Exit (the OS asks you to confirm) |

Clips under 250 ms are discarded, so a press let go of at once won't send anything, and
recording stops on its own after 60 s.

A tap neither starts a recording nor stops one — releasing the touch bar is the only way
to end a recording, and the 60 s cap above is what catches a release the glasses never
report. All a tap does is stand the mic down for two seconds, so tapping and then leaving
a finger on the touch bar — which the glasses report as a long press — doesn't open the
mic. Hold again after that and it records as usual.

Press-and-hold needs Even App **2.2.9** or newer (`min_app_version` in
[app.json](app.json)) — that's the version that started reporting the two ends of a long
press to the app.

**4. Or type**

The app page is a full terminal: type a message and press Enter, Shift+Enter for a new line.
`:` commands go to the CLI as-is — `:help` lists them. The gear icon opens settings (speech
language, UI language, theme, transcription on/off); the refresh icon resets the conversation.


Self-hosting the bridge
-----------------------

The published app talks to `https://cli.simple-ai.io/`. To run your own:

```bash
./setup.sh                 # install deps, create .env
# put your OPENAI_API_KEY in .env
./start.sh                 # sc-bridge under PM2 on :8787
```

Then open `http://localhost:8787/` for the terminal page, and point
`SC_SERVER_BASE_URL` in [src/services/sc.ts](src/services/sc.ts#L12) at your host (it also has
to be in the `network` whitelist in [app.json](app.json)).


Docs
----

- [Development](docs/Development.md) — setup, dev server, release, and debugging
- [sc-bridge API](docs/Bridge-API.md) — endpoints, sessions, environment, reverse proxies


License
-------

[Simple AI License](LICENSE) © 2026 simple-ai.io

You can fork this code and run it on your own machine for non-commercial use.
Commercial use of the software, or any part of it, is not permitted, and
neither is offering a product that competes with it, free of charge or not.
