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
   merges.
4. **`replyDocuments.ts` reads three files with `readFileString` and a CRLF
   replace**, the body of `readNormalizedFile`. Left for the same reason: the
   open #14941 edits that file.
5. **`import.meta.dirname`.** Eight scripts under `packages/harness/scripts`,
   `packages/llm/scripts` and `scripts/` build their directory with
   `fileURLToPath(new URL('..', import.meta.url))`, and the bundle banner
   (`scripts/esm-cjs-globals-banner.mjs`) rebuilds `__filename` and
   `__dirname` from `import.meta.url`. Node 22 gives both directly. The banner
   runs inside the packaged desktop and CLI bundles, so the change wants a
   packaged smoke run. The open #14951 already converts
   `scripts/verify-desktop.mjs` and drops `nanoid` for `node:crypto`, so this
   run left both to it.

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
  failed with "Attachment not found" (regression test:
  `src/test-kernel/tools/ExtractFiguresTool.vitest.ts`). A figure two files
  include now enters media once.
- `describe` in `packages/harness/src/agent/core/tools/toolSchema.ts` groups
  a field's copies with `Map.groupBy` instead of a hand-written loop.

A sweep of `packages/*/src` for the usual hand-written natives
(`hasOwnProperty`, `substring`, sort/reverse copies, `split().join()`,
manual grouping, `setTimeout` sleeps, unprefixed Node imports, index-based
dedup, chunked `Promise.all`) found none left beyond the above.

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
- **`truncate` in `packages/harness/src/agent/storage/conversationFormat.ts`
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
- **`pretty-ms` in `packages/texra/src/tools/agentCli/codexShared.ts` replaced
  by `formatCompactDuration`**: the latter shows two units at most, so an
  hour-long wait would lose its seconds.
