
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

`GET /healthz`  
Health check. Returns `ok`.

`GET /api/sc/stream?session=<id>`  
SSE stream of the CLI's output for the given session. Emits `chunk` events with text and a `ready` event when the CLI is idle.

`POST /api/sc/send`  
Send a message to the CLI. Body: `{ session, text }`.

`POST /api/sc/login`  
Log in to the sc account. Body: `{ session, username, password }`.
