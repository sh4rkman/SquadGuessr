
<h1 align="center">
    <a href="https://squadcalc.app">
      <img src="./public/img/github/logo.png" alt="squadcalc logo">
    </a>
</h1>

<div align="center">
    <a href="https://discord.gg/BNPAc5kEJP">  
      <img src="https://img.shields.io/badge/Discord-111?style=for-the-badge&logo=discord&logoColor=white" alt="discord"></a>
</div>

# Submit a new guess

1. Turn on Squad's **screenshot mode** first, so the compass is not in your screenshot: click the eye icon at the bottom of the screen in the main menu.

   For a free camera, start Squad's Firing Range (training mode), open the console and load the map you want with `AdminChangeLayer <layer>`, e.g. `AdminChangeLayer Narva_AAS_v1`. You are admin there, so **Shift+P** switches to the admin camera and you can fly anywhere on the map.

2. Take a full screenshot ingame. Any screenshot tool works: you choose the part to show later in SquadGuessr, which also scales it to the right size. The easiest is Steam's own: press **F12** (Steam's default key), watch your screenshots in Steam and copy the one you want to the clipboard, ready to paste with Ctrl+V in **step 4**. Please consider taking your screenshots at quite high graphics settings for best UX on SquadGuessr.

3. Open SquadGuessr, click **SUBMIT A GUESS** in the menu and then **SUBMIT** (or go to `/?submit`).

4. Choose the map, paste your screenshot with Ctrl+V (or drop/choose the file), drag the square onto the part you want to show and click on the map where the screenshot was taken. Click **ADD** and repeat for more screenshots. Click a guess in the list to correct it, then **SAVE**.

5. Click **DOWNLOAD ZIP** and upload the ZIP on [Discord](https://discord.gg/BNPAc5kEJP) (suggestion channel).

## Reviewing submissions

Click **SUBMIT A GUESS** → **REVIEW** in the menu (or go to `/?review`), drop the ZIPs from Discord onto the page and accept (`A`) or reject (`D`) every guess. Images in a ZIP may be WebP, PNG or JPEG (up to 32 MB). **EXPORT** downloads one ZIP with the accepted guesses: `guesses.json` and the images under `img/guesses/`, every one turned into a 900×900 WebP (the centred square) under a new random name. **CLEAR** empties the review for the next batch. Every entry looks like this:

```json
{
    "map": "Narva",
    "mode": "easy",
    "url": "/img/guesses/PTWxNN2RRl9vC8G.webp",
    "lat": -1402.4167693765319,
    "lng": 1438.0344360576973,
    "submitter": "your preferred nickname/ingame-nick here"
}
```

# Multiplayer server

Group sessions ("Play with friends") need the small WebSocket server in `server/`.

**Development**

```bash
npm run server   # ws server on :3001 (MP_PORT to change)
npm start        # dev server proxies /mp to it, reachable from phones on the LAN
npm test         # server + scoring tests
```

**Production (Docker Compose)**

Your existing reverse proxy terminates TLS and forwards the domain to the `web` container:

```bash
cp .env.example .env   # optional, see variables below
docker compose up -d --build
```

| Variable | Default | |
|---|---|---|
| `WEB_BIND` | `127.0.0.1` | use `0.0.0.0` if the reverse proxy runs on another host |
| `WEB_PORT` | `8080` | point your reverse proxy here |
| `API_URL` | `https://squadguessr.app` | upstream for `/api/` (guesses and images) |
| `SEARCH_ENGINES` | `false` | allow indexing in `robots.txt` |

The reverse proxy must pass WebSocket upgrades for `/mp` (Caddy and Traefik do this automatically; plain nginx needs `proxy_http_version 1.1` plus `Upgrade`/`Connection` headers; Nginx Proxy Manager: enable "Websockets Support").

Sessions live in memory only; `docker compose up -d --build` after an update restarts the server and ends all running sessions.

Guesses and images come from the public API at `https://squadguessr.app/api/`.
Building the frontend outside Docker needs Node ≥ 20.9 (required by `copy-webpack-plugin`); the server and `npm test` run on Node 18.

# **Support the project**
[![buy me a coffee](https://img.shields.io/badge/BUY%20ME%20A%20COFFEE-b12222?style=for-the-badge&logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/sharkman)  



