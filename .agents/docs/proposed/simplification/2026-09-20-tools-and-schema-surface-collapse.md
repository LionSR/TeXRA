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
   charter. The barrel stays a published surface; it shrinks.
2. One dependency-probe catalog in `externalToolDefs` plus `toolAvailability`;
   the other four spellings, their sync comments and the completeness test go
   (400 to 600 lines). The per-host Lean capability read and the CLI doctor's
   rendering stay.
3. One `run.fact` row and one `state.value.set` row; delete eight schema
   arms, four name lists, `runFactEvents.ts`, the `Database.ts` branch chain
   and the five readers (250 to 400 lines). Bump `SESSION_EVENT_FORMAT`; there
   is no legacy reader to migrate.
4. `ExecutionsTool` renders text from the fold; keep `wait` and `kill`
   (500 to 700 lines).
5. Derive the replacement-category universe from the registry; rename the
   colliding type pairs (about 150 lines). The two ordered apply lists stay,
   because order is behavior.
6. Delete `core/define.ts` and inline the `execute` forwarder; make path and
   bash approval one loop-side guard the tool declares rather than calls.
7. Move the fourteen module-global registries into the services they belong
   to (session or process scope), one PR per subsystem.

## 3. Feature-scope questions, not layering

The ten-tool, 1 513-line `setup/` family is one agent's private tool surface
carried in the global registry and in `RegisteredToolName`. GitHub polling is
5 248 lines, 14 percent of `src/tools`, for three pollers. Both are product
decisions for the owner; neither is fixed by a refactor.

## 4. Acceptance

- No webview bundle includes `stateSettings.ts`.
- One `CORE_LATEX_TOOLS` spelling in the tree; no "kept in sync" comment.
- `sessionEvent.ts` has no `updateTodos` arm; `runRecords.ts` has one
  latest-row reader.
- The tool-call path has five layers; `core/define.ts` is gone.
- `src/tools` has no module-level `Map` or `Set` that outlives a session.
