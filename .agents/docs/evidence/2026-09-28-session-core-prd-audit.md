# Session-core and plugin architecture: audit against the original plan

Audited on 2026-09-28 against remote `main` at
`0a5aa283bbcc4b23af6ec689fea2a11db00517e2`, including the newly merged #13412.
The broad source audit used `0117c59eb2`; the subsequent diff was reviewed before finalizing this report.
The local checkout was not advanced.
This is an assessment of the implementation, not a new architecture decision or an implementation plan.
The comparison is posted on [#13397](https://github.com/LionSR/TeXRA/issues/13397#issuecomment-5863101532), with the
specific plugin follow-up on [#13396](https://github.com/LionSR/TeXRA/issues/13396#issuecomment-5863107349).

The plugin foundation is substantially implemented. The full programme is not complete, and its remaining work
includes consequential behavior, not merely naming and file arrangement. In particular, several parts can still
change approval state; explicit session close differs from process shutdown; agent definitions can still
be reloaded on resume; and current settings still share the execution-history representation.

Counting merged PRs would overstate completion. Conversely, counting missing proposed class names would understate it.
The useful measure is whether each required behavior has one owner and whether the replaced behavior has disappeared.

## Baseline and later decisions

The baseline is the [original session-core proposal][original], merged in [#13350][p13350], together with the
[earlier plugin architecture][plugin-design]. The [core-concepts document][concepts] and the decisions recorded in
[#13388][p13388] amend that baseline. The original document itself contains reviewed reductions, deferred structures,
and questions for the owner; its thirteen moves are not thirteen equally weighted release requirements.

| Original description                                                              | Governing interpretation for this audit                                                                                                                  |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A composition fixed for the entire run                                            | Superseded: changes apply at recorded step boundaries. Tools are checked against the step that offered them.                                             |
| A plugin driver table and `DriverUnavailable`                                     | Withdrawn: native execution stays core; paused plugin children continue through tool re-entry.                                                           |
| A new session kernel, split session interface, and complete process-layer rewrite | Deferred unless a bounded change demonstrates a concrete benefit and removes the competing implementation.                                               |
| Third-party plugins                                                               | Data plugins, including stdio MCP execution, are implemented. The broader third-party hook/LSP/code-plugin surface through typed RPC is not implemented. |
| Plugin schema versions                                                            | Versions per row kind are the policy after 1.0. The whole-store development stamp remains permitted before then.                                         |
| Goal approval on resume                                                           | Settled: goal mode resumes paused until a human re-arms it. This is implemented.                                                                         |

The source documents also contain stale passages. For example, the implemented plugin note still has a title about
run-wide pinning, although its amended body specifies step boundaries. The session-core note still proposes removing
global database polling, although cross-process plugin switches now use it. These passages must be corrected to the
recorded decisions and current consumers, rather than implemented literally.

## Latest progress

Seven commits landed after the preceding audit at `ec4d15a900`. The three material architecture changes are:

- [#13414][p13414] makes host identity explicit data, including `sdk`, and moves tool availability into a process
  service. SDK and CLI sessions now initiate probes. The old global-host and UI-only-probe findings are obsolete.
  Probes remain nonblocking: the first step may offer tools before their prerequisites have been checked.
- [#13411][p13411] reduces repeated plugin digest work, closes acquisition/publication interruption gaps, and removes
  the repeated history fold from follow-up admission. These are real improvements to resource lifetime and cost.
- [#13412][p13412] records template inputs once, restores tool-use prompt inputs from history, and updates listed skills
  and model-dependent text at step boundaries. It also replaces per-step skill directory grants. A narrower residual
  involving explicitly activated skills remains, described below.

The other four commits group plugin setup fields, correct one such declaration, retain typed user channels, and
remove duplicated grouping code while fixing a `since=` defect. They do not complete the remaining ownership contracts.

[#13415][p13415] remains **open**. It moves automatic resume into
the owning session and removes the host resume port. Its branch evidence is not evidence of merged behavior.

## Coverage of the thirteen moves

“Partial” means that a named slice is implemented but some requested behavior remains. “Deferred” is a recorded
scope decision, not a defect. A proposed representation is not treated as obligatory when the same behavior already
has a simpler correct implementation.

| Move                                             | Delivered                                                                                                                                                                                                                                                                                                           | Remaining or deferred                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Session state and derived views**           | Removal goes through the publisher (#13375); repeated durable facts were removed (#13386). The run and display reducers already share `applyRunRow`.                                                                                                                                                                | Single-run lineage reads and exhaustive listing classification remain to be completed. A new `SessionKernel` was explicitly deferred.                                                                                                                                                                                                                                                                                    |
| **2. Plugin ownership**                          | Typed contribution tables; live tools and continuations; built-in prompt contributions; process/session plugin services; goal schema contribution; installed data plugins and shared trust; cross-process switch changes; exact request records; step-selected skill listings and model-dependent prompts (#13412). | Document output, workflow checkpoint and inquiry schema ownership is incomplete. Explicit session close lacks the plugin delivery drain. Explicitly activated skills can retain directory grants after disablement. External executable trust uses metadata, not content. Stored plugin presets, the proposed setup operation, SDK plugin selection, and the broader hook/LSP/code-plugin RPC surface are not delivered. |
| **3. One launch path**                           | Workflow resume and launch terminal ownership were consolidated (#13384/#13385). Final output presentation no longer changes the committed verdict (#13372).                                                                                                                                                        | Fresh and resumed setup still differ. Remaining child setup handoffs should be removed only with their replacement; a new launch framework is not required.                                                                                                                                                                                                                                                              |
| **4. Process and SDK lifetime**                  | Explicit SDK storage and model transport (#13398); explicit host identity and all-host availability probes (#13414); typed refusal of conflicting SDK composition.                                                                                                                                                  | Module-global signals and detached workers remain. Explicit close and process shutdown still differ. The SDK does not expose the full plugin/resources/approval options from the plan. Per-graph owner identity is absent. Wholesale process reconstruction remains deferred.                                                                                                                                            |
| **5. Shared commands and streams**               | Shared runtime request union and handler; durable decisions can carry edited content; per-session webview pending requests close correctly (#13398); internal durable cursor stream exists.                                                                                                                         | Start, resume and media operations still take host command routes. `policy.set` does not atomically settle existing eligible requests. The SDK does not expose the full durable-cursor/live-stream distinction required by the plan.                                                                                                                                                                                     |
| **6. Session interface and resume ownership**    | Bounded interface and lifetime cleanup has landed.                                                                                                                                                                                                                                                                  | One subscription interface and default-session retirement remain incomplete. Session-owned automatic resume is under review in #13415. The proposed `SessionPlane` split was withdrawn.                                                                                                                                                                                                                                  |
| **7. Trace lifetime and SDK interaction**        | SDK operations already use Effect and expose run result, view and bounded live events. Foreign loops use Streams and sweep open cards (#13400).                                                                                                                                                                     | Scoped stage/per-attempt stream cleanup, direct emitter subscription, and a replaying manual-approval surface are not delivered. An Effect return type alone does not fulfill these lifecycle contracts. The `RunTrace` rename was withdrawn.                                                                                                                                                                            |
| **8. Model ownership**                           | Exact request recording and reconstruction checks cover invoker requests (#13409). SDK transport no longer changes the embedder's global dispatcher.                                                                                                                                                                | Replaced model bindings live until run end; helper/compaction requests still bypass the invoker; automatic retry does not reacquire an aged WebSocket; failed manual rebinding can still authorize retry on the old binding; cumulative response time is reported per round.                                                                                                                                             |
| **9. Approval decisions**                        | Call-time guards and distinct shell/tool-call grants (#13363); human grant restoration and corrected `never` proposal behavior (#13376); paused goals on resume (#13387).                                                                                                                                           | Policy is still decided in several places. Approval state changes outside the publisher. Goal teardown restores saved booleans, potentially overwriting a later human choice. A complete action/resource contract remains open.                                                                                                                                                                                          |
| **10. Run inputs and wake-up**                   | Durable follow-ups, claim-based coordination, and paused child re-entry exist; native runs keep their scope while waiting; #13411 removes repeated admission folds.                                                                                                                                                 | Core wake-up is still under review. Durable deferral/release, interruptible recovery, and separation of replay safety from parallel execution remain unfinished. Broader stopped-run input and answer-linked settlement retain an explicit decision dependency. Changing the queue's name would not satisfy these contracts.                                                                                             |
| **11. Agent catalogue and recorded definitions** | Refresh ordering already has a lane and epoch barrier. Installed agents and cross-process plugin changes refresh the catalogue. Exact request records include the resolved definition used for that request.                                                                                                        | Failed remote loads become empty successful results; source failure/retry state is absent. Scanning and launching resolve inheritance separately. Local-directory watching is extension-specific. Resume still reloads the definition. Run-open definition pinning remains a target with unresolved decision wording; #13412 records template inputs, which is a separate contract.                                      |
| **12. Application state**                        | SQLite is authoritative; project database handles are shared; individual state modifications are transactional; desktop global state uses the common root.                                                                                                                                                          | Current values still use history rows; `borrowsClaim` remains. Desktop remembered/recent lists update separately. Repository setting routing still has a separate key list. Format-reset notices omit some affected state and are not surfaced by every host.                                                                                                                                                            |
| **13. Hosts and presentation**                   | Final run outcome is committed before presentation; pending webview calls end on session close.                                                                                                                                                                                                                     | Desktop window teardown still starts asynchronous closes without awaiting them. Per-round document presentation remains inside execution. Presentation checkpoints, provider singleton removal, and CLI input-state simplification are incomplete. Broad host rearrangement remains subject to demonstrated benefit.                                                                                                     |

## Discrepancies that determine the next work

1. **Approval state needs one decision owner.**

   The clearest example is the goal grant. [`GoalGrants`][goal] now has a session lifetime, but it still saves and later
   restores an earlier bypass value. A human can change that value while the goal is active; ending the goal then
   reinstates the old value. The original requirement expressly said to delete this second authority, not move it.
   The earlier isolated reproduction is recorded in the [programme issue][goal-reproduction]; the two relevant source
   files have not changed since that reproduction.

   Separately, [`policy.set`][policy-set] changes bypass flags and returns. It does not decide already pending requests
   in the same publisher operation. [`openRequest`][open-request] publishes the request, while policy evaluation also
   remains in helpers and [CLI evaluators][cli-approvals]. The bounded guard fixes are valuable but do not complete move 9.

   **Completion criterion:** one core operation determines policy and eligible decisions from committed policy/goal
   facts, publishes them together, and leaves no saved-value restoration or CLI policy evaluator. A later explicit
   human choice must survive goal termination. The same sequence must produce the same decisions on every host.

2. **A plugin switch must govern all of that plugin's contributions.**

   The supported data-plugin installation and trust path is shared across hosts. #13408 makes changes visible across
   processes. #13412 now filters listed skills by the step's selected plugins and refreshes model-specific prompt text.
   The earlier broad finding that installed skills remain listed after disablement is resolved.

   A narrower source-traced discrepancy remains. If a user explicitly activates an installed skill while it is enabled
   and trusted, [`noteActivations`][activations] caches its directory once. After that plugin is disabled or loses trust,
   [later steps][step-skills] filter the listed skills but still add every cached activation directory to the grants.
   [`grantSkillRoots`][skill-grants] replaces the grant set it receives; it does not recheck trust. Thus an external
   skill directory that still exists remains readable during that live run activation even though the catalogue entry
   disappears. The run finalizer eventually releases the grants. This was traced through source, not reproduced in
   an application run.

   **Completion criterion:** reconcile activated grants with the same current plugin selection before granting them.
   Disablement must withdraw future directory access as well as the listing; an already executing call may retain the
   resources it needs. Do not undo #13412's recorded inputs or rebuild a second skill catalogue.

   Trust has a separate specification mismatch. Every file inside the plugin is now hashed. External server executable
   and argument files, however, are [identified by path, size and modification time][external-trust], explicitly not
   content. The prompt discloses this, but the amended PRD asks for a content digest of what executes. Either satisfy
   that requirement or record an explicit amendment; disclosure alone is not evidence that the requirement was met.

3. **Moving a service does not settle ownership of its records.**

   [`PLUGIN_EVENT_ARMS`][plugin-arms] currently contains goal only. Document outputs, workflow checkpoints and inquiry
   schemas remain in core. The amended PRD explicitly retains a documents output plugin even though round execution
   is core. These are different responsibilities. Likewise, keeping inquiry answers decidable when a plugin is off
   explains core decision ownership; it does not by itself settle where the inquiry record schema belongs.

   Built-in history can be decoded independently of its switch. Unknown plugin rows are [retained in SQLite but omitted
   from decoded reads][unknown-rows] with a warning. Preservation of bytes is not complete interpretation of missing
   plugin semantics. Dynamic third-party schema registration is not implemented.

   **Completion criterion:** document which module defines and derives each record kind, remove its competing core
   definition, and retain one publisher. Resolve the inquiry distinction explicitly in #13390. Post-1.0 schema
   versioning should follow its recorded schedule; this audit does not request legacy-state import machinery.

4. **Close a session through the same protocol as process shutdown.**

   [`closeAll`][close-all] drains plugin deliveries before closing sessions. [Explicit session close][session-close]
   stops and settles runs but lacks the equivalent drain for that session. #13401 itself recorded this follow-up.
   The required behavior is per-session: closing session A must settle A's accepted work without stopping B's resources.

   Process cleanup is also incomplete. [`bootstrapHost`][bootstrap] still detaches the credential listener, and
   [`AppSignals`][signals] owns a module-global hub without shutdown. #13414 correctly places availability state in a
   service, but its [shared probe attempt][attempt] runs on a detached fiber; scoping its waiting caller does not give
   the underlying attempt the same lifetime. The latter is bounded by a deadline, so it should not be described as
   an unbounded permanent worker.

   **Completion criterion:** accepted deliveries drain through one session-close operation; callers await it. Each
   listener and resource has an explicit owning scope. Disposing and reopening the SDK in one process must not retain
   the previous listener. This can be achieved in the existing services without a wholesale process rewrite.

5. **Model requests need one resource and accounting path.**

   #13409 proves an important contract for invoker requests: the recorded context matches the dispatched request.
   It does not cover [compaction][compaction] or [helper calls][helper], which still dispatch separately. Rebinding a
   model also retains the previous binding until the run ends. The known [aged WebSocket retry defect][i13407] remains
   open. [Failed manual rebinding][failed-rebind] is caught as a warning, after which retry is authorized while the old
   binding remains. [`UsageMonitor`][usage] reports the cumulative run response time as each round's response time.

   **Completion criterion:** replacing a binding releases its old connection and workers; automatic recovery acquires
   a valid binding; every paid auxiliary request has appropriate usage accounting, and run-bound requests enter that
   run's durable history. Helpers without a run need process accounting, not artificial runs. Keep compaction's policy
   in core while using the common request path. No new “model plane” abstraction is needed.

6. **A failed agent refresh must remain a failure.**

   [`remoteAgentList`][remote-list] catches a remote error as `[]` and has no scheduled retry. [`agentRegistry`][agent-cache]
   then clears its cache and records that remote agents were included. This makes a failed retrieval indistinguishable
   from a successful empty catalogue. The existing refresh lane and epoch already prevent an older refresh from
   overwriting a newer one; replacing them merely to obtain a particular Effect helper would not fix this defect.

   [`agentLoad`][agent-load] separately reads YAML and resolves inheritance at launch. Resume still follows that live
   definition loader, even though #13412 now restores template inputs, system text and skill catalogue from history.
   Recording its result with each model request is useful, but it is not the proposed run-open definition record.

   **Completion criterion:** keep the last successful remote rows, expose failure as such, and retry under the catalogue's
   lifetime. Use one definition loader. Reconcile the PRD's still-listed definition-pinning decision with core-concepts,
   then make resume consume the chosen durable authority. Do not quietly redefine pinning as recording whatever was
   reloaded later.

7. **Current values and related writes need the intended database contract.**

   [`appStateStore`][app-state] reads from SQLite and already supports atomic per-key modification. This is not a claim
   that settings are still stored in legacy JSON. The remaining difference is the representation: current values still
   append `state.value.set` execution-history rows, and their claim exception remains.

   [`desktopProjectRecords`][project-records] performs two `appendAll` calls for remembered and recent projects. Its
   local lane orders callers, but does not make those writes one transaction. A failure after the first commit can
   therefore leave the pair inconsistent; this is a source-traced failure path, not a reproduced fault injection.
   [`WORKTREE_SHARED_KEYS`][worktree-keys] also remains a second routing list outside the settings catalogue.

   The [format-retirement code][store-format] preserves an older store before resetting the active format. The remaining
   notice problem is narrower: [the shared message][store-message] describes session history only, lacks size, and
   has no desktop caller. The plan requires every affected store and settings reset to be visible on every host.

   **Completion criterion:** fulfill the accepted current-value decision directly, make related list updates atomic,
   and give the settings catalogue sole routing authority. Keep cross-process change observation: it now has real
   consumers. Do not add migration, dual writes or a temporary compatibility representation.

8. **Shared commands and host presentation are only partly unified.**

   The [runtime union][requests] handles stop, delete, compact, follow-up, decisions, policy and workflow control.
   General start/resume and several media actions still use host commands. The [decision schema][decision] already
   carries edited content, so that subrequirement is complete even though the GUI still takes a host detour.
   [A durable cursor stream exists internally][cursor], but the [SDK session interface][sdk-session] does not expose the
   complete cursor-history/live-stream contract. A public Promise at a browser boundary is not itself an architecture
   defect; the plan retained that boundary after review.

   Final result presentation now follows the committed verdict. [Per-round document opening and dialogs][documents]
   still execute inside the run. [Desktop window disposal][desktop-close] starts scope closure asynchronously and
   continues shutdown without awaiting those window finalizers.

   **Completion criterion:** hosts submit common application commands and render their results. Presentation failure
   must not alter execution, and restart-stable presentation checkpoints belong in current values. Close operations
   must be awaited. Renaming controllers or splitting a large file is useful only when it removes actual coupling.

## Remaining run and SDK contracts

The smaller changes in moves 1, 3 and 6 should not be lost among the broad targets. [Lineage lookup][lineage] still
folds the session listing instead of reading one run. [Listing classification][listing] retains an unchecked default;
this is preventative clarity work, not a newly reproduced failure. Fresh launch creates and reveals the run directory,
while [resume bypasses that applicable setup][resume-setup]. The remaining two transcript subscription interfaces and
default-session lookup have live callers; deleting a method alone would not fulfill the ownership change.

The original claim that removal must prune every child ID was refuted by #13375: child runs are not SQL dependents,
and that removal result contains the root. It should not reappear as unfinished work.

Run input has more unfinished behavior than the host resume port. [Waiting is committed before a native child's turn
result is offered][waiting]; restoring that waiting state does not re-offer the result. This identifies a crash window
from source ordering, not a fresh executed reproduction. [Deferred delivery is still held in memory][deferred-row];
the durable row has no deferral flag or release record. Producer settlement and final wake remain separate actions.
These are the reasons to complete durable release/recovery, not to build a new inbox service. #13415 addresses the
session wake path but does not claim to complete these contracts.

The existing queue already has delivery-ID protection and child-result withdrawal. It should not be described as
having no idempotency or withdrawal at all. The broader proposed steer/queue lanes, general withdrawal and recorded
answered/unanswered settlement depend on the plan's still-open decision about input to stopped runs. Separately,
[tool replay still tests `parallelSafe`][replay]; concurrent execution and safe repetition are different properties.

The SDK's bounded event stream also already works. The remaining move-7 requirements are a subscription bounded by
the caller's scope and a replaying stream of pending requests, including edit previews, with one selected manual or
automatic decision mode. [The SDK presently refuses approval-requiring tools][sdk-admission], so this is an absent
capability, not just an alternative spelling of the current API. Foreign card cleanup has landed; root-stage closure
still has two sites and model streams still close through `finishAttempt`. Outer ledger closure gives protection,
so this audit does not claim a newly reproduced visible stream leak.

## Effect-native interpretation

The useful boundary is simple: plugins provide optional behavior and their own record definitions; core decides
admission, approvals, durable writes and execution outcomes; hosts present committed results. A plugin can own a
service without acquiring a second authority over core policy.

Use the pinned Effect version's services for state with a lifetime, scopes for resource release, and structured
concurrency for workers. Keep pure definitions, reducers and contribution tables as ordinary TypeScript values.
Use SQLite transactions for atomic facts. A scoped service is progress only if the former global or competing writer
is removed, and a typed error is useful only if it is not immediately converted into an apparently successful empty value.

This gives concrete priorities without introducing another framework: complete core resume and the remaining activated-skill
grant issue; centralize
approval decisions; unify session close; correct model binding/accounting; fix catalogue failure behavior; and complete
current-value storage. Schema ownership proceeds in the existing plugin issue. SDK interaction and host cleanup retain
their own completion criteria instead of being presumed complete after internal services move.

## Tracking and evidence

The existing programme issue [#13397][i13397] should remain open. Its initial checklist is stale: #13388 is merged,
installed data plugins (#13392) and exact request recording (#13394) are closed, while #13390 and #13391 remain open.
Those closed deliverables do not close the broader plugin tracker [#13396][i13396] or the thirteen-move programme.

| Work                                                     | Existing home                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| Plugin record ownership and per-session delivery drain   | [#13390][i13390], [#13391][i13391], under [#13396][i13396]           |
| Approval authority and remaining catalogue requirements  | [#13397][i13397], moves 9 and 11; avoid a parallel programme tracker |
| Run input, wake-up, settlement and replay safety         | [#12881][i12881]; coordinate with #13415                             |
| SDK/process cleanup and common close behavior            | [#12884][i12884]                                                     |
| Model bindings, auxiliary accounting and WebSocket retry | [#12070][i12070], [#13407][i13407]                                   |
| Current-value storage and state consistency              | [#11867][i11867]                                                     |
| Shared commands and SDK streams                          | [#11861][i11861]                                                     |

Current source was read at the pinned remote commit. Original and amended requirements, merged PR descriptions,
open-PR state, and CI results were checked separately. The [Linux/macOS validation run][ci] at exactly this commit
passed static checks, both kernel shards, CLI runtime validation, builds, desktop E2E and webview smoke. The separate
[Windows run][windows-ci] at the preceding `0117c59eb2` commit failed both kernel shards. Its failure is not superseded
by the Linux/macOS success at the newer commit. Three assertions expected Unix path separators; another suite passed
all its tests but failed teardown with `EBUSY` while deleting SQLite. The logs do not identify the remaining handle's
owner. These are test-portability and cleanup failures, not generic runner failures, and the affected suites and
fixture are unchanged by #13412. A passing suite does not prove the unimplemented PRD
contracts. No new application test run was performed for this document; PR-reported experiments were not independently
repeated, and the original survey's entire defect list was not re-reproduced. This audit covers the thirteen moves and
the concrete paths cited above, not every possible defect in the repository.

[original]: https://github.com/LionSR/TeXRA/blob/a53db0e9df3d34b9784f99efb90f4d50883bddb9/.agents/docs/proposed/architecture/2026-09-26-effect-native-session-core.md
[plugin-design]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/.agents/docs/implemented/architecture/2026-09-24-plugin-architecture.md
[concepts]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/.agents/docs/proposed/architecture/2026-09-26-core-concepts.md
[p13350]: https://github.com/LionSR/TeXRA/pull/13350
[p13388]: https://github.com/LionSR/TeXRA/pull/13388
[p13411]: https://github.com/LionSR/TeXRA/pull/13411
[p13412]: https://github.com/LionSR/TeXRA/pull/13412
[p13414]: https://github.com/LionSR/TeXRA/pull/13414
[p13415]: https://github.com/LionSR/TeXRA/pull/13415
[goal]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/tools/goal/goalAutoApproval.ts#L20-L74
[goal-reproduction]: https://github.com/LionSR/TeXRA/issues/13397#issuecomment-5861029320
[policy-set]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/controllers/session/SessionRequests.ts#L426-L441
[open-request]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/runtime/SessionHandle.ts#L713-L747
[cli-approvals]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/packages/cli/src/runtime/approval/settleApprovals.ts#L43-L146
[skills]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/skills/runtimeSkills.ts#L337-L357
[plugin-arms]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/tools/pluginArms.ts#L22-L34
[unknown-rows]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/controllers/session/Database.ts#L275-L296
[session-close]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/controllers/session/sessionLayer.ts#L918
[close-all]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/controllers/session/sessionLayer.ts#L1192-L1213
[bootstrap]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/controllers/hostBootstrap.ts#L87-L94
[signals]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/eventBus/AppSignals.ts
[attempt]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/utils/core/sharedAttempt.ts#L23-L48
[compaction]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/runtime/run/compaction.ts#L261-L279
[helper]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/runtime/helperModel.ts#L95-L114
[usage]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/runtime/UsageMonitor.ts#L72-L89
[failed-rebind]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/runtime/ModelInvoker.ts#L1046-L1060
[lineage]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/storage/runRecords.ts#L121-L124
[listing]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/shared/schemas/sessionEvent.ts#L636-L682
[resume-setup]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/runtime/executeAgent.ts#L491-L550
[waiting]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/runtime/loop/toolUse.ts#L690-L711
[deferred-row]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/shared/schemas/sessionEvent.ts#L383-L392
[replay]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/runtime/loop/toolUseDispatch.ts#L750
[sdk-admission]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/packages/agent/src/effect/sessionPrograms.ts#L150-L163
[remote-list]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/remote/remoteAgentList.ts#L71-L110
[agent-cache]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/index/agentRegistry.ts#L192-L205
[agent-load]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/runtime/agentLoad.ts#L149-L208
[app-state]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/controllers/session/appStateStore.ts#L54-L106
[project-records]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/packages/desktop/src/main/desktopProjectRecords.ts#L65-L76
[worktree-keys]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/platform/defaults/worktreeStateStore.ts#L20-L39
[store-format]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/controllers/session/storeFormat.ts#L20-L102
[store-message]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/ui/copy/sessionStore.ts#L4-L13
[requests]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/shared/session/runtimeRequest.ts#L26-L77
[decision]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/shared/schemas/request.ts#L20-L29
[cursor]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/shared/session/sessionEvents.ts#L167-L183
[sdk-session]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/packages/agent/src/effect/sessions.ts#L92-L136
[documents]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/output/documentRounds.ts#L388-L418
[desktop-close]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/packages/desktop/src/main/index.ts#L1519-L1562
[i13397]: https://github.com/LionSR/TeXRA/issues/13397
[i13396]: https://github.com/LionSR/TeXRA/issues/13396
[i13390]: https://github.com/LionSR/TeXRA/issues/13390
[i13391]: https://github.com/LionSR/TeXRA/issues/13391
[i12881]: https://github.com/LionSR/TeXRA/issues/12881
[i12884]: https://github.com/LionSR/TeXRA/issues/12884
[i12070]: https://github.com/LionSR/TeXRA/issues/12070
[i13407]: https://github.com/LionSR/TeXRA/issues/13407
[i11867]: https://github.com/LionSR/TeXRA/issues/11867
[i11861]: https://github.com/LionSR/TeXRA/issues/11861
[ci]: https://github.com/LionSR/TeXRA/actions/runs/36375025981
[windows-ci]: https://github.com/LionSR/TeXRA/actions/runs/36374295031
[activations]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/runtime/loop/step.ts#L87-L109
[step-skills]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/agent/runtime/loop/step.ts#L263-L293
[skill-grants]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/utils/files/externalRoots.ts#L191-L227
[external-trust]: https://github.com/LionSR/TeXRA/blob/0a5aa283bbcc4b23af6ec689fea2a11db00517e2/src/common/plugins/pluginDigest.ts#L109-L156
