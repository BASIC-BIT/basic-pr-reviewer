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

The host must put both ledger and staging on encrypted storage and upload only completed `.sqlite` snapshots to encrypted S3 with a seven-day expiry. Encryption, upload, remote expiry, IAM, and email alarms belong to deployment infrastructure. Application tests verify SQLite consistency, local retention, and permissions; they do not prove physical encryption or remote delivery. Deleted live records may remain in encrypted backups for up to seven additional days, plus the infrastructure's documented expiry processing delay. Keep snapshots out of Git and logs.

For disaster recovery, stop the service and hold its exclusive lock. Preserve the current ledger and WAL together for investigation, then restore a completed online snapshot into an empty state location. Remove no active database files. Start normally: startup purges expired records before accepting work and reconciles GitHub before any publication. Use `inspect` to check results and uncertain receipts. An ordinary code rollback must retain the current ledger; replacing it with an older snapshot would discard newer publication receipts and can duplicate writes.

## Release and synthetic acceptance

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
