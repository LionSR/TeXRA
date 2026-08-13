# Host-parity audit: CLI / extension / desktop behavior divergences (2026-07)

> **Status:** Adjudicated audit (2026-07-09), pinned to HEAD `cf138f802` in an
> isolated worktree. origin/main moved 6 commits _during_ adjudication and one
> draft finding (#7693 goal-entry leak) was fixed mid-audit by PR #7729 —
> the re-verify-at-HEAD trap is live; re-open every cited site before acting.

Method: six adjudicated matrices — run lifecycle, interactions/approvals,
fact-family rendering, capability surface, history/sessions/continuation, and
the CLI's own two surfaces (Ink TUI vs headless `texra run`/`--print`/NDJSON) —
across four host surfaces (extension, desktop, CLI-TUI, CLI-headless). Every
drift / false-simplification row and every contested deserved row was re-opened
at the cited file:line; all trackers cross-checked via `gh` at adjudication
time. Companion docs: `2026-07-03-tech-debt-audit.md` (A2 named this seam "the
single largest source of 'works in extension, broken in desktop' bugs"),
`2026-07-09-tech-debt-audit-runtime-ui.md` (A2/A16/A17, rejected trap R4),
`2026-07-09-tech-debt-error-ownership.md` (EP-R2/EP-4, UICPL-04),
`2026-07-03-session-scoped-runtime-architecture.md` (plane-2 pending-registry target,
per-session queue ruling).

The maintainer's framing, which this audit uses as its verdict vocabulary:

- **parity** — same behavior via one shared owner. Keep; named so nobody
  "unifies" it again.
- **deserved** — different on purpose (terminal modality, headless-parity
  discipline, or a ruled decision). Deliverable = the fence register (§6), so
  future audits and swarm agents stop re-flagging these.
- **drift** — accidental: nobody ported it, or two projections of one shared
  fact forked.
- **false-simplification** — the maintainer's specific concern ("some simplify
  adds complexity"): a host simplified a capability away and the complexity
  re-landed somewhere worse — mislabeled outcomes, advertised toggles that
  no-op, tools that throw wiring errors into the model loop, data nothing can
  reclaim or export.
- **copy-parity-risk** — identical today only because N hand-maintained copies
  happen to agree.

---

## 1. The parity scoreboard

| Domain                                     | rows | parity | deserved |  drift | false-simpl. | copy-parity |
| ------------------------------------------ | ---: | -----: | -------: | -----: | -----------: | ----------: |
| 1. Run lifecycle (launch/stop/resume/wake) |    7 |      0 |        3 |      1 |            1 |           2 |
| 2. Interactions & approvals                |    9 |      1 |        2 |      4 |            1 |           1 |
| 3. Fact-family rendering                   |    8 |      1 |        2 |      3 |            1 |           1 |
| 4. Capability matrix (tools/settings)      |    8 |      2 |        0 |      3 |            3 |           0 |
| 5. History, sessions & continuation        |    7 |      1 |        1 |      2 |            3 |           0 |
| 6. CLI: TUI vs headless                    |    8 |      0 |        1 |      4 |            2 |           1 |
| **Total (as adjudicated)**                 |   47 |  **5** |    **9** | **17** |       **11** |       **5** |
| **Deduped**¹                               |   45 |      5 |        9 |     16 |           10 |           5 |

¹ Two cross-matrix dedups: (a) the TUI output-file-facts row appears in domains
3 and 6 with **conflicting verdicts** (deserved vs false-simplification);
resolved to **deserved-with-cleanup** on domain 3's corrected basis —
`delegate_workflow` tool results already carry outputs + compileFailures into
the TUI transcript (`subagentResults.ts:165-176,546-553`) and root workflow
runs are headless-only — provided the cleanup rider lands (delete the three
dead entries from `subscribeRuntimeHost.ts:376-378` + fence comment naming the
tool-result channel). (b) Domain 6's usage row merges into domain 3's (one
drift, two facets).

The explicit-parity count understates the healthy baseline: extension+desktop
share `ProgressFactApplier` + one `@progressView/frontend` renderer (parity by
construction for todos/plan/round-stage/child-activity/usage/status), and the
following shared owners were re-confirmed load-bearing at all three hosts — do
not re-flag: `resolveAndResumeStream` + `detectWaitingStreams` +
`deriveResumability` (resume), `streamStatusDisplay.ts` (labels),
`reduceStreamMeta` (process tails), `loadChatExportInput`/`assembleTrace`
(export), `runLatexdiffForExecution` (#6529 landed), `initNodeAgentRuntime`
(`nodeHost.ts:115-132`, "centralized so the hosts cannot drift"),
`approvalGatedTools.ts` (one list, one enforcement), and the `STATE_SETTINGS`
catalog with per-entry `hosts` rosters + guardrail suite — the model the rest
of the capability matrix should copy.

---

## 2. False simplifications

Lead section by design: each of these is a case where dropping a capability
did not remove complexity — it relocated it into a mislabel, a lying setting,
or unreclaimable state. Format: three-host behavior → where the complexity
landed → convergence.

### FS1. CLI `AgentResumePort` is a `false` stub — shared code mislabels drops as delivery

- Extension: real port → `tryResumeFromSnapshot` → shared
  `resolveAndResumeStream`, `isResumeInFlight`, parentStreamId threaded (#7543
  fix). Desktop: same shared orchestrator + deleted-stream pre-check
  (`desktopAgentExecution.ts:1158-1224`). CLI:
  `agentResume: { tryResumeStream: async () => false }`
  (`initPlatform.ts:249`), TUI and headless alike.
- Scope (verified, narrower than it looks): inside one live CLI process this is
  mostly moot — root runs block in-process at WAITING
  (`ToolUseWaitNode.ts:118-136`) and live child loops are woken by the enqueue
  itself (`DelegationTools.ts:346-362`). The stub bites exactly where no loop
  is listening: a `texra resume`d orchestrator whose subagents persisted
  WAITING (wake failure is loud post-#7402 but the child **never resumes**
  where ext/desktop would, and the orchestrator gets a terminal error via
  `deliverResumeWakeFailure`), plus `children_running` edges
  (`childRunLoop.ts:419-424` silent drop; inquiry threads parked at
  `resumeOutcome 'queued'`, `inquiryContinuation.ts:131-146`).
- **Where the complexity landed:** in the _shared_ wake/delivery code, which
  now reports `queued_resume_failed`/terminal errors for what is actually an
  unwired host port.
- **Convergence:** the single owner exists and the CLI has both halves
  (`resolveCliResumeSnapshot` + `resumeExecution.ts`); one wiring caveat — the
  port is streamId-keyed, the CLI resolver executionId-keyed, so thread the
  snapshotStore's streamId→executionId map. Wire a real `tryResumeStream`
  through `resolveAndResumeStream`, OR fence an explicit decided divergence
  whose shared-code outcome says "resume manually with `texra resume <id>`".
  Either way, **NEW tracker** (searched: only closed #6826/#5452/#7543 nearby).
  Lands together with CP1 (§5), the delivery half.

### FS2. Retry non-answers resolve `{action:'cancel'}` — runs terminalize "Retry cancelled by user" with zero user involvement

- Extension: real retry panel, waits indefinitely; shared mapper folds
  non-retry into cancel. Desktop: **decline-the-panel is the ruled EP-R2
  design** (fenced, §6) — but `requestRetry` returning `cancel`
  (`desktopHostInteractions.ts:131-133`) mislabels the outcome as user
  cancellation (`RetryState.ts:312-320`). CLI-TUI: any non-accepted decision —
  including policy-deny under `--approval-policy never` and the
  credential-exhausted auto-deny — resolves `cancel`
  (`subscribeApprovals.ts:537-540,547`): the exact mislabel #7331 already fixed
  for headless, which correctly returns `{action:'deny', reason}` → FAILED
  (`approvalAdapter.ts:151-168`).
- **Where the complexity landed:** outcome taxonomy — FAILED runs report
  CANCELLED, poisoning exit semantics, history labels, and support triage.
- **Convergence:** desktop half is tracked-decided-unbuilt: **UICPL-04**
  (`2026-07-09-tech-debt-error-ownership.md:50`, ~0 LoC, rejected traps stand).
  TUI half is **NEW**: reuse headless's existing owner
  (`toRetryResult(decision, humanInputAvailable)` — the TUI already imports the
  module), no new mapping layer; explicit modal-cancel stays `cancel`.

### FS3. Desktop `WORKFLOW_AUTO_OPEN_PDF` toggle no-ops — schema advertises `hosts:['vscode','desktop']`, handler drops the event

- Extension handles `requestOpenFile` (`agentEventListeners.ts:34-44,143`).
  Desktop's runtime-host switch handles only ensureProgressView + showError;
  `requestOpenFile` hits `default: return`
  (`desktopAgentExecution.ts:1006-1036`) — despite desktop owning both a
  pdfOverlay and an `openPath` fallback. CLI is the model: excluded **and
  documented at the schema** (`stateSettings.ts:362-365,399-402`).
- **Where the complexity landed:** a live settings toggle that lies — "works in
  VS Code, broken in the app."
- **Convergence (either side is net-honest):** wire desktop `requestOpenFile`
  to its existing preview host, or edit the roster to `hosts:['vscode']` so the
  toggle disappears (net-delete). **NEW** (gh: untracked).

### FS4. The setup-agent tool family (9 tools) throws wiring errors into the model loop on desktop and CLI

- `setSetupPlatform()` is called **only** from `extension.ts:553`; every family
  tool (`probe_environment`, `verify_setup`, `set/unset_api_key`,
  `invoke_command`, `install_vscode_extension`, `read/update_config`,
  `send_to_terminal`) calls `getSetupPlatform()` inside `execute()`, and
  `BaseTool.call()` converts the throw into a model-visible error ToolResult:
  "Setup platform not initialized. Wire it from extension.ts…". Yet desktop
  first-run onboarding launches the setup agent (`setupLaunch.ts:125`) and
  `texra setup` is a shipped flagship CLI command (`setup.ts:58`). The
  unavailable-lists hide only `list_api_keys` of the family (af8bc3b57 fixed
  that one symptom, left the 9 siblings).
- **Where the complexity landed:** the flagship onboarding flow on 2 of 3
  hosts runs an agent whose advertised schema contains tools that error with an
  extension-internal wiring message — error-retry noise in the model loop.
- **Convergence:** derive a default `SetupPlatform` from the existing
  host-neutral `platform()` ports (secrets/config/auth exist on all hosts),
  keeping genuinely VS Code-only adapters per-host runtime-unavailable — this
  **deletes** most of the bespoke `extension.ts:553` adapter object. Minimum
  honest fix: extend both unavailable lists to the whole family. **NEW**
  (verified untracked; highest-value capability finding). Fits #7724's
  hosts-as-examples program.

### FS5. `texra.skills.enabled` is an advertised VS Code setting that does nothing

- Extension contributes it (`package.json:832-840`) but never calls
  `setRuntimeSkillSources`; `loadRuntimeSkillCatalog` returns an empty catalog
  on empty sources (`runtimeSkills.ts:62-63`) — the setting toggles an already-no-op.
  CLI is the only production setter (`initPlatform.ts:341`) with full
  `/skills` + `texra skills`. Desktop: **not decided-for-free** — #7692
  (CLOSED) explicitly deferred the skill-sources fold as a product decision.
- **Where the complexity landed:** a documented setting whose observable effect
  is zero; worse than absence.
- **Convergence:** register skill sources in `extension.ts` alongside
  `registerAgentFeatures`, or remove the contributed setting until it does
  something. Desktop half stays the deferred product decision — cite #7692's
  deferral, don't treat it as ruled. **NEW**.

### FS6. Desktop Settings says "Goals are not available in the desktop app yet" while the goal runtime is live

- Goal tool injection runs (`platform/index.ts:215`), the progress bridge
  renders GoalStore state into the rail
  (`desktopSessionProgressBridge.ts:452,513-516`) — but
  `desktopSettingsIpc.ts:1263-1266` denies goals exist. Support cost: "my goal
  is running but the app says goals don't exist."
- **Convergence:** wire `goals.getList/revealStream` to the shared GoalStore
  the bridge already imports (near-zero code), or correct the message to "goal
  management UI not ported". **NEW**.

### FS7. CLI writes stream sidecars forever and can never reclaim them

- CLI writes the exact same `streamData/{id}/*` + streamLogs the GUI hosts read
  (`runChatTui.tsx:396-407`) but has **zero** delete/sweep path (grep
  `SessionStores|deleteStream|sweepOrphanedStreams` over `packages/cli` = 0);
  `texra history delete` removes only `executions/{id}` and reports success
  while the transcript bytes stay on disk. `streamDataPaths.ts:14-19` concedes
  "no retention policy or GC."
- **Where the complexity landed:** unbounded `~/.texra` growth + a delete
  command that lies by omission.
- **Convergence:** route CLI history-delete through the existing
  `SessionStores` reap (host-neutral; third caller of one existing owner).
  Execution-first delete needs the execution→stream reverse resolution
  **#7469** (OPEN) is deciding — same dependency as DR12; do them as one move.
  `--all` can use the facade's `deleteAll` today.

### FS8. Desktop history Rerun/Restore: the "fix" was hiding the buttons

- Extension: rerun = `runExecuteCommand(config)`; restore = shared
  `agentConfigToTaskState` → main view. Desktop: 3 `unsupported()` stubs
  (`desktopSettingsIpc.ts:1078-1083`, `desktopAgentExecution.ts:631`) — and the
  shared frontend grew an `unsupportedCommands` hide-the-buttons mechanism
  specifically to mask them (`HistoryItemElement.ts:59-68`, post-#7084, which
  was closed _by choosing to hide rather than wire_).
- **Where the complexity landed:** a masking mechanism in the shared frontend —
  the complexity-cost, not the fix.
- **Convergence:** both building blocks are host-neutral and dual-consumed
  already; desktop executes agents; wiring rerun/restore deletes 3 stubs and
  shrinks the `unsupportedCommands` set. CLI half is deserved (#5197,
  fenced §6). **NEW** (untracked).

### FS9. Desktop conversations are un-exportable by any tool

- Extension exports md/tex/html via host-neutral `ChatExportController` +
  `assembleTrace`; CLI exports md/html **byte-identical by shared owner**
  (`loadChatExportInput.ts:68` backs both). Desktop: all three
  `unsupported()` (`desktopSettingsIpc.ts:1084-1092`) — and because desktop
  history lives under Electron `userData`, not `~/.texra` (fenced silo, #3865),
  `texra history show --export` cannot reach it either. Un-exportable, period.
- **Convergence:** desktop calls the existing host-neutral controller and
  saves/opens the file (it already has `openPath`); net-deletes 3 stubs and
  defuses the #3865 silo's sting. **NEW** (untracked; pair with FS8 as one
  issue).

### FS10. Headless NDJSON dumps unfrozen presentation-event names onto the frozen rail

- The ndjson gate in `runtimeHost.ts:80-89` precedes all handlers, so every
  non-intercepted runtime event — including the 5 presentation events the docs
  explicitly exclude from "the frozen host progress compatibility vocabulary"
  (`runtimePresentationEvents.ts:9-15`) — is emitted raw as `kind:'progress'`.
  Since run-failure toasts ride `requestShowInstruction`/`requestShowError`,
  these unfrozen names **are** the error rail scripts parse; renaming a
  presentation event silently breaks public output with no failing test.
- **Where the complexity landed:** an implicit public API made of names the
  codebase reserves the right to rename.
- **Convergence:** the TUI/headless-text instruction-drop half is **#7644**
  (OPEN, maintainer-approved direction) — but its fix lands _below_ the ndjson
  gate and won't touch this. Decide one owner: project
  showError/showInstruction through the frozen projection in
  `sessionProgressSubscription.ts` (deleting the raw passthrough — net-delete),
  or pin the passthrough names in `CliNdjsonRecordContract` + a runtimeHost
  test. File as a **NEW companion to #7644**, citing it. Fits #7726 + #7728.

---

## 3. Drift register

Accidental divergences. Format: mechanism → single-owner convergence → net
elements → tracker. Rows already carrying issue numbers are cited, not
re-explained.

- **DR1. Pending-interaction cleanup on stop, three shapes.** Extension:
  kind-scoped retry-cancel, conditional; desktop: same block copy-pasted,
  unconditional; CLI: `clearApprovals()` settles _every_ kind, _every_ stream
  (`approvalQueue.ts:242-267`). Shared flows already cancel stream-scoped
  interactions for live runs (`runToolUseFlow.ts:285,469`;
  `executeAgent.ts:236-242`) — residual divergence is only the post-run retry
  panel + the CLI's over-broad scope. → Move the stream-scoped cancel into
  `stopAgentStream` on the session-owned registry. **Net:** deletes 2
  copy-pasted retry blocks + the conditional/unconditional split. **NEW**.
- **DR2. Prompt replay after view reload.** Extension replays 6 kinds but
  **not userQuestion** (`ProgressViewProvider.ts:468-482`; worse — a
  hidden-webview `show()` never delivers even once, run blocks with no
  timeout). Desktop: **zero replay** (`WEBVIEW_READY → syncFullView()` only;
  renderer reload orphans every pending prompt while main-process
  `pendingRequests` hold the settle). CLI: no reload concept (structural).
  → One set-level `replayAll()` on `ApprovalRequestHandlerSet`, called from
  both hosts' ready paths. **Net:** deletes the hand-enumerated per-kind list;
  desktop replay for free. Not the rejected R4 cross-host-table trap; matches
  the plane-2 target (`2026-07-03-session-scoped-runtime-architecture.md:260-262`).
  **NEW** (distinct from #7644/#7639/#6887).
- **DR3. External-inquiry rehydration is extension-private.**
  `hydrateOpenInquiries` reads host-neutral durable manifests but lives in
  `ProgressViewProvider.ts:412-466`; desktop ignores `inquiryThreadUpdated`
  and never reads a thread manifest — open inquiries survive on disk, panels
  vanish on restart. → Relocate hydration into the shared progress backend
  (**move**, deleting the extension copy). Headless auto-drop stays fenced.
  **NEW**.
- **DR4. `HostInteractionOptions.timeoutMs` is fully inert.** TUI built the
  whole consumer (`withInteractionTimeout`, `NEUTRAL_TIMEOUT_DECISION`,
  #7307/#7444); **zero** call sites pass it; every `'timeout'` result branch is
  unreachable on every host. → Net-delete the option, the TUI machinery, and
  the dead branches — already ruled a do-now by the abstraction-calibration
  audit; cite #7307/#7444 so deletion isn't mistaken for a revert.
- **DR5. Approval serialization scope.** Bash queue is process-wide
  (module-singleton PQueue — desktop windows serialize behind each other);
  toolEdit bypasses the queue; TUI/headless each serialize their own way.
  Both halves **tracked-decided**: per-session narrowing = runtime-ui audit
  A17 (deferred, with its rejected parallel-registry trap); the
  bash-vs-toolEdit asymmetry resolves by deletion via **#7641** (OPEN,
  ~−300..450 LoC). Cite, don't re-decide.
- **DR6. `goalPaused` dropped by GUI hosts.** Shared `ProgressFactApplier`
  subscribes then no-ops (`:280-282`, landed mechanically in e8a027d3a, no
  fence); GUI degrades to chip-only via `goalStateChanged`; TUI renders a
  synthetic notice but ignores `goalStateChanged` — each host keys off a
  different fact. → Emit the pause notice as a core-owned stream-log row at the
  emit site (`ToolUseWaitNode.ts:77-84` already documents intent), then
  **delete** the CLI synthetic (`appendGoalPausedTranscriptNotice`) —
  converges with **#7601** (OPEN). Record the alternative if rejected: delete
  the redundant run fact. #6968-adjacent (fact-split territory).
- **DR7. Run-completion/approval notifications: desktop is the silent host.**
  CLI notifies (OSC 99/9 + BEL, capability-gated); extension = platform-norm
  editor chrome (fenced); desktop = **zero** (`grep new
Notification|flashFrame|setBadge` = 0) — the one host users background as a
  standalone app. → Map the same two moments the CLI keys off (session result,
  approval-pending) to Electron `Notification`. Fold into the **#7682**
  desktop-notification-surface decision (fits #7728), don't file in isolation.
- **DR8. Usage totals: the token number a TUI user sees is computed by code no
  other surface runs.** GUI: shared UsagePanel with USD cost. TUI: local
  `sumResumeUsageStats` fold, used only for the resume hint; `/status` omits
  usage/cost entirely. Headless final result carries `totalCostUsd` (>0) but
  **no token stats**; NDJSON emits raw increments. → Surface the run's token
  total in the final result / terminal record next to `totalCostUsd` (usage
  monitor already records it), render cumulative + shared cost derivation in
  `/status`, then **delete** the TUI-side fold. **NEW** (low urgency).
- **DR9. Desktop `unsupported()` census: 23 rows, 17 unported drift.** (2
  deserved-definitional, 2 deserved-modality, 2 = FS6.) → Before porting
  anything, recompute against **#7688**'s dead-command set (some rows delete
  with their schema members — do that first). Cheapest real ports: the 5
  history rows (= FS8/FS9). "Yet" with no ticket is slow-motion silence.
- **DR10. GitHub PR subscriptions: desktop absence is drift** (long-lived
  host, no platform constraint; the 7 actions are extension-frontend-sent, so
  not in #7688's dead set); CLI absence deserved (`install-github-action` is
  the CLI story). → Decide: port the subscription controller behind the shared
  layer for desktop; fence CLI out explicitly. **NEW**.
- **DR11. Agent creation: flow is shared, launch surfaces aren't.** Extension
  full; desktop visible stubs; CLI **silent** absence (`agents.ts:128-131` —
  the discoverability bug). → Decide once: add `texra agents create` + desktop
  wiring (flow reuse), or fence extension-only and say so in CLI help. **NEW**.
- **DR12. History-delete semantics, three shapes.** Tab-delete goal half is
  **DONE** (#7693 closed via PR #7729) — do not re-file. Remaining: the three
  execution-first history-delete surfaces bypass the `SessionStores` facade
  (ext/desktop leave goal entries; all three leave sidecars — CLI half = FS7);
  CLI `--all` passes no exclude set and has **no active-run guard** (the
  extension's in-process guard can't port — separate process; needs an on-disk
  liveness decision). → Land **#7469** (OPEN) first, then route all three
  through the facade and net-delete the CLI's hand-paired `forgetByExecutionIds`.
  The `--all` guard is the one untracked correctness bit.
- **DR13. History outcome labels: two parallel projections over one
  `ExecutionListingEntry`.** Settings tab (ext+desktop, shared
  `HistoryMessageBuilder`) shows no status, startup model, filters process
  entries; CLI shows resumable/terminalStatus, _current_ model, no filter.
  → Decide once at the existing shared owner (a legit outcome is "settings
  stays config-oriented; Progress board owns status") — no new reducer. **NEW**
  (decision).
- **DR14. Stream-status duplicates on the NDJSON rail.** #7697's duplicate
  transitions were patched renderer-side (#7712); the NDJSON dual projection
  (session fact + run fact, `sessionProgressSubscription.ts:64-65,94-105`)
  remains undeduped; #7695's checkboxes are done, so this half is untracked.
  → Root-cause the guard-escaping emission, make publication idempotent per
  (stream, phase, substate) at `StreamStatusService` across both rails, then
  **delete** the renderer-side guard. **NEW companion** citing
  #7697/#7712/#7695; #6968 territory.
- **DR15. Headless exit codes for routine provider failures.** Tracked +
  decided: **#7645** (OPEN, re-verified live at HEAD) — double error print +
  exit 1; `ModelOrNetworkError(3)` never used for agent runs. Cite only.
- **DR16. NDJSON parity suite pins ~half the frozen vocabulary.** Zero
  coverage for 15 record types incl. **all child-stream events**;
  `CliNdjsonRecordContract` deliberately pins only the kind registry. → Pure
  test addition: extend `CliSessionProgressSubscription.vitest.mts` to the full
  vocabulary — it is the rail's only pin. Fits **#7728**.

---

## 4. Copy-parity risks

Identical today only by parallel code. Name the shared-owner move or the fence.

- **CP1. FollowUpWakeResult → user-message mapping, duplicated per host.**
  Ext/desktop carry near-identical switches
  (`followUpCommand.ts:79-110` / `desktopAgentExecution.ts:1361-1400`); CLI
  never calls the wake at all and marks queued-to-dead-stream follow-ups
  "delivered" (`runChatTui.tsx:695`), plus the `children_running` release
  branch never runs → stale-queue leak. → Co-locate the outcome→message table
  with `wakeQueuedFollowUpStream` in `src/agent/followUp` (net-deletes both
  switches; hosts keep only the toast verb); CLI submit path calls the same
  wake. Lands with FS1.
- **CP2. Stop detach-policy pairing repeated at 5 sites.** Closed **#5575
  decided this shape** (registry owns stop; hosts supply only their policy
  input) — the pairing is resolved design, not copy-paste; the registry-default
  idea would revisit #5575. The live item is narrow: CLI has no setter and the
  toggle lives in workspaceState, so **CLI always cascades** — decide a
  `.texra/config.json` key feeding `detachSubagentsOnStop()`, or fence it (§6).
- **CP3. Bypass toggles: TUI dual-writes shared maps + cliState mirror.** The
  single state owner exists (`streamApprovalQueue.ts:51-85`) and a third
  channel already exists (`HostInteractions.setApprovalBypassState`, used by
  `goalAutoApproval.ts:31`) — but the shared setters don't call it and the CLI
  subscribes to none of the emitted bypass events. → Pick ONE existing channel
  (port callback or event subscription), then **delete** the per-kind imperative
  mirror writes at the three prompt sites. No new layer. **NEW**.
- **CP4. Headless run-progress line hand-rolls a third status vocabulary.**
  `formatRunProgressStatus` maps COMPLETED→'done', CANCELLED→'interrupted'
  (`runProgressRenderer.ts:410-415`), bypassing the shared table all
  interactive surfaces use; a phase rename won't reach it. → Replace with
  `formatStreamStatusLabel(status, {style:'cliCompact'})` (style exists) and
  delete the map (~−5 LoC), or fence 'interrupted' with a comment.
- **CP5. Three hand-maintained run-fact filter arrays inside `packages/cli`.**
  NDJSON 13 types / TUI 12 / text renderer 5 — no compiler guard (unlike the
  session-fact side, which is parity-by-`assertNever`); a new AgentEvent type
  silently drops from whichever list wasn't updated. → One exported const of
  CLI-progress event types, per-consumer subsets derived. Three callers = legit
  shared const under the abstraction-cost guardrails. Mechanical net-delete.

---

## 5. Deserved-divergence register — THE FENCE

First-class deliverable. Every verified-deserved divergence, one line each, so
future audits and swarm agents stop re-flagging them. Anchors are in the
adjudicated matrices; spot-verified at `cf138f802`.

**Terminal modality (CLAUDE.md TUI discipline — defer non-terminal content):**

1. CLI lacks tool-edit mid-flight actions (openDiff/preview/latexdiff) and
   user-edited apply — and note **desktop has full parity** here via
   `desktopToolEditApproval.ts`, so this is _not_ an extension-only capability.
2. Auto-open final output (`texra.agentOutputs.autoOpenFinal`) is
   GUI-host-only; shared `selectAutoOpenFinalOutput` policy, hosts supply the
   open verb; document the key as having no CLI effect.
3. TUI single-modal-at-a-time for all interaction kinds vs concurrent webview
   panels — one keyboard, one focus.
4. File-tree "Modified by TeXRA" decorations are VS Code-explorer-only; the
   touched-files fact reaches every host via its existing output-files surface.
5. Proposal `setup` action is ext/desktop-only (restores into a config UI the
   terminal doesn't have) — #6888/#6906 converged the mechanism; setup stayed
   host-gated by design. Watch item: TUI approve can't override model/agent.
6. CLI single-root-run concurrency (one conversation per terminal, child
   streams underneath) vs N parallel streams — same shared per-stream lock.
7. Per-host status-label _projectors_ (webview vs `sessionStatus.ts`) atop the
   one shared `streamStatusDisplay` table.

**Headless-parity discipline (clig: never require a prompt; stdout byte-parity):**

8. Headless WAITING = `stopAfterCycle:true` — a blocking turn terminates the
   run instead of hanging a pipe.
9. Headless per-kind approval auto-decision policy (yolo approves
   toolEdit/bash/plan/proposal/retry; never credential-exhausted retries; never
   synthesizes user-question answers; deny = exit 4 distinct from exit 1) —
   challenged as an unported gap and upheld: interactive approval cannot exist
   without a TTY. Residual small issue: the auto-denial never appears as a
   structured NDJSON record.
10. Headless external-inquiry auto-drop with explanatory feedback naming
    `ask_user_question`/`texra chat` — async continuations can't outlive a
    one-shot process; documented in the feedback itself.
11. Headless plan approval never returns `approve_and_goal` — auto-entering
    interactive supervision from a yolo policy would be wrong.
12. Headless bypass absence — `--approval-policy yolo` _is_ the bypass.
13. `followUpSent` kept session-local off the NDJSON rail (pinned by test) —
    `updateQueuedFollowUps` is the public fact.
14. No content streaming in headless output (final result = `lastResponse` +
    `totalCostUsd`) — a stream-json mode would be a new feature, not a
    convergence fix.
15. Headless-text progress line: stderr-only, off-TTY degradation, disabled
    for ndjson.
16. APPROVAL_GATED tool hiding: one shared list + one shared enforcement; only
    CLI can hit the precondition — parity by shared owner.

**Ruled decisions (cite the ruling, don't re-litigate):**

17. Desktop ships no retry panel and declines synchronously — EP-R2
    (`2026-07-09-tech-debt-error-ownership.md:16`); retry transport stub kept per
    EP-4. Only the cancel-vs-deny semantics are wrong (FS2/UICPL-04).
18. CLI workflow-resume refusal ("only tool-use sessions can be resumed") —
    explicit, actionable; workflows re-run via `texra run`.
19. CLI resume-not-rerun: no "rerun stored config" surface (#5197) — shell
    history + flags are the CLI-native rerun; don't converge toward a Rerun
    button.
20. Three per-host storage roots with byte-identical relative layout
    (`streamDataPaths.ts:1-13`) — deliberate until the shared-root flip,
    tracked **#3865** (OPEN); the silo's downstream costs (FS8/FS9) are
    separately actionable, the silo itself is not drift.
21. Stop detach-policy plumbing shape (hosts supply policy input) — #5575.
22. Silent schema-narrowing for host-fenced tools (bare `continue` in
    `passesRuntimeGates`) — **downgraded from false-simplification**: the
    missing-dependency toast is worded for installable deps; fenced tools never
    enter the model schema, so no retry loop. Optional polish: a trace-only
    fact, never a toast.
23. `inline_comment` + inlineCriticism settings extension-only (VS Code
    CommentController); `diagnostics.add` narrowed gracefully (subcommand
    stripped, list/count stay — the model pattern for host-narrowed tools);
    `inquiry` hidden on CLI by session lifetime (rationale in-file).
24. `openVscodeSettings`/`setProviderVscodeSetting` unsupported on desktop —
    definitional, correctly worded (not "yet").
25. STATE_SETTINGS host scoping with in-catalog rationale (latexdiff rows,
    WORKFLOW_AUTO_OPEN_PDF CLI half) — decided at the single-owner declaration
    site, guardrail-tested.
26. Lean language-services backend split (extension injects lean4-extension
    LSP; CLI/desktop register the direct adapter) — same injectable port; also
    why extension calls `registerAgentFeatures` instead of
    `initNodeAgentRuntime`.
27. Copilot subscription absent everywhere — #6729 (OPEN) already decides it
    will be extension-gated when wired.
28. Extension has no OS-level notification — VS Code platform norm; the hosts
    where the user can be away are CLI (has it) and desktop (DR7).
29. Process-output cap constants differ per host (100k/80k webview vs 8k
    exact-cut TUI) atop the single `reduceStreamMeta` owner — display-budget
    tuning, both commented.
30. TUI drops the output-file run-fact family **given the cleanup rider**
    (delete dead filter entries + fence comment naming the delegate_workflow
    tool-result channel that already carries outputs/compileFailures) — the
    fact channel is a GUI-progress-board projection; root workflow runs are
    headless-only. This resolves the domains-3/6 adjudication conflict.
31. CLI-only input history (TTY line-editing affordance); CLI history
    list/show machine-readability; CLI lacking tex/PDF export (md/html already
    byte-identical via shared owners — keep that).
32. NDJSON projection import fence (only `runExecution.ts` + named tests may
    import `sessionProgressSubscription`) — structurally prevents a second
    emitter.
33. Goal state on CLI is pull-based (/status, /goal) vs live chip — acceptable
    provided DR6 collapses the goalPaused/goalStateChanged fact split.

---

## 6. Suggested priority

Ordered, net-delete-biased. Existing trackers absorb most items; **six genuinely
new issues** are worth filing (grouped below). Per swarm discipline: re-check
open issues immediately before filing — #7729 landed mid-audit and superseded a
draft finding.

**Do now (decided or pure deletion):**

1. **DR4 timeoutMs net-delete** — already ruled a do-now; −machinery, −dead
   branches, cite #7307/#7444.
2. **FS2 desktop half** — UICPL-04, ~0 LoC, decided-unbuilt (#7726). Ride the
   same PR with the **TUI deny half** (reuse `toRetryResult`, no new layer).
3. **#7645** headless exit codes — tracked, decided, still live at HEAD
   (#7726).
4. **#7641** toolEdit legacy-fallback deletion (−300..450 LoC); shrinks DR5 to
   bash-only.
5. **CP4 + CP5** — mechanical vocabulary/filter dedups, small net-deletes
   (#7727 leaked-conventions territory).
6. **Fence commits** — land §5 as code comments where named (TUI filter
   entries + tool-result-channel comment; `autoOpenFinal` doc line;
   DESKTOP_UNAVAILABLE_TOOLS rationale comments copying the CLI convention).

**New issues to file (the six):**

7. **Setup-platform family (FS4)** — minimum: extend both unavailable lists to
   the family; better: default SetupPlatform from `platform()` ports,
   net-deleting the extension adapter. Fits #7724.
8. **CLI resume port + wake delivery (FS1 + CP1)** — one issue, two halves;
   single owner exists; net-deletes the two host switches.
9. **Pending-prompt durability (DR2 + DR3)** — `replayAll()` on the handler
   set (deletes the per-kind list, fixes userQuestion + desktop) + relocate
   inquiry hydration to the shared backend (move, not add). Fits #7725/#7726.
10. **Desktop history rerun/restore/export (FS8 + FS9)** — deletes 5–6 stubs
    over existing host-neutral owners; defuses the #3865 sting. Sequence after
    recomputing #7688's dead set (DR9).
11. **Honest-settings trio (FS3 + FS5 + FS6)** — wire-or-remove for
    `WORKFLOW_AUTO_OPEN_PDF@desktop`, `texra.skills.enabled@extension`
    (desktop skills stays the #7692-deferred product decision), desktop goals
    message. Each is tiny; all three are "advertised ≠ real" (#7726 spirit).
12. **NDJSON rail companion (FS10 + DR14 + DR16)** — freeze-or-project the
    presentation passthrough (cite #7644), owner-side status idempotency then
    delete the #7712 renderer guard (cite #7697/#7695; #6968-adjacent), and
    extend the parity suite to the full vocabulary (#7728).

**Blocked / decision-first:**

13. **DR12 + FS7 delete-lifecycle convergence** — blocked on **#7469**
    (execution→stream resolution); then one facade route net-deletes the CLI
    hand-pairing. The CLI `--all` no-guard bit needs the cross-process
    liveness decision first.
14. **DR7 desktop notifications** — fold into **#7682** (#7728), not a
    standalone issue.
15. **Decision-only rows** (record the ruling, then §5 or a small PR): CLI
    detach-on-stop config surface (CP2), GitHub subscriptions on desktop
    (DR10), agent-create launch surfaces (DR11), history label projection
    (DR13), DR8 usage totals owner.

**Deliberately not proposed:** any cross-host reducer or merged HostInteractions
implementation (rejected trap R4; the runtime-ui audit's per-host-projector
fence stands); re-deciding #5575's stop-policy shape; a new pending-interaction
table beside the singletons (A17's trap); converging the CLI toward GUI rerun
buttons or GUI hosts toward TUI modality. The pattern this audit keeps finding
healthy — one shared owner, per-host verbs, divergence documented at the
declaration site (`STATE_SETTINGS` model) — is the convergence target for
everything above; nothing here requires a new layer.
