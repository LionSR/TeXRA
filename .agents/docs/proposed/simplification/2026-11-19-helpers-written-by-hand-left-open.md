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

## Open

1. **Warnings with no channel of their own.** Some sites write
   `Effect.logWarning(...).pipe(Effect.annotateLogs({ data }))` with no
   channel and inherit their caller's:
   - `packages/harness/src/agent/runtime/runRegistry.ts`
   - `packages/texra/src/controllers/server/discovery.ts` (two)
   - `packages/texra/src/controllers/server/hostWindows.ts`
   - `packages/extension/src/frontend/ui/fileDecorations.ts`

   `logFailure` takes a channel, and passing one would override the
   inherited channel. Decide whether each file names its own channel. If it
   does, these become `logFailure` calls.

2. **The memory tool counts lines two ways.**
   `packages/harness/src/tools/memory/MemoryTool.ts` views a file through
   `splitContentLines`, which drops the empty entry after a trailing
   newline. It edits and inserts through a raw `split('\n')`, which keeps it.
   So for a file that ends in a newline, the view shows N lines and
   `insert_line` accepts N + 1. Insert may need the raw split to keep the
   trailing newline. Confirm what a model sees before changing either.
3. **A setting's default read by decoding `undefined`.** Three app sites
   write `Schema.decodeUnknownSync(row.schema)(undefined)`:
   - `packages/texra/src/ui/settings/tabs/GitTab.ts`
   - `packages/texra/src/ui/settings/settingsState.ts`
   - `packages/cli/src/chat/tui/forms/ConfigForm.tsx`

   `configDefault` in `packages/harness/src/shared/state/stateSettings.ts`
   memoizes this, but only for `slot: 'config'` rows, and the Git tab's row
   is a `repoState` row. A slot-agnostic `rowDefault(row)` would serve all
   three. It is a new SDK export, so it needs the owner's call.

4. **`:host { display: block; }` in 28 Lit components.** The block is
   repeated across `packages/texra/src/ui/progress/components/` and
   `packages/texra/src/ui/settings/`. Twenty settings components also open
   their styles with the same `designTokens, commonViewStyles` pair.
   - Do not put `display: block` into `designTokens`: inline and flex hosts
     would change.
   - A shared `hostBlock` (or a settings-tab styles array) in
     `packages/texra/src/ui/styles/litStyles.ts` would hold it once.
   - It needs a visual check of both webviews, which this run could not do.
5. **The two CLI entry points share a crash wrapper.**
   `packages/cli/src/bin/texra.ts` and `packages/cli/src/bin/texraServe.ts`
   each do the same three things:
   - install the stderr log sink;
   - run their body under `Effect.tryPromise` with `CliEntryCrashed`;
   - word the crash and set the exit code.

   They differ in the label and the crash-report line. One `runCliEntry` in
   `packages/cli/src/runtime/platform/logSinks.ts` would serve both. These
   are runtime entries, so the change wants a packaged CLI smoke run.

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
