# Release, pilot and rollback

Run one central engine build. Pilot a candidate sequentially on one approved repository, then promote the same bytes. Repository policy and selected App access remain local controls; there are no permanent version channels.

## Build identity

From a clean committed checkout, install locked dependencies, typecheck, build and test. Build the pinned Linux amd64 worker and proxy images and run their synthetic acceptance. Generate `release.json` with `npm run release -- <release-root> <manifest-path> sha256:<worker-id> sha256:<proxy-id>` using full image IDs. Verify the manifest against the exact packaged build.

The manifest binds the Git revision, compiled engine modules, schema, lockfile and worker/profile files. The runtime hash additionally binds immutable worker/proxy identities, CLI/model/prompt/configuration and containment profile. A core-only change can invalidate prior coverage. Preserve the generated manifest and built bytes through promotion; do not rebuild after acceptance. Host ownership and artifact delivery establish trust. The manifest checks integrity, not signatures or deployment permission.

## Switch a release

1. Obtain approval for the candidate, selected pilot repository and any live inference/publication. Verify the host prerequisites and release ownership.
2. Send `pause` to the running supervisor. Require the successful `{paused:true,drained:true}` acknowledgement. It arrives only after the active cycle settles. Intake and lifecycle reconciliation can continue while execution is paused.
3. Create an online SQLite checkpoint in the private encrypted staging directory. Probe a disposable copy with the candidate, then prove the previous rollback binary can open the resulting schema. Review storage changes as backward-compatible additions before promotion; a successful open test alone does not establish every semantic compatibility property.
4. Stop the old supervisor, verify worker cleanup, switch the immutable release pointer and start the candidate. Startup must verify its manifest/images, acquire ownership, reap abandoned resources, purge expired records and reconcile GitHub. Check healthy, paused state and current publication receipts.
5. Resume only after the applicable live-operation gate. Pilot the selected repository, inspect real check/summary/inline locations and confirm cleanup/recovery. Pause and drain before expanding selection. Promote the same central build after acceptance.

The pause client waits up to the pass bound plus 15 minutes, currently 75 minutes of inactivity. A timeout or failed pause-state write is not a drained acknowledgement. Repair storage and obtain a successful pause before restarting or switching publishers. Changing `initiallyPaused` never overrides a saved pause state.

## Rollback and restore

Ordinary rollback switches to a proven compatible previous binary and its matching manifest/images, retaining the current ledger. Re-run the drain/checkpoint/compatibility procedure. Never restore an older database over newer publication receipts to make an old binary start. A changed runtime identity invalidates incompatible coverage, and a current integration pass remains required.

Schema 5 adds retention metadata, but earlier binaries can reject it. Those revisions are unavailable rollback targets unless a reviewed compatible build is supplied. The first deployment has no prior service release. A schema-breaking promotion requires a separate reviewed restore/reconciliation procedure before deployment.

If startup fails after a successful durable pause, preserve the ledger/WAL, verify the process and owned workers are stopped, and probe a copy with the proposed rollback binary before a manual pointer repair. Remain paused throughout. Do not bypass unknown publication receipts.

Disaster restore uses a completed online snapshot and a new private encrypted state directory. Preserve current evidence, start without a copied stale pause/control file, and allow startup purge/reconciliation to run while paused. Older snapshots can lack newer receipts. Resolve ambiguous surviving GitHub publications before resuming. Keep restore separate from ordinary code rollback.

See [operations](operations.md) for commands and retention, and [security](security.md) for trust and hosted acceptance requirements.
