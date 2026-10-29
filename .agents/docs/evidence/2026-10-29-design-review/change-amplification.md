# Lens: complexity measured by six concrete changes (APSD ch. 2)

Revisions: TeXRA `cae1afc30a` (paths under `packages/`), pi `c3d8ce4` (paths under `packages/`), DeepSeek `f3803c96` (paths under `packages/`). Cost is 1 (one local file) to 5 (many files across packages with hidden coupling). Before scoring, I checked these peer claims in the source myself: pi `durable/src/harness/tool.ts:158-187`, `durable/src/types.ts:53`, `coding-agent/src/core/extensions/types.ts:1256-1260` and `durable/src/harness/scheduler.ts:2405-2419`; DeepSeek `core/tools/src/contracts.ts:349-361`, `core/tools/src/pipeline.ts:432-441` and `interaction/user-approval/src/index.ts:124-127`. The other peer citations come from two delegated traces and are labelled as such where it matters.

pi is two harnesses, not one. No file in `coding-agent/src` imports `pi-durable`, so I score "pi" separately for durable and for coding-agent.

## 1. Verdict

pi-durable has the lowest total change cost on these scenarios. It makes the policy a required field on the data: a document type must declare its `fork` (`durable/src/types.ts:53`), and a `beforeTool` rewrite is validated again and recorded in the execute checkpoint (`tool.ts:170-187`). Changing stop semantics is its weak spot. TeXRA is now close behind. Its compile-checked tables keep unknown unknowns low for tools and providers, and today's #14411 and #14412 cut the stop scenario from five decision sites to three. The run's final result, and stop's treatment of children, are still amplified in TeXRA, and two comments on the stop path are false. DeepSeek pays a wiring tax for every capability, and optional services quietly change behaviour by profile.

Grades:

| Project  | Grade | Why                                                                                                                                                                                         |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TeXRA    | B     | Scenarios 1, 3 and 4 are local or compiler-guided. Scenarios 2 and 6 still spread one decision over 4 or more owners.                                                                       |
| pi       | B     | Durable rates A- on state and rewrite but has a 2,528-line scheduler with cancellation re-derived in about six places. Coding-agent rates C: event and tool declarations are written twice. |
| DeepSeek | C     | About 9 wiring files per capability. `ask` turns into deny when there is no approval service. Stop and result semantics are reimplemented in each host.                                     |

## 2. Findings

### Scenario matrix (cost)

| #   | Change                                | TeXRA                     | pi-durable             | pi coding-agent | DeepSeek             |
| --- | ------------------------------------- | ------------------------- | ---------------------- | --------------- | -------------------- |
| 1   | New shell tool with approval          | 2                         | 4                      | 4               | 3                    |
| 2   | User stop detaches children           | 4 (was 5 before today)    | 4 (2 via `background`) | 1               | 4                    |
| 3   | New provider and credential           | 3                         | 3                      | 3               | 1 (pi-ai route) or 3 |
| 4   | Per-run state, fork carries it or not | 2 not carried, 4 carried  | 1                      | 2               | 3                    |
| 5   | Pre-tool hook that rewrites input     | 4 on main, 2 after #14413 | 2                      | 4               | 5                    |
| 6   | Result field a host shows             | 4                         | 2                      | 3-4             | 4                    |

### TeXRA

**S1: shell tool with approval (cost 2).**

- **Edit:** a new tool that declares `requiresApproval: true` and `guard: { bash: (input) => ... }`, as `harness/src/tools/bash.ts:528-536` does, and its registration in `harness/src/tools/builtinPlugins.ts:32-39`.
- **Approval prompt:** the loop builds the spelling (`loop/toolGuard.ts:84-86`). Every host already renders the `bash` request kind (`cli/src/chat/tui/modals/ApprovalModal.tsx:25`, `extension/src/progressView/frontend/components/BashRequestPanel.ts:24`), so no host edit is needed.
- **Read first:** `toolGuard.ts:39-110` and `tools/approval/bashApproval.ts:79-133`.
- **Easy to miss:**
  - The session grant is a name comparison: `SHELL_TOOL = 'bash'` (`toolGuard.ts:33,105`). A second shell tool gets `grant: 'call'`, so it is never offered "approve for session". This is special-general mixing.
  - The card's display kind is a separate table (`harness/src/shared/tools/toolKind.ts:25-35`), and the extension formatter special-cases `codex` by name (`extension/src/progressView/frontend/formatters/logFormatters/toolFormatters.ts:95`).
- **History:** #13363 (`205d499da9`) found four tools that declared `requiresApproval` but ran unasked, and tool grants that leaked into the shell bypass. That is a real unknown unknown, now closed by "`true` cannot leave a call unasked" (`toolGuard.ts:44-46`).

