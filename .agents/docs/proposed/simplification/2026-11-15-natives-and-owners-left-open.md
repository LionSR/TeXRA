# Native methods and existing owners: what the 2026-11-15 audit left open

Date: 2026-11-15
Status: proposed

Origin: the scheduled audit for duplicated logic and hand-written versions of
what Node, the language or Effect provides, run on `main` at `1dd278b`. The
findings that fit a reviewable diff landed in the PR that adds this note. The
ones below need a decision, a run of tooling the audit could not run, or
another open PR to merge first.

## Open

3. **`logFailure` has two more hand-written copies** in
   `packages/harness/src/agent/runtime/AgentRunLifecycle.ts`
   (`logLifecycleWarning`) and
   `packages/harness/src/controllers/session/deletionCleanup.ts` (two inline
   pipes). Both files are rewritten by the open #14944; convert them after it
   merges. Landed 2026-11-16 (see below).
4. **`replyDocuments.ts` reads three files with `readFileString` and a CRLF
   replace**, the body of `readNormalizedFile`. Left for the same reason: the
   open #14941 edits that file. Landed 2026-11-16 (see below).
5. **`import.meta.dirname`.** Every script now reads its directory from
   `import.meta.dirname`; the last one, `packages/harness/scripts/publish-npm.mjs`,
   followed on 2026-11-19 (checked with its `--dry-run`). What is left is the
   bundle banner (`scripts/esm-cjs-globals-banner.mjs`), which rebuilds
   `__filename` and `__dirname` from `import.meta.url`. It runs inside the
   packaged desktop and CLI bundles, so that change wants a packaged smoke
   run.

## Landed in the 2026-11-16 sweep

- Item 3: `deletionCleanup.ts`'s two inline pipes are `logFailure`.
  `AgentRunLifecycle.ts` no longer has `logLifecycleWarning`.
- Item 4: `replyDocuments.ts` reads its three files with
  `readNormalizedFile`. A file that starts with a UTF-8 BOM now keeps it
  (`readFileString` dropped it), so the output-structure pass no longer
  strips a BOM when it rewrites the output file.
- Item 5: the one script left on `fileURLToPath(new URL(...))`,
  `packages/harness/scripts/publish-npm.mjs`, runs in the release workflow
  and was left alone; the others are already converted.

## Landed in the 2026-11-17 sweep

- Item 1: both CLI validators already parse with `parseArgs` from
  `node:util`; nothing was left to convert.
- Item 2: `extractFigurePathsFromLatex` returns the absolute path it found,
  `latexMedia.ts` lost its second resolution and existence probe, and the
  defect it hid is fixed: `extract_figures` on a `.tex` in a subdirectory
  failed with "Attachment not found". The tool and its regression test
  went with the `latex-extract` plugin on 2026-11-19. A figure two files
  include now enters media once.
- `describe` in `packages/harness/src/tools/core/toolSchema.ts` groups
  a field's copies with `Map.groupBy` instead of a hand-written loop.

A sweep of `packages/*/src` for the usual hand-written natives
(`hasOwnProperty`, `substring`, sort/reverse copies, `split().join()`,
manual grouping, `setTimeout` sleeps, unprefixed Node imports, index-based
dedup, chunked `Promise.all`) found none left beyond the above.

## Landed in the 2026-11-22 sweep (app and hosts)

A sweep of `packages/texra/src` (outside `ui/`), `packages/cli/src`
(outside the TUI), `packages/desktop/src/main` and `packages/extension/src`
for hand-written retry, backoff, timeout, poll, queue, debounce, cache,
cleanup and child-process code, and for helpers ES2022–ES2024, Node or a
dependency already covers, found one:

- `attachTo` in `packages/texra/src/controllers/server/windowHost.ts` no
  longer reassigns its call receiver from inside the frame loop (open item 2
  of `2026-11-20-effect-modules-audit-left-open.md`). The attachment's RPC
  server is built before the stream opens and an answer waits on a
  `Deferred` for the id. The service's `attach` sends `attached` first, so
  the case where a `call` frame arrives first (served now, dropped before)
  cannot occur against TeXRA's own service.

Everything else the sweep looked at is already on Effect's modules (`Schedule`,
`Effect.retry`, `timeoutOrElse`, `Deferred`, `Queue`, `acquireRelease`,
`ChildProcess`, `Stream.callback`), Node's builtins (`hash`, `randomUUID`,
`stripVTControlCharacters`, `Map.groupBy`, `toSorted`, `.at`, `replaceAll`)
or a dependency (`@altmetric/identifiers`, `content-disposition`, `which`,
`diff-match-patch`, `SemVer`).

### Checked and declined on 2026-11-22

- **`spawnService` in `packages/texra/src/controllers/server/client.ts` on
  Effect's `ChildProcess`.** The service must outlive the window that starts
  it. The Node spawner's release kills the process group when its scope
  closes, and `unref` does not change that.
