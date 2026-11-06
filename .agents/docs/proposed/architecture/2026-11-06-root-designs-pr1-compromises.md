# Root designs, PR 1: the compromises and red flags on record

Date: 2026-11-06
Status: open (the follow-ups below are unassigned)
Origin: the owner's request, after PR 14769 landed R1 to R5, R7 and R8 of
the root designs (`2026-11-05-root-designs-effect-native.md`, PR 14766), to
look deep and record every compromise the cut made. Reviewed on
`simplify/session-core` at `17e786a`, commits `b34150d` (R5), `beb0f9e` (R7)
and `17e786a` (R8), by two independent read-only reviews and the author's
own pass against `AGENTS.md` "Design guardrails" and the code-review
checklist. The fixes a review produced landed in the same PR (`fixed`); the
rest is a compromise, named with what it costs and what would end it.

## 1. Compromises against the note's design

Each item: what the note asked, what landed, why, and what ends it.

1. **The TUI still decides through `request.decide`** (R7 asks every host to
   attach `approve`). Landed: the headless CLI attaches a `SessionHost` with
   `approve`; the TUI keeps its surface (`packages/cli/src/chat/tui/state/approvalQueue.ts`:
   `decided`, `markDecided`, `reopenRequest`, `issue`, `stagePresentation`,
   `dropPresentation`, `presentedOrder`, `promoted`, `useHostCapability`).
   Why: the modal's "approve and stop asking" is a `policy.set` the handler
   would have to issue beside its decision, and the own-key retry lands its
   decision through `ProgressApiKeyRetryController`; moving both onto one
   `approve` fiber is the hosts' PR's work (R6+R10). Ends with: the TUI
   `approve` handler that stages a request on a signal with a `Deferred`, so
   the card is on screen exactly while its fiber runs.
2. **Agent-CLI threads: one turn per call, a busy thread refuses** (R5 asks
   for a process child whose turn is `strategy.runTurn(batch)` with the
   thread id as a `plugin.fact`). Landed: each `codex`/`claude_code` call is a
   new run of one turn; a later call with the thread id continues the thread
   as a new run; a thread whose turn still runs here is refused
   (`AgentCliSessionRegistry.claim`). Why: a resume of a process run would
   need the plugin to rebuild its turn from a fact, a plugin door the note
   did not design. Costs: the old "queue behind the running turn" is gone;
   the model is told to wait for the result. Ends with: a plugin-declared
   process program (`Plugin.processRun(identity, facts)`) the resume routes
   process identities to, if a second turn on a run is ever worth a run.
