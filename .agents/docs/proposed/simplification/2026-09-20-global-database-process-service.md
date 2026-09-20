# One process-scoped database for the global root

Date: 2026-09-20
Status: proposed
Baseline: `main` at `3378a967`. Parent:
[service scopes and ownership ledger](./2026-09-20-service-scope-ownership-ledger.md),
candidate P1. Consolidates under #12422 (runtime boundary residue and
resource lifetime).

## 1. Problem

`withScopedDatabase` (`src/controllers/session/Database.ts:1279-1294`) builds
a complete database layer per operation: a fresh `databaseLayer('persistent')`
plus its own `WorkspaceRoots` and `ProcessIdentity`. Each call runs
`mkdirSync`, `SqliteClient.make`, `configure` (four pragmas including a
`journal_mode` verify and a `user_version` check), `applySchema`, and
`Effect.forkScoped` of the 250 ms `PRAGMA data_version` poll
(`Database.ts:405-425`), then tears all of it down. Five callers do this for
single-row reads and writes:

| Caller                                                     | Operation                          |
| ---------------------------------------------------------- | ---------------------------------- |
| `src/controllers/session/updateCheckRecords.ts:14`         | one update-check row               |
| `src/controllers/session/appStateStore.ts:128,135`         | one app-state key read or write    |
| `src/controllers/session/inquiryRecords.ts:31`             | one inquiry record                 |
| `packages/cli/src/…/inputHistory.ts:40`                    | append or load CLI input history   |
| `packages/desktop/src/main/desktopProjectRecords.ts:17-27` | a sixth, hand-rolled `Layer.build` |

Two connections on one file in one process are legal and safe here:
`busy_timeout` is set before WAL (`Database.ts:1327-1336`) and claims are
enforced in SQL (`:505-520`). The cost is different. The change-detection
design assumes one long-lived handle per root: the poll compares
`data_version` against a captured `let version` and drives `SubscriptionRef`
wake levels. A handle that lives for one operation observes nothing, so for
these callers the `Database`'s reactive surface is dead code that is built
and torn down every time.

## 2. Proposal

One process-scoped database for the global storage root, built once in
`installProcessRuntime` beside `globalStorageFsLayer(globalStorage)`
(`src/controllers/session/sessionLayer.ts:1117-1123`). `GlobalStorageFs` is
the existing precedent for exactly this shape: one per process, the global
root, provided beside `lean` rather than among the host-value `services`.

- Tag: either a new `GlobalDatabase` tag with the `Database` shape, or the
  existing `Database` tag provided at process scope for the global root. The
  session-scoped `Database` per workspace root is unchanged.
- `InquiryRecords` and `UpdateCheckRecords` become `Layer.effect` over it,
  dropping their storage-path and owner-id parameters.
- `inputHistory`'s `access` wrapper and its own `selfIdentity` read go; it
  yields the tag.
- `desktopProjectRecords` yields the tag instead of building a layer.
- `withScopedDatabase` is deleted.

## 3. Two blockers, both real

1. **`openAppStateStore` runs before the runtime** on the CLI and the desktop
   (`packages/cli/src/runtime/cliProcessRuntime.ts:113-131`,
   `packages/desktop/src/main/platform/index.ts:148`), so it cannot take the
   tag from a runtime that does not exist yet. It keeps a scoped build, but
   then it is the only one and should hold one handle for the store's life
   rather than one per key write. That store is also the value `AppState.layer`
   wraps (#12553), so this does not reopen the settled construction order.
2. **The desktop has two global roots.** `globalStorage` is the shared
   `~/.texra` and `updateCheckStorage` is the Electron profile
   (`platform/index.ts:203-205`, rationale at `:154-157`). One tag does not
   cover both. Either two tags, or one process-scoped keyed family (a
   `LayerMap` keyed by root, as `leanServerPool.ts:144` already does), or a
   decision that the split is not needed once the update-check row lives in
   SQLite. The third is the simplest and is the owner's call.

## 4. What we give up

Nothing in behavior. The five callers observe the same rows through one
handle. Tests that build a database per operation through
`withScopedDatabase` provide the process layer instead.

## 5. Accounting

| Deleted                                                     | Count                                          |
| ----------------------------------------------------------- | ---------------------------------------------- |
| `withScopedDatabase` and its doc                            | 1 export                                       |
| `withDatabase` (update-check), `inGlobalDatabase` (inquiry) | 2 wrappers                                     |
| layer parameters on the two record modules                  | 2 params                                       |
| `inputHistory` `access` wrapper and `selfIdentity` read     | ~10 lines                                      |
| desktop manual `Layer.build`                                | ~11 lines                                      |
| per-operation layer builds and poll fibers                  | 6 sites                                        |
| Net LoC                                                     | about −90                                      |
| Added                                                       | 1 tag, 1 layer line in `installProcessRuntime` |

## 6. Acceptance

- `Database.ts` has no `withScopedDatabase`.
- `installProcessRuntime` provides one global-root database; `InquiryRecords`
  and `UpdateCheckRecords` depend on it and take no path or owner parameter.
- `desktopProjectRecords.ts` contains no `Layer.build`.
- Opening a session and writing one app-state key forks at most one
  `data_version` poll per long-lived handle (assert by counting forks in the
  existing `Database` suite, not by adding a suite).

## 7. Risks

The `Layer.fresh` boundary for session entries must not capture the global
handle; provide it in the process layer, outside the entry. The desktop
two-root decision (section 3) must precede implementation or the second
root keeps its own scoped build.
