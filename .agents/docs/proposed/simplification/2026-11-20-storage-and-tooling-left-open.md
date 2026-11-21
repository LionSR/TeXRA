# Storage, shared schemas and tooling: what the 2026-11-20 pass left open

Date: 2026-11-20
Status: proposed

Origin: a find-simplification pass over `packages/harness/src/controllers/session/`,
`shared/`, `common/`, `utils/`, `platform/`, `scripts/` and `packages/*/scripts/`
on `main` at `56a555c`. The same series deletes the fake-provider TLS preload
nothing loads, folds `scripts/build-identity.mjs` into its one consumer,
writes a `FileLocation` as its literal (the three identity factories leave
`@texra-ai/harness/host`), turns the never-decoded `SessionCloseReportSchema`
into an interface, and drops an identity rebuild in `classifyAgentError`. No
row version, `SCHEMA_VERSION`, stored or wire shape changed.

## Open

1. **A preview's temp file is located by its own containment rule.**
   `tempPathToLocation` in `packages/texra/src/controllers/approval/latexPreview.ts`
   decides workspace or external with `isStrictlyWithin` over
   `path.normalize`d paths. `pathToLocationIn`
   (`packages/harness/src/common/storage/fileLocation.ts`) answers the same
   question through `locateInWorkspace`, which reads the relative path
   following symlinks on either side (`relativeToRoot`). The two differ when
   the temp path reaches the workspace through a symlink: the preview's rule
   calls the file external, the shared one a workspace file. Decision: should
   such a preview read as a workspace file? If so,
   `tempPathToLocation` is `pathToLocationIn(workspaceRoot, tempPath)` and
   goes (about 20 lines); it changes which LaTeX root and display path the
   preview build uses, so it wants a preview run on a symlinked project.
2. **`scripts/code-sandbox-worker.mjs` is named for one of its three
   facts.** It embeds the worker, but every bundle reads it for
   `harnessBundleOptions` (the worker plugin, the WASM loader, the build
   identity, `keepNames`). Renaming it (for example
   `scripts/harness-bundle.mjs`) touches five importers, `vitest.config.mjs`
   and the `ci.yml` path filter that names the file. Decision: worth the
   rename, or leave the name with its header saying what else it holds.

## Checked and declined

- **`run`, `pragmaValue`, `STORE_FILE_SUFFIXES` and `isDamaged` in
  `controllers/session/storeAside.ts`** have one consumer, `storeSchema.ts`.
  Moving them there changes no owner and deletes nothing (the reasoning of
  `TRANSCRIPT-pure-reads-out-of-view-update` in
  `.agents/docs/refuted-candidates.json`).
- **Unexporting `TakenFollowUp` (`shared/session/runRowsShape.ts`) and
  `PluginProgram` (`common/plugins/pluginPrograms.ts`).** Each is read only in
  its file, but each types a field of an exported interface, so the exported
  declaration keeps naming it; the export is the honest surface.
- **`safeParseJson` and `safeParseYaml`** (`common/parsing/`): thin
  `Result.try` wrappers, but each has several callers and names the
  `unknown` result once.
- **Containment checks written by hand in scripts**
  (`scripts/verify-desktop.mjs`, `scripts/check-guidance-refs.mjs`,
  `scripts/vscode-host-e2e-suite.cjs`,
  `packages/harness/scripts/forgotten-exports.mjs`). Scripts cannot import
  the harness's `isPathWithin`, and each check compares paths it built
  itself.
- **The bundle banner's `import.meta.dirname`**
  (`scripts/esm-cjs-globals-banner.mjs`) stays with
  `2026-11-15-natives-and-owners-left-open.md` item 5: it needs a packaged
  desktop and CLI smoke run.
