# Nine waves

A plan for Kept, written 17 Aug 2026, to be executed in order. Each wave has **one outcome**
and **one number that says whether it worked**. Read `CLAUDE.md` first for the state of things.

## The premise, stated once

The product works. Nobody uses it. **~1,350 landing visits and 400 app opens produced 5
accounts**, and three of those are him, his wife and a test record. Until today no exam had
ever been completed by anyone. Zero push subscriptions exist.

So the waves are ordered by that reality, not by what is fun to build. **Capability is not the
bottleneck.** Waves 1–3 are about whether a stranger ever reaches value; only then is it worth
deepening what happens after.

**His standing decisions, which shape everything below:**
- **Open doors.** Anyone may use it. The pipeline gives value first and asks them to connect at
  a moment when connecting obviously pays them back — never at the door.
- **Subscription is built and hidden.** The plumbing exists (`can()`, `subscription`, tiers).
  It stays dark until **1,000 users**. Nothing in these waves puts a price on screen.

---

## Wave 1 — See where they fall

**Why first:** 400 app opens happened and we cannot say what any of those people did. Every
wave after this is guesswork until we can. Today's funnel counts *page views*, not *progress*.

**Build:** an anonymous step event per meaningful beat — opened the app, added a book, saved a
first thought, hit a sign-in wall, signed in, took an exam. No cookie, no identifier beyond the
existing hashed-per-day bucket; the privacy page's promise holds. Surface it in `/admin` as a
funnel with drop-off between each step.

**Done when:** he can look at one screen and say which step loses the most people.

## Wave 2 — A guest reaches real value before being asked for anything

**Why:** the wall is currently at the mentor, the exam and sharing. A guest can save thoughts
but the pipeline stops before the payoff, and the ask arrives as a refusal.

**Build:** audit every `guestBlocked` call. Move the wall to the first point where an account
genuinely buys something (persistence across devices, a page that lives on a server). Rewrite
each ask to name what they *get*, not what they cannot do. A guest who has written three
thoughts should be offered an account as a way to keep them, at that moment.

**Done when:** the median guest saves a first thought without meeting a wall, and the
sign-in prompt appears after value, not before.

## Wave 3 — The empty shelf

**Why:** "added a book" is the metric that has never moved. Every reader who stopped, stopped
here — an empty library with a form in it.

**Build:** make the first book take one tap, not a form. Ask the one question that matters —
*what are you reading right now?* — the moment the app opens with an empty shelf. Search is
already there; the friction is being asked to fill fields.

**Done when:** the share of new arrivals who add a book at least doubles from its current
near-zero.

## Wave 4 — The exam becomes the reason people talk about it

**Why:** it is the only genuinely novel thing here — Goodreads owns "what I read", nobody owns
"did I keep it". It ran for the first time today, after a bug ate five answers.

**Build:** finishing a book should lead into the exam instead of waiting to be found. The
result page should be worth sending to somebody. The structured grade (understood / used /
challenged) is the shareable object — a number nobody can fake.

**Done when:** ten exams have been completed by people who are not him.

## Wave 5 — A reason to come back tomorrow

**Why:** notifications were built, shipped and have **zero subscribers, including him**. That is
a feature that failed, and it should be treated as one rather than left sitting there.

**Build:** find out why nobody turns them on — ask, or watch the funnel from Wave 1. Then either
make the first one arrive at a moment that earns the permission prompt, or remove the feature
and stop paying for it in code. Do not add a second notification type before the first has one
subscriber.

**Done when:** either ten people have them on, or the code is gone.

## Wave 6 — The shared page is the front door

**Why:** 6 shares have drawn 25 views and no sign-ups. Shared pages are the only organic reach
this product has, and `/c/<code>` is brand new and untested in the wild.

**Build:** treat `/r/` and `/c/` as landing pages, because for a stranger that is what they are.
One clear thing to do, the book already on the shelf when they arrive (already built), and the
reply box on `/c/` as the lowest-friction first act anyone can perform here.

**Done when:** one person arrives from a shared link and saves a thought.

## Wave 7 — The mentor earns its tab

**Why:** it can now see the exam, and still cannot see tasks or questions — so nothing ever
nudges an open task, and the Do tab has no voice.

**Build:** give the mentor the open tasks and unanswered questions. One nudge, at most, when a
task has gone quiet. Let it turn a conversation into a task directly.

**Done when:** a task gets completed that the mentor raised.

## Wave 8 — Fast on a mid-range Android

**Why:** almost everyone opens this on a phone, and `journal.html` is a single 2,700-line file
sent whole on every load. Nobody has ever measured it on a slow connection.

**Build:** measure first — real load time on throttled 3G on a mid-range device. Then act on
what the measurement says, not on instinct. Splitting the file is a guess; the measurement is
not.

**Done when:** first thought savable within three seconds of tapping the link on throttled 3G.

## Wave 9 — The money shape, built and dark

**Why:** his trigger is **1,000 users**, and the plumbing already exists. Building it late is
how a launch slips; showing it early is how trust goes.

**Build:** switch the subscription path on behind a flag with nothing visible. Stripe (his
account exists, KYC done), Checkout plus Customer Portal, EU VAT decided with an accountant.
Test it end to end with his own card, then turn it off.

**Done when:** a payment can be taken in under an hour's notice, and not one user can tell it
exists.

---

## How to run these

One wave at a time, in order. A wave is finished when its number moves, not when its code
ships — and if the number does not move, the next wave is not the answer; understanding why is.

Waves 1–3 are the ones that decide whether this product has a future. Waves 4–7 are worth doing
only once strangers are arriving. Waves 8–9 are readiness, not growth.
