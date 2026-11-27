# Consolidation and natives: what the 2026-11-27 audit left open

Date: 2026-11-27
Status: proposed

Origin: the scheduled audit for duplicated logic and hand-written versions
of what the standard library or Effect provide. Three read-only surveys
(the harness and llm; the app and hosts; scripts, config and test support),
each leaving out the files the open PRs #15216, #15230, #15242, #15245 and
#15247 touch. The app and harness surveys found no pattern with four or more
sites that an earlier note has not landed or declined; most of what is left
is in the validation scripts and in files the open PRs hold. These landed in
the PR that adds this note:

- in `packages/cli/scripts/validate-run.mjs`: one
  `validationModelEnv(flagPath)` for three copies of the validation-model
  child environment, and the chat scenario's reply wait through `waitFor`,
  which takes the detail its timeout prints. The same morning's package
  scan (#15256) landed `projectStore`, the value-returning `waitFor`,
  `loadPtySpawn` and the shared key list; this run had written the first
  three as well, and the merge kept #15256's.
- the CLI bundle script's manifest as a JSON import, and
  `import.meta.dirname` for its one `fileURLToPath`
- `Schema.isBetween` for the tool time limit's two chained checks (#15256
  landed the list and web-search limits)
- `appendTail` and `appendHead` at two more code-unit cuts (the partial text
  a failed turn stores, a JSON-RPC frame error), `Arr.findLast` for a
  reverse-then-find, `Order.String` for a hand-written comparator
- `copyText` beside `vscodeUi` for the extension's three clipboard writes;
  `joinFacts` and `Str.capitalize` at one inline copy each
- the protocol digest sorts its shapes by code unit, not by the host's locale

## Open

1. **The validation scripts' provider key list has drifted from its
   owner.** `VALIDATION_PROVIDER_KEYS`
   (`packages/cli/scripts/validationAgent.mjs`) lists nine provider key
   variables; `API_KEY_ENV_NAMES`
   (`packages/llm/src/providers/providers.ts`) derives eleven from the
   provider manifest, so `META_API_KEY` and `KIMI_CODE_API_KEY` set in a
   developer's shell reach every validation child. A script cannot import
   the llm sources (their specifiers name `.js` files). Decide between a
   list in `packages/cli/src/runtime/models/validationSwitch.ts`, which the
   scripts already import, pinned equal to `API_KEY_ENV_NAMES` by one suite,
   and clearing every `*_API_KEY` by suffix as `validate-tui.mjs` does and
   faking only the provider a scenario names.
2. **Two more copies of the validation-model environment.**
   `generate-golden-store.mjs` sets the switch and the flag path itself and
   fakes two keys where `validationModelEnv` fakes all nine; `scriptedModel`
   (`packages/desktop/tests/e2e/serviceFixture.ts`) fakes one. Moving
   `validationModelEnv` to `validationAgent.mjs` with the faked keys as its
   argument serves the two scripts; the fixture is TypeScript and would
   need the builder in `validationSwitch.ts`. The golden store's `until`
   also still polls beside `waitFor`: it gives up when its PTY exits, which
   `waitFor` does not.
3. **"Report a failure, pass an interrupt" is written per host.**
   `reportingFailure` (`packages/extension/src/frontend/ui/errorHandlingUtils.ts`)
   is the extension's owner; `reported` in
   `packages/desktop/src/main/desktopWindowHost.ts`, `reported` in
   `packages/texra/src/controllers/settingsView/settingsHostBindings.ts` and
   `finish` in `settingsViewBody.ts` restate it. Two of them answer an
   interrupt-only cause with `Effect.void` and two raise the interrupt
   again, so one owner in the app needs that decided first. About eleven
   more sites catch the same way with a handler of their own.
4. **Two public callback types are written out at each implementer.** The
   `change` argument of `StateStore.modify` and of the current-values
   `modify` (five declarations across `shared/config/settings.ts`,
   `appStateStore.ts`, `memoryState.ts`, `shared/session/database.ts`,
   `currentValues.ts`), and the transcript `subscribe` signature (four, with
   `RemoteSessionView`'s shape equal to `ActivationViewSource`). One named
   type each; both are public, so the change rewrites
   `config/api-reports/`, which the open PRs hold.
5. **`bash.ts` still chains its two range checks**, and
   `chatSessionController.vitest.ts` the second copy of the signal-wait
   `until` (item 6 of the 2026-11-26 note). Both files are held.
6. **xterm's font size is read two ways.** The desktop terminal pane reads
   the body's computed size (fallback 14); the progress view's terminal
   output reads `--wa-editor-font-size` (fallback 12). Both take the font
   family from `resolveXtermTheme`; the size could join it once one source
   is chosen.

## Checked and declined

- **`fs.globSync` for the `find` that collects `serve.log` files**
  (`removeScratch` in `validate-run.mjs`). `**` skips dot directories on
  Node 22.23, and the logs are under `<home>/.texra/run/`. A recursive
  `readdirSync` reads them, but it throws when a directory disappears during
  the walk, and this one runs at exit over homes whose services are still
  stopping; `find` reports that and continues.
- **A `rowsOf(rows, run, type)` in `storeFaults.ts`** (item 6 of the
  2026-11-26 note, counted again: four named helpers and about thirty inline
  `row.run === x && row.type === y` predicates across `filter`, `find`,
  `some` and `findLast`). The named helpers decode differently, and a shared
  predicate replaces a one-line arrow with a one-line call.
- **`withTempDirEffect` and `useTempDirs` for the suites' own
  `mkdtempSync`** (about eight suites). The owners resolve the real path and
  the copies do not, `makeTempDir` is asynchronous where the hook copies are
  synchronous, and each conversion re-indents a test body.
- **A `pollUntil` for the suites' `Effect.repeat` with a spaced schedule and
  a timeout** (eleven sites). Interval, timeout, clock and failure message
  differ at each; the helper would take all four as arguments.
- **A forwarded `--` handled one way in every script** (item 5 of the
  2026-11-26 note). None of the nine `parseArgs` scripts that ignore it is
  run through `pnpm run … --`: CI, `package.json` and the hooks call them as
  `node scripts/x.mjs --flag`. The three that are run that way handle it.
- **`pluralize(n, 'is', 'are')` and `pluralize(n, 'a tool', 'tools')`**
  (`pluginPrograms.ts`, `AgentLaunchContext.ts`). The helper is for a noun's
  plural; a verb or an article through it reads worse than the conditional.
- **A `cachedOnSuccess` for the two
  `Effect.cachedWithTTL((exit) => Exit.isSuccess(exit) ? infinity : zero)`**
  (`codeSandbox.ts`, `pluginCatalog.ts`). Two callers of one expression.
- **`removeBestEffort` in `desktopToolEditApproval.ts`.** It changes the
  warning's wording and adds a debug line for one site.
- **`formatError(prefix, error)` for the app's `${prefix}: ${toErrorMessage(e)}`
  sites** (about thirty-five). `formatError` cuts at 500 graphemes.
- **`Effect.catchCauseIf` for the catches of item 3.** It keeps the typed
  error in the channel and fails again with the original cause where the
  sites raise a fresh interrupt.
- **One `[warn] [channel]` writer for the CLI's direct stderr warnings**
  (seven sites). They are outside the stderr sink on purpose (Ink owns the
  terminal, or the process is exiting), and a helper saves no lines.
- **A shared `{ message, cause }` field set for the tagged errors** (about
  eighteen). The same length at each site, and llm cannot import the harness.
