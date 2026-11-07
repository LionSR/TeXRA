---
created: 2026-11-07
status: proposed (owner review)
---

# Red flags outside the harness core, and the order for everything still open

Origin: the owner's questions on 2026-11-06, "do we have more design red
flags?", "in what order is it best to do them? scan the other parts too",
and "it should be Effect-native and use the best Effect solutions". Round 1
(`../../evidence/2026-11-05-design-red-flags/`, areas A–F and L) read the
harness core and the hosts' session paths, and
[root designs, Effect-native](./2026-11-05-root-designs-effect-native.md)
(R1–R10) owns what it found. Round 2 read everything round 1 did not: eight
read-only audits, one per area, under one
[brief](../../evidence/2026-11-06-design-red-flags-round-2/BRIEF.md), with
every claim as `path:line` and grepped consumer counts, in
[`../../evidence/2026-11-06-design-red-flags-round-2/`](../../evidence/2026-11-06-design-red-flags-round-2/):

| Area | Report                                                                                              | Scope                                                                         |
| ---- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| G    | [app controllers](../../evidence/2026-11-06-design-red-flags-round-2/G-app-controllers.md)          | `packages/texra/src/controllers/`, `hosts/`, `telemetry/` and neighbours      |
| H    | [app tool plugins](../../evidence/2026-11-06-design-red-flags-round-2/H-app-tools.md)               | GitHub, Lean, Zotero, arXiv, agent CLIs, plugin registration                  |
| I    | [LaTeX and documents](../../evidence/2026-11-06-design-red-flags-round-2/I-latex-documents.md)      | `latex/`, `replacement/`, `tools/latex/`, `tools/documents/`, `agent/output/` |
| J    | [UI kit](../../evidence/2026-11-06-design-red-flags-round-2/J-ui-kit.md)                            | `packages/texra/src/ui/`, `packages/texra/src/shared/`                        |
| K    | [CLI](../../evidence/2026-11-06-design-red-flags-round-2/K-cli.md)                                  | `packages/cli/src/` outside round 1's F and the CLI-service note              |
| M    | [harness tools and platform](../../evidence/2026-11-06-design-red-flags-round-2/M-harness-tools.md) | built-in tools, `platform/`, `utils/`, `skills/`, `plugins.ts`                |
| N    | [VS Code and desktop](../../evidence/2026-11-06-design-red-flags-round-2/N-vscode-desktop.md)       | `packages/extension/src/`, `packages/desktop/src/`, `packages/trace-viewer/`  |
| O    | [llm providers](../../evidence/2026-11-06-design-red-flags-round-2/O-llm-providers.md)              | `packages/llm/src/` outside round 1's D                                       |

Surveyed on `main` at `6bbe08d`. Every Effect API named here and in the
reports was checked against `node_modules/effect` 4.1.2's `.d.ts`; each
report ends with an "Effect-native mapping" table that cites the line. One
assumption failed and is corrected everywhere, this note's parent included:
4.1.2 has no `Layer.scoped`. `Layer.effect` (`Layer.d.ts:1166`) already
provides a `Scope` to its program, so a layer that acquires a resource is
`Layer.effect` over `Effect.acquireRelease`.

A finding is cited as its area and number (`G1`, `N10`); the evidence, the
deletion list with consumer counts, and what each one gives up are in the
report.

## Where things stand on 2026-11-07

| Work                                     | State                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| R1–R5, R7, R8's first half               | landed, PR 14769; compromises in [PR 1's record](./2026-11-06-root-designs-pr1-compromises.md)                                       |
| The CLI service (R10's service side)     | landed, PRs 14771 and 14772 ([its note](./2026-11-06-cli-service-root-causes.md))                                                    |
| R10's "the client holds one `Session`"   | landed, PR 14772 (`CliRunReads`, `serviceRunReads`, `serviceRecords` gone)                                                           |
| `oneShot` as a read; six llm error kinds | landed, PRs 14774 and 14776; one platform-error unwrap, PR 14777                                                                     |
| R9, the model path                       | two loops (PR 14778) and the gate with `ScopedRef` (PR 14781) landed; the coordinator lock (PR 14782) in review; the credential next |
| Round 2, step 0 and 3.1                  | landed: I9 (PR 14783), G1 + I11 (PR 14784); M3 and N10 refused on investigation                                                      |
| R6, the view's three facts               | not started; `RUN_PHASE` 64 references, `durableOutcome` 30, `statusKey` 31                                                          |
| R10's hosts' verbs, exit code, drainer   | not started; `setExitCode` 22 references, `registerCliStateResetHook` 10                                                             |
| R8's second half                         | not started (rooted filesystems as one `SessionRoots`, `SessionViewService`, `Interactions`)                                         |
| PR 1 record §3 and §4, harness small     | not started, except `oneShot`                                                                                                        |

Lanes 2 to 9 are handed out in "Who takes what" below.

Open pull requests the order waits on:

- **14713** (a document task tells its chat what the user changed) edits
  `hostRunActions.ts`, `documentTools.ts` and `workflowOutput.ts`: G5, I1,
  I3, I4, I5 and I7 land after it.
- **14773** (programs, not agents, for the catalog and codemode) is set
  aside by the owner (2026-11-07). M4, M9 and H9, which its outcome could
  replace, are out of the order until the owner returns to it.
- **14777** (one unwrap of a platform error) landed 2026-11-07, so G10's
  error tags can join the storage-errors inventory now.
- **14741** (blob link kinds) touches only the store; nothing here waits.

Decided, not reopened here: every item marked "_Done 2026-11-06_" in
[storage errors and stop paths](../simplification/2026-11-03-storage-errors-and-stop-paths.md),
and PR 14777's kept distinctions (`isTransientHttpStatus` beside
`isRetryableStatus`, each package's plan wording, llm's own `causeChain`).

