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
`buildSubagentFailureResultMeta` (`src/tools/subagentResults.ts`), called from
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
| `src/controllers/progressView/backend/state/ProgressViewState.ts`          | `WorkspaceStateKey.PROGRESS_VIEW_PREFS` | yes                                               |
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
