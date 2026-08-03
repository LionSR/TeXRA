# Architecture Rulings Ledger

**Status:** Living. Each entry is a **closed** question — a decision that has
already cost an audit round to reach and must not be re-litigated. Add an entry
when a recurring audit question is settled but has no natural home in a plan
doc; when it does have a home (a numbered disease, a tiered item), record it
there and leave a one-line pointer here instead.

**Format:** one heading per ruling, stating the question, the decision, the
evidence that forces it, and what the decision forbids. Anchor evidence on
symbol and clause text, not line numbers — line cites in this repo drift under
shared-checkout churn.

---

## D1/T9 — persisted `result.outcome` stays; the read-time projection is final

**Question.** Drop the persisted `result.outcome` field now that `meta.outcome`
is the durable writer of "how did this run end", or accept the landed read-time
projection as the final design?

**Ruling.** Close as superseded. The read-time projection is final, and the
persisted `result.outcome` field **stays**. No field drop, no migration.

**Evidence.** `applyExecutionOutcome` (`src/agent/storage/resultMeta.ts`) is the
one projection, and its own contract comment records why the two values are not
redundant: a durable `completed` is **never** projected, because the result
envelope's producer may already have downgraded a nominally completed flow that
reported an application-level error. That downgrade is
`buildSubagentFailureResultMeta` (`src/tools/delegation/subagentResults.ts:553`), called from
both delegation strategies (`nativeSubagentStrategy.ts`,
`inBandSubagentExecution.ts`) and pinned by `SubagentResultMeta.vitest.ts`. So
`result.outcome` carries a producer-side subagent-failure downgrade that
`meta.outcome` does not, and a naive drop would silently flip failed child runs
to `completed` at every read — the exact wrong-but-quiet class the repo treats
as a defect.

**What this forbids.** Do not re-propose dropping the field, and do not add a
second writer of `result.outcome` at read time. The projection stays one
function with one direction: `meta.outcome` narrows the envelope, never widens
it to `completed`.

**Home.** The disease this closes is D1 in
[`2026-06-10-lifecycle-status-ownership.md`](./2026-06-10-lifecycle-status-ownership.md).

---

## D7/T14 — no PersistedState one-instance-per-key registry

**Question.** Build a registry that guarantees one `PersistedState` instance per
storage key, so two instances (each with its own cached `state`) cannot
overwrite each other's writes?

