# Consolidation and natives: what the 2026-11-28 audit left open

Date: 2026-11-28
Status: proposed

Origin: the scheduled audit for duplicated logic and hand-written versions
of what the standard library or Effect provide. Three read-only surveys
(the harness and llm; the app and hosts; scripts, config and test support),
each told to skip what the 2026-11-23 to 2026-11-27 notes landed, left open
or declined. All three report the same thing: mechanical scans for repeated
text, identical function bodies and the usual native swaps (`toSorted`,
`.at()`, `Object.groupBy`, `node:timers/promises`, `parseArgs`,
`import.meta.dirname`) find the tree already on its owners and on the
natives. What is left is small owner bypasses. These landed in the PR that
adds this note:

- `ValuesChange` for the read-modify-write callback that `StateStore.modify`,
  `CurrentValues.modify` and their three implementations each wrote out
  (the first half of item 4 of the 2026-11-27 note)
- `TEXRA_SETTINGS.settingsViewRow`, the throwing lookup the settings signals
  and the row renderers each wrote (item 3 of the 2026-11-26 note)
- the signal-0 liveness check: two harness suites take `processRunning`, and
  the service script's Windows branch, the run validator and a desktop e2e
  spec take `processExists` from `scripts/texra-services.mjs`
- `sha256` where `pluginDigest.ts` and `runOwnership.ts` stringified and
  then hashed; `UtilizationSchema` at its two inline copies
- `projectStore` in `validationAgent.mjs`, read by the run validator and the
  golden store; the signed builder config reads its base file by URL
- `messageTimestamp` for the `<time>` three message renderers built by hand
- `clampListIndex` beside `nextListIndex`, for `Select`, the slash palette
  and `nextListIndex` itself
- `formatResultCount` at thirteen count-and-noun templates,
  `Predicate.isNotUndefined` at two filters and `Str.uncapitalize` at one
  hand-written lowercase-first

## Open

Items 1, 2, 3 and 6 of the 2026-11-27 note are unchanged: each waits on the
decision that note names.

1. **The CLI bundle build is spawned by hand in four validation scripts.**
   `buildValidationCli` (`packages/cli/scripts/validationAgent.mjs`) runs
   `pnpm run bundle` and `pnpm run copy:resources` and throws.
   `validate-tui.mjs`, `validate-journeys.mjs` and `validate-run.mjs` (three
   bundles) each spawn `scripts/build-bundle.mjs` through `process.execPath`
   with their own failure handling: exit with a message, an assertion, or
   captured output printed by `assertSuccess`. One
   `buildCli({ outfile, flags, env, resources })` needs that decided: throw
   everywhere and stream the build's output, or keep the capture.
2. **"A named terminal, shown, sent a command" is written twice in the
   extension** (`gitCommands.ts`, `SettingsViewProvider.ts`) beside
   `revealTerminal` (`packages/extension/src/frontend/setupTerminalRunner.ts`),
   which reuses a running terminal of the same name. Routing both through it
   sends a second install command into a terminal that may still be running
   the first; decide whether that is wanted.
3. **VS Code's "open this file in an editor" has two copies beside
   `openFileInEditor`** (`SettingsViewProvider.ts`,
   `VscodeToolEditApprovalHost.ts`). The owner shows an editor that is
   already visible in its own column, where the copies open in the active
   one, and its failure reads differently.
4. **llm's `toErrorMessage` is written inline once** (`packages/llm/src/node.ts`).
   The fact-spread gate counts the predicate by file, so the swap fails it;
   it lands when another file stops using the name.

## Checked and declined

- **The transcript `subscribe` signature as one named type** (the second
  half of item 4 of the 2026-11-27 note). `ActivationViewSource` is gone;
  one declaration is left.
- **`formatResultCount` in `EditTool.ts` and `cleanCommands.ts`.** Each uses
  the plural noun a second time without its count.
- **A shared `withMember(set, key, present)`** for the desktop editor pane's
  private one and three inline set copies (`ModelSelectionList.ts`,
  `TasksForm.tsx`, `approvalQueue.ts`). The copies are three lines each, and
  the helper returns the same set when nothing changes, which a setter reads
  as no update.
- **A `filterListKey` for the model picker's and the command palette's
  keydown handlers.** Two sites, and they differ on an empty list (0 against
  -1), so the helper would return the choice to each caller.
- **`offeredMembers(object)` for two `Object.entries(…).flatMap` reads**
  (`editorHost.ts`, `registry.ts`). Two callers of one expression.
- **`getPathSegments` in `runTargetFromPath`** (`executionsDisplay.ts`). It
  also trims and converts backslashes, which changes what the display labels.
- **A `waitSync(check, timeoutMs)` for two `Atomics.wait` poll loops**
  (`texra-services.mjs`, `validate-run.mjs`). Two callers of a three-line loop.
- **JSON imports for the two manifests `publish-npm.mjs` reads.** They are
  read in a loop over the two package directories; two imports and an array
  are no shorter.
- **`processRunning` in `testTempRoot.ts`.** It is Vitest's global setup and
  imports only `node:` modules; the owner would load Effect and the harness
  logger into Vitest's main process.
