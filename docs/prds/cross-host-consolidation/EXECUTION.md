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

The program now spans THREE interlocking tracks: **SHAPES** (the discriminated-union
PRs), the cross-host **UI** consolidation (sub-PRDs 01-07), and the deep **CORE**
(the gold-standard runtime + the SDK boundary). The gold-standard PRD
(`2026-06-29-prd-runtime-gold-standard.md` §9) and SDK PRD
(`2026-06-29-prd-agent-sdk-boundary.md`) **supersede** the old sub-PRD 06
coordinator-collapse and **fold** sub-PRD 04 into the Descriptor work; the original
P0-P8 list is replaced by the phased queue below.

Base of the stack = tip of `codex/decouple-ui-agent-core` (#6697). When #6697
merges to main, rebase the remaining stack onto main.

### Phase A - Foundations (independent, parallelizable)

- [ ] **#6697** merges (approved).
- [ ] **Shapes** - #6720 + #6723 (vs current main); #6721 (as a plain TS DU) +
      #6722 (stacked on #6697). #6723 carries its own `mode` stamp.
- [ ] **GS-0 retry-clamp** - broaden `errors.ts` transport-error retryability +
      honor `Retry-After`/jitter, then clamp every model-handler SDK to
      `attempts:1`. Zero structural change; verifiable by attempt count; ship first.
- [ ] **SDK-1a alias-closure** - author the ts-morph alias-leak lint rule and
      reconcile the 25-of-45 `Runtime*` exports: **delete-wholesale** the shims the
      gold-standard removes (`runCoordinatorCommands`, `executionQueries`,
      `streamControl`, `modelSwitch`) vs **convert-to-projection** the ones the SDK
      surface publishes; re-type `RunAgentOptions.onBeforeWaiting`. THE no-leak
      gate; blocks the SDK Tier-2 freeze. (See the dedicated reconciliation pass.)
- [ ] **SDK-1b import-direction** - lint rule forbidding deep `@agent/runtime/*`
      in the UIs' run-driver tier + make the 3 UIs import `@texra/core` (today: zero
      do).
- [ ] **P0 drift bugs** - the 3 in `00-overview.md` (desktop delete-all,
      `warning` severity, workflow auto-open).

### Phase B - Cross-host UI + the SSOT seam

- [ ] **CH-01 (sub-PRD 01)** - desktop adopts the shared progressView controllers.
- [ ] **GS-1 RunDescriptor (additive)** - build it in `assembleAgentLaunchContext`
      alongside today's context. The Step-1 phase gate (`FlowRecord` never
      references descriptor fields) IS the SDK serialization fence.
- [ ] **SDK-1c bus-promotion** - promote `ProgressEventPayloads` ->
      `RuntimeEventPayloads`/`HostUiEventPayloads`; seal the run `bus`; `HostUiBus`
      for non-run signals (preserve the `MAX_BUFFER_SIZE` replay).
- [ ] **CH-07-slice (sub-PRD 07 Phase A)** - status + display-identity projection
      (consumes #6722 + the carried name); fixes the renderer-reload parity bug.
- [ ] **S1 simplifier** over Phase A+B changed files.

### Phase C - The deep core (gold-standard Strangler, sequenced)

- [ ] **GS-2 ModelCell** - route model / `withModelClient` / `switchModel` through
      it; lockstep-swap the 2 bridge-node `{...this.services}` spreads.
- [ ] **GS-3 PendingRequests** - 3 coordinators -> one registry + config table +
      slim `(kind,id)->session` routing index. **Supersedes** sub-PRD 06's
      coordinator slice. Collapses only the inquiry _coordinator plumbing_ (one of
      the 3 deferred coordinators); the host-aware inquiry decision policy stays
      owned by sub-PRD 05 (CH-05), not absorbed.
- [ ] **GS-4 retry-two-owners** - `RetryPolicy` + `RetryGate`; human wait stays
      in-node; touches the shared `ModelInvocationNode` (both flow families, one
      commit).
- [ ] **S2 simplifier** over Phase C so far.
- [ ] **GS-5 RoundFlow** - unify `PersistedFlow`/`RoundPersistedFlow`; `FlowRecord`
      versioning + replay shim (highest risk; 5a/5b/5c, resume-migration gated).
- [ ] **GS-6 Descriptor + ambient-shrink** - `RunDescriptor` as the `Svc` SSOT;
      5-field `ToolRunContext`; restrict `currentSession()` to host-entry; delete
      `agentContextToRunContext`. **Absorbs** only 04's resolved-name field-carry
      (`config.agent` stays raw); 04's branding / display-repoints / resume-id trap
      ship as CH-04.
- [ ] **CH-04 (sub-PRD 04)** - the two-brand identity boundary
      (`RawAgentIdentifier` vs `ResolvedAgentName`) + the display-consumer repoints + the resume-id-contract trap + the quick-win deletions. Sequence with/after
      GS-6 (which owns the field-carry).

### Phase D - SDK packaging + the remainder

- [ ] **SDK-1d package** - real build (`.d.ts` via `tsc-alias`/`tsup`), drop
      `private`, subpath `exports`, `createNodePlatform()` at `./node`, author the
      `AgentRunHandle` interface. (Sequencing per this runbook: 1d lands last, after
      the internal migration settles - supersedes the SDK PRD's "all-four-first"
      framing.)
- [ ] **CH-05 (sub-PRD 05)** - the host-aware external-inquiry decision policy
      (`onEmpty: keepOpen | drop`), consuming #6723's `mode` union. After #6723 and
      GS-3 (which collapses only the coordinator plumbing).
- [ ] **CH-02 / CH-03 (sub-PRDs 02, 03)** - stream-resume + settings registries
      (orthogonal; interleave anywhere in B-D).
- [ ] **06 CLI inline culls** - the 2 CLI resolve-stack/agent-trio inlines (after
      GS-6).
- [ ] **S3 simplifier** over Phase D.
- [ ] **Gated, declinable (last)** - SDK-002 (widen `RunAgentOptions` to one verb) + F-1 (`session.hostChannel` host-path routing), each behind the headless
      byte-parity gate. Ship single-session embeddable first.

Each phase preserves the resume-id contract (`config.agent` raw) and headless
parity (`noopAgentRuntimeHost` reduces with zero subscribers).

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
