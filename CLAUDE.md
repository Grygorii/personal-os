# personal-os / Kept — pick-up map

Read this first in a new session. It is the state of the project, not a wish list. Every
number was read from the live database and the live site; where something has never been
used, it says so.

**Motto (his words, he stands behind it):** *For people who use what they read — not just
finish it.* Kept — your reading companion.

- **Live:** https://readkept.com (`www` 301s to the apex). Build marker: `GET /version`.
- **Deploy:** push to `main` → Railway builds automatically. No manual step.
- **DB:** MongoDB Atlas **M0, 512 MB**, database `personal_os`. **Shared cluster with
  SILKILINEN**, his live Stripe store — a bad query here touches his shop.
- **Repo:** github.com/Grygorii/personal-os, **private**. 140 commits, 14 Jun → 16 Aug 2026.
- `README.md` is **stale** — it describes the Telegram-bot era. This file is the truth.

## The one honest paragraph

The product works. Almost nobody uses it. Roughly **1,350 landing visits and 400 app opens**
across the 17 days counted produced **5 accounts**, and 3 of those are him, his wife
(`sabreen`), and a test record. **Zero exams have ever been taken** — the "get tested
honestly when you finish a book" promise, the actual differentiator, has never once run for
a real person, including him: he finished *Zero to One* (p195/195, 44 thoughts) and did not
take the exam. **Zero push subscriptions exist** — the notification system was built,
shipped, and nobody has ever turned it on, him included. 6 share links have drawn 25 views.

Do not plan new features against this without saying it out loud. The bottleneck is not
capability.

## What a person actually does here

1. Lands on `/` → **Try it free** → `/app` (works as a guest, no account).
2. Adds a book, reads, saves **thoughts tagged to a page** — typed, or photographed and
   transcribed (`/api/readpage`), or tidied (`/api/tidy`).
3. Finds any thought again later (client-side search in `journal.html`).
4. Finishes the book → takes an **exam** the model generates and grades (`/api/bookexam`).
5. Optionally shares a thought or a result (`/api/share` → public `/r/<code>` page).
6. Talks to the **mentor** (`/api/chat`), which sees only the modules they have.

## Layout

```
src/
  webserver.js  2040  every HTTP route, the admin page, all /api/*. The big one.
  coach.js       801  the mentor: prompt, JSON action parsing, applyAction()
  system.js      659  XP, levels, quests, streaks (his own module)
  router.js      593  Telegram message routing
  users.js       520  accounts, can()/isAllowed(), trust ladder, quotas, BYOK, GDPR
  push.js        198  web-push: VAPID, subscribe, sendTo, daily/quiz/idle nudges
  telegram.js    261  Bot API client + long poll
  contact.js     143  the contact threads behind the hamburger
  llm.js         140  Anthropic/Gemini call, model choice, token ceilings
  db.js          134  connect, col() [user-scoped], rawCol() [unscoped]
  auth.js        128  sessions, Google token verify, cookie
  runtime.js     119  node-cron; the agent registry
  ctx.js          89  AsyncLocalStorage user context, languageRule(), LANGUAGES, safeName()
  index.js        82  boot; VERSION lives here — bump it every deploy
  text.js         48  reflow()/looksWrapped() — printed line breaks are the paper's, not the sentence's
  agents/           english, bookCoach, water, reading, routine, body
reading/journal.html   2335  THE APP. Search, crop, sheets, mentor chat, notifications, language.
webapp/                landing.html (947), signin, dashboard, home, privacy, icons
english/               his C2 study system (run via the /english skill)
body/ routines/        his private modules
scripts/smoke.mjs 204  62 assertions against the LIVE site. Run after every deploy.
test/logic.test.js     19 pure-function tests. No DB, no network.
```

## Data model (collections in `personal_os`)

| collection | holds |
|---|---|
| `users` | one doc per person. `_id` is a Telegram id, or `g:<google-sub>` |
| `books` | **one doc per user**, `books[]` array; **thoughts live at `books[].notes[]`** |
| `conversation` | mentor memory (1,210 docs — the biggest thing here) |
| `logs` | typed life events: water, sleep, mood, book, note… (his modules) |
| `shares` | public share codes and view counts |
| `contacts` | contact threads, keyed by hashed IP for guests |
| `meta` | `boot` (version), `visits:<YYYY-MM-DD>` (five buckets), book-rec caches |
| `reading` | **legacy**. The mentor used to write here while the app read `books` — two stores that never met. Do not add to it. |
| `invites` `personal` `profile` `snapshots` `english` `portraits` `pursuits` `agents` `system` | modules and his own data |

## Invariants — the bugs that keep coming back

These are not style preferences. Each one reached a real person.

1. **Multi-tenant lens.** `col()` auto-scopes to the current user and *throws* with no user;
   `rawCol()` is unscoped and must be justified. A member without `product` falls through to
   the *owner's* prompt — his job, his shop, his life. Read every new query as a stranger.
2. **Fail closed.** `uid` throws rather than returning a default. A missing session must
   never resolve to the owner.
