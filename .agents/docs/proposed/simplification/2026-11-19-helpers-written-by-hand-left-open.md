# Helpers written by hand: what the 2026-11-19 audit left open

Date: 2026-11-19
Status: proposed

Origin: the scheduled audit for duplicated logic and hand-written versions of
what Effect or an existing helper already provides. These landed in the PR
that adds this note:

- `Result.getOrUndefined`
- `logFailure`, exported to the app
- `fromHost` for every promise-faced host call
- `Record.filter` / `Record.map`
- `Array.difference`
- `envNameKey`

The findings below each need a decision or a check this run could not make.

Landed since:

- **The memory tool counts lines one way.** `insert` and the listing
  `str_replace` returns read the file through `splitContentLines`, as `view`
  does, so `insert_line` takes exactly the lines a view numbered. Insert puts
  the file's final newline back after the join. Line endings were never the
  difference: `readMemoryFile` normalizes CRLF before either split.
- **One `runCliEntry` for both CLI entries**
  (`packages/cli/src/runtime/platform/logSinks.ts`): it installs the stderr
  sink and the pipe handlers, runs the entry's body for its exit code, and
  words a crash under the entry's label. `texra` also passes the
  crash-report line; `CliEntryCrashed` is file-local.

- **A second pass over every package** replaced the remaining sites with
  `Record.map` / `filter` / `mapEntries` / `remove`, `Effect.match`,
  `Effect.orElseSucceed`, `Effect.tapError`, `Effect.sandbox`,
  `Effect.filter`, `Effect.catchTag`, `Fiber.join`, `Result.all`,
  `Array.zip` and `Stream.zipWithPrevious`. What it read and left is under
  "Checked and declined".

## Open

1. Landed 2026-11-20: every such site, and twenty more that wrote
   `logFailure`'s body by hand, calls `logFailure` with its module's channel
   (`2026-11-20-one-owner-per-wording-left-open.md`). Was: **Warnings with
   no channel of their own.** Some sites write
   `Effect.logWarning(...).pipe(Effect.annotateLogs({ data }))` with no
   channel and inherit their caller's:
   - `packages/harness/src/agent/runtime/runRegistry.ts`
   - `packages/texra/src/controllers/server/discovery.ts` (two)
   - `packages/texra/src/controllers/server/hostWindows.ts`
   - `packages/extension/src/frontend/ui/fileDecorations.ts`

   `logFailure` takes a channel, and passing one would override the
   inherited channel. Decide whether each file names its own channel. If it
   does, these become `logFailure` calls.

2. **A setting's default read by decoding `undefined`.** Three app sites
   write `Schema.decodeUnknownSync(row.schema)(undefined)`:
   - `packages/texra/src/ui/settings/tabs/GitTab.ts`
   - `packages/texra/src/ui/settings/settingsState.ts`
   - `packages/cli/src/chat/tui/forms/ConfigForm.tsx`

   `configDefault` in `packages/harness/src/shared/state/stateSettings.ts`
   memoizes this, but only for `slot: 'config'` rows, and the Git tab's row
   is a `repoState` row. A slot-agnostic `rowDefault(row)` would serve all
   three. It is a new SDK export, so it needs the owner's call.

3. **`:host { display: block; }` in 28 Lit components.** The block is
   repeated across `packages/texra/src/ui/progress/components/` and
   `packages/texra/src/ui/settings/`. Twenty settings components also open
   their styles with the same `designTokens, commonViewStyles` pair.
   - Do not put `display: block` into `designTokens`: inline and flex hosts
     would change.
   - A shared `hostBlock` (or a settings-tab styles array) in
     `packages/texra/src/ui/styles/litStyles.ts` would hold it once.
   - It needs a visual check of both webviews, which this run could not do.

## Checked and declined

- **`fs.exists` in place of `pathExists`** (nine harness sites). Effect's
  `exists` already reads `NotFound` as false. `pathExists` adds only
  `ENOTDIR`, so the change would buy little unless one of those paths can
  sit under a file. Checking each path is a separate pass.
- **The `firstLine` copies and the line splits in `unifiedDiff.ts`, `grep.ts`
  and `img.ts`.** They differ from `splitContentLines` on purpose:
  - a diff keeps a CRLF line's `\r`;
  - grep and the page count drop every blank line;
  - the first-line helpers trim differently.
- **Plugin hook and server file pinning**
  (`packages/harness/src/common/plugins/pluginHooks.ts`,
  `packages/harness/src/common/plugins/pluginDigest.ts`). Hooks hash an
  external file; servers record size and mtime and refuse relative paths
  differently. A shared resolver would carry both rules.
- **`Record.filter` over a union of structs** (`resultFields` in
  `packages/harness/src/shared/toolUse.ts`, `runRecords.ts`).
  `ReadonlyRecord` does not accept a union whose branches lack each other's
  keys.
- **`Record.map` in `packages/harness/src/logger/redaction.ts`.** Its spread
  would copy symbol keys past the redaction.
- **`path.extname(x).toLowerCase()` as `getExtensionLowercase`.** The
  harness helper is not on a public entry. Exporting it to replace a
  one-call native expression is not a gain.
- **`isFields` in `packages/llm/src/api/failureReply.ts` as
  `Predicate.isObjectOrArray`.** The runtime check is the same, but the
  Effect guard narrows to a union with `unknown[]`, which has no named
  fields to read. The same holds for `Predicate.isObject` over the reused
  result's `value` in
  `packages/harness/src/agent/runtime/delegation/agentChild.ts`: the
  narrowed type cannot be spread.
- **`Array.partition` for a pair of opposite `filter` calls.** In this Effect
  version it takes a `Result`-returning filter, not a predicate, so it is
  not shorter.
- **`Effect.findFirst` for the first-hit loops** (vendor packages, tool
  checks, credentials). It returns the element, and each loop wants the
  value it probed.
- **A `Schedule` for the model retry and the GitHub poller.** The delay
  comes from the failure itself (a retry-after, a rate-limit reset), and
  `times` is applied after `while`, so the last failure would log a retry
  and sleep before giving up.
- **`Effect.isSuccess` for the readable-file probe in
  `packages/cli/src/runtime/doctor.ts`.** The handler's annotated parameter
  is what makes a second error type fail to compile.
- **One helper for "copy the sign-in code, warn, say whether it copied"**
  (`packages/desktop/src/main/desktopSignInPresenters.ts`,
  `packages/extension/src/frontend/auth/subscriptionSignIn.ts`). Eight
  lines in two hosts; a new app export would cost about as much.
