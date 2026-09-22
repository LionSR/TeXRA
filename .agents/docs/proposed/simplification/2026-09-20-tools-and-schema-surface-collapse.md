# Tools and schema-surface collapse

Date: 2026-09-20
Status: proposed
Baseline: `main` at `3378a967`. Parent survey:
[post-refactor architecture survey](../architecture/2026-09-20-post-refactor-architecture-survey.md).
Closes the still-open rows of the 2026-09-10
[collapse duplicate concepts](../architecture/2026-09-10-collapse-duplicate-concepts.md)
census that fall in this territory; families C, D and E of that note are
already closed or owned elsewhere and are not restated.

## 1. Findings

**The barrel.** `sharedSchemasDeepImportRatchet` forbids every
`@shared/schemas/<leaf>` import, so 811 files import a 60-module,
9 510-line barrel. About 3.5k lines of it are not wire contracts:
`stateSettings.ts` (1 581), `settingsViewMessages.ts` (951),
`memoryViewMessages`, `profileViewMessages`, `mainView/`, `progressView/`.
They ride into every closure, webviews included. Separately, `src/shared`
carries ~10k lines of UI toolkit (`wa/`, `styles/`, `transcript/`,
`markdown/`, `copy/`) under a directory CLAUDE.md defines as "wire contracts
and UI-shared message types".

**The tool-call path.** Seven layers from model output to tool body
(`run/tools.ts` parse and dispatch facts, registry lookup, `BaseTool.call`,
`ToolCall` context provision, `DefinedTool.execute`, body). Two are pure
pass-through: `core/define.ts` (27 lines that only re-type `defineTool`) and
the `execute` forwarder in `core/definition.ts`. Approval and path guards are
not loop layers; nine tools call `resolveWorkspaceRelativePath` and
`assertWritable` themselves, four call `requestBashApproval`, and three
thread `requestApproval` as a constructor seam purely for tests.

**Module-global state.** Fourteen mutable module-level registries or caches
in `src/tools` (`github/subscriptionBindings.ts`, `lean/leanServerRegistry.ts`,
`registry.ts`, `nativeSubagentStrategy.ts`, `support/rateLimiter.ts`,
`codexConfig.ts`, `InlineCommentTool.ts`, and others).

**Restated lists.** The LaTeX and image tool probe is spelled five times
(`tools/setup/toolProbing.ts`, `controllers/settingsView/LatexToolingController.ts`,
`latex/latexToolchain.ts` with a "kept in sync" comment, the CLI `doctor.ts`,
`externalToolDefs.ts`). The five run-fact row names are restated in four
places (`sessionEvent.ts`, `trace/events.ts`, `runtime/runFactEvents.ts`,
`runStateFold.ts`). The replacement-category universe is declared three
times and reconciled by a completeness test, with two colliding type names
resolved by import aliasing.

**Rows.** Of 35 `SessionEvent` row types none is orphaned, but five run-fact
rows (`updateTodos`, `updatePlan`, `addOutputFiles`, `updateMissingOutputs`,
`updateCompileFailures`) are one row with a discriminator, three singleton
records (`desktop.projects.changed`, `inquiry.recorded`,
`update.check.recorded`) are one `state.value.set`, and five `run.*` record
rows have five near-identical latest-row readers in `runRecords.ts` and a
hand-rolled per-type branch chain in `Database.ts`.

**`ExecutionsTool`** (1 141 lines plus `executions/` 946 and formatters 356)
re-derives liveness, pagination and summaries that `SessionView` already
folds.

## 2. Changes

1. Split the non-contract half out of `@shared/schemas` into its own
   surfaces; move the UI toolkit out of `src/shared` or rename the directory's
   charter. The barrel stays a published surface; it shrinks. The settings
   webview consumes the catalog on purpose (`settingEnumChoices`,
   `settingsViewSettingByKey` from `stateSettings.ts`) and keeps it; the
   gain is for the progress, memory and profile views, which do not.
