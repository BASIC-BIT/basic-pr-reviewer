# Operating the reviewer

This is a private operator service. It accepts signed GitHub App events, captures inert Git objects, runs one disposable subscription CLI worker at a time, and publishes informational reviews. The service never approves or merges a PR.

## Start and configure

Run Node 24.18 or newer within major 24, Linux amd64, UID 1000, Git, util-linux `flock`, and Docker 28 or newer. Install dependencies with `npm ci`, then run `npm run build`. The release directory, worker images, configuration, and state directory belong to the trusted host. PR content must never select these paths or values.

Set `REVIEWER_CONFIG` to a private JSON configuration file. Its default is `/etc/basic-pr-reviewer/config.json`. All paths below are absolute examples. Secret references are names or ARNs, optionally with one JSON field. They contain no secret values.

```json
{
  "stateDirectory": "/var/lib/basic-pr-reviewer",
  "backupDirectory": "/var/lib/basic-pr-reviewer/backups",
  "releaseManifest": "/opt/basic-pr-reviewer/release.json",
  "region": "us-east-1",
  "appId": "123",
  "ownerIds": ["456"],
  "privateKey": {"secretId": "reviewer/app", "jsonKey": "privateKey"},
  "webhookSecret": {"secretId": "reviewer/app", "jsonKey": "webhookSecret"},
  "oauthToken": {"secretId": "shared/subscription", "jsonKey": "oauthToken"},
  "port": 8787,
  "initiallyPaused": true
}
```

The supervisor's AWS SDK uses its normal credential chain and reads `AWSCURRENT`. Give the host role read access only to the configured secrets. OAuth is fetched for each pass. Rotate the App key or webhook secret with a service restart. Missing keys, malformed values, and denied access produce a sanitized configuration failure; temporary OAuth transport failure uses the scheduler's finite retry policy. The worker receives only the subscription credential over its private standard input, never AWS or GitHub credentials.

Start with `reviewer serve`, or `node dist/runtime.js serve`. The launcher acquires a kernel `flock` on `stateDirectory/service.lock`. The child verifies its PID, device, inode, and write-lock ownership through `/proc/locks` before opening the ledger or cleaning resources. Supplying `--locked` without the actual lock fails. A process exit releases the lock automatically. Do not run another service against the same Docker ownership label or state directory.

Startup verifies the release files and actual worker/proxy images, reaps only service-owned abandoned containers/networks, removes owned temporary source/home/CA allocations, expires closed-PR records, and reconciles live GitHub state. Intake and publication start only after those steps succeed. SIGTERM and SIGINT stop intake, abort the active pass, await requests and cleanup, close SQLite, and release ownership on exit.

## Intake and trusted policy

The HTTP listener binds `127.0.0.1`. Put the deployment's HTTPS reverse proxy in front of `POST /webhook`. Requests have a 30 MiB limit and require GitHub's signature, event, and delivery headers. HTTP 202 means admission or a lifecycle receipt is durable. Storage or admission failure returns 503 so the event is not silently lost.

Normal service admission accepts only the repository's current default branch, verified through live repository metadata before reading its policy. Missing metadata fails closed. A default-branch rename takes effect immediately; update the repository policy's `baseBranches` too. Feature and release bases remain unsupported even if their own policy authorizes them.

Reconciliation runs at startup and every 15 minutes. It can recover a known admitted head and update lifecycle/access state. GitHub's current PR snapshot does not prove who triggered an unseen head. That head gets an `actor_provenance_unknown` notice and no inference. Deliver a signed eligible actor event or have a human with write permission use `/claude-review rerun` or rerequest this App's check. Reconciliation never assumes the actor was human or widens allowed bots.

## Local controls

The control server uses `stateDirectory/control.sock`, mode 0600, inside the owner-only state directory. It is not an HTTP route exposed by the reverse proxy. Commands use `REVIEWER_CONFIG` to find it.

```sh
reviewer inspect 789 42
reviewer reconcile
reviewer pause
reviewer resume
reviewer backup /var/lib/basic-pr-reviewer/backups/operator-checkpoint.sqlite
```

`inspect` returns the PR observation, current structured result, notices, and publication receipts. It can contain private findings and belongs in a trusted terminal. `pause` first persists the paused state and stops new inference and publication dispatch. It returns `{ "paused": true, "drained": true }` only after the active cycle has settled. Intake and lifecycle/access reconciliation continue. `resume` persists the enabled state before permitting inference and publication. A failed state write returns an error, keeps execution stopped, and reports `pause_state_failed` until a successful state change. Repair that failure before restarting or switching publishers.

