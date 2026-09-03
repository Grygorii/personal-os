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

The "interest a year" card said this for one deposit and then printed a confident euro total for
all of them — €6,622 a year, **24% of his entire net worth**, as though it were income. It now
carries the bar the currency has to clear: his EGP deposits pay 19.5% on average, so **if the
pound falls more than 16.3% against the euro this year that interest is a loss** in the money that
buys his groceries. `breakEvenFall()` — the same arithmetic as `realReturn`, solved for zero, so
it needs no forecast and no rate history. The rate is weighted by money, not by count: a rate on
500,000 matters more than one on 5,000.

### Extra payments

He had been overpaying his euro loan, and the app showed him owing more than he did — because the
balance was **derived from dates**: what a borrower who paid exactly the schedule and nothing more
would owe. It had no way to hear about the 500 he put in last March.

A liability now carries `payments[]`, its own history of everything paid beyond the instalment: an
overpayment, a lump off the principal, an instalment from before the start date the loan is set
to. `+ I paid extra` on any loan records one.

So `balanceNow` **walks** the loan instead of discounting it — period by period, interest, then
the instalment, then whatever else he actually paid that period. Present value gives the right
answer only for a borrower who never deviated from the schedule; walking hears about every extra
euro. The two agree exactly when there are none, which is the regression test.

And then the number no lender ever puts on a statement: **how many months earlier this clears and
how much interest he never pays.** Same principal either way, so every euro of difference in what
he hands over is interest — €1,500 on that loan takes eight months off the end.

A payment dated in the future has not been made. A balance never goes below nothing, and never
above what was borrowed.

*(Half a cent is treated as nought. Walking ten periods lands on 3.6e-11 rather than 0, and a `> 0`
test on that quietly adds a whole extra instalment to how long the loan has left.)*

### One loan, one rate

The card charged Loan 1 at the 24% on its paperwork, directly beneath a warning saying the loan
costs 20.6%. Two numbers on one screen disagreeing about the same loan — the shape of invariant 9
in `CLAUDE.md`. Interest on a liability is now charged at the rate its payments imply, wherever
that is known, so the warning and the card are the same figure.

## The grammar

One line, no forms. Currency is optional and defaults to `BASE_CURRENCY`.

