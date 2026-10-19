# Repository configuration

The host configures the GitHub App ID, signing key, webhook secret, approved immutable GitHub owner/account IDs, and central runtime hash. Keep GitHub and host secrets outside worker processes. The isolated CLI receives only its subscription OAuth credential. See [worker configuration and acceptance](worker.md) for image pins, Linux ownership, startup recovery and the network boundary. Installation IDs are discovered from the App and live-verified against approved account IDs. They are operational inventory, not another enrollment requirement. Signed installation events cannot approve an owner.

Select repositories in GitHub's installation settings. A selected repository under an approved owner opts in with `.github/claude-review.json` and `REVIEW.md` on its live default branch. The service rejects nondefault bases before reading their policies. No reviewer workflow YAML is required. A newly selected repository under an approved owner needs no per-repository host entry. Repository transfers outside the approved owner boundary fail closed. Installation tokens never fall back to another installation or a personal token.

The smallest policy is:

```json
{
  "schemaVersion": 1,
  "enabled": true
}
```

`REVIEW.md` contains the repository's review instructions. List any additional applicable repository instruction files explicitly in `instructionPaths`, for example `["AGENTS.md", "src/AGENTS.md"]`. The loader fetches this policy, `REVIEW.md`, and those files at the captured base SHA. Its policy hash includes normalized settings and each instruction's content hash. Links inside instruction text do not grant additional file access. PR edits to policy and instructions remain review input until they reach the trusted base.

## Local policy fields

Unknown fields, unsupported versions, unsafe instruction paths, missing required files, and invalid JSON fail closed. Admission returns a durable `configuration_failure` with no queued inference. The service retains and publishes that failure through its notice ledger. See [service operations](operations.md) for startup, controls, retention, and actor-provenance limits.

| Field | Default | Meaning |
| --- | --- | --- |
| `schemaVersion` | Required, `1` | Supported policy format |
| `enabled` | Required | Explicit repository enablement |
| `baseBranches` | `["main"]` | Eligible target branches |
| `skipLabels` | `["skip-review"]` | Labels that cancel work |
| `rerunOnUnskip` | `false` | Whether removing a skip label may start work |
| `excludeGlobs` | `[]` | Scope exclusions consumed by source planning |
| `excludeDocsOnly` | `false` | Documentation-only exclusion consumed by source planning |
| `docsOnlyGlobs` | `["**/*.md", "**/*.mdx", "**/*.rst", "**/*.txt", "docs/**"]` | Paths counted as documentation when `excludeDocsOnly` is true. All old and new paths must match; mixed changes retain documentation coverage. |
| `allowBotAuthors` | `false` | Whether PR authors may be bots |
| `allowedBotActors` | `[]` | Exact bot logins allowed to trigger automatic work. Literal `"*"` permits any bot actor. Bot-author policy and human write-permission checks for rerun commands still apply. |
| `contextMode` | `"changed-context-only"` | `changed-context-only`, `diff`, or `allowlist`, enforced by source planning |
| `contextAllowGlobs` | `[]` | Explicit additional context selection for source planning |
| `githubLinksOnly` | `false` | Local publication restriction consumed by the renderer |
| `instructionPaths` | `[]` | Additional trusted instruction paths, maximum 32 |

Restricted repositories should retain `contextMode: "changed-context-only"` and explicitly set `githubLinksOnly: true` when required. These are separate controls. Other repositories can explicitly configure their permitted source navigation during migration.

## Source capture and worker inputs

Construct one `createSourceService` at startup with a dedicated host-owned temporary `root`. Startup deletes abandoned `capture-*` and `bundle-*` workspaces within that root. Pass its `credential` option the host adapter's `installationCredential` operation. That operation rechecks installation ownership and repository access, then requests a repository-scoped token with `contents: read`. Keep the adapter and temporary object store outside workers.

Call `captureManifest(identity, trustedPolicy, signal?)` with the admitted immutable `ReviewIdentity`. Capture verifies the policy hash, fetches exact base/head objects into an isolated bare repository, checks object integrity, and independently verifies the unique merge base. It enumerates Git's NUL-delimited raw changes without GitHub file-list or patch limits. Exact-content renames are paired; edited renames remain explicit delete/add changes. Missing objects, ambiguous comparisons, exclusions, binary content, and resource limits never imply a clean review.

`materializeBundle(manifest, unitIds, signal?)` creates a separate service-owned read-only directory. Only mount its `allowedReadScope` into the worker, as a read-only mount. Do not mount the service root or `manifest.workspace`. Its files use hashed aliases with a byte-safe original-path mapping. Symlink targets are data. Startup-like files and planted review outputs are quarantined as `.txt` data. No repository configuration or scripts execute.