3. **Anything a user controls can rewrite the prompt.** Display names did it once
   (`safeName()`), and the language setting nearly did it again — a regex allowing letters and
   spaces also allows `"Ignore previous instructions and"`. **Use the closed list
   (`isLanguage`), never a pattern**, for anything interpolated into a system prompt.
4. **Capabilities, not roles.** Gate with `can(user, 'english')`. Never scatter
   `role === 'owner'`. The subscription shape already exists; switching it on is a decision,
   not a rewrite.
5. **`needs:` in `ROUTES` is access control.** `public: true` once meant only "substitute
   APP_URL here" and read like a permission flag — `/hub`, `/body`, `/deck`, `/dashboard`
   were served to anyone.
6. **`hidden` loses to any author `display` rule.** Every class with a `display` needs
   `.cls[hidden]{display:none}`. The smoke test checks this.
7. **CSS at equal specificity is decided by source order.** Mobile rules beat desktop ones
   this way. Use non-overlapping media queries so order stops mattering.
8. **Never guess a size — measure it.** `100vw` includes the scrollbar; percentage heights
   resolve against the parent's *height*. `fitStack()` measures in JS.
9. **Two ceilings drift apart.** A `maxTokens` and a length guard set months apart silently
   destroyed text past 2,000 chars. Guard against *shrinkage*, not just overflow, and always
   log `stop_reason`.
10. **Never route regexes or escapes through a Python/Bash heredoc.** `\b` became a literal
    backspace and `\\n` became real newlines — four separate times. Use the Edit tool.

## Ship loop

```bash
npm test && node --check src/webserver.js
```

Then bump `VERSION` in [src/index.js](src/index.js), commit, `git push origin main`, poll
`https://readkept.com/version` until the new marker appears, and finish with:

```bash
node scripts/smoke.mjs
```

`smoke.mjs` exists because four bugs in a row were invisible to unit tests — an unsubstituted
placeholder, a `ReferenceError` that killed the whole app script, a CSS rule that showed "Not
signed in" to a signed-in owner, and a route serving a raw template. It also **asks Google
directly whether the OAuth redirect URI is accepted**, because switching to `ux_mode:'redirect'`
without registering the URI locked ~111 people out for two days while the page looked perfect.

Env vars in use: `MONGO_URI DB_NAME ANTHROPIC_API_KEY CLAUDE_MODEL DEEP_MODEL LLM_PROVIDER
GEMINI_API_KEY GEMINI_MODEL GOOGLE_CLIENT_ID OWNER_EMAIL ALLOWED_EMAILS APP_URL PORT TZ
ENCRYPTION_KEY VAPID_PUBLIC VAPID_PRIVATE TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID BOT_USERNAME
MULTI_TENANT INVITE_ONLY AUTO_ACCEPT`.

## How it got here

- **Jun 14 – Jul:** a Telegram coach bot. Agents, XP/quests, English, body, routines.
- **Late Jul:** built for more than one person — `users.js`, encrypted BYOK keys, trust
  ladder, moderation, GDPR export/delete. Nothing sold; the plumbing came first on purpose.
- **Aug 1–2:** it became a website. Landing page, PWA install, sessions, Google sign-in,
  `/app` as the real product.
- **Aug 2–4:** the outage. Sign-in was dead for two days; the funnel got blamed. `smoke.mjs`
  was born from it.
- **Aug 3:** modules — the mentor only knows what a person's modules cover.
- **Aug 6–8:** the repositioning. A friend said he couldn't tell what the site was *for*.
  Result: the motto, the landing rebuilt as one pipeline, gold replaced by cream/white/black
  with **yellow only where a highlighter would go**, per-thought sharing, and the acquisition
  pipeline mirrored in the admin so he can see where it breaks.
- **Aug 15:** Telegram parity — everything in the app, no Telegram needed. Mentor stopped
  reading its own JSON braces aloud. Notifications, drawn icons, notifications page.
- **Aug 16:** visit counting stopped filing his own deploy checks as visitors; room around
  the crop; bring-your-own-key in the app; **language you choose once and the mentor keeps**.

## Open

**His, and only his — do not do these for him:**
- Rotate the exposed Anthropic API key.
- Atlas DB user still has more privilege than it needs.
- Mongo Network Access is still `0.0.0.0/0`.

**Deferred with his agreement:** photos saved as thoughts and photos to the mentor (needs an
image-storage decision plus moderation); payments (his trigger: 10 people finishing a second
book); multi-language UI copy (the *mentor* speaks 9 languages; the interface is English).

**Flagged, untouched, separate work:** SILKILINEN's Stripe has shown eight consecutive
"Incomplete" payments since 20 July.

## How he wants to be worked with

Standing orders, and he means them:

- **Radical honesty over flattery.** Verify before asserting. Let the score fall.
- **Minimize his decisions.** Decide anything non-critical yourself and give him **one clear
  next action**. Ask only on genuinely personal or critical forks.
- **Five whys, and play the move both ways** before writing code — on every task.
- **Value first**, and name the person and the moment it lands.
- He is a solo builder with a day job, relatively new to git and devops. Explain the *why*,
  never just the command.
- Commit messages here are a sentence about what changed for a person, not a changelog line.
