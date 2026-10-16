# Security boundary

This service reviews untrusted pull requests using a trusted supervisor and disposable model workers. Repository content, model output and remote responses remain untrusted. The service does not execute PR code, hooks, project installation scripts or PR-controlled tools/configuration.

## Authority and credentials

The GitHub App, selected installations, immutable owner/repository identities and repository policy determine admission. Default-branch trusted instructions are captured at recorded revisions. PR instructions and filenames cannot select runtime paths, credentials, executable tools or publication targets. Missing authority produces an explicit incomplete/configuration outcome.

The trusted host holds the App signing key and installation publication credentials, loads selected AWS secrets in memory and controls Docker. Its release/configuration/state files must be writable only by trusted operators or the supervisor as appropriate. The supervisor's Docker access is a host-administration privilege; the model worker never receives it.

Workers receive only the subscription credential needed for inference, through private stdin, plus a read-only inert source bundle and public proxy CA. The proxy is inside the credential trust boundary. Its ephemeral private CA stays in its tmpfs. It permits only the pinned inference endpoints and disables request/header/body logging. No host, AWS or GitHub credential is forwarded. Worker output is bounded and independently validated before coverage or GitHub publication.

## Containment and recovery

Run Linux amd64 with supervisor and worker UID1000 so private source directories and files remain readable without broader permissions. Keep state and backup staging private on encrypted storage. Mount a hard-bounded temporary filesystem directly at `stateDirectory/source`; the source collector's sampled disk safeguard alone is not a hard allocation cap. Size that filesystem alongside the worker/proxy memory limits. Do not add source or worker directories to backups.

Workers have a read-only filesystem, limited CPU/memory/processes, no elevated capabilities, no Docker socket and an internal network. The standard TLS-inspecting proxy supplies the bounded egress path. The host must require IMDSv2, block container access to metadata and expose only the authenticated webhook through HTTPS. These controls require actual host acceptance in addition to the synthetic container tests.

Startup holds exclusive service ownership, verifies release files and image identity, and reaps only service-owned abandoned resources before admission. Failed cleanup blocks execution. Source and disposable worker material are removed after attempts and during startup recovery. Publication receipts survive process failure and are reconciled instead of deleted to force retries.

## Retention and operational evidence

Open PR records remain while the PR is open. Closure starts a 30-day retention clock, with reopening and expiry handled by the ledger. Published GitHub reviews remain. Online SQLite snapshots can retain deleted records for the deployment's backup retention plus storage expiry-processing delay. Restore starts paused, purges expired data and reconciles live authority/publications before execution.

Health and alarms must contain aggregate status, never source, findings, credentials or raw provider diagnostics. Keep inspection output and recovery artifacts private. Prove secret isolation, mounted-path permissions, metadata denial, encrypted remote restore and alarm delivery on the actual host before unattended operation. A green build or advertised credential reference proves none of those live facts.

See [operations](operations.md) for exact configuration and control commands, [worker containment](worker.md) for image acceptance, and [release](release.md) for pilot and rollback.