## What round 2 found: six decisions made in the wrong place

About ninety findings across the eight areas come from six decisions, each
made per module where one Effect value already answers it. The species are
round 1's; the places are new. Rule 7 of the root note ("a fact that lives in
this process lives in one Effect value") holds outside the core too.

| #   | The decision, as it should be                                                       | The primitive (4.1.2)                                                                                                     | Where it is broken today                                 |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| S1  | A request, a window or a subscription has one lifetime: its `Scope`                 | `Scope.addFinalizer`, `Effect.acquireRelease`, `Effect.forkIn(_, scope)`, `FiberMap`/`FiberHandle`/`FiberSet` per owner   | G1, G2, G7, I11, N9, N10, H1, H5, K5, K10                |
| S2  | A value that changes is one ref; readers subscribe, the latest wins                 | `SubscriptionRef` + `changes`, `Stream.switchMap`, `Stream.zipLatest`, `Stream.debounce`, `Stream.changes`, `Latch`       | G3, G6, M1, M9, H6, K1, K3, K6, N8, J1, J3, J5           |
| S3  | A process fact is served by a layer, not held in a module variable                  | `Layer.effect`, `Context.Reference`, `Effect.cachedWithTTL((exit) => …)`, `RcMap` with `idleTimeToLive`, `Cache.makeWith` | M2, M7, H10, K4, G11, I12; round 1's F7                  |
| S4  | A host-neutral flow is written once; a host owns one verb                           | one app body over a `Context.Service` per verb; `Layer.succeed` per present host service                                  | N1, N2, N3, N4, N10, G4, G5, K9, H8, H9; R10's extension |
| S5  | A fact is stored once and a grammar is spelled once                                 | one `Schema` (`TaggedUnion`, `TemplateLiteralParser`, `ReadonlyMap` with its `Iso`) and one owning table                  | I1, I2, I4, I5, H4, J4, J10, M3, M5, O1, O2, O6, I10     |
| S6  | A failure is typed at its boundary, not wrapped, cached as success, or checked late | the typed error channel, `Effect.catchTag`, `Effect.retry({ while, schedule })`, a failing `RcMap` lookup                 | I9, H3, M2, G10, I3, J2, I8                              |

The counts the acceptance below follows, at `24df986`:

| Package                  | `*Unsafe(`, `addObserver`, `uninterruptibleMask`, `Effect.uninterruptible`, `Effect.never` | module-level `let` |
| ------------------------ | ------------------------------------------------------------------------------------------ | ------------------ |
| `packages/harness/src`   | 69                                                                                         | 9                  |
| `packages/llm/src`       | 12                                                                                         | 0                  |
| `packages/texra/src`     | 49                                                                                         | 16                 |
| `packages/cli/src`       | 33                                                                                         | 16                 |
| `packages/extension/src` | 9                                                                                          | 4                  |
| `packages/desktop/src`   | 18                                                                                         | 14                 |

The root note's narrower metric (`*Unsafe(`, `addObserver`,
`uninterruptibleMask` in harness and llm) reads 60, down from 66 at
`ccf15b4`.

Not every call above is a defect: an `Effect.uninterruptible` around a
durable write and an `Effect.never` that holds a scope open are the primitive
used right. The reports name which are which; the count must fall, not reach
zero.

## The order

### Rules the order follows

1. **A small fix that changes behaviour goes first.** I9 is a latent defect
   rather than structure, and one PR (step 0). M3 was the other; it was
   refused on investigation (below).
2. **A root before what it replaces.** The root note's rule stands: no
   consolidation lands inside a model a root below replaces. G4, G5, N2, K5
   and K9's controller half are R10's; J7 is R6's; M8's tag side is R8's.
   They land inside those PRs, not before.
3. **A second implementation before a cleanup inside one.** Deleting a host's
   copy of a flow (S4) or a hand-rolled twin of a scope (S1) removes the most
   change amplification and the most fiber-fighting calls per line changed.
