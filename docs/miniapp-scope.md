# Telegram Mini App — scope

## Why (Гриша's reason, and it's the right one)
The brain has limited daily fuel. Every command he must *remember and type*
(`/english`, `/englishreport`, `/library`, `/body`, `/deck`) is friction that spends
that fuel on operating the tool instead of on the work. Goal: **zero-memory,
one-tap, intuitive** — so he uses the maximum of it every day without thinking about
*how*.

## What "intuitive, no commands" actually means
1. **A persistent Menu button** on the bot chat (set once via BotFather). One tap
   always opens the app — no command, no memory.
2. **A home hub** inside the app: big tap targets — English · Body · Study deck ·
   Progress — everything reachable by tapping, nothing to recall.
3. The **conversation** (the English tutor, the coach) still happens in chat; the app
   is the **launcher + dashboard + interactive tools**.

## Why this needs real hosting (not the current Artifacts)
The deck and body map currently live on `claude.ai` as Artifacts, behind a strict CSP
that blocks external scripts. A true Mini App must load Telegram's
`telegram-web-app.js` SDK (for theme-sync, the native back button, safe-area/fullscreen,
and `initData` auth). That's only possible when **we host the HTML ourselves**. So the
core of this work is: serve our own pages, from our own URL, with the Telegram SDK.

## Architecture
- **Serve from the bot.** Add a small HTTP server to the personal-os process (Node's
  built-in `http`, no new deps) that serves static files (`webapp/home.html`,
  `study.html`, `map.html`) and, later, a few JSON endpoints. Bind to `process.env.PORT`.
- **Railway**: enable a public domain on the service (it currently runs as a worker
  with no port). One setting on Гриша's side; then the bot has an HTTPS URL.
- **BotFather**: set the **Menu Button** → Web App → that URL. ~2 minutes, his side.
  (I'll give exact click-by-click steps.)
- **Telegram WebApp SDK**: load it, call `Telegram.WebApp.ready()`, sync theme colors
  to CSS variables, wire the back button, use `initData` for auth (below).

## Phases
- **Phase A — the shell (the friction-killer).** Home hub + the deck + the body map,
  self-hosted, launched from the Menu button, theme-synced, back button. Data stays
  client-side (localStorage) for now. *This alone delivers the "one tap, no commands"
  win.* Meaningful first slice.
- **Phase B — live data.** Authenticated JSON endpoints (verify Telegram `initData`
  HMAC with the bot token, server-side) so the app shows his REAL data: English score
  trend chart, body-map entries synced to MongoDB (not just the device), System stats
  (level, Mind/Body, streak) as a real dashboard. This turns tools into his cockpit.
- **Phase C — polish.** Haptics, Telegram `MainButton` flows, offline caching,
  bot-initiated deep-links ("open your report").

## Security (must-haves)
- Verify `initData` server-side (HMAC-SHA256 with the bot token) on every data
  endpoint — otherwise the endpoints are open to anyone.
- The bot token NEVER reaches the client. Server only.
- Serve only static assets + authenticated APIs; no directory listing.
- Single-user for now (his chat id); the auth check also enforces "only him".

## What I need from Гриша (his side, small)
1. **Railway**: enable a public domain / networking on the service (so it has an HTTPS
   URL). I'll bind the server to `PORT`.
2. **BotFather**: set the Menu Button to the Web App URL (I'll give exact steps).

## Honest effort read
This is the **biggest single step so far**: it turns the bot from a pure worker into a
web service, adds a server, auth, and a front-end hub. It's very doable and the right
move for daily usability — but it's a multi-session build. **Phase A is the meaningful
first slice** and I'd ship that before touching live data.

## Recommendation
Self-host from the bot (one system, opens the door to live data), do **Phase A first**.
Alternative considered: host statics on Netlify/Pages (simpler, but siloed from his
data and a second place to manage) — rejected because the whole point is one living OS.
