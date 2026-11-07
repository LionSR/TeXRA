---
created: 2026-11-03
status: proposed (item 1 done 2026-11-05, #14742; item 2 done 2026-11-07)
---

# Overlapping responsibilities: git reads and subscription provider facts

Scheduled responsibility audit at `7a9451c`. Nothing was changed in code: the
audit sandbox had no installed dependencies, so no edit could be type-checked.
The codebase's package boundaries are otherwise well defined; the two overlaps
below are the significant ones found.

## 1. The same git reads are written in several places (most significant)

Done: `packages/texra/src/utils/git/gitReads.ts` owns the five reads. The
CLI's read helpers, latexdiff's root lookup and the subscription tool's
runner are deleted, and a bare repository is not a repository for
`install-github-action` either (there is no work tree to write the workflow
into). `workspaceInfo.ts` keeps its documented difference. The table below is
the state the audit found.

| Read                                                      | Where it is written                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "is this a work tree" (`rev-parse --is-inside-work-tree`) | `packages/texra/src/utils/git/isGitRepository.ts` (success and stdout `true`); `packages/cli/src/runtime/gitOps.ts` `isGitRepo` (success only); `packages/harness/src/agent/prompt/workspaceInfo.ts` `getGitInfo` (success only, deliberately, with a comment explaining why) |
| origin URL, current branch, origin default branch         | `packages/cli/src/runtime/gitOps.ts` (`remoteUrl`, `currentBranch`, `defaultBranch`); `packages/texra/src/tools/github/githubSubscriptionTool.ts` (`gitInDir` with `remote get-url origin`, `rev-parse --abbrev-ref HEAD`, `symbolic-ref --short refs/remotes/origin/HEAD`)   |
| repository root                                           | `packages/cli/src/runtime/gitOps.ts` `repoRoot`; `packages/texra/src/latex/latexdiff.ts` (`rev-parse --show-toplevel`)                                                                                                                                                        |
| a local `git` runner wrapper                              | `gitOps.git`, `githubSubscriptionTool.gitInDir`, `repositoryOverview.readGit`, `pluginGit.git`, `workspaceInfo.runGit`                                                                                                                                                        |

Why it matters: the copies already disagree. In a bare repository or inside
`.git`, the texra probe answers false while the CLI probe answers true, so
`install-github-action` and the GitHub plugin's availability check disagree
about the same directory. Detached HEAD is handled three ways: `null` in the
CLI, an explicit `ToolError` in the subscription tool, and `branch: null` in
the prompt block. A fix to any one (timeouts, git identity from `settings`,
Windows quoting) has to be found and repeated in each.

Proposed change (one PR, `refactor:`):

- `packages/texra/src/utils/git/` becomes the one owner of the host-neutral
  reads: `isGitRepository`, plus `repositoryRoot`, `originUrl`,
  `currentBranch` (null when detached) and `originDefaultBranch`, each
  returning a plain value and taking `(cwd, settings)`.
- `packages/cli/src/runtime/gitOps.ts` keeps the `git` runner (for the writes
  in `installGithubAction.ts`), `gh`, `ghAvailable` and `localBranchExists`;
  its five read helpers (`isGitRepo`, `repoRoot`, `remoteUrl`,
  `currentBranch`, `defaultBranch`) are deleted and `installGithubAction.ts`
  imports the texra ones with `settings: undefined`.
- `packages/texra/src/latex/latexdiff.ts` drops its own
  `rev-parse --show-toplevel` lookup for `repositoryRoot`.
- `githubSubscriptionTool.ts` calls the same reads and keeps its own error
  wording for the failure cases it reports.
- `workspaceInfo.ts` stays in the harness (it may not import the app) and keeps
  its documented difference; the PR notes that it is the one intended
  exception.

Decision to make first: whether a bare repository counts as "a repository" for
`install-github-action`. The shared probe says no; the CLI currently says yes.

Net elements target: delete five read helpers in `gitOps.ts`, the root lookup
in `latexdiff.ts` and one runner in the subscription tool; add none beyond the
four new reads. Before landing, run
`npm run typecheck`, `npm run test:changed` and `npm run check:dead-code-ratchet`.

## 2. Subscription provider facts: two files share a name

Checked again against `main` after #14598, which moved the display names out
of the harness.

- `packages/harness/src/shared/model/subscriptionAuth.ts`: the provider ids
  (`SUBSCRIPTION_AUTH_PROVIDERS`); its doc leaves what a person calls each
  subscription to the app.
- `packages/texra/src/shared/model/subscriptionAuth.ts`: the sign-in status
  schema and account labels (`codexAccountLabel`, `xaiAccountLabel`). Same
  file name, unrelated contents; import paths differ only by `@shared` versus
  `@texra/shared`.
- `packages/harness/src/model/subscriptionAccess.ts`: the config key of each
  provider's "prefer subscription" switch.
- The names a person reads: `displayName` in
  `packages/texra/src/controllers/modelAccess/subscriptionProviders.ts` and
  `SUBSCRIPTION_AUTH_COPY` in `packages/texra/src/ui/copy/accountAuth.ts`.

The coding plans (`kimiCode`, `glmCodingPlan`) are a separate set:
`packages/texra/src/shared/model/codingPlans.ts` and `subscriptionUsage.ts`
describe them, not the sign-in providers above.

Why it matters: the identical name invites importing the wrong module.
Done: the texra file is now `packages/texra/src/shared/model/subscriptionStatus.ts`
(six importers). Smaller and less urgent than item 1.

## Not found

No duplicate exported function names across packages beyond overloads. The
`toErrorMessage` in `packages/llm/src/oauth/support.ts` repeats the name of the
harness one with a simpler body, but `llm` sits below the harness and cannot
import it, so that is intended.
