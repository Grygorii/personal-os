# Steward — the investing bot

The Telegram bot, rebuilt around one job. The old one was a life coach (water, sleep, quests,
English); this one keeps a trade journal and argues with him about it. It is a **separate
deploy off this same repository**, with its own bot token and its own database.

Read `CLAUDE.md` first for the state of everything else.

## The three apps, and why one repo

| App | Entry point | Deploy | Database |
|---|---|---|---|
| **Kept** — readkept.com | `src/index.js` (`npm start`) | Railway service 1 | `personal_os` |
| **Steward** — investing bot | `src/steward/index.js` (`npm run start:steward`) | Railway service 2 | `steward` |
| **Vitals** — pills, water (not built) | `src/vitals/index.js` | Railway service 3 | `vitals` |

One repository, three services. The shared plumbing — `db.js`, `llm.js`, `telegram.js`,
`config.js`, `ctx.js`, `shape.js` — is written once and fixed once. Three repos would mean
copying it three times and fixing every shared bug three times, which is too much for one
person with a day job. Three *services* means they cannot take each other down.

**The database boundary is the one that matters.** The Atlas cluster is **M0, 512 MB, shared
with SILKILINEN's live Stripe store**. Kept is on it too. A bot being actively rewritten has no
business in the same database as either, so `src/steward/index.js` **refuses to start** if
`DB_NAME` is still `personal_os`. That check is not a nicety — it is the whole isolation story
on a free tier where a second cluster is not available.

## What it does

Everything is trading. Nothing else.

- **Records trades from plain text.** "bought 10 MSTR at 402.50", "sold 5 mstr @ 390". No price
  given → a real one is fetched and shown with its source; it is never invented.
- **Keeps the thesis and the invalidation.** Every position carries *why I own this* and
  *I'm wrong if X*. The second is the point of the whole system.
- **Puts them back in front of him.** Before adding to a position, and on a schedule whether or
  not he asks. A position he has already called broken and still holds is raised every time.
- **Income, and whether it is safe.** Annual and monthly income, portfolio yield, and flags for
  the yield trap — payout over 100% of earnings, a yield high enough that a cut is being priced
  in, a dividend that has shrunk over five years.
- **Concentration limits, checked arithmetically** before the trade, not after.
- **The case for and against a ticker** (`idea MSTR`) — both sides, its own invalidation, and
  what it does not know.

It **never touches the broker.** He places every trade himself. That was his decision and it is
the reason the suggestion feature is buildable honestly at all: the worst case is a bad idea he
can reject, not money leaving while he sleeps.

## The rule everything else is arranged around

**A price the model wrote down is not a price.**

Asked "what is MSTR trading at", a language model answers confidently from training data months
stale. Here that is not a wrong answer, it is a wrong position. So:

- every market number reaches a decision through `market.js`, carrying its source and its age;
- the brain is *handed* prices as facts and told, in the system prompt, that they are the only
  prices that exist for it;
- a symbol with no quote is reported as having none — never estimated, and **never valued at
  zero**. A failed fetch that valued at zero would show a whole book as a total loss.

## Environment

```
TELEGRAM_BOT_TOKEN   a SECOND bot from @BotFather — not the coach's token
TELEGRAM_CHAT_ID     his chat id; the only one this bot answers
DB_NAME=steward      its own database (the process refuses to start on personal_os)
MONGO_URI            same cluster as everything else
ANTHROPIC_API_KEY    or GEMINI_API_KEY — same llm.js as Kept
MARKET_API_KEY       Finnhub, free tier, 60 calls/min
MARKET_PROVIDER      optional: 'finnhub' | 'stooq'. Defaults to finnhub when a key exists.
BENCHMARK            what his picking is scored against. Default URTH (MSCI World).
TZ                   schedules run in this zone
```

**Without `MARKET_API_KEY`** it falls back to Stooq: no key, no signup, but **end-of-day prices
and no dividend data at all**. For an income strategy that is most of what matters, so the free
Finnhub key is worth the two minutes.

