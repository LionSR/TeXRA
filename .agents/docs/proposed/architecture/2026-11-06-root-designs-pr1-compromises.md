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
   root resume. Ended in review: `submitFollowUp` refuses a run whose
   `run.start.userFollowUpSupport` is `unsupported` (a headless one-shot
   root, a process child) before it queues.
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

A second round, two independent reviews of the three commits as landed:

- A grant-carrying approve (the modal's "approve and stop asking") was two
  requests, `request.decide` then `policy.set`, so the decision could land
  refused when the grant's transaction answered the request first. Fixed:
  `Approvals.decideUnder` writes the decision and the grant's rows in one
  transaction, the decided request excepted from the grant's sweep.
- The headless answerer held a request forever after the session refused
  its decision (`Unavailable`: said, then `Effect.never`). Fixed: a refused
  decision ends the handler's program; only a recorded one is held until
  the view drops the request.
- A native child waited on the session's `ChildRunBudget` outside the
  masked region, so a stop landing in that wait ended no run. Fixed: the
  permit is taken inside `Effect.exit(restore(...))`, where every exit
  reaches `endRun`.
- `sweepLeftoverRuns` removed a background shell a clean close had stopped
  (its end is `cancelled` under a `shutdown` stop, which the sweep read as
  ended). Fixed: the sweep reads `cutShort` (the one predicate; exported from
  `leftoverChildren`), and a shell cut short is reported interrupted, not
  deleted.
- A message to a run that takes none (a process child, a headless one-shot
  root) was queued, and woke it. Fixed: `submitFollowUp` refuses a run whose
  `followUpSupport` is `unsupported` as not resumable, before the queue.
- An awaited child's background launches: `oneShot` read `parent === null`,
  so a subagent run in band (which no later turn reaches either) could
  launch a background command nobody delivers to. Fixed: `oneShot` is
  `stopAfterCycle && (parent === null || awaited)`.
- A parent stopped while its child's opening commits left the child with no
  `run.stop` row (the registry's `start` wrote the stop only for an opened
  run). Fixed: the opening's interruption writes the stop rows too
  (`tapCause` in `RunRegistry.start`), the reason from whether the session
  is closing.
- A child resumed for a message reported twice under two delivery ids, and
  its parent could not tell the second report from the first (§1.7). Fixed:
  the envelope carries `continued="true"` when the run reported from an
  activation, not its registration.
- `ProcessChildLaunch.open` was an Effect every producer wrapped in
  `Effect.succeed`, with an `onError` branch the harness handled nowhere.
  Fixed: `turn(ctx): ProcessTurn`, plain; the trace emitter is built inline
  in the launch.
- `Interactions.layer` was a static layer constructor no composition used
  (the session builds its host in `sessionOwnersLayer`). Deleted.
- Eight comments restated the retired loop (a "lane", a "closing plane", a
  "terminal-backed run", a "continuous delivery driver", a "pause notice",
  the executions tool's `send` description, `openRequest`'s claim that an
  interruption cancels the request, the headless adapter's plugin case).
  Rewritten to what the code does.

A third round, from the Codex review threads on the PR, fixed at the root
rather than per finding:

- **A child resumed for a message ended without reading it.** The loop's
  parked branch read `stopAfterCycle` as "end when parked", so a one-shot
  child woken by its parent's message ended at once, and the wake repeated
  (the queued row stayed). `stopAfterCycle` now means "end after one
  cycle": a queued message starts that cycle (`loop/toolUse.ts`). The one
  regression test of this round (`ToolUseWait`: a one-shot child resumed
  for a queued message runs its turn, then ends) failed first.
- **The registry read the run tree through held fibers' direct edges.**
  A stop's cascade and the "has active children" read listed the held
  runs whose parent edge named the run, so a grandchild under an ended
  child escaped a stop, and a completed run with a live grandchild read
  as done (its input closed as terminal, its deletion accepted, and the
  deletion's cascade took the grandchild's rows and files). One reading
  now: `heldUnder` walks the stored parent edges to any depth
  (`RunRegistry.heldUnder`, `hasLiveDescendants`). A stop writes the run's
  own `run.stop` first, so a child registering under it meanwhile is
  refused (`registrationRows`), then stops every held run under it, then
  interrupts the run.
- **A deletion or a file operation checked liveness once.** The old lane
  (`withInactiveRunStep`) made the operation and a launch mutually
  exclusive for the operation's whole lifetime; the cut kept one `get`.
  `RunRegistry.withInactiveRun` is that step again: it refuses a run live
  here or with live work under it, holds the run for the operation, and a
  launch arriving meanwhile waits for it.
- **A stop during a committed opening leaked the opening's resources.**
  The registry wrote the stop and the end on the rows and discarded the
  prepared run, whose scope (its model binding, its plugin holds) only its
  program closes. Now the stop row goes in, the run is forked and
  interrupted before its first step, and its one terminal (`endRun`) ends
  it and releases the scope; `RunStoppedAtStart` is gone with the second
  ending path.
- **A second stop overwrote a person's.** `stopRun` appended a `run.stop`
  for every ask, and the facts keep the latest, so a session's shutdown
  stop replaced the user's and the next resume restarted work a person
  had stopped. The first stop of a lifecycle stands.
- **An awaited script call had no bound.** Awaited children ride their
  parent's slot in the session's budget, and the per-script semaphore the
  cut removed was the only bound on a script's parallel `agent()` and
  `self()` calls, which the setting promises. Each run now carries its own
  semaphore of the budget's size (`AgentRun.awaitedCalls`), held across
  the call's launch and wait (`awaitChildRun`); one per run, so a child's
  calls never wait on its parent's and nested delegation cannot deadlock.
- **A grant's sweep authorized against the view.** `approvalsUnder`
  resolved each descendant's grants from the view, which can lag a
  descendant's own `bypass: off` already committed; it now reads each
  reached run's committed grants (`facts`). The descendant list itself is
  still the view's (§1.3).
- **Two readers decided whether a message wakes a run.** `submitFollowUp`
  skipped the wake when the run was live a moment before the send
  committed; a run that exited meanwhile kept the row unread. The inbox's
  one reading (`owesResume`) runs after every landed send.
- **The follow-up receipt's query left out `run.stop`**, so a turn a
  shutdown cut read as cancelled instead of continued. Added to
  `RECEIPT_ROW_TYPES`.

## 3. Red flags that stand

- **Repetition, ended in the hosts' PR.** "A grant answers a request of
  this kind" was read twice: `sessionPermission` (`loop/toolGuard.ts`)
  before a request opens, over the operation's own grant alone, and
  `grantAnswers` (`agent/runtime/requests.ts`) as it opens, over every
  grant that covers the kind. One table now (`GRANT_OF`, `STANDS_FOR` in
  `shared/schemas/request.ts`): `grantHeld` reads it for the guard and
  `grantAnswering` for the opener, so super yolo answers a bash call at
  the guard as it did at the open.
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
  harness enforces it once, in `submitFollowUp` (`acceptsFollowUp` is a view
  affordance that reads the same field). One fact, one representation would
  make it a boolean.
- **The ten-minute `APPROVAL_HANDLER_TIMEOUT`** (`requestAnswerer`) now
  bounds the headless operator's prompt as well as a programmatic handler:
  an operator who answers after ten minutes finds the request denied. The
  old adapter's own loop had no clock. A host's prompt should carry its own
  deadline, or none.
- **The two edges, after the one reading above.** Super yolo on with
  bash off no longer opens a bash request only to decide it in the same
  batch: the guard allows it. A `call` operation's bash-kind request with
  `allowBypass: false` is still asked under super yolo: a hook's `ask`
  names a person, and both readings honour it; the old lane head's pass
  was the defect.
- **`resumeOwnedChild`** (an awaited call's resume of its child) repeats
  `openResume` with fewer checks: no `checkpointRefusal`, no closed-input
  read, no stop asked meanwhile. Correct today because the call owns the
  run, and a second site for the same decision.
- **`awaitChildRun`'s interruption** (the parent stopped while waiting on a
  child in band) interrupts the child's fiber directly, so the child ends
  cancelled with no `run.stop` row of its own; its parent's stop is the
  only record. The registry's `stop` is the one writer of that row;
  routing the await's interruption through it would make the child's
  rows say why.
- **The session's close deadline** bounds the drain of the runs, not the
  stop rows `stopAll` writes first: a slow publisher delays a close past
  the five seconds before the timeout starts. One deadline over both
  would need the stop writes interruptible, which a durable append is not
  by design.
- **An agent-CLI plugin switched off mid-turn** releases its session
  registry (the busy set); switched on again, a second call on the same
  thread passes the claim. A hold per running turn would keep the
  registry; recorded, not fixed (§1.2 asks whether the registry stays at
  all).
- **`ProcessReport.failure` beside `ProcessReport.exit`**: a failed exit is
  said twice, as the exit code and as the failure message the end records.
  One reading (`exit.code !== 0` is the failure, the message its report)
  would own it; a provider SDK's error result, which has no exit, keeps
  `failure`.
- **`childEndReport`** switches on the child's kind (a background script's
  notice, a subagent's envelope) in one function; two delivery formats, one
  function, where the kind is known at the launch.
- Pre-existing, noted: `Context.merge` of the whole captured context in
  `sessionOwnersLayer` (the runs' fork runtimes are built under the
  session's context deliberately; a `Context.pick` would name the services
  a run needs); `Effect.try` around a parent stage's `end`; `joinOpening`'s
  swallowed facts read; the `Run ID:`/`Run:` pair on a subagent's receipt.

## 4. Follow-ups

- Hosts' PR (R6+R10): §1.1 (TUI `approve`; moot while the TUI is a
  client of the service, whose windows answer prompts through
  `request.decide`), §1.5 (R8's second half), §1.4 (denied-request
  notice). §3's one reading of a grant landed there (PR 14772).
- Harness, small: §3's one `cutShort` predicate (`agentChild.standingOf`
  still reads its own), one delivery-id shape, `USER_FOLLOW_UP_SUPPORT` as a
  boolean, the handler timeout off the operator's prompt, `resumeOwnedChild`
  through `openResume`, the await's interruption through `RunRegistry.stop`,
  the close deadline over the stop writes, a hold per agent-CLI turn.
- Open question: whether a second turn on a process run is worth a run
  (§1.2); until then the thread is the provider's and the run is the turn.
- The CLI service and its sessions, read after this PR's review rounds:
  `2026-11-06-cli-service-root-causes.md` (the upgrade handoff, the
  projects' and the service's lifetime, the wire, the windows), which
  extends R10 and names the fifteen-second store retry this PR's R1 slice
  added as a wait to delete.