4. **An open PR's files after it merges.** 14713 and 14777 above.
5. **Few PRs: one per package, a second only where a step waits on another
   PR** (owner, 2026-11-07: PR count is the cost, not the safety). Each PR
   deletes the hand-rolled version of what it replaces (AGENTS.md "New ports,
   facades and template methods delete what they replace in the same PR"),
   and its body cites the finding ids it closes, one section per step, and
   the ones in its files it leaves, with why.

### Step 0: one small fix, any time

- **I9, a compile that succeeds without a PDF.** `compileLatex2Pdf`
  (`latex/texTools.ts`) answered `ok` on the engine's exit code; five of its
  seven callers trusted it and two checked the file their own way. One
  `fs.stat` inside its `Effect.fn` makes `ok` mean "a non-empty PDF exists";
  the callers' post-checks and the options schema decode go. Landed in
  PR 14783 (2026-11-07).

#### M3: refused on investigation

M3 proposed one owner for the environment a child process starts from, over
`inheritedEnv` (shell commands, agent CLIs), `serverEnv` (MCP servers) and
`makeMachineGitEnv` (plugin fetches, Overleaf clones), with the git helper
moved onto the project's `.env`. Checked against the tree on 2026-11-07, it
buys nothing and costs a hole:

- The two credential vocabularies leave no gap. All eleven names in
  `API_KEY_ENV_NAMES` match the MCP server's
  `/KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL/i`, so every credential the harness
  reads is already withheld from an MCP server. The only name one withholds
  and the other does not is `TEXRA_APPROVAL_POLICY`, which matters only to a
  nested texra.
- The machine git helper reads `process.env` on purpose. It runs at plugin
  install and Overleaf clone, outside any project's approval; a project's
  `.env` that set `GIT_SSH_COMMAND` (not in `GIT_UNSAFE_ENV_KEYS`) would run
  an arbitrary command there. Shell commands already see the project's
  `.env`, but they run under the run's approval policy.
- The owner kept shell commands' credential-shaped names (2026-11-07), so a
  shared policy would differ per kind of child anyway: the three functions
  are three policies, not one policy spelled three times.

Recorded as `RT-child-environment-one-owner` in
`.agents/docs/refuted-candidates.json`. New evidence that reopens it: a
credential the harness reads whose name the MCP regex misses, or a child
kind that should see a project's `.env` without running under approval.

### Lanes that run in parallel

Each lane is a sequence; lanes share no files, so several sessions can drive
them at once. A step is numbered lane.step (3.1 is lane 3's first step) and
lists the findings it closes and the primitive.

**Lane 1, the model path** (driver: the session that landed PRs 14778 and
14781).

1. R9, two loops. Landed in PR 14778.
2. R9, the gate as a `Latch` and a probe permit, `AgentRun.model` as a
   `ScopedRef` (landed in PR 14781); the coordinator as one `Semaphore(1)`
   (PR 14782, in review); the bearer on the credential (next).
3. O7, the sign-in flows: `Effect.scoped` over `Effect.acquireRelease` for the
   presenter in both flows, the detached launcher as a `Deferred`, the
   loopback's wait as `Effect.retry({ while, schedule })`; depends on step 2's
   coordinator.
4. O3, the subscription provider as one `Context.Service` per account
   provided by `Layer.effect`, its `WeakMap` memo and optional policy hooks
   deleted; depends on step 2.

**Lane 2, the view and the hosts' verbs** (package A; the largest lane).

1. **R6**, the view carries `position`, `outcome`, `holder`, `actions`; one
   app function maps them to words. J7 (three tone tables, two of which
   disagree) lands here. This step unblocks the rest of the lane.
2. **R10's hosts' verbs, exit code and drainer**, with G4 (`openGuiWindow`'s
   contract typed from four controllers' parameter lists, the thirteen-field
   bag), G5 (a refused launch presented from three sites, final output opened
   from two, three pass-through ports), N2 (binding tables carrying whole
   flows), K5 (the chat's exit decided in one place and run from three) and
   K9's controller half. After PR 14713 for `hostRunActions.ts`; one PR with
   step 2.3.
3. **R8's second half**, with M8 (platform ports carrying app facts as
   optional members; `WorkspaceRoots` restating `GlobalStorageFs` and
   `AppState` as fields).

**Lane 3, one lifetime per request and window** (package B; no root).

1. **The tool-edit preview: G1 + I11.** The request's `Scope` (the fiber
   `followPendingRequests`' `FiberMap.run` already gives it) is the only
   "finished": the temp files are finalizers of a child scope forked first,
   a preview's fiber is in the request's scope, and `Semaphore.make(1)` per
   entry is "one LaTeX operation at a time". Deletes `settled`, `isSettled`,
   `workspaceTempCleanup`, `latexOperationInProgress`, `registerCleanup` and
   one uninterruptible mask. Landed in PR 14784 (2026-11-07). The approval's masks and the
   `applied` Ref wait for R7. N10, one staging for both hosts, was refused
   on investigation (below).

   **N10: refused on investigation.** The two hosts differ exactly where the
   flow matters: the desktop stages each request in a temp directory of its
   own and reads the user's edits from the saved file, while VS Code stages
   into its storage directory and reads the unsaved editor buffer; an
   unapplied edit stays on disk beside the editor in the desktop, and moves
   to an untitled editor in VS Code before both copies go. The shared part,
   writing the two copies, is already one function
   (`writeApprovalTempFiles`). Moving the staging into the controller would
   make it know which files each host removes. What stays duplicated is two
   path getters and two spellings of the diff's title; the title could be
   one string in `ui/copy/toolEditPreview.ts` if the two hosts should show
   the same one. Recorded as `RT-tool-edit-staging-one-owner`.

2. **The host snapshot and onboarding: G3 + G6 + N3.** One
   `SubscriptionRef<HostSnapshot>` fed by `Stream.zipLatest` of the flag
   changes and the credential probe, `Stream.changes` before the `update`;
   the funnel is a field of it. Deletes the ten `let`s and the `publish`
   closure of `hostSnapshotSource`, the refresher's boolean and lane, the
   extension's second wiring of the funnel and the setup launch, and the
   cached credential answer.
3. **A window's session: N1 + N7.** One opener as `Layer.effect` over
   `Effect.acquireRelease`, built into the window's `Scope`, used by all three
   hosts; the desktop's open projects as `RcMap` keyed by root, so the
   bindings map, its hand diff, the `released` flag and the Symbol-keyed lane
   go.
4. **The settings view: G8 + J5 + J6, and N11's settings-frontend item.** One
   `SubscriptionRef<SettingsSnapshot>` the host updates; each page is
   `Stream.concat(Stream.make(void), changes)` into its build, so a mutation
   names no page. Sixteen pushed message kinds become one snapshot; the
   217-line dispatcher and its test-mode switch go; the frontend has one
   spelling of "not loaded".
5. **The webview transport: J1 + J2, then J3 + J4.** `RpcClient.make` over a
   protocol whose `send` is the host bridge's `postMessage` replaces the
   hand-rolled RPC, its in-flight Sets and the Promise surface layer; one
   `Rpc` per request kind carries its own success and error schemas, so the
   error is decoded once. Then the shell's three nullable fields become one
   `Schema.TaggedUnion` inside the surface `SubscriptionRef`, and the five
   per-run maps one `Schema.ReadonlyMap(RunIdSchema, RunSurfaceSchema)` with
   its `Iso`. **Check first:** `effect/rpc` in the webview bundle against the
   browser-bundle lint rule and the bundle budget.
6. **The desktop window and renderer: N9, N5, N4, N8.** `FiberHandle` with
   `onlyIfMissing` and a `Deferred` for the window's lifecycle; one `post` for
   the renderer with its failure surfaced, not a fallback "so tests work";
   one presenter as a `Context.Reference`; the editor pane's five generation
   counters as one `FiberHandle.run` per supersedable read.
7. **The progress view's surfaces and the session bridge: N6, G7, G2.** The
   two surfaces as a `FiberMap` keyed by surface; the bridge's requests in a
   `FiberSet` in its scope, closed by `awaitEmpty` under `Effect.timeout`; the
   process recorder as a `SubscriptionRef<Recording>` with a `FiberHandle`.

**Lane 4, plugins** (package C, but I8 + H10 are package F's; each PR stays
inside one plugin).

1. **GitHub: H1 + H2, then H3 + H4.** Subscriptions as `RcMap` keyed by
   target, a `PubSub` per entry and the poll fiber `Effect.forkScoped` in the
   entry's scope, so the two tables, `onKeysChanged`, `notes[]` and the
   `pollLoopStop` `Deferred` go; a tick commits one `Ref<State>` at its end,
   which deletes the staged-cache hand-off. Then the typed error channel
   instead of the `PollHookRejected` carrier unwrapped at four sites, and the
   target grammar as one `Schema.TaggedUnion` with one string codec.
2. **Lean: H5 + H7, then H6 and H8.** The pool on `LayerMap`'s own `RcMap`
   count with a lease in the run's `Scope`, which deletes the second refcount,
   the owners table and the module `WeakSet`; the roster derived from
   `RcMap.keys`; the per-file condition variable as a `SubscriptionRef` per
   file read with `Stream.takeUntil` and `Stream.debounce` under
   `Effect.timeout`; the port without optional host hooks.
3. **The document task's record: I5, I4, I1, then I2, I3, I7 and J9.** After
   PR 14713. The `r<N>` grammar as one
   `Schema.TemplateLiteralParser(['r', Schema.NumberFromString])` (eight sites
   today); documents reported once, by the fact row; then a revision's record
   as a value each step returns, not a map six modules write into, after
   which the lineage is one field and the compile outcome one `TaggedUnion`.
   The extraction ladder's decision stays pure TypeScript.
4. **LaTeX tools and arXiv: I6, I10, I8 + H10.** One latexdiff orchestrator
   failing with `Schema.TaggedError`s; the toolchain catalog as data rendered
   by one function, not prose parsed back; the arXiv download as
   `Stream.run(NodeSink.fromWritable(…))` under `Effect.timeout` with
   `Effect.retry({ while })` on the typed error, and its rate limit served by
   the plugin's `processLayer` (`effect/persistence`'s `RateLimiter` over
   `layerStoreMemory`) instead of a module `SynchronizedRef`.

**Lane 5, the harness's built-in tools** (package F).

1. M2: the MCP pool's failed start as a failing `RcMap` lookup (4.1.2 keeps a
   failed lookup's exit in the entry until it is released or invalidated),
   which deletes the `failed` Set and the success-shaped failure.
2. M1: `toolAvailability` as one `SubscriptionRef` per root and
   `Stream.switchMap` over the signal stream, which deletes the latest-wins
   lane scheduler, the refcount map and the Queue and Deferred relay.
3. M5 and M6: the `/executions` routes as one table column; the background
   shell's head and tail as a projection of its `process.output` rows.
4. M10: `utils/core/index.ts`'s barrel and the three modules with domain
   owners moved to them.
5. Set aside with PR 14773 (owner, 2026-11-07), not in the order: M4 (the
   plan tool reads its fact row, not its own past tool results), M9 (the
   catalog follower as one feed with `Stream.take(1)` for the first load),
   H9 (a plugin reaches its host one way).

**Lane 6, the terminal UI** (package D; 6.5 is package A's).

1. K1 + K2: the scrollback as one `SubscriptionRef<Scrollback>`, printed in
   the order of the view's own `settledRows` prefix, which deletes the three
   epochs, the render key, the scan cursor and the equivalence oracle.
2. K3: the typed message's five homes as one `SubscriptionRef<Draft>` and a
   `Latch` for "a model is connected".
3. K6, K8, K10: the status bar as `Stream.merge` of `Stream.tick` and the
   signal streams into `Stream.switchMap` of the read; the child list's focus
   read through the one `useStream` bridge; supersedable reads and pastes as
   `FiberHandle` and `FiberSet` in a mount-owned scope.
4. K7: one fitter with a policy field, pure.
5. K9's registry half, after step 2.2.

**Lane 7, llm providers** (package E, after lane 1).

1. O1 + O2 + O6: the route decision as one pure function over `RouteFacts`,
   reasoning controls as one table keyed by provider, "takes a document" as
   one capability the route's configuration writes. Measured by O9's "add an
   API-key provider" count.
2. O4: the Anthropic codec as a pure `(raw) => PartEvent` step under the one
   assembly reducer.
3. O5 and O8: no synthetic transport identity on the turn; the key lookup as
   one `Effect<{ value, origin }>`.

**Lane 8, sweeps by package** (package F; one PR per package).

1. S3, module-level facts: M7's eleven in the harness (two of them deciding
   the proxy policy differently), G11's and I12's in the app (H10's is step
   4.4's), K4's and round 1's F7 in the CLI (`registerCliStateResetHook`'s
   ten singletons), N11's in the desktop. `Context.Reference` for a defaulted value,
   `Effect.cachedWithTTL` with an `Exit`-computed lifetime for a probe,
   `Layer.effect` for a resource.
2. G9: `UsageLogService` as `Queue.sliding` into `Stream.groupedWithin` into
   `Effect.retry`.
3. G10's error tags nothing branches on (H3 is step 4.1's): the unread
   fields landed in #14786; one `HostFailed` for the host ports waits on
   packages A and B.

