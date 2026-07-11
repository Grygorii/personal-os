# Scored conversations — the engine

The core of the whole program. We just **talk** — business, psychology, life — and
every conversation is quietly **scored and mined**. Over time the scores show the
climb, and your real writing (not artificial tests) becomes the diagnostic. It *is*
how you talk, so it's the truest test there is.

## Why this beats cold tests

Cold tests show what you can do when you slow down and concentrate. Conversation shows
what you *actually* do at speed — the real gaps: words you're missing, ten words where
one would land harder, grammar that slips while you focus on ideas, thoughts you can't
yet express cleanly. That's the raw material every lesson is built from.

## The five scores (each 1–5, tracked over time)

1. **Clarity** — would an average listener get it the first time, with zero effort?
   *(your north star — see `patterns.md` #breakdowns)*
2. **Grammar & structure**
3. **Vocabulary** — precision and range (the right word; all its senses)
4. **Conciseness** — one sharp sentence, not ten padded ones *(your "10 words for 1")*
5. **Register** — professional, in-command tone

*(Pronunciation joins the scoring when you send a voice note, not text.)*

## What I pull from every message

- **Missing words** — ideas you reached for but couldn't name → added to `words.md`
- **Verbose spots** — "ten words instead of one" → logged with the tighter version
- **Grammar gaps** → marked on the blind-spot ladder
- **Knowledge / idea gaps** (business, psychology) → feed your broader profile / Mind
- **Breakdowns** — where a stranger would lose the meaning → `patterns.md` #breakdowns

## Seeing the improvement

Every conversation logs its date, topic, five scores, and highlights to
`english/scores.json`. We chart the trend so progress is **visible, not a feeling** —
the same way your personal-os System shows stats bending over time.

## "Swiping" past conversations

Once enough of your real writing has piled up, I re-scan the whole corpus to seed
lessons and re-place your level accurately — your own words replace my guesswork. Your
first weeks of just-talking become the dataset for everything after.

## Where this lives

The natural home is a **daily chat surface** — the personal-os Telegram bot — because
this method needs *ambient, everyday* talking, not deliberate study sessions. Claude
Code (the atelier) stays for deep restructuring and building lessons. See the access
plan in the session notes / README.

## Schema (a `scores.json` entry)

```json
{
  "date": "2026-07-12",
  "topic": "his business idea",
  "scores": { "clarity": 3, "grammar": 3, "vocab": 2, "concise": 2, "register": 3 },
  "missing_words": ["leverage", "scalable"],
  "verbose": [{ "said": "the reason why I did it is because", "tight": "because" }],
  "grammar_gaps": ["comma splice", "article before 'business'"],
  "notes": "Strong ideas; padding and vague verbs pull clarity down."
}
```
