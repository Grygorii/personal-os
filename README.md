# Personal OS

One always-on worker that runs your personal agents over Telegram, backed by your
existing MongoDB Atlas cluster. "10 agents" is **1 engine + N config rows** — you
add agents, you don't add programs.

```
Telegram  ←→  worker (Railway)  ←→  MongoDB Atlas (personal_os db)
                  │                      profile  (shared memory)
                  ├─ node-cron           logs     (water/sleep/book/essay events)
                  ├─ runtime.js          agents   (the registry)
                  ├─ router.js           reading  (current book state)
                  ├─ system.js           system   (XP, level, quests, streak)
                  └─ agents/*            conversation (coach memory)
                  └─ llm.js  → Claude API
```

## What's in here

- **coach** (`src/coach.js`) — the brain. You just *talk* to it. Every message goes to
  Claude with your full context (profile, last 7 days of logs, what you're reading,
  recent conversation, and your live System state). It reads the situation, replies in
  whatever register fits, and quietly logs anything worth remembering. Over time it
  **learns you** — durable insights get written back into your profile — recommends a
  real-world **skill** to train as you level up, and **gently verifies** logs that look
  off instead of blindly crediting them. It also reaches out on its own — a morning and
  an evening check-in, and reads your mood across days.
- **shortcuts** (`/water`, `/read`, `/suggest`, `/progress`, `/finished`) — optional fast
  paths handled by `src/agents/*`. They log *and* feed the System, exactly like talking to
  the coach. Everything that isn't a slash-command goes to the coach.
- **the System** (`src/system.js`) — a Solo-Leveling-style layer over your real actions.
  Everything you log feeds four stats (Vitality, Mind, Forge, Discipline), earns XP, and
  clears daily quests; XP compounds into levels on an **accelerating, uncapped curve**
  (gentle early, a real grind up high — there's no winning, only climbing). Levels map to
  **hunter ranks** (E→D→C→B→A→S→National→Monarch); Monarch at Lv.100+ is a lifetime away.
  **Energy** is derived live from last night's sleep
  and today's water (0–100). **Debuffs** (sleep-debt, dehydration) and **buffs** (well-rested)
  are honest mirrors of how your body is doing — they have teeth (cap energy, shave/boost XP),
  but are never punishments for gaming. `/status` shows it all. Mirror, not bribe: the numbers
  track growth you're already choosing.

The coach is situational and autonomy-supportive by design: no fixed tone, and it aims to
get you moving because *you* want to — never because it pushed you.

## Setup

1. **Install**
   ```bash
   npm install
   ```

2. **Make a Telegram bot** — message [@BotFather](https://t.me/BotFather), `/newbot`,
   copy the token.

3. **Env** — `cp .env.example .env` and fill it in. Use a **separate database name**
   (`personal_os`) on your existing Atlas cluster so this stays out of SILKILINEN's data.
   Leave `TELEGRAM_CHAT_ID` blank for now.

4. **Seed** the profile + agent registry:
   ```bash
   npm run seed
   ```

5. **Run**
   ```bash
   npm start
   ```

6. **Get your chat id** — message your bot `/start`. It replies with your chat id.
   Paste it into `TELEGRAM_CHAT_ID` in `.env` and restart. Now agents can DM you
   proactively on schedule.

## Daily use

```
/status                  open your status window (level, rank, energy, quests)
/ranks                   see the full rank ladder (E → Monarch)
/read Antifragile        start a book you chose
/suggest                 get a recommendation
/progress halfway, ch 8  log where you are
/finished                mark it done
/water 0.5               log half a litre
```

When the book coach asks an essay question, just reply in normal text — your reply
becomes the essay and it answers with feedback.

## Deploy to Railway

Push this repo, create a Railway service from it, add the same env vars in Railway's
dashboard. It's a long-running process (not a web server), so no port needed. The
`start` script is `node src/index.js`.

## Adding a new agent (the whole point)

**Simple scheduled nudge** (e.g. a morning intention prompt): create
`src/agents/morning.js` exporting `run()`, register it in `src/runtime.js`'s
`runners` map, and add a row in `src/seed.js`'s `agents` array with a cron schedule.
Re-run `npm run seed`. Done.

**A command-driven agent** (e.g. sleep): also export `command(text)` to parse things
like `/sleep 23:30` / `/wake 07:00`, log to the `logs` collection with a new `type`,
and add the module to the `handlers` array in `src/router.js`.

All agents share the `profile` document, so each new one automatically "knows you".

## Notes

- Free Atlas tier has **no backups**. If your essays matter, add a weekly export later.
- `CLAUDE_MODEL` defaults to Sonnet. Bump to an Opus model for richer coaching at higher cost.
