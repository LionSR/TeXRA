# Consolidation and natives: what the 2026-11-26 audit left open

Date: 2026-11-26
Status: proposed

Origin: the scheduled audit for duplicated logic and hand-written versions
of what the standard library or Effect provide. Three read-only surveys
(the harness and llm; the app and hosts; scripts, config and test support),
each leaving out the files the open PRs #15216, #15229 and #15230 touch.
These landed in the PR that adds this note:

- `absentWhenInvalid` beside `NonEmptyJwtClaim`, for seven written-out
  copies of "an optional OAuth field of another shape reads as absent", and
  one `PositiveSeconds` for the two xAI lifetimes
- `Schedule.min([exponential, spaced(cap)])` at four backoffs that capped
  the delay with `modifyDelay` and `Duration.min`, as the service link's
  reconnect schedule already did
- `appendHead` at seven cuts that sliced by code unit and could leave half a
  surrogate pair in a stored row or a model's context;
  `truncateSummary` for the context tool's preview
- `Record.map` and `Record.filter` for two hand-built entry rewrites
- `optionalInput` for the eight optional fields of the Zotero search and
  export tools
- one `firstLine` for a script stage's summary and a hook's stderr
- `Order.String` and `pluralize` at one inline copy each
- `dynamicValueFlags` in the completion command tree, read by the bash and
  fish writers, which each built the same first-flag-per-name map
- `createPathToolbar` for the desktop editor and PDF panes
- the suites' `REPO_ROOT` in the guidance-reference suite, and
  `realpathSync.native` in `FakePlatform`, whose comment names the Windows
  short name that only the native form expands

## Open

1. **The validation scripts repeat each other.**
   `packages/cli/scripts/validate-run.mjs` and `generate-golden-store.mjs`
   each hold the provider key list and the fake key, the validation-model
   child environment (four copies), the two-step validation bundle build,
   the node-pty loader (a third copy in `validate-tui.mjs`) and "find the
   project store by its directory prefix" (eight copies). `validate-run.mjs`
   also has three inline poll loops beside its own `waitFor`, and two
   `spawnSync('find', …)` calls where `fs.globSync` works on every platform.
   Both files are held by #15229. After it lands: one
   `packages/cli/scripts/validationAgent.mjs` owner for the key list, the
   child environment and the bundle build; `waitFor` returning what its
   check found; `projectStore(root, prefix)`.
   **Landed 2026-11-27**, except the child environment: see the 2026-11-27
   run in
   [`2026-11-23-hand-written-code-a-package-covers-left-open.md`](2026-11-23-hand-written-code-a-package-covers-left-open.md).
2. **Tool inputs in files the open PRs hold.** `ZoteroAddTool.ts` (eleven
   fields) and `ZoteroCollectionsTool.ts` (two) write
   `Schema.optional(Schema.NullOr(S.annotate({ description })))` where
   `optionalInput` is the owner. The description moves from the inner schema
   to the field, which is where the other tools put it.
3. **A settings-view row is fetched and checked three times.**
   `settingsState.ts`, `PluginsTab.ts` and `placedRow` in
   `stateSettingRows.ts` each call `TEXRA_SETTINGS.settingsViewByKey` and
   throw the same error. The owner is `texraSettings.ts`, which #15229
   holds: a throwing `settingsViewRow(key)` there.
4. **The interactive-terminal rejection is assembled at four call sites**
   (`chat.ts`, `setup.ts`, `resumeRun.ts` twice): `interactiveTerminalFailure`
   then `formatInteractiveTerminalFailure`, which has no other caller. One
   function returning the message in `terminalRequirements.ts`; two of the
   three files are held. `resumeRun.ts` also writes the non-usage branch of
   its own `resumeFailureExit` inline twice.
   **Landed 2026-11-26 evening:** `interactiveTerminalRejection` returns
   the message, and both load failures take `resumeFailureExit`.
5. **A forwarded `--` is handled three ways in scripts.** Six scripts drop
   every `--` from `process.argv`, two drop a leading one, and nine that
   call `parseArgs` handle none, so `pnpm run <script> -- --flag` reads the
   flag as a positional. Not checked: which of the nine are ever run with
   forwarded flags.
6. **Tests.** The signal-wait `until` is byte-identical in
   `TuiApprovalRetry.vitest.ts` and `chatSessionController.vitest.ts` (the
   second is held), and `rowsOf(rows, runId, type)` is written in four
   suites; `src/test-kernel/support/storeFaults.ts` already owns
   `storedRows`.
7. Items 1 and 2 of the 2026-11-25 note (the chat export's file name, the
   settings select row) are unchanged, as are the `ifCurrent` comparison,
   the home directory and the timestamp format of the 2026-11-23 note.

## Checked and declined

- **`appendHead` in `logger/logSink.ts` and `logger/effectDiagnostics.ts`.**
  `logger/` is the bottom layer and imports nothing in the harness; its two
  cuts stay code-unit slices.
- **`Record.filter` over a struct with optional keys**
  (`anthropicMessages.ts` usage counters, `fillModelError`). The same
  refusal as `Record.isEmptyRecord` in the 2026-11-23 note: a type with
  optional keys is not assignable to `ReadonlyRecord`. `redactFields` and
  `renameRefShaped` take an `object` and would need a cast.
- **`localeCompare` sorts as `Order.String`** (seven sites in the harness).
  The order changes: `localeCompare` follows the locale, `Order.String`
  compares code units.
- **`Array.partition` for a pair of opposite `filter` calls.** In Effect 4
  it takes a function returning a `Result`, not a predicate.
- **`Num.sumAll` and `Array.countBy` for the remaining `reduce` and counting
  loops** (about nine sites). Each rewrite is the same length as the loop.
- **`Stream.fromAsyncIterable` for `sdkStream`
  (`packages/llm/src/api/transport.ts`).** `sdkStream` aborts the request
  before the iterator's `return()` and turns a rejected `return()` into a
  defect; Effect's swallows it.
- **`normalizeLineEndings` in `ToolEditApprovalController.ts`.** It also
  turns a lone CR into LF, and that text is compared with the editor's.
- **`getBasename` in `mimeUtils.ts`.** It returns `to` for `/path/to/`,
  where the extension lookup needs the empty name.
- **One `stringField`/`numberField` for `failureReply.ts` and
  `planUsage.ts`.** One trims and accepts a number as text; the other does
  neither.
- **A frame-coalescing helper for the three `requestAnimationFrame` guards
  in the desktop renderer.** Each guard is mixed with the caller's own
  conditions; the helper adds a file and removes about as many lines.
- **`SessionUiEvents.launch(patch)`.** The three private methods it would
  replace are each one line with several callers in their class.
- **A base class for `SessionDrawer` and `ToolsSheet`.** Two components,
  and the shared part is the drawer's open-and-forget lifecycle, which Lit
  mixes poorly through inheritance.
- **`import.meta.dirname` in `packages/harness/scripts/bundle.mjs`.** The
  file still needs `fileURLToPath` for the QuickJS module.
