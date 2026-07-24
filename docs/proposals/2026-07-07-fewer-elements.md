# Fewer Elements: LoC and Element Accounting for the 2026-07 Campaign

> **Status:** Analysis and rulings. Written 2026-07-07 from a measured audit of
> the campaign window 2026-07-02..07 (~300 merged PRs): a 20-PR diff
> dissection, a staged-deletion inventory measured file-by-file in the current
> tree, a test-growth audit, an element census of the runtime/interaction/
> progress planes, and a cost accounting of the migration middle. Companion to
> [`2026-07-03-tech-debt-audit.md`](./2026-07-03-tech-debt-audit.md),
> [`2026-07-03-session-scoped-runtime-architecture.md`](./2026-07-03-session-scoped-runtime-architecture.md),
> [`2026-07-05-architecture-checkpoints.md`](./2026-07-05-architecture-checkpoints.md), and
> trackers #6951 / #6968 / #6981. The rulings in §7 extend #6951's
> single-ownership section and bind future campaign PRs; the PR that merges
> this doc mirrors R1 and R5-R8 into the code-review checklist (§14) so the
> review train applies them, and posts them as a comment on #6951. On any
> conflict, #6951's single-ownership section wins.

## 1. The principle

A system that works with fewer elements beats tireless management of a larger
number of elements that brings endless trouble.

An **element** is any named construct that must be managed: a file, an exported
symbol, an interface, a class, an enum or vocabulary, a registry, a port, an
adapter, a shim, a ledger row, a follow-up tracker, a test file. LoC is the
symptom; element count is the metric. Two corollaries drive everything below:

- **Dual-system coexistence is the worst element multiplier.** Every live
  old-plus-new state costs the elements twice, plus a reconciler, plus
  equivalence tests, plus a ledger row, plus the correction PRs the seam
  generates. Dual states are no longer tolerated as a resting state (§7 R1).
- **A managed middle is itself a system of elements.** Ledger rows, checkpoint
  documents, hardening trackers, and equivalence rigs are real maintenance
  surface. When the middle's element count rivals the payoff's, the middle is
  too long.

## 2. Measured reality (2026-07-02..07)

All numbers reproducible from
`git log --since=2026-07-02 --before=2026-07-08 --numstat -- . ':(exclude)pnpm-lock.yaml' ':(exclude)**/deno.lock'`
and the GitHub record; census methods stated inline.

- **~300 PRs merged; net +44k LoC whole-repo.** Tests +24.7k (55%,
  `src/test-kernel` grew 113.9k to 138.6k, +80 vitest files in 5 days),
  product code +15.0k, docs +4.8k.
- **Files:** net +111 non-test source files (average ~135 LoC each) and
  +85 test files.
- **PR mix:** ~53% forward work; ~34% correction PRs fixing or finishing
  something another same-week PR created; ~9% process artifacts (checkpoints,
  audits, ledger bookkeeping); ~4% unclassified (deps bumps, reverts).
  Roughly 42% of the week, net +12.2k LoC, went to managing the middle
  itself.
- **Ledger (#6981):** 38 rows (34 at the audit snapshot plus 4 gap-filled the
  same day for shims that had merged without rows); 2 ever executed (5%);
  22 of 38 are hops the campaign itself minted.
- **Live dual-states in the tree at the audit snapshot: ten.** Dual status
  vocabulary (`STREAM_STATUS` beside `StreamPhase`), session-fact to
  progress-event projection, `setTaskState` compat emissions, completed-run
  todos dual-owner with an mtime reconciler, tool-use per-step KV dual-write,
  tier-3 read shims, frozen CLI JSON fields, `defaultSession()` aliasing,
  v1/v2 flow-record replay, and the TUI usage-echo guard.
- **Element census** (architectural constructs in the event/status/interaction
  planes; counted as classes, buses, vocabularies, registries, coordinator
  layers, and per-host adapters): baseline ~30, current ~43, planned end state
  ~32. With the coordinator fold the proposal already promises (§5), ~26.

