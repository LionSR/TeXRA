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

### HP-2: Trust pins "a file outside the plugin that trusted code runs" by two rules: a hook's script by its content, a server's script by its size and date

- **Package:** harness
- **Flags:** repetition (one rule with two owners); special and general code mixed; hand-written twice what one function does
- **Evidence:**
  - Hooks: `pinHook` (`common/plugins/pluginHooks.ts:149-238`) resolves the program on PATH (`:195-211`, refusing to pin when `PATH` is unset, `:199-200`), pins it by path, size and mtime (`:205-210`), and pins every path word outside the plugin by its **content** (`sha256: … sha256Hex(yield* fs.readFile(real))`, `:221-228`).
  - MCP servers: `externalFiles` (`common/plugins/pluginDigest.ts:134-177`) resolves the command on PATH a second way (`:138-141`, no `PATH`-unset check), and pins the command **and every argument that is a file outside the plugin** by size and mtime only (`:155-163`; its comment, `:125-133`: "They are not hashed").
  - So `node /home/me/tool.js` as a hook is re-asked on any edit of `tool.js`; the same line as a plugin's MCP server is re-asked only when the edit changes the size or the timestamp. The trust prompt says so in two wordings (`pluginTrust.ts:127-130` "trusted by its path, size and date, not its content" for servers; `:148-161` "trusted by its content: an edit asks again" for hook scripts), and the closing line (`:169-171`) promises "the scripts its hooks run", not the servers'.
  - Both walk the same steps: `fs.realPath(root)`, `realPath(word)` with `absentReason` tolerated, `isPathWithin(realRoot, real)` (`pluginHooks.ts:193,216-219`; `pluginDigest.ts:137,151-154`), a third copy of the containment test beside `containedPath` (`pluginManifest.ts:169-189`).
  - Consumers: `pinHook` 3 production sites (`pluginDigest.ts:211`, `pluginTrust.ts:141`, its own file), `externalFiles` 2 (`pluginDigest.ts:198`, `pluginTrust.ts:127`); 0 tests name either.
- **Better design:** one `pinRun(root, cwd, program, args)` in `pluginHooks.ts` (or a `pluginPins.ts`) returning the `PinnedFile[]` it already defines: the program on PATH by path, size and date, every other file outside the plugin by content, PATH unset refused. The hook path calls it after its word classification; the server path calls it with `cwd: root` (servers run in the plugin directory, `pluginManifest.ts:346`, so a relative argument resolves there, which is the one real difference and becomes a parameter). `reviewLines` prints both from one `describePin`.
- **Deleted:** `externalFiles`, the `ExternalFile` interface, the second PATH lookup, the server branch's wording in `reviewLines`; one of the three containment walks.
- **Size:** about 70 lines changed, 3 files (`pluginHooks.ts`, `pluginDigest.ts`, `pluginTrust.ts`).
- **Risk / owner decision:** **owner decision.** The digest of every plugin with an MCP server changes, so each asks for trust once more after the upgrade, and a server script outside the plugin is then re-asked on any edit. Open PR #14953 touches `pluginDigest.ts` and `pluginTrust.ts` (an `Order.String` sort and a `pluginSkillCount` helper); it does not touch either pin.

### HP-3: An installed plugin's MCP server name is written as `plugin_<plugin>_<server>` and parsed back with a regex that is wrong for a plugin name with `_`

- **Package:** harness
- **Flags:** information leakage (a string format with a writer and a re-parser in two files); non-obvious code; a defect
- **Evidence:**
  - Writer: `pluginManifest.ts:337` `name: \`plugin_${name}_${server.name}\``. The plugin name may hold `_`: `readPlugin` checks it against `ServerNameSchema` (`pluginManifest.ts:483-491`), which is `/^[A-Za-z0-9_-]{1,32}$/` with no `__` (`mcpServers.ts:92-105`).
  - Re-parser: the trust prompt shows each server as `server.name.replace(/^plugin_[^_]+_/, '')` (`pluginTrust.ts:91-92`). For plugin `my_tools` and server `db` the stored name is `plugin_my_tools_db` and the prompt shows `tools_db` (checked with `node -e`), so the review a person accepts names a server that does not exist.
  - The declared server name is known at the writer (`server.name`, `:337`) and dropped; `ResolvedPlugin.mcpServers` (`:212-215`) carries only the composed name.
