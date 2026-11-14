# Reliability verification, 14 November 2026

## Executed checks

The GitHub preparation run (43631508100, attempt 2) applied the integration changes only to `fix/kept-reading-reliability-20261114`. All 232 then-present tests passed, including 22 new tests. Recursive JavaScript syntax checks and `git diff --check` also passed. No production MongoDB connection or model/API credentials were used. The first attempt failed because the new inline-script parser treated a literal script tag in an HTML documentation comment as executable code; the test now excludes HTML comments. The application was not deployed during either run.

A final review added two more regression cases: editing while a cloud recovery fetch is in flight, including when that request fails. These preserve the new edit instead of restoring an older snapshot. The complete final suite is checked again by the pull-request workflow.

Chromium DOM interaction checks at a 390 x 844 viewport passed for:
- A guest adding a book and saving a thought without an unauthenticated library PUT.
- A signed-in reader saving a thought before submitting a mentor message; the simulated cloud has the thought before the chat request.
- A stale revision showing a conflict notice, retaining the unsent second thought locally, and not replacing the simulated cloud copy.

Those browser checks used the actual journal markup/scripts, with explicitly mocked API responses and browser storage. Network navigation was blocked by the execution environment, so the markup was rendered locally. These are UI interaction checks, not real authentication, persistence, MongoDB, or model tests. No claims about live browser sign-in or deployed AI reply quality follow from them.

## Still required before production

Use an isolated staging database and credentials to test real sign-in, database compare-and-swap races, cross-device edits, guest migration, recovery-file download, persisted state after browser reload, word lookup with the provider, and mentor responses grounded in saved notes. Confirm strong session-signing material is configured and take a database backup before merging to the auto-deploying main branch. The draft pull request is intentionally not merged.

The temporary preparation workflow and script were removed from the final branch tree. The ordinary repository PR test workflow remains unchanged.