2. One dependency-probe catalog in `externalToolDefs` plus `toolAvailability`.
   The four other spellings are not interchangeable projections of it, so
   the catalog grows their semantics first: `externalToolDefs` deliberately
   carries no system LaTeX dependency except `texcount`, so it gains the
   LaTeX and image entries; each entry records per consumer whether it is
   required or an alternative, so the doctor keeps its compiler and
   bibliography alternates (`xelatex`, `lualatex`, `bibtex`, `biber`) and its
   `latexmk` required row that sets the CLI exit code (the stated residual in
   `latexToolchain.ts`), and the settings probe keeps Ghostscript plus either
   image tool as one capability. Only then do the four spellings, their sync
   comments and the completeness test go (400 to 600 lines). The per-host
   Lean capability read and the CLI doctor's rendering stay.
3. One `run.fact` row and one `state.value.set` row; delete eight schema
   arms, four name lists, `runFactEvents.ts`, the `Database.ts` branch chain
   and the five readers (250 to 400 lines). Bump `SESSION_EVENT_FORMAT`; there
   is no legacy reader to migrate. The collapsed rows keep a discriminator
   that ties each key family to its existing Zod value schema and aggregate
   kind, so a desktop-projects value cannot be committed under the inquiry
   aggregate and corruption is still caught at the database parse boundary.
   The cold-start listing (`READ_LISTING` and the run-record query in
   `Database.ts`) selects `MAX(seq)` per `(aggregate_id, type)`, so one
   stored `run.fact` type would keep only the most recent fact per run;
   the query groups by the discriminator as well, or each row carries the
   complete combined fact state, before the distinct types go.
4. `ExecutionsTool` renders text from the fold; keep `wait` and `kill`
   (500 to 700 lines).
5. Derive the replacement-category universe from the registry; rename the
   colliding type pairs (about 150 lines). The two ordered apply lists stay,
   because order is behavior.
