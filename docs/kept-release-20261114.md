# Kept release verification — 14 November 2026

Build marker: `reading-reliability-20261114`. This record supersedes the earlier draft's verification limits where explicitly stated. Release outcome and the final commit are recorded in PR #1.

## Verified before release

Preparation run **43638005469** passed the full unit suite, syntax/diff checks, and a real MongoDB 8 + Chromium integration exercise. The integration artifact reports success for API authentication, valid/tampered synthetic Telegram login, concurrent revision-checked writes, cross-account rejection, database persistence, guest capture across browser reload, guest-to-account migration through the real API, conflict downloads and pending-draft reload, and switching accounts without transferring drafts.

Railway check deployment **efffc5fe-88a0-4884-82d6-43f4816b7916** ran the same candidate code at commit `87c731bf8b6357e23447a5825dff33335cd995eb` against a separate temporary MongoDB, not the production Atlas database. Its report passed real-provider word lookup, mentor recall of a synthetic saved phrase with the correct page, a Google authorization-configuration probe, and the existing signing-key strength check.

The Gemini provider returned HTTP 402 because its prepayment credits were depleted. The existing Anthropic fallback completed both AI checks successfully. No billing settings or provider preferences were changed.

A human Google account consent/login ceremony was NOT completed by the tests. Telegram validation used signed synthetic test identities. Browser tests use real storage, HTTP and MongoDB but do not call an AI model; the separate Railway checks exercise the model. These are explicit boundaries, not claims of complete coverage.

## Additional shared-browser protection

Caches are now account-labelled. Requests bind to the page's account, and the server refuses an old tab whose session belongs to another account. Guest drafts may be claimed only once. Old unlabelled `reading-journal-v1` copies remain available through **Download older device copies**, but are never silently attached to an account. Existing signed-in cloud libraries are loaded normally. There is no automatic merge/import UI for legacy exports.

The temporary preparation workflow and source-rewriting script have been removed from the final tree. `.github/workflows/kept-staging.yml` is a lasting, read-only CI job using disposable MongoDB and Chromium; it does not access production secrets or deploy an application.

## Backup and rollback

Before production release, an encrypted logical backup is created in the private `kept-release-backups` Railway bucket and checked by read-back, AES-GCM authentication/decryption, decompression and Extended JSON parsing. The one-shot backup function reads only `personal_os`; it performs no source writes. This is a live logical copy, NOT a transactionally consistent point-in-time snapshot.

Backup envelope `kept-aes256gcm-gzip-ejson-v1` contains base64 IV, tag and ciphertext plus the plaintext SHA-256. The 32-byte AES key is SHA-256 of the UTF-8 concatenation `kept-release-backup-v1:` + the existing production `ENCRYPTION_KEY`. Keep that key recoverable if it is rotated. The decrypted gzip contains canonical EJSON with per-collection documents and index definitions. Never commit backup contents or keys to GitHub.

The previous production deployment is `6ab1f383-83f4-4e10-b407-61600086722f`, main commit `12825f3bcd1c6bea393f55a3b352d6ae80cf272d`. Roll back the application build first if health fails; do not overwrite newer reader data with a backup without a separate review. Old clients without revisions receive HTTP 428 and need a reload; their device copy must be retained.

No subscription, notification schedule, EPUB upload/storage or Pocket/Steward feature change is part of this release. Previously exposed provider credentials and Atlas privilege/network settings still require a separate security review.