`diff` exposes selected diff data. `changed-context-only` also exposes the old/new contents of selected changed files. `allowlist` additionally exposes head files matching `contextAllowGlobs`. All selection happens before materialization. Globs use Git's forward-slash path semantics on every host. A non-UTF-8 name under an exclusion policy is conservatively excluded and recorded; it cannot bypass a private exclusion. The bundle's context hash covers every readable file and stable mapping plus policy/runtime hashes. Attempt IDs, head SHAs, absolute host paths, and unrelated exclusions do not enter that hash.

Hunks split below 128 KiB with overlapping context and original line ranges. Single long lines use explicitly labeled byte fragments. Pass planning must include every resulting unit ID and retain explicit omissions. Binary blobs and gitlink contents are represented by metadata with omission records, rather than decoded or expanded. Defaults bound individual blobs to 16 MiB, aggregate blobs, retained raw diffs, and generated patch data to 128 MiB, bundle data to 128 MiB, each Git output to 64 MiB, captured disk use to 1 GiB, and each Git command to five minutes. Rejected raw diffs are never cached. Disk use is sampled during Git commands and checked after fetching; the deployment should also bound the temporary volume. Limits produce missing scope while preserving other reviewable changes where enumeration remains available.

Failure to enumerate optional allowlisted context preserves available changed-file scope. Its retrieval record has a null path and a `context_` error code, for example `context_git_output_limit`, and is carried into bundle omissions. It means neighboring context is unavailable, so the overall review still has missing scope. Cancellation continues to abort and clean up the capture.

The caller must invoke `destroyWorkspace` for every successful bundle and its capture workspace in `finally`, after success, failure, or cancellation. Capture failures and materialization errors remove their own partially created directories. Aborted Git commands terminate their process tree. Constructing a second service against an active root is unsupported because startup cleanup owns that root.

Source tests generate synthetic bare Git objects. The default transport has a real HTTPS fetch and a process-scoped Node credential helper. `REVIEWER_HOST_GIT_TEST=1 npm test -- test/source-transport.test.ts` also exercises Git's actual helper launch using synthetic credentials, without a network request. This opt-in is needed on Windows hosts whose sandbox blocks Git's MSYS subprocesses.

## Pass planning and coverage

`planCoverage(manifest, previous, ancestry)` plans from captured metadata without writing bundles. The manifest's `bundleInputs` contain aliases, original paths, unit mappings, hashes, byte sizes and selection roles. They contain no source bytes. `describeBundle` in `src/source.ts` owns selection and context hashing for both planning and materialization.

Scope passes group conventional `packages`, `apps`, `modules` and `services` directories by package. `src`, `lib`, `test`, `tests` and `__tests__` pair nearby modules. Root files, shared contracts, configuration, uncertain paths and cross-group renames broaden invalidation to the whole comparison. This is a conservative directory rule, not dependency analysis. Current integration still checks cross-group effects.

Each scope starts with at most 200 KiB of diff text, identified by `initialAliases` and `initialBytes`. All assigned units remain explicit. Full permitted source context stays navigable in the bundle. Scope navigation narrows the policy maximum to that group plus shared context. Integration receives the full permitted comparison and starts with at most 200 KiB of its diff text. A bundle resource omission remains missing scope even when a worker reports completion.

Use these host-side operations in order:

1. Read `store.passHistory(repositoryId, pullNumber)`. It includes failed and completed records with their original review identities.
2. Call `source.verifyAncestry(manifest, heads, signal?)` with previous head SHAs and the current head SHA. It runs Git merge-base against captured objects. Missing or unrelated old heads cannot authorize reuse. The returned frozen proof is valid only in that process and for that head. Recompute it after restart; serialized data and model claims are not proofs.
3. Call `planCoverage`. Its `reusedPasses` contain only compatible completed scope, projected to the current identity with `spec.reusedFrom` for older attempts. Persist adopted records with `savePass`. Current-attempt records retain their existing specifications. Failed scope is fresh. Base, merge base, policy, runtime and repository identity changes prevent reuse.
4. Call `source.materializePass(manifest, plannedPass, signal?)` only for the next pass to execute. It checks the planned hash, omissions and initial aliases, writes one bundle and verifies captured bytes. It returns `{ spec, bundle }`. Only this runnable `PassSpec` has a real `bundlePath`; `PlannedPass` has none. Mount only `bundle.allowedReadScope`, read-only. Dispose the bundle in `finally`.
5. Save the terminal, host-validated worker outcome. `validatePassOutcome` rejects foreign evidence units, unknown prior-finding references and worker-supplied coverage fields. The worker boundary must still validate execution success and source locations. These APIs do not turn arbitrary parsed model output into a trusted terminal outcome.
6. Replan from saved outcomes before running integration. This supplies current scope findings, including useful findings from failed passes. Integration IDs bind the current comparison and finding inputs. An earlier integration result cannot certify later findings.
7. Call `aggregateReview` with current stored records and any current projected reuse records. It derives coverage from validated assignments and terminal outcomes. Finish by disposing the capture workspace, including failed captures whose directory was already removed.

