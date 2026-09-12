# Survey: code consolidation and native-method opportunities (2026-09-12)

Status: implemented
Archived: 2026-09-12

> **Status:** Written 2026-09-12 against branch HEAD `03b7e4a` (`refactor(memory):
one Effect leaf per memory file operation; delete the duplicated tryPromise
wrappers`, #12317). Scheduled routine re-ran the standing question — "find
> duplicate/similar logic to consolidate, and hand-rolled code that a native
> method or the standard library already covers" — six days after
> `2026-09-06-consolidation-and-native-methods-survey.md`. **Verdict: one
> small, isolated candidate clears the bar and is fixed in this pass, outside
> the churning "1.0 clean slate" run-model surface; a second candidate was
> reverted after review because deduping it costs more than it saves.**
> `src/tools/memory/memoryUtils.ts`'s `displayToStoragePath` hand-rolled
> absolute-path containment instead of calling the shared symlink-aware
> `relativeToRoot` helper — fixed. A `bearerToken` helper duplicated in
> `supabase/functions/github-app-token-exchange/index.ts` looked like a
> straightforward dedup against `supabase/functions/_shared/auth.ts`'s
> export, but that shared module also pulls in `@supabase/supabase-js` at
> module scope for its (unrelated, unused-here) `authenticateJwt` export —
> importing `bearerToken` from it would have added a full Supabase-client
> dependency to an OIDC-only, Supabase-free endpoint. Reverted to the local
> three-line copy; see "Correction" below.

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

**Duplicate `bearerToken` helper in a Supabase edge function — proposed,
then reverted (see "Correction" below).**
`supabase/functions/_shared/auth.ts:11-14` exports `bearerToken(req)`.
`supabase/functions/github-app-token-exchange/index.ts:50-53` defined an
identical local copy. At first glance this looked like a normal dependency
already in use: the file imports three other helpers
(`parseRepositoryClaim`, `validateWorkflowIdentity`,
`verifyGitHubActionsToken`) from a module named `./auth.ts` — but that
import is from this directory's own **local** `auth.ts` (GitHub
OIDC-claim helpers only), a different file from the **shared**
`supabase/functions/_shared/auth.ts` that exports `bearerToken`. The two
same-named modules were conflated in the first pass.

## 3. Fix

- `src/tools/memory/memoryUtils.ts`: `displayToStoragePath` now calls
  `relativeToRoot(MEMORY_STORAGE_DIR, resolved)` and checks
  `relative === undefined` instead of resolving a second `base` path and
  calling `isPathWithin` directly; the `isPathWithin` import is gone (no
  other use in the file) and `relativeToRoot` is imported from
  `@platform/defaults/nodeWorkspace`. Error message and return value are
  unchanged for every non-symlink case; a symlinked storage root now
  resolves instead of being rejected.
- `supabase/functions/github-app-token-exchange/index.ts`: unchanged from
  before this pass — the local `bearerToken` stays. See "Correction".

Verified (for the `memoryUtils.ts` fix that shipped): `npm run typecheck`
(all seven workspace/package checks) passes clean; `npx eslint` reports
zero errors; `npx prettier --check` passes; `npx vitest run memory` (26
tests, 6 files) passes; `npm run test:pure` (2335 tests) passes; `npm run
check:dead-code-ratchet` reports no new findings; the full `npm test`
(6295 tests, 591 files) passes.

**Correction (PR #12319 review):** the first pushed commit (`c356c80`)
imported `bearerToken` from `./auth.ts` — the local module, which doesn't
export it — a straight-up broken import, caught independently by both
Codex and the repo's own `texra-ai` PR review. The obvious fix looked like
pointing the import at the real owner, `../_shared/auth.ts`, and commit
`df663c1` did that. But CI's `static checks` job then failed `deno check`
for a different reason: `_shared/auth.ts` imports `@supabase/supabase-js`
at module scope for its `authenticateJwt` export, so importing anything
from that module — even just `bearerToken` — pulls the Supabase client SDK
into `deno check`'s dependency resolution, and this function's
`deno.json` never declared it (unlike `auth-device`, `get-agent-config`,
and `log-usage`, which already need `@supabase/supabase-js` for their own
`authenticateJwt` calls and declare it accordingly). Adding that
declaration would have "worked", but it means giving a Supabase-free,
GitHub-OIDC-only endpoint a transitive dependency on a full Supabase
client just to reuse a three-line header parse — a worse trade than the
duplication it removes for a function that is deliberately minimal
(`deno.json` only lists `@octokit/auth-app` and `jose` today). Reverted
instead: the local `bearerToken` copy stays, now with a comment recording
why it isn't deduped against the shared one. Net result for this
candidate: no code change, caught before merge.

Lessons for this series: (1) a same-named local module in the target
directory (`auth.ts` here, colliding with `_shared/auth.ts`) needs the
import path checked against a same-stack compiler, not visual similarity
to the export name; (2) "the export already exists in a module we import
from" is not sufficient evidence for a safe dedup when the target module
has other exports with their own dependencies — check what else the
target module pulls in at module scope before proposing the merge,
especially for a deliberately dependency-light edge function.

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
candidates outside that churning surface. One — `memoryUtils.ts`'s path
containment — was genuine, isolated, and low-risk, and is fixed and
verified in this pass (typecheck, lint, format, targeted tests, the full
suite, and the dead-code ratchet all clean). The other — the Supabase
`bearerToken` dedup — looked equally safe but, once PR review forced a
same-stack `deno check` against the actual dependency graph, turned out to
trade a three-line duplication for a real cost (an unwanted transitive
`@supabase/supabase-js` dependency on a deliberately Supabase-free
function); it was reverted rather than shipped, which is the correct
outcome for a consolidation series that only wants net wins. Three further
candidates (the webview listener-set duplication, the prompt YAML
macro/style-block duplication) are real but were deliberately left for a
follow-up pass because they sit inside actively-changing surfaces this
window is still rewriting; two more (the flag-parser inconsistency, the
git-branch-detection duplicate) were judged too thin to be worth a
standalone change.