The pause client waits up to the configured worker pass timeout plus 15 minutes for setup, settlement and cleanup, currently 75 minutes of inactivity. Other control commands retain their two-minute inactivity timeout. A client timeout is not a drained acknowledgement; keep the service paused and obtain a successful acknowledgement before switching publishers.

`reconcile` refreshes live state without bypassing actor or policy restrictions. Backup destinations must be unused `.sqlite` filenames directly inside the configured backup directory.

`stateDirectory/pause.json` is a private mode 0600 boolean state file, atomically replaced and synced. Pause survives restart. When this file is absent, `initiallyPaused` defaults to true and initializes it before dependencies or startup reconciliation. Changing the configuration later does not override saved pause state. Use explicit `resume` after the deployment approval gate.

Worker passes are scheduled serially every five seconds. Source or container cleanup failure blocks admission to inference and remains unhealthy until the owned cleanup succeeds. Publication runs after settlement without a worker lease. Lost or uncertain remote responses retain their sending receipts. Never delete a sending receipt to force a retry. Inspection and live App publication reconciliation must resolve the uncertainty.

## Health and alarms

`GET /health` returns aggregate health and HTTP 200 or 503. The service writes `stateDirectory/heartbeat.json` every 30 seconds and after each scheduler cycle. The JSON contains `observedAt`, `healthy`, `database`, `scheduler`, `paused`, `freeBytes`, `workerFailures`, `publicationFailures`, `recoveryRequired`, `lastCycleAt`, and a sanitized `reason`. It contains no source, credentials, raw provider messages, or finding text. Disk free space below 512 MiB stops new work.

The infrastructure must collect this heartbeat, alarm on a missing/stale heartbeat, unhealthy state, cleanup requirement, worker intervention/incomplete results, publication failures, and low disk capacity. Every alarm must have an actionable SNS email action. Creating the file alone does not deliver an alert. HTTP health is for operational status, not a public dashboard.

## Retention, backup and restore

Open PR records remain indefinitely. The live GitHub closure timestamp starts a 30-day retention clock, with observation time as a conservative fallback when the timestamp is absent; reopening before expiry cancels that clock. Daily purge, and an expiry check before live admission or reconciliation, remove the pull, attempts, passes, delivery records, receipts, notices, and publication operations in one transaction. Receipts without a tracked PR, including ignored ordinary comments and unrelated check events, expire 30 days after receipt. Receipts attached to a tracked open PR remain until its closure retention ends. A purge error remains an operational failure. Source and worker allocations are temporary and are removed after every terminal path and during startup recovery.

After expiry, a reopened PR starts with no saved coverage or findings. The publisher can adopt the surviving App-owned summary and recognize identical App findings. It does not turn GitHub thread text into coverage or authority to resolve an old thread. Ambiguous surviving publications require operator action.

Daily backup follows purge, using SQLite's online backup API while WAL is active. Snapshots are mode 0600 under a mode 0700 directory, and the service retains seven daily files. Explicit operator snapshots remain until the operator removes them. A completed snapshot becomes visible through an exclusive filesystem link, so an existing destination is never overwritten. Failed backup cleanup is reported.

The host must put both ledger and staging on encrypted storage and upload only completed `.sqlite` snapshots to encrypted S3 with a seven-day expiry. Encryption, upload, remote expiry, IAM, and email alarms belong to deployment infrastructure. Application tests verify SQLite consistency, local retention, and permissions; they do not prove physical encryption or remote delivery. An upload delayed until almost seven days after snapshot creation can leave its encrypted object for another seven days after upload. Deleted live records can therefore remain in managed backups for almost fourteen days after snapshot creation, plus lifecycle rounding and asynchronous expiry. Explicit operator snapshots remain until manually removed. Keep snapshots out of Git and logs.

For disaster recovery, stop the service and hold its exclusive lock. Preserve the current ledger and WAL together for investigation, then restore a completed online snapshot into an empty state location. Remove no active database files. Start normally: startup purges expired records before accepting work and reconciles GitHub before any publication. Use `inspect` to check results and uncertain receipts. An ordinary code rollback must retain the current ledger; replacing it with an older snapshot would discard newer publication receipts and can duplicate writes.

## Release and synthetic acceptance

### Single-publisher handoff