```
in 3200 salary
out 40 food
in 27000 EGP rent
out 1 200,50 flights            European decimals work
add deposit 540000 EGP Cairo savings
add property 2700000 EGP apartment pays 27000 monthly
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

### Dates, and how often it pays

```
add deposit 495000 EGP 20% quarterly start 28.05.2024 end 28.05.2027
```

A rate on its own is a property of the paper. A rate **with a term and a frequency** is money on
a date, which is the only form he can plan around — so a dated holding reports what it has
already paid, what is still to come, how far through it is, what each payment is, and when the
next one lands.

- Dotted and slashed dates are read **day first** (`28.05.2024` is 28 May); ISO is read as
  itself; anything else is `null` rather than a guess. A misread date shifts every interest
  figure that hangs off it.
- The keyword claims the date after it and **both leave the label**. Before this, `start
  28.05.2024 end 28.05.2027` ended up as the deposit's name.
- `monthly` · `quarterly` (`kvartally` works too) · `yearly` · `maturity`. Nothing said stays
  nothing said — assuming monthly would invent twelve arrivals a year that never come.
- Only on `add` lines. A spend may legitimately be called "monthly gym", and swallowing that
  word as a frequency would silently rename the category.

Interest on a **deposit** is simple, on the principal, because that is how these certificates
pay. Compounding would overstate the return, and overstating a return is the one direction this
app is not allowed to be wrong in.

### A loan is repaid; a deposit is not

The first version treated both the same and showed his car loan as costing 26,700 EGP a quarter —
445,000 × 24% ÷ 4, interest and nothing else, **about half his real bill of 58,063.45**. A deposit
pays a coupon and returns the principal at the end; a loan repays principal in every instalment.

So an account can carry the **payment** — what actually moves each period, off his own statement:

```
add loan 445000 EGP 24% quarterly pays 58063.45 start 28.11.2024 end 28.05.2027
```

The stated payment **overrides every calculation here**, because a bank's number beats an app's
arithmetic. With none given, a liability now gets the amortising payment (60,461 for that loan)
and is labelled an estimate — amortisation depends on fees and day-count conventions the app
cannot see.

**And a stated payment reveals the true rate.** Repaying 58,063.45 ten times on 445,000 borrowed
is 135,634 of interest, which is **20.6% a year, not the 24% on the paperwork**. `impliedRate()`
solves it by bisection and the pay-this-first comparison uses that figure, because comparing the
paperwork's rate against an expected yield compares the wrong thing. It is the same question the
app already asks of a high deposit rate, pointed the other way.

### What is owed today is not what was borrowed

`balanceNow()`. The app subtracted the full 445,000 from his net worth while he was **seven
payments of ten** through clearing it — every instalment he had made was invisible, so paying the
loan down looked like nothing happening.

What he still owes is the **payoff**: the instalments still to come, discounted at the loan's own
rate — the one his payments imply, not the headline, or the schedule would not even return the
principal on day one. Not the raw sum of them either: that includes interest for years he has not
reached, and settling tomorrow would not cost that. Net worth, currency exposure and the yearly
interest bill all follow that number. Everything that is not an amortising liability keeps exactly
the figure he typed.

Terms are measured on the **calendar**, not in days ÷ 365. That version reads a one-year
certificate opened on 1 January 2020 as 366/365 of a year and pays 10,027 on a round 10,000 —
quietly wrong on every term that spans a leap day (`yearsBetween`).

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

## The backup

His whole household — four certificates, four loans, a flat, the subscriptions, the plan — lives
in one collection on a free-tier cluster shared with a live shop, behind delete buttons that have
no undo. Until now there was **no way to get the data out at all**. That was the largest remaining
risk in this app, and it is not a money bug: a mistake or a bad day for Atlas takes the lot.

```
backup
```

The bot sends everything as a dated JSON file — holdings, entries, subscriptions, goal, plan, with
Mongo's own keys stripped so a person can read it. It lands in a chat he keeps for ever, which is
the point: **a backup must not live inside the thing being backed up.**

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
5. Look for `[boot] pocket-16 · db=pocket · base=EUR`.

**Which build is actually serving?** `GET /health` (or `/version`) answers without Telegram —
`{"ok":true,"app":"pocket","version":"pocket-16"}`. The marker lives in `src/pocket/version.js`;
bump it on every deploy. Kept has `GET /version` for exactly the same reason: "is my change even
out there yet" is the first question of every deploy, and guessing at it wastes an evening.

## Layout

```
src/fx.js                shared: rates, conversion, the known-currency list, realReturn()
src/pocket/money.js      pure: accounts, flows, net worth, the month, the goal, parseEntry()
src/pocket/store.js      Mongo, whitelisted in and out
src/pocket/bot.js        Telegram — the grammar, the buttons, /subs
src/pocket/index.js      boot and the DB_NAME guard
src/pocket/web.js        the Mini App server; buildState() is pure and fixture-testable
src/pocket/app.html      the Mini App itself — four tabs, the month strip, the edit sheet
test/pocket.test.js      the money maths
scripts/pocket-render.mjs  does the page actually DRAW? (npm run render:pocket)
```

`npm test` proves the arithmetic; it cannot prove the page survives contact with it. A
`ReferenceError` in one line of an inline script does not fail softly — it kills the whole script
and serves a blank page with every unit test still green. `scripts/pocket-render.mjs` builds the
real `/api/state` payload from fixtures, runs `app.html`'s script against a small DOM shim, and
checks that all six panels drew, across five states: this month, a month scrolled back to, an
empty month, no exchange rates, and a brand new Pocket with nothing in it. Same reason
`scripts/smoke.mjs` exists on the Kept side.

`money.js` is pure for the same reason `shape.js` and `steward/book.js` are: a wrong number
here is not a bad screen, it is a household misreading what it has.

## Why this app uses `rawCol()`

`col()` returns a **per-user view** of a collection, and every one of its methods calls
`uid()` — which **throws when there is no user context**. That scoping is right for Kept, where
one database holds many people. It is wrong here: Pocket is single-tenant with a database of its
own, so a `userId` on every document would be a constant that buys nothing, and there is no
user context to establish.

So `rawCol()` is correct, and this section is the justification `CLAUDE.md` asks for whenever
it is used.

Found the hard way. Built on `col()`, it connected and then died on `createIndex`, which the
scoped view does not expose. Had that call not been there it would have crashed later, on the
first save, which is a far worse place to discover it. `test/pocket.test.js` now asserts both
apps import `rawCol`.

## The Mini App

Chat is the fastest way to **record** something and a poor way to **look** at anything: no
tabs, no colour, no way to scan a month. So the bot keeps the typing and a Telegram Mini App
serves the seeing — six tabs: **Month · Worth · Subs · Goal · Plan · Rates**.

## Subscriptions

The only category of spending nobody decides to make twice. It is agreed once and then charges
for ever, which is why it is a **thing** in this app and not a spend recorded after the fact:
what matters about Netflix is not the €12.99 that left last Tuesday, it is that €155.88 a year
is committed until someone actively stops it.

```
sub 12.99 netflix monthly
sub 90 icloud yearly
sub 4500 EGP kvartally gym
sub 45 EUR quarterly gym from 01.03.2025
```

Two numbers the Subs tab exists to produce, and neither is visible from a list of charges:

**1. Everything per year.** A yearly bill and a monthly one cannot be compared until both are
annual — €90 a year is cheaper than €9 a month and does not look it. Weekly is ×52, not ×4×12;
treating a week as a quarter of a month understates a weekly bill by 8%, which is small enough to
look right and wrong every single time.

**2. What the bill costs in capital.** A bill that never ends has to be funded by capital that
never ends. €48 a month is €579 a year, which at the same yields the Goal tab uses needs
**€8,000–€16,500 invested behind it** — money he has to build before the goal is real. Cancelling
a quarter of it is worth years of contributions, and no expense tracker ever says so. It is the
same question the app already asks of a deposit and a loan, pointed at spending.

Other decisions:

- **A cancelled subscription is kept, greyed, not deleted.** `endsAt` is set the day he cancels.
  One that still bills until March is money he owes, and the row is the only record that he
  stopped it — deleting it makes cancelling look like nothing happened.
- **A free trial is not a charge.** `trialEndsAt` pushes the first real charge out to the day it
  expires and raises a warning before it does, because that is how subscriptions actually cost
  people money: not by being expensive, by starting.
- **Nothing is ever recorded automatically.** ✓ turns a subscription into a real spend in the
  month, tagged with `subId`. Stamping charges on a schedule would fill his months with spending
  that may have failed, been refunded, or been cancelled the week before.
- **A charge is tagged but not flagged `recurring`.** The subscription *is* the recurring record;
  both would put the same bill in two separate "you have not entered this yet" lists.
- **A charge lands in the month on the day it bills.** This was wrong at first: subscriptions were
  deliberately kept out of the month's totals, on the reasoning that a subscription is what he has
  *agreed* to pay and a flow is what has *left*. Over-careful, and it made the month wrong — a
  household paying for Netflix and a gym showed OUT of nothing. A charge on the 14th is exactly as
  real as a coupon on the 28th, so it goes through the same two rules as every other scheduled
  payment: only a date that has passed counts, and recording one replaces it.

`out 40 monthly gym` is still a spend called "monthly gym". The two shapes stay apart, or every
gym bill becomes a commitment.

## A flat, and the rent it pays

He could not add his apartment with its rent, and the reason was structural: an account only
produced anything if it had a **rate**. A deposit is described by a percentage; **a flat is not**.
He knows the rent is 27,000 EGP a month, not what fraction of the building's value that happens to
be. So the income had nowhere to go and the flat sat in his net worth doing nothing.

Either now describes an income — a rate, *or* an amount and how often it arrives:

```
add property 2700000 EGP apartment pays 27000 monthly
```

From that one line the app gets everything: the rent appears on the Worth row, it lands in every
month as `rent` (which is passive, so it counts towards the €2,000 goal), it joins "already
contracted", and it produces the number he never had — **12% a year on what the flat is worth**.
That is the same question the app asks of a deposit rate, asked of bricks, and it is how a lazy
building gets noticed. Below 4% it says so.

A tenancy he has had for years has no interesting start date, so with none given the schedule is
anchored to the day he added it. Better than refusing to show the rent at all.

### A flat is not a certificate

He said "I am not sure apartment counted correct", and he was right. His apartment carried **"Pays
back 2,032,000 EGP at maturity"**, counted its rent as though it accrued daily like interest, and
the app was ready to announce in April 2027 that the flat had *matured* and the money was sitting
idle.

One `endsAt` meant two different things:

| | A certificate | A flat |
|---|---|---|
| What the end date is | the **term** ends | the **tenancy** ends |
| What happens that day | the bank hands the principal back; the holding ceases | nothing — the building is still his |
| What "so far" means | interest **accrued**, day by day | rent **received**, payment by payment |

`REDEEMABLE_KINDS` is the distinction. `valueAtMaturity` is `null` for anything that is not
redeemed, `matured` means *the money came back* and is now only ever true of a deposit, and a new
`ended` means only that the end date has passed. Rent is measured on a cash basis: on the 20th he
has had this month's payment and not a twentieth of next month's.

The warnings follow. A certificate maturing says the capital is idle and asks where it goes next.
A tenancy ending says the opposite: *you still own it, nothing came back and nothing is idle — but
it pays you nothing until it is let again.*

### What a review turned up

Two correctness bugs, both found by reading rather than by using:

**Ids collided inside a millisecond.** `Date.now().toString(36)` gives one id fifty times if you
call it fifty times in a row. Flows, accounts and subs all carry a *unique* index on `id` — so
that is either a 500 he sees, or, for an account (saved by upsert **on that id**), the second one
silently replacing the first. A holding lost without an error is the worst thing this code can do.
`newId()` adds a counter and a random tail; 5,000 in a tight loop are now 5,000 distinct.

**A tenancy that had run out was still reported as income.** Collateral damage from the fix above
it: narrowing `matured` to mean "the money came back" (only ever true of a certificate) left
`contractedIncome` gating on it, so every *ended* arrangement stayed on the books for ever. A let
that expired in 2024 was still reporting €305 a month. Exactly the failure this app exists to
prevent, introduced by the change that fixed the one beside it.

And two things that were simply in the way:

- **The Add button sat on top of the content**, centred, covering the middle of whatever row was
  under it — the part of a line that carries the words. It is in the corner now.
- **Worth was one long list** ordered by kind, so reaching the loans meant scrolling past four
  certificates, and neither side had a subtotal: "how much do I owe" could only be answered by
  adding rows up in his head. **What you own** and **what you owe** are now two sections, each
  with its total in the heading.

*(Measured, not assumed: `buildState` takes 22 ms with nine holdings, three hundred entries and
eight subscriptions. Performance needed no work, so none was done.)*

### The hazard this created, and the guard for it

He has typed the Cairo rent by hand every month for a year. Those flows carry no `schedId`, so
the exact-id guard cannot see them — and the day the flat learned to produce its own rent, every
one of those months would have counted it **twice**.

So a recorded flow that *looks like* a scheduled one is treated as it: same direction, same
currency, the same amount within 1%, within five days of the date. The match is deliberately
tight — a different amount, month, currency or direction is different money. Suppressing a real
projection is a small loss; double-counting the rent is a wrong total, and a wrong total gets
believed while a missing one gets noticed.

## The Rates tab

Nine tenths of what he owns is in Egyptian pounds and every bill he pays is in euro. That is the
largest single fact about this household — larger than which deposit pays what — and the app could
convert his money for months without ever saying what the currency itself had cost him.

**`realReturn()` had been in `src/fx.js` since the first week and had never once run.** Nothing
ever passed it a rate from the past. So:

- **One rate for the whole position, because that is how the money got there.** He did not *earn*
  Egyptian pounds — he took euro and exchanged them, so every pound has a known euro cost, and
  asking him to type a starting rate into five separate holdings was asking five times for one
  fact. `What did you exchange EGP at?` on the Rates tab takes it once and stands in for every
  holding without a rate of its own; a certificate bought in a different year can still carry
  its own, and always wins.
- **Measured from the day he bought in, not from the day this app started watching.** The first
  version compared today against the oldest daily snapshot, which on day one read *"0.0% since
  Sep 2"* — a fact about the app, not about his money. The date now defaults to the earliest
  holding in that currency, so the only thing he types is a rate.
- **What he put in, against what it is worth.** Neither is an estimate: he knows what he paid and
  the app knows today's rate. His 20% certificate, bought at 48 and marked at 59, has returned
  **−2.4% a year in euro.**
- **A falling currency erodes a foreign DEBT in his favour** — same arithmetic, opposite sign.
  Getting that backwards would tell him a falling pound was costing him money it is saving him.
- **The size of the bet, with no forecast in it.** "If EGP weakens 10% you are €4,130 poorer; at
  20%, €7,572." That needs no history and no opinion — it is what he is already holding.
- **The rate is recorded once a day** from now on (`meta`, one small document, written by the
  first open of the day). Nothing is backfilled. With fewer than two days on record the tab says
  the record starts today rather than drawing a line through one point.
- **Where he has not said what he paid, it asks.** A made-up starting rate makes a made-up gain,
  which is worse than no answer.

## What the month already knows

A deposit coupon and a loan instalment are the two largest and most predictable movements in this
household, and for a long time neither appeared in a month at all: **In** and **Out** counted only
what he had typed. A month missing 1,075 EUR of loan payments and a 419 EUR coupon is not a
picture of the month.

These are not guesses. A certificate paying 24,750 EGP on 28 November and a car loan billing
58,063.45 on the same day are contractual and dated — which is exactly what separates them from
"salary probably arrives". So they are projected in. Two rules keep that honest:

1. **Only a payment whose date has passed counts.** One still ahead gets its own "still due this
   month" card and a projected month-end figure, because *left over* has to keep meaning what
   actually happened. Folding a future charge into it turns the record of a month into a forecast
   of one, and then the same number means two different things depending on the date.
2. **Every projection has a stable id** (`<accountId>:<YYYY-MM-DD>`) and a recorded flow carrying
   that id **replaces** it. That one field is all that stands between this and a month counting
   the same coupon twice — which is worse than never showing it, because a wrong total is trusted
   and a missing one is noticed. The ✓ on a scheduled row records it, so there is never a reason
   to type it by hand.

A coupon is `passive`, so it joins the goal on the day it pays. The Goal tab's "already
contracted" card is the yearly *rate* behind those holdings; the figure above it counts only what
has landed.

**And a loan instalment is not all spending.** Part of it buys back his own debt — 49,936 of that
58,063, this late in the term. That part is saving wearing the clothes of an expense: he is poorer
in cash and exactly that much less in debt. The Month tab splits it and says so, because a surplus
that treats debt repayment as consumption understates what he is actually building.

### The year along the top

The Month tab opens on a strip of twelve months, each with its own surplus, and tapping one
loads it. One month is a number; twelve months is a shape, and the shape is what says whether
this month is normal. Empty months stay in the strip, dimmed — a month silently missing reads
as a month that did not happen, which is the opposite of a month nothing was recorded in.

The whole strip and the month being read come back in **one query**, because thirteen round
trips to a shared M0 cluster to scroll back through a year is not a thing to do.

The Goal and Plan tabs are always about **now**, whichever month is on screen. Reading a thin
August must not quietly rewrite the ten-year projection.

### Editing, and repeats

Every entry and every holding has a pencil beside it that opens a real form — name, amount,
currency, date, and for a holding its kind, rate, term and payout frequency. Deliberately not
the one-line grammar: retyping `out 40 food` to fix a mistyped amount produces a **second**
entry, and a month that double-counts is worse than one that was wrong once.

The currency is a **list, never a text box**. "EGY" typed into a free field sanitises to nothing,
falls back to the base, and silently moves an Egyptian holding into euro.

An edit is a patch of named fields (`patchFrom` is the whitelist) merged over the stored
document and *then* sanitised. The order matters: cleaning the fragment alone and `$set`-ing it
would drop every field the fragment did not mention — the same shape of bug as `saveBooks`
deleting a quiz. The id always comes from what is stored, never from the patch.

**Repeats.** Anything marked recurring that has not been entered again this month appears as a
list to confirm, one tap each. Nothing is ever auto-created and none of it is added to a total:
salary that has not arrived is not income. But a month missing its salary does not read as "he
forgot" — it reads as a household that earned nothing, with a surplus to match.

### Two things the Worth and Goal tabs now say out loud

**A term that has ended earns nothing.** Before dates existed the app could not know that, and a
certificate that matured in 2021 went on reporting its interest for ever. Ended and not-yet-
started terms are excluded from the yearly interest figure and named, so a smaller number is
explained rather than mysterious. A matured certificate also raises a warning of its own —
capital sitting idle is invisible everywhere else in the app.

**Contracted is not counted.** What his holdings are scheduled to pay sits in its own card on the
Goal tab, never inside the bar. A promise is not income, and a goal that counts promises can be
reached without any money arriving. But showing `0` beside a certificate paying 24,750 EGP a
quarter reads as an app that does not know about the certificate.

It is a public URL in front of a household's finances, so two checks guard every API call:
Telegram's signed `initData` verified server-side against the bot token (constant-time, with a
freshness window), **and** the verified Telegram user id must equal `TELEGRAM_CHAT_ID`. A valid
signature only proves the request came from Telegram — not that it came from him. No cookie, no
fallback path, no initData no answer.

Railway sets `RAILWAY_PUBLIC_DOMAIN` once a domain is generated, so the "Open Pocket" button
usually needs no configuration; `POCKET_URL` overrides it.

### A loan never speaks in the language of a deposit

The Worth tab showed `3,191 EUR earned so far`, **in green**, on money he was paying out. A
liability now has its own wording (*paid so far* / *still to pay*), its own red bar, its own
"still owed of the … borrowed" line, and the sentence that matters most: what the whole term
costs and what rate that really is.

### Why colour never carries meaning alone

Green for money in, red for money out — which is the pair the palette validator scores at
**ΔE 7.7 for deuteranopia**, the commonest colour blindness. Measured, not guessed. The rule is
that such a pair is legal only with a *secondary encoding*, so here money in is a **filled dot
prefixed +** and money out is a **hollow ring prefixed −**. Either signal alone reads correctly.

## The Plan tab: something you build

His verdict on the first version was "completely not clear", and he was right. It projected from
a measured surplus he could never see, through four `prompt()` boxes, at one yield for every kind
of money. **A projection you cannot take apart is not a plan, it is a claim.**

It is now a list of named pieces, in his words, each editable:

| He says | It is |
|---|---|
| "500 from salary" | `contribution` — money he moves into the pot each month |
| "rent from apartment 1" | `income` — money that arrives; also counts towards the goal |
| "deposit 10000 under 2%" | `lump` with `ratePct: 2` — lands once, grows at **its own** rate |
| "in year 3, another apartment" | `income` from `atYear: 3` |
| "car insurance until year 4" | `spending` with `untilYear: 4` |

The pieces are listed *before* the result, and the total that goes in each month is visibly their
sum. The measured surplus is the first row in that list rather than a hidden ingredient — with a
button to ignore it, because "start from what I actually saved" and "only count what I have
listed" are both honest and which he means is a decision, not a default to guess at.

### A workbench, not a slideshow

The first rebuild put the pieces above the projection and then spent most of the page on ten
year-blocks, each with a bar, a capital figure, a range and a monthly figure. He called it "just
for showing", and he was right: **a bar under a number that is already printed is decoration**, and
ten of them were sitting on top of the only part he can change.

So the tab is his plan first — the pieces, with the monthly total in the heading — then *what it
comes to* as one card, then the years as a plain table behind a fold for when he wants to read
them.

**And the horizon is now his.** `setPlanYears` had been on the server the whole time with nothing
in the page to call it, so the plan was stuck at ten years. 5 / 10 / 20 / 30 sit beside the result.
That is not cosmetic: at ten years his plan reads "not enough to reach €2,000 a month", and at
twenty it reads **"you reach it in year 11"**. He was one year short of seeing it.

### Money in buckets, one per rate

**A deposit at 2% and a portfolio at whatever the market does are not the same money.** The old
forecast compounded both at one figure and was therefore wrong about whichever it was not
describing — over ten years, by tens of thousands. Each piece with a stated rate now gets its own
bucket and compounds at its own rate; everything without one follows the scenario yield, and the
passive income each throws off follows its own rate too.

10,000 at 2% for ten years is 12,190. At the 5% middle case it would be 16,289. That gap, on one
line, is the whole argument.

### The goal bar is split by where the money comes from

One green bar said he was 15% of the way to €2,000 a month. It did not say whether that 15% was a
flat he owns or a certificate that matures in 2027 — **and those are not the same progress.**

The bar is now stacked by source, in **fixed slots** (rent, interest, dividend, other) so a colour
follows the entity and never its rank: rent keeps its colour when a dividend appears beside it.
The "already contracted" list below wears the same colours, so the two agree at a glance.

The three hues are the reference categorical palette's first three slots, run through its
validator against this app's own card colour, **all pairs, in both modes**: worst CVD ΔE 9.4
dark / 9.2 light, worst normal-vision ΔE 20.9 dark / 24.0 light. Measured, not eyeballed. Two of
the light steps fall under 3:1 on a light surface, which obliges relief — so **every segment is
also named, with its amount, in a legend below the bar.** Same rule as everywhere else here:
colour never carries identity alone.

**Arrived and still-to-come are on the same bar, told apart by texture.** On the 2nd of the month
no certificate has paid a coupon yet, so a bar of only what landed showed him one flat and nothing
else — which is not the shape of his income. What a holding is contracted to pay and has not paid
yet is drawn in the same hue, hatched and half-opaque: the source stays readable, but money that
has not arrived can never look like money that has. Only the solid part is in the headline figure,
and the legend says the rest in words as well as texture.

**And the app now understands his own words.** He calls the Cairo rent "Apt 1", so the split found
nothing it recognised and painted the largest slice of his goal in the grey reserved for
"something else" — while the app knew perfectly well, two cards below, that the flat pays 27,000
EGP a month. `matchRecorded()` matches a hand-typed flow to the holding it came from, using the
same near-match rule that stops the rent being counted twice, so the two can never disagree about
which flow is which. The slice is coloured as rent; the month's list keeps his name for it.

And the sentence the split makes possible:

> **€38 a month of this comes from holdings that end.** Soon CD stops paying on 1 Nov 2026. Rent
> from something you own keeps arriving; a certificate hands the money back and stops. Reaching
> €2,000 on terms that expire is reaching it until they do.

### Why the ten-year view is one colour, not three

The low / mid / high yields are a **range, not three identities**. Painting them as three series
would say "here are three plans" when the truth is "here is one plan and nobody knows which line
it lands on". So the bar is the middle case in a single hue and the spread is printed beside it
as text, where it cannot be mistaken for precision — with `assumes` attached to every figure.

Over ten years the yield assumption is most of the answer: 3.5% against 7% on the same
contributions differs by tens of thousands. Showing that gap *is* the feature.

## Not done yet

- **Never run against live Telegram or the live rate API.** The sandbox this was built in
  blocks the FX provider, so the fetch path is untested end to end.
- Months are bounded in **UTC** while `TZ` is Europe/Dublin. For the seven months of the year
  Ireland is UTC+1, an entry made between midnight and 1 a.m. on the 1st lands in the previous
  month. Narrow, but real; the escape hatch is that any entry's date is now editable in two taps.
- Recurring flows are listed for confirmation but still never re-stamped automatically, which is
  deliberate — the app must not invent income he has not received.
- Pocket holds the portfolio as a single `portfolio` account entered by hand; it does not yet
  read the steward's book directly, so the two need keeping in step manually.
- Removing or editing an account or flow works in the Mini App, but not from a Telegram message.
- The bot itself still only knows "this month". The month strip is the app's alone.
- The Mini App has never been opened against real Telegram — `initData` verification, the
  Railway domain and the web_app button are all untested end to end.
