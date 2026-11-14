# Kept: reading reliability, 14 November 2026

## Scope

This change connects the reading mentor to selected saved thoughts, open tasks and questions; repairs `/api/word` routing; protects library writes with revisions; and removes the public fallback session-signing secret. It does not change pricing, guest allowances, EPUB storage, notifications, Pocket/Steward features, infrastructure, or production data.

## Data safety

`GET /api/books` now returns `revision` and `exists`. `PUT` requires the revision the client actually read. A successful write increments it atomically; a stale revision returns 409, and an old client without a revision gets 428. Existing documents start at revision zero without a migration. Mentor additions use the same revision guard and bounded retry. MongoDB duplicate-key errors from simultaneous first writes are treated as conflicts.

The client serializes writes, retains pending edits on HTTP/network failure, waits for saves before asking the mentor, and never interprets an intentionally empty server library as an invitation to upload a stale local copy. Conflicts pause syncing. Recovery is explicit: the reader downloads their device copy, a recovery snapshot is retained locally, and only then may the current cloud version replace the on-screen one. This is not automatic merging. Local browser storage is not a durable backup and can be cleared or unavailable.

The old shared-device cache design is unchanged. Account-scoped cache migration and a convenient recovery-file import/merge UI remain separate follow-up work.

## Mentor grounding

The server queries the caller's scoped `books` collection. It selects at most six books, prioritizing matches in the reader's question, and caps the evidence at 16,000 characters. Titles, pages, notes, tasks and questions are carried in a labelled user-message evidence block, never promoted to system instructions. No EPUB files or unrelated personal modules are included. This is bounded lexical retrieval, not exhaustive semantic search. The model is told to acknowledge missing evidence and not to treat a task as proof of a real-life outcome.

## Session preflight

A dedicated `SESSION_SECRET` of at least 32 characters may be configured. Existing strong `ENCRYPTION_KEY` or `TELEGRAM_BOT_TOKEN` values remain compatible when the dedicated secret is absent. No public development fallback remains. Kept refuses to boot without strong signing material. Check configuration before deploying. Changing the chosen secret invalidates existing sessions. This change does not rotate an exposed API key or validate Atlas permissions/network rules.

## Verification and deployment gate

Run `npm ci --ignore-scripts`, `npm test`, syntax checks, and `git diff --check`. The new tests use injected storage/network fakes, plus a real local Node HTTP server for route recognition and asset delivery. They do not contact production MongoDB, Google or a model. They do not replace a real-browser end-to-end test or real MongoDB integration test.

Before merging to main (which auto-deploys): verify the session secret exists without displaying it; back up the database; exercise guest capture, sign-in migration, two-device edits/conflicts, recovery downloads, mentor grounding and a word lookup in an isolated staging environment. Test an old open tab receives 428 and preserves its local copy. Use separate staging credentials/database, not the shared production cluster. After deployment, run `node scripts/smoke.mjs` and confirm `/version` says `reading-reliability-20261114`.

The branch and pull request are for review. No automatic merge or production deployment is authorised by this change itself.