Use the target repository's policy, required checks and recorded legacy workflow
inventory with this sequence. Source preparation does not authorize default-branch
changes, infrastructure, credential access, inference or publication. Obtain the
applicable approvals for the exact target and establish trusted default policy
through the approved baseline procedure while legacy remains the sole publisher.

1. Verify read access and exact repository, installation, head/base, policy and
   release identities. For a finite shadow, follow the ownership and admission
   procedure below: persist pause, obtain a successful drain, stop the normal
   service and hold its production lock. Let any approved legacy run finish before
   shadow inference so only one inference owner is active. Shadow uses the same
   production ledger, has no publisher or publication acknowledgements, and cannot
   prove COMMENT, inline, sticky, check or thread-resolution permissions.
2. Inspect saved coverage and pending publication intents. Keep execution and
   publication durably paused. Before target writes, obtain the approved legacy
   shutdown: disable the recorded workflows, cancel queued/in-flight legacy jobs
   and verify terminal status. Workflow deletion in a branch is not shutdown proof.
3. Only after that terminal proof and explicit target publication/cutover approval,
   continue the finite publication pilot below or resume the normal service under
   its sole ownership lock. Refresh admission when head, base, policy or release
   changed. Prove target COMMENT, inline, sticky and exact-head check publication
   and actual thread permissions, including the limits on resolving App-owned
   verified-fixed findings without human replies. Record remote receipts and
   confirm one inference owner and publisher. An earlier separately approved
   fixture can prove only its own permissions; it is not target cutover proof.
4. On the approved disposable acceptance PR, verify push, labels, skip/unskip,
   draft/ready, retarget, close/reopen, base invalidation, authorized rerun,
   publication failure and revocation. Retain repository-specific current-head
   review gates and required checks. Missing live evidence remains UNKNOWN.

Shadow leaves pending intents in the production ledger. Never use an alternate
ledger, erase receipts or resume implicitly to clear them. Keep pause until their
publication is approved or abandon the pilot through the normal authorized
skip/close and paused reconciliation procedure below. Cancellation itself does
not authorize notices or other queued publication.

Rollback pauses and drains App execution/publication, stops its in-flight work,
then restores the recorded prior workflows and proves only the legacy owner is
active. Preserve the ledger and handle queued intents explicitly before any later
App resume. Engine rollback alone does not restore retired workflows.

### Finite GitHub pilot

Live pilot execution needs separate human approval of the target, credential access, input scope, inference budget and publication. CLI flags record operator intent; they do not grant that approval. The two existing synthetic commands below remain offline.

Use the deployed Linux UID1000 host and its fixed `/etc/basic-pr-reviewer/config.json` and `/var/lib/basic-pr-reviewer` paths. The pilot rejects alternate state/configuration paths because Docker worker ownership is host-wide. First obtain a successful `reviewer pause` response with both `paused` and `drained` true, then stop `basic-pr-reviewer.service`. Keep Docker, metadata protection and the production source/worker mounts running. A timeout or failed pause write is not a successful drain.

The selected head must already be durably admitted by the normal service from a real signed eligible event or authorized human rerun. While paused, use `reviewer inspect REPOSITORY_ID PR` to obtain its exact identity. An unseen head cannot be admitted by this runner. Refresh policy/current identity through normal paused service operation if needed, then drain and stop again. Other queued or leased pulls cause refusal, including work scheduled for later. Resolve that queue through normal authorized controls, never delete ledger rows to make the pilot run.

Prepare a private JSON request with `identity` copied from the current admitted record, `coreRevision` and `coreHash` from the verified deployed release, and explicit positive `maxTicks` and `maxElapsedMs`. The identity includes installation/repository IDs, owner/repo, PR number, head/base/merge-base SHAs, base ref, policy/runtime hashes, attempt ID and generation. No field selects policy or an actor. The runner reads the normal live default policy and rejects any identity mismatch.

```sh
node scripts/acceptance.ts --github-pilot /private/pilot-request.json /private/shadow-report.json --allow-credentials --allow-inference --shadow --drained
# Only after separate publication/cutover approval:
node scripts/acceptance.ts --github-pilot /private/pilot-request.json /private/publication-report.json --allow-credentials --allow-inference --allow-publication --drained
```

Each report path must be unused and on private encrypted storage. The runner reserves it before dependencies or credential reads. It takes the production `service.lock`, verifies real kernel ownership and stopped service, checks durable pause and the exact queued target, and opens no listener or reconciliation loop. Do not pass internal `--locked`; that flag cannot bypass kernel ownership. The compiled `dist/pilot.js` module is included in normal release hashing.

