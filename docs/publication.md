# Publication

`createPublisher` consumes the store's existing summary/check intents after scheduler settlement. It does not claim a model lease. Admission and worker claims also save queued/running intents. The host must hold its singleton and use one publisher instance, which serializes mutations per pull request.

Supply `store`, the GitHub adapter, a trusted `readPolicy(livePull)` callback, `notify`, `engineRevision` and `operatorCommand`. The command must name the host's implemented private attempt lookup. It is displayed with the attempt ID in the summary; no dashboard URL is invented.

- `publishReview(result)` publishes only the exact currently saved result.
- `reconcilePublication(record)` handles queued, running and settled summary/check intents.
- `reconcileNotice(notice)` handles configuration failure, outdated comparison and cancellation notices, including a destination that never admitted an attempt.

Each returns `{ status, reason }`, where status is `published`, `pending`, `stale` or `access_revoked`. A pending uncertain create requires operator attention. Do not delete its receipt or repeat the create to make it disappear. The publisher first searches paginated App-owned records for the saved operation key. A known accepted write is acknowledged locally; uncertain acceptance stays pending. There is no automatic approval, request-changes review or merge.

The store saves operation intent before every remote mutation. Receipts include the destination, current intent/notice fence, service-authored operation key and remote ID. Resolution undo receipts can survive a newer generation because they compensate a specific prior App resolution. They cannot authorize a new resolution. Reconciliation keeps threads with replies open, including a reply that races resolution or a lost resolution response.

`invalidatePull(..., livePull)` saves a normalized lifecycle notice in the same transaction as invalidation. Admission and scheduler current-state checks supply this snapshot. `scheduler.cancelPull(..., livePull?)` also accepts it for host-driven cancellation. If the caller lacks a current trusted snapshot, it must reconcile admission before publishing a lifecycle notice. Access revocation prevents all writes.

Schema version 4 adds `publication_notices` and `publication_operations`. Both are scoped by repository and pull number and reference `pulls`. Retention must delete these rows with the pull's other private records, including notices with no attempt. Their JSON contains normalized destinations, review output and operation receipts, not webhook payloads, credentials, source files or human reply text.

## Finding and permission boundaries

Original path bytes and reviewed line ranges determine anchors. Invalid UTF-8 paths remain summary-only. LEFT comments use the diff filename and an old-side line range; source links use the recorded merge-base SHA. Model Markdown, links, images, mentions and markers are rendered as plain text. Only service-generated source links are clickable. Summaries stay below 50,000 UTF-8 bytes; further finding text goes into commit-scoped COMMENT reviews.

The integration pass receives compatible retained findings as `assessmentFindings`. Those inputs are bound to its input hash and limited to current readable source. They do not grant current findings or coverage. Only a complete current result and validated fixed assessment permit cleanup. Missing evidence leaves the old thread open.

The adapter requests repository-restricted Pull requests write tokens for publication and Checks write tokens for checks. It never asks for Issues write or Contents write. A mutation permission denial is distinct from lost installation access and raises an actionable pending result. Before live enablement, prove sticky-comment, check, review and thread-resolution operations with the intended App grants. If thread resolution needs Contents write in the target account, obtain explicit authorization for that exact scope change. The local synthetic transport tests do not prove the target-account permission matrix.

The REST review contract, including COMMENT and commit binding, is documented in [GitHub's review API](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request). [Review comment locations](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request) distinguish LEFT and RIGHT line ranges. Live rename/deletion acceptance remains part of the pilot.
