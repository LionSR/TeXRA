# Survey: code consolidation and native-method opportunities (2026-09-12)

Status: implemented
Archived: 2026-09-12

> **Status:** Written 2026-09-12 against branch HEAD `03b7e4a` (`refactor(memory):
one Effect leaf per memory file operation; delete the duplicated tryPromise
wrappers`, #12317). Scheduled routine re-ran the standing question — "find
> duplicate/similar logic to consolidate, and hand-rolled code that a native
> method or the standard library already covers" — six days after
> `2026-09-06-consolidation-and-native-methods-survey.md`. **Verdict: two
> small, isolated candidates clear the bar and are fixed in this pass; both
> outside the churning "1.0 clean slate" run-model surface.**
> `src/tools/memory/memoryUtils.ts`'s `displayToStoragePath` hand-rolled
> absolute-path containment instead of calling the shared symlink-aware
> `relativeToRoot` helper, and
> `supabase/functions/github-app-token-exchange/index.ts` reimplemented the
> `bearerToken` helper already exported by `supabase/functions/_shared/auth.ts`.

## 0. Window covered

`701824c..HEAD` (36 commits touching `src/` or `packages/*/src/`) was this
pass's window — `701824c` is the most recent commit before this run whose
subject starts `consolidate:` (`consolidate: shared wa-details toggle guard,
native toSorted over spread+sort`, #12244), the same marker the prior entries
in this series use to find their own grounding point. The window is
dominated by the "1.0 clean slate" push and the new run-ledger/run-loop
architecture (`feat(run): the run ledger foundation`, #12287;
`feat(run): two Effect loops on the ledger and the llm Model; delete the
PocketFlow engine`, #12314; a dozen more `refactor(run):`/`simplify:` PRs
landing in the same span) — active, fast-moving surface that this pass
deliberately avoided proposing changes into, per this series' standing rule
to prefer isolated wins over touching code mid-refactor.

Note: the runner's git history is shallow (50 commits), so `701824c` was the
oldest `consolidate:`-prefixed commit reachable at all; the exact grounding
commit the 2026-09-06 entry used (`03d2cfd`) is outside the fetched range.
This pass's window is therefore a superset of the untouched gap, not an
exact diff against the prior entry — see "Method" below for how that gap was
covered.

## 1. Method

Given the shallow history, this pass could not do a pure `git diff
<prior-grounding-commit>..HEAD` sweep for new tells the way the 2026-08-29
through 2026-09-06 entries did. Instead it ran four parallel domain surveys
(the same tells this series has always checked — duplicate/near-duplicate
logic, hand-rolled code a Node builtin or an existing dependency already
covers, and re-derived facts) across the whole repo, cross-checked each
candidate's file against `701824c..HEAD` to see whether it fell inside the
actively-churning run-model surface, and rejected anything that did:

- **`src/agent/`, `src/tools/`** (agent runtime, model handlers, tool
  implementations).
- **The three webview frontend trees** (`webview/`, `progressView/`,
  `settingsView/` under `packages/extension/src/`).
- **`src/platform/`, `src/hosts/`, `src/common/storage/`**, and per-host
  platform implementations.
- **`scripts/`, `docs/scripts/`, `packages/extension/resources/`,
  `prompts/`, `supabase/functions/`, `src/utils/`.**

## 2. What was found

**`memoryUtils.ts` hand-rolled path containment instead of the shared
symlink-aware helper.** `src/tools/memory/memoryUtils.ts`'s
`displayToStoragePath` built `path.resolve` + `path.relative` +
`isPathWithin` by hand to validate a memory path stays under
`MEMORY_STORAGE_DIR`. `src/platform/defaults/nodeWorkspace.ts`'s
`relativeToRoot` already does the same containment check _and_ additionally
falls back to a symlink-canonicalized comparison
(`canonicalizeWorkspacePath`) when the lexical check fails — the exact
helper `src/tools/pathResolution.ts:131-135` calls out in a comment as "the
shared symlink-aware absolute-path containment helper" and
`src/utils/files/workspaceFS.ts:44` already uses. Grepping every
`isPathWithin` call site (`deletionCleanup.ts`, `workspaceStorage.ts`,
`externalRoots.ts`, `nodeWorkspace.ts` itself, and `memoryUtils.ts`) showed
`memoryUtils.ts` was the only remaining caller building the containment
sequence by hand rather than through `relativeToRoot`. This was a real
behavioral gap, not just style: a memory storage root reached through a
symlink would fail `memoryUtils.ts`'s check while succeeding through
`pathResolution.ts`'s.

**Duplicate `bearerToken` helper in a Supabase edge function.**
`supabase/functions/_shared/auth.ts:11-14` exports `bearerToken(req)`.
`supabase/functions/github-app-token-exchange/index.ts:50-53` defined an
identical local copy, in a file that already imports three other helpers
from that same `./auth.ts` module (`parseRepositoryClaim`,
`validateWorkflowIdentity`, `verifyGitHubActionsToken`) — so the shared
module was already a normal dependency for this file, just not used for
this one function.

## 3. Fix

- `src/tools/memory/memoryUtils.ts`: `displayToStoragePath` now calls
  `relativeToRoot(MEMORY_STORAGE_DIR, resolved)` and checks
  `relative === undefined` instead of resolving a second `base` path and
  calling `isPathWithin` directly; the `isPathWithin` import is gone (no
  other use in the file) and `relativeToRoot` is imported from
  `@platform/defaults/nodeWorkspace`. Error message and return value are
  unchanged for every non-symlink case; a symlinked storage root now
  resolves instead of being rejected.
- `supabase/functions/github-app-token-exchange/index.ts`: the local
  `bearerToken` function is deleted; the file imports `bearerToken` from
  `./auth.ts` alongside its existing imports from that module.

Verified: `npm run typecheck` (all seven workspace/package checks) passes
clean; `npx eslint` on both touched files reports zero errors (the Supabase
function is outside the ESLint project's configured scope, so it only
carries the expected "no matching configuration" notice, unrelated to this
change); `npx prettier --check` passes on both files; `npx vitest run
memory` (26 tests, 6 files) passes; `npm run test:pure` (2335 tests) passes;
`npm run check:dead-code-ratchet` reports no new findings; the full `npm
test` (6295 tests, 591 files) passes.

## 4. What was checked and ruled out

- **Platform/hosts/storage** (`src/platform/`, `src/hosts/`,
  `src/common/storage/`, per-host platform implementations): already
  thoroughly consolidated — shared secrets (`secretsGet`), shared
  composition helpers (`createNodePlatform`, `createNodeWorkspaceRoots`,
  `openTexraConfigStores`), `node:crypto`-backed ID hashing, no
  migration/compatibility readers for internal formats, no `.catch()`
  masking corrupted persisted state. One trivial, low-confidence,
  not-worth-a-standalone-change item noted (`packages/desktop/src/main/platform/paths.ts`'s
  `isExistingDirectory` could use `statSync(..., { throwIfNoEntry: false
})` instead of a try/catch — purely stylistic, same behavior) and left
  unfixed.
- **Agent runtime and tools** (`src/agent/`, `src/tools/`): equally
  consolidated — `auxiliaryRetry`/`pRetry`, `matchMappedSdkError`,
  `ToolCallAccumulator`/`ChannelStreamAggregator`, `KeyedMutex`,
  `pathResolution.ts`'s containment helper, and `agentCliShared.ts` are all
  genuine shared bases with no duplicate reimplementations found (zero
  duplicate exported function names across the whole domain). No hand-rolled
  promise chains, manual retry loops, or manual debounce/throttle found; the
  two rate-limiting implementations that exist are deliberately different
  algorithms with a comment explaining the choice, not duplicates. Google's
  media-classification fork (`mediaClassification.ts:14-19`) is a
  documented, conscious tradeoff (needs a `video` category the shared
  classifier doesn't have), not unowned debt — left as a note, not fixed.
- **Webviews** (the three frontend trees): a hand-rolled `Set` + notify
  listener pattern recurs at five call sites
  (`progressView/frontend/sessionSurfaces.ts`,
  `src/controllers/session/hostDraftRequests.ts`,
  `src/agent/runtime/SessionHandle.ts`,
  `src/agent/followUp/ToolUseFollowUpQueueManager.ts`,
  `packages/desktop/src/main/desktopProjects.ts`) instead of the existing,
  browser-safe `createListenerSet` (`src/utils/core/listenerSet.ts`, today
  only adopted by `TraceEmitter`). Not fixed in this pass: three of the five
  sites (`SessionHandle.ts`, `ToolUseFollowUpQueueManager.ts`,
  `hostDraftRequests.ts`) sit inside or adjacent to the run-ledger/session
  surface this window's dominant "1.0 clean slate" work is actively
  rewriting (see §0), so touching them now risks colliding with in-flight
  restructuring rather than being a clean, isolated win. Worth a follow-up
  pass once that work settles. `installWebviewTransport`'s request/response
  correlation map (`progressView/frontend/sessionTransport.ts`) has only one
  consumer today — noted as a "name it before a second caller forces a worse
  copy" candidate, not an active duplicate. `BaseWebviewApp` not being
  shared by `ProgressApp` is intentional architecture per the
  one-fold-three-renderers PRD, not overlooked duplication. All other
  classic tells (manual dedup, manual debounce/throttle,
  `JSON.parse(JSON.stringify(`, hand-rolled deep-equal, clipboard handling,
  `EventTarget` reimplementation) were absent or already routed through
  shared helpers, matching this series' 2026-09-02 through 2026-09-06
  findings.
- **Scripts, resources, prompts, Supabase, utils**: a real duplicated LaTeX
  `\criticize` color-coding macro across seven `prompts/agents/remote/workflow/*.yaml`
  files has drifted into a genuine severity-mapping bug (`criticize.yaml`
  and `enhance.yaml` gate the lowest severity on `\ifnum#2=0`, which never
  fires given the documented 1–5 severity scale, while `elevate.yaml` has
  the correct `\ifnum#2=1`), and a 15-line style-guide `itemize` block is
  duplicated verbatim across `correct.yaml`, `polish.yaml`, and
  `generic.yaml`. Both are real findings but are prompt-content fixes with
  no include/anchor mechanism available (`agentLoad.ts` parses each YAML as
  a standalone document) and land in the same prompt-authoring surface this
  window's `refactor: inline the polish prompt and delete
initializeBundledPrompts` (#12297) just touched — deferred to a
  dedicated pass rather than folded into this consolidation sweep. A
  hand-rolled flag parser in `scripts/check-effect-migration-ratchet.mjs`
  (vs. the `node:util.parseArgs` already used by
  `scripts/sync-remote-agents.mjs` in the same directory) and a ~4-line
  duplicated "current branch, treat HEAD as absent" check between
  `src/utils/git/worktreeInfo.ts` and `src/utils/git/repositoryOverview.ts`
  were both judged too thin to extract on their own (single-ternary logic,
  not the kind of real duplicated logic this series' bar requires) and were
  not fixed.

## 5. Verdict

Six days after the 2026-09-06 entry, and against a window dominated by the
large in-flight run-ledger/run-loop rewrite, the standing sweep found two
genuine, isolated, low-risk consolidation candidates outside that churning
surface — both fixed and verified in this pass (typecheck, lint, format,
targeted tests, the full suite, and the dead-code ratchet all clean). Three
further candidates (the webview listener-set duplication, the prompt YAML
macro/style-block duplication) are real but were deliberately left for a
follow-up pass because they sit inside actively-changing surfaces this
window is still rewriting; two more (the flag-parser inconsistency, the
git-branch-detection duplicate) were judged too thin to be worth a
standalone change.