The audit also confirmed the campaign's health where it is healthy: typecheck,
lint, and all 5031 tests green; VS Code-free zones clean; one run-fact rail
holds by grep; stages 0-4 landed with checkpoints executed (two Stage-4 gates
were only partially met at issue close: the replay-reads-`pending()` gate,
since renounced in #7451, and the port-width deletion, picked up in §8). This
document is an accounting of what the architecture has been costing and a plan
to stop paying twice.

## 3. Why "deletion" PRs land net-positive

Dissection of 14 add-heavy deletion-intent PRs and 6 genuinely net-negative
contrast PRs. Added lines classify into six recurring causes, ordered by
measured mass:

1. **Unadvertised churn riding a refactor title.** #7070 ("extract executions
   formatters", +2877/−2153): 92% of the diff is an unrelated styles split and
   settings-state hoist; 2407 churn lines; +123 elements including 57 exported
   signal singletons and 13 one-line handler registries; the title's own
   extraction violates the single-caller ban (all 7 functions have exactly one
   consumer). #6885 ("consolidate settingsView message builders",
   +2463/−2032): ~86% is Prettier/Lit reflow across ~150 unrelated files, and
   the real duplication (paired per-host `postX`/`sendX` functions) was left
   alive in both hosts. Both verdicts: unjustified.
2. **Test ceremony.** Up to 713 test lines per PR (typically 130-450 among the
   twelve that added tests). Of the window's ~90 added test files (net +85
   after in-window deletions; the test audit examined the 84 added as vitest
   suites), 49 are under 150 LoC (three under 20); ~1.8k LoC of
   shim/projection pinning carries a
   planned expiry with no expiry marker; 3,329 LoC across 10 files assert
   against the legacy `ProgressEventPayloads` plane Stage 5 deletes; 506 LoC
   of tests were written and deleted within the same 5 days.
