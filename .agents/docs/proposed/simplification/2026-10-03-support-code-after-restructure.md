# Support code after the restructure: what the sweep left for a design call

Date: 2026-10-03
Status: proposed
Origin: lane 3 of the 2026-10-03b simplification sweep. It covered the
host-agnostic support code (`src/utils/`, `src/common/`, `src/platform/`,
`src/hosts/`, `src/logger/`, `src/eventBus/`) after code-as-tool
(#13616–#13626), plugins-as-values (M2 #13643/#13646, M3 #13652), M4
(#13644) and the GUI lanes.

The knip ratchet already had no entry under these trees, and the sweep found
no new dead export. Every `AppSignals` key has an emitter and at least one
subscriber. Every `AgentDirectoriesPort` member has a caller.

The batched PR that carries this note implemented these finds:

- deleted `LanguageModelPort.isAvailable`, `PromptHost.error`,
  `PromptConfirmOptions.cancelLabel` and `isThenable`;
- trimmed the TUI host to the three members the CLI uses;
- folded `workspaceRoot.ts` into `locateInWorkspace` and `xmlConversion.ts`
  into `extractScratchpad`;
- removed the second read of each category's primary prompt file;
- made `pathExists` reuse `absentReason`, and moved `hookProtocol` onto
  `safeParseJson` and `mcpServer` onto `truncatedHexId`;
- tightened `ConfigWriteFailed.target`, and un-exported nine types that only
  their own file names.

The findings below were not implemented. Each one changes behavior, widens a
ratchet, or needs an owner's call.

## 1. `initializeNodeRuntimeSkills` is a one-caller forward that holds an upward edge

`src/platform/defaults/nodeHost.ts` exports `initializeNodeRuntimeSkills` and
`NodeRuntimeSkillOptions`. The only production caller is
`src/controllers/hostBootstrap.ts` (`bootstrapHost`). The body is a single
`installSkillContributions({...})` call. It is the module's only reason to
import `@skills`, which is the `platform → skills` value edge in
`config/ratchets/architecture-edges-baseline.json`. The header's "so hosts
cannot drift" rationale is gone, because every host already goes through
`bootstrapHost`.

Proposal: inline the call into `bootstrapHost`, move `NodeRuntimeSkillOptions`
beside `HostBootstrapInit`, and point the four `CliSkills.vitest.ts` calls and
the `CliInitPlatform.vitest.ts` mock at `installSkillContributions`.

Why it was not done here: the inline swaps the upward `platform → skills`
edge for a new `controllers → skills` edge. That edge is not in the
baseline, and the baseline rule is "never widen". It needs an owner's
ruling that the swap counts as a shrink. The likely answer is yes, since
`controllers` is the orchestration layer and `platform` is not.

## 2. `LanguageModelPort.onDidChange` is a VS Code concern on the shared port

`src/platform/languageModel.ts`: the only subscriber is
`packages/extension/src/extension.ts`, which listens on the port it built
itself and re-emits `languageModelsChanged`. Host-neutral code listens to
that `AppSignal`, never to the port. `UNAVAILABLE_LANGUAGE_MODEL_PORT`
carries a no-op only to satisfy the interface.

Proposal: `createLanguageModelPort` returns the port together with its
change subscription, and the extension wires the signal from that. The port
then shrinks to `selectModels` and `acquire`. `selectModels` could also take
its selector as required, since the one caller (`copilotRouting.ts`)
always passes `{ vendor: 'copilot' }`.

Not done: it changes the factory's return shape and the extension's
activation wiring. That deserves its own diff, so it is not bundled with the
deletions.

## 3. Silent catches in the plugin hook runner and digest

These are catch-alls with no predicate, which §15 of the review checklist
classes as masking:

- `src/common/plugins/pluginHooks.ts`, `runHook`:
  - `handle.exitCode.pipe(Effect.catch(() => Effect.succeed(null)))` turns
    every exit-code failure into "exited, code null". The comment only
    justifies a signal kill.
  - `Fiber.join(readers).pipe(Effect.timeoutOption(STDIO_GRACE), Effect.ignore)`
    drops stdout and stderr read or decode failures without a log.
- `src/common/plugins/pluginDigest.ts`, `walk`: `fs.readLink(full)` recovers
  every failure as "not a link". The `fs.stat` that follows surfaces most
  real I/O errors, but the predicate should name EINVAL and ENOENT.
- `src/utils/files/externalRoots.ts`, `readLinkOrUndefined`: the comment says
  EINVAL or ENOENT, but the bare `catch` also absorbs EACCES and ELOOP.

Proposal: give each one a code predicate, or log at `warn` before
recovering.

Not done: each changes which failures surface, and the hook runner's
verdicts are pinned by `HookProtocol.vitest.ts`. A behavior-preserving
sweep is the wrong place for that.

## 4. Two plugin pins resolve a program on different PATHs

`pluginDigest.ts` (`externalFiles`) resolves an MCP server command with
`whichOnExtendedPath`. `pluginHooks.ts` (`pinHook`) resolves a hook program
with `which.sync(program, { path: process.env.PATH })`. If a binary is only
on the extended PATH, it pins for a server but is refused for a hook, and
the two can pin different binaries for the same name.

Proposal: one resolver for both. The extended PATH is the one TeXRA's
spawns use. Not done because it changes which hooks load.

## 5. `entryTypeIn` and `entryExists` disagree on ENOTDIR

`src/utils/files/fsEntryExists.ts`: `entryExists` reads a path under a
regular file as absent (`absentReason` covers ENOTDIR). `entryTypeIn` only
recovers `NotFound`, so the same path fails with `BadResource`, even though
its doc says "only absence is recovered". Proposal: have `entryTypeIn`
recover through `absentReason`. Not done because it changes a failure into
a value for its callers.

## 6. Config file paths derived twice

`src/platform/defaults/nodeStores.ts` derives the local and global
`config.json` paths inline. `packages/cli/src/runtime/cliConfig.ts`
recomputes the same two paths for its warnings. Only the project path has
a shared helper (`workspaceTexraConfigPath` in `nodeStorage.ts`). Proposal:
add the two siblings and use them at both sites. Hold this until M7 (the
settings split by owner), which reshapes these readers anyway.

## 7. `ConfigProvider.inspect` is typed `| undefined`, and no implementation returns it

`JsonConfigProvider.inspect` always returns an object. Only the test fake
`FakePlatform` returns `undefined`. Proposal: drop `| undefined` and the
four callers' `?.` (`settingsAccess.ts`, `subscriptionAccess.ts`, two in
`cliConfig.ts`). This is a type tightening with cross-lane callers, so it
waits for M7.

## 8. `@common/errors` is a barrel with mixed import paths

`src/common/errors/index.ts` re-exports `formatError`, the error predicates,
`classifyAgentError` and `AgentError`. AGENTS.md documents it as a public
surface, and about 17 production files import through it. Four import the
same symbols from the defining files instead:

- `settingsHostBindings.ts`
- `toolProbes.ts`
- `terminalResultToast.ts`
- `modelFailure.ts`

Either is fine, but having both is not. Proposal: pick one path. Under
"no convenience barrels" the answer is the defining files, plus an AGENTS.md
edit and the two `import('@common/errors')` mocks in `ExecuteCli.vitest.ts`.
That is an owner call on the documented surface.

## Rejected

- **`filterNotNull`, `filterNotNullish` and `isObject` → Effect `Predicate`:**
  - The bodies are identical, but that is 54+ call sites of churn for no
    element drop.
  - `@utils/core` is browser-safe, and `Predicate` would pull `effect` into
    webview call sites that do not import it today.
- **One shared `sha256Hex`:** every remaining site is a one-line call to
  native `crypto.hash` (#13613). A helper would add an export and remove
  none.
- **Folding `gitAuthorEnv.ts` into `execUtils.ts`:** that is a file move
  with one consumer, which is M8's job.
- **Narrowing `PromptMessageItem` to `T`:** `VscodeUiHost.confirm` builds
  its own close-affordance item through it. Moving that inside the host
  trades one type arm for a private items path.
- **`linkAbortSignals`, `throwAggregated`, `clampOptional`, `clampIndex`:**
  each has one production caller, but each is a documented member of its
  family in `@utils/core`. Inlining would scatter the abort-link rationale.
- **`planTeamRuns`:** it has two callers (the CLI and `resolveTeamLaunch`).