**Lane 9, harness small** (package E, after lane 7).

PR 1's record §3 and §4: one delivery-id shape, `USER_FOLLOW_UP_SUPPORT` as
a boolean, the awaited child's interruption through `RunRegistry.stop`, one
close deadline over the stop writes, a hold per agent-CLI turn,
`ProcessReport.failure` beside `exit`, `childEndReport`'s switch on kind,
`check-guidance-refs.mjs`'s `NOT_ROWS`. The root note's second-order items
the R9 driver does not take: hooks as one step value (E3), tool-schema union
flattening (E6), the script door's `Deferred` maps (E10), deletion's three
entry points (B9). The R9 driver folds in `openStep`'s mode (E9), `RunRows`
and `recordOf` (C10) and the script run's `handedDown` branches (E4) where
its files are open.

## Who takes what

The large lanes go to sessions of their own; the small items stay with the
session that wrote this note. A package below is one owner's for its whole
length, so two owners never hold one file. Each brief is enough to start
from: it names the steps, the findings with their reports, the files, what
waits on what, and when the package is done.

| Package                           | Steps                                 | Size       | Owner                                 | Starts                  |
| --------------------------------- | ------------------------------------- | ---------- | ------------------------------------- | ----------------------- |
| A. The view and the hosts' verbs  | 2.1, 2.2, 2.3; 6.5                    | largest    | a new session                         | now, with R6            |
| B. Lifetimes in the app and views | 3.2 to 3.7                            | large      | a new session                         | now                     |
| C. Plugins                        | 4.1, 4.2, 4.3, 4.4 (I6, I10)          | large      | a new session                         | now; 4.3 after PR 14713 |
| D. The terminal UI                | 6.1 to 6.4                            | medium     | a new session                         | now                     |
| E. The model path, then providers | lane 1, lane 7, lane 9                | large      | the R9 driver ("TeXRA pull requests") | already running         |
| F. Small items                    | lane 5; 8.2, 8.3; 4.4 (I8 + H10); 8.1 | small each | this session                          | #14786; 8.1 later       |