3. **Seam-before-delete.** The Stage-4 port PRs (#7303/#7309/#7311) added
   ~790 seam-surface lines with deletion staged for a later PR. Legitimate
   strangler mechanics, but only when the deletion PR lands promptly (#7316
   did, at −336, the same afternoon as #7303; the pattern held there).
4. **Doc-comment essays.** The three worst offenders carried 200-347 comment
   lines each (#7070/#7271/#7159); of #7271's 266, a third re-narrate the
   pre-refactor design to the reviewer (against the code-review checklist's
   comment rules, §9).
5. **Ceremony width.** Per-kind type pairs that hand-sync an `Omit` field
   list, options bags unioning both callers' quirks, exports minted for one or
   two use sites, and unledgered legacy-migration shims (#7271 shipped two;
   gap-filled into #6981 on 2026-07-07).
6. **Genuine, staged growth.** Zod discriminated unions are wordier than
   optional bags; three hosts genuinely diverge; previously untested behavior
   deserves tests. Real, but a minority of the added mass in every dissected
   PR; #7284 is the special case, a feature slice mislabeled `refactor:`,
   where addition was structurally guaranteed.

What the six net-negative PRs did differently: they deleted a whole system in
the same PR that replaced it. #7338 code-generated `package.json` contributes
and retired the catalog-derived bulk of a 70KB snapshot (−1091). #7202 retired
an entire export system (−769, about −24 constructs). #7316 executed the
staged Stage-4 deletion (−336; two files gone, including the abstract base
class). #7036/#6898 were sweeps with zero new exports. #7356 replaced
configurability with constants (−122), though its one legacy-tolerance shim
was also only ledgered by the 07-07 gap-fill. The pattern is consistent:
**net-negative happens when the delete ships inside the PR, not after it.**

## 4. The dividend, measured

Every staged deletion in the program, measured in today's tree (file list and
`wc -l` per item recorded in the 2026-07-07 audit):

| Cluster                | Content                                                                                                                                                                                                      | LoC now   | Trigger                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------------------------------------------- |
| Stage 5 close-out      | `ProgressEventBus` (327, 45 keys, 1000-event buffer) + `emitRuntimeEvent` (95) + `InterruptRegistry` (34) + process-bus backend hop (36) + `sessionProgressEventProjection` (216) + `RunContext` dedup (~50) | ~760      | #6968, near-term                               |
| D1 vocabulary sweep    | legacy `STREAM_STATUS`/`TRAITS`/`ExecutionStatus`/`EndGroupStatus` + converters (~200) + legacy projection columns (~80) + display mappings (~100) + desktop tier-3 union (~60) + smaller read shims (~150)  | ~590      | Stage 5 + an age window never dated            |
| D3 age-based rows      | 19 rows at the audit snapshot (~670) + the 4 gap-filled rows (~150-190)                                                                                                                                      | ~820      | Retention window never dated                   |
| CLI frozen JSON fields | `terminalStatus.ts`                                                                                                                                                                                          | 108       | Maintainer decision, punted at two checkpoints |
| F6 unification         | twin formatters + CLI loop's private outcome choreography                                                                                                                                                    | ~500      | Forecast, not measurement; #6976               |
| Dying tests            | equivalence rigs, shim round-trips, legacy-plane assertions                                                                                                                                                  | ~1.5-1.8k | With the above                                 |

**Total: ~4.1-4.7k LoC against +44k added.** Even perfect execution of every
staged trigger leaves the campaign net-positive by ~+10k in product code and
~+23k in tests. In elements: the staged deletions retire at most 10-12 files,
one 45-key vocabulary, ~17 legacy status exports, one registry class, and ~20
shim schemas, against the window's net +111 source files and +85 test files.

**The campaign bought architecture (session isolation, one emit rail, a
host-interactions port) at a permanent size premium, mostly in tests.** The
dividend is still worth executing because it deletes the right elements (the
process-global bus, the 7-value vocabulary, the second run driver). But
LoC-neutrality cannot come from the staged deletions. The recoverable mass is
elsewhere: preventing the churn class (§3 item 1), the test budget (§7 R7),
small-file consolidation, and the coordinator fold (§5).

## 5. Element census by plane

- **Status plane: net element reduction, as intended.** A 7-value vocabulary
  plus 4 sibling vocabularies plus 2 trait tables collapse to `RunOutcome` +
  `StreamPhase` + one `StreamStatusMachine`.
- **Facts plane: a swap, not a reduction.** One bus (54 keys at baseline)
  became `SessionEventHub` + 5 `SessionFact` arms + 5 new trace arms +
  `AppSignals` (10 keys) + a new `ExtensionPresentationEventBus` that
  reimplemented the 1000-event buffer
  (`extensionPresentationEvents.ts:20`) the proposal's mapping table said
  would be "never reimplemented". Two residues keep the old vocabulary alive
  inside the new one: `SessionFact` payloads are still typed as
  `ProgressEventPayloads[...]`, and run facts ride a `'runFact.'+busKey`
  string-prefix protocol. Unless Stage 5 moves the payload schemas to
  fact-native names, `ProgressEventPayloads` survives as a types-only zombie
  (rule pinned on #6968).
- **Interactions plane: a multiplication, so far.** The proposal's mapping
  table promises "BasePromiseCoordinator + 3 coordinators + RunCoordinatorBridge
  → HostInteractions request bookkeeping + pending registry". What landed is a
  multi-method `SessionHostInteractions` forwarder + three hand-written
  per-host implementations (333/282/323 lines at the audit snapshot), each
  keeping its own pending bookkeeping (the CLI's lives in
  `subscribeApprovals.ts`), while the coordinator middle layer (4 classes, 5
  maps) and `ApprovalRequestHandler` survive with no stage bullet or ledger
  row scheduling their deletion. A plan approval today traverses ~5 pending
  registries; baseline was 3. The three host implementations are the
  justified multiplication (hosts genuinely diverge: live-diff capture,
  Electron IPC, Ink modal queue). The surviving coordinator layer and the
  port's optional-member width are ceremony. Executing the promised fold takes
  the end state to ~26 elements, genuinely below the pre-campaign ~30, for
  roughly −900 LoC.

## 6. The cost of the middle

The strangler middle was defensible for the status/event planes (three hosts
plus a public CLI JSON surface). But at this repo's merge cadence (~60 PRs a
day, no external consumers of intermediate states except CLI JSON), the two
ledger rows that actually executed prove short middles are safe here:
#7016→#7116 closed inside a day (merged 07-04 → 07-05); #7303→#7316 closed the
same afternoon (both merged 07-06, under two hours apart). Meanwhile the long
middles have produced: 38 ledger rows with 2 executed, ten live dual-states,
~34% of a week's PRs spent on corrections, and three unmade decisions that
block nearly every staged deletion. Two of those decisions' designated venues
(Checkpoint B for the tier-3 window; Checkpoints A/B for the CLI JSON freeze)
closed without recording a decision.

The dual-states are where the trouble concretely lives: the completed-run
todos dual-owner alone consumed 8 PRs in 3 days (#7292 plus its correction
tail through #7429), including an mtime-tie-break reconciler; the WAITING
suspend built on the still-dual run driver produced two user-facing bugs
(#7286/#7287); the #7398 projector deletion severed an emit rail while a
consumer was still on the old plane (3.5h dead status bar on main).

## 7. Rulings

These extend #6951's single-ownership section; R1 and R5-R8 are mirrored into
the code-review checklist (§14) by the PR that merges this doc. Correctness
and security work is always exempt from R3/R4 sequencing.

- **R1. No dual-system resting state.** Code-to-code duals (projections,
  dual-writes, aliases, adapter hops) merge only when their deletion PR is
  already open and referenced from the shim's #6981 row at merge time, or the
  row carries a calendar date at most 7 days out. Shims for **persisted data
  outside the repo's control** (old stream logs, flow records, agent YAML,
  workspace state) are the legitimate exception: they take an age-based #6981
  row with a calendar date per R2(2). Anything else needing a longer window
  must name the external consumer that forces it; today only the CLI JSON
  surface qualifies. A migration that cannot schedule its delete does not
  start.
- **R2. Decisions before code.** Three pending decisions are made this week,
  at zero code cost: (1) #7246 Decision 1, completed-run archive owner, which
  collapses both the KV dual-write and the todos mtime reconciler; (2) the
  tier-3/D3 retention window as a calendar date, since "decide at #6979"
  already failed once; (3) the CLI JSON freeze: announce deprecation of
  `status`/`terminalStatus`/`endGroupStatus` in the next minor's changelog and
  delete in the following minor (the CLI is published; additive-change rules
  apply, so there is no delete-now arm).
- **R3. Batched sweeps, not per-consumer PRs.** Consumer moves stay small
  independently-shippable PRs per #6951's coordination rule; the sweeps are
  the terminal deletion PRs, where atomicity is the point (the Stage-5 gates
  require the bus and its equivalence rigs to die together). Sweep 1 (Stage-5
  close-out, driven by #6968): last consumers move, then one PR deletes the
  bus, `emitRuntimeEvent`, `InterruptRegistry`, the projection, the `runFact.`
  prefix, and the equivalence rigs. Sweep 2 (D1, #6982): the legacy status
  vocabulary, tier-3 shims, display mappings, `defaultSession()` aliasing.
  Sweep 3 (D3, #6984): all age-based rows sharing the dated retention window,
  in one dated PR. Target within two weeks: every remaining ledger row carries
  a calendar date, and undated/event-triggered rows number under 5.
- **R4. Moratorium on new planes, vocabularies, rename churn, and
  deferred-improvement umbrella trackers until R3's target is met.**
  Detection, so reviewers can apply it: a new file exporting an
  emitter/bus/hub class; a new enum or const-vocabulary whose members map onto
  an existing vocabulary (a mapping table appears in the same diff); a
  rename-only diff whose R6 element delta is zero (#7347 alone cost 3
  correction PRs for zero element reduction; a rename that retires an alias in
  the same PR is a deletion, not a rename). Scope: bugs and regressions file
  issues normally; the ban covers "Tracking: follow-ups from #X" umbrellas
  carrying non-bug findings (25 minted in 5 days is a second backlog). Standing
  umbrellas: #7417 closes when its drained children close; #7424/#7425/#7427
  (data-shape refactors) defer behind Sweeps 1-3; #7426 is already rescoped
  and blocked on #6968.
- **R5. Churn-class ban.** No reflow or reformat of files a PR does not
  functionally touch. No styles/file splits without net element accounting.
  The single-caller extraction ban now cites #7070 as its canonical violation.
- **R6. Net-element accounting.** Every refactor PR body reports constructs
  added vs deleted alongside net LoC. Counting method: files from the
  diffstat; exported-symbol delta via `^[+-]export` over the diff; class/
  interface/enum declarations counted the same way. Reviewers reject
  "consolidation" PRs whose element delta is positive without a stated,
  staged reason.
- **R7. Test budget.** Extend-first: a new test file is legal only when the
  product module has no existing suite (one suite per module, path-mirrored;
  cross-module integration scenarios get one suite per named scenario, stated
  in the PR body). Scaffolding tests carry an in-file expiry comment naming
  their #6981 row, and the row's trigger includes deleting the marked blocks.
  Scaffolding test LoC counts double in R6 accounting. Suites with 4 or more
  structurally identical cases use `test.each`. Immediately foldable: the 8
  new sub-50-LoC suites. (The audit's other immediate candidate,
  `ProgressBackendProcessBus.vitest.ts`, was retired together with its adapter
  by #7446 while this doc was in review — the retire-with-the-equivalence gate
  working as intended.)
- **R8. Consumer-grep before emitter deletion.** Any PR deleting or re-routing
  an emit path greps all subscribe sites of the affected keys first and states
  the consumer count in the PR body (the #7398 rule, pinned on #6968).

## 8. Sequenced plan

**Week of 07-07** (decisions and banked wins): make the three R2 decisions;
merge the WAITING-suspend fix (#7324); port width: unread `pending()` deleted
in #7451 (−62); `handleProgressEvent` became live in #7443/#7446 and moves to
the post-Stage-5 port shrink; knip ratchet baseline (#7448); fold the 8 micro
test suites; Stage 3c (#6966) bullets unblock once Decision 1 lands.

**Week of 07-14** (Sweep 1 and the fold): finish the last extension/desktop
fact-plane consumers with R8 greps; Sweep 1 in one PR (#6968); Stage 3c
persistence facade bullets 2-5 (#6966) behind Decision 1; coordinator fold
into `session.interactions` (delete `runCoordinators.ts`,
`PlanApprovalCoordinator`, `AgentProposalCoordinator`,
`RetryRequestCoordinator`; ~−450 LoC, −4 classes, −5 maps; ledger row first);
shared `PendingInteractionTable` consumed by all three hosts, with
`ApprovalRequestHandler` deleted **in the same PR that switches webview replay
to it**, gated on replay parity: a pending prompt redisplays exactly once
after webview reload, and external inquiry's two replay sources do not
double-card (Checkpoint B's ruling); then shrink the port (required request
methods, one `cancel(selector)`, a slot-wrapper instead of the multi-method
forwarder, `handleProgressEvent` deleted once Stage 5 removes its callers).

**Week of 07-21 and after:** Sweep 2 (D1 #6982, dated); Sweep 3 (D3 #6984,
dated); F6 one-loop unification with its net-LoC gate enforced as a merge
blocker (this program's convergence slices have repeatedly landed
net-positive; F6 is the only staged item whose dividend is a forecast rather
than a measurement); then the test-consolidation workstream (fold the 49
micro-files; rewrite the 3.3k legacy-plane assertion cohort incrementally
inside each Sweep-1/2 slice, not as a big-bang at the end).

**End-state targets:** element census ~26 (below the pre-campaign ~30); every
ledger row dated and undated rows under 5; zero live dual-states except CLI
JSON through its one-minor deprecation window; every remaining shim carrying a
calendar date.

## 9. What this does not relitigate

Session isolation, the single emit rail, `StreamPhase`/`RunOutcome`, and the
host-interactions port are landed, correct, and stay. The multi-window desktop
fix, the WAITING-suspend semantics, and the memfs test kernel are wins. This
document exists so the remaining staged work deletes more than it adds, and so
the next campaign starts from "fewer elements" as the acceptance gate rather
than the retrospective.
