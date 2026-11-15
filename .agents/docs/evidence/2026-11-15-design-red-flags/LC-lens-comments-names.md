# LC: comments, names and non-obvious code (lens across `packages/*/src`)

Read on `main` at `cb22acd`; covers `packages/{harness,texra,llm,cli,desktop,extension,trace-viewer}/src`, tests excluded.

Status: in progress. Sections are appended as each species is counted and verified.

## Method

- False comments: every backticked identifier and every repo path or file name in a comment line of `packages/*/src` was checked against the set of identifiers in non-comment code of `packages/`, `src/` and `scripts/`, and against `git ls-files`. Each hit was then read in context. Hits that are external names (SQLite codes, citty, picocolors), examples, or the version log in `rowVersions.ts` (which names removed fields on purpose) were dropped.
- `node_modules` is not installed in this checkout, so no Effect API claim in a comment was checked.

### LC-1a: harness comments name symbols and files that do not exist

- **Package:** harness
- **Flags:** a comment that is false
- **Evidence:** (verified at `cb22acd`; none is in `interface-comments.md`'s table of 32 or in lens-2)
  1. `packages/harness/src/agent/trace/AgentTrace.ts:8`: "plain functions in `helpers.ts`". No `helpers.ts` in `agent/trace/`; `logSdkError` and `logUserMessage` are in `agent/trace/traceLogs.ts:40,141`.
  2. `packages/harness/src/agent/trace/AgentTrace.ts:64`: "(see `helpers.ts`)". Same.
  3. `packages/harness/src/agent/trace/TraceEmitter.ts:6`: "functions in `helpers.ts`". Same.
  4. `packages/harness/src/agent/runtime/delegation/bashDelivery.ts:28-29`: "mirroring the foreground `checkToolResultTextLimit`'s "[... N characters elided ...]" note". No `checkToolResultTextLimit` anywhere; the note is written in `agent/runtime/run/toolResultText.ts:64`.
  5. `packages/harness/src/shared/session/sessionEvents.ts:117`: "`RunTrace.lost`". No `RunTrace` type; the sink is what `makeRunTrace` returns (`controllers/session/runTrace.ts:64`, its `lost` at `:42`).
  6. `packages/harness/src/shared/session/runtimeRequest.ts:103` and `packages/harness/src/agent/runtime/executeAgent.ts:232`: "`StartOptions.apiKeys`". No `StartOptions`; the struct is `StartOptionsSchema` (`runtimeRequest.ts:278`, `apiKeys` at `:298`).
  7. `packages/harness/src/tools/executions/killPolicy.ts:2`: "The `ALLOW_ORCHESTRATOR_KILL` permission gate". The constant is `ALLOW_ORCHESTRATOR_KILL_SETTING` (`shared/state/stateSettings.ts:419`); the short form names nothing.
- **Better design:** each comment names the symbol that exists, or drops the name where the sentence stands without it (items 1 to 3 say the same thing three times in two files: keep one, on `AgentTrace`).
- **Deleted:** two of the three `helpers.ts` sentences; seven false names.
- **Size:** ~10 lines, 6 files
- **Risk / owner decision:** none

### LC-1b: texra comments name symbols and files that do not exist

- **Package:** texra
- **Flags:** a comment that is false
- **Evidence:**
  1. `packages/texra/src/agent/teams/teamPlan.ts:5`: "`WorkspaceAgentsController.setTeam`". No `setTeam`; the method is `setDefaultTeam` (`packages/harness/src/agent/workspaceAgents/WorkspaceAgentsController.ts:365`).
  2. `packages/texra/src/agent/export/standaloneTraceHtml.ts:7`: "`main.ts`'s `loadTrace()` reads this global". `loadTrace` is in `packages/trace-viewer/src/traceHostBridge.ts:45`; `main.ts` has none.
  3. `packages/texra/src/utils/git/repositoryOverview.ts:4-7`: "Previously implemented separately in `packages/extension/src/commands/git/gitCommands.ts` and `packages/desktop/src/main/desktopGitHost.ts`". `desktopGitHost.ts` does not exist; the sentence is history, not a contract.
  4. `packages/texra/src/latex/arxivProcessor.ts:502-504`: "the provider typed ordinary entries from the `readdir` dirent, but a *symlink* dirent still ran one `stat` (`fileTypeFor` → `resolveSymlinkType`)". Neither function exists anywhere; the comment describes a removed provider in the past tense to justify the present call.
  5. `packages/texra/src/controllers/server/client.ts:68` and `packages/texra/src/controllers/server/protocol.ts:279`: "`StartOptions.apiKeys`" (as LC-1a item 6).
  6. `packages/texra/src/tools/zotero/bbtClient.ts:119`: "When `includeParents` is true". No such parameter in the repo; it is the second positional argument of the Better BibTeX RPC `item.collections(citekeys, true)` named on the line above.
  7. `packages/texra/src/latex/extractFileDependencies.ts:99`: "which is what `stopOnError: false` used to do". No `stopOnError` in the repo; history.
- **Better design:** name the existing symbol (1, 2, 5), delete the history sentences (3, 4, 7), say "with the second argument `true`" (6).
- **Deleted:** three history sentences; five false names.
- **Size:** ~14 lines, 8 files
- **Risk / owner decision:** none

### LC-1c: cli comments name symbols that do not exist

- **Package:** cli
- **Flags:** a comment that is false
- **Evidence:**
  1. `packages/cli/src/runtime/models/modelAccess.ts:213-215`: "at 1.0 the fanned-out `availabilityLabel`, `requiresKey` and `disabled` keys are gone". `availabilityLabel` and `requiresKey` exist nowhere; the comment documents keys by their absence.
  2. `packages/cli/src/chat/tui/forms/_shared/FormFrame.tsx:2`: "Replaces the per-form `XFrame` wrappers". History; nothing is named `*Frame` but this.
  3. `packages/cli/src/runtime/platform/cliConfig.ts:237`: "`contextFromArgs` is the one place". Gone from the tree; **open PR #14959 already rewrites it to `loadConfigAndWarn`**, so it is listed only for the count.
- **Better design:** state what the record holds now; drop "replaces".
- **Deleted:** two history clauses.
- **Size:** ~5 lines, 2 files
- **Risk / owner decision:** none