### What every owner follows

- **Read first:** root `AGENTS.md` and the nested guide of each package you
  touch; this note's lane; the round-2 report of each finding you take
  (`../../evidence/2026-11-06-design-red-flags-round-2/<area>-*.md`, the
  finding's section and the report's closing "Effect-native mapping"); for
  lane 2, the root it implements in
  [root designs, Effect-native](./2026-11-05-root-designs-effect-native.md).
- **Re-verify each finding on `main` before writing code.** Two of round 2's
  did not hold up (M3, N10, recorded above and in
  `.agents/docs/refuted-candidates.json`). One that does not hold is
  recorded the same way, not built. Check `refuted-candidates.json` before
  proposing anything in it.
- **Effect 4.1.2:** check every API in `node_modules/effect`'s `.d.ts`
  before using it. There is no `Layer.scoped`; `Layer.effect` already
  provides a `Scope`. `Scope.addFinalizer` on a closed scope runs the
  finalizer at once, and finalizers run in reverse order of addition.
- **Few PRs.** A package lands as one PR, or two where a step waits on
  another PR (the owner's ruling: PR count is the cost). Commit per step
  inside it, so a reviewer reads one step at a time. The body cites the
  finding ids each step closes, deletes the hand-rolled version in the same
  PR, fills the PR template (`Net elements (R6)` and `Consumer counts (R8)`
  for a simplify PR), and names any finding in its files that it leaves.
- **Tests:** zero new tests by default; a bug fix gets one regression test
  that fails first on the old code; a behaviour-preserving change adds none.
  Before a push: `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run test:changed`, `npm run check:fact-spread`,
  `node scripts/check-api-report.mjs`; `npm test` when the change reaches the
  session store or the run loop.
- **Identity:** commit as `Sirui Lu <14889516+LionSR@users.noreply.github.com>`
  or `Claude <noreply@anthropic.com>`, never a personal address; a squash's
  co-author lines come from the commits' authors.
- **Merging is the owner's.** Watch your PR, fix its CI and its review
  findings, and do not merge it unless the owner asks.
- **Coordination:** tell the R9 driver before touching
  `packages/llm/src/providers/credentials.ts`,
  `packages/harness/src/agent/runtime/modelAccess/` or
  `packages/llm/src/oauth/`. PR 14713 holds `hostRunActions.ts`,
  `ProgressWorkflowFileActionsController.ts`, `documentTools.ts` and
  `workflowOutput.ts` until it lands.

### A. The view and the hosts' verbs

- **Goal:** R6, then R10's hosts' half, then R8's second half, as the root
  note designs them.
- **First PR (2.1, R6):** `RunView` carries `position`, `outcome`, `holder`,
  `actions`; one app function maps them to word, tone, group and offers.
  Deletes `RUN_PHASE` (64 references on 2026-11-07), `statusKey` (31),
  `durableOutcome` (30), `isTerminalOutcomePhase`, `HISTORY_RUN_STATUS`,
  `cliRunStanding` and the rest of R6's list; J7's three tone tables go with
  it. Re-baselines three hosts' status snapshots and breaks the NDJSON
  `status` word (accepted in the root note).
- **Then (2.2, R10):** `createHostRunActions` as the one action body for all
  three hosts, the exit code as one function at the process edge, the NDJSON
  drainer as one bounded read, with G4, G5, N2, K5 and K9's controller half.
  **Then (2.3):** R8's second half with M8. **Last (6.5):** K9's registry
  half. **PRs:** two. R6 now; R10, R8's second half and K9's registry half
  together once R6 and PR 14713 have landed.
- **Files:** `packages/harness/src/shared/session/` (the view and its
  update), `packages/harness/src/shared/schemas/run.ts`, `packages/texra/src/ui/copy/`,
  `packages/texra/src/controllers/session/` (`openGuiWindow.ts`,
  `hostRunActions.ts`), the hosts' request handlers, `packages/cli/src/`'s
  run reads, exit code and progress drainer.
- **Leave to B:** `hostSnapshotSource.ts`, the onboarding funnel, the
  settings view, `SessionBridge.ts`. **Leave to D:** the TUI's panes and
  state stores.
- **Done when:** R6's, R10's and R8's deletion lists are gone or each
  leftover is named in a PR body; the fact-spread count shrinks on every
  step.

### B. Lifetimes in the app and views

- **Goal:** each request, window and subscription has one lifetime, its
  `Scope`; each changing value is one `SubscriptionRef`.
- **Steps, in order:** 3.2 (G3, G6, N3: one `SubscriptionRef<HostSnapshot>`
  fed by `Stream.zipLatest`), 3.4 (G8, J5, J6: one settings snapshot, no
  page named by a mutation), 3.6 (N9, N5, N4, N8: the desktop window and
  renderer), 3.7 (N6, G7, G2: the progress view's surfaces, the session
  bridge, the process recorder), 3.5 (J1 to J4: the webview transport),
  3.3 (N1, N7: one opener for a window's session). 3.3 last because R10
  (package A) also edits the hosts' window wiring: agree the order with A
  before it.
- **Check first for 3.5:** whether `effect/rpc` fits the webview bundle and
  the browser-bundle lint rule; if not, keep the framing and delete only the
  Promise layer and the in-flight Sets.
- **Files:** `packages/texra/src/controllers/` outside `session/hostRunActions.ts`
  and `openGuiWindow.ts`, `packages/texra/src/ui/progress/`,
  `packages/texra/src/shared/`, `packages/desktop/src/`,
  `packages/extension/src/progressView/` and `settingsView/`.
- **PRs:** one, with a commit per step.
- **Done when:** steps 3.2 to 3.7 have landed or been refused with a
  record, and the fiber-fighting count in `packages/texra/src`,
  `packages/desktop/src` and `packages/extension/src` (49, 18, 9 at
  `24df986`) has fallen.

### C. Plugins

- **Goal:** each plugin's state is one structure with one lifetime; each
  plugin PR stays inside that plugin.
- **Steps:** 4.1 GitHub (H1 + H2, then H3 + H4), 4.2 Lean (H5 + H7, then H6
  and H8), 4.3 the document task's record (I5, I4, I1, then I2, I3, I7 and
  J9; after PR 14713), 4.4's I6 (one latexdiff orchestrator) and I10 (the
  toolchain catalog as data).