3. **A grant answers open requests, not queued ones; descendants added**
   (R7). The lanes went, so every prompt opens at once; a grant turned on
   answers the open requests it covers in its own transaction
   (`approvalsUnder`), the run's own and its descendants' whose grants
   follow it (fixed in review: the first cut answered the changed run alone,
   which lost the old lane-head re-check for a descendant's queued prompt).
   The view the descendant walk reads can lag a child born in the same
   second; that child's request is then approved at its own open
   (`grantAnswers`). Costs: two readings of "a grant answers this kind"
   remain, `sessionPermission`'s before a request opens and `grantAnswers`'
   as it opens; see §3.
4. **Denials are rows, so the headless CLI no longer warns on stderr**
   (R7). `warnApprovalDenied` and its messages went with `approvalDenied`;
   the reason is on the `request.decided` row and in the tool result the
   model reads. Costs: an operator of a headless run sees "Command denied"
   only through the transcript, not a `[warn]` line. Ends with: the CLI's
   progress projection rendering a denied `request.decided` as a notice.
5. **R8 landed its first half.** One scoped program, no bag, no cohort, no
   `holds`. Not landed: `WorkspaceFs`/`StorageFs`/`WorkspaceRoots` (the
   controllers' tag) as fields of one `SessionRoots`; `SessionViewService`
   as a second view tag; `Interactions` as `SubscriptionRef` + `Queue.sliding`
   (the class keeps its replay array and `use`); `RunCallShape.session` as
   `runs` (built-ins would need the table's one cast); `ToolEnv.run`. Why:
   each is a cross-package sweep (13+ files for the rooted filesystems) with
   no structural gain inside the harness; they belong with the hosts' PR.
6. **`ToolPolicy.oneShot` beside `stopAfterCycle`** (two fields for one
   decision, `packages/harness/src/agent/runtime/run/AgentRun.ts`). Every
   child is `stopAfterCycle` now, so a tool can no longer read "no later turn
   reaches this run" off it; `oneShot` is that fact (`stopAfterCycle && parent
   === null`), derived once in `executeAgent`, because a tool holds no parent
   edge. Costs: a derivable column. Ends with: the tool call reading its
   run's parent edge from `RunCall`, which R8's second half may carry.
7. **A background child resumed by a delivery reports twice.** A child that
   launched a background command ends and reports; the command's result
   queues on the ended child, the registry wakes it, it runs one more cycle
   and reports again under a new delivery id (`${runId}:${activation}`).
   This is the accepted default ("a background child's second message is a
   resume"); the parent can tell the two reports apart by id and content.
   Recorded because the old loop delivered one report per turn of a
   long-lived child and never a second "result".
8. **A one-shot root is not shielded from a late message.** The harness no
   longer refuses a message to a one-shot run (`submitFollowUp`'s refusal
   went, so a child's `executions send` joins the root's cycle, as the golden
   store now shows). A message that lands after such a root ended wakes it
   (`wakeIfOwed`) and the resume runs it as an interactive root. The headless
   CLI closes its session when the root ends, so nothing wakes there; an SDK
   embedder holding a session open after a one-shot `start` would see the
   root resume. Ends with: `wakeIfOwed` reading `run.start.userFollowUpSupport`
   (`unsupported` for a one-shot root) before resuming.
9. **A background child left interrupted by a crash is nobody's to resume.**
   `resumeLeftoverChildren` resumes a parent's cut-short children as the
   parent resumes; a background child whose parent ended first stays
   interrupted until a person resumes it (listed as such). The old loop's
   `closeLeftoverChildren` had the same reach.
10. **Erased suites.** `ChildRunLoop`, `ChildRunProgressEvents`,
    `DelegationHeadless`, `ClaudeAgentResumeFallback`, `ApprovalAdapter`
    were pinned to the retired loop, the retired CLI queueing and the ask
    door. What still covers their contracts: the golden store (a Codex child
    detached while running, a background command's `process.output`/`exit`
    /report/delivery), the `child-results` crash scenario (a child's end and
    its parent's delivery, exactly once), `BashApprovalPrompt` (a grant
    answering an open request), `TuiApprovalRetry`, the TUI smoke's
    `edit-approval` and `agent-proposal-approve-all`. Not covered any more:
    the headless adapter's prompt-to-decision path end to end (the harness's
    `answerRequests` loop has no suite of its own).

## 2. Red flags the review found and fixed in the PR

- `processRun.ts`: an end the store refused after a failed open was swallowed
  (`Effect.ignoreCause`, M2). Fixed: logged at warn on the `processRun`
  channel; the run reads as interrupted.
- `requestAnswerer.ts`: a decision the session refused (`Unavailable`) was
  swallowed silently (M2); fixed: said at info with the reason, then held
  until the view drops the request.
- `ProcessExitSchema.signal` was a column nothing writes (a constant column
  is a special case as data). Fixed: dropped; `code: null` says the command
  had no exit code of its own.
- `approvalsUnder` answered the changed run alone (§1.3). Fixed: the
  descendants whose grants follow it too.

## 3. Red flags that stand

- **Repetition.** "A grant answers a request of this kind" is read twice:
  `sessionPermission` (`loop/toolGuard.ts`) before a request opens, and
  `grantAnswers` (`agent/runtime/requests.ts`) as it opens, for the race
  between the two. One owner: `openRequest` could take the policy's reading
  from the guard as data; left for the hosts' PR with the request's
  `answeredBy`.
- **Two readings of "cut short".** `leftoverChildren.cutShort` and
  `agentChild.standingOf` both decide "no end, or the end a clean close's
  stop wrote" from `RunRows`. One predicate on `RunRows` would own it.
- **`ToolPolicy.oneShot`** (§1.6): a derivable column.
- **`reportInterrupted`'s delivery id** carries an `:interrupted` suffix the
  end's `${runId}:${activation}` does not; the executions tool's `wait`
  consumes both by prefix. Two id shapes for one lifecycle's deliveries.
- **`check-guidance-refs.mjs` `NOT_ROWS`**: a two-entry exclusion list for
  Node's `process` global, since `process.*` is now a row namespace. A list
  by name is a special case written as data; the checker could instead
  require a cited row to exist in the vocabulary before reading a token as a
  citation.
- **`AgentCliSessionRegistry`** is a `Set<string>` with a `claim` that returns
  a release: a shallow module kept as a service tag per plugin
  (`CodexThreads`, `ClaudeAgentSessions`) so the session layer owns its
  lifetime. A `Context.Reference` on the plugin's session layer would be the
  same with less.
- **`USER_FOLLOW_UP_SUPPORT`** is now two values (`unsupported`,
  `nativeInteractive`) for one boolean fact, carried on `run.start`; the
  harness enforces neither (`acceptsFollowUp` is a view affordance). One
  fact, one representation would make it a boolean, or delete it once
  §1.8's `wakeIfOwed` check is the one reader.

## 4. Follow-ups

- Hosts' PR (R6+R10): §1.1 (TUI `approve`), §1.5 (R8's second half), §1.4
  (denied-request notice), §3's `answeredBy`.
- Harness, small: §1.8 (`wakeIfOwed` and a one-shot root), §3's one
  `cutShort` predicate, one delivery-id shape, `USER_FOLLOW_UP_SUPPORT` as a
  boolean.
- Open question: whether a second turn on a process run is worth a run
  (§1.2); until then the thread is the provider's and the run is the turn.
