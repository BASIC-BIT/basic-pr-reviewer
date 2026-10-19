# Scheduling and recovery

The scheduler runs one pass per tick and releases its lease at that boundary. Due work is ordered by its last completed scheduling turn, then creation time. The last-work value advances monotonically even when the clock is unchanged, so equal timestamps cannot let one review keep its queue position. A large comparison yields between passes. Saved compatible scopes survive restarts, failed integrations and finite recovery.

`createScheduler({ store, source, worker, now, readCurrent, random? })` returns `tick(now)`, `cancelPull(repositoryId, pullNumber, reason)`, `recoverExpiredLeases(now)`, `recoverWorker()` and a read-only `recoveryRequired` flag. Use the same clock for `now()` and `tick(now)`. `random` is the test seam for retry jitter.

Before constructing source services or scheduling, startup must acquire exclusive service ownership and await the worker's initial `reap()`. Source construction removes its owned stale temporary directories. The ledger prevents concurrent leases, but it cannot stop an orphan container belonging to an old supervisor. Host exclusivity and startup cleanup remain required.

## Current identity and credentials

The host supplies `readCurrent(identity, signal)`. It must verify the installation owner and current repository access, read the live pull, and load policy and instruction text from trusted recorded revisions. Default-branch trust and the installation allowlist belong in that host composition. The scheduler checks the returned identity, eligibility, policy/runtime hashes, observation generation, access and worker lease. Unrelated labels do not invalidate work.

Every scheduler source capture and worker execution receives a per-run async guard bound to that exact claim. `captureManifest(identity, trusted, signal, guard?)` checks it before Git credential retrieval and after credential resolution. `runPass(identity, spec, signal, guard?)` checks it before OAuth retrieval, after credential resolution and immediately before inference. Standalone synthetic callers may omit the guard. Production scheduling must supply it. No global mutable current-attempt callback is used.

Bundles and captures are destroyed in `finally`. The scheduler mounts only the verified materialized bundle. A worker cleanup failure blocks admission immediately. The source service retains failed cleanup ownership, including directories that could not be returned by a failed capture or materialization. Its `SourceFailure` has a `cleanup` reason and a fixed safe message. Source and scheduler admission stay blocked until explicit recovery succeeds. When `recoveryRequired` is true, the supervisor must surface that state and call `recoverWorker()` only after the active tick has returned. This method awaits worker reap, then calls `source.recoverCleanup()`. That operation accepts no paths and retries only retained service-owned directories. Any failure leaves admission blocked.

## Limits and outcomes

Passes retain the worker's 100-turn and 60-minute limits. Temporary failures get three retries after 1, 5 and 15 minutes with 10 percent jitter. Execution counts and due times live in SQLite. Exhausted scope passes split by existing unit IDs; completed children are reused and an unsplittable unit remains explicitly incomplete. Integration is replanned from saved findings immediately before it runs.

Automatic recovery lasts at most 48 hours after the first claim. The heartbeat and awaited-stage checks stop active work at that deadline. Four lost leases stop recovery earlier. Authentication, missing credentials and provider access denial require intervention. A new eligible head or explicit rerun uses normal compatible reuse and a fresh integration. Base-only movement cancels old work without starting new inference.

A later source outage keeps saved findings visible. When source and ancestry cannot be revalidated, prior assigned units are explicitly missing and receive no fresh coverage credit. The saved ledger scopes remain available for normal compatible reuse after recovery.

Only validated terminal CLI metadata classifies provider errors. The pinned CLI emits `terminal_reason: api_error` and `api_error_status` on observed 401 and 429 failures, including nonzero exits. Model text cannot set these fields or certify coverage. Independently validated structured findings can survive a turn-limit result; that result remains incomplete. Nonzero exits never complete coverage.

The pinned CLI's JSON envelope did not retain Retry-After or provider reset headers in the local synthetic probe. Such provider timing is unknown, and the scheduler uses its finite retry delays. Authoritative host HTTP reset headers take precedence when available. Source credential 429s and explicitly identified 403 rate limits cross the source boundary as `SourceFailure` with a `rate_limit` reason. Only validated `resetAt` and `retryAfterMs` numbers survive, derived from numeric Unix-reset seconds and Retry-After seconds. Invalid timing stays unknown. Raw errors, messages, credentials and arbitrary headers do not cross that boundary. A concurrent cleanup failure retains the safe timing while blocking admission. CLI-internal retries remain inside the existing 60-minute process limit. The probe's zero-retry overrides are not production settings.

## Ledger and publisher contract

Schema version 3 upgrades version 2 in place without rebuilding or deleting the existing tables. Attempts add due time, recovery start, last-work time, terminal state, intervention reason, result JSON, lease-loss count and progress sequence. `pass_executions` stores the count for each attempted pass. Source bytes, bundles, instruction text and credentials are never persisted.

`savePass(identity, spec, outcome, { token, now })`, `planPublication(intent, { token, now })`, `renewLease(identity, { token, now })`, `startPass(identity, passId, { token, now })` and `settle(identity, { token, now }, settlement)` require the active unexpired lease and current observation. A stale or terminal owner cannot write. Claiming does not reclaim expired work implicitly; call recovery only after startup has made old worker resources safe.

`settlement` contains `{ state, reason, nextAttemptAt, result }`. The state is `queued`, `complete`, `incomplete` or `intervention`. Result is the aggregated `ReviewResult` or null when source was unavailable. A complete settlement requires a complete or skipped result. Skipped scope still has `result.complete: false`; a null result must never render as a clean review.

Settlement atomically saves the result and durable summary/check intents, then releases the lease. Their body is JSON containing the settlement fields. Keys include channel, monotonic progress sequence and body hash. New progress supersedes older pending summary/check intents in the same attempt. `publications(repositoryId, pullNumber)` returns the ordered durable records. Publication transport and formatting must reread current identity, observation and intent state before writing and must treat result status as authoritative even when historical failure codes remain.

These are worker-owned intents. Lifecycle publication for a never-admitted configuration failure, cancellation or outdated comparison needs a separate trusted live-target and observation-generation path without an active worker lease. The publisher implements that path separately. This scheduler does not send GitHub requests or publish inline findings itself.