- **Files:** `packages/texra/src/tools/github/`, `tools/lean/`,
  `tools/documents/`, `agent/output/`, `latex/latexdiff/`,
  `shared/constants/latexToolchain.ts`, and the Lean port's host halves in
  `packages/extension/src/frontend/lean/` and the desktop.
- **Leave to F:** `latex/arxivProcessor.ts` and `tools/arxiv/` (I8 + H10).
- **PRs:** two. GitHub, Lean, I6 and I10 now; the document task's record
  once PR 14713 has landed.
- **Done when:** the steps have landed or been refused with a record; H's
  23 `Deferred`s (15 in `leanServer.ts`) have mostly gone.

### D. The terminal UI

- **Goal:** the TUI holds each fact once, in a `SubscriptionRef` read
  through its one `useStream` bridge, and each supersedable read in a
  `FiberHandle`.
- **Steps:** 6.1 (K1 + K2: the scrollback in the view's own `settledRows`
  order), 6.2 (K3: the typed message's five homes as one draft), 6.3 (K6,
  K8, K10: the status bar on signal streams, the child list's focus, reads
  and pastes in mount-owned scopes), 6.4 (K7: one fitter). 6.5 is package
  A's, after R10.
- **Read first:** the repo's `texra-cli` skill (`.claude/skills/texra-cli/`).
- **Files:** `packages/cli/src/chat/tui/`. **Leave to A:** the chat
  controller's run reads, the exit path and the progress drainer.
- **PRs:** one, with a commit per step.
- **Done when:** the four steps have landed or been refused with a record,
  and the module-level `let`s in `packages/cli/src` (16 at `24df986`) that
  belong to the TUI are gone.

### E. The model path, then providers

Lane 1 (the credential PR, then O7 and O3), then lane 7 (O1, O2, O6, then
O4, O5, O8), then lane 9 (PR 1's record §3 and §4; E3, E6, E10, B9). The R9
driver holds `agent/runtime/` and `packages/llm/src/`; other packages ask it
before touching them.

### F. Small items (this session)

Done as one PR, #14786 (2026-11-07), after each finding was re-checked on
`main`:

- **Landed in #14786:** M5 (the route table's `kinds` column; the summary
  had listed `/executions/<id>/children`, which no route serves), H10 (the
  plugin's `RateLimiter`, a token bucket of one token per 3 seconds), G10's
  unread fields (`ExternalOpenFailed.kind`, `PromptFailed.member`,
  `TranscriptExportFailed.step`), and a false comment on `RcMap` failures.
- **Refused:** M2. `RcMap` has no read that does not acquire, so a root run
  sweeping its keys would wait on starts in flight and renew every idle
  server; the failed-key set stays. I8's parts: the `catchCause`/`failCause`
  pair keeps a cleanup defect a typed retry would drop, and `autoIndent`
  and a null `formatter` are two facts (a null formatter with indenting
  asked says formatting is off).
- **Not small, out of package F:** G9 (the usage log's close must try each
  queued batch once, warn at 5 s and not hold the process; the stream design
  gives no close), M1 (scheduling, publication and `refresh`'s wait together),
  G10's one `HostFailed` (it spans the hosts packages A and B edit), and
  I8's tar extraction as a stream (needs proof the writable's end covers the
  file writes). M6 was not reached.
- **Still package F's, later:** 8.1, the module-level facts, one package at a
  time after that package's owner has landed there; M10 last.

## Acceptance

- Every PR cites the finding ids it closes, deletes the hand-rolled version
  in the same PR, and names in its body any finding in its files it leaves.
- The counts in the table above fall per package with every step of lanes
  3, 4, 5, 6 and 8, and no PR raises one. The root note's narrower metric (60 at
  `24df986`) falls with lanes 1 and 5.
