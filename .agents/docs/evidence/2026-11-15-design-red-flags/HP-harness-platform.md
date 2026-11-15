# HP: harness platform, session store, utilities and entry files

Read on `main` at `cb22acd`. Covered in `packages/harness/src/`: `controllers/`,
`effect/`, `platform/`, `common/`, `utils/`, `model/`, `logger/`, `types/`, and
the entry files (`index.ts`, `host.ts`, `plugins.ts`, `node.ts`, `schemas.ts`,
`transcriptEntry.ts`).

Findings are appended as they are verified; the summary table is at the end.

### HP-1: `RunFileService` is two modules in one class: the harness's run-directory reader and the document task's snapshot-and-mirror state

- **Package:** harness (moves code to texra)
- **Flags:** special and general code mixed; information leakage; repetition (a fact with two owners); shallow use (a service built to read one path)
- **Evidence:**
  - `packages/harness/src/common/storage/runStorage.ts:55-502`. The class has nine public members. Five have no caller in `packages/harness/src`: `prepareRunWorkspace` (`:103`), `mirrorWorkspaceFile` (`:355`), `ensureMirroredInRunSubdir` (`:418`), `originalSnapshotPath` (`:232`), `hasDirectory` (`:217`). Their only callers are the app's document and LaTeX code: `packages/texra/src/tools/documents/documentState.ts:168,345`, `packages/texra/src/latex/latexMedia.ts:206,273,373`, `packages/texra/src/agent/output/revisionLatexdiffs.ts:101,141,144`, `packages/texra/src/tools/AcceptRunFilesTool.ts:208,264`.
  - Those five carry the class's only mutable state (`preparedBaseFiles` `:58`, `mirroredDependencies` `:59`, `pathLanes` `:62`) and speak the document task's vocabulary inside the harness: "Round-dir symlinks ... `r<N>/<relPath>`" (`:155-156`), "Read-only build assets (cls/sty/bib/figures)" (`:441-443`), `protectedStem` "would clobber primary output" (`:418,433-437`).
  - `shouldSkipRelocation` (`common/storage/storageLayout.ts:53-59`) hard-codes `new Set(['History', 'history'])`, the app's output folder, which the app owns as `HISTORY_DIR = 'History'` (`packages/texra/src/housekeeping/constants.ts:24`). It is called only from the two app-only members (`runStorage.ts:167,365`).
  - What the harness itself calls: `inspectEntry` (4 sites), `createLocation` (1), `locateSource` (1, `agent/runtime/loop/runLoop.ts:214`), `runDirectory`. None reads the mutable state.
  - Six sites build the service only to read `runDirectory`, which is `runDirUnder(roots.storage, runId)` (`storageLayout.ts:77`, set at `runStorage.ts:84`): `packages/cli/src/runtime/headless/documentTaskOutput.ts:312`, `packages/texra/src/controllers/progressView/ProgressDocumentTaskFileActionsController.ts:105,180`, `packages/texra/src/agent/output/compileCheck.ts:107`, `packages/texra/src/tools/OpenPdfTool.ts:69`, `packages/texra/src/tools/documents/documentResult.ts:297`.
- **Better design:** the harness keeps the stateless half as functions of `(roots, runId)` beside `runDirUnder` in `storageLayout.ts` (`inspectRunEntry`, `runOutputLocation`, `locateSource`); `AgentRun.fileService` goes, since nothing stateful is left to hold per run. The snapshot-and-mirror half becomes the documents plugin's own per-run value (it already keeps per-run state: `DOCS-task-file-snapshots-weakmap-stays` in `refuted-candidates.json` names it), with the `History` rule read from `HISTORY_DIR`. The six `new RunFileService(...).runDirectory` sites call `runDirUnder`.
- **Deleted:** the `RunFileService` class and its export; `AgentRun.fileService`; `shouldSkipRelocation` and `IGNORED_WORKSPACE_ROOTS` from the harness; the `r<N>`/LaTeX comments in the harness; six throwaway constructions.
- **Size:** about 450 lines moved, 60 deleted, 20 files.
- **Risk / owner decision:** `RunFileService` and `RunStorageEntry` are exported from `@texra-ai/harness/plugins`: **owner decision** on the published name. Not the refuted `DOCS-prepare-run-workspace-per-call-stays` (that one is about when the call runs, not where the code lives).