## Deploying it

1. `@BotFather` → `/newbot` → a second token. Do **not** reuse the coach's.
2. Railway → the existing project → **New Service** → same repo.
3. Start command: `npm run start:steward`.
4. Set the env vars above, `DB_NAME=steward` among them.
5. Deploy. The log line to look for is
   `[boot] steward-1 · db=steward · prices=finnhub`.
6. It puts its keyboard up in Telegram on boot. Send `help`.

The coach keeps running on the old service and the old token until he decides to retire it.
Nothing here touches Kept.

## Schedules

| id | when | what |
|---|---|---|
| `steward-morning` | 08:00, Mon–Fri | before the US open, while there is still a choice about the day |
| `steward-weekly` | 18:00, Sunday | nothing to trade on, which is when a thesis can be looked at honestly |

Both **stay silent when the book has nothing worth saying**. Idle chatter is what made the old
bot easy to ignore.

## Layout

```
src/steward/
  book.js     pure: positions, P&L, income, yield traps, concentration. No db, no network, no model.
  market.js   prices and dividend data. The only source of a market number.
  store.js    Mongo, whitelisted on the way in and out.
  brain.js    prompts: the ground rules, his strategy, the voice.
  bot.js      Telegram — commands, buttons, scheduled reviews.
  index.js    boot, cron, the DB_NAME guard.
test/steward.test.js   20 tests over the money math.
```

`book.js` is pure on purpose, the same way `shape.js` is: a wrong number here is not a bad
screen, it is a bad trade, so the arithmetic is testable without a database or a model.

## His strategy, as the bot understands it

**Income that still grows** — high dividends, from companies that keep *raising* them. What
matters, in order: is the dividend safe (payout ratio, cover), is it growing, and only then how
big the yield is.

The trap it is built to guard against: **a very high yield is usually not generosity — it is
the price falling ahead of a cut that has not been announced yet.** A 4% payout growing 8% a
year beats a 12% payout that gets halved, and the bot is instructed to say so every time the
temptation appears. `dividendFlags()` catches it arithmetically rather than leaving it to be
argued about.

## The funding plan

`plan 1000 24` — $1,000 a month for 24 months, on top of what is already in.

This is not decoration. Without it the concentration rules are nonsense for a year: the first
buy is 100% of a one-position book, the second is 50%, and the bot spends twelve months
shouting about limits he is not actually breaching — which teaches him to ignore the warnings
that matter. Measured against **committed** capital, a $1,000 buy in month one is 4%, which is
the truth.

The plan is used to judge whether a position is oversized. The **actual book** is always what
gets reported. And once the book outgrows the plan, the book becomes the measure again — a
plan must never soften a real breach.

`plan` on its own reports what he has put in and how much is still to come. It deliberately
does **not** project a future value.

## The scoreboard

He already has a Revolut robo-advisor: global UCITS accumulating ETFs, EUR100 a month on
standing order, and — the hard part, which he is already doing — he does not touch it.

So anything he picks by hand has to beat that, or it is a hobby he is paying for. `score`
compares every buy against the same money going into `BENCHMARK` on the same day. It is
money-weighted on purpose: buying more of a winner after it has run must not flatter the
result, and a comparison that ignores WHEN the money went in is the one people reach for when
they want to like the answer. Sales are subtracted from the benchmark stake too, or he gets
credited with a position he no longer funds.

It is built to be able to tell him he is losing. That is the point of building it.

Under a year the number is mostly noise and the bot says so. Around year two it starts to
mean something.

## Not done yet

- Not wired to a token or deployed — steps above.
- No research digest (paste a filing → summary filed against the ticker).
- Closed positions keep a `review.lesson` field that nothing writes to yet. The lesson is the
  only part that compounds, so this is the next thing worth building.
- `positions` is the only collection; a watchlist is not built.
- The old coach's Telegram commands still live in `src/router.js` and are untouched. Retiring
  them is a separate decision.
