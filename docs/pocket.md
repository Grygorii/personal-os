# Pocket — the household's money

The third app off this repository. Kept is the reading product; Steward is the investing
journal; **Pocket is what comes in, what goes out, and what it all adds up to** across three
currencies — with one goal in front of it: **€2,000 a month in passive income**.

Read `CLAUDE.md` for everything else, and `docs/steward.md` for the investing side.

## The three apps

| App | Entry point | Database |
|---|---|---|
| **Kept** — readkept.com | `npm start` | `personal_os` |
| **Steward** — investing journal | `npm run start:steward` | `steward` |
| **Pocket** — household money | `npm run start:pocket` | `pocket` |

One repository, three Railway services, three databases on one M0 cluster **shared with a live
Stripe store**. Each entry point refuses to boot on another app's `DB_NAME`; that check is the
whole isolation story on a free tier where a second cluster is not available.

## The rule this app is built around

**An amount without a currency is not an amount.**

He earns and spends in euro, holds a portfolio in dollars, and has deposits and an apartment in
Egypt. So every figure is stored **in the currency it actually exists in**, and converted only
at the moment it is shown, at a rate that is fetched and dated.

- Nothing is ever stored converted. A stored conversion is wrong the moment the rate moves, and
  the original is gone, so it cannot be corrected.
- **There is no 1:1 fallback anywhere.** A missing rate produces `null` and is reported as
  "not converted". A silent 1:1 would value 1,200,000 EGP as 1,200,000 EUR and report the
  household as fifty times richer than it is.
- A converted figure is always shown **next to its original**: `540,000 EGP ≈ 10,000 EUR`. The
  euro number alone hides a devaluation; the pair does not.

## Two things it is built to tell him that a normal tracker will not

**1. What currency his net worth is actually in.** If most of what he owns sits in EGP while
every bill he pays is in EUR, that is the largest single risk in the household — larger than
which stocks he picks — and a single euro total conceals it completely. `worth` prints the
exposure and says so out loud above 50%.

**2. What an Egyptian deposit really earns.** A deposit paying 20% a year in EGP is not a 20%
return to someone who spends euro. If the pound falls 25% against the euro over that year, the
deposit **lost** money in the only currency that buys his groceries. `realReturn()` in
`src/fx.js` does that arithmetic. High local rates and devaluation are not two separate facts —
the first is largely compensation for the second, and it is the same question the investing side
asks about a high dividend yield.

## The grammar

One line, no forms. Currency is optional and defaults to `BASE_CURRENCY`.

```
in 3200 salary
out 40 food
in 27000 EGP rent
out 1 200,50 flights            European decimals work
add deposit 540000 EGP Cairo savings
add property 2700000 EGP apartment
add portfolio 1000 USD eToro
goal 2000
```

**A three-letter word is only a currency if it is actually a currency.** An earlier version
matched any three letters, so `in 3200 salary` recorded 3,200 **SAL** — a currency with no
rate, which silently dropped his most common entry out of every total. The currency is now
decided in code against a known list (`isKnownCurrency`), never by the shape of the word.

`rent`, `interest` and `dividend` count as **passive** without being told, because that is what
the goal measures. An explicit flag always wins — a category name is a label; `passive` is a
decision.

## The goal

`goal` reports the gap, then how long — as a **range across stated yields**, never a date.

€2,000 a month is €24,000 a year. At a sustainable 3.5% that needs about €686,000; at 7%,
about €343,000. Those numbers are printed, so the size of the thing is never hidden behind a
percentage bar.

`yearsToGoal()` returns a spread with `assumes: 'income reinvested, contributions held flat, no
tax, no inflation adjustment'` attached, and that string travels with the number wherever it is
shown. This is deliberately the opposite of the 31-year projection quoted to the dollar that he
was shown — same arithmetic, one optimistic yield, presented as a fact.

**And the honest headline: at his stage the savings rate moves the goal far more than the
picking does.** Going from €1,000 to €1,400 a month shortens the road by years; beating the
index by 1% on €25,000 is worth €250 a year. `goal` says so.

## Environment

```
TELEGRAM_BOT_TOKEN   a THIRD bot from @BotFather
TELEGRAM_CHAT_ID     his chat id — the only one it answers
DB_NAME=pocket       its own database (refuses to boot on personal_os or steward)
MONGO_URI            same cluster
BASE_CURRENCY=EUR    what everything totals in
FX_URL               optional: override the rate provider
TZ=Europe/Dublin     decides which month "this month" is
```

Rates come from `open.er-api.com` — free, no key, and it states its own update time, which is
kept and shown (`Rates today.` / `Rates 3 days old.`). A rate without a date is the same trap as
a price without one: it looks current.

## Deploying

1. `@BotFather` → `/newbot` → a third token. Not Kept's, not the steward's.
2. Railway → same project → **New Service** → same repo.
3. Start command: `npm run start:pocket`.
4. Env vars above, `DB_NAME=pocket` among them.
5. Look for `[boot] pocket-1 · db=pocket · base=EUR`.

## Layout

```
src/fx.js                shared: rates, conversion, the known-currency list, realReturn()
src/pocket/money.js      pure: accounts, flows, net worth, the month, the goal, parseEntry()
src/pocket/store.js      Mongo, whitelisted in and out
src/pocket/bot.js        Telegram — the grammar, the four buttons
src/pocket/index.js      boot and the DB_NAME guard
test/pocket.test.js      17 tests over the money maths
```

`money.js` is pure for the same reason `shape.js` and `steward/book.js` are: a wrong number
here is not a bad screen, it is a household misreading what it has.

## Not done yet

- **Never run against live Telegram or the live rate API.** The sandbox this was built in
  blocks the FX provider, so the fetch path is untested end to end.
- Recurring flows are stored and queryable but nothing re-stamps them into each new month yet,
  so salary and the Cairo rent need entering monthly until that lands.
- No web dashboard — Telegram only for now.
- Pocket holds the portfolio as a single `portfolio` account entered by hand; it does not yet
  read the steward's book directly, so the two need keeping in step manually.
- Nothing removes accounts or flows from Telegram yet (`removeAccount`/`removeFlow` exist and
  are unused).