**S2: stop detaches children (cost 4).** The child policy is still decided in four mechanisms:

- the registry cascade, `RunRegistry.terminate` (`agent/runtime/runRegistry.ts:707-717`), versus `detachActiveChildren` (`:732-770`);
- the durable cascade for owned children on an ownerless end, `endOwnedChildren` (`agent/storage/runLifecycle.ts:294-317`);
- the in-band join's own interrupt: `awaitInBand` calls `runs.interrupt(childId)` when its caller is interrupted (`agent/runtime/delegation/inBandSubagentRun.ts:362-372`). It does not consult the stop's policy. Inferred, not reproduced: a detaching stop of a script- or one-shot parent still interrupts its awaited child (cause `released`) after `run.detach` commits;
- two readers of the setting, `SessionRequests.ts:358-362` and `ExecutionsTool.ts:467-471`, plus an explicit value at `cli/src/runtime/executeCli.ts:372-375` and the default at `stateSettings.ts:622-625`.

There is also cognitive load from false comments:

- `detachSubagentsOnStop.ts:24-27` and `runs.ts:103-107` say a bare Escape in the CLI always detaches. #13102 (`e45b2db238`) removed that. The CLI now leaves the policy unset (`chatSessionController.ts:395-398`).
- `detachSubagentsOnStop.ts:32-35` says the close "stops or settles" children. After #14411 the close settles nothing.

**What today's merges changed.** Before #14411, the cancelled end of an undriven run was written by three writers:

- the ownerless stop path;
- `stoppedUnadmitted` in `followUp/ToolUseFollowUp.ts`;
- `settleRun` in `controllers/session/sessionLayer.ts`.

#14411 made `stopEnd` (`runRegistry.ts:665-680`) the one decision. #14412 deleted the child loop's claim scope and `releaseClaim`, so a stop no longer has to reason about who releases the claim. Five sites became three.

**S3: provider and credential (cost 3).** The credential path is generic: the `apiKey.<id>` secret, then an environment variable (`llm/src/providers/apiProviders.ts:23-25,66-80`). A plain key provider needs no edit to `modelAccess/credentials.ts`. The provider id is restated in about 9 places:

- `llm/src/providers/providerPlugins.ts` (`MANIFEST`, and `BACKEND_PROTOCOLS` at `:182-195`);
- `harness/src/logger/redaction.ts:26-38`;
- the persisted enums `shared/schemas/prompts.ts:49-61` and `shared/schemas/runFacts.ts:128-140`;
- `texra/src/shared/settingsView/settingsViewMessages.ts:175-193`;
- `harness/src/shared/state/providerSettings.ts:32`;
- `texra/src/model/providerPresentation.ts:53`;
- `texra/src/model/setupModelDefaults.ts:9`;
- the external llm-zoo release.

