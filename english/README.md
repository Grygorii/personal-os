# English → C2 — a living study system

This is not an app you use alone. It's the **memory** for a teacher (Claude) who
teaches you across sessions. You forget; these files don't. Claude reads them,
runs a class, and writes back what changed. That's the whole trick.

**Goal:** pass Cambridge C2 Proficiency. **Owner:** Гріша. **Teacher:** Claude (in Claude Code).

## How a class works

Run `/english` in Claude Code. Every class does the same loop — the one that worked:

1. **Cold check.** I test what's *due* today (things you got wrong before, plus
   spaced spot-checks of things you'd mastered). You answer from your head — no
   scrolling back. That's the point: it shows real gaps, not speed slips.
2. **Grade honestly.** Right → it waits longer before asking again. Wrong → it
   comes back next class, and I re-teach it on the spot.
3. **Teach something new.** One or two new pieces from the roadmap, aimed at your
   next real gap — not random.
4. **Blend.** New material mixes with old-you-shakey and old-you-solid.
5. **Write it down.** The rule goes in `rules/`, the word in `words.md`, and your
   memory (`progress.json`) updates so next class knows where you are.

You get **results, not cheerleading** — that's how you asked to be taught.

## What's in here

| File / folder     | What it is                                                          |
| ----------------- | ------------------------------------------------------------------- |
| `progress.json`   | The brain. Who-knows-what, when each item is next due, your level.  |
| `rules/`          | Clear rule lessons, one per file. Re-read any time, on any device.  |
| `words.md`        | Word bank with **full** meanings — every sense, not just one.       |
| `patterns.md`     | Your recurring mistakes and the fix for each.                       |
| `sessions/`       | A short log of every class, so progress is visible over weeks.      |
| `study.html`      | The deck you tap on your phone (published as an Artifact). See below.|

## The study deck (your phone surface)

`study.html` is published as a Claude Artifact — bookmark it. Three tabs:

- **Meaning** — a word appears; think what it means; tap **Reveal**; then rate
  yourself 🟢 *knew it* / 🟡 *roughly* / 🔴 *new to me*. The reds are your next study
  list. This is also how I find words you didn't know you were missing.
- **Spelling** — you get a meaning, you type the word; it checks you instantly.
- **Grammar** — the rules as calm tables to read.

Your ratings save on your phone. Tap **Copy results for Claude**, paste it into a
class, and I fold it into `progress.json` and refresh the deck (same link).

## The rules of *this* system (so it stays alive and cheap)

- **One file = one clear thing.** Easy to read on your phone via GitHub.
- **I load only what's due**, not the whole corpus — that keeps each class fast
  and cheap on tokens.
- **Cold testing is the default.** You asked for it; it's non-negotiable.
- **Everything you get wrong becomes a tracked item** with a review schedule.
- **Meanings are complete.** When a word has several senses, all of them go in —
  that's the gap you flagged (adding one meaning and missing the rest).

## How we climb: the blind-spot ladder

We don't chase a distant certificate. We start at the bottom and **sweep every level
(A1 → C2) for blind spots** — the silent gaps immersion left behind — and fix them.
The full map is [`blind-spots.md`](blind-spots.md); the Cambridge exams that confirm
each rung are in [`cambridge-path.md`](cambridge-path.md).

At **every rung** we work four aspects:
1. **Grammar & structure** · 2. **Vocabulary & word-understanding** ·
3. **Pronunciation** (stress, silent letters, homophones) ·
4. **Register — sounding professional** (I also correct your phrasing in real time).

These aren't just language points — they're **signals of level**. The goal isn't a
certificate on a shelf; it's to read as someone in command, so companies come to you.

The Cambridge exams (B2 First → C1 Advanced → C2 Proficiency) are **checkpoints we
earn** by clearing rungs — real certificates for LinkedIn along the way, not a far-off
goal. Certificates never expire.