Shadow mode uses the production ledger and constructs no publisher. It saves coverage, findings and pending publication intents for continuation. Its report says `shadow` and contains no publication acknowledgements. These saved intents can publish after a later normal resume. Keep execution paused until explicit publication/cutover approval or cancellation. To abandon a pilot, keep the service paused, apply an approved normal skip label or close the disposable PR, start the service paused and reconcile, then inspect the cancelled/superseded attempt and notices. Neither cancellation nor a restart authorizes publishing notices or other queued work. No ledger editing is required.

At most one pass runs per tick, with the existing 100-turn/60-minute per-pass ceiling. `maxTicks` must be 1 through 1000 and the elapsed limit at most 24 hours. Choose much smaller values for the approved measurement. The deadline aborts active inference and prevents new work/publication boundaries; already-issued requests and cleanup can finish after it. This is not a hard process-kill timer. Provider reset/backoff stops the invocation at its next eligible time instead of sleeping or bypassing quota. Continue with a new explicitly bounded invocation of the same identity. A changed head, base, policy or release requires fresh admission/identity and approval scope review. Completed compatible scope can be reused; failed or incompatible scope cannot certify completion.

The report records exact identity, bounds, elapsed time, executed passes, coverage counts, saved pass outcomes, token estimates, publication receipt IDs and pending intents. Finding/source text, paths and raw diagnostics are omitted. Turns, remaining subscription quota and worker peak memory are `UNKNOWN`; supervisor peak RSS is process-wide and is not worker memory. A refused command exits nonzero with sanitized unknown outcome. An orderly deadline or interruption exits nonzero with saved progress when available. Inspect private ledger/host state before retrying. A report write or cleanup failure is also failure. Nothing resumes the normal service. Hard kill or host failure may leave owned allocations for normal locked startup recovery.

The synthetic runner tests cover finite progress, refusal, shadow/publication separation and invented 66-file exhaustion/continuation. Existing source, worker and lifecycle suites cover containment and cleanup. They do not prove live App permissions, subscription capacity, host isolation, alarm delivery or a deployment.

`pendingIntents` counts current planned ledger intents. The ledger retains these for reconciliation even after individual operations are acknowledged; use publication outcomes and operation receipts to determine remote completion. The service dispatches new progress and pending or uncertain publication work each cycle. Successfully reconciled, unchanged intents and notices are checked again after 15 minutes. Any uncertain write bypasses that delay. This in-memory cadence resets on restart; durable operation receipts still prevent duplicate writes.

From a clean committed checkout after `npm ci` and `npm run build`, generate a manifest using the immutable image IDs:

```sh
npm run release -- /opt/basic-pr-reviewer /opt/basic-pr-reviewer/release.json sha256:WORKER_ID sha256:PROXY_ID
```

Use full 64-hex image IDs. The manifest binds the actual Git revision, every compiled engine module including source rendering, schema, dependency lockfile, and worker profile files. Startup verifies those bytes. The worker composes that core identity with both immutable images, CLI/model/settings/prompt identity, and containment profile. Admission, source hashing, reuse, and `runPass` use the same composed runtime hash. A core-only release change invalidates old coverage.

The manifest is a trusted deployment artifact, not a signature or permission grant. Distribute it with its verified immutable release. Pilot changes before promotion. Rolling back executable files requires the corresponding manifest and images, while retaining current compatible ledger data. Schema 5 adds retention/receipt metadata and reads the older schema 2, 3, and 4 ledgers through additive migrations; an older binary that rejects schema 5 cannot be used as a rollback without a reviewed compatibility build.

```sh
npm ci
npm run typecheck
npm run build
npm test
node scripts/acceptance.ts --fake-container
node scripts/acceptance.ts --worker-profile sha256:WORKER_ID sha256:PROXY_ID
```

The fake-container mode runs the composed local service with fake GitHub/provider boundaries and real HTTP, SQLite, Git objects, and subprocess transport tests. The image mode uses the actual pinned CLI against synthetic container services and checks containment and cleanup. Linux CI also enables `REVIEWER_HOST_GIT_TEST=1`, exercising the actual Git credential helper without a remote fetch. It verifies real competing-process `flock` behavior.

These tests do not authorize or prove live App grants, subscription startup, real publication locations, hosted quota reset timing, infrastructure encryption, or alarms. The pinned CLI reports quota status but no authoritative reset time. Preserve that timing as unknown and keep the approved hosted pilot as a separate acceptance step.