Five of these are compiler-checked (the `AssertNever` guards and `satisfies Record<ApiKeyProviderId,...>`). Two are not: `providerSettings.ts`, and `setupModelDefaults.ts`, which is a `Record<string,string>`. This is high amplification with few unknowns. For comparison, the Meta provider (#8279) touched 14 production files, including a handler class.

**S4: per-run state (cost 2 if not carried, 4 if carried).**

- **Not carried:** declare a `PluginArm` (`tools/plugins.ts:71-90`, following `shared/schemas/plan.ts:18-35`), list it on the plugin (`builtinPlugins.ts:99`), and emit it as a fact of a tool result. The core fold stays generic (`shared/session/sessionViewUpdate.ts:849`).
- **Carried:** this is impossible without editing harness `agent/runtime/forkRun.ts`, because "the source's plugin facts stay with the source" (`:12`). The plan is lost on fork today.
- **Easy to miss:** trace import checks each fact against its arm (`transcript/traceDocumentSchema.ts:61-76`).

**S5: rewriting pre-tool hook (cost 4 on main).** `hook.outcome` v2 already stores `updatedInput` (`shared/schemas/hookOutcome.ts:55`), but the loop discards it:

- `common/plugins/hookProtocol.ts:267` lists it as ignored;
- `preToolUse` returns only deny and context (`loop/hooks.ts:386-458`);
- `claudeToolCall` has no reverse mapping (`common/plugins/hookConfig.ts:269-285`);
- the guard decodes the issued input (`toolGuard.ts:64`).

#14413 itself measures the amplification: +488/−494 across 22 production files, per its PR body.

**S6: result field a host shows (cost 4).** The edits are:

- `RunEndOutputSchema` (`shared/schemas/runRecords.ts:67-77`);
- its producers (`loop/toolUse.ts:521-530`, `scriptRun.ts`);
- the `run.end` version (`shared/schemas/rowVersions.ts:94`) and the golden fixture;
- the script envelope type, spelled as a string (`agent/runtime/delegation/AgentTool.ts:559`).

`RunView` takes only the outcome and error from `run.end` (`sessionViewUpdate.ts:777-784`), so the hosts that render the view do not see the new field. The NDJSON result passes it through untyped (`cli/src/schemas/cliOutput.ts:74`, `StructWithRest`) to an external consumer. History shows the risk: #9819 records that a renamed result field (#9518) silently emptied texra-action's review comments.

### pi (traced by subagent, key lines re-read)

- **Deep module (durable):** a document's `fork: "asOf"|"current"|"initial"` is required at declaration (`durable/src/types.ts:53`; README `:764`) and honoured in one place (`session/forks.ts:26-42`). This defines the "forgot the fork policy" error out of existence.
- **Defined errors (durable):** a `beforeTool` rewrite is validated again and recorded as `checkpoint.arguments` (`tool.ts:161-187`). The gap is that a model-issued call's live slot still shows the original arguments (`live.ts:54-55`, per the subagent).
- **Change amplification (durable):** cancellation cascade is re-derived across `scheduler.ts:588-604,668-683,783-799,1264-1276,1491-1496,1564`. `cancellationIntent` conflates a stop with a failed outcome (`:2411-2414`). There is no durable wait-for-person state, so in-hook approval asks again after a restart (inferred from `types.ts:664-675`).
- **Change amplification (coding-agent):**
  - `ToolName` unions and maps (`core/tools/index.ts:95-217`), and `agent_end` events defined twice (`agent-session.ts:197-205`, `extensions/types.ts:1039-1043`).
  - `tool_call` mutates `event.input` with "no re-validation" and no record (`extensions/types.ts:1256-1260`).

### DeepSeek (traced by subagent, key lines re-read)

- **Deep module:** projection folds plus copy-the-prefix fork carry state by default (`core/session/src/fork.ts:21-30`). A pi-ai provider is configuration only (`llm/llm-pi-ai/src/index.ts:12-40`).
- **Unknown unknowns:** `serviceAsk` turns `ask` into deny when no approval service is composed (`pipeline.ts:436-441`), which is the case in sdk-minimal. The approval request carries no arguments, so each host must join it to the earlier `tool/call` event (`user-approval/src/index.ts:124-127`).
- **Change amplification:**
  - A new tool touches its package (about 14 files with locales), the base patch (`bundle/base/cordis.patch.yml:281`), `package.json`, `tsconfig.base.json:576`, the Python runtime `package.json` and generated catalogs.
  - The final result is recomputed in the TypeScript SDK, the Python SDK, headless and ACP (`sdk/client/src/api.ts:253-258`, `bundle/headless/src/index.ts:83-110`).
- **Rewrite excluded by design:** `contracts.ts:349-356` freezes arguments before policy runs, so scenario 5 costs 5.

### TeXRA scenarios ranked by amplification

1. S2 stop: 4 mechanisms and 2 false comments.
2. S6 result: schema, producers, version, view, every host renderer and an untyped external pass-through.
3. S5 on main: 22 files; 2 after #14413.
4. S4 when carried.
5. S3: many edits, mostly compiler-guided.
6. S1.

The structural change that collapses S2 is to make the child disposition (cascade or detach) part of the stop decision `RunRegistry.stop` already owns:

- record it on the stopped activation beside `stop` (`markStopped`, `runRegistry.ts:695-700`);
- have `awaitInBand` and `endOwnedChildren` read that value instead of choosing for themselves;
- resolve the setting once, inside `stop`, rather than in its two callers.

After that, "change what a stop does to children" edits one function, which is PRD row 4's acceptance criterion.

### #14413 on S1 and S5

- **S5:** cost drops to 2. The rewrite is applied, validated again, and decided over the final input (`answerOf`, `rejection`). Reverse mappings become paired, compiler-required `Translation`s, which removes the forward-only trap at `hookConfig.ts:269-285`.
- **S1:** a tool no longer restates `requiresApproval: true` next to `guard.bash`, and the prompt shows the hooks' final input. But `SHELL_TOOL` survives: `definition.name === SHELL_TOOL && guard?.bash ? 'bash' : 'call'` (diff, `toolGuard.ts`). The card still opens with the issued input (`toolUseDispatch.ts:551`, unchanged by the diff), so after a rewrite the card and the prompt can disagree. This is inferred from the diff and not run.

## 3. What TeXRA should do

1. **One child disposition per stop.**
   - Red flags: change amplification and unknown unknowns (S2).
   - Change: in `runRegistry.ts` `stop`, resolve `detachSubagentsOnStop` and store the disposition on the activation. `inBandSubagentRun.ts:362-372` only stops awaiting a detached child. `runLifecycle.ts:294-317` takes the disposition. `SessionRequests.ts:358-362` and `ExecutionsTool.ts:467-471` pass the request through. Delete `detachSubagentsOnStop.ts`, whose 47 lines are mostly comment and include two false claims, and fix `runs.ts:103-107`.
   - Net: about −40 lines, estimated as 47 deleted, two 4-line call sites shrunk, and +15 in the registry and join.
   - Peers: pi-durable shows the cost of not doing this (six sites). DeepSeek has no owner at all.
   - Status: ALREADY QUEUED as PRD row 4 (`endOwnedChildren` cascade). The in-band join's own interrupt and the stale comments are NEW.

2. **Land #14413, then make the shell grant a declaration.**
   - Red flags: special-general mixing (S1) and change amplification (S5).
   - Change: replace the `SHELL_TOOL` name test with a guard field such as `guard.grant: 'shell'` on `bash.ts`, and open the slow-tool card with the final input.
   - Net: about ±0, from replacing a one-line comparison with a one-line field.
   - Peer: DeepSeek's `presentCall` belongs to the tool (`contracts.ts:93`).
   - Status: #14413 is ALREADY QUEUED as row 5. The grant field and the card input are NEW.

3. **Fold the run's output into `RunView`.**
   - Red flag: information leakage of the result shape into every host (S6).
   - Change: carry `output` in `sessionViewUpdate.ts:777-784` and `RunView`, so a new `RunEndOutputSchema` field reaches the TUI, desktop and extension through the fold they already render. Give `cli/src/schemas/cliOutput.ts:74` the typed `RunEnd`, so an external consumer's contract changes visibly.
   - Net: about +15 in the harness. Host-side result reads deleted afterwards are not counted; that they exist is inferred.
   - Peer: DeepSeek's per-host recomputation is the anti-pattern this avoids.
   - Status: NEW. It is adjacent to the PRD section "运行结束只有一个公开结构".

4. **A required fork policy on `PluginArm`.**
   - Red flag: unknown unknowns (S4).
   - Change: make `fork: 'cut' | 'none'` a required field (`tools/plugins.ts:71`), applied in `forkRun.ts`, so every new kind decides at declaration, as pi requires (`durable/src/types.ts:53`).
   - Net: +57, measured on the revision #14402 dropped.
   - Status: ALREADY QUEUED as row 3 (deferred patch).

5. **Type the two unchecked provider tables.**
   - Red flag: unknown unknowns (S3).
   - Change: `setupModelDefaults.ts:9` and the endpoint rows in `providerSettings.ts` `satisfies Record<ApiKeyProviderId, ...>`.
   - Net: about +2.
   - Status: NEW.

## 4. What TeXRA should refuse

- **DeepSeek's package per concern with profile YAML.** It adds about 9 wiring files per tool, and an optional service changes `ask` to deny with no type error. TeXRA's `builtinPlugins.ts` table, checked at compile time, is cheaper.
- **pi coding-agent's mutable `event.input`.** It is unvalidated and unrecorded, which recovery replay cannot reproduce.
- **pi-durable's in-hook approval.** There is no durable waiting state, so a restart asks again. Keep `request.opened`.
- **Carrying state on fork by default (DeepSeek).** It makes "not carried" the special case written in each fold (`init(header, inheritedEventCount)`). A required per-kind declaration is better.
- **pi-durable's scheduler-wide cancellation flags.** They re-derive one decision across a 2,528-line file. Fix S2 by giving one owner the disposition, not by adding a scheduler.

## 5. Corrections

- The #14402 squash message on main (`77164f3445`) still says `forkRun` and `forkSeed` take `forkedFacts` and that a fork keeps the plan at its cut. The PR body says this was taken out, and main has no `forkedFacts`; `forkRun.ts:12` is accurate. Anyone reading `git log` will be misled. PRD row 3 states the deferral correctly.
- `detachSubagentsOnStop.ts:24-27` and `runs.ts:103-107` describe a CLI Escape detach that #13102 removed. `detachSubagentsOnStop.ts:32-35` describes the close settling children, which #14411 removed.
- PRD row 4's list of remaining cascade work omits the in-band join's own child interrupt (`inBandSubagentRun.ts:362-372`). This is inferred.
- The prior review's line "pi: tool hooks may rewrite arguments before execution intent is recorded" holds for pi-durable only. pi coding-agent mutates input with no re-validation and no record (`extensions/types.ts:1256-1260`), so cite "pi-durable" there.
