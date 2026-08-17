# Kept

**For people who use what they read — not just finish it.**

Live at **[readkept.com](https://readkept.com)**.

You save thoughts while you read, tagged to the page they came from. You find any of them
again later. When you finish the book, you get tested honestly on what you actually took
from it.

This repo is also the **personal OS** it grew out of — a set of private modules (English
study, body, routines, a life-logging system) that only the owner's account can see. Kept is
the part of it that became a product.

## Run it

```bash
npm install
```

Create `.env`:

```
MONGO_URI=mongodb+srv://...
DB_NAME=personal_os
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
OWNER_EMAIL=you@example.com
APP_URL=http://localhost:3000
PORT=3000
```

```bash
npm start
```

Then open http://localhost:3000 — the landing page — or go straight to `/app`, which works
without an account.

`ENCRYPTION_KEY` (for storing a user's own API key), `VAPID_PUBLIC` / `VAPID_PRIVATE` (push
notifications) and the `TELEGRAM_*` vars are optional; the features that need them switch
themselves off when the key is absent.

## Shape

```
browser ──→ Node HTTP server (Railway) ──→ MongoDB Atlas (personal_os)
                  │                            users, books, conversation,
                  ├── node-cron agents         logs, shares, contacts, meta
                  ├── web push
                  └── Claude API (Anthropic) / Gemini
```

- **`src/webserver.js`** — every route and every `/api/*` endpoint, plus the admin page.
- **`reading/journal.html`** — the app itself: the shelf, thoughts, photo capture and crop,
  search, exams, the mentor, settings.
- **`webapp/landing.html`** — the public front door.
- **`src/coach.js`** — the mentor. Replies in prose and returns actions as JSON.
- **`src/users.js`** — who is allowed in, what they can use, and their daily allowance.

## Test

```bash
npm test
```

19 pure-function tests — no database, no network, under a second.

```bash
node scripts/smoke.mjs
```

62 assertions against whatever is actually deployed, including asking Google whether sign-in
would really work. Run it after every deploy; it exits non-zero when the live site is lying.

## Deploying

Push to `main`. Railway builds and restarts on its own. Bump `VERSION` in `src/index.js`
first so `GET /version` tells you which build is live.

---

Working on this with Claude? Read [CLAUDE.md](CLAUDE.md) — the current state, the data model,
and the ten mistakes this codebase has already made once.
