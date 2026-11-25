# MyTurn

A tiny installable web app for passing the turn around a board-game table.
Everyone joins a room on their phone, the host arranges the seating order, and
only the current player's button lights up. Tap it when you're done; the next
person's phone lights up (with a buzz and a chime).

## Run

```bash
npm install
npm start            # http://localhost:3000  (PORT env var to change)
```

### Docker

```bash
docker compose up -d --build          # serves on port 3000
MYTURN_PORT=8080 docker compose up -d # or pick another host port
```

After pulling a new version, run `docker compose up -d --build` again.

## Features

- **Rooms**: create one to get a 4-letter code; others join with the code, the shared link (`/ABCD`), or by scanning the **invite QR code** (tap the room code or "Invite players").
- **Seating order**: the host moves players up/down, shuffles, or removes them. Late joiners sit at the end.
- **Turn button**: enabled only on the current player's phone. Double taps can't skip anyone.
- **Host controls**: Skip the current player, go back one turn, give the turn to anyone (▶), end the game.
- **Extra buttons**: the host adds or removes buttons like "I win! 🏆" that every player sees. Pressing one shows a full-screen announcement on every phone.
- **Keeps the screen awake** using the Screen Wake Lock API.
- **Name saved** in the browser and reused next time. Reloading or a dropped connection puts you back in your seat.
- **↻ Refresh app** (bottom of every screen) clears the service worker and cache and reloads, so phones pick up a new version. You land back in your room.
- **Installable PWA**: "Add to Home Screen" on iOS or "Install app" on Android.

## Deploying (phones need HTTPS)

Install-to-home-screen, the wake lock and the service worker only work over
**HTTPS** (or on `localhost`). Phones reaching your laptop at `http://192.168.x.x:3000`
will work for playing, but won't stay awake or install.

Options:
- Quick test from your laptop: `npx cloudflared tunnel --url http://localhost:3000` gives you an https URL.
- Put the Docker container behind a reverse proxy with TLS (Caddy, Traefik, nginx; it must pass WebSocket upgrades), or host it on any Node host that supports WebSockets (Render, Fly.io, Railway, a VPS behind Caddy/nginx).

QR codes are drawn on the phone with the vendored [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), so no CDN is needed.

Rooms live in server memory: restarting the server ends all games. Empty rooms are cleaned up after an hour.
