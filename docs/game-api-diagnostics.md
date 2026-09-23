# Game API diagnostics

Implemented for consolidation onto `master`, based on `799a4a8`. All six manifests are `0.13.2`. No upstream commits were merged or cherry-picked, and no installed module files were changed.

## Error recovery

Legacy tool formatting now preserves `BridgeError` instances. The backend puts the original code and deterministic recovery advice in the MCP text content as JSON, while retaining `isError` and the existing top-level `errorCode` extension. Clients that ignore extension fields still receive the advice.

For an uncertain write, the content includes:

```json
{
  "errorCode": "UNKNOWN_OUTCOME",
  "recovery": {
    "automaticRetry": false,
    "action": "inspect_state",
    "message": "The write may have completed. Read current state or the audit log before retrying; do not replay the write automatically."
  }
}
```

The full content also includes the original error message. This changes error text from prose to JSON; successful tool content is unchanged. No automatic retry was added.

`shared/src/operation-safety.ts` explicitly classifies the 96 registered handlers. Unknown handlers and handlers from another namespace are never assumed read-only. A registration-coverage test requires new handlers to declare their semantics. Combined read/write operations remain classified as writes, even when a particular request is a dry run.

## Timing

Diagnostics are off by default. Set `FOUNDRY_DIAGNOSTICS=timing` in the backend's launch environment and restart the backend to log:

- Whole tool duration, including reconnect waits and error classification.
- Each query's round-trip duration, operation, outcome, and read/write classification.
- Foundry execution duration when the module supplies it.

The module adds timing to the response envelope, outside handler results. Older modules remain supported; missing module timings stay absent. At most 64 query samples are retained per tool call, with an omitted-query count. Completion callbacks keep concurrent calls' samples separate.

These timings do not independently measure network transit or recovery across several agent calls. Query round trips include queuing, transport, execution, and response processing. Parallel query times should not be summed and subtracted from total tool time. Module timing is advisory and rejected if malformed or implausible. Existing backend logs receive fixed names and numerical measurements, not argument payloads.

## Compatibility fixes

Four upstream ideas were adapted to this fork's existing APIs; no upstream commits were imported:

- Preserve Activity save data and serialized Advancement data without traversing live Advancement objects or deprecated D&D ability-save getters.
- Resolve Actor UUIDs and Scene Token UUIDs, returning prepared synthetic actor state. Existing world actor ID/name precedence remains intact; ambiguous bare token IDs fail explicitly.
- Rename an existing journal page when `pageId` and `newPageName` are supplied together. The generic document service records permission checks, audit data, and an inverse for undo.
- Reject malformed or expired WebRTC responses promptly. Dispatched writes retain `UNKNOWN_OUTCOME`; the server neither retries them nor disconnects a healthy peer.

## Laya decision

Laya is not integrated. The experimental client, evaluator, and shadow mode were removed. Only optional timing diagnostics remain.

A local CPU experiment on 25 synthetic error cases scored 23/25 (92%) for deterministic rules and 19/25 (76%) for Laya. Warm model requests took approximately 220 ms median and 237 ms p95, with about 2 GB observed process memory. These are small synthetic measurements, not production accuracy estimates; GPU inference was not evaluated. They provide no evidence that this project's additional runtime and inference cost would improve recovery.

Historical [evaluation results](laya-evaluation-results.json) and [runtime details](laya-runtime-environment.json) remain as decision evidence. The [initial assessment](laya-integration-assessment.md) records research preceding this decision; its proposed integration was not retained.

## Verification

Regression tests cover serialization, exact character identity, audited journal rename, structured recovery, timing isolation, malformed responses, and chunk expiry. Live Foundry validation is required before a release. No installed module files were deployed and no release was published.

See the upstream [functionality review](upstream-functionality-review.md) and [architecture review](upstream-standards-review.md) for why broad tool, lifecycle, and installer imports were rejected.

The full workspace build and unit-test suite passed, as did MCP schema validation, the fork contract (93 tools / 96 handlers), six-manifest version consistency, and Windows installer safety checks. Targeted lint still reports existing errors in older source files; the new diagnostics and regression files pass.

Live validation remains pending: the installed backend reports 0.13.1 and both local and Forge profiles are disconnected. The smoke suite includes Actor UUID identity and journal rename/undo checks for the upgraded installation.

Branch history before consolidation is preserved in `.git/branch-archives/2026-09-23-before-cleanup.bundle`, verified as a complete bundle, with a matching refs manifest. The installer branch's two commits are retained in master; unrelated feature branches are archived rather than imported.

The temporary external Laya service is stopped. Automatic approval review blocked deletion of `C:\Users\Gage\.cache\foundry-laya-eval` and `D:\foundry-laya-eval-cache`; these isolated evaluation files remain outside the project and are unused.
