# Royal Blackjack Online

Multiplayer blackjack, up to 4 players per room, one shared shoe (1-6 decks).
The host sets decks + starting chips; others join with a 4-letter code or an invite link.

## Run locally
    npm install
    npm start          # http://localhost:3000
    npm test           # 4 simulated players play 4 rounds

## Play with friends on the same Wi-Fi
Find your PC's IP (`ipconfig`); friends open `http://<your-ip>:3000`.
Allow Node through Windows Firewall when prompted.

## Host it on the internet

### Option A - Render.com (free, easiest)
1. Put this folder in a GitHub repo (node_modules is git-ignored).
2. render.com > New > Web Service > pick the repo.
3. Build command `npm install`, Start command `npm start`, Instance type Free.
4. Open the URL Render gives you and share it. (Free tier sleeps after ~15 min idle; first load takes ~30s.)

Railway, Fly.io and any VPS work the same way (Node >= 18, `npm start`, honours `PORT`).

### Option B - From your own PC, no deploy
    npx cloudflared tunnel --url http://localhost:3000
Share the https URL it prints. Works while your PC and the server are running.

### Option C - VPS (Ubuntu)
    npm install && npm i -g pm2
    pm2 start server.js --name blackjack && pm2 save
Put Caddy/nginx in front for HTTPS (WebSocket upgrade headers must pass through;
Caddy's `reverse_proxy localhost:3000` does this automatically).

## Rules
Up to 6 players, 1-6 decks (shared shoe). Dealer stands on all 17s, blackjack pays 3:2, double on first two cards,
split pairs (one split, split aces get one card), insurance when the dealer shows an Ace (pays 2:1). Min bet $10.
Win the match by reaching the goal (default 10x starting chips) or by outlasting everyone; final ranking 1st-6th.
No rebuys. Refreshing rejoins your seat. Sound effects + music are generated in the browser (toggle top-right).
Rooms live in server memory (restart = rooms gone); run a single instance.
The original single-player game is kept as `original_singleplayer.html`.