- Module-level `let` in `packages/texra/src`, `packages/cli/src` and
  `packages/desktop/src` (16, 16, 14) halves with lane 8.
- `npm run check:fact-spread` shrinks on every step of lanes 2 and 4.
- The change-amplification counts the reports name hold after the step that
  claims them; for example N10's "a third thing a preview stages", six sites
  to one, and I5's "rename the revision folder", eight files to one.
- The good modules each report names stay, among them: `runActionPolicy`,
  `decodeLaunchConfig`, `SessionFramer`, `Cache.makeWith` in
  `SubscriptionUsageService` (G); `prCheckRunDomain`, `DedupedResource`,
  `runLakeCommand` (H); `latexdiffVerbs`, `DOCUMENT_TASK_OPTIONS`,
  `assignByContentSimilarity` (I); `applySurfaceAction`, `ROW_FORMATTERS`,
  `webviewSessionLayer`'s `LayerMap`, `toSignal` (J); `formSlot`,
  `appLayout`, `DraftAttachmentStore`, `holdSignals` (K); `defineTool`, the
  spawner supervisor, `rootedFileSystem`, `jsonRpc`, `hookProtocol` (M);
  `desktopWindow`'s router, `desktopProjectRecords`, `requestAttention` (N);
  `assembleTurn`, `transport`'s `rejoin`, `resolveCredential`,
  `chooseReasoning` (O).

## What we give up, and risks

- **J1** puts `effect/rpc` in the webview bundle; if the bundle budget or the
  browser-bundle rule refuses it, the transport keeps its own framing and
  only the Promise layer and in-flight Sets go.
- **Steps 3.2, 3.4 and 2.2** rebuild what the three hosts render; each host's snapshot
  tests re-baseline in the PR that changes them.
- **Step 4.3** changes a persisted document fact's shape; a `rowVersions` bump and
  regenerated golden stores, no reader for the old shape.
- **R6** breaks the NDJSON `status` word `texra-action` reads (the root note
  accepted this).

## Findings by area

Each finding with its species and its place in the order; "—" is a batched
item a report lists without a lane. Full deletion lists are in the reports.