6. Inline the `execute` forwarder (landed, #12891); make path and bash
   approval one loop-side guard the tool declares rather than calls.
   Deleting `core/define.ts` is refuted, on the evidence of that same PR: it
   is not a pass-through but the fence that keeps `ToolServices` off the
   SDK's published surface. `packages/agent/src/index.ts` exports
   `defineTool` from `@tools/core/definition`, and
   `packages/agent/scripts/validate-artifacts.mjs` walks each published
   entry's whole declaration graph, so moving the `R = ToolServices` default
   onto `defineTool` itself makes `definition.d.ts` import `ToolServices` ->
   `ToolCall` -> `AgentWorkspaceState` -> `ServerTools` ->
   `@anthropic-ai/sdk` and the agent build fails the provider-leak check.
   The specialization has to live in a module the SDK entry does not reach,
   which is what `define.ts` is.
7. Move the module-global mutable ownership state into session- or
   process-scoped services, one PR per subsystem: the Lean server map in
   `leanServerRegistry.ts`, the agent-engine slot (only after the #12888
   ruling admits a tag; not actionable before it), the inline-comment
   provider slot, the Codex config slots and the GitHub subscription
   bindings. The lazy memos of immutable tables (`registry.ts`), the
   class-shaped `toolAvailability` cache, the per-API rate limiters and the
   once-warn latches are intentional process caches and stay; the
   service-scope ledger records them as such.

## 3. Feature-scope questions, not layering

The ten-tool, 1 513-line `setup/` family is one agent's private tool surface
carried in the global registry and in `RegisteredToolName`. GitHub polling is
5 248 lines, 14 percent of `src/tools`, for three pollers. Both are product
decisions for the owner; neither is fixed by a refactor.

## 4. Acceptance

- No webview other than the settings view includes `stateSettings.ts`.
- One `CORE_LATEX_TOOLS` spelling in the tree; no "kept in sync" comment;
  `texra doctor`'s exit code and the settings status fields are unchanged on
  every machine configuration.
- `sessionEvent.ts` has no `updateTodos` arm; `runRecords.ts` has one
  latest-row reader.
- The tool-call path has five layers; `core/define.ts` stays (step 6).
- `src/tools` has no module-level mutable ownership state; the surviving
  memo caches are listed by name in the ledger.

## 5. Landed

Re-checked against the current tree (2026-09-22). Most of the plan above has
already shipped, in smaller PRs that never came back to update this note:

- **Step 1 (barrel).** The UI toolkit (`wa/`, `styles/`, `transcript/`,
  `markdown/`, `copy/`) moved out to `src/ui/`, as CLAUDE.md now documents.
  `stateSettings.ts`, `settingsViewMessages.ts`, `memoryViewMessages.ts` and
  `profileViewMessages.ts` are no longer exported from
  `src/shared/schemas/index.ts` — they live in `src/shared/state/` and
  `src/shared/settingsView/` as standalone modules. `stateSettings.ts` has
  around two dozen importers tree-wide (backend config plumbing, the CLI's
  own settings forms, tests), but no webview other than the settings view
  frontend (`LaTeXTab.ts`, `GitTab.ts`, `AIAgentsTab.ts`, `settingsState.ts`,
  `stateSettingRows.ts`) is among them — the first Acceptance bullet, as
  written, holds. `src/shared/schemas/` is down to ~6.9k lines
  (from the ~9.5k cited above); `mainView/` and `progressView/` remain, as
  wire-contract state for those views rather than settings surface.
- **Step 2 (LaTeX/image probe).** One catalog, `LATEX_TOOLS` in
  `@shared/constants/latexToolchain`, consumed by `@latex/latexToolchain`,
  `@tools/setup/toolProbing`, `@controllers/settingsView/LatexToolingController`
  and the CLI doctor (`@latex/latexToolchain` → `probeLatexToolchain`) — four
  of the five spellings §1's Findings named are one now. No "kept in sync"
  comment remains anywhere in the tree. The per-consumer roles (doctor
  required/optional, probe required/image, `drivesCompile`) landed as
  designed, including the stated `latexmk` residual.

  The fifth spelling §1 named, `externalToolDefs`, still declares and probes
  `texcount` on its own (`checkToolInstalled('texcount', false)`, the same
  call `LATEX_TOOLS`-derived consumers make for it) — as designed, not left
  over: §2's own step 2 said `externalToolDefs` would "carr[y] no system
  LaTeX dependency except texcount" going in, because `texcount` is also a
  registered agent tool (`tools: ['texcount']`) needing a Tools-dashboard
  availability entry no other `LATEX_TOOLS` consumer needs. Both call sites
  read the identical primitive, so there is no restated _list_ to drift,
  only one boolean check reached from two registries for two purposes.

  Not one of §1's five, but flagged as a sixth un-consolidated spelling by an
  earlier pass of this note: `checkCoreDependencies`
  (`src/utils/system/checkCoreDependencies.ts`), which then hardcoded
  `['latexindent', 'perl', 'gs']` rather than reading the catalog. That was
  true when written (#12994) but landed independently in the meantime
  (`#12962`, before this note could be updated): the function now iterates
  `CORE_DEPENDENCY_TOOLS`, itself derived from `LATEX_TOOLS` via each entry's
  `core?: true` flag, and the catalog's own docstring now lists
  `checkCoreDependencies` as the fourth of "four surfaces" that read it — not
  a missed one. Corrected here rather than left stale, per a review catch on
  this note's own PR (#13022).

- **Step 3 (rows).** `sessionEvent.ts` has a single `run.fact` row
  (discriminated by `fact.key`) and a single `state.value.set` row;
  `updateTodos`/`updatePlan`/`addOutputFiles`/`updateMissingOutputs`/
  `updateCompileFailures` and the three singleton record types no longer
  exist as separate schema arms. `runFactEvents.ts` is gone.
  `src/agent/storage/runRecords.ts` has no restated latest-row readers.
- **Step 4 (`ExecutionsTool`), mostly, corrected on a review catch.** Its own
  module docstring now states the invariant directly: "every fact about a
  run... is read off the session fold (`SessionView`)... this surface never
  resolves liveness, parentage or a task list a second time." One documented
  exception the docstring doesn't cover: `/report` and `/result`
  (`showReport`/`showResultMeta`, `ExecutionsTool.ts:559-596`) call
  `turnAttributionNote`, which calls `resolveRunLiveness`
  (`executions/runLiveness.ts`) — a second read against `Runs`, the run-end
  row and claim ownership, not the fold. An earlier pass of this note
  claimed the fold carries no reason string for the unsettled/interrupted
  cases, which is wrong and was caught on review: `RunView.statusDetail`
  (`sessionView.ts`) is filled by `withAggregates`
  (`sessionFold.ts`) with `runInterruptedMessage()` or
  `runHeldMessage(ownerPid(heldBy))` for exactly the interrupted and
  foreign-held cases `resolveRunLiveness` also names. The one case the fold's
  `statusDetail` does not cover is narrower: this process holding the run's
  claim with no tracked handle and no recorded outcome — the anomaly
  `resolveRunLiveness` calls `OWNED_HERE_REASON` and logs as a leak, which
  the fold's `own` branch instead folds into ordinary "held," no detail
  attached. Whether that narrow gap justifies a second full liveness read
  (rather than, say, the fold flagging that one anomaly too) is not settled
  by this note.
- **Step 5 (replacement categories).** `NON_REGEX_REPLACEMENT_CATEGORIES` /
  `REGEX_REPLACEMENT_CATEGORIES` in
  `@shared/constants/replacementCategories` are the one declaration;
  `@replacement/engine` keys its rule tables off them so a name with no
  rules fails to typecheck, exactly as proposed.
- **Step 6.** The `execute` forwarder inlined (#12891, as already noted
  above); `core/define.ts` stays, per the ruling already recorded in this
  step.
- **Step 7 (module-global state), partially.** The Lean server roster
  (`leanServerRegistry.ts`) is now a per-adapter factory
  (`createLeanServerRoster`) rather than a module map. GitHub subscription
  bindings (`GitHubSubscriptions`) and the inline-comment provider
  (`InlineComments`) are both `Context.Service` tags resolved from process
  scope, not module slots.

## 6. Still open

- **Step 4, the turn-attribution liveness read.** `/report` and `/result`
  resolve a run's liveness a second time via `resolveRunLiveness` rather than
  reading it off `SessionView`, contradicting the "never... a second time"
  reading of the module docstring if taken to cover every codepath. The fold
  already carries a reason string for the interrupted and foreign-held cases
  (`RunView.statusDetail`); the real gap is narrower — one anomalous case
  (this process's own orphaned claim) the fold doesn't flag. See §5 Step 4
  for detail.
- **Step 7, the agent-engine slot.** `src/tools/delegation/nativeSubagentStrategy.ts`
  still holds `let agentEngine: AgentEngine | undefined;` at module scope —
  unchanged, and still correctly gated on the #12888 ruling as stated above.
- **Step 7, the remaining slots.** The Codex config module
  (`src/tools/codexConfig.ts`) now reads settings entirely through
  `StateStore`/`createEnumStateGetter`; its only module-level state is an
  xhigh-capability probe cache keyed by binary path
  (`codexXhighSupportByBinary`, `codexXhighProbeLanes`), which reads as the
  kind of lazy memo of an immutable fact this step's own carve-out says
  should stay, not the mutable "config slot" this step meant to move. Not
  independently reverified this pass: `registry.ts`'s memo cache and
  `support/rateLimiter.ts` staying as intentional (they were already ruled
  to stay); whether the service-scope ledger lists the survivors by name;
  the tool-call-path's five-layer count and the setup/GitHub-polling
  feature-scope questions in §3, which are unchanged product questions, not
  layering.
- Steps 1–6 above are re-verified against the tree but not exhaustively —
  e.g. the exact "400 to 600 lines" / "250 to 400 lines" savings estimates
  in §2 were not re-measured, only the structural claims (one spelling, no
  duplicate schema arms, one reader).
