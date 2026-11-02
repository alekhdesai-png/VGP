# Guess the Price — Vintage Edition

Friends guess the price of each card on their phones; your TV shows the live count, the reveal, and an animated leaderboard. One Node app, no build step, no accounts.

## Setup (once)

Needs Node.js 18 or newer (`node -v` to check; get it from nodejs.org).

```bash
cd guess-the-price
npm install && npm start
```

The terminal prints everything you need:

```
Players (phones):  http://192.168.1.23:3000/
TV / big screen:   http://localhost:3000/tv
Admin panel:       http://localhost:3000/admin
Admin PIN:         4821
```

The PIN is random on first run and then stays the same (it's saved in `data/game.json`). To choose your own: `ADMIN_PIN=2468 npm start` (Windows PowerShell: `$env:ADMIN_PIN="2468"; npm start`). Different port: `PORT=8080 npm start`.

## Game night, step by step

1. **Before guests arrive:** `npm start`. Open the **Admin panel** on your laptop, enter the PIN.
2. **Add your cards** (see below). Press **Wipe everything** first if you want to drop the 3 sample items.
3. **Put the TV view on the big screen** (`/tv`, press F11 / Ctrl+Cmd+F for full screen). It shows a big QR code; friends scan it and type a name.
4. **Run each item from the admin panel:**
   - **Start first item ▶** (or **Start** on any row) — phones show the card and a price box.
   - Watch guesses arrive under *Live guesses* (only you see amounts; the TV just shows "7 of 9 in" and who's locked in).
   - **Close guessing** (optional, stops late guesses) → **Reveal price** — TV shows the price, everyone's guess and points; each phone shows its own % off, points, total and rank.
   - **Next item ▶** — repeat. After the last item, **Next** shows the final podium.
5. **Play again:** *New game (clear scores)* keeps items and players. *Clear scores + players* makes everyone re-join.

Phones can lock, reload, or join late — they come back as the same player with their score (a token is kept in the phone's browser). If the laptop crashes, just `npm start` again: every change is saved to `data/game.json` immediately.

## Adding your real cards

**One at a time — "Create a question"** in the admin panel: card name, set, population, optional grade, a photo, and the true price. The preview shows exactly what players will see. Photos from your phone are shrunk automatically before upload. Edit, delete or reorder (▲ ▼) any time.

**Bulk add** — paste one per line:

```
Mickey Mantle #311, $1,200
Charizard | 1999 Base Set | 4,200 | 1250
Jordan rookie	1986 Fleer	22000	1450        ← tabs, pasted from a spreadsheet
```

Format is `name, price` or `name | set | population | price`. Then click **Edit** on any row to attach a photo.

## Scoring

Percent error = |guess − true price| ÷ true price, calculated on the server.

| Error | ≤5% | ≤10% | ≤20% | ≤25% | ≤30% | >30% |
|---|---|---|---|---|---|---|
| Points | 5 | 4 | 3 | 2 | 1 | 0 |

Edit the `SCORING` object in `lib/scoring.js` to change tiers. Ties on points go to the lower cumulative % error.

## If friends aren't on your Wi-Fi (internet fallback)

```bash
npm run start:tunnel
```

This starts the game plus a free Cloudflare quick tunnel and prints a public `https://…trycloudflare.com` link; the TV QR code switches to it automatically. The first run downloads `cloudflared` through npm (about 30–40 MB). To install it permanently instead:

- **macOS:** `brew install cloudflared`
- **Windows:** `winget install --id Cloudflare.cloudflared`

Manual alternative (any OS): run `npm start` in one terminal and `cloudflared tunnel --url http://localhost:3000` in another, then paste the printed URL into **Admin → Join link → Override join URL**. Anyone with the link can join, so share it only with guests. The URL changes every time you start the tunnel.

**Same-Wi-Fi troubleshooting:** if phones can't open the Wi-Fi link, allow Node through your firewall (macOS asks on first run — click *Allow*; on Windows choose *Private networks*). Guest/hotel Wi-Fi often blocks device-to-device traffic; use the tunnel there.

## Tests

```bash
npm test          # scoring + input-validation unit tests (boundaries at 5/10/20/25/30%, guess of 0)
npm run simulate  # 10 players × 5 items on a real server: leaderboard math, no price/guess leaks
                  # before reveal, duplicate/late/invalid guesses, reconnects, crash recovery
```

## Files

```
server.js         HTTP + WebSocket server, admin API, tunnel
lib/scoring.js    SCORING config + scoring function
lib/game.js       game state, rules, persistence, what each screen is allowed to see
lib/validate.js   money/name parsing, bulk-add parser
public/           player.html (phones), tv.html, admin.html — plain HTML/JS
data/             game.json + uploaded photos (created on first run)
```