- **Better design:** the reader keeps what the writer knew: `ResolvedPlugin.mcpServers` entries carry the declared `server` name beside the `McpServerConfig` (whose `name` stays the tool prefix), and `describeServer` prints it. No string is parsed back.
- **Deleted:** the regex and the knowledge of the `plugin_` prefix in `pluginTrust.ts`.
- **Size:** about 10 lines, 2 files.
- **Risk / owner decision:** none (prompt wording only). One regression test (a plugin name with `_`) is within the bug-fix budget. #14953 touches `pluginTrust.ts` but not `describeServer`.

### HP-4: Whether an installed plugin loads is judged three times in `pluginTrust.ts`, and its two refusals are worded again in the app

- **Package:** harness, texra
- **Flags:** repetition (a decision with three owners, a wording with two); conjoined methods
- **Evidence:**
  - The same pipeline (reread the manifest, digest under the env key, compare with the recorded trust, refuse a plugin that ships LSP servers) is written in `enablePlugin` (`pluginTrust.ts:184-211`: code check `:193-194`, `trustKey` `:195`, `trusts` `:196`), `listPlugins` (`:237-284`: `trustKey` `:245`, `trusted: trusts(record, key)` `:259`, no code check) and `readInstalledPluginLoad` (`:319-388`: `trustKey` `:341`, code check `:357-358`, `trusts` `:361`).
  - Only the loader says *why* a plugin does not load (`:362-370`: never trusted, version changed, contents changed). The listing returns `trusted: boolean` and `code: string[]`, and the app words the code refusal a second time: `pluginRowProblem` (`packages/texra/src/ui/copy/plugins.ts:163-167`) "ships …, which TeXRA does not run yet", beside the harness's `codeRefusal` (`pluginTrust.ts:80-81`) "ships …, which this build does not run yet". A plugin that is enabled but changed since it was trusted shows no problem in the settings list or `texra plugin list` (`packages/cli/src/commands/plugin.ts:84-88`) while the loader withholds it with a reason only the log and skill notices carry (`skills/runtimeSkills.ts:131`).
  - Consumers: `listPlugins` reaches 3 hosts through `InstalledPlugins.list` (`installedPlugins.ts:473`); `pluginRowProblem` 2 (`PluginsListForm.tsx:62`, `commands/plugin.ts:84`).