`splitScope(manifest, plannedPass)` divides a multi-unit scope into two smaller passes. Their exact unit subsets remain reusable and count once toward coverage. A single unit returns no children; the execution layer must stop after its finite recovery limit. Recovered parent failures keep useful findings but do not block completion when their units are covered and current integration completes.

`ReviewResult` separates covered units, reused units, missing units, missing context, exclusions and integration status. Binary and gitlink contents are excluded explicitly; their eligible metadata units do not certify their contents. Null-path `context_*` failures retain reviewed change units and findings but make the overall result incomplete. Empty or wholly policy-excluded comparisons produce `status: "skipped"`, `reason: "no_eligible_scope"`, no integration and no inference. Zero units caused by retrieval failure remain incomplete.

The ledger keeps planned specifications and findings, without temporary bundle paths, captured diff/blob text or prompts. Legacy records without scope metadata remain readable but cannot qualify for current reuse. `publicationState: "unpublished"` is the aggregation result, not a claim about GitHub publication.

## Events and reruns

Subscribe to `pull_request`, `push`, `issue_comment`, and `check_run`. Also process GitHub's automatically delivered `installation` and `installation_repositories` events.

Pass the original UTF-8 request bytes and lowercase GitHub headers to `admitWebhook`. Octokit's verifier runs before database writes or API calls. Bodies over 30 MiB are rejected, and raw payloads are not retained. Send HTTP acknowledgement only after its promise resolves. Admission persists the attempt and normalized receipt before returning; it never calls an inference provider.

Open, ready, synchronized, and reopened internal PRs may start work. Compare head/base repository IDs to detect forks; a repository's own fork flag does not exclude its internal PRs. Current live draft, closed, retargeted, disabled, or skipped state cancels prior work, including leases and planned publications. Generation and rerun high-water marks survive cancellation and restart.

A PR comment containing exactly `/claude-review rerun`, apart from surrounding whitespace, requires a human comment author with current write, maintain, or admin permission. Comment identity deduplicates repeated command delivery. Check-run rerequests require a human actor with that same live permission, the App's own current-head check, and exactly one associated PR. GitHub delivery identity deduplicates repeated check-run events. PR titles and bodies cannot authorize work or choose destinations.

Unskip does not start work unless `rerunOnUnskip` is true. Reconciliation preserves deliberate skipped, disabled, revoked, retargeted, and base-invalidated state for the same head. A new eligible head or authorized explicit rerun can start a fresh generation. A disallowed bot actor cannot be bypassed by reconciling the same head.

Base pushes only invalidate comparisons. They do not queue inference or create publication intents, including for a PR never reviewed before. Reconciliation also detects missed base-only movement when a prior identity exists. A delayed lifecycle delivery uses current GitHub state for closure, draft, skip and access cancellation. Automatic actor eligibility applies only when the signed delivery head matches the current head; unrelated labels cannot authorize or cancel work through their sender.

## Recovery and host integration

`reconcileInstalled` paginates installation repositories and open PRs. It also checks tracked PRs missing from an open list and cancels work for repositories missing from live installation membership. Independent installations continue after a confirmed revocation; a read never falls through to another token for the same operation.

Fresh approved-owner installation and repository-access reads can clear stale durable denial after a missed re-add/unsuspend or delayed removal event. Restoration checks the access clock atomically, so metadata read before a concurrent revocation cannot clear that revocation. It preserves cancelled attempts and the same-head waiting rule. A later eligible head or authorized explicit rerun can start fresh work.

The service calls `reconcileDue()` at startup and during its serial cycle. The standalone `startReconciliation(onError)` timer uses the same scan state and retry deadline. Both scan immediately, then every 15 minutes without overlap. They honor GitHub's `Retry-After` and primary rate-limit reset timing. Secondary-limit responses without retry timing wait at least one minute. Repeated limits increase the delay through two, four, eight, and fifteen minutes, with longer provider timing still taking precedence. A successful scan restores the normal cadence.

Startup failures leave scheduling and publication blocked until the first successful scan. Later scan failures report unhealthy reconciliation while allowing scheduled work and publication to continue through their own live guards. Operator reconciliation also respects an active retry deadline.

The standalone timer's returned stop function prevents subsequent scans; it does not interrupt an in-flight HTTP request. The host owns HTTP status handling, process shutdown, actionable alarms, worker cancellation, and publication. Callers receive sanitized request errors with a safe `rateLimited` flag and no authenticated request headers or response bodies.

The ledger uses schema 5, with additive upgrades from schemas 2, 3, and 4 that preserve existing records. Other existing versions are rejected. Rollback retains the current ledger and requires a binary compatible with schema 5; an older binary that rejects it needs a reviewed compatibility build. See [release and rollback](operations.md#release-and-synthetic-acceptance) for the operating procedure.

Authentication and signature behavior follow the upstream [Octokit App authentication](https://github.com/octokit/auth-app.js) and [Octokit webhooks](https://github.com/octokit/webhooks.js) interfaces. Tests use an ephemeral RSA key and a synthetic HTTP transport, with no live App or provider calls.
