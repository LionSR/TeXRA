---
created: 2026-09-20
status: proposed
---

# Post-refactor architecture survey: what is left after the 1.0 engine replacement

Baseline: `main` at `3378a967` on 2026-09-20. Window surveyed: 2026-09-03 to
2026-09-20, 1 026 commits, 3 075 files, +271k / −354k lines, 852 files deleted.
Origin: ten independent surveys (Effect migration, `packages/llm`, agent
runtime and session, SDK tier and hosts, state ownership and race guards, run
programs and dispatch, Effect leverage, host layer, tools and shared schemas,
apparatus), each spot-checked
on the tree. The published status page is
<https://claude.ai/artifact/9aeiYZmqg1AKX5UTeoK5az>.

This note is the index. Each finding that warrants work has its own proposal,
listed in section 3, and a tracking issue under the umbrella #12880.

## 1. Verdict

The architecture replacement is done. `PersistedFlow`, `KVStore`,
`executionLease`, `fileLocks`, the model-handler hierarchy, the run-context
`AsyncLocalStorage` and the `Platform.fs` port have zero references. A run is
one Effect program appending rows to a per-root SQLite event table and
continuing from the folded `RunState`; resume is the same function. One
`ManagedRuntime` per host, sessions as a `LayerMap`, one provider caller
(`ModelInvoker`) over the `packages/llm` `Model`. Every architecture baseline
moved down in the window; none widened. The Effect-migration baseline is at
seven sites, all ruled permanent.

What remains is not engine work. It is:

- a set of second copies of run state that can disagree with the rows
  (section 2, [single-owner liveness](./2026-09-20-single-owner-liveness-and-one-fold.md));
- duplicated scaffolding across the two run programs and the child-run
  strategies ([dedup](../simplification/2026-09-20-run-program-and-dispatch-dedup.md));
- an LLM package that is migrated but not hardened, with one shipped
  capability regression ([hardening](./2026-09-20-llm-package-hardening.md));
- product logic written two or three times across the hosts
  ([host layer](../simplification/2026-09-20-host-layer-collapse.md));
- a schema barrel and a tool-call path carrying more than they need
  ([tools and schemas](../simplification/2026-09-20-tools-and-schema-surface-collapse.md));
- four Effect families with zero uses where hand-rolled equivalents live
  ([Effect adoption](../simplification/2026-09-20-effect-facility-adoption.md));
- a test estate and a docs corpus that an autonomous agent cannot navigate
  ([refactorability gates](../process/2026-09-20-agent-refactorability-gates.md)).

## 2. The single finding that explains most of the month's fixes

Of the 18 `fix(session)` and `fix(tools)` commits in the window, 7 were
"a local side effect ran without first taking the DB claim", 5 were "a second
projection disagreed with the rows", 2 were process-local facts read as
liveness. Roughly 13 of 18 are impossible under strict single-owner-per-fact.
The event table is sound; the in-memory authorities beside it
(`RunRegistry`, `RunLanes`, the approval-policy field, the `AppState` value
map) and the three interpreters of one row vocabulary (`runStateFold`,
`sessionFold`, `StreamLogStore`) are the defect surface. The 2026-09-10
ownership doc prescribed this fix; only its durable-claim quarter landed.

## 3. Proposals and their tracking issues

| Proposal                                                                                               | Class          | Deletes                                                                                                                    | Issue  |
| ------------------------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| [Single-owner liveness and one fold](./2026-09-20-single-owner-liveness-and-one-fold.md)               | architecture   | `runLanes.ts`, `waitingTermination.ts`, `holdLive`, the snapshot cross-checks, `StreamLogStore` as a store                 | #12881 |
| [Run-program and dispatch dedup](../simplification/2026-09-20-run-program-and-dispatch-dedup.md)       | simplification | seven duplicated loop pairs, a second attempt identity, two envelope formatters, one abort bridge, two empty path segments | #12882 |
| [LLM package hardening](./2026-09-20-llm-package-hardening.md)                                         | architecture   | nothing; adds the live tier, restores hosted tools, splits `turn.ts`                                                       | #12883 |
| [Host-layer collapse](../simplification/2026-09-20-host-layer-collapse.md)                             | simplification | a duplicated 42-arm switch, two Supabase state machines, two settings registries, two bootstrap bodies                     | #12884 |
| [Tools and schema-surface collapse](../simplification/2026-09-20-tools-and-schema-surface-collapse.md) | simplification | the non-contract half of the barrel closure, four probe catalogs, eight row arms, two pass-through tool layers             | #12885 |
| [Effect facility adoption](../simplification/2026-09-20-effect-facility-adoption.md)                   | simplification | three config providers, the second logger, two backoff copies, an `EventEmitter`                                           | #12886 |
| [Agent-refactorability gates](../process/2026-09-20-agent-refactorability-gates.md)                    | process        | the fake-platform installer, the host-agent mock ratchet, seven spent runtime proposals, five reverify docs                | #12887 |

## 4. Numbers the proposals rest on

| Measure                          | Value                                                                    |
| -------------------------------- | ------------------------------------------------------------------------ |
| Production TypeScript            | 283k lines, 1 402 files; 120 files over 500 lines, 27 over 1 000         |
| Test estate                      | 170k lines, 529 suites; 355 in the kernel tier; 244 use a mock primitive |
| Host packages                    | 117k lines, of which 29k is one webview UI library the desktop imports   |
| `@shared/schemas` barrel         | 60 modules, 9.5k lines, 811 importers                                    |
| `src/tools`                      | 36k lines, 53 tools, 14 module-global mutable caches                     |
| Planning docs                    | 269 files, 132k lines; 9 Effect-runtime proposals all marked proposed    |
| Effect facilities with zero uses | `Config`, `Metric`, `Cache`, `PubSub`, `TxRef`                           |

## 5. Not re-proposed

Checked against the rulings ledger and the 2026-09-17 refuted list, and
excluded here: `withPerKeyLane` onto `Semaphore`, `ModelRetryGate` onto
`Schedule`, `SessionOwner` onto the `Sessions` tag (D5), `SessionHandle`'s
`DisposableStore` onto a plain `Scope` finalizer as specified (D26; the
single-owner proposal restates it under the fiber-scope change that makes it
viable), cutting `src/auth` out of the SDK graph, the `MessageHandler`
dispatcher contract, and `DesktopPtyHost.create` as an Effect.

## 6. Two live defects found in passing

- `UsageLogService.dispose()` sits in a different shutdown phase in each host
  bootstrap (`packages/desktop/src/main/platform/index.ts`,
  `packages/extension/src/extension.ts`, `packages/cli/src/runtime/initPlatform.ts`),
  a queued-usage-loss window on the desktop. Fixed by the bootstrap step of
  the host-layer proposal.
- `packages/cli/src/commands/tools.ts` preserves an old empty catch as
  `Effect.orElseSucceed(() => null)`. A silent-degradation defect under
  CLAUDE.md; needs its own small PR because making it loud is a behavior
  change.