**Ruling.** Close as superseded. **Do not build the registry.** It would add an
element without deleting a dual system: the construction sites are few, and each
production site that can be single-owner already documents itself as one — see
the in-file comment on `webviewStorage` in
`packages/extension/src/webview/frontend/persistence.ts` ("a second instance …
has no reason to exist").

**The narrower follow-up is blocked, and this is the record of why.** The
accepted residue was a ~40-line dev-mode duplicate-key assert in
`PersistedState`'s constructor. Re-verifying the sites at HEAD shows the
premise it rested on ("3 sites, each single-owner by construction") is stale.
There are **four** production sites, and the fourth is not single-owner:

| Site                                                                       | Key                                     | Single owner?                                     |
| -------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------- |
| `src/controllers/progressView/backend/ProgressViewState.ts`                | `WorkspaceStateKey.PROGRESS_VIEW_PREFS` | yes                                               |
| `packages/extension/src/webview/frontend/persistence.ts`                   | `'mainViewState'`                       | yes, documented in-file                           |
| `packages/extension/src/settingsView/frontend/components/history/state.ts` | `'historyView'`                         | yes                                               |
| `packages/extension/src/progressView/frontend/components/LogList.ts`       | `logListStateKey(streamId)`             | **no — one per stream, behind an evicting cache** |

`LogList.getOrCreateEntry` constructs a `PersistedState` per stream against a
module-level `webviewStorage`, and the entries live in an
`LRUCache({ max: MAX_CACHED_STREAMS })` that both evicts and `clear()`s. Revisit
a stream after its entry was evicted and the same `(storage, key)` pair is
legitimately constructed again. A constructor assert keyed on that pair would
therefore throw in dev/test (and warn in production) on ordinary navigation — a
false positive, which is its own defect, not a guard.

**What landing it would take**, if someone wants it later: a `dispose()` on
`PersistedState` that unregisters the key, the manager held on `LogList`'s
`CachedStream` rather than captured in a local closure, and the LRU's `dispose`
hook wired to release it. That is a change to the progressView webview render
path and needs to be scoped as such — it is not a drive-by on the shared state
helper.

**What this forbids.** Do not file the registry again. Do not land a
construction-time duplicate-key assert without the disposal path above; without
it the assert is knowingly wrong for `LogList`.

---

<a id="modelcell"></a>

## ModelCell — current ownership ruling supersedes only the retired prohibition

**Question.** Does the retired runtime gold-standard PRD's statement that
`ModelCell` “must not be implemented from this record” still prohibit the
`ModelCell` ownership primitive now present on `main`?

**Ruling.** No. The implementation merged in
[#9547](https://github.com/LionSR/TeXRA/pull/9547) is authoritative for the
narrow ownership and lifecycle guarantees below. It supersedes the retired
PRD's top-level [historical-status clause](../prds/2026-06-29-prd-runtime-gold-standard.md),
which says the listed designs “must not be implemented from this record,” and
its [§2 ModelCell text](../prds/2026-06-29-prd-runtime-gold-standard.md#2-modelcell-the-one-mutable-seam)
only where those passages deny that this primitive exists on `main`.

**Current guarantees.** The code, rather than the retired design, defines the
accepted shape:

- `AgentLaunchContext` constructs one `ModelCell` for the run from its launch
  handler and model id. Flow services and the tool-facing run context share that
  cell instead of copying a live handler/client pair.
- `ModelCell.swap` synchronously adopts the replacement handler and model id,
  clears the cached client, and disposes the distinct handler it retires. A
  lazily built client is reused until `rebind` or `swap`; build and rebind
  completion guards prevent a client produced for a retired handler from being
  published as current.
- A tool-use model switch persists `shared.modelId` and the run config before
  the live swap, then updates the launch-context mirrors through
  `onModelChanged`. Resume reconstructs the handler from that persisted model
  identity.
- The run lifecycle calls `ModelCell.dispose()` in its `finally` path. Thus the
  cell disposes handlers retired by successful swaps and the handler still live
  when the run ends. In the tool-use switch path, the runtime explicitly
  disposes a replacement candidate before ownership transfer only when the
  conversation-format check rejects it or either persistence write fails. This
  is not a blanket guarantee for exceptions from compatibility inspection,
  `setAgentCategory`, or `setLogger`. On success, `ModelCell.swap` adopts the
  replacement before disposing the distinct handler it retires.

**Scope of supersession.** This ruling does **not** revive the retired PRD as a
plan, make its unmerged `RunDescriptor` injection program authoritative, or
approve its `PendingRequests`, `RetryPolicy`, `RetryGate`, `HostUiBus`, stage
sequence, or concept-count claims. Those passages remain historical.

**Implementation evidence.** The accepted behavior is defined by
`src/agent/runtime/ModelCell.ts`,
`src/agent/runtime/AgentLaunchContext.ts`,
`src/agent/runtime/AgentRunLifecycle.ts`,
`src/agent/runtime/SessionResumeRetrieval.ts`,
`src/agent/runtime/executeAgent.ts`, and the model-switch path in
`src/agent/implementations/flows/tooluse/runToolUseFlow.ts`.

**Test evidence.** The focused coverage is in
`src/test-kernel/agent/runtime/ModelCell.vitest.ts`,
`src/test-kernel/agent/runtime/AgentRunLifecycle.vitest.ts`,
`src/test-kernel/agent/SessionResumeRetrieval.vitest.ts`,
`src/test-kernel/agent/runtime/ResumeToolUseCancellation.vitest.ts`, and
`src/test-kernel/agent/followUp/ModelSwitchState.vitest.ts`.

Future changes to model ownership must be justified against that current
implementation and test coverage, not by treating the retired gold-standard
program as normative.