- **`globSync` in `packages/texra/src/platform/defaults/commandDirs.ts` and
  `glob` in `controllers/session/taskFiles.ts` on Node's `fs.glob`.**
  `taskFiles.ts` needs `hasMagic`, `magicalBraces` and
  `windowsPathsNoEscape`, which Node's glob lacks, and the harness imports
  `Glob` too, so the dependency stays. Converting only `commandDirs.ts` would
  add a second glob implementation, whose dotfile and Windows path rules
  nobody has checked.
- **`semver` in `packages/cli/scripts/build-bundle.mjs` on `SemVerRange`.**
  The script calls `minVersion` on the `engines.node` range, and
  `SemVerRange` has no lowest-version reader (`minSatisfying` needs a
  candidate list).
- **`editDistance` in `packages/cli/src/commands/_helpers/editDistance.ts`
  on effect/cli's suggester.** That module is internal (`cli/internal/
  auto-suggest.js`), counts a transposition as two edits and caps the
  distance at 2. Its one caller is in the TUI.
- **`resolveStreamColor` in `cliContext.ts` on `stream.hasColors()`.** Node
  reads `FORCE_COLOR` as a color depth and ignores `TERM=dumb` for a forced
  value. The CLI's `0`/`false`/`no` rules would change.
- **The update-check latch, `cachedAmbient` and `cachedManifest` in the CLI as
  `Effect.cached`.** Each runs before any runtime exists, or is read
  synchronously.
- **`drainAndStop`'s warning fiber in `UsageLogService.ts` as
  `Effect.timeoutOrElse`.** The wait must not be abandoned at the deadline,
  only reported. A timeout would need the same interrupt written twice.
- **`desktopProjects.ts` `dispose` (a `reduce` of `Effect.ensuring`) as
  `Effect.forEach`.** `ensuring` runs every later dispose after an earlier
  one fails or dies; `forEach` stops at the first failure.
- **The home-directory reads (`commandDirs.ts`, `nodeStorage.ts`,
  `settingsPluginCommands.ts`, `doctor.ts`, `desktopAppLog.ts`)** stay as
  item 1 of `2026-11-21-consolidation-and-natives-left-open.md` records
  them. `os.homedir()` ignores `HOME` on Windows, so replacing the
  `HOME || USERPROFILE` read is a behavior change, and whether `commandDirs()`
  gets `home` from its caller is still undecided.
- **`claudeAgentConfig.ts`'s raw `access`**: credential code, out of this
  sweep's scope.

## Checked and declined

- **One `rank` for reasoning efforts and one `envVar`.**
  `packages/llm/src/models/reasoningChoice.ts` and
  `packages/texra/src/tools/agentCli/codexConfig.ts` each write
  `EFFORT_SCALE.indexOf(effort)`; `packages/llm/src/providers/credentials.ts`
  and `packages/harness/src/utils/system/envFlags.ts` each write the same
  `Config.String` pipe. Either would be a new llm export for a
  one-expression idiom, the trade the positive-integer schema below
  declines.
- **`sha256Hex` / `truncatedHexId` at the four app sites that call
  `hash('sha256', …, 'hex')`.** `idHash.ts` is harness-internal; exporting it
  through the SDK surface to replace a one-line Node call is not a gain.
- **`truncate` in `packages/harness/src/shared/transcript/conversationFormat.ts`
  on `truncateWithEllipsis`**: its ASCII `...` is deliberate (its comment says
  why).
- **`isFields` in `packages/llm/src/api/failureReply.ts` as
  `Predicate.isObjectOrArray`**: the same test, but it narrows to `object`,
  not the local `Fields` record its eleven callers index.
- **A shared positive-integer schema.** `Schema.Int.check(Schema.isGreaterThan(0))`
  appears about forty times across `packages/llm`, the harness, the app and
  the desktop. One owner would be a new export crossing three packages (llm
  cannot import the harness) for a single-expression idiom; the copies that
  name a domain (`SeqSchema`, `PositiveTokenCountSchema`) are already local
  owners.
- **`raisedBy` in `logger/formatLogData.ts` imported from
  `utils/errors/errorMessage.ts`.** The logger is the bottom layer and imports
  nothing in the harness.
- **`Schema.isBetween` in the model-facing tool inputs.** The JSON Schema is
  the same, but the failure message a model reads changes from the bound it
  broke to the whole range.
- **`walkFiles` on the recursive `readdirSync`**: recorded in
  `.agents/docs/refuted-candidates.json`
  (`SCRIPT-walkfiles-recursive-readdir`).
- **The Codex card's duration in
  `packages/texra/src/tools/agentCli/codexShared.ts` replaced by
  `formatCompactDuration`**: the latter shows two units at most, so an
  hour-long wait would lose its seconds. (The card words it with
  `Duration.format` since `pretty-ms` went.)
