---
created: 2026-06-28
---

# Execution Mechanism: Stacked, Worktree, Bot-Reviewed PRs

This runbook drives the cross-host consolidation backlog to completion. It is
written so execution can resume mechanically after a context compaction. The
authoritative plan lives here; current position is tracked in the Queue checklist
below and mirrored in the `cross-host-consolidation-execution` memory.

## Principles

- One sub-PRD (or simplifier pass) per PR. Each PR is small and independently
  reviewable.
- Every PR is built in its own git worktree, stacked on the previous PR's branch.
- Every PR is opened on GitHub and gated on the review bots before it is treated
  as ready. We do not self-approve away the bots.
- A code-simplifier / refactor pass is inserted on a fixed cadence (after every
  two feature PRs).
- The maintainer merges. We get each PR to "green CI + bot findings addressed",
  then stop and report.

## Queue (ordered; check off as merged)

Base of the stack = current tip of `codex/decouple-ui-agent-core` (the approved
decouple PR #6697). When #6697 merges to main, rebase the remaining stack onto
main with `git rebase --onto main <old-base> <branch>`.

- [ ] **P0 Drift-bug fixes** - the 3 bugs in `00-overview.md:64-78` (desktop
      delete-all stop+reselect, dropped `warning` severity, workflow auto-open
      output choice). Tiny, behavior-correcting, no PRD needed.
- [ ] **P1 Sub-PRD 01** - desktop adopts the shared progressView controllers.
- [ ] **S1 Simplifier pass** over P0+P1 changed files.
- [ ] **P2 Sub-PRD 07 Phase A** - make `ProgressViewState` subscribable; fold
      status / pending approvals / ephemeral counters into the projection (fixes
      the renderer-reload prompt parity bug). NOT the full delta-patch rewrite.
- [ ] **P3 Sub-PRD 03** - grouped settings command-handler registries.
- [ ] **S2 Simplifier pass** over P2+P3.
- [ ] **P4 Sub-PRD 02** - one `requestRuntimeStreamResume` command.
- [ ] **P5 Sub-PRD 05** - external-inquiry resolution policy into runtime.
- [ ] **S3 Simplifier pass** over P4+P5.
- [ ] **P6 Sub-PRD 04** - agent-identity resolve-once (carry the resolved name).
- [ ] **P7 Sub-PRD 06** - reduce the `resolve*` surface (coordinator family +
      dead/synonym deletes + AGENTS.md convention).
- [ ] **S4 Simplifier pass** over P6+P7.
- [ ] **P8 Sub-PRD 07 Phase B** - the `ProgressViewDelta` patch type + delete
      the frontend mirror reducer. Largest; gate on Phase A landing.

Parallel track (maintainer-owned, coordinate, do not duplicate): the
discriminated-union PRs #6720/#6721/#6722 and issue #6704.

## Per-PR procedure

1. **Worktree off the stack tip.**
   `git worktree add ../texra-wt-<slug> <prev-branch>` then create
   `git switch -c consolidation/<NN>-<slug>` inside it. Symlink node_modules so
   typecheck/tests run: `ln -s <main-checkout>/node_modules ./node_modules`
   (and per-package node_modules if needed). Subagents working in the worktree
   must be given the ABSOLUTE worktree path + a `cd <worktree>` prefix + a branch
   assertion (subagents spawned after a worktree still default to the original
   checkout).
2. **Implement** the sub-PRD's Scope. Keep it to that PR's scope only.
3. **Gate:** `npm run typecheck`, the targeted vitest files, and
   `npm run check:runtime-boundaries`. Fix until green.
4. **Commit** with `--no-verify` (the pre-commit prettier hook aborts the first
   commit otherwise). Worktree agents must commit and report their SHA or the
   work is lost when the worktree is reaped.
5. **Push** the branch; open a stacked PR:
   `gh pr create --base <prev-branch> --head consolidation/<NN>-<slug>`.
   (For P0, base is the stack base.)
6. **Bot-review gate.** Poll `gh pr checks <pr>` and
   `gh pr view <pr> --json reviews,comments`. The reviewers are
   claude-review-anthropic, claude-review-deepseek, Cursor Bugbot, plus the
   `review` + `validate (linux)` + `webview smoke` CI jobs. Re-enqueue
   flaky-shaped CI (timeout/runner); fix real findings.
7. **Address** every substantive bot finding: commit + push to the same branch,
   re-poll until CI is green and bot threads are resolved. Resolve threads via
   the GitHub GraphQL `resolveReviewThread` mutation.
8. **Stop and report**; the maintainer merges. The next PR's base becomes this
   branch (or main once this one merges, then rebase the stack).

## Simplifier pass procedure

After every two feature PRs, run a code-simplifier over only the files those PRs
touched (not the whole repo). Cap concurrency at ~5 agents on disjoint file
batches (15 once tripped a rate limit); central typecheck after; one PR. This is
itself a stacked, bot-reviewed PR.

## Worktree hygiene

- Build artifacts: worktrees need node_modules symlinked; the CLI bundler runs
  from `packages/cli`.
- Clean up reaped worktrees: `git worktree prune`.
- Never move files under a running workflow; stop, move, resume.
- Recover a dropped `stash -u` via its `^3` tree if needed.

## Driving it

This pipeline is advanced one PR-step per turn. It is a good fit for `/loop`:
each tick either (a) starts the next queue item in a worktree, or (b) checks the
current PR's bots and addresses findings. After a compaction, read this file +
the `cross-host-consolidation-execution` memory, find the first unchecked queue
item and the open PR (if any), and continue from there.

## Decisions assumed (change if wrong)

- Stack base is `codex/decouple-ui-agent-core` until #6697 merges, then main.
- We get PRs review-clean and stop; the maintainer merges (do not auto-merge).
- coauthor's own review job stays approval-policy=never (secret-bearing).