| Id  | Finding                                                                                     | Species | Step      |
| --- | ------------------------------------------------------------------------------------------- | ------- | --------- |
| G1  | the tool-edit preview fights its own scope: five `uninterruptible`, a `settled` Deferred    | S1      | landed    |
| G2  | the process recorder: two booleans, two Deferreds, a detached fiber, a listener Set         | S1, S2  | 3.7       |
| G3  | the host snapshot as a hand-written `SubscriptionRef`; capabilities as optional members     | S2      | 3.2       |
| G4  | `openGuiWindow`'s contract typed from four controllers; a thirteen-field bag                | S4      | 2.2       |
| G5  | `hostRunActions`: refused launch from three sites, output from two, pass-through ports      | S4      | 2.2       |
| G6  | the onboarding funnel as a boolean, a lane and a mutable `current`, its state three times   | S2      | 3.2       |
| G7  | `SessionBridge`: nullable replay fiber and queue, a scope `_tag` test, every request masked | S1      | 3.7       |
| G8  | the settings body repaints by hand; the host's name as a discriminator                      | S2, S4  | 3.4       |
| G9  | `UsageLogService`: an array queue, a dropping trigger, a boolean, a lane, once-flags        | S1      | 8.2       |
| G10 | `uiHosts.ts` 52% prose; nine error tags nothing branches on                                 | S6      | 8.3       |
| G11 | batched: process layer optionals, setup launch outcomes, module probe caches, …             | S3      | 8.1       |
| H1  | "run R subscribed to K" in two tables joined by a hand-off protocol                         | S1, S3  | 4.1       |
| H2  | a tick commits state piecemeal; a staged-cache hand-off                                     | S1      | 4.1       |
| H3  | a typed failure wrapped in a defect carrier, unwrapped at four sites                        | S6      | 4.1       |
| H4  | the target grammar in six modules; three registries per command                             | S5      | 4.1       |
| H5  | the Lean pool's second refcount, run-owners table, module "once per run" set                | S1, S3  | 4.2       |
| H6  | a per-file condition variable re-armed per notification                                     | S2      | 4.2       |
| H7  | the server roster as a second record of the pool, with a generation counter                 | S5      | 4.2       |
| H8  | the Lean port's optional host hooks; command rows one host answers with an error            | S4      | 4.2       |
| H9  | a plugin reaches its host six ways; a capability as a bare flag                             | S4      | held      |
| H10 | the arXiv rate limit as a module `SynchronizedRef`                                          | S3      | landed    |
| H11 | batched: two Zotero classifiers, a field-scan decision, two `AppSignals` paths, …           | —       | —         |
| I1  | a revision's record as a mutable map six modules write into                                 | S5      | 4.3       |
| I2  | an output's lineage as two fields flattened to one path, origin re-derived                  | S5      | 4.3       |
| I3  | the compile outcome in script variables, a sentinel path and three setting reads            | S6      | 4.3       |
| I4  | a task's documents reported twice; five compatibility defaults on persisted shapes          | S5      | 4.3       |
| I5  | the `r<N>` grammar at eight sites with two meanings                                         | S5      | 4.3       |
| I6  | two latexdiff orchestrators; a service as three one-use classes                             | S5      | 4.4       |
| I7  | the extraction ladder decides "which files may this reply name" twice                       | S5      | 4.3       |
| I8  | the arXiv download hand-joins a promise; a cause wrapper around `Effect.retry`              | S6      | 4.4       |
| I9  | `compileLatex2Pdf` reports success before the PDF exists                                    | S6      | landed    |
| I10 | the toolchain catalog's install advice as prose parsed back                                 | S5      | 4.4       |
| I11 | the LaTeX preview re-implements the request's scope                                         | S1      | landed    |
| I12 | batched: helpers, `applyFor`'s enum, `LatexTrace`, `taskFileSnapshots`'s `WeakMap`, …       | S3      | 8.1       |
| J1  | the webview transport as a hand-rolled RPC beside its own runtime                           | S2      | 3.5       |
| J2  | a response carries both kinds' outcomes; its error decoded and said twice                   | S6      | 3.5       |
| J3  | "what the shell shows" as three nullable fields                                             | S5      | 3.5       |
| J4  | per-run surface state as five parallel maps with a hand-written codec                       | S5      | 3.5       |
| J5  | sixteen pushed settings message kinds for one host record                                   | S2, S4  | 3.4       |
| J6  | two generic dispatchers, one with a test-mode switch                                        | S4      | 3.4       |
| J7  | the UI re-derives status from nine fields; three tone tables                                | R6      | 2.1       |
| J8  | `htmlBuilders.ts`: a sentinel icon, producers' vocabularies in the painter                  | S5      | after 2.1 |
| J9  | renderers that rebuild what the data model split                                            | S5      | 4.3       |
| J10 | `commandCatalog` membership columns its consumers' tables already state                     | S5      | —         |
| K1  | "what the terminal already shows" as three epochs, a render key, a cursor, an oracle        | S2      | 6.1       |
| K2  | the TUI prints the settled prefix in a second order and checks the two agree                | S5      | 6.1       |
| K3  | the typed message has five homes                                                            | S2      | 6.2       |
| K4  | the runtime install and platform init as memoized singletons and a refusing stand-in        | S3      | 8.1       |
| K5  | the chat's exit decided in `leave` and run from three places                                | S1      | 2.2       |
| K6  | the status bar polls two facts on timers and a hand-bumped version                          | S2      | 6.3       |
| K7  | two fitting algorithms; "never drop" as a priority number                                   | S5      | 6.4       |
| K8  | the child list's focus as a reducer reconciled during render                                | S2      | 6.3       |
| K9  | the slash-command registry: a global table from a 21-field bag of optional callbacks        | S4      | 2.2, 6.5  |
| K10 | "which read is current" hand-rolled per site: counters, `interruptUnsafe`, once-flags       | S1      | 6.3       |
| K11 | batched                                                                                     | —       | —         |
| M1  | `toolAvailability`'s latest-wins scheduler, refcount and signal relay                       | S2      | 5.2       |
| M2  | the MCP pool caches a failed start as a success and remembers it in a Set                   | S3, S6  | refused   |
| M3  | a child process's environment decided in four modules, two vocabularies                     | S5      | refused   |
| M4  | the plan tool decodes its own past results to find its goal                                 | S5      | held      |
| M5  | `/executions` paths per run kind spelled three times                                        | S5      | landed    |
| M6  | the background shell's in-memory capture beside its `process.output` rows                   | S5      | 5.3       |
| M7  | eleven process facts in module `let`s; two proxy policies                                   | S3      | 8.1       |
| M8  | platform ports carry app facts as optionals; `WorkspaceRoots` restates services             | S4      | 2.3       |
| M9  | the catalog follower's three subscriptions and a readiness Deferred                         | S2      | held      |
| M10 | `utils/` holds domain modules; `utils/core/index.ts` a three-topic barrel                   | —       | 5.4       |
| M11 | batched: `JsonStore`'s one-caller options, `FileSecrets.watch`, …                           | S2      | —         |
| N1  | "open a window's session" written by all three hosts                                        | S4      | 3.3       |
| N2  | binding tables carry whole flows where the host owns one verb                               | S4      | 2.2       |
| N3  | the onboarding funnel and the setup launch wired twice; a third credential cache            | S4      | 3.2       |
| N4  | the desktop builds every window port twice to decide "present or not"                       | S4      | 3.6       |
| N5  | renderer reachability as a tri-state optional with a fallback for tests                     | S6      | 3.6       |
| N6  | the progress view's two surfaces as four optional fields and a callback                     | S1      | 3.7       |
| N7  | open projects: a persisted list read four times, a Symbol lane, a hand-diffed map           | S3      | 3.3       |
| N8  | the editor pane's five generation counters and a promise lane                               | S2      | 3.6       |
| N9  | the desktop window's lifecycle as three optionals beside a FiberSet and a Semaphore         | S1      | 3.6       |
| N10 | tool-edit staging implemented twice, down to the preview class                              | S4      | refused   |
| N11 | batched: settings frontend's "not loaded" ×3, trace viewer, logs poll, …                    | S2, S3  | 3.4, 8.1  |
| O1  | the route decided in three steps the harness sequences; the endpoint in three constants     | S5      | 7.1       |
| O2  | reasoning controls decided in `models/` and in each `api/` row                              | S5      | 7.1       |
| O3  | a subscription provider as a one-implementation port memoized in a `WeakMap`                | S3, S4  | 1.4       |
| O4  | the Anthropic codec keeps its own position state beside the assembly's                      | S5      | 7.2       |
| O5  | a synthetic transport identity on the turn, patched back by the harness                     | S5      | 7.3       |
| O6  | "this route takes a document" decided by the harness and by llm                             | S5      | 7.1       |
| O7  | the sign-in flows fight the fiber model                                                     | S1      | 1.3       |
| O8  | the API-key lookup as four projections; its origin re-spelled as a status                   | S5      | 7.3       |
| O9  | batched; "add a provider" touches five files                                                | S5      | 7.1       |
