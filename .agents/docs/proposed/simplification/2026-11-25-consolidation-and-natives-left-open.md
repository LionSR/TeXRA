# Consolidation and natives: what the 2026-11-25 audit left open

Date: 2026-11-25
Status: proposed

Origin: the scheduled audit for duplicated logic and hand-written versions
of what the standard library or Effect provide. Three read-only surveys
(the harness and llm; the app and hosts; scripts, config and test support),
each leaving out the files the open deletion PRs #15229 and #15230 touch.
These landed in the PR that adds this note:

- three `Intl.DateTimeFormat` constants in place of a memo keyed by sorted
  options
- `collapseWhitespace` at six inline copies, `formatResultCount`,
  `appendHead` and `Predicate.isNotUndefined` at one or two each
- `asToolError` beside `ToolError`, for three hand-written copies in the
  harness
- `pathExists` at twelve raw `FileSystem.exists` calls, which failed on a
  path whose parent is a file
- LaTeX Workshop's placeholders expanded in one pass by a replacer function
- `Response.json` for four hand-built JSON responses
- the root tsconfig `paths` and the declaration specifier pattern read from
  one owner by the harness build scripts; `clean.mjs` inlined; one `assert`
  for the two extension-package checks
- one xAI seconds field and one OpenAI ambient-header check

## Open

1. **A chat export's file name has its own sanitizer.**
   `generateExportFilename`
   (`packages/texra/src/agent/export/chatExport/filenames.ts`) lower-cases
   and dashes the label and strips date suffixes from the model with two
   regexes, where `labelFileName` and `modelFileName` are the stated owners
   of a label and a model as a file-name segment. A label with no ASCII
   letter or digit sanitizes to nothing and leaves `texra-chat-<date>--…`.
   Switching changes every export's name (case and Unicode kept, `_` for an
   unsafe character), and `modelFileName` lives in a file #15229 edits.
   Decide the name's form, then take it after that PR.
   **2026-11-26 evening:** #15229 deleted `labelFileName` and
   `modelFileName` with their last other callers, so the export's sanitizer
   is the only file-name rule left and nothing is collapsed. The
   label-with-no-ASCII case still leaves `--` in the name.
2. **The settings select row has no kit owner.** `@ui/wa/settingsSection.ts`
   owns the toggle and number rows; the select row's frame is written in
   `stateSettingRows.ts`, in the desktop theme row
   (`packages/desktop/src/renderer/settingsDialog.ts`) and in `PluginsTab.ts`
   and `LaTeXTab.ts`. The desktop row sets `size="s"` and `aria-describedby`
   and the others do not, and its id is pinned by an e2e locator. One
   `renderSettingsSelectRow` once the two attributes are decided for all
   four.
3. **The service log line is parsed twice.** `scripts/texra-services.mjs`
   owns `serviceLogPath` and `serviceAnnouncements`;
   `scripts/vscode-host-e2e-suite.cjs` has its own path and regex. The suite
   is CommonJS inside the VS Code extension host, also on the minimum
   supported VS Code, whose Node may not `require` an ES module: use
   `await import()` inside its async `checks()`.
   **Landed 2026-11-25 evening:** the suite's `run()` loads the module with
   `import()` and reads the newest announcement through
   `serviceAnnouncements(serviceLogPath(...))`; its own path and regex are
   gone.
4. **A raw `exists` in files the open PRs hold** (`latexMedia.ts`,
   `acceptedFileTarget.ts`, `ProgressDocumentTaskFileActionsController.ts`,
   `vendorPackages.ts`) and the same `${n} ${pluralize(n, …)}` in the arXiv
   and Zotero tools: `pathExists` and `formatResultCount` once those PRs
   land. The texra `asToolError`
   (`packages/texra/src/tools/agentCli/agentCliShared.ts`) goes with #15230.
   **2026-11-26 evening:** #15229 deleted `latexMedia.ts`,
   `acceptedFileTarget.ts`, the document-task file actions and the arXiv and
   Zotero tools; only `vendorPackages.ts` and `asToolError` remain, both in
   the files #15230 deletes.
   **Landed 2026-11-28:** #15230 closed without merging, so both stayed.
   `binaryIfPresent` probes with `pathExists`, and the Codex and Claude
   Code tools take the harness's `asToolError` from `./plugins`, which
   passes a `ToolError` through instead of wrapping it in another; the
   texra copy is gone.
5. **Static manifest reads as JSON imports.**
   `packages/harness/scripts/bundle.mjs`, `packages/cli/scripts/build-bundle.mjs`,
   `scripts/code-sandbox-worker.mjs` and `scripts/vscode-host-e2e-runner.mjs`
   read a fixed `package.json` with `JSON.parse(readFileSync(...))`;
   `import … with { type: 'json' }` loads on Node 22.23. Not checked: that
   the Vite config loader accepts it (`vitest.config.mjs` imports the
   sandbox worker).
   **Landed 2026-11-25 evening** for the harness bundle, the sandbox
   worker's build stamp and the VS Code host runner; the Vite config loader
   accepts the import (`vitest list` loads the config and lists the same
   250 suites). `packages/cli/scripts/build-bundle.mjs` is held by an open
   PR and still reads its manifest by hand.
   **Landed 2026-11-27** for `build-bundle.mjs`.
6. **`vitest.config.mjs` is the root's one importer of the `glob` package.**
   `globSync` from `node:fs` returns the same 250 suites on Linux; it has no
   `posix` option, so the Windows shards need the separators replaced.
   Dropping the dependency edits `pnpm-lock.yaml`, which the open PRs hold.
   **Landed 2026-11-25 evening** for the import: the config lists its
   suites with `node:fs` `globSync` and rewrites the platform separator to
   `/`, and `vitest list` assigns the same 250 suites to the same projects.
   The root `package.json`'s `glob` devDependency now has no importer; drop
   it with its `pnpm-lock.yaml` entry once the open PRs merge.
   **Landed 2026-11-26 evening:** the devDependency and its lockfile entry
   are gone.
7. Items 1, 3 and 4 of the 2026-11-23 note (`ifCurrent` compared as JSON
   text, the home directory, one timestamp format twice) are unchanged.

## Checked and declined

- **`isFields` (`packages/llm/src/api/failureReply.ts`) as
  `Predicate.isObjectOrArray`.** Same body, but the predicate narrows to
  `unknown[] | { [x: PropertyKey]: unknown }`, which is not assignable to
  `Fields`; twelve sites stop compiling.
- **`runNode` and the `tsc` lookup shared by the harness and llm
  `build.mjs`.** Two callers and about zero net lines.
- **`normalizeLineEndings` in `sync-notice-files.mjs` and
  `sync-package-contributes.mjs`.** Two one-line rules in two scripts; the
  app's owner is TypeScript a script cannot import.
- **`writeFileIfUnchanged` onto `writeFileAtomic`.** The harness documents
  `writeFileAtomic` as not for workspace files: it fsyncs and stages under a
  visible name a LaTeX watcher would see.
- **`stableStringify(a) !== stableStringify(b)` as `isDeepStrictEqual`.**
  The `{ a: undefined }` against `{}` question of the 2026-11-23 note.
- **Listener cleanup with one `AbortSignal`** in the renderers: one or two
  listeners a site, so a controller adds a field and removes nothing.
- **`toLines` in `unifiedDiff.ts` onto `splitContentLines`.** The latter
  normalizes CRLF, which a diff must not.
- **`events.once` for `waitForTermination`
  (`scripts/smoke-process-utils.mjs`).** `once` rejects on an `error` event,
  which the function must not read as an exit.