- **Better design:** one `judgePlugin(record, envKey)` returning `{ plugin, key, withheld?: string }` (the loader's three wordings and `codeRefusal`), called by all three. `PluginListing` carries `withheld` in place of `code` + the app's wording; `pluginRowProblem` returns `row.plugin.problem ?? row.plugin.withheld ?? null`. `trusted` stays for the CLI toggle (`PluginsListForm.tsx:95`).
- **Deleted:** two copies of the reread-digest-compare sequence; the app's second wording of the code refusal; `PluginListing.code` (its one reader is that wording).
- **Size:** about 60 lines, 5 files (`pluginTrust.ts`, `ui/copy/plugins.ts`, `settingsViewMessages`/`pluginMessages.ts`, `pluginRows.ts`, `commands/plugin.ts`).
- **Risk / owner decision:** none for the harness half. The settings list and `texra plugin list` start showing "changed since you trusted it": user-visible, but it surfaces a state that is already true. Open PRs #14953 (`pluginTrust.ts`) and #14950 (`ui/copy/plugins.ts`, `joinFacts` in `pluginRowSummary`) touch neighbouring lines and fix neither.

### HP-5: `ConfigProvider.inspect` keeps a VS Code-shaped pair whose `globalValue` nobody reads, and `update` defaults a target its one production caller always passes

- **Package:** harness (one CLI caller)
- **Flags:** overexposure; an option for a special case; remainder of P2 (round 3, landed)
- **Evidence:**
  - `ConfigInspection` is `Partial<Record<'globalValue' | 'workspaceValue', T>>` (`shared/config/settings.ts:43-44`), the shape of `vscode.WorkspaceConfiguration.inspect`. Its production readers both read `workspaceValue` only: `model/subscriptionAccess.ts:56-58` ("a project that already names the preference keeps owning it") and `packages/cli/src/runtime/platform/cliConfig.ts:164-166` ("the workspace file's own section"). P2 deleted `rawConfigValue`, the one reader of `globalValue`; nothing reads it now. It also says nothing of the `local` store `get` consults (`jsonConfigProvider.ts:85-88`).
  - `update(key, value, target = 'workspace')` (`jsonConfigProvider.ts:99-103`; optional in the port, `settings.ts:95-99`): the one production caller, `writeSlot`, always passes `target ?? entry.configTarget ?? 'workspace'` (`settings.ts:243-247`), so the default is restated there. One test relies on the port default (`packages/harness/test/skills/RuntimeSkills.vitest.ts:77`); `src/test-kernel/tools/setup/ConfigTools.vitest.ts:46-47` pins the two-field shape.
- **Better design:** the port answers the one question its callers ask: `projectValue(key): unknown` (the project file's own value), and `update` takes a required `target`. The default lives once, in `writeSlot`.
- **Deleted:** `ConfigInspection`, `inspect`, the `globalValue` read, the parameter default.
- **Size:** about 25 lines, 7 files (2 harness, 1 CLI, 2 tests, `schemas.ts`, the API reports).
- **Risk / owner decision:** **owner decision**: `ConfigProvider` and `ConfigInspection` are published from `@texra-ai/harness/schemas` (`schemas.ts:250-251`). Not `EFF-ADOPT-config-provider` in `refuted-candidates.json` (that refused moving the port onto Effect `Config`; this keeps the port and narrows it). Open PR #14959 touches `cliConfig.ts` but not the `inspect` read.

### HP-6: Batched: plugin-source and small harness items, each written twice or false

- **Package:** harness (item d: cli)
- **Flags:** repetition; a comment that is false; identity rebuild; overexposure
- **Evidence:**
  - (a) A git plugin source is built and checked in two places. The GitHub URL is formed at `installedPlugins.ts:91-96` (typed shorthand) and `marketplace.ts:90-95` (marketplace `github` entry); `GIT_URL` and `SAFE_REF` are tested in `parsePluginOrigin` (`installedPlugins.ts:88,97`) and again in `installOrigin` (`:265-276`) because a marketplace's `PluginCandidate` (`marketplace.ts:62-68`, its `git` case a copy of `PluginOrigin`'s, `installedPlugins.ts:52-54`) skips the parser.
  - (b) `classifyAgentError` (`common/errors/agentErrorClassification.ts:21-26`) rebuilds `failureIn`'s `model` case into an identical object (`failure.kind === 'model' ? { kind: 'model', failure: failure.failure } : failure`); `failureIn`'s return type is already a subset of `RunEndError` (`shared/schemas/runRecords.ts:62-71`).
  - (c) `mcpServers.ts:41-43`: two stacked doc comments on `MCP_REVISION_KEY`; the first ("A revision key as app state stores it") is a stray.
  - (d) `packages/cli/src/runtime/platform/updateChecker.ts:134-137`: "pass an explicit cwd — the wrapper's workspace-root default would throw". `executeCommand` has no default and never throws for a missing cwd: `cwd` is required (`utils/system/execUtils.ts:114-123`) and an empty one returns a 127 result (`execUtils.ts:416-419`).
  - (e) Office formats are two lists that disagree: `OFFICE_EXTENSIONS` and `OFFICE_MIME_TYPES` (`utils/files/mimeUtils.ts:62-102`). The read tool consults both (`tools/ReadTool.ts:219-222`); the desktop's file tree filter only the extensions (`packages/desktop/src/main/desktopWorkspaceIpc.ts:280`). The MIME set is derived from the same path's extension (`getMimeType`, `mimeUtils.ts:45-54`), so it only adds extensions mime-types maps to those types (`.dot`, `.xlt`, `.pps`, …), which the tool reads as documents and the tree shows as text.
- **Better design:** (a) `marketplaceCandidate` returns a `PluginOrigin` built by one `gitOrigin(url, ref)` that validates; `installOrigin`'s re-check and `PluginCandidate`'s `git` case go. (b) `classifyAgentError = (err) => failureIn(primaryAgentError(err))`. (c) delete the stray. (d) correct the comment. (e) one extension list, the MIME set deleted (or the list derived from the MIME set by `mime.extensions`), read by both.
- **Deleted:** one validation pass and one URL builder; a branch; a stray comment; one of two office lists.
- **Size:** about 45 lines, 7 files.
- **Risk / owner decision:** none. (e) changes what the desktop tree hides for three rare extensions.

## Good modules here

- `utils/system/execUtils.ts` `executeCommand`: one call over spawn, shell lifeline, process-group teardown, deadline and output cap, never failing; every outcome is one `Outcome` case read once (`resultFromOutcome`).
- `utils/core/perKeyQueue.ts` `withPerKeyLane`: a keyed `Semaphore` with its idle cleanup in one `acquireUseRelease`; the comment states the ordering limit it measured.
- `common/plugins/pluginHooks.ts` `runHook`: scoped child, bounded capture, timeout and interruption all from Effect's scope, "never fails" by construction.
- `common/plugins/hookConfig.ts` `CLAUDE_TOOLS`: one table carries both directions of the Claude Code tool translation (`input`, `back`), so a hook's rewrite cannot drift from what it saw.
- `utils/files/fsDurability.ts`: each helper says which `FileSystem` gap it fills (`entryMetadataAt`, `readNormalizedFile`, `copyDereferenced`) and adds nothing else.
- `logger/logSink.ts`: render, redact, then bound, once, at the one write path; producers attach raw payloads.

## Considered and left alone

- The module-level external-root registry (`utils/files/externalRoots.ts:88`): `SCOPE-external-roots-standalone-service` in `refuted-candidates.json`.
- `OpenOptions.host?: Record<string, never>` (`effect/sessions.ts:88`): recorded (lens `interface-comments.md` table, Q); not repeated.
- The global store's `'global'` mode in `databaseLayer.ts`: `proposed/simplification/2026-11-15-global-store-values-only.md`. The other session-store files open PRs change (`databaseLayer.ts`, `rowReader.ts`, `runTrace.ts`, `sessionOwners.ts`, `storeSchema.ts`, `SessionRequests.ts`, `requestAnswerer.ts`, `runHandle.ts`, `sessionReads.ts`) were read for context only.
- `failureIn` / `normalizeProviderError` / `buildErrorLogData`: `proposed/simplification/2026-11-04-store-and-test-support-debts.md` (B1) and `2026-11-14-reading-a-failed-cause.md`.
- `requiredRead`'s retry over a read that already retried busy (`sessionInputsLayer.ts:64-79`): B (2026-11-05 `B-session-store.md`).
- `create{Workspace,RunStorage,External}Location` (`common/storage/fileLocation.ts`): lens-2 README, listed borderline.
- `WorkspaceRoots.globalStorage` / `globalState`: `PLATFORM-roots-drop-global-slots`; `AgentDirectoriesPort.teamMembers?` and `resourcesRoot?`: M8, kept (X S2).
- Child-process environments (`execUtils.commandEnv`, `gitEnv`, `runHook`'s env): `RT-child-environment-one-owner`.
- `DEPRECATED_DECISIONS` in `hookProtocol.ts:196`: the Claude Code hooks protocol is an outside format, normalized once at the boundary, which the 1.0 rule allows.
- `storageIdentity` (`platform/defaults/workspaceStorage.ts:122`) beside `canonicalizeWorkspaceRoot` (`utils/system/nodeWorkspace.ts:21`): two realpaths on purpose (native for the storage key, JS to keep the spelling shown), each documented.
- `MemoryStateStore` and `MemoryConfigStore`: two in-memory maps over two ports of different shape (Effect `get` vs sync `get`); merging them saves nothing.
- `executeCommand`'s `quiet` option (2 CLI callers): suppresses logging for pre-runtime callers; a log-routing question for the CLI's sink owner, not a deletion here (only the false comment is in HP-6 d).
- `utils/system/envFlags.ts` and `platform/appSignals.ts`: open PRs #14959 and #14955.
- `model/`: covered by D, O, P and U (rounds 1 to 3); nothing new found that those rows do not hold.
- The entry files: 160-odd entry names have no consumer outside the harness, almost all types in exported signatures (the API report needs them). LS-1a and Q8 covered the value exports.

## Summary

| Id | Title | Package | Flags | Size | Owner decision? |
| --- | --- | --- | --- | --- | --- |
| HP-1 | `RunFileService` is the harness's run-directory reader and the document task's snapshot-and-mirror state in one class | harness (to texra) | special and general mixed, information leakage, repetition, shallow use | ~450 moved, 60 deleted, 20 files | yes (published `RunFileService`, `RunStorageEntry`) |
| HP-2 | Trust pins an outside file by content for a hook, by size and date for an MCP server | harness | repetition, special and general mixed | ~70 lines, 3 files | yes (every plugin with a server re-asks trust once) |
| HP-3 | `plugin_<plugin>_<server>` is parsed back by a regex that misnames servers of plugins with `_` | harness | information leakage, non-obvious code, defect | ~10 lines, 2 files | no |
| HP-4 | A plugin's load verdict is judged three times; its refusals are worded again in the app | harness, texra | repetition, conjoined methods | ~60 lines, 5 files | no |
| HP-5 | `ConfigProvider.inspect` returns an unread `globalValue`; `update` defaults a target its caller always passes | harness | overexposure, option for a special case | ~25 lines, 7 files | yes (published `ConfigProvider`, `ConfigInspection`) |
| HP-6 | Batched: git source built and checked twice, identity rebuild, stray and false comments, two office lists | harness, cli | repetition, false comment, overexposure | ~45 lines, 7 files | no |
