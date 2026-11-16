# Native methods and existing owners: what the 2026-11-15 audit left open

Date: 2026-11-15
Status: proposed

Origin: the scheduled audit for duplicated logic and hand-written versions of
what Node, the language or Effect provides, run on `main` at `1dd278b`. The
findings that fit a reviewable diff landed in the PR that adds this note. The
ones below need a decision, a run of tooling the audit could not run, or
another open PR to merge first.

## Open

1. **The CLI validation scripts check argv strictness by hand.**
   `packages/cli/scripts/validate-run.mjs` (`PARSE_ARGS_DEF`,
   `KNOWN_FLAG_TOKENS`, the unknown-token scan) and
   `packages/cli/scripts/validate-tui.mjs` wrap citty with their own rejection
   of unknown flags, and `packages/cli/scripts/generate-golden-store.mjs`
   compares against a literal list. `parseArgs` from `node:util` with
   `strict: true` and `allowNegative: true` does all three, as six scripts
   under `scripts/` already do; about 110 lines go. Not done here because the
   two validators are only proven by running them against a built CLI, and
   strict mode refuses `--snapshot-dir -x` where today's scan accepts it.
2. **A figure's path is resolved twice.** `extractFigurePathsFromLatex`
   (`packages/texra/src/latex/extractFigure.ts`) finds each figure's absolute
   path and returns it relative to the LaTeX file's directory;
   `packages/texra/src/latex/latexMedia.ts` resolves that directory again,
   joins the path back and re-checks that the file exists. Returning the
   absolute path deletes the second resolution (about 20 lines).
   `packages/texra/src/tools/latex/ExtractFiguresTool.ts` hands the relative
   paths to `buildLimitedAttachments`, which resolves against the working
   directory, so a `.tex` file in a subdirectory may attach nothing: read from
   the code, not reproduced. The fix and the defect are one change and want a
   regression test written to fail first.
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

## Checked and declined

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
