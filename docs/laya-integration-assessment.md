# Laya integration assessment (historical proposal)

Final decision: do not integrate Laya. The experimental implementation was removed after local evaluation; see [the decision and measurements](game-api-diagnostics.md#laya-decision). The repository/branch snapshot below describes the initial audit, before final consolidation and cleanup. Initial research reviewed September 23, 2026. The follow-up implementation and local evaluation are documented in [Game API diagnostics](game-api-diagnostics.md). This file preserves the original proposal; its external benchmark numbers are not measurements of this machine.

## Repository snapshot

The repository audit on September 23 found `origin/master` at `1a7d867` and the current checkout at `799a4a8`. The current branch contains `origin/master` plus two commits associated with open PR #14. Six fully merged local branches were removed. The remaining local branches are `master` and `codex/fix-installer-migration-ux`, with one worktree and no stale registrations. Local `master` now tracks `origin/master`.

The separate upstream reference at `cbca58c` diverges from origin, with 43 origin-only commits and 83 upstream-only commits. It was not integrated. Four remote feature branches with unmerged commits were preserved.

## Recommendation

Improve deterministic error reporting first. Evaluate Laya as an optional classifier for unfamiliar errors after that work. Adding inference to every successful MCP call would add latency, while the current server already receives an explicit tool name and structured arguments from its client.

Laya could reduce an agent's follow-up calls if it reliably identifies an unfamiliar failure and suggests the right diagnostic. That benefit is a hypothesis to measure with Foundry examples. It would not make Foundry document operations or WebSocket/WebRTC transport intrinsically faster.

## What the model does

Laya scores choices, ordinal scores, and yes/no probabilities using an encoder and decision head. It does not generate repairs, scripts, or explanations. The English checkpoint has 421 million parameters and a 512-token default context, with about 320 tokens left for state. Other checkpoints support larger contexts. Its weights are Apache-2.0 licensed. The model card reports roughly 33–40 ms for one question on a T4 GPU and 193–464 ms on CPU. Those are upstream measurements, not this computer's performance. [Model card](https://huggingface.co/convaiinnovations/laya)

The important distinction is that structured _answers_ constrain the model's output. They do not guarantee that its interpretation of a JSON state is correct. The upstream card acknowledges unreliable act/escalate probabilities and confident mistakes. Its English base checkpoint reaches about 36% on the typed-decisions benchmark, below the 46% majority-class baseline. The 76.6% result belongs to a checkpoint fine-tuned on that benchmark's training split. That does not establish Foundry competence. [Model card](https://huggingface.co/convaiinnovations/laya#honest-limits)

The benchmark report recommends fewer than roughly 20 choices and calibration on application data. Its Jev comparison uses separately published results with different prompts and samples. The newer GPU fast path reports 2.8–4.6 ms for short inputs on an RTX 4070 Ti SUPER, but longer batches cost more and first-use compilation adds delay. CPU results vary substantially with thread settings. None of these measurements predicts end-to-end MCP improvement. [Benchmark report](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md)

## Relationship to Jev and deployment

Calling this an open implementation of the same decision API is reasonable. Calling it a reproduction of Jev's model would go beyond the evidence. Laya's HTTP server implements the Jev-compatible `POST /v1/systemone` contract with a separate model behind it. It accepts state, questions, and an optional checkpoint selection. The service has a health endpoint and optional bearer authentication. Its default binding is all interfaces, so a local bridge deployment should explicitly bind `127.0.0.1`. Inference requests currently share one worker. [HTTP implementation](https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py)

This introduces a Python runtime and PyTorch/Transformers dependencies. The package declares Python 3.10 or newer and optional HTTP, MCP, ONNX, and GPU acceleration dependencies. Keep those outside the Electron/backend installation until a measured benefit justifies packaging them. [Package manifest](https://github.com/NandhaKishorM/laya/blob/main/pyproject.toml)

Laya also supplies its own optional MCP server. That offers a way to experiment independently, but having a client explicitly invoke a second MCP tool does not automatically shorten the existing bridge's error path. [MCP implementation](https://github.com/NandhaKishorM/laya/blob/main/laya/mcp/server.py)

## Existing bridge opportunities

The following observations come from the local source:

- `packages/mcp-server/src/foundry-client.ts` already classifies failures as `NOT_CONNECTED`, `NO_HANDLER`, `VERSION_MISMATCH`, `TIMEOUT`, `UNKNOWN_OUTCOME`, or `QUERY_FAILED`. Preserve these authoritative classifications.
- `packages/mcp-server/src/utils/error-handler.ts` creates a plain `Error` in `handleToolError`. That can discard an existing `BridgeError.code` before `backend.ts` tries to serialize it. Repairing that path can improve agent recovery without any model.
- The current read-only classification in `foundry-client.ts` relies on a method-name pattern. Explicit operation metadata would make retry safety easier to inspect and test.
- A lost response to a write may mean the write committed. `UNKNOWN_OUTCOME` must require inspecting state before another write, regardless of a classifier's prediction.

## Bounded implementation proposal

1. Preserve structured errors end to end. Add deterministic recovery hints for known codes and explicit operation safety metadata. Measure dispatch, transport, Foundry execution, and recovery round trips separately.
2. Build a redacted Foundry failure dataset, including different systems, versions, and disconnect cases. Separate training, calibration, and evaluation cases by incident to avoid testing on copies of training examples.
3. Add an opt-in backend diagnostic adapter to a persistent loopback Laya HTTP service. Initially run it offline or in shadow mode, where predictions are recorded but do not alter responses or execution.
4. Send a small bounded state containing the existing code, sanitized message, operation category, versions, and connection facts. Ask one choice question with a handful of diagnostic categories and an `unknown` option. Do not send entire worlds, compendiums, credentials, or arbitrary logs.
5. Validate responses against a strict schema. Apply a timeout, bounded concurrency, and a circuit breaker. A model outage must leave normal bridge behavior available. Keep inference out of desktop status polling and the module's reconnect loop.
6. Compare against the deterministic baseline. Measure category precision, false actionable advice, abstention coverage, p50/p95 latency, memory, and agent follow-up calls. Test calibration on held-out Foundry cases rather than interpreting confidence as a guaranteed probability.

Only after that evaluation should the backend return an optional advisory diagnostic alongside the original error. The classifier should never grant permissions, select a different server, retry writes, decide that an unknown write outcome failed, or execute generated code. If it cannot beat deterministic hints on useful coverage and total recovery time, leave it out of production.
