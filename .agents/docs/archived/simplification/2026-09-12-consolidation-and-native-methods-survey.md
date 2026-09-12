# Survey: code consolidation and native-method opportunities (2026-09-12)

Status: implemented
Archived: 2026-09-12

> **Status:** Written 2026-09-12 against branch HEAD `03b7e4a` (`refactor(memory):
one Effect leaf per memory file operation; delete the duplicated tryPromise
wrappers`, #12317). Scheduled routine re-ran the standing question — "find
> duplicate/similar logic to consolidate, and hand-rolled code that a native
> method or the standard library already covers" — six days after
> `2026-09-06-consolidation-and-native-methods-survey.md`. **Verdict: two
> candidates were proposed; both were reverted after PR review (#12319) found
> a real cost neither the original survey nor local validation caught. No
> code shipped from this pass.**
>
> - `src/tools/memory/memoryUtils.ts`'s `displayToStoragePath` hand-rolled
>   absolute-path containment instead of calling the shared symlink-aware
>   `relativeToRoot` helper. Looked like a clean behavior-preserving
>   consolidation (plus a symlink-support improvement) and passed every local
>   check (typecheck, lint, format, the full test suite). A security-focused
>   PR reviewer then pointed out that `relativeToRoot`'s realpath fallback
>   (`canonicalizeWorkspacePath`) calls synchronous `realpathSync` on a path
>   the original code never touched the filesystem for — and the memory
>   tool's path argument is model-controlled with no absolute-path
>   pre-filter, so a crafted `/memories/\\server\share\x` on a Windows host
>   could force a blocking SMB lookup (a known UNC-path attack class:
>   NTLM-hash leakage / DoS). Reverted to the original implementation.
> - `supabase/functions/github-app-token-exchange/index.ts` reimplemented
>   `bearerToken`, already exported by `supabase/functions/_shared/auth.ts`.
>   The first attempt imported from the wrong same-named local `auth.ts`
>   (a broken import, caught by CI and two review bots); the corrected import
>   then failed CI's `deno check` because the shared module transitively
>   requires `@supabase/supabase-js`, which this deliberately
>   Supabase-free, GitHub-OIDC-only function doesn't declare. Reverted to the
>   original local three-line copy, now with a comment recording why it
>   isn't deduped.
>
> Full narrative in §2–3 below. This entry is archived as a completed pass
> even though nothing shipped: the record of what was tried, why it looked
> safe, and why it wasn't is the useful output, and both reversions are
> pinned so a future pass doesn't repeat them without re-deriving the same
> two lessons.

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

## 2. What was found, tried, and reverted

### 2a. `memoryUtils.ts` — hand-rolled path containment vs. the shared helper

`src/tools/memory/memoryUtils.ts`'s `displayToStoragePath` built
`path.resolve` + `path.relative` + `isPathWithin` by hand to validate a
memory path stays under `MEMORY_STORAGE_DIR`.
`src/platform/defaults/nodeWorkspace.ts`'s `relativeToRoot` already does the
same containment check _and_ additionally falls back to a
symlink-canonicalized comparison (`canonicalizeWorkspacePath`) when the
lexical check fails — the exact helper `src/tools/pathResolution.ts:131-135`
calls out in a comment as "the shared symlink-aware absolute-path
containment helper" and `src/utils/files/workspaceFS.ts:44` already uses.
Grepping every `isPathWithin` call site showed `memoryUtils.ts` was the only
remaining caller building the containment sequence by hand.

**Tried:** routed `displayToStoragePath` through `relativeToRoot`, removing
the local `isPathWithin` sequence. Passed `npm run typecheck` (all seven
workspace/package checks), `npx eslint`, `npx prettier --check`, `npx
vitest run memory` (26/26), `npm run test:pure` (2335/2335), `npm run
check:dead-code-ratchet`, and the full `npm test` (6295/6295) — every check
this session could run locally.

**Reverted after review:** none of those checks exercise the
security-relevant difference. The old code's lexical `isPathWithin` never
touches the filesystem for a path outside the root; `relativeToRoot`'s
fallback calls `realpathSync` on the path before rejecting it. A PR
reviewer pointed out that `MemoryTool.run`'s `locate` closure
(`src/tools/memory/MemoryTool.ts:215-222`) passes the model's raw tool-call
argument straight into `displayToStoragePath` with no absolute-path
pre-filter — only a `/memories`-prefix string check
(`memoryUtils.ts:22-25`), which a value like
`/memories/\\attacker-host\share\x` still satisfies. `path.resolve` treats
an absolute (or, on Windows, UNC-rooted) suffix as replacing the base
entirely, per Node's documented last-absolute-argument-wins behavior, so
`resolved` becomes the raw attacker string regardless of `MEMORY_STORAGE_DIR`.
The old code's `isPathWithin(base, resolved)` then just returns false
(string comparison, no I/O) and throws. The new code's `relativeToRoot`
falls through to `canonicalizeWorkspacePath`, which calls `realpathSync` on
that same attacker string before it can return `undefined` — on Windows,
`realpathSync` on a UNC path is a synchronous, blocking SMB connection
attempt to a host the model chose, a known attack class (NTLM-hash
relay/leak via forced authentication, or event-loop-blocking DoS if the
host doesn't respond). This is a real regression: the old function never
performed I/O on a rejected path, and the new one does.

This is not a defect in `relativeToRoot` itself — `pathResolution.ts`'s own
existing use of it (`pathResolution.ts:135`) has the same shape for
arbitrary absolute tool paths, so the underlying question of whether that
call site needs a pre-filter is a separate, repo-wide concern outside a
routine consolidation sweep's scope to decide unilaterally. For
`memoryUtils.ts` specifically, the safe choice was to revert: the original
implementation is restored verbatim (confirmed via `git diff origin/main`
showing zero diff on this file), and the "let's dedupe this" attempt is
recorded here so it isn't retried without addressing the pre-filter
question first.

### 2b. Duplicate `bearerToken` helper in a Supabase edge function

`supabase/functions/_shared/auth.ts:11-14` exports `bearerToken(req)`.
`supabase/functions/github-app-token-exchange/index.ts:50-53` defined an
identical local copy. This looked like a normal dependency already in use:
the file imports three other helpers (`parseRepositoryClaim`,
`validateWorkflowIdentity`, `verifyGitHubActionsToken`) from a module named
`./auth.ts` — but that import is from this directory's own **local**
`auth.ts` (GitHub OIDC-claim helpers only), a different file from the
**shared** `supabase/functions/_shared/auth.ts` that exports `bearerToken`.
The two same-named modules were conflated in the first pass.

**Tried (attempt 1, commit `c356c80`):** imported `bearerToken` from the
wrong module (`./auth.ts`, the local one, which doesn't export it) — a
straight-up broken import. Local validation (`npm run typecheck`, `npx
eslint`, `npx prettier`) could not catch this: Supabase edge functions are
Deno projects outside the pnpm workspace's `tsc`/ESLint scope, checked
instead by CI's dedicated `deno check` step, which this session has no
local `deno` binary to run (and the sandboxed network policy blocked
fetching one). Caught independently by both Codex and the repo's own
`texra-ai` PR review within minutes of the PR opening.

**Tried (attempt 2, commit `df663c1`):** pointed the import at the real
owner, `../_shared/auth.ts`, matching the three other edge functions
(`auth-device`, `get-agent-config`, `log-usage`) that already import
`bearerToken` that way.

**Reverted after CI (`static checks (linux)`, `deno check`):**
`_shared/auth.ts` imports `@supabase/supabase-js` at module scope for its
`authenticateJwt` export, so importing anything from that module — even
just `bearerToken` — pulls the Supabase client SDK into `deno check`'s
dependency resolution. `github-app-token-exchange/deno.json` only declares
`@octokit/auth-app` and `jose`; it never needed a Supabase client because
this endpoint verifies GitHub's OIDC tokens, not Supabase JWTs. Declaring
`@supabase/supabase-js` would have made `deno check` pass, but it means
giving a deliberately Supabase-free, minimal-dependency endpoint a
transitive dependency on a full Supabase client SDK just to reuse a
three-line header parse — a worse trade than the duplication it removes.
Reverted to the local `bearerToken` copy (confirmed unchanged behavior),
now with a comment recording why it isn't deduped against the shared one.

### Lessons for this series

1. A same-named local module in the target directory (`auth.ts` colliding
   with `_shared/auth.ts`) needs the import path checked against a
   same-stack compiler, not visual similarity to the export name.
2. "The export already exists in a module we could import from" is not
   sufficient evidence for a safe dedup when the target module has other
   exports with their own dependencies (`authenticateJwt`'s
   `@supabase/supabase-js` import) or other code paths with different
   trust assumptions (`relativeToRoot`'s realpath fallback, safe for a
   validated workspace root, live for a model-controlled tool argument with
   no absolute-path pre-filter). Passing typecheck/lint/test is necessary
   but not sufficient for a security-relevant path or dependency-boundary
   change — those need a reviewer (or a repo-specific security checklist)
   looking at what changed about _when I/O or a new dependency gets
   pulled in_, not just whether the output is the same on the happy path.
3. For a scheduled, unattended routine specifically: when a PR reviewer
   raises a plausible security concern on a change this pass cannot fully
   resolve within its own scope (here, whether `pathResolution.ts`'s
   existing absolute-path handling needs a UNC/absolute pre-filter is a
   separate, repo-wide question), the correct move is to revert and record
   it, not to argue the risk down to keep a "nice-to-have" consolidation
   that fixes no active bug.

## 3. What was checked and ruled out

- **Platform/hosts/storage** (`src/platform/`, `src/hosts/`,
  `src/common/storage/`, per-host platform implementations): already
  thoroughly consolidated — shared secrets (`secretsGet`), shared
  composition helpers (`createNodePlatform`, `createNodeWorkspaceRoots`,
  `openTexraConfigStores`), `node:crypto`-backed ID hashing, no
  migration/compatibility readers for internal formats, no `.catch()`
  masking corrupted persisted state. One trivial, low-confidence,
  not-worth-a-standalone-change item noted
  (`packages/desktop/src/main/platform/paths.ts`'s `isExistingDirectory`
  could use `statSync(..., { throwIfNoEntry: false })` instead of a
  try/catch — purely stylistic, same behavior) and left unfixed.
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
  `\criticize` color-coding macro across seven
  `prompts/agents/remote/workflow/*.yaml` files has drifted into a genuine
  severity-mapping bug (`criticize.yaml` and `enhance.yaml` gate the lowest
  severity on `\ifnum#2=0`, which never fires given the documented 1–5
  severity scale, while `elevate.yaml` has the correct `\ifnum#2=1`), and a
  15-line style-guide `itemize` block is duplicated verbatim across
  `correct.yaml`, `polish.yaml`, and `generic.yaml`. Both are real findings
  but are prompt-content fixes with no include/anchor mechanism available
  (`agentLoad.ts` parses each YAML as a standalone document) and land in
  the same prompt-authoring surface this window's `refactor: inline the
polish prompt and delete initializeBundledPrompts` (#12297) just touched
  — deferred to a dedicated pass rather than folded into this consolidation
  sweep. A hand-rolled flag parser in
  `scripts/check-effect-migration-ratchet.mjs` (vs. the `node:util.parseArgs`
  already used by `scripts/sync-remote-agents.mjs` in the same directory)
  and a ~4-line duplicated "current branch, treat HEAD as absent" check
  between `src/utils/git/worktreeInfo.ts` and
  `src/utils/git/repositoryOverview.ts` were both judged too thin to
  extract on their own (single-ternary logic, not the kind of real
  duplicated logic this series' bar requires) and were not fixed.

## 4. Verdict

Six days after the 2026-09-06 entry, and against a window dominated by the
large in-flight run-ledger/run-loop rewrite, the standing sweep found two
candidates outside that churning surface — and both were wrong to ship, for
two different reasons neither the survey nor this session's local
validation could catch: a security-relevant behavior change
(`memoryUtils.ts` newly performing realpath I/O, including a synchronous
network call on Windows, on a model-controlled path that used to be
rejected lexically with no I/O) and a dependency-boundary cost (pulling a
Supabase client SDK into a Supabase-free edge function). Both were reverted
to their original implementations in PR #12319, which ships no code change
— only this record and, on the Supabase side, an explanatory comment. That
is the correct outcome for a consolidation series whose bar is "net win
after review," not "passed local checks." Three further candidates (the
webview listener-set duplication, the prompt YAML macro/style-block
duplication) are real but were deliberately left for a follow-up pass
because they sit inside actively-changing surfaces this window is still
rewriting; two more (the flag-parser inconsistency, the git-branch-detection
duplicate) were judged too thin to be worth a standalone change.
