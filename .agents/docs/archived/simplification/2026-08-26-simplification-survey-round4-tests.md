# Simplification survey, round 4A: the test budget

Status: implemented
Archived: 2026-09-06

**Date**: 2026-08-26 · **Net**: -2261 LoC · **Findings**: 25 actionable, 8 keep rulings, 12 refuted

## 0. Method

Rounds 1-3 all swept **production code** — by directory ([round 1](./2026-08-25-simplification-survey-49-candidates.md), 49 shipped), by cross-cutting pattern ([round 2](./2026-08-26-simplification-survey-round2.md), 40 shipped), and by subsystem architecture ([round 3](./2026-08-26-simplification-survey-round3.md), 26 actionable). None of them audited the test suite.

At the time of this survey `src/test-kernel/` was **241,619 LoC across 829 vitest files**, against 303,831 LoC of production TypeScript — tests are 44% of the repo's TypeScript. AGENTS.md is unusually strict about this: "Tests are a budget, not proof of work. Internal interfaces here break often by design, so every test pinned to a churning seam is merge friction, not safety."

Eight agents each took a slice of that budget, under an explicit maintainer mandate to cut deep.

Every finding names the **surviving suite, with a path,** that owns each behavior it stops pinning. A finding that could not name an owner for every dropped behavior was rejected before verification.

Four things stayed protected regardless of the mandate, because they are correctness rather than caution:

- the **only** coverage of a durable boundary (public API, wire format, persisted format, settings contract, CLI flag, approval or permission decision, security check)
- **regression pins** for shipped bugs whose code path still exists — deleting one re-opens the bug
- `src/test-kernel/architecture/` suites, which are guards rather than tests
- concurrency, cancellation, first-terminal-outcome and dispose-to-quiescence coverage

|                          | Count  |
| ------------------------ | ------ |
| Findings produced        | 45     |
| **Actionable, verified** | **25** |
| Keep rulings             | 8      |
| Refuted                  | 12     |

Every actionable finding went to an independent adversarial verifier. Surveyors and verifiers deduplicated against a 234-title index of everything rounds 1-3 shipped, refuted, or ruled worth keeping, plus six items that were **overturned at validation** during round 3 and are now policy-protected.

## 1. Findings

| Surface                     | Finding                                                                                                                                                                                                            | Kind        | Risk   | Net LoC   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ | --------- |
| `tests-rest`                | ProgressViewCommandHandlers suite: delete the mock-routing tests and the three Zod parse-table describes                                                                                                           | amend       | low    | -319      |
| `tests-desktop`             | Delete the desktop source-text-scraping design suites: DesktopControlSystem.vitest.ts (keep only the browser-view security assertions) and the literal-hex/tombstone pins in DesktopThemeTokens.vitest.ts          | delete      | low    | -287      |
| `tests-desktop`             | Finish the round-2 ruling: delete DesktopHostInteractions.vitest.ts, which re-tests the shared createProgressHostInteractions machine the extension suite already owns                                             | delete      | low    | -270      |
| `tests-desktop`             | Delete DesktopDevScript.vitest.ts (spawn-choreography of the dev launcher against its own mocks) and the string-scrape half of BuildAliasConfig.vitest.ts                                                          | delete      | medium | -218      |
| `tests-agent-handlers`      | No-output-file initializeOutputAndPrefill is pinned six times across three files for one two-line base-class branch                                                                                                | delete      | low    | -207      |
| `tests-progress-transcript` | ChatExportController has two suites; three of its exportAsHtml failure tests re-test assembleTrace decisions that traceAssembler.vitest.ts already owns                                                            | consolidate | low    | -160      |
| `tests-desktop`             | Delete the pure-delegation tests in DesktopSettingsIpc.vitest.ts that stub a controller and assert the stub received the same payload                                                                              | delete      | low    | -110      |
| `tests-desktop`             | DesktopUpdateChecker.vitest.ts re-tests the shared runDailyUpdateCheck machine — move the two genuinely unowned cases into SemverUpdateCheck.vitest.ts and delete the rest, completing round 1's identical CLI cut | consolidate | low    | -65       |
| `tests-progress-transcript` | StreamSnapshotStore: the partial-preload eager-overlay scenario is hand-copied per sidecar kind over one shared production path, and the usage-baseline merge is pinned five times                                 | consolidate | low    | -65       |
| `tests-tools`               | Retire the model-facing prompt-copy substring pins in DelegationHeadless and WorkflowScriptTool (keep schema-shape and plumbing assertions)                                                                        | amend       | low    | -64       |
| `tests-tools`               | NativeSubagentStrategy: drop the runTurn call-shape case — its assertions are re-made by the two-turn loop test and the production-path suite                                                                      | amend       | medium | -53       |
| `tests-agent-handlers`      | ModelHandlerXAI long-context threshold tests re-pin computeStandardPrice tier semantics that support/priceUtils.vitest.ts owns                                                                                     | delete      | low    | -42       |
| `test-support`              | Merge ToolUseWaitNodeFollowUpTranscriptLog.vitest.ts into ToolUseWaitNode.vitest.ts, its module's main suite                                                                                                       | consolidate | low    | -42       |
| `tests-agent-core`          | chatExportFormatter: fold the mixed tool_calls filtering test into normalizeConversation, whose suite already owns it                                                                                              | consolidate | low    | -41       |
| `tests-rest`                | One suite for InstructionPanel: merge InstructionPanelDesktopComposer.vitest.ts into InstructionPanelLauncher.vitest.ts                                                                                            | consolidate | low    | -40       |
| `tests-tools`               | ToolStatusFormatting: drop the two formatSubagentError cases — the exact-XML pin in SubagentResults and the classification suite already own both                                                                  | amend       | low    | -37       |
| `test-support`              | Hoist the only multi-copy byte-identical fixtures: projectTaskGroupsFromStreamLog (x3) and physicistCatalog (x2)                                                                                                   | consolidate | low    | -32       |
| `tests-progress-transcript` | Two suites over the one StreamTabs component, with duplicated fixture builders and drifted file names                                                                                                              | consolidate | low    | -30       |
| `tests-rest`                | One suite for mainViewActions: fold MainViewActions.vitest.ts into MainViewLaunchTarget.vitest.ts                                                                                                                  | consolidate | low    | -30       |
| `tests-cli`                 | chatSessionController re-pins the chatTuiCanStartRootRun truth table that TuiStateAndFocus already owns as an it.each                                                                                              | delete      | low    | -29       |
| `tests-progress-transcript` | ProgressBackendFactProjection: the narrow two-session active-stream scoping test is strictly subsumed by the wide isolation test in the same file                                                                  | delete      | low    | -29       |
| `tests-agent-core`          | AgentCreatorOrchestration: collapse the three per-prompt cancellation clones and the mock call-order pin                                                                                                           | consolidate | low    | -25       |
| `tests-cli`                 | Fold the 64-line TranscriptMarginCollapse file into ConversationTranscript, the suite that already owns transcriptEntryLayout                                                                                      | consolidate | low    | -22       |
| `tests-tools`               | latex/: one owner for the shared 'LaTeX file not found' guard instead of three per-tool copies                                                                                                                     | amend       | low    | -22       |
| `tests-rest`                | SettingsAgentCatalogController suite: drop the two root-preview tests that re-pin planTeamRun's selection, owned by TeamPlan.vitest.ts                                                                             | amend       | low    | -22       |
|                             | **Total**                                                                                                                                                                                                          |             |        | **-2261** |

## 2. Findings in detail

### tests-agent-core

#### chatExportFormatter: fold the mixed tool_calls filtering test into normalizeConversation, whose suite already owns it

- **Kind**: consolidate · **Risk**: low · **Net**: -41 LoC (proposer claimed -42; verifier figure governs)
- **Files**: `src/test-kernel/agent/export/chatExportFormatter.vitest.ts`, `src/test-kernel/agent/export/normalizeConversation.vitest.ts`

**Evidence**

formatChatAsMarkdown is a two-layer pipeline: normalizeMessages() then a renderer table (src/agent/export/chatExportFormatter.ts:5-9, renderDocument at :29-31). The formatter test 'preserves function tool calls in mixed tool_calls arrays' (chatExportFormatter.vitest.ts:46-91) asserts that a custom-type entry and a malformed function entry are filtered — normalization behavior. normalizeConversation.vitest.ts already pins 'handles assistant tool_calls array' (:556) and 'filters out non-function tool_calls (custom type)' (:576) through the same normalize path. The formatter test's only rendering assertion ('#### Tool: `first_tool`') is re-asserted by the surviving 'renders OpenAI Responses function call outputs with mixed parts' (:93-121, asserts '#### Tool: `fetch_notes`').

**Coverage handoff — which suite owns each dropped behavior**

custom-type tool_calls filtering → normalizeConversation.vitest.ts:576 'filters out non-function tool_calls (custom type)'. Tool-call markdown rendering ('#### Tool:' heading) → chatExportFormatter.vitest.ts:93 'renders OpenAI Responses function call outputs with mixed parts'. Malformed function entry (type:'function' with no .function payload) is the one case with no existing owner: add it as one ~5-line case to normalizeConversation.vitest.ts's 'handles assistant tool_calls array' describe, which becomes its named owner.

**Proposal**

Delete chatExportFormatter.vitest.ts:46-91 (47 lines) and add the malformed-entry case (~5 lines) to normalizeConversation.vitest.ts. The formatter suite keeps its unique value: the URL/Markdown/LaTeX escaping and web-fetch shape tests.

**What we give up**

If the malformed-entry filtering turns out to live in the renderer table rather than normalizeMessages (would show as the normalizeConversation case passing trivially), keep the formatter test and drop this finding.

**Verifier corrections — these override the evidence and proposal above**

1. The deleted block chatExportFormatter.vitest.ts:46-91 is 46 lines, not 47; honest net is ~-41, not -42. 2. The "what we give up" contingency is moot and can be dropped: I verified both filtering behaviors live in the normalize layer, not the renderer table — the custom-type entry is dropped by normalizeConversation.ts:524 (message.tool_calls.filter(isFunctionToolCall), where isFunctionToolCall in src/agent/modelHandlers/openai/functionToolCalls.ts requires type === 'function'), and the malformed {type:'function', no .function} entry passes that filter but is dropped by the fn?.name guard at normalizeConversation.ts:491. So the new normalizeConversation case will not pass trivially. 3. Minor framing: the malformed-entry drop is the fn?.name guard, distinct from the isFunctionToolCall filter — worth asserting both valid calls survive (2 tool-call nodes) in the added case so the guard, not just the filter, is pinned.

<details><summary>Verifier reasoning</summary>

Verified against HEAD: formatChatAsMarkdown (src/agent/export/chatExportFormatter.ts:29-31) delegates to renderDocument, which calls normalizeConversationForExport (src/agent/export/chatExport/formatSpec.ts:9,76) — the exact function normalizeConversation.vitest.ts tests directly (import at its line 14). The formatter test at :46-91 asserts custom-type and malformed tool_calls entries are filtered plus '#### Tool:' rendering; the custom-type filter is already pinned by normalizeConversation.vitest.ts:576 'filters out non-function tool_calls (custom type)' and the array path by :556 'handles assistant tool_calls array', while '#### Tool:' rendering of a tool-call ExportNode is retained by the surviving formatter test at :93 ('#### Tool: `fetch_notes`'). The only uncovered behavior is the malformed-entry fn?.name drop (normalizeConversation.ts:491), which the finding correctly hands to a new ~5-line normalizeConversation case. The deleted test inlines its own fixture, so no helper goes dead. This is a genuine same-layer dedup, aligned with the repo's tests-are-a-budget rule.

</details>

#### AgentCreatorOrchestration: collapse the three per-prompt cancellation clones and the mock call-order pin

- **Kind**: consolidate · **Risk**: low · **Net**: -25 LoC (proposer claimed -30; verifier figure governs)
- **Files**: `src/test-kernel/agent/AgentCreatorOrchestration.vitest.ts`

**Evidence**

runAgentCreator is 'one linear async function with a single production caller' (CLAUDE.md, src/agent/implementations/agentCreator/). The suite mocks every collaborator (helper-model kit, completion, YAML validation, AbsoluteFS.write, all six UI callbacks — 21 vi.fn/vi.mock in 306 lines) and three tests are structurally identical wizard early-exits: stub one prompt to undefined, assert no downstream mock was called (:153-164 name cancelled, :165-176 description cancelled, :177-189 tool selection cancelled). One equivalence class — 'a cancelled prompt aborts before any side effect' — parameterized three times. Separately, :93-118 pins the exact mock side-effect sequence expect(events).toEqual(['write','show','register','open']), a call-sequence pin on a linear function's internals. These are user-input early returns, not run/async cancellation arbitration, so the protected-cancellation carve-out does not apply.

**Coverage handoff — which suite owns each dropped behavior**

Wizard early-exit-without-side-effects → the retained :177-189 tool-selection case (same file), which asserts the widest set of downstream mocks stayed uncalled (getCustomAgentDir, createHelperModelKit, AbsoluteFS.write, promptAddToConfig). Write-before-register ordering → keep a single expect(events.indexOf('write')).toBeLessThan(events.indexOf('register')) in the happy-path test; the full four-step sequence stops being pinned as internal choreography. The real logic tests stay untouched: validation-error second attempt (:190), deterministic-template fallback (:215), TOOL_GROUPS-vs-doc parity (:289).

**Proposal**

Delete :153-176 (two of three cancellation clones, 24 lines) and reduce the events sequence assertion in :93-118 to the one ordering invariant that matters (~6 lines saved).

**What we give up**

If the write→show→register→open order is a recorded product decision (none found in docs/proposals or the file), keep the full sequence assertion and take only the cancellation collapse (-24).

**Verifier corrections — these override the evidence and proposal above**

1. "One equivalence class parameterized three times" overstates it: the three tests cover three DISTINCT early-return guards (agentCreatorFlow.ts:444 name, :450 description, :459 blueprint/pickTools), and the retained case runs category 'toolUse' while the two deleted ones run 'workflow' — so per-guard granularity is genuinely lost (e.g. the name-cancel test's unique promptDescription-not-called assertion has no equivalent in the retained test, which necessarily calls promptDescription). This is an acceptable trade under the AGENTS.md/CLAUDE.md test-budget doctrine (trivial one-line guards on a single-caller linear function), but the finding should state it as three isomorphic guards collapsed to one representative, not one class. 2) "~6 lines saved" from the events-sequence reduction is wrong: the toEqual pin is one line (:116) and its indexOf replacement is one line; the events plumbing (:94-98) must stay to record write/register. That edit is net ~0, so honest total is about -24 to -26, not -30. 3) The briefing's framing "round 3 open as #11452-#11460" is stale — those PRs are MERGED (verified #11455 MERGED); irrelevant here since none touched this file (last touch #10872). 4) Minor: "21 vi.fn/vi.mock" is ~20 by my count (17 vi.fn + 2 vi.mock + 1 vi.spyOn); not load-bearing.

<details><summary>Verifier reasoning</summary>

Verified against HEAD: all three cancellation tests (src/test-kernel/agent/AgentCreatorOrchestration.vitest.ts:153-189) and the four-step events pin (:116) exist unchanged; file last touched by #10872. Not in rounds123-index.md (251 titles) or any survey doc as a finding — only as a grep witness in an unrelated round-2 refutation. No dated ruling protects these tests; no cancellation carve-out exists in the review checklist or AGENTS.md, and these are wizard-prompt early returns, not run/async cancellation. The only intent marker (test title pinning side-effect order) is beaten by retaining the write-before-register invariant plus the stated fallback. Test-only change: no wire/persisted/settings/texra-action consumer, no ratchet. The coverage handoff is real — the retained :177-189 case asserts the widest no-side-effect set (getCustomAgentDir, createHelperModelKit, AbsoluteFS.write, promptAddToConfig), and the real logic tests (validation retry :190, template fallback :215, TOOL_GROUPS parity :289) are untouched. Fits the repo's explicit test-budget rule that redundant tests on churning internal seams are merge friction. Cost slightly optimistic (see corrections) but still clearly negative.

</details>

### tests-agent-handlers

#### No-output-file initializeOutputAndPrefill is pinned six times across three files for one two-line base-class branch

- **Kind**: delete · **Risk**: low · **Net**: -207 LoC (proposer claimed -203; verifier figure governs)
- **Files**: `src/test-kernel/agent/modelHandlers/EmptyPrefill.vitest.ts`, `src/test-kernel/agent/modelHandlers/ModelHandlerOpenAIResponse.vitest.ts`, `src/test-kernel/agent/modelHandlers/ModelHandlerAnthropic.vitest.ts`

**Evidence**

initializeOutputAndPrefill has exactly one implementation, on the base class (src/agent/modelHandlers/ModelHandler.ts:1520); grep over src/agent/modelHandlers finds no override. Its no-output-file branch is `if (!(await existsAndNonTrivial(outputLocation))) return [false, messages]` — no polymorphic call runs on that path, so every handler exercises byte-identical code. That branch is pinned by: EmptyPrefill.vitest.ts (whole file, 130 LoC, it.each over OpenAI chat / Google Interactions / OpenRouterNative), ModelHandlerOpenAIResponse.vitest.ts:1431-1470 ('preserves user content when no output file exists', 40 LoC), and ModelHandlerAnthropic.vitest.ts:2554-2619 (two tests, 66 LoC — the second, 'leaves messages untouched for models without assistant prefill', flips supportsAssistantPrefill, which the no-file branch never reads). History confirms these are pre-consolidation leftovers: .agents/docs/archived/simplification/2026-07-03-tech-debt-audit.md:52 records that prefill/continuation used to be re-implemented 5x per provider; the hoist into the base has since landed, making per-provider repeats retired parameterization. Dedupe: rounds123-index.md has no entry touching EmptyPrefill or initializeOutputAndPrefill; the only proposal-doc mention is the 2026-07-03 production-side note above.

**Coverage handoff — which suite owns each dropped behavior**

Behavior 'no output file (or trivial file) -> initializeOutputAndPrefill returns [false, messages] with messages and workspaceState untouched' remains pinned by the surviving test ModelHandlerAnthropic.vitest.ts:2555 'leaves messages untouched when no output file exists' (src/test-kernel/agent/modelHandlers/ModelHandlerAnthropic.vitest.ts), which drives the real base method through a real temp path. No other behavior is dropped: the per-provider message-type variance the deleted cases enumerated is compile-time (typecheck), and supportsAssistantPrefill is not consulted on this branch.

**Proposal**

Delete EmptyPrefill.vitest.ts entirely (130 LoC), delete the ModelHandlerOpenAIResponse.initializeOutputAndPrefill describe (1431-1470, 40 LoC), and delete the Anthropic 'models without assistant prefill' duplicate (2587-2619, 33 LoC), keeping ModelHandlerAnthropic.vitest.ts:2555 as the single owner of the shared branch.

**What we give up**

A per-provider smoke that each handler type-checks against the base signature (already guaranteed by npm run typecheck), and a second pin of a branch that cannot vary per handler.

**Verifier corrections — these override the evidence and proposal above**

1. Round 3 is no longer open: all of #11452-#11460 are MERGED as of verification (immaterial to duplication — none touch these files). 2. Deleting the ModelHandlerOpenAIResponse describe orphans four imports used nowhere else in that file (AgentWorkspaceState, AgentSettingSchema, AgentCategory, AgentConfig — each has exactly 2 occurrences: import + the deleted block), so those import lines must be removed too; net is slightly better than claimed (~-207, not -203). 3. Minor span nit: the Anthropic duplicate test starts at ~2586, not 2587. 4. The EmptyPrefill file is 130 lines exactly as claimed; the surviving test is the describe at ModelHandlerAnthropic.vitest.ts:2554-2585 ('leaves messages untouched when no output file exists'), whose assertions are a strict superset (it additionally asserts the output file was not created).

<details><summary>Verifier reasoning</summary>

The dropped behavior has a named, verified owner: ModelHandlerAnthropic.vitest.ts 'leaves messages untouched when no output file exists' drives the real base-class method through a real missing temp path and asserts isComplete=false, messages untouched, accumulatedOutput empty, and no file created — a superset of every deleted assertion. All six pins exercise byte-identical code: single implementation, no override, no polymorphic dispatch and no capability read on the no-file branch (verified by reading ModelHandler.ts:1520-1560). The per-provider variance the it.each enumerated is message-shape typing, which typecheck enforces; runtime behavior cannot differ. History supports retirement: the tests date from when prefill was re-implemented 5x per provider (#4131), and the hoist recorded in the 2026-07-03 audit has landed. Repo test doctrine (CLAUDE.md 'Tests are a budget') explicitly disfavors multiple pins of one internal seam. No regression-pin comment, no protecting ruling, no external consumer, not an architecture guard.

</details>

#### ModelHandlerXAI long-context threshold tests re-pin computeStandardPrice tier semantics that support/priceUtils.vitest.ts owns

- **Kind**: delete · **Risk**: low · **Net**: -42 LoC (proposer claimed -41; verifier figure governs)
- **Files**: `src/test-kernel/agent/modelHandlers/XaiLongContextPricing.vitest.ts`, `src/test-kernel/agent/modelHandlers/support/priceUtils.vitest.ts`

**Evidence**

The generic tier math lives in computeStandardPrice (src/agent/modelHandlers/support/priceUtils.ts:54) and is unit-pinned in support/priceUtils.vitest.ts: :20 'bills the flat rates when the prompt ends one token below the threshold', :37 'switches the complete pricing tuple once the prompt reaches the threshold', :66 'keeps flat rates for a config without a tier'. XaiLongContextPricing.vitest.ts:166-206 ('bills flat rates below the threshold and tier rates once reached', 'keeps flat rates for xAI models without a documented tier') re-runs exactly those three assertions through ModelHandlerXAI.normalizeUsage. The xAI-specific wiring — that the documented tier tuple and cache factor actually reach computeStandardPrice on the xAI path — remains pinned by the same file's ':238 follows the tier input rate for the rebate past the threshold' (asserts tier rates 4/12 past the 200k threshold on grok-4.6) and the cache-rebate it.each at :209, plus the catalog cross-check pins at :71-137 which stay untouched. Dedupe: no rounds 1-3 title and no survey-doc mention of XaiLongContextPricing or priceUtils.

**Coverage handoff — which suite owns each dropped behavior**

(1) 'flat rates below the threshold, full tier tuple at/after it' -> support/priceUtils.vitest.ts:20 and :37 (semantics) plus XaiLongContextPricing.vitest.ts:238 (xAI wiring: tier input/output rates applied past the threshold on the real catalog config). (2) 'model without a documented tier keeps flat rates at any prompt length' -> support/priceUtils.vitest.ts:66 (semantics) plus XaiLongContextPricing.vitest.ts:44/:64 which pin that undocumented ids get no tier/factor, and the tier-gap warning tests at :255 which pin the loud path for live unlisted models.

**Proposal**

Delete the 'ModelHandlerXAI long-context pricing' describe at XaiLongContextPricing.vitest.ts:166-206.

**What we give up**

One handler-level restatement of threshold arithmetic on accounting data; the accounting behavior itself keeps two named owners.

**Verifier corrections — these override the evidence and proposal above**

1. Omitted history the PR description must carry: the deleted 'bills flat rates below the threshold and tier rates once reached' test is a regression expression of PR #10477 (commit b9e4878537), which fixed a real off-by-one billing bug by making the tier switch inclusive. The deletion is safe only because the same commit pinned the identical boundary in priceUtils.vitest.ts:20/:37 at the fixed line itself; cite #10477 when deleting. 2. The finding under-claims the surviving handler-path coverage for 'flat below threshold': the cache-rebate it.each at XaiLongContextPricing.vitest.ts:209 bills 100k-prompt requests at flat catalog rates on all three tiered models, so the below-threshold branch keeps a handler-path owner too, not just the priceUtils unit pin. 3. Net LoC is -42, not -41: lines 166-206 are 41 lines and one adjoining blank line goes with the describe. 4. Minor: 'tier-gap warning tests at :255' is the describe line; the tests are at :256 and :282.

<details><summary>Verifier reasoning</summary>

Read all files rather than trusting the evidence text. Verified (a) priceUtils.vitest.ts pins the exact tier semantics the deleted tests restate, including the inclusive boundary; (b) the handler adds no threshold logic — standardPricingConfig only assembles the config from xaiLongContextTier/xaiCacheDiscountFactor lookups that keep their own pins at :26-68; (c) both sides of the boundary retain handler-path wiring owners (:209 flat below, :238 tier past); (d) the no-tier case is a direct-assignment composition of two surviving pins (:44-48 and priceUtils:66) plus the loud tier-gap path (:255-297). Chased the regression-pin risk through git history: #10477 and #10495 both touched this surface; #10477's fix is dual-pinned and the priceUtils copy — the one on the fixed line — survives; #10495's tripwire boundary is pinned by the surviving xaiLongContextTierGap describe. Dedupe against the rounds index and survey docs found no prior claim on this describe. Every dropped behavior has a named owner I opened and read, so the deletion is a genuine restatement removal on a low-churn accounting suite.

</details>

### tests-cli

#### chatSessionController re-pins the chatTuiCanStartRootRun truth table that TuiStateAndFocus already owns as an it.each

- **Kind**: delete · **Risk**: low · **Net**: -29 LoC (proposer claimed -28; verifier figure governs)
- **Files**: `src/test-kernel/cli/chatSessionController.vitest.ts`, `src/test-kernel/cli/TuiStateAndFocus.vitest.ts`

**Evidence**

chatSessionController.vitest.ts:521-548 is a standalone describe('chatTuiCanStartRootRun') with three cases: never-started -> true, completed -> true, pending -> false. TuiStateAndFocus.vitest.ts:~1280-1316 pins the same pure function through an it.each truth table ('allows a fresh root run $name') covering before-start, pending, and after-terminal-failure, plus the session-integrated assertions at 1335 and 1372. Both call the same export of packages/cli/src/chat/tui (chatTuiCanStartRootRun) with a plain {runCompleted, runPromise} record; no controller machinery is involved in the duplicate describe. The controller-level delegation test at chatSessionController.vitest.ts:634 ('canStartRootRun() delegates to chatTuiCanStartRootRun(session)') stays. Dedupe: no rounds123 or survey-doc entry.

**Coverage handoff — which suite owns each dropped behavior**

chatTuiCanStartRootRun truth table (never started / pending / completed) -> src/test-kernel/cli/TuiStateAndFocus.vitest.ts it.each at ~1280-1316 plus integrated assertions at 1335/1372. Controller wiring of that predicate -> chatSessionController.vitest.ts:634 (kept).

**Proposal**

Delete the describe block at chatSessionController.vitest.ts:521-548.

**What we give up**

None; the surviving table is strictly a superset of the deleted cases.

**Verifier corrections — these override the evidence and proposal above**

1. Fixture description inverted: the DELETED tests do not use "a plain {runCompleted, runPromise} record" — makeSession() (chatSessionController.vitest.ts:188) constructs a real TuiSession via markRunPending/markRunCompleted. It is the SURVIVING it.each that uses plain records. Verdict unaffected because TuiStateAndFocus also asserts through a real TuiSession at 1335/1372 and the kept delegation test covers the real-class sequence. 2) The it.each sits at TuiStateAndFocus.vitest.ts:1290-1316; ~1280 is the adjacent chatTuiCanInterruptActiveRun table. 3) The export lives in packages/cli/src/chat/tui/state/sessionRunState.ts, not "packages/cli/src/chat/tui". 4) Net LoC is -29, not -28: deleting lines 521-548 removes 28 lines, and the chatTuiCanStartRootRun specifier at import line 154 then becomes unused (line 634's test calls only ctrl.canStartRootRun()) and must be removed too.

<details><summary>Verifier reasoning</summary>

The deleted describe re-tests a three-branch pure predicate whose complete truth table survives as an it.each in TuiStateAndFocus.vitest.ts, with the real-session integration and controller-wiring variants each retaining a separately verified owner (TuiStateAndFocus 1335/1372; chatSessionController 634-644). No pinned regression, no dated ruling, no dedupe collision, no external consumer, and the deletion is a strict coverage superset removal in a suite governed by the repo's tests-are-a-budget rule.

</details>

#### Fold the 64-line TranscriptMarginCollapse file into ConversationTranscript, the suite that already owns transcriptEntryLayout

- **Kind**: consolidate · **Risk**: low · **Net**: -22 LoC (proposer claimed -20; verifier figure governs)
- **Files**: `src/test-kernel/cli/TranscriptMarginCollapse.vitest.ts`, `src/test-kernel/cli/ConversationTranscript.vitest.ts`

**Evidence**

TranscriptMarginCollapse.vitest.ts tests exactly one function, transcriptEntryLayout from @cli/chat/tui/panes/transcriptEntryLayout (5 tests on margin collapse). ConversationTranscript.vitest.ts already imports and tests the same module extensively ('derives insets, margins, prefixed lines, and row counts from one layout' at 571; margin-collapse-aware trimming at 1095). AGENTS.md Testing discipline: 'Extend the module's existing suite rather than adding a new test file... one suite per module'. Dedupe: no rounds123 or survey-doc entry for either file.

**Coverage handoff — which suite owns each dropped behavior**

All five margin-collapse cases move verbatim into a describe inside src/test-kernel/cli/ConversationTranscript.vitest.ts; nothing stops being pinned. Net saving is the duplicated header comment, imports, and local fixtures (~20 lines) plus one file.

**Proposal**

Move the describe('transcript entry margin collapse') block and its three tiny row builders into ConversationTranscript.vitest.ts (which already imports textRowFixture-compatible fixtures), delete the file.

**What we give up**

If ConversationTranscript.vitest.ts is judged too large to grow (2,141 LoC), keep the file split; the cost is one file, not wrong coverage.

**Verifier corrections — these override the evidence and proposal above**

Minor inaccuracies only. (a) The finding says "three tiny row builders" move; the file actually has four local helpers (user, assistant, phase, topRows), and two need not move at all — ConversationTranscript.vitest.ts already has entry() (line 121, textRowFixture-based) and phaseRow() (line 156) that cover user/assistant/phase rows, plus textRowFixture itself is already imported (line 82). Only topRows (~3 lines) plus the describe block and its header comment need to move. (b) The cited line for the layout test is 571; the actual assertions on marginTopRows/marginBottomRows span 571-598 — substance correct. (c) All imports the moved block needs (transcriptEntryLayout, TranscriptRow, textRowFixture) already exist in the destination, so the import saving is the full 5-line import block of the deleted file.

<details><summary>Verifier reasoning</summary>

Verified against HEAD: TranscriptMarginCollapse.vitest.ts (64 lines) tests only transcriptEntryLayout margin collapse; ConversationTranscript.vitest.ts (2141 lines) already imports the same module and tests the same behavior surface, including previousEntry-driven margin collapse in its trimming test at ~1095-1120. The repo's own testing discipline (AGENTS.md 189-190) mandates one suite per module and extending it rather than adding files. The split file exists only because bug fix #9776 added it as a new file. Folding moves all five tests verbatim (coverage handoff is real, nothing stops being pinned), reuses existing fixtures, and deletes one file. The only counterargument — the destination suite is already 2141 lines — is acknowledged by the finding itself and is a style preference, not a rule; the repo has no test-file size cap and the >400-500 LoC split heuristic applies to production modules, not centralized suites.

</details>

### tests-desktop

#### Delete the desktop source-text-scraping design suites: DesktopControlSystem.vitest.ts (keep only the browser-view security assertions) and the literal-hex/tombstone pins in DesktopThemeTokens.vitest.ts

- **Kind**: delete · **Risk**: low · **Net**: -287 LoC (proposer claimed -305; verifier figure governs)
- **Files**: `src/test-kernel/desktop/DesktopControlSystem.vitest.ts`, `src/test-kernel/desktop/DesktopThemeTokens.vitest.ts`

**Evidence**

DesktopControlSystem.vitest.ts (323 lines, 15 tests) contains not one behavioral assertion: every test is readFileSync over production source followed by toContain/not.toContain/toMatch of literal code strings — CSS class attributes ('task-sidebar-action btn-ghost' :97), template fragments ('startupTeamPanel.template()' :~145), exact code lines ('void editorPane.save()' :265), and regexes over Electron event-wiring source (:267-277, :283-321). It pins source text, not behavior: any rename/reformat breaks it with no behavior change, and behavior can break while every string survives. It is also loaded with retired-name tombstones ('openMacTerminalCommand' :226, 'EDITOR_DIRTY_STATE' :~316, 'workspaceRelaunchInProgress', 'allowNextPreventedUnload', 'editorHasUnsavedChanges') — the exact class round 3 deleted with maintainer sign-off in #11460 ('delete two retired-name tombstone suites', -101 LoC), whose verifier confirmed the doctrine. The 'asks about unsaved editor changes' test (:279) describes a shipped stale-mirror bug but cites no issue number and the mirror code path is GONE (the not.toContain tombstones prove it), so per the regression-pin rule it is deletable. Comment-defeat for the two rationale comments: the 'did-navigate-in-page is load-bearing' comment (:251) explains the PRODUCTION line; the test only asserts the line's text exists — deleting the test deletes no rationale (the production comment stays). DesktopThemeTokens.vitest.ts:106-124 asserts literal design hex values ('light-dark(#ffffff,#212121)', 'light-dark(#0d0d0d,#f4f4f4)') that two sibling tests in the same file (:55, :77) explicitly call 'a design choice and free to change'; :95-105 pins two retired token names (--texra-input-background, --vscode-textArea-background) — tombstones. Dedupe: round-2 survey doc :204/:226/:268 names DesktopControlSystem.vitest.ts only as a CONSTRAINT on the controlStyles selectorGroup candidate ('the const MUST be a literal string ... would break DesktopControlSystem.vitest.ts:46-49') — deleting this suite removes that constraint and helps that shipped item; no round proposed keeping these suites.

**Coverage handoff — which suite owns each dropped behavior**

Source-text pins drop with no behavioral owner needed — they never pinned behavior. The durable items are carved out or already owned elsewhere: (1) the embedded-browser URL/permission security policy (https/http/mailto allowlist, 'Blocked external browser URL', setPermissionRequestHandler/setPermissionCheckHandler over packages/desktop/src/main/desktopBrowserViews.ts) is the ONLY coverage of a security check → KEEP it, as DesktopControlSystem.vitest.ts trimmed to that single ~50-line test (or move those assertions into src/test-kernel/desktop/DesktopNavigationPolicy.vitest.ts, the suite that owns desktop navigation policy). (2) DesktopThemeTokens keeps unchanged: the two token-indirection tests (:55, :77 — form-control and terminal contrast contracts with stated failure modes), the reduced-motion damping test (:124, stated cross-file failure mode), the Lit control-sizing silent-degradation guard (:169, litStyles fallback rationale), and the --desktop-color-* confinement scan (:178, a mini-ratchet). Only the literal-hex test (:106) and the two tombstone assertions (:95-105) leave.

**Proposal**

Delete 14 of 15 tests in DesktopControlSystem.vitest.ts, keeping a trimmed browser-view security-policy test (~~55 lines survive of 323). In DesktopThemeTokens.vitest.ts delete 'uses neutral surfaces and achromatic primary actions' and the tombstone half of 'keeps light and dark palettes in one semantic token layer' (~~-40).

**What we give up**

The ability of a string-scrape to catch someone deleting a specific production line. That protection is illusory for behavior (a same-named reintroduction passes, a renamed regression passes) and its cost is real: every design tweak, rename, or reformat of seven renderer files pays merge friction here.

**Verifier corrections — these override the evidence and proposal above**

(1) The suite has 14 tests, not 15; the proposal is delete 13 of 14, keeping the trimmed security test. (2) netLoc is ~-287, not -305: the DesktopThemeTokens edit removes ~19-21 lines (the :106-122 test is 17 lines; the two tombstone assertions at :102-103 are 2 lines), not ~-40. (3) Minor line drift: 'void editorPane.save()' is at :263; the EDITOR_DIRTY_STATE loop is :318-320. (4) Stronger than claimed, cite in the PR: the no-mirror invariant already has a named BEHAVIORAL owner — src/test-kernel/desktop/DesktopWorkspaceIpc.vitest.ts:282 'accepts no editor dirty-state mirror from the renderer' (asserts the router rejects desktop:workspace:editorDirtyState, same bug story in its comment) — so the tombstone half of the unsaved-changes test is doubly covered. (5) The unsaved-changes test traces to #9507 (git log -S), so regression provenance exists even without an inline number; deletable because the mirror path is gone and the WorkspaceIpc test owns the invariant. (6) 'uses neutral surfaces and achromatic primary actions' is not only literal hexes: it also asserts not.toContain('radial-gradient(') and info !== accent — same design-choice class, but the PR should name dropping those two explicitly. (7) The relaunch/quit regexes being dropped from the trimmed test 13 keep a sibling pin at ElectronCompositionRoot.vitest.ts:162 and behavioral runShutdown coverage in src/test-kernel/platform/LifecycleHost.vitest.ts — name these as owners in the PR body.

<details><summary>Verifier reasoning</summary>

Default-refute pressure applied and the finding held. Every test in DesktopControlSystem.vitest.ts is a readFileSync source scrape (verified by reading all 323 lines); the one durable boundary in the file — the embedded-browser URL/permission security policy, confirmed by grep to have no other owner — is explicitly kept. The tombstone assertions match the class #11460 deleted with maintainer sign-off. Each behavior-adjacent dropped pin has a verified surviving owner: no-mirror invariant -> DesktopWorkspaceIpc.vitest.ts:282 (behavioral), disposeRendererResources -> same suite, relaunch/fatal-shutdown -> ElectronCompositionRoot.vitest.ts:162, runShutdown -> LifecycleHost.vitest.ts, external-URL allowlist -> DesktopNavigationPolicy.vitest.ts (behavioral). The did-navigate-in-page rationale is duplicated in production source so no rationale is lost. DesktopThemeTokens keeps all indirection contracts, the reduced-motion test, the litStyles sizing guard, and the confinement mini-ratchet; only literal hexes (which two kept sibling tests in the same file explicitly declare 'a design choice and free to change') and two retired-name tombstones leave. The only unowned loss is the source-regex pin on the discard-prompt wiring, which is not a listed durable boundary and whose protective value against behavioral regression is near zero; the repo's stated testing discipline (tests are a budget; design-seam pins are merge friction) supports accepting it.

</details>

#### Finish the round-2 ruling: delete DesktopHostInteractions.vitest.ts, which re-tests the shared createProgressHostInteractions machine the extension suite already owns

- **Kind**: delete · **Risk**: low · **Net**: -270 LoC (proposer claimed -290; verifier figure governs)
- **Files**: `src/test-kernel/desktop/DesktopHostInteractions.vitest.ts`, `src/test-kernel/progressView/ExtensionHostInteractions.vitest.ts`

**Evidence**

Round 2 shipped 'Inline the two-line createDesktopHostInteractions wrapper and delete its 405-line suite' (.agents/docs/archived/simplification/2026-08-26-simplification-survey-round2.md:3068-3091, with a verbatim per-test overlap map at :3081). PR #11441 (commit 5abad05f7f) executed only half: it inlined the wrapper in packages/desktop/src/main/desktopAgentExecution.ts and deleted desktopHostInteractions.ts, but REWROTE the suite around the shared factory instead of deleting it — the file now imports createProgressHostInteractions directly (src/test-kernel/desktop/DesktopHostInteractions.vitest.ts:11-14) and its describe is literally titled 'createProgressHostInteractions on the desktop host' (:132). Nothing desktop-specific is exercised: the fixture passes generic vi.fn stubs (:96-130) and uses the SAME createRecordingApprovalHandlers harness the extension suite imports (desktop :20 from '../progressView/approvalHandlerSetHarness'; extension :14). AGENTS.md Testing discipline explicitly bans this: 'delete tests ... instead of rewriting them around the new implementation'. Production callers of the shared factory: exactly 2 spreads (packages/desktop/src/main/desktopAgentExecution.ts:376, packages/extension/src/progressView/extensionHostInteractions.ts:21). Dedupe: rounds123-index round-2 shipped row covers the old file; this is completion of that shipped ruling, not a re-proposal; grep of both survey docs confirms no ruling to keep the rewritten suite.

**Coverage handoff — which suite owns each dropped behavior**

Per-test owners, all verified in the current tree: 'approves already-pending delegated work only in the selected stream' (desktop :133) → src/test-kernel/progressView/ExtensionHostInteractions.vitest.ts:188 (identical title/assertion sequence), with the one desktop-only assertion — the await-tool-edits gate (releaseToolEdits/approvalCompleted, desktop :152-175, absent from the extension suite per grep) — ported into that test (~15 lines). 'delegates tool edit approvals to the window controller' (:201) → ExtensionHostInteractions.vitest.ts:864. 'rejects a plan decision for a pending bash request' (:219) → ExtensionHostInteractions.vitest.ts:715 ('rejects a resolution whose kind does not match'). 'forwards a bash cancellation cause without user provenance' (:249) → ExtensionHostInteractions.vitest.ts:695 (identical title). 'routes tool-edit cancellation to the window controller' (:297) → ExtensionHostInteractions.vitest.ts:681. 'reveals the owning stream before showing an external inquiry' (:313) → ExtensionHostInteractions.vitest.ts:339 (#8246 focus registration) + :773 (inquiry show). 'can cancel synchronously while presenting a request' (:275), 'preserves typed proposal approval overrides' (:334), and 'cancels all pending requests on dispose with a stable cause' (:363) have no exact extension twin → port all three into ExtensionHostInteractions.vitest.ts (~85 lines total; dispose settlement is additionally pinned at the session-port layer by src/test-kernel/agent/runtime/SessionInteractions.vitest.ts:881, :893, :1049). Desktop-side WIRING of the factory (the thing a desktop file should pin) stays owned by src/test-kernel/desktop/DesktopAgentExecution.vitest.ts:1264-1378 ('installs host interactions on the desktop runtime host', 'resolves plan approvals through desktop host interactions', 'resolves agent proposals', 'surfaces a retry request').

**Proposal**

Port the await-tool-edits gate plus the three uncovered cases (sync-cancel-during-show, typed proposal overrides, dispose-with-stable-cause) into src/test-kernel/progressView/ExtensionHostInteractions.vitest.ts, then delete src/test-kernel/desktop/DesktopHostInteractions.vitest.ts (391 lines). -391 deleted, ~+100 ported.

**What we give up**

A second suite running the shared factory a second time with a second set of stubs. No desktop-specific code path loses coverage — the file contains none.

**Verifier corrections — these override the evidence and proposal above**

1. The handoff for 'reveals the owning stream before showing an external inquiry' (desktop :313) is WRONG. ExtensionHostInteractions.vitest.ts:773 asserts only externalInquiry show/dismiss — it never asserts requestEnsureProgressView or setActiveStream registration — and :339 pins revealStream for the retry path only. revealStream is one shared helper (progressHostInteractions.ts:99) but its call from openExternalInquiry (:439) would lose its only pin. PR #11441's carried verifier correction #1 listed this as the FIFTH uncovered behavior; the finding contradicts that correction and the code shows the correction was right. The port list must be five items, not four: fold the reveal assertions (~15 lines) into ext :773 or port desktop :313. 2) The ':219 → :715' mapping is incomplete: desktop :219 additionally asserts requestEnsureProgressView, no presentation-sink setActiveStream, and stream registration for a BASH request; ext :715 has none of these. Acceptable residue only because the shared revealStream helper is pinned at :257-289 (plan) and :339 (retry) — but the mapping as stated oversells. 3) The AGENTS.md citation is misapplied: the quoted rule (AGENTS.md:200-204) governs tests for RETIRED behavior, and createProgressHostInteractions is live code; the actual basis is the one-suite-per-module test budget plus the round-2 ruling, which still support the deletion. 4) netLoc overstated: with the fifth port item the add side is ~115-120 lines, so net is about -270, not -290. 5) Sequencing: open round-3 PR #11458 edits the inquiry test at ext :784-793 (drops the 'mode' field); land the port after or rebase over it.

<details><summary>Verifier reasoning</summary>

Verified against HEAD by reading both full suites, the shared factory, the round-2 survey ruling, PR #11441's merged body, AGENTS.md, the rounds123 index, and all nine round-3 PR file lists. The deletion finishes a verified shipped ruling that #11441 explicitly left open; the deleted file contains zero desktop-specific coverage (desktop wiring is owned by DesktopAgentExecution.vitest.ts:1264-1378, confirmed present). Eight of nine tests have verified owners or are in the port list; the ninth (reveal-before-external-inquiry) was misattributed and must join the port list — with that correction, every dropped behavior has a named, verified owner. Test-only change, validated centrally under vitest, so risk is low.

</details>

#### Delete DesktopDevScript.vitest.ts (spawn-choreography of the dev launcher against its own mocks) and the string-scrape half of BuildAliasConfig.vitest.ts

- **Kind**: delete · **Risk**: medium · **Net**: -218 LoC (proposer claimed -225; verifier figure governs)
- **Files**: `src/test-kernel/desktop/DesktopDevScript.vitest.ts`, `src/test-kernel/desktop/BuildAliasConfig.vitest.ts`

**Evidence**

DesktopDevScript.vitest.ts (207 lines, 1 test) mocks spawn entirely with FakeChild EventEmitters (:25-33, :77-90) and asserts the mock's own call ordering — port allocation, Vite spawn, Electron spawn, replacement-args message — for the desktop DEV launcher. No production logic beyond argument marshalling to the mocked spawn is exercised; this is the asserts-its-own-mock pattern applied to a developer convenience script whose failure is self-announcing (every `npm run dev` run of the desktop app exercises it end-to-end, for real). It pins a churning internal seam (the launcher's spawn sequence) at 207 lines of listener-restoration bookkeeping (:35-69). BuildAliasConfig.vitest.ts's second test (:48-65) is source-text scraping with retired-name tombstones (not.toContain('aliasPlugin'), not.toContain('.mjs import works at runtime via Vite')) over extension build configs — same class as the #11460 tombstone deletion. Its FIRST test (:25-46) is different: it computes the desktop alias table from the root tsconfig and asserts structural equality — a real drift guard for a config the typechecker does not cross-check (CLAUDE.md: 'builds do NOT type check') — and stays. Dedupe: neither file appears in any round-1/2/3 title or survey doc (grep confirmed); the round-2 scripts/ sweep touched scripts/ residues, not these suites.

**Coverage handoff — which suite owns each dropped behavior**

Dev-launcher choreography: no suite owns it afterward, deliberately — it is not a durable boundary (not a wire format, flag, persisted file, or user contract), and AGENTS.md's budget rule says a test must protect 'a consequential current contract, a difficult invariant, or a reproduced defect'; a dev script's spawn order is none of these and is exercised for real on every dev launch. Build-config tombstones: no owner needed (retired names; the code paths are gone). The alias-table root-vs-desktop equality drift guard SURVIVES as BuildAliasConfig.vitest.ts test 1 (:25-46), unchanged — it remains the named owner of 'desktop bundling resolves the root alias map'.

**Proposal**

Delete src/test-kernel/desktop/DesktopDevScript.vitest.ts (-207) and the 'uses generated TypeScript paths for extension bundling' test from BuildAliasConfig.vitest.ts (~-18), keeping the alias-table equality test.

**What we give up**

A CI signal for a broken dev launcher, traded for the immediate signal every developer gets on the next `npm run dev`. Under the maintainer mandate this balanced case cuts.

**Verifier corrections — these override the evidence and proposal above**

1. MANDATORY: BuildAliasConfig.vitest.ts test 2 is mischaracterized as 'source-text scraping with retired-name tombstones'. Only four of its six assertions are tombstones/negative pins (:55-57, :60-63 — verified dead: packages/extension/esbuild.config.mjs contains no aliasPlugin and no aliases.mjs import). The other two are positive pins of the LIVE extension alias mechanism: :54 pins that extension vite.config.ts imports '../../scripts/aliases.mjs' (matches packages/extension/vite.config.ts:5) and :59 pins esbuild's tsconfig-based aliasing (matches esbuild.config.mjs:46). BuildAliasConfig is the only suite in the repo that touches the extension build configs (the AliasMapGeneration suite named in the 2026-08-04 audit no longer exists), so deleting test 2 wholesale drops these with no owner. Fold the two positive assertions into test 1 and delete only the tombstones. 2. 'Asserts the mock's own call ordering' is inaccurate: the test imports and executes the real packages/desktop/scripts/dev.mjs (:148-150) and asserts what production code passed to the mocked spawn — the ordering asserted is dev.mjs's actual control flow, not mock echo. The deletion stands on the budget rule (dev-only surface), not on the mock-echo charge. 3. 'Every npm run dev exercises it end-to-end' holds only for the launch half. The replacement-args relaunch (:192-205) is exercised only when a developer reopens a workspace in dev mode, and it is one side of a live cross-process contract whose production side still exists with an explanatory comment at packages/desktop/src/main/index.ts:1180-1187 ('The development supervisor owns Vite and the Electron child...'). The proposal must name that contract as deliberately given up; DesktopControlSystem.vitest.ts:310 is only a tombstone, not an owner. 4. The finding omits that this test was deliberately repaired for hermeticity in the 2026-07-29 open-source-readiness pass; that investment is being discarded and should be acknowledged in the PR description. 5. Net LoC: -225 assumed deleting all of test 2; keeping the two positive assertions (folded into test 1, ~+4 lines) gives about -218.

<details><summary>Verifier reasoning</summary>

Read both files in full. DesktopDevScript.vitest.ts (207 lines, 1 test) tests packages/desktop/scripts/dev.mjs (187 lines, still present, no regression-pin issue/PR comments — only local 'stopping' flags). It is a real hermetic test of the dev launcher, but the surface is a developer convenience script: not a public API, wire format, persisted format, settings contract, CLI flag, approval decision, or security check — none of the durable-boundary categories. The repo's own testing doctrine (AGENTS.md:173-179, quoted correctly by the finding) sets the bar at 'consequential current contract, difficult invariant, or reproduced defect'; a dev launcher's spawn choreography meets none, and its maintenance cost is real (signal-listener restoration, env juggling, cache-busted module import). The one behavior with teeth — the supervised workspace-relaunch IPC contract with production main/index.ts — is dev-mode-only (packaged builds take the app.relaunch branch) and self-announcing to the developer who hits it; giving it up is a defensible budget call once named explicitly. For BuildAliasConfig, I verified against the live configs which assertions are tombstones (deletable, #11460 class) and which pin current mechanisms with no other owner (must survive). Dedupe verified against the scratchpad index, both survey doc trees, git history of both files, and open PRs (only #11326 open; rounds 1-3 merged without touching these). Helper orphaning checked: moduleFileUrl and createModuleMocks retain 5+ and 10+ other users respectively, so the deletion is clean.

</details>

#### Delete the pure-delegation tests in DesktopSettingsIpc.vitest.ts that stub a controller and assert the stub received the same payload

- **Kind**: delete · **Risk**: low · **Net**: -110 LoC
- **Files**: `src/test-kernel/desktop/DesktopSettingsIpc.vitest.ts`

**Evidence**

Three cases exercise nothing but the handleMessage routing dictionary with every handler replaced by vi.fn: 'delegates agent-selection commands to the required controller' (:301-328 — stubs setAgentEnabled, sends SET_AGENT_ENABLED, asserts the stub got the identical payload), 'delegates profile and ChatGPT commands to the credential controller' (:660-718 — four stubs, four identity assertions, read in full), and the toggleTool/runInstallCommand halves of 'delegates Tools and LaTeX commands' (:594-658 — the LATEX_FORMATTER third of that test does a real workspace-state round trip and stays). Each configures a mock and asserts the mock was called as configured; the only production code on the path is a command→handler lookup. The same dispatch mechanism is already exercised with REAL handlers by sibling tests in the same suite. Dedupe: DesktopSettingsIpc appears in no round-1/2/3 title; the round-2 'twelve stale vi.mock factory keys' item was different files.

**Coverage handoff — which suite owns each dropped behavior**

The dispatch mechanism (handleMessage recognizes a command, returns true, routes to the owning controller) remains pinned in the SAME suite by tests that route through real handlers and assert observable effects: DesktopSettingsIpc.vitest.ts:330 (Git author round trip through workspace state), :719 (model settings persisted through global state), :846 (bash-approval toggle written to workspace scope), :427 (goal list served), :925 (agent-skills toggle), plus the negative gate at :1009 ('ignores unsupported or malformed settings messages'). The delegated handlers' behavior is owned by their own suites: src/test-kernel/desktop/DesktopAgentSettingsController.vitest.ts (setAgentEnabled family, :185-516), src/test-kernel/desktop/DesktopCredentialSettingsController.vitest.ts (signIn/signOut/setProviderKey/ChatGPT preference), src/test-kernel/desktop/DesktopToolingSettingsController.vitest.ts (toggleTool/runInstallCommand). What stops being pinned: only the specific routing rows SET_AGENT_ENABLED, SIGN_IN, SIGN_OUT, SET_PROVIDER_KEY, SET_CHATGPT_PREFER_SUBSCRIPTION, TOGGLE_TOOL, RUN_INSTALL_COMMAND — a misroute breaks the settings screen on first click and the surviving real-handler tests pin the mechanism itself.

**Proposal**

Delete the two pure-delegation tests and trim the delegation half of the Tools/LaTeX test (~-110 of 1,022).

**What we give up**

Per-command routing-row pins whose handlers are mocks. The routing mechanism and every handler's behavior keep named owners.

**Verifier corrections — these override the evidence and proposal above**

(1) 'The only production code on the path is a command→handler lookup' is slightly understated: the path also runs SettingsViewInboundMessageSchema.safeParse (desktopSettingsIpc.ts:472) before dispatch, and the deleted tests are the only ones that run these seven specific commands through that runtime parse — the surviving pins are frontend-side postMessage assertions (AgentSelectionPanelToggle.vitest.ts:96) and direct handler calls that bypass the schema. Mitigated because handler param types and frontend payloads both derive from the shared schema types, so shape drift is type-caught; the residual runtime-only gap is a schema .refine/runtime-only rejection, which none of these messages use. (2) The routing rows are not a hand-maintained dictionary per command: SET_AGENT_ENABLED, SIGN_IN/SIGN_OUT/SET_PROVIDER_KEY, SET_CHATGPT_PREFER_SUBSCRIPTION, TOGGLE_TOOL, RUN_INSTALL_COMMAND arrive via spreads of the controllers' own handler dictionaries (desktopSettingsIpc.ts:418, 424, 437-438, 445-446) into an exhaustive registry type, so 'a misroute breaks on first click' is the worst case; a wholly missing row is a type error. This makes the deletion safer than the finding argues, not less. (3) The Tools/LaTeX trim is a rewrite, not a pure deletion: the surviving LATEX_FORMATTER half still needs the stub tooling controller for its postLatexConfigValues assertions, so the fixture setup shrinks but does not disappear (~25-30 lines removable from that test, not the full delegation half's ~40). (4) The claimed handoff range 'DesktopAgentSettingsController.vitest.ts :185-516' is loose; the setAgentEnabled exercise starts at :224. Immaterial.

<details><summary>Verifier reasoning</summary>

These are textbook configure-a-mock-assert-the-mock tests: every behavioral assertion is against a vi.fn the test itself installed, and the only unmocked production code is safeParse plus an exhaustive typed registry dispatch — a mechanism the same suite pins six more times through real handlers with observable effects (workspace/global state writes, posted renderer messages) and once negatively (:1009). Every delegated handler's real behavior has a verified named owner suite. The repo's explicit testing discipline says internal-seam pins like these are merge friction, not safety; the routing seam is internal (desktop IPC to its own controllers), while the durable boundary — the shared settings-view message schema — keeps its type-level enforcement and its real-handler runtime coverage. No pin comment, no dated KEEP, no duplicate, honest cost. What is genuinely lost (per-command spread-wiring pins for seven commands) fails loudly in the settings UI on first click and partially fails at compile time, which is an acceptable trade under this repo's stated test budget.

</details>

#### DesktopUpdateChecker.vitest.ts re-tests the shared runDailyUpdateCheck machine — move the two genuinely unowned cases into SemverUpdateCheck.vitest.ts and delete the rest, completing round 1's identical CLI cut

- **Kind**: consolidate · **Risk**: low · **Net**: -65 LoC (proposer claimed -75; verifier figure governs)
- **Files**: `src/test-kernel/desktop/DesktopUpdateChecker.vitest.ts`, `src/test-kernel/utils/system/SemverUpdateCheck.vitest.ts`

**Evidence**

packages/desktop/src/main/desktopUpdateChecker.ts:113 calls the shared runDailyUpdateCheck (src/utils/system/updateCheck.ts) directly with no wrapper. Round 1 already shipped the same cut for the CLI: 'Delete checkCliUpdateAvailable, a single-caller wrapper whose 214-line suite retests the shared state machine' (.agents/docs/archived/simplification/2026-08-25-simplification-survey-49-candidates.md:99, which itself notes desktop 'calls runDailyUpdateCheck directly'); src/test-kernel/cli/UpdateChecker.vitest.ts no longer contains any throttle/not-newer/no-stamp case (verified by outline). Of DesktopUpdateChecker.vitest.ts's 12 cases, seven re-test shared-machine behavior: newer-release-notify+persist (:87), not-newer (:100), same-day throttle (:108), no-re-notify (:129), no-stamp-on-failed-fetch (:143), empty-tag-is-failure (:162), no-stamp-when-notify-fails (:177). Shared owners already exist for five of them (SemverUpdateCheck.vitest.ts:55 notify-before-stamp, :73 no-repeat + stamps-live-refresh, :91 refreshed:false-no-stamp, :136 fetchJsonStringField rejects empty, isNewerSemverVersion :11-25 comparison). Two are currently pinned ONLY by the desktop suite — the same-day throttle skip and not-newer-no-notify wiring — because round 1's CLI deletion moved nothing to the shared suite; they must be ported, not dropped. Dedupe: no survey doc proposes keeping this suite; grep for DesktopUpdateChecker across docs/proposals returns only the round-1 contextual mention.

**Coverage handoff — which suite owns each dropped behavior**

newer-release-notifies-once-and-persists-version → SemverUpdateCheck.vitest.ts:55 + :73. no-re-notify-for-notified-version → SemverUpdateCheck.vitest.ts:73. no-throttle-stamp-on-failed-fetch → SemverUpdateCheck.vitest.ts:91. empty-release-tag-is-failure → SemverUpdateCheck.vitest.ts:136 (fetchJsonStringField, the exact production path desktop uses at desktopUpdateChecker.ts:44). no-stamp-when-notification-fails → the notify-before-stamp ordering pin at SemverUpdateCheck.vitest.ts:55 (stamp provably not written until notify returns). same-day-throttle-skip and not-newer-no-notify → PORTED as two new runDailyUpdateCheck cases in SemverUpdateCheck.vitest.ts (~30 lines) — these currently have no shared owner and may not be dropped. Desktop-specific cases stay in DesktopUpdateChecker.vitest.ts: known-constant releases URL, never API-provided (:20 — security), isPackaged skip (:69), TEXRA_NO_UPDATE_CHECK skip (:79), and concurrent-check coalescing (:195 — concurrency, protected class, pins the module-level in-flight latch at desktopUpdateChecker.ts:70-101).

**Proposal**

Add same-day-throttle and not-newer cases to SemverUpdateCheck.vitest.ts (+~~30), delete the seven shared-machine re-tests from DesktopUpdateChecker.vitest.ts (~~-105), keep the four desktop-only cases.

**What we give up**

Redundant execution of the shared throttle machine through a second host's fixture. The shared suite becomes the single owner of runDailyUpdateCheck semantics, which is where round 1 left an unacknowledged gap.

**Verifier corrections — these override the evidence and proposal above**

1. The desktop suite has 11 cases, not 12 (7 shared-machine + 4 desktop-only; count of it() blocks is 11). 2. 'Round 1's CLI deletion moved nothing to the shared suite' is FALSE: round 1's verified proposal migrated the stampFailure-ignore-still-returns-latest case, now live at SemverUpdateCheck.vitest.ts:106-121. What round 1 did NOT move are throttle, not-newer, and notify-throws — and its verification section explicitly left those 'pinned instead by the desktop suite: DesktopUpdateChecker.vitest.ts:108/:143/:177', so this finding is knowingly removing pins round 1 relied on and must port accordingly. 3. The handoff for no-stamp-when-notification-fails to the :55 ordering pin is too weak: a future try/catch around notify() in runDailyUpdateCheck would keep :55 green while regressing the behavior (exactly the silent-degradation class §15 warns about). Port a notify-throws case too — three ports, not two (+~15 LoC). 4. no-stamp-on-failed-fetch handoff via :91 is transitive, not direct: :91 pins the refreshed:false gate with a DEFINED version, while a failed desktop fetch yields {version: undefined, refreshed: false}; coverage holds only because the refreshed gate alone blocks the stamp — the undefined-version early return (updateCheck.ts 'if (version === undefined) return undefined') remains unpinned anywhere. Acceptable, but say so in the PR. 5. Deleting :87 and :129 removes the only pins that desktop actually passes GlobalStateKey.DESKTOP_UPDATE_CHECK_LAST_NOTIFIED_VERSION (once-per-release wiring through checkForDesktopUpdate); if desktop dropped lastNotifiedVersionKey, no test would fail and users would be re-notified daily. Keep :87 as one end-to-end wiring smoke case (12 lines) or accept that loss explicitly. 6. Net LoC with the extra port and the retained smoke case is ~-60 to -70, not -75.

<details><summary>Verifier reasoning</summary>

Verified against HEAD: desktopUpdateChecker.ts calls runDailyUpdateCheck directly (no wrapper), and the seven cited desktop cases exercise machine semantics owned by src/utils/system/updateCheck.ts, which has its own suite. The CLI precedent is real and merged (UpdateChecker.vitest.ts retains 15 host-wiring tests, zero machine tests). The finding correctly identifies the two genuinely unowned behaviors (same-day throttle window, not-newer-no-notify) and correctly refuses to drop them. The four kept desktop tests are exactly the ones the source comments defend (security URL, isPackaged, TEXRA_NO_UPDATE_CHECK, in-flight coalescing latch). The proposal matches the repo's test-budget doctrine and completes a gap round 1's own verifier documented. Corrections tighten the handoff (port three cases, not two; keep one wiring smoke test) without changing the verdict.

</details>

### tests-progress-transcript

#### ChatExportController has two suites; three of its exportAsHtml failure tests re-test assembleTrace decisions that traceAssembler.vitest.ts already owns

- **Kind**: consolidate · **Risk**: low · **Net**: -160 LoC (proposer claimed -80; verifier figure governs)
- **Files**: `src/test-kernel/progressView/ChatExportController.vitest.ts`, `src/test-kernel/progressView/ChatExportControllerHtml.vitest.ts`, `src/test-kernel/transcript/traceAssembler.vitest.ts`

**Evidence**

One module, two suites (122 + 214 LoC), violating AGENTS.md 'one suite per module, path-mirrored'. Production: src/controllers/progressView/ChatExportController.ts:157-161 passes historyId straight to assembleTrace and its own comment at :62 says the failure statuses are "assembleTrace's failure statuses, re-surfaced for the HTML export path". The wrapper adds no routing before assembleTrace. Duplicated tests, each with a same-property twin in src/test-kernel/transcript/traceAssembler.vitest.ts: ChatExportControllerHtml.vitest.ts:126 ('streamLogs_missing when metadata carries no stamped stream id') = traceAssembler.vitest.ts:152; :134 ('never resolves a transcript from sidecar candidates without a stamped stream id') = traceAssembler.vitest.ts:171; :150 ('streamLogs_missing when only delegated child sidecars remain') = the same no-stamp/no-sidecar-adoption property, with the tool-format child-id half owned by traceAssembler.vitest.ts:192. Dedupe: rounds 1-3 index has no ChatExport entry; grep of both survey docs for 'ChatExport' hits only an unrelated CLI packaging item.

**Coverage handoff — which suite owns each dropped behavior**

Dropped: (1) 'streamLogs_missing when metadata has no stamped stream id' -> src/test-kernel/transcript/traceAssembler.vitest.ts:152; (2) 'never resolves from sidecar candidates without a stamp' -> traceAssembler.vitest.ts:171; (3) 'only delegated child sidecars remain' -> traceAssembler.vitest.ts:171 plus :192 (tool-format child ids resolve only through stamped metadata). Retained in the merged suite: the config_missing test (ChatExportControllerHtml.vitest.ts:118) as the one pin that assembleTrace failure statuses propagate through exportAsHtml, the end-to-end 'writes a self-contained HTML file' test (:170), the missing-template throw (:201), and all four buildExportInput status tests from ChatExportController.vitest.ts. injectStandaloneTrace behavior stays owned by src/test-kernel/transcript/standaloneTraceHtml.vitest.ts.

**Proposal**

Merge the two files into one src/test-kernel/progressView/ChatExportController.vitest.ts (drop one preamble, one duplicated AgentConfig fixture, one describe scaffold). In the merged file delete the three tests listed above and the expectStreamLogsMissing helper (ChatExportControllerHtml.vitest.ts:106-114), keeping the config_missing test as the single status-propagation pin. About 52 LoC of duplicated tests plus ~30 LoC of merged scaffolding leave; one file disappears.

**What we give up**

Redundant end-to-end confirmation that three specific assembleTrace failure modes surface unchanged through the export wrapper; the retained config_missing test still pins the propagation mechanism itself.

**Verifier corrections — these override the evidence and proposal above**

(1) MECHANICS WRONG — the proposed literal merge of the two files is infeasible. ChatExportController.vitest.ts vi.mock()s '@agent/storage' and '@transcript' (hoisted, file-scoped); ChatExportControllerHtml.vitest.ts requires the REAL implementations of both (real getExecutionStore, StreamLogStore, StreamSnapshotStore, assembleTrace). Concatenating the suites breaks every Html test. The two-file split is structurally forced by vitest mock scoping, not sloppiness. (2) MISSED THE BIGGER DUPLICATION that makes the fix work anyway: ChatExportController.vitest.ts is a near-verbatim copy of src/test-kernel/agent/export/loadChatExportInput.vitest.ts — identical hoisted mocks, identical AgentConfig fixture, same four scenarios including the empty-array-conversation pin. buildExportInput's doc comment calls it a "thin wrapper around the shared loadChatExportInput loader"; its only added logic is null-to-status mapping, i.e. trivial plumbing AGENTS.md says not to test. Correct plan: delete ChatExportController.vitest.ts entirely (122 LoC), delete the three duplicated exportAsHtml failure tests plus the expectStreamLogsMissing helper from the Html file (~52 LoC), rename ChatExportControllerHtml.vitest.ts to ChatExportController.vitest.ts (one suite per module restored), optionally add one real-storage conversation_missing test (~10 LoC) so both failure statuses of buildExportInput stay pinned through the wrapper — config_missing propagation is already pinned at what is now the surviving suite's first test. (3) The claimed "duplicated AgentConfig fixture" between the two ChatExport files is not comparable duplication (partial cast vs full factory with different fields); the verbatim fixture twin is in loadChatExportInput.vitest.ts. (4) Minor: survey-doc grep returns zero ChatExport hits, not "one unrelated CLI packaging item". (5) Line numbers off by one in places (traceAssembler twins sit at ~151/~170, finding says 152/171) — immaterial.

<details><summary>Verifier reasoning</summary>

Every load-bearing factual claim verified against HEAD: two suites for one module (122+214 LoC) violating AGENTS.md:190-191; exportAsHtml passes historyId straight to assembleTrace and re-surfaces its status with zero added routing; each of the three targeted tests has a same-property twin in traceAssembler.vitest.ts, which owns stream resolution (assembleTrace delegates to resolveStreamForExecution; the :170 test proves sidecar candidates are never consulted without a stamped meta.streamId, subsuming the delegated-child variant). The finding survives because its dedup claim is true and undefended by any comment, ruling, or consumer — but its proposal needed repair: the vi.mock file-scoping conflict makes the literal two-file merge impossible, and the correct route (discovered during verification) is deleting the mock-based buildExportInput suite as a near-verbatim duplicate of loadChatExportInput.vitest.ts, then renaming the integration file. Coverage handoff is sound: every dropped property has a named surviving owner (traceAssembler.vitest.ts for the three failure modes, loadChatExportInput.vitest.ts for all four loader scenarios, the retained config_missing test for wrapper propagation, standaloneTraceHtml.vitest.ts for injection).

</details>

#### StreamSnapshotStore: the partial-preload eager-overlay scenario is hand-copied per sidecar kind over one shared production path, and the usage-baseline merge is pinned five times

- **Kind**: consolidate · **Risk**: low · **Net**: -65 LoC (proposer claimed -70; verifier figure governs)
- **Files**: `src/test-kernel/transcript/StreamSnapshotStore.vitest.ts`

**Evidence**

Production shares one mechanism: src/transcript/StreamSnapshotStore.ts:204-209 mergeRoundPatch is documented 'Shared by every round-keyed accumulator overlay (output files, missing outputs, compile failures)' and OVERLAY_TO_SIDECAR_KEY (:239) is 'the single enumeration'. The suite replays the identical scenario per kind: tests at :705 (outputFiles), :724 (missingOutputs), :784 (compileFailures) — the copies even say so ('Same race as the output-files case above, replayed for updateMissingOutputs' :727-730; 'Eagerly applied for the same reason as the missing-outputs case above' :793). Separately, the disk-baseline-survives-unseeded-usage-mutation property is pinned 5 times: :502, :521 (#9956 regression pin), :642, :661, :682. Test :642 strictly subsumes :502 (same fresh-store/no-load scenario plus an extra read-back assertion); :661 and :682 differ only in whether the mutated run key matches the baseline run. Dedupe: no rounds 1-3 entry touches these tests; the survey docs' StreamSnapshotStore hits are the snapshot.description field and snapshotFromMemory clones, both unrelated.

**Coverage handoff — which suite owns each dropped behavior**

(1) The three round-keyed partial-preload tests become one it.each over [addOutputFiles/getOutputFiles/outputFiles.json, updateMissingOutputs/getMissingOutputs/missingOutputs.json, updateCompileFailures/getCompileFailures/compileFailures.json] in the same file — every kind stays pinned, through the same shared mergeRoundPatch path; the workPlan variant (:806) stays a separate test because its merge semantics differ (per-field last-write-wins). (2) Test :502 is deleted; its behavior is owned by the strictly-wider test :642 in the same file ('resolves pre-seed usage after merging existing disk usage', identical scenario plus read-back). (3) Tests :661 and :682 merge into one preload-variant test asserting both the different-run merge and the same-run sum; the load()-variant stays pinned by the protected #9956 regression test at :521. No persisted-format pin, no crash-recovery test, and no hydration-race test is touched.

**Proposal**

Three edits inside the existing suite: it.each the round-keyed accumulator trio (~65 LoC -> ~30), delete the subsumed :502 (~23 LoC), merge :661+:682 (~43 LoC -> ~26). All within one file; no format coverage moves across files.

**What we give up**

Per-kind test names in vitest output for the accumulator race (the it.each case label keeps the kind visible), and one redundant restatement of the usage-baseline merge.

**Verifier corrections — these override the evidence and proposal above**

1. 'No rounds 1-3 entry touches these tests' is slightly wrong: open round-3 PR #11457 edits this exact vitest file — but only to recast RUN/RUN_2 from StorageKey to ExecutionId at the constants block (and drop the StorageKey import). No structural overlap; the consolidation PR must simply land after/rebase onto #11457. 2) Unstated constraint worth carrying into the PR: issue #10809 puts StreamSnapshotStore's overlay-replay apparatus on a bugfix-only freeze, so the PR must remain strictly test-only (zero production edits) and preserve the exact scenarios — which the proposal already does. 3) Minor context: these tests pin machinery #10809 schedules for deletion by a named successor (JSONL swap / sidecar campaign), so the consolidation's shelf life is bounded; still a valid win now since no successor has landed. 4) LoC nit: trio is ~65 lines (18+26+21), :502 block is 19 lines with its comment, :661+:682 are 42 lines; recomputed net is ~-65, marginally under the claimed -70.

<details><summary>Verifier reasoning</summary>

Read the production file (mergeRoundPatch :209-216 with its 'shared by every round-keyed accumulator' doc, OVERLAY_TO_SIDECAR_KEY :245-251, consumeOverlay :263) and all cited tests at HEAD. The three partial-preload accumulator tests are structurally identical modulo setter/getter/sidecar-key/value-constructor and their comments admit it; missingOutputs lost its reset-aware special case when round 2 deleted clearMissingOutputs (0 hits at HEAD), so all three genuinely share one production path now. The workPlan exclusion is correct (WorkPlanOverlay is per-field last-write-wins, not mergeRoundPatch). Usage-baseline pins: :502 vs :642 confirmed same scenario with :642 strictly wider; :661 vs :682 confirmed differing only in run-key identity and safely mergeable; :521 (#9956, load()-variant, also pins plan sidecar) is a distinct scenario and stays. Checked dedupe index, all three survey docs, round-3 PRs #11452-#11460 (only #11457 touches the file, trivially), and the #10809 freeze (bans extending production machinery, not deduping tests). Risk is low: single test file, no production change, no wire or persisted contract, protected regression pin retained.

</details>

#### Two suites over the one StreamTabs component, with duplicated fixture builders and drifted file names

- **Kind**: consolidate · **Risk**: low · **Net**: -30 LoC (proposer claimed -65; verifier figure governs)
- **Files**: `src/test-kernel/progressView/StreamTabsStatus.vitest.ts`, `src/test-kernel/progressView/StreamTabsExpandChevron.vitest.ts`

**Evidence**

Both files import the same component under test: @progressView/frontend/components/StreamTabs (StreamTabsStatus.vitest.ts:5, StreamTabsExpandChevron.vitest.ts:5), 394 + 301 = 695 LoC. Each re-declares the same scaffolding: a StreamTabInfo builder (stream() at StreamTabsStatus:29-37 vs makeStream() at ExpandChevron:14-22), an identical settleChildRender() (StreamTabsStatus:54-56, ExpandChevron:38-41), and a mountTabs() wrapper (StreamTabsStatus:58-76, ExpandChevron:43-46), plus duplicate import blocks and useLitComponentTestDom setup. The 'ExpandChevron' file has drifted far past its name — it tests aria-labels, session footers, inline agent names, hidden finished process children (:100-274). AGENTS.md Testing discipline: 'Extend the module's existing suite rather than adding a new test file... one suite per module'. Dedupe: round 2's survey touches StreamTabs only for the WorktreePRInfo production deletion and explicitly checked StreamTabsExpandChevron.vitest.ts:125-127 passes (round2 doc line 123); no round proposed suite consolidation.

**Coverage handoff — which suite owns each dropped behavior**

No behavior stops being pinned. All 17 tests from both files move verbatim into one merged src/test-kernel/progressView/StreamTabs.vitest.ts (two describes: lifecycle/status rendering, and tree/labels), sharing one fixture builder, one settleChildRender, one mountTabs. The two existing builders differ only in AgentCategory default (ToolUse vs Workflow) — the merged builder takes it as a parameter.

**Proposal**

Merge into one StreamTabs.vitest.ts; delete the duplicated builders, mount helper, render-settle helper, and one import/setup preamble (~65 LoC), removing one file. Keep every it() body unchanged so no coverage question arises in review.

**What we give up**

Nothing behavioral; only the (misleading) per-topic file naming.

**Verifier corrections — these override the evidence and proposal above**

1. netLoc -65 is ~2x optimistic. The proposal's "sharing ... one mountTabs" contradicts its own "keep every it() body unchanged" constraint: the two mountTabs helpers have incompatible signatures — StreamTabsStatus's mountTabs(streams, statuses, activeStreamId) (19 lines, synthesizes the streamStates map from a status list) vs ExpandChevron's mountTabs(props: Partial<StreamTabs>) (4-line passthrough). With bodies unchanged, both must be kept (one renamed); actual dedup is one import preamble (~11), one StreamTabInfo builder (~9), one settleChildRender (~5), one useLitComponentTestDom call hoisted to file scope (~3), plus ~3 blank/comment lines — honest net ~-30. 2. "All 17 tests" is 16 (6 in StreamTabsStatus, 10 in StreamTabsExpandChevron). 3. Merging the builders requires renaming call sites (stream vs makeStream), a minor deviation from "it() bodies unchanged"; ExpandChevron's makeBashChild and Status's streamState/styleText are unique and carry over as-is. 4. Both files were already reworked by test-simplifier sweeps (#10287 and the 82/104-batch checkpoint) without merging — the win is residual and modest, not untouched territory.

<details><summary>Verifier reasoning</summary>

Verified against HEAD: both suites import @progressView/frontend/components/StreamTabs, 394+301=695 LoC as claimed; scaffolding duplication is real (near-identical StreamTabInfo builders differing only in AgentCategory, byte-identical settleChildRender, duplicate import/setup preambles). AGENTS.md's one-suite-per-module rule makes this the canonical shape, and the ExpandChevron file has genuinely drifted past its name (aria-labels, footers, agent-name rendering, finished-child hiding). No duplicate claim in any round, no KEEP ruling, no external consumer, no ratchet. The only material defects are the inflated LoC estimate (mountTabs cannot be unified without rewriting Status's 6 call sites) and an off-by-one test count. Low risk: pure test-file merge, verbatim it() bodies, verifiable with npx vitest run src/test-kernel/progressView/.

</details>

#### ProgressBackendFactProjection: the narrow two-session active-stream scoping test is strictly subsumed by the wide isolation test in the same file

- **Kind**: delete · **Risk**: low · **Net**: -29 LoC (proposer claimed -28; verifier figure governs)
- **Files**: `src/test-kernel/progressView/ProgressBackendFactProjection.vitest.ts`

**Evidence**

Test at :336 ('scopes direct session events to each backend session', 28 LoC) creates two backends, emits an active-stream fact into each, and asserts per-backend presentation.activeStream plus no cross-leak of stream ids into the other backend's messages. Test at :433 ('isolates simultaneous window sessions across view state, status, snapshots, and transcripts', ~110 LoC) performs the identical emitActiveStream on both backends and asserts the same activeStream-per-backend and the same JSON.stringify(messages) non-containment (:539-543), plus status, run metadata, and transcript isolation. Every assertion of :336 has a literal counterpart in :433. The middle test at :364 is NOT subsumed — it pins the distinct same-stream-id case — and stays. Dedupe: rounds index has no FactProjection entry; the suites share no duplicate it() names (checked with a uniq -d over all five ProgressBackend suites).

**Coverage handoff — which suite owns each dropped behavior**

Dropped: two-backend active-stream fact scoping -> owned by 'isolates simultaneous window sessions across view state, status, snapshots, and transcripts' in the same file (src/test-kernel/progressView/ProgressBackendFactProjection.vitest.ts:433), which performs the same emits and carries the same assertions. 'isolates same-stream run facts across simultaneous backend sessions' (:364) is retained untouched.

**Proposal**

Delete the test at :336-362. Nothing else changes.

**What we give up**

A faster-failing narrow variant of an invariant the wide test still enforces.

**Verifier corrections — these override the evidence and proposal above**

1. The retained same-stream-id test is at :365, not :364 (:364 is the blank separator line). 2. The wide test's message non-containment assertions are at :540-541, not :539-543 (:536-539 are streamLogs assertions). 3. The wide test's emitActiveStream calls are not literally "identical": stream ids differ ('window:_' vs 'session:_') and the agent categories are swapped (first=ToolUse/second=Workflow vs first=Workflow/second=ToolUse) — functionally equivalent for the isolation invariant, but not the same emits. 4. The wide test never asserts second.activeStream !== firstStream directly; it asserts === secondStream, which strictly implies it. 5. Deleting :336-363 plus the trailing blank line is 29 physical lines, not 28. No imports are orphaned (createListeningBackend, emitActiveStream, StreamTabId all have other users).

<details><summary>Verifier reasoning</summary>

Read the full 1370-line suite. Enumerated the narrow test's six assertions and matched each to a literal or strictly-stronger counterpart in the wide isolation test: waitFor activeStream per backend (:501-506) and the cross-backend message non-containment pair (:540-541). The only non-literal delta — probing the second backend before its own emit — adds no detection power because every realistic leak path (shared bus/handler cross-wiring; each backend has its own isolated session via createIsolatedRecordingBackend) produces an outbound message naming the leaked stream, which the wide test's containment check fails on regardless of emit ordering; presentation.activeStream is only written by that same handler. Neither stream id is a substring of the other in either test. Git history confirms the wide test was added later as deliberate session-isolation coverage (5e766fbb2d) while the narrow test came from the #7330 routing refactor with no regression pin. Coverage handoff is real and named. Not a durable boundary in the checklist sense (internal progress-view projection seam), not an architecture guard, no dated KEEP ruling, no duplicate in rounds 1-3 or open round-3 PRs, and PR #11457's edits to the same file are disjoint. Consistent with the repo's "Tests are a budget" rule.

</details>

### tests-tools

#### Retire the model-facing prompt-copy substring pins in DelegationHeadless and WorkflowScriptTool (keep schema-shape and plumbing assertions)

- **Kind**: amend · **Risk**: low · **Net**: -64 LoC
- **Files**: `src/test-kernel/tools/DelegationHeadless.vitest.ts`, `src/test-kernel/tools/WorkflowScriptTool.vitest.ts`

**Evidence**

Three DelegationHeadless cases pin exact substrings of tool-description / injected-instruction prose: :1219-1233 ('adds a substantive handoff requirement…', 4 toContain substrings of the injected instruction), :1258-1272 ('tells orchestrators that delegated instructions must carry parent constraints', 3 substrings of the parameter description), :1274-1283 ('…run asynchronously and support parallel dispatch', 3 substrings of the tool description). WorkflowScriptTool.vitest.ts:415-477 ('declares the task-plan contract at the model-facing boundary') pins 8 exact description substrings (~lines 439-462) alongside genuine provider-schema shape assertions. None carries a comment or issue number explaining a pinned incident. Prompt copy is edited routinely; each wording tweak breaks these tests without any observable behavior at a durable boundary changing — AGENTS.md Testing discipline's churning-seam case. Dedupe: no rounds123-index entry; grep of the three survey docs for 'task-plan contract', 'handoff requirement' and prompt-copy pins is empty. The nearby em-dash content-rule test (DelegationTools.vitest.ts:125) is a deliberate standing lint and is NOT part of this finding.

**Coverage handoff — which suite owns each dropped behavior**

Deliberately none for the prose substrings — the pin is retired, not moved; that is the point of the finding. Behaviors that remain pinned: parent-instruction propagation into the subagent (rootUserInstruction + constraint-context header) stays via the kept DelegationHeadless.vitest.ts:1235 case; the WorkflowScriptTool provider-schema shape (script/scriptPath optional pair, no scriptInput property, args accepts arbitrary JSON via the two zodSchema.safeParse checks) stays — only the plain-English description substrings leave.

**Proposal**

Delete DelegationHeadless.vitest.ts:1219-1233, :1258-1272, :1274-1283 (keep :1235-1256). In WorkflowScriptTool.vitest.ts:415-477 delete the eight description-substring expectations, keeping the providerSchema toMatchObject, the property-presence/required assertions, and both safeParse checks.

**What we give up**

If the guidance copy silently disappeared from a tool description (e.g. a refactor dropping the annotation step), no test would notice. The structural annotation machinery (roster/model placeholders being rewritten) is still pinned by DelegationAvailability.vitest.ts, so only unannotated static prose loses protection.

**Verifier corrections — these override the evidence and proposal above**

1. 'None carries a comment or issue number explaining a pinned incident' is slightly overstated for the first case: DelegationHeadless :1219 ('adds a substantive handoff requirement') was introduced by fix commit 164dea778c (#5864, 'require substantive subagent handoffs') and is that fix's regression test. Deleting it removes a bug-fix regression test, not just decorative prose. Mitigation: the pinned copy already churned wholesale in #9568, so even the regression pin only mirrors wording; an amender could optionally replace the 4 substrings with one durable assertion that the injected instruction extends the bare instruction (injection-happened, wording-free) instead of deleting outright. 2. The two later DelegationHeadless description tests (:1258, :1274) were themselves added by #9568, the same prompt-alignment commit — they are 3 weeks old, not long-standing protection. 3. WorkflowScriptTool churn evidence should cite the concrete commits: fd93c20823 (#9127 introduced the substrings), then b1dfcc127a, 2aecb2349a, 8a082676d3 touched the :415-477 region, though some of those edits hit the kept schema assertions rather than the prose. 4. Production copy homes for the retired pins: src/tools/delegation/inputFields.ts:108 and src/tools/delegation/DelegationTools.ts:113,225 — useful for the amend PR description.

<details><summary>Verifier reasoning</summary>

The finding is a textbook application of the repo's own testing doctrine. Verified at HEAD that all four cases exist exactly as cited and that every claimed remaining-coverage anchor is real: DelegationAvailability.vitest.ts pins the roster/placeholder annotation machinery, DelegationHeadless :1235-1256 pins rootUserInstruction plus the constraint-context header, and the WorkflowScriptTool provider-schema assertions (toMatchObject, required-list, scriptInput absence, two safeParse checks) are cleanly separable from the 8 prose substrings at :439-462. git -L history proves the churn claim rather than merely asserting it: #9568 rewrote three substring sets in lockstep with prompt copy, the exact failure mode AGENTS.md names. The one real cost — silent disappearance of guidance copy going unnoticed — is honestly disclosed, and the #5864 regression-test nuance (correction 1) softens but does not defeat the finding, since a wording-pinned regression test that gets rewritten whenever the prompt is tuned provides no durable regression protection. Risk is low, not medium: test-only deletion, no production edits, no external contracts, kept assertions verified present.

</details>

#### NativeSubagentStrategy: drop the runTurn call-shape case — its assertions are re-made by the two-turn loop test and the production-path suite

- **Kind**: amend · **Risk**: medium · **Net**: -53 LoC (proposer claimed -52; verifier figure governs)
- **Files**: `src/test-kernel/tools/NativeSubagentStrategy.vitest.ts`

**Evidence**

NativeSubagentStrategy.vitest.ts:544-595 ('runTurn hands its consumed batch directly to the persisted flow cursor') asserts the exact argument shape passed to the mocked resumeToolUseTurn. Its two central assertions are duplicated in the same file: the resume-snapshot handoff (calls.map(c => c[0]) === [resume, resume]) and the drainedFollowUps normalization (identical {text, displayText: undefined, mediaFiles: undefined, origin} shape) are both asserted at :727-750 inside 'keeps a second child follow-up available after two resumed WAITING turns' (:615). The end-to-end resume behavior runs unmocked in NativeSubagentProductionPath.vitest.ts:371 ('resumes one persisted child through the real queue and archives both turns once'). Dedupe: the round-2 survey doc touches this file only for two stale mock-factory keys (2026-08-26-simplification-survey-round2.md:461-475, shipped); rounds123-index has no entry for this case.

**Coverage handoff — which suite owns each dropped behavior**

Resume-snapshot handoff to the flow cursor and drainedFollowUps normalization: src/test-kernel/tools/NativeSubagentStrategy.vitest.ts:615 (same-file, same mocks, asserts both). Real resume path end-to-end: src/test-kernel/tools/NativeSubagentProductionPath.vitest.ts:371. retrieveSessionResumeData being called with (streamId, executionId, config): implied by the :615 case reaching resumeToolUseTurn with the retrieved snapshot; the exact argument triple itself stops being pinned.

**Proposal**

Delete the it() at NativeSubagentStrategy.vitest.ts:544-595. Do not touch the #7491 regression pin immediately below (:597) or anything else in the file.

**What we give up**

The approvalPromptsUnavailable and runtimeUnavailableTools passthrough into resumeToolUseTurn options loses its only pin — that is a same-process option-forwarding seam, and round 2's refuted list already ruled the production threading of runtimeUnavailableTools stays as-is, so the passthrough is stable code; still, a dropped field there would now surface only in dogfooding.

**Verifier corrections — these override the evidence and proposal above**

1. Line cite: the loop test's duplicate assertions sit at :728-753 (calls at :729-731, drainedFollowUps at :732-753), not ":727-750". 2. "What we give up" is incomplete: the deleted objectContaining also pins parentStreamId (:581) and session (:591) forwarding into resumeToolUseTurn options, and :594 pins isTerminal(completed toolUse) — none mentioned. All three are covered end-to-end by the unmocked ProductionPath suite (resumedStreams/completedResumes asserted as [PARENT_STREAM_ID, PARENT_STREAM_ID]; run completion requires terminal classification of a completed toolUse turn), so the verdict stands, but the honest unique loss is options forwarding of approvalPromptsUnavailable/runtimeUnavailableTools plus the retrieveSessionResumeData argument triple — the latter partially real-covered because ProductionPath runs retrieval unmocked and a wrong key would fail the resume there. 3. Net is -53 counting the separating blank line; -52 counts the it() block alone. 4. Merge-order note: the round-2 stale-mock-key fix for this same file (survey round2 proposal item 2, :70-73) shifts line numbers if it lands first; anchor the deletion by test title, not line range.

<details><summary>Verifier reasoning</summary>

The claim's core is true and verified against HEAD: both "central" assertions of the :544 case are re-made in the same file by the :615 two-turn loop test using the same mocks, and the loop test exercises them through the production caller (childRunLoop) rather than a hand-built direct call, so it subsumes the call-shape case rather than merely overlapping it. The fully-unmocked ProductionPath suite covers the real retrieval-and-resume path including session/parent-stream threading. The only assertions that lose their last pin are the passthrough of two config options into resumeToolUseTurn — a same-process option-forwarding seam on stable code (round 2 already ruled runtimeUnavailableTools production threading stays as-is). Under the repo's explicit tests-are-a-budget doctrine, a mocked call-shape test whose substance is asserted twice more (once at a stronger level, once unmocked) is exactly merge friction, not safety. No index entry, no dated ruling, no open-PR collision, no comment to defeat, cost accurate. Medium risk is right: the loss is real but narrow, and a dropped option field would surface in dogfooding as the finding says.

</details>

#### ToolStatusFormatting: drop the two formatSubagentError cases — the exact-XML pin in SubagentResults and the classification suite already own both

- **Kind**: amend · **Risk**: low · **Net**: -37 LoC
- **Files**: `src/test-kernel/tools/ToolStatusFormatting.vitest.ts`

**Evidence**

ToolStatusFormatting.vitest.ts:58-71 ('marks retryable subagent errors in the orchestrator delivery') and :73-92 ('includes attached memory misses in subagent error delivery') call the same production function, formatSubagentError (src/tools/delegation/subagentResults.ts:229), with weaker toContain assertions than SubagentResults.vitest.ts:325 ('pins the exact native error XML'), which pins the retryable attribute, the memory-misses element, escaping, and field order byte-for-byte through the same code path. The retryable derivation itself is normalizeProviderError().userRetryable (subagentResults.ts:239,246), and the specific 'No output generated - API returned empty response' classification is pinned at src/test-kernel/common/SdkErrorUtils.vitest.ts:620. Dedupe: no rounds123-index or survey-doc entry names ToolStatusFormatting or formatSubagentError.

**Coverage handoff — which suite owns each dropped behavior**

Retryable attr + memory-misses rendering + escaping in the error XML: src/test-kernel/tools/SubagentResults.vitest.ts:325 (exact-string pin, strictly stronger). Memory-misses in success deliveries: SubagentResults.vitest.ts:248. Retryable classification of the empty-response message: src/test-kernel/common/SdkErrorUtils.vitest.ts:620. The three remaining ToolStatusFormatting cases (formatTodoSection, formatSubagentProgress, formatListingLine) keep their own coverage in place.

**Proposal**

Delete the two cases at ToolStatusFormatting.vitest.ts:58-92 and the formatSubagentError import at :16. Optional zero-cost tidy-up while there: the remaining file and ExecutionFormatters.vitest.ts (34 lines) both cover @tools/executionFormatters and could be one suite, saving ~15 more lines of boilerplate.

**What we give up**

Nothing — every dropped assertion is a strict subset of a surviving exact pin.

**Verifier corrections — these override the evidence and proposal above**

Two minor overstatements, neither verdict-changing. (a) The SdkErrorUtils pin is at line 618 (the it() 'treats provider empty responses as retryable transient failures'), not 620; and it exercises formatProviderHttpError directly, which is the delegate normalizeProviderError reaches for a bare Error — same path, but one indirection removed from the finding's phrasing. (b) 'Every dropped assertion is a strict subset of a surviving exact pin' is slightly too strong: the escaped memory-miss reason ('&amp; unreadable') in the dropped error-path case is NOT in the exact error pin (whose reason has no special chars); it survives via the success-delivery test at SubagentResults.vitest.ts:248 plus the fact that both paths share formatDeliveryPreamble/escapeAttr — a shared-helper argument, not a literal subset. The handoff still holds because the helper is provably single (subagentResults.ts:120-138, called at 161 and 254). The optional ExecutionFormatters.vitest.ts merge (34 lines, confirmed) is a separate change and should not be bundled into the netLoc claim.

<details><summary>Verifier reasoning</summary>

Read the target file in full and every claimed surviving pin. The two cases under deletion assert (i) retryable='true' + message element for the empty-response error and (ii) memory-misses element with escaped reason in the error delivery. The exact-string pin at SubagentResults.vitest.ts:325 covers the error XML shape (retryable attr, memory-misses element, message escaping) byte-for-byte; SdkErrorUtils.vitest.ts:618 covers the specific message-to-retryable classification; SubagentResults.vitest.ts:248 covers reason-attribute escaping through the shared formatDeliveryPreamble helper both delivery paths use. Composition of the three surviving tests dominates the two dropped ones. Deletion is pure test-budget recovery with zero coverage loss, aligned with the repo's testing doctrine.

</details>

#### latex/: one owner for the shared 'LaTeX file not found' guard instead of three per-tool copies

- **Kind**: amend · **Risk**: low · **Net**: -22 LoC
- **Files**: `src/test-kernel/tools/latex/ExtractFiguresTool.vitest.ts`, `src/test-kernel/tools/latex/ExtractTikzFiguresTool.vitest.ts`

**Evidence**

The error string exists at exactly one production site: src/tools/latex/figureExtractionShared.ts:54 (`throw new ToolError('LaTeX file not found: …')`), shared by all three latex extraction tools. Three structurally identical tests pin it: ExtractBibliographyTool.vitest.ts:100-110, ExtractFiguresTool.vitest.ts:54-63, ExtractTikzFiguresTool.vitest.ts:62-71 — each installs an empty platform, calls the tool on a missing path, and asserts status error + the same message. This is exactly the brief's 'same plumbing pinned once per tool' pattern.

**Coverage handoff — which suite owns each dropped behavior**

Missing-input-file error from the shared guard: src/test-kernel/tools/latex/ExtractBibliographyTool.vitest.ts:100 survives as the single named owner. Each tool's own behaviors (figure discovery, TikZ compile toggle, bibliography wildcard fallback) keep their existing per-tool cases untouched.

**Proposal**

Delete the missing-file case from ExtractFiguresTool.vitest.ts (:54-63) and ExtractTikzFiguresTool.vitest.ts (:62-71); keep the ExtractBibliographyTool copy as the guard's owner.

**What we give up**

If one tool someday stops routing through figureExtractionShared's guard, its missing-file behavior regresses unpinned. Today all three provably share the single throw site, so the risk is hypothetical.

**Verifier corrections — these override the evidence and proposal above**

Minor only. (a) The tool class in ExtractFiguresTool.vitest.ts is `ExtractLatexFiguresTool`, not `ExtractFiguresTool` — the file paths in the proposal are correct, so this is cosmetic. (b) The cited ranges are the it-blocks alone (Figures :54-63, Tikz :62-71); reaching -22 requires also deleting the preceding blank separator line in each file (Figures 53-63 = 11 lines, Tikz 61-71 = 11 lines), which any implementer would do. (c) The ExtractBibliographyTool owner block is :100-109 in the current file (the `expect(result.error)` line is :108), an off-by-one on the stated :100-110. (d) "exists at exactly one production site" is true for source (figureExtractionShared.ts:54, function resolveLatexFileOrThrow); the string also appears in checked-in dist bundles, which are build artifacts of that same site.

<details><summary>Verifier reasoning</summary>

Verified against HEAD: the guard is src/tools/latex/figureExtractionShared.ts:49-55 (resolveLatexFileOrThrow, throws `LaTeX file not found: ${display}`), and all three tools call it as their first statement in execute() — ExtractBibliographyTool.ts:55, ExtractFiguresTool.ts:37, ExtractTikzFiguresTool.ts:40. The three tests are structurally identical as claimed: install empty platform, call tool with a missing texPath, assert status 'error' + toContain('LaTeX file not found') (ExtractBibliographyTool.vitest.ts:100-109, ExtractFiguresTool.vitest.ts:54-63, ExtractTikzFiguresTool.vitest.ts:62-71). Deleting the two non-owner copies removes 11 lines each (10-line it-block + blank separator): FiguresTool 53-63, TikzTool 61-71 = 22 lines, leaving both files with their remaining tool-specific tests (files are 64 and 72 lines; neither is emptied). The named owner in ExtractBibliographyTool.vitest.ts survives and pins the guard once. The residual risk the finding admits — a tool later bypassing the shared guard regresses unpinned — is real but hypothetical today and is exactly the trade the repo's testing discipline endorses. Cost is honestly stated and net negative with no added code.

</details>

### tests-rest

#### ProgressViewCommandHandlers suite: delete the mock-routing tests and the three Zod parse-table describes

- **Kind**: amend · **Risk**: low · **Net**: -319 LoC (proposer claimed -318; verifier figure governs)
- **Files**: `src/test-kernel/controllers/ProgressViewCommandHandlers.vitest.ts`

**Evidence**

Four regions of the 1,254-line suite exercise no production logic beyond what other pins already own. (1) Lines 206-343: 'routes lifecycle commands to host actions' and 'routes file commands to host actions' build every action as vi.fn() and assert the mock was called with the message's own fields — classic asserts-its-own-mock over one-line dispatch rows. The repo's own round-1 verifier already recorded this coverage as inert: .agents/docs/archived/simplification/2026-08-25-simplification-survey-49-candidates.md:2401 quotes issue #11282 that 'the only coverage today is the mocked bag in ProgressViewCommandHandlers.vitest.ts:106-162 ... which would pass regardless of a routing regression'. (2) Lines 788-881 ('permission action schemas', 30 it.each rows), 892-912 (the parse-only it.each of 'external inquiry action schema'), and 1190-1254 ('user question action schema', 7 rows) all reduce to expectMessageParses = ProgressViewInboundMessageSchema.safeParse(...).success (helper at :200-205) — pure re-assertion of the schema's declared strictObject/DU arms, which AGENTS.md Testing discipline bans ('Do not test what npm run typecheck or a Zod schema already guarantees'). Dedupe: rounds 1-3 index has no entry for this suite; the two round-1/3 refutations touching ProgressViewCommandHandlers concern production shape, not tests. The expectDispatched helper survives (29 uses, 10+ after line 343). No issue-number regression pins in the cut regions (grep '#[0-9]{3,}' → none in this file).

**Coverage handoff — which suite owns each dropped behavior**

Dispatch wiring for lifecycle/file commands: owned end-to-end by src/test-kernel/controllers/ProgressViewRunCommands.vitest.ts, which drives the same dispatchProgressViewInbound registry through REAL ProgressWorkflowFileActionsController and ProgressAgentProposalController instances (RUN_NEW/RESUME/OPEN_LABEL/AGENT_PROPOSAL_ACTION at :147-186, including the non-native-identity refusal regression pin), plus the surviving behavioral describes in this same file (follow-up :344, bypass toggles :429, approvals :704, second tier :958) which all dispatch through the same registry. Per-row pass-through mappings (SWITCH_STREAM→setActiveStream etc.) become intentionally unpinned trivial plumbing per AGENTS.md. Message-shape acceptance/rejection: owned by ProgressViewInboundMessageSchema itself in src/shared/schemas — the schema is the wire contract's single source of truth. Approval BEHAVIOR (the landmine) stays pinned: the approvals describe survives here, and tool-edit approval decisions are owned by src/test-kernel/frontend/VscodeToolEditApproval.vitest.ts and src/test-kernel/controllers/ToolEditApprovalController.vitest.ts. The behavioral persist→dismiss→continue ordering test of the external-inquiry describe (:913-957) is explicitly KEPT.

**Proposal**

Delete lines 206-343 (the first 'createProgressViewCommandHandlers' describe with its two routing tests), 788-881 ('permission action schemas'), the parse-only it.each at 892-912 inside 'external inquiry action schema' (keep the beforeEach and the behavioral ordering it.each), and 1190-1254 ('user question action schema'). Keep expectDispatched and expectMessageParses is then dead → delete the helper at :200-205 too. Everything behavioral (follow-up image persistence, bypass-kind grants, approval routing with real controllers in ProgressViewRunCommands, second-tier polish/export) survives untouched.

**What we give up**

Give up if any cut region turns out to carry an issue-numbered regression pin on re-read, or if a reviewer shows a schema refinement in these tables (e.g. feedback-only-on-reject) that is NOT declared in ProgressViewInboundMessageSchema itself — that would mean the test pins logic living outside the schema.

**Verifier corrections — these override the evidence and proposal above**

(1) "expectMessageParses is then dead → delete the helper" is FALSE: the kept bypass-toggles describe uses it at :548 ('rejects a bypass enable that does not name its kind', :547-555). Either keep the helper (net ~-319) or, consistently, also cut :547-555 — it is the same parse-only schema re-assertion (EnableApprovalBypassMessageSchema declares `kind` as required) — giving ~-334. (2) The "classic asserts-its-own-mock" / inert characterization overstates: the two routing tests dispatch real parsed messages through the real factory registry and WOULD fail on a swapped route or dropped argument. The #11282 quote ("would pass regardless of a routing regression") was about cross-HOST adapter wiring regressions, which the mocked bag indeed cannot catch — the correct ground for deletion is the AGENTS.md:194 test budget (trivial pass-through plumbing; schema-guaranteed shapes), not inertness. (3) Region boundary nit: the parse-only it.each in 'external inquiry action schema' is lines 891-911, not 892-912. (4) The routing region includes the OPEN_SPILL_ARTIFACT rows added by fix commit 3eacfc6f3b ('fix(progress): complete spilled output access') — no issue-numbered pin and the fix's substance lives in production spill handling, but a reviewer may flag it; the handoff answer is that the row becomes intentionally unpinned plumbing.

<details><summary>Verifier reasoning</summary>

Dedupe clean: rounds123-index has no entry for this suite; survey docs mention the file only inside refutations of production-side candidates; no round-3 PR (#11452-#11460) touches it. No dated ruling protects the tests — the closest, #11282 (CLOSED 2026-08-23), actually characterizes the mocked-bag coverage as insufficient. AGENTS.md:194 explicitly bans testing what a Zod schema already guarantees, and I verified every row of the three parse tables (permission actions :788-880, external-inquiry parse-only :891-911, user-question :1190-1254) reduces to safeParse-success against constraints declared verbatim in src/shared/schemas/progressView/inbound.ts (strictObject DU arms, actionWithFeedback, submit-requires-answers/answer, draft nullable-required). The schema is internal webview IPC, not a frozen external wire. Coverage handoff holds: ProgressViewRunCommands.vitest.ts exercises the same factory with real controllers, and all behavioral describes in the suite survive (follow-up, bypass toggles incl. the AUTO-EDIT/AUTO-BASH split pins from #11383, approvals, external-inquiry persist→dismiss→continue ordering, second tier). No issue-numbered regression pins in the cut regions (grep confirmed; git log -L shows refactor/chore provenance). LoC recomputed: 138 (206-343) + 94 (788-881) + 22 (891-912) + 65 (1190-1254) = 319 with the helper kept; ~334 if the :547-555 parse-only test and helper go too — the claimed -318 is essentially accurate. Pure test deletion, no production or contract change; residual exposure is future routing regressions on a surface #11282 already noted lacks host-level coverage, which the repo's test-budget policy accepts.

</details>

#### One suite for InstructionPanel: merge InstructionPanelDesktopComposer.vitest.ts into InstructionPanelLauncher.vitest.ts

- **Kind**: consolidate · **Risk**: low · **Net**: -40 LoC (proposer claimed -55; verifier figure governs)
- **Files**: `src/test-kernel/webview/InstructionPanelLauncher.vitest.ts`, `src/test-kernel/webview/InstructionPanelDesktopComposer.vitest.ts`

**Evidence**

Both suites (416 + 249 LoC) render the same production module, @webview/frontend/components/InstructionPanel, through the same useLitComponentTestDom(loadInstructionPanelModules) + mountInstructionPanel harness from ./mainViewTestUtils, and each re-declares duplicate local helpers — query<T>() (Launcher :31, Composer :26) and recordEvents() (Launcher :38, Composer :53). AGENTS.md Testing discipline: 'Extend the module's existing suite rather than adding a new test file ... one suite per module, path-mirrored'. Dedupe: no rounds-1-3 entry proposes or protects this split; the survey docs mention InstructionPanel only for production sentinel-event findings (2026-08-25 survey :2657-2663), not its test layout.

**Coverage handoff — which suite owns each dropped behavior**

Nothing stops being pinned — this is a pure merge. All 9 desktop-composer behaviors (desktop layout opt-in, compact affordances, unified mode picker mapping, multi-root working-directory control, Enter-to-send vs Shift+Enter, send-disabled gating) move verbatim into the merged file as a 'desktop composer' describe alongside the launcher/team-picker/session-hint describes. The merged suite (suggested name InstructionPanel.vitest.ts) owns everything both files own today.

**Proposal**

Move the Composer describes into the Launcher file (or a renamed InstructionPanel.vitest.ts), keep one copy of query/recordEvents/dispatch helpers and one SESSION fixture block, delete the second file. Honest saving is the duplicated import/helper/fixture block (~55 lines); test bodies are untouched.

**What we give up**

Give up only if the merged file's shared beforeEach state turns out to conflict between the two describes (different module-load options), in which case keep the split and record a keep ruling.

**Verifier corrections — these override the evidence and proposal above**

1. The local helpers are NOT verbatim duplicates, only near-duplicates: Launcher's query returns T | null (line 31) while Composer's throws on missing (line 26); Launcher's recordEvents records {type, detail} (line 38) while Composer's records {type, value} from detail.value (line 54, not 53 as claimed). Unifying recordEvents requires editing ~4 Composer expectation blocks to the detail shape (or keeping both variants and losing that saving) — so "test bodies are untouched" is overstated. Composer's dispatchChange is subsumed by Launcher's changeValue but folding it also touches call sites. 2. The two describes install different module-load hooks: Launcher's useLitComponentTestDom callback additionally imports @shared/utils/selectTemplates sentinels after DOM globals install; the merged file should keep two useLitComponentTestDom calls (one per describe) rather than one shared beforeEach — the finding's give-up clause already anticipates this and it works, so it is not a blocker. 3. -55 LoC is optimistic given the helper-shape reconciliation; honest saving is the import block (~15), one query (~8), one recordEvents (~12), dispatchChange fold (~4), plus blank/fixture lines: about -40.

<details><summary>Verifier reasoning</summary>

Verified at HEAD: both files render the same InstructionPanel module through the identical harness, and the repo's own testing-discipline rule mandates one suite per module. Both files survived prior simplifier sweeps (#9827, #9989 touched them without merging) but no ruling protects the split. Dedupe clean: no index entry, no survey mention, no open or merged PR overlap. The only substantive pushback is that the duplicated helpers differ in shape (nullable vs throwing query; value vs detail recordEvents), which slightly raises the edit surface inside Composer test bodies and trims the net saving from -55 to roughly -40. Merge is mechanical, no production code changes, coverage handoff is complete since every describe moves verbatim.

</details>

#### One suite for mainViewActions: fold MainViewActions.vitest.ts into MainViewLaunchTarget.vitest.ts

- **Kind**: consolidate · **Risk**: low · **Net**: -30 LoC
- **Files**: `src/test-kernel/webview/MainViewActions.vitest.ts`, `src/test-kernel/webview/MainViewLaunchTarget.vitest.ts`

**Evidence**

Both suites test the same two production modules — @webview/frontend/mainViewActions and @webview/frontend/mainViewState (import blocks: MainViewActions :8-20, MainViewLaunchTarget imports the same pair plus slices). MainViewActions (210 LoC, 3 tests: pack posts, multi-file clean, merge posts) is a second file over a module whose primary suite is the 513-line MainViewLaunchTarget. AGENTS.md: one suite per module. Dedupe: no rounds-1-3 entry covers these files; the shipped round-1 item about MainView execute messages ('MainViewExecuteMessage') is a different shared-schemas suite.

**Coverage handoff — which suite owns each dropped behavior**

Nothing stops being pinned. The three direct-action behaviors (single-file pack + info message, multi-file clean filtering empty entries with the active tool-use agent, merge + info message) move as a 'direct actions' describe into MainViewLaunchTarget.vitest.ts (which already mocks the host bridge via mainViewTestUtils), which then owns the whole mainViewActions/mainViewState surface.

**Proposal**

Move the three tests plus the selectFiles/information helpers into MainViewLaunchTarget.vitest.ts (consider renaming it MainViewActions.vitest.ts to path-mirror the module), reuse its existing state-reset/postMessage harness, delete the smaller file. Saving is the duplicated import/mock/reset scaffolding (~30 lines).

**What we give up**

Give up if the hoisted @shared/hostBridge mock in MainViewActions proves incompatible with mainViewTestUtils' harness in one file; then keep the split.

**Verifier corrections — these override the evidence and proposal above**

1. The finding says MainViewActions.vitest.ts has "3 tests". It has 8 test blocks totaling 15 cases (it.each): pack post, multi-file clean, pack-rejection x2, the latexdiff/latexdiffvc/pack-latexdiffvc/clean-latexdiffvc family x4, merge post, merge-rejection x2, compare/accept posts x2, compare-rejection x2. The proposal's "move the three tests" would silently drop 12 pinned cases and falsify "Nothing stops being pinned" — the entire describe body must move. Net LoC is unchanged by this correction (the -30 is scaffolding dedupe either way). 2) MainViewLaunchTarget does NOT mock the host bridge "via mainViewTestUtils"; mainViewTestUtils supplies only the teamOption factory, and both files declare identical inline vi.hoisted/vi.mock('@shared/hostBridge') blocks (MainViewActions:22-28, MainViewLaunchTarget:40-46). This actually kills the finding's own give-up condition: the mocks are byte-identical, so incompatibility risk is nil. 3) The "one suite per module" framing is overstated as a violation claim: src/test-kernel/webview/ routinely holds scenario-scoped suites over the same modules (FileSelectGroupActions, MainAppPersistenceRestore, MainAppDesktopGating also import mainViewState/mainViewActions through a DOM harness), and MainViewLaunchTarget plausibly qualifies as the rule's permitted "one named cross-module scenario" (it also tests MainViewPersistedStateSchema and catalog/session slices). The real justification is the duplicated signal-level scaffolding between exactly these two suites, not a rule breach. 4) Minor: merged file lands at ~690 lines, the largest suite in the directory (current max: MainAppPersistenceRestore at 575) — acceptable but worth stating as the trade.

<details><summary>Verifier reasoning</summary>

Verified at HEAD: both suites exercise the same production pair (@webview/frontend/mainViewActions + mainViewState) with byte-identical mock/reset scaffolding, and MainViewActions.vitest.ts (210 lines) duplicates ~35-40 lines of imports/mock/beforeEach that MainViewLaunchTarget.vitest.ts (513 lines) already has. AGENTS.md's testing discipline explicitly prefers extending an existing suite over a second file, no ruling or comment defends the split, no round 1-3 item or open round-3 PR covers it, and the change is test-only with no external consumer. The finding's description contains real errors (test count, the mainViewTestUtils mock claim, the overstated rule-violation framing) but none of them invalidates the consolidation — the corrected plan (move all 8 test blocks plus the selectFiles/information helpers under the existing harness, delete the smaller file) preserves every pinned case and nets about -30 LoC. Low risk: pure test-file merge, identical mocks, no production or wire-contract surface touched.

</details>

#### SettingsAgentCatalogController suite: drop the two root-preview tests that re-pin planTeamRun's selection, owned by TeamPlan.vitest.ts

- **Kind**: amend · **Risk**: low · **Net**: -22 LoC
- **Files**: `src/test-kernel/controllers/SettingsAgentCatalogController.vitest.ts`, `src/test-kernel/common/teams/TeamPlan.vitest.ts`

**Evidence**

The controller's getPresetToolUseRoot delegates to planTeamRun (src/controllers/settingsView/SettingsAgentCatalogController.ts:125, doc comment :103 says the preview must show 'what planTeamRun picks'). Two tests in the controller suite re-assert planTeamRun's own selection outcomes through the extra layer: :279-289 'previews no root for a custom team with no delegating members' and :290-300 'previews the engineer root for the built-in Software Engineer team'. TeamPlan.vitest.ts pins exactly these facts at the owning boundary: 'selects engineer for the built-in software-engineer team' (:130), 'does not fall back to an arbitrary delegating agent for a built-in' (:144), 'selects the first delegation-capable custom member in preset order' (:155), and the launch-block/no-runnable-root cases (:254). Dedupe: no rounds-1-3 entry names either suite; the round-1 refuted item about SettingsAgentControllerFactory's getAgents seam is unrelated.

**Coverage handoff — which suite owns each dropped behavior**

Root-selection semantics → src/test-kernel/common/teams/TeamPlan.vitest.ts (planTeamRun describes, :115-233). The controller-specific wiring stays pinned in the controller suite by the surviving tests: :301 (preview before the catalog loads, empty-catalog case — controller-specific), :314 ('previews a built-in team with the root planTeamRun picks for it' — the delegation wiring itself), :363 (custom root semantics by id), :399 (unresolvable preset fallback). Nothing loses its owner.

**Proposal**

Delete the two tests at :279-300 (~22 lines). Keep :301-407 untouched.

**What we give up**

Give up if reading getPresetToolUseRoot shows the no-delegating-member undefined path takes a controller-local branch that bypasses planTeamRun — then only the engineer-root test (:290-300) is a true duplicate.

**Verifier corrections — these override the evidence and proposal above**

1. The engineer test (:290-299) does NOT re-pin TeamPlan's 'selects engineer for the built-in software-engineer team' (:130) as claimed: it passes no presetId, so it runs CUSTOM-preset semantics through the synthetic 'settings-preview' preset, not built-in-root-name semantics — a different planTeamRun path. It is still redundant, but with different owners: surviving controller test :259-277 (same default fixture, ad-hoc preview picks 'engineer' first among delegation-capable members) plus TeamPlan's 'selects the first delegation-capable custom member in preset order' (:155), and :314-361 pins the ad-hoc-custom vs by-id-builtin divergence. 2) The coverage handoff cites 'launch-block/no-runnable-root cases (:254)' — the tests at TeamPlan :254-268 are manualPlan-based teamLaunchBlockReason checks, not planTeamRun; the actual owner of the custom-no-delegating→undefined fact is resolveTeamLaunch's block test at TeamPlan.vitest.ts :593-610 plus surviving controller test :399 (identical member list, asserts undefined through the exact same getPresetToolUseRoot path). 3) TeamPlan's planTeamRun describe has no direct 'custom preset with zero delegating members → undefined rootAgent' case; coverage of that fact after deletion rests on controller :399 and TeamPlan :593, which is sufficient but is not the mapping the finding stated.

<details><summary>Verifier reasoning</summary>

Verified against HEAD: getPresetToolUseRoot (src/controllers/settingsView/SettingsAgentCatalogController.ts:106-137) is a pure delegation to planTeamRun with catalog + synthesized built-in root entries; the doc comment itself says the preview shows 'the same root planTeamRun picks'. Test :279-288 (custom team, no delegating members → undefined) is a strict behavioral subset of surviving test :399-406, which feeds the identical member list through the identical code path (an unresolvable presetId falls back to the same synthetic custom preset) and asserts the same undefined — so within the controller suite alone it pins nothing unique, and the launcher-agreement rationale is separately owned by TeamPlan.vitest.ts :593 (resolveTeamLaunch → 'no runnable team root'). Test :290-299 pins 'engineer wins for the software-engineer member list previewed ad-hoc', which is already pinned by :259-277 (same fixture, engineer beats leanOrchestrator/non-orchestrator members ad-hoc) and by TeamPlan's custom preset-order-first test; the controller-specific wiring facts (empty catalog + synthesized roots :301, by-id builtin semantics :314, custom-by-id :363, unresolvable id :399) all survive. Nothing loses its owner; deletion is safe and aligns with the repo's test-budget rule. The finding's evidence contains two ownership mischaracterizations (listed in corrections) but they do not change the verdict.

</details>

### test-support

#### Merge ToolUseWaitNodeFollowUpTranscriptLog.vitest.ts into ToolUseWaitNode.vitest.ts, its module's main suite

- **Kind**: consolidate · **Risk**: low · **Net**: -42 LoC (proposer claimed -40; verifier figure governs)
- **Files**: `src/test-kernel/agent/followUp/ToolUseWaitNodeFollowUpTranscriptLog.vitest.ts`, `src/test-kernel/agent/followUp/ToolUseWaitNode.vitest.ts`

**Evidence**

AGENTS.md Testing discipline: 'Extend the module's existing suite rather than adding a new test file... one suite per module.' ToolUseWaitNode has two suites: ToolUseWaitNode.vitest.ts (994 LoC) and the 167-LoC satellite ToolUseWaitNodeFollowUpTranscriptLog.vitest.ts, whose describe at :78 marks it 'regression: #7508 pattern on resume'. The satellite carries its own ~30-line buildServices preamble duplicating setup the main suite already owns. The three sibling *TranscriptLog satellites (ToolUsePrepareNodeTranscriptLog 137, MediaExtractionNodeTranscriptLog 95, ToolUseRoundPrepNodeFollowUpTranscriptLog 117) are each their node's ONLY suite (verified: rg for those node names across test-kernel finds no other file), so merging them would mean creating new files — no win; they stay. Dedupe: no rounds 1-3 item touches these files; #7508 is cited in all four, and the pins are preserved by the move, not deleted.

**Coverage handoff — which suite owns each dropped behavior**

Every behavior stays pinned: the #7508 resume-path transcript-logging regression cases move verbatim into src/test-kernel/agent/followUp/ToolUseWaitNode.vitest.ts (the module's surviving main suite), keeping their describe title citing #7508. Nothing is dropped; only the duplicated fixture preamble and the file are deleted.

**Proposal**

Move the satellite's describe blocks into ToolUseWaitNode.vitest.ts, reusing that suite's existing services builder (extend it with the two overrides the satellite needs), delete the file. Gross -167 file, +~127 relocated = net about -40 and one fewer suite pinned to this churning node seam.

**What we give up**

If ToolUseWaitNode.vitest.ts's existing builder cannot express the satellite's mocked initializeMessages/consumeInsertedAttachmentKinds overrides without contorting its other 990 lines, keep the satellite — a 40-line win does not justify destabilizing a 994-line suite.

**Verifier corrections — these override the evidence and proposal above**

1. The "What we give up" section names "mocked initializeMessages/consumeInsertedAttachmentKinds overrides" — neither symbol appears in either file. The satellite's actual distinct setup is: a spy-wrapped TraceEmitter logger (Object.assign(new TraceEmitter(), {info: vi.fn(), ...})), an identity createUserFollowUpMessages mock (async (messages) => messages, vs the main builder's default async () => []), an addMediaToUserMessage mock, capabilities: {} (vs DEFAULT_MODEL_CAPABILITIES in the main builder — verify the merged tests still pass under default capabilities), fileService.createLocation as vi.fn(), and onRoundFinalized: () => {} (absent from the main builder; the main suite passes without it, so likely optional). 2) The satellite's buildServices is 21 lines, not "~30" (roughly 35 counting imports and PREP_RES, so approximately fair). 3) The satellite also omits the main suite's `import '@test/support/defaultSessionTestSetup'`; after the merge its tests run under that setup — low risk since the logger is a local spy, but worth a local test run. 4) The file was created by #7579 ("log follow-up transcript rows even when media insertion throws"); #7508 is cited only as the pattern in the describe title — the finding's phrasing is consistent but the PR of record is #7579. 5) Sequencing note: open round-3 PRs #11455-region touch neighboring followUp test files (FollowUpQueue, ToolUseFollowUp*, ToolUseRoundPrepNodeFollowUpTranscriptLog, ToolUseDispatchInterruption, ToolUseRoundFollowUpMedia, ChildStreamYoloInheritance) but NOT the two target files — no conflict, though landing after those merges avoids directory-level churn.

<details><summary>Verifier reasoning</summary>

Verified against HEAD: ToolUseWaitNode.vitest.ts is 994 lines and is the module's main suite; the 167-line satellite tests the same node's post() path with its own 21-line buildServices duplicating capability the main builder (createWaitNodeServices, with typed WaitNodeServiceOverrides including logger, onFollowUpConsumed, fileService, modelHandler overrides) already provides — onFollowUpConsumed is already referenced 7 times in the main suite, proving the exact seam the satellite tests is first-class there. rg over src/test-kernel confirms the three sibling *TranscriptLog files are each their node's only suite, so the finding correctly limits itself to the one true satellite. AGENTS.md's one-suite-per-module rule directly supports the merge. Cost: -167 (file) + ~120-125 relocated (90-line describe block + ~30 lines of helpers after dropping PREP_RES, which duplicates the main suite's waitPrep(), and the 13 import lines) ≈ -40 to -50 net; claimed -40 is honest. All #7508-pattern pins move verbatim, so no coverage loss. Risk is low: pure test relocation, no production code, and the escape hatch (keep the satellite if the builder can't express the overrides) is genuinely unlikely to trigger given the builder's existing override surface.

</details>

#### Hoist the only multi-copy byte-identical fixtures: projectTaskGroupsFromStreamLog (x3) and physicistCatalog (x2)

- **Kind**: consolidate · **Risk**: low · **Net**: -32 LoC (proposer claimed -45; verifier figure governs)
- **Files**: `src/test-kernel/shared/TaskGroupProjection.vitest.ts`, `src/test-kernel/cli/WorkflowRunDetails.vitest.ts`, `src/test-kernel/progressView/LogDeltaTextDeltas.vitest.ts`, `src/test-kernel/settings/ExtensionAgentHandlers.vitest.ts`, `src/test-kernel/desktop/DesktopAgentSettingsController.vitest.ts`, `src/test-kernel/support/transcriptRowFixtures.ts`

**Evidence**

From the corpus-wide duplicate-body scan, only two clusters exceed the pair-of-3-liners noise floor. (1) projectTaskGroupsFromStreamLog — a 10-line fold over upsertTaskGroupFromStreamLog — is byte-identical at src/test-kernel/shared/TaskGroupProjection.vitest.ts:15, src/test-kernel/cli/WorkflowRunDetails.vitest.ts:35, and src/test-kernel/progressView/LogDeltaTextDeltas.vitest.ts:40 (5 call sites total). Three suites re-declaring the same fold over the same production helper is the drift shape round 3 paid for. (2) physicistCatalog — a 23-line AgentCatalog literal builder — is byte-identical at src/test-kernel/settings/ExtensionAgentHandlers.vitest.ts:71 and src/test-kernel/desktop/DesktopAgentSettingsController.vitest.ts (same body, verified by hash), pinning the same preset-catalog fixture on two hosts. Dedupe: neither symbol appears in rounds123-index.md nor in the 2026-08-25/2026-08-26 survey docs.

**Coverage handoff — which suite owns each dropped behavior**

No behavior stops being pinned: this moves fixture construction only; every assertion in all five suites survives in place. Task-group projection behavior remains owned by src/test-kernel/shared/TaskGroupProjection.vitest.ts; the CLI and progress-view rendering behaviors remain owned by their existing suites, now importing the one fold helper. Agent-preset behavior remains owned by src/test-kernel/settings/ExtensionAgentHandlers.vitest.ts and src/test-kernel/desktop/DesktopAgentSettingsController.vitest.ts unchanged.

**Proposal**

Add projectTaskGroupsFromStreamLog to src/test-kernel/support/transcriptRowFixtures.ts (the existing transcript-fixture home, 8 consumers) and import it in the three suites (-30 gross, +14 shared incl. imports). Hoist physicistCatalog into a small shared fixture (support/ or settings-local with a desktop import) and import from both suites (-46 gross, +27 incl. imports and the AgentCatalog type it needs). Honest net about -45 across 5 files; do NOT expand into a sweep of the ~25 remaining 2x pairs of 3-16-line helpers — each pair nets under 10 lines and is R5 churn.

**What we give up**

If cross-directory imports from settings/ into desktop/ tests are unwanted for the physicistCatalog half, drop that half and keep only the x3 projection fold (net -15, still defensible as the lone 3-copy fixture in the corpus).

**Verifier corrections — these override the evidence and proposal above**

1. Call-site count wrong: projectTaskGroupsFromStreamLog has 7 call sites (shared:51,103,120,144 = 4; cli:196,254 = 2; progressView:308 = 1), not 5. Also shared/TaskGroupProjection.vitest.ts:129 calls upsertTaskGroupFromStreamLog directly (incremental path), so that suite keeps its upsert import after the hoist. 2. The claimed net (-45) contradicts the finding's own arithmetic: -30+14 and -46+27 sum to -35. My recount: fold = 11 lines/copy incl. doc comment (33 gross), shared copy ~14 incl. import additions, +2 new import lines in consuming suites (cli already imports transcriptRowFixtures, extends existing specifier) → about -17; physicistCatalog = 23 lines x2 (46 gross), shared fixture ~28-30 incl. the local `type AgentCatalog = Record<AgentCategory, AgentEntry[]>` alias (declared test-locally in BOTH suites, another small dedup win the finding undercounts) and imports, +2 import lines → about -15. Honest net ≈ -32. 3. Placement nit: transcriptRowFixtures.ts's header scopes it to projected CLI transcript ROW builders; a TaskGroup fold is stream-log projection, not a transcript row — either extend that header comment or put the fold in a small taskGroup fixture module; does not change the net materially. 4. Desktop physicistCatalog is at DesktopAgentSettingsController.vitest.ts:160 (finding gave no line; body verified identical, 2 vs 7 call sites settings/desktop).

<details><summary>Verifier reasoning</summary>

Verified byte-identity directly: awk-extracted bodies hash identical (fold: af3f495fceda3cd0b936d920f7d7649b x3 at shared:15/cli:35/progressView:40; catalog: 186c4741406a15f48522691e532e7503 x2 at settings:71/desktop:160). Confirmed no production equivalent of the fold exists, so support/ is the right home. Confirmed support/agentCatalogMock.ts is a vi.mock of the @agent/index surface, not an AgentCatalog data literal — no existing fixture is being duplicated by the proposal. Confirmed zero overlap with prior rounds and open PRs. Coverage handoff claim holds: only fixture construction moves; every assertion stays in its owning suite, and the shared suite retains its direct upsert import for the incremental-path test. The scoping discipline (refusing the ~25 small 2x pairs) is correct per R5. Only defects are a call-site miscount and an internally inconsistent net figure; corrected net is still a clean two-cluster dedup at low risk.

</details>

## 3. Keep rulings

8 apparent redundancies were examined and found to be the right shape. Do not re-open one without evidence that beats the reasoning here.

#### Runtime session/lifecycle/lease/resume suites: audited, every apparent duplication sits inside the protected categories

~12,000 LoC examined test-by-test (full describe/it inventories plus close reads of the overlap candidates). Real overlaps exist but are all barred from deletion by the mandate's own stays: (1) RestartRepair:113/:398/:476 vs SessionRestartRepair:747/:474/:386 duplicate foreign-owner hold, reuse-race skip, and crash-settles-CANCELLED at unit vs SessionHandle level — all concurrency/lease arbitration from the 2026-08-23 single-owner-sessions campaign. (2) issue #7287 is pinned twice (ExecutionRegistry:376, AgentRunLifecycle:896) — both are regression pins through two live entry points. (3) RetryState's gate block (:892-1105) is NOT a duplicate of ModelRetryGate.vitest.ts: it pins wire-route key derivation and classifyFailure vs classifyModelFailure scoping, while ModelRetryGate owns probe/backoff/streak arbitration — complementary, verified by reading both. (4) SessionResumeRetrieval's first describe is the persisted resume-record format boundary; its cancellation half carries #8049/#8018 pins. Issue-pin census across the scope: #7287×2, #8155, #8093, #7491, #8049, #8018, #9590, #7331, #7079, #7086, #6937.

Record as a round-4 keep ruling so future sweeps skip this ground: the runtime core suites protect exactly what the deletion mandate exempts (concurrency, cancellation, first-terminal-outcome arbitration, dispose-to-quiescence, cross-process leases) at high pin density, and no suite here reduces to asserting its own mocks — SessionInteractions and ExecutionRegistry drive the real port/registry with recording hosts.

#### WorkflowScript family (~6,400 LoC across 8 suites): sandbox security plus persisted journal format — not a consolidation target

Read the full test inventories and compared the suspected duplicate pair line-by-line: Engine's 'replays matching journal entries and re-runs edited calls' (:766-798) pins in-memory journal identity matching; Persistence's 'accepts script drift' (:873-906) additionally asserts the stored checkpoint adopts the evolved script across a store round-trip — a persisted-format assertion the engine suite cannot make. ProgressBridge asserts the AgentEvent workflow.call/stage projection (the trace plane all three hosts render), while WorkflowExecutionObservability asserts the persisted observability snapshot — two different durable outputs, verified from their imports (@tools/delegation/workflowScriptRun + TraceEmitter vs @agent/workflowScript direct). Roughly a third of Engine is node:vm escape/security tests (Function-constructor, malicious thenables, Promise.prototype.then forgery, Intl wall-clock, determinism guards) — protected as security checks; most of the rest is journal/checkpoint identity, i.e. the persisted resume format.

Record as a keep ruling: the family's size is proportionate to what it guards (a vm sandbox running untrusted-ish scripts plus a persisted, resumable journal), and the apparent cross-suite overlaps each assert a distinct durable layer.

#### src/test-kernel/agent/followUp/ examined in full: no deletion survives verification — the directory is regression pins, admission arbitration, and cancellation coverage

All 20 suites (~5,500 LoC) read. The four transcript-log suites (MediaExtractionNodeTranscriptLog, ToolUsePrepareNodeTranscriptLog, ToolUseRoundPrepNodeFollowUpTranscriptLog, ToolUseWaitNodeFollowUpTranscriptLog, 516 LoC) are all #7508 regression pins, each at a different node whose code path still exists — protected, and consolidation would merge four node-specific harnesses for little net gain. FollowUpQueue/ToolUseFollowUp/ToolUseFollowUpProgressEvents pin the single-owner-sessions admission machine (leases, generations, delivery-id replay #9531) — first-terminal-outcome arbitration, protected. ToolUseWaitNode and ToolUseDispatchInterruption are interruption/cancellation and tool_use/tool_result pairing — protected. ChildStreamYoloInheritance and HumanPromptProgressEvents pin approval-bypass decisions — protected category, and the bypass-ancestry shape is the subject of an open round-3 actionable (#11452-#11460 range), so its tests should churn with that PR, not before. The *ProgressEvents suites each cover a distinct provider/child-stream fact family with a real recording-host harness (progressTestUtils), not asserting-own-mock; cross-checked against sibling owners (GoalContinuation.vitest.ts is helper-level while ToolUseWaitNode is integration-level; runtime/ChildRunLoop covers a different plane). ToolUseProgressEvents carries the #8023 persistence pin.

No change. If the round-3 bypass-ancestry consolidation lands, ChildStreamYoloInheritance should be trimmed in that PR (delete-with-the-behavior), not preemptively.

#### The protected core of the CLI suite: concurrency, arbitration, frozen-wire, and flag-boundary suites are correctly sized — do not re-hunt

Examined each of the largest suites against the deletion categories and found them protected or genuinely behavioral: chatSessionController (1,915 LoC) is run-slot ownership, first-terminal-outcome, resume-vs-Ctrl-C races, host-generation detach — the concurrency/cancellation category, with real runtime objects behind the mocked executeAgent boundary; TuiApprovalRetry's bulk (700-1676) is retry cancellation, rollback serialization, stale-lookup arbitration; StreamLogDeltaFold is the fold-vs-oracle property suite for #9946 (regression pin, randomized interleavings); AppEscapeRouting pins chord-window disambiguation and pending-action invalidation (timing arbitration); History pins the frozen pre-consolidation NDJSON vocabulary (306, 342) and the history/export command surface; CliRootArgs pins flags, help text, exit routing and stdout/stderr discipline — durable CLI boundaries; ApprovalAdapter pins approval-policy decisions with issue-cited describes (#7331, #9532); AnsiMarkdown's dollar/math/HTML cases each encode a distinct user-visible rendering equivalence class. Mock-assertion scan (toHaveBeenCalled density) found no suite that only asserts its own mock. Prior sweeps (#10287 net -219, #9827) already removed the mechanical fat.

Record as a keep ruling so round 5 does not re-partition these files. The one structural blemish worth a line in the ruling: TuiStateAndFocus.vitest.ts (4,036 LoC) spans ~9 modules in one file, but splitting it adds files against the extend-existing-suites rule and deletes nothing — leave it.

#### KEEP ruling: DesktopAgentExecution.vitest.ts stays at 4,370 lines — it is the regression-pin and concurrency spine of the desktop host, not padding

Audited the full outline (79 tests). The bulk sits squarely in the four protected classes: numbered regression pins (#10399 :1076, #10400 :1122, #10848 :1232, #7751 :1213/:1930, #7851 :1963, #7827 :2692, #7860 :2735, #8227-#8261 across :3088-:4172), window-recreation/process-owned-session arbitration (:2776-4172 — reattach-exactly-once, first-terminal-outcome, headless approval replay, stale-handle late settlement), deletion-vs-reattach races and dispose-to-quiescence (:2020-2288, :3595-3862), and resume dedupe/concurrency (:2538, :2557). The apparent sibling overlap is layering, not duplication: DesktopAgentResume.vitest.ts tests DesktopProcessResumeOwner (spied runAgent/resumeToolUseFromResumeData), DesktopAgentExecution tests the bridge above it through persisted meta — different failure modes (:209 vs :2293). Its known flakiness under parallel full-suite load is a stated artifact, not a finding. Recording this ruling stops future rounds from re-opening the repo's largest test file without new evidence.

No change. Any future cut here must name a specific duplicated section and defeat the issue-number pins individually.

#### StagedDeletionCoordinator.vitest.ts stays despite testing an internal single-consumer helper the store suite also exercises

The coordinator has exactly one production consumer (src/transcript/StreamSnapshotStore.ts:450), and StreamSnapshotStore.vitest.ts carries ~35 staged-deletion tests (:1554-2350), which made this 251-LoC isolation suite the surface's most tempting duplicate-coverage deletion. It survives on the what-the-code-says-it-is-for rule: the suite's header (:25-30) states it pins 'the disk transitions [the store] can't observe from the store's own public surface', and the fake host proves it — queueWrite records liveDirExisted (:57-61) so the suite asserts replayed writes land only AFTER the live namespace is restored, and calls[] pins the crash-safety ordering cancelPendingWrites-before-staging-rename (:104-115). Those mid-transition orderings are not observable through store-level end-state assertions, and they are crash-safety of persisted user data (protected class). Round 3 already refuted retiring the coordinator itself ('Retire StagedDeletionCoordinator: reorder stream deletion decide-first' — refuted, rounds index).

Keep the suite as-is. Any future proposal must defeat the header comment's mid-transition-observability argument explicitly, not just count the store suite's overlapping scenario names.

#### No shared mega-builder: the fixture layer is already consolidated, and a cross-suite builder would add more than it deletes

The briefing's premise ('3,175 LoC in only 2 files') is stale: src/test-kernel/support/ is 40 modules totaling 3,171 LoC, layered and heavily adopted — setupPlatform.ts imported by 132 test files, defaultSessionTestSetup.ts by 77, tempDirPlatform.ts by 73, FakePlatform.ts by 52, sessionTestUtils.ts by 44, asyncTestUtils.ts by 39, modelConfigTestUtils.ts by 33, repoScan.ts by 30 (counted via rg over import specifiers). Directory-local harnesses add 20 files / 2,188 LoC (largest: agent/progressTestUtils.ts 484, settings/litComponentTestUtils.ts 391 with 53 consumers), each with docstrings stating their layering. I ran a normalized byte-identical scan of every top-level helper body across all 830 .vitest.ts files: only ~30 duplicated blocks exist, the largest 23 lines x2, roughly 350 LoC gross for the entire corpus. The named suspects are not consolidatable: the 5 'buildServices' definitions build three DIFFERENT service types (ToolUseServices, ReflectionServices, ToolUseRoundServices) at 10-25 lines each; the 16 'function createHandler' definitions construct ~10 different production handler classes with per-suite capability deltas, and googleInteractionsTestUtils.ts's own docstring rules the shape deliberate ('Pass the capabilities a suite depends on as buildTestModelConfig's second argument so the meaningful override stays visible at the call site'); the 24 files hand-rolling a vi.fn logger each spend 1-4 lines; the 24 vi.mock('@agent/storage') factories mock different member subsets per suite (compared AgentRunLifecycle vs History vs DelegationHeadless — no two identical). Dedupe: rounds123-index.md has no fixture-layer item beyond round 2's 'twelve stale vi.mock factory keys' (already shipped, disjoint); the two survey docs under docs/proposals/ mention support/ only as fixture homes for other findings.

Record the fixture layer as settled for future rounds: 40 support modules + 20 directory-local harnesses are the intended two-tier shape (support/ for cross-directory reuse, directory-local for family-specific builders). Do not commission a unified buildServices/makeFake builder; any future fixture proposal must beat the measured ~350-LoC total duplication figure.

#### The support layer's self-tests and its two config-wired invisible consumers are load-bearing — do not sweep them as dead

Three support modules grep as zero-consumer and would be false-positive deletions in a future sweep: setupFakePlatform.ts is wired via vitest.config.mjs:33 setupFiles, vscode-mock.ts via the vitest.config.mjs:26 'vscode' alias (every one of the 27 suites mocking vscode resolves through it), and inkTestHarness.ts is imported by ~50 CLI suites via '@test/support/inkTestHarness.ts' (with extension, which my plain-name scan and a naive knip-style scan both miss). The two self-test files (inkTestHarness.vitest.ts 51 LoC, spiedTrace.vitest.ts 19 LoC) are not asserts-its-own-mock: they pin real harness semantics dozens of suites depend on — that renderOutputAtTerminalSize returns only the CURRENT frame after an effect-driven repaint or clear (the exact property that made the CLI resize-residue class of bugs reproducible), and that spiedTrace's strict mode throws on unexpected trace-member access. Deleting them saves 70 lines and unpins the contract of a harness with ~50 dependents.

Keep all five. If a later round automates dead-test detection, its scanner must resolve vitest.config.mjs setupFiles, the vscode alias, and extension-suffixed '@test/support/*.ts' import specifiers before classifying support modules as unconsumed.

## 4. Refuted — do not re-file

- **AgentPromptContracts: delete the verbatim-prose pins, keep the scanners, tool-roster, security, and issue-cited contracts** (`tests-agent-core`)

  <details><summary>Why it was refuted</summary>

  The core claim — ten "fully-prose tests with no roster/security/issue anchor" — is factually wrong for at least six of the ten. git log -S shows they are regression pins landed BY dated fix PRs: correct-agent describe (747-784) by fix(agent) #6149 "keep correct workflow from rewriting math"; both setup prose tests (720-733) by fix(setup) #8710 "keep provider keys out of chat" (the same PR as the security test the finding protects — and the finding's own escape clause says a citing PR makes them protected; PR found); progress-check describe (613-651) by fix #10136 "keep read-only progress checks focused" (the verbatim narrow-path sentences are the fix's payload); 'prefers direct review over computation' (671-681) by fix "reduce review agent over-verification"; 'still documents its ideal software specialist roles' (590-600) by the same #6655/#6664 fix whose sibling tests the finding explicitly keeps; 'owns general-purpose delegation guidance' (524-529) by fix "keep assistant delegation guidance in agent definition" (a placement contract). This is kill criterion 3 — the round-3 overturn pattern where the target's reason for existing wasn't defeated; the finding checked only for comment/issue citations in the file, not commit provenance, and its own logic (keeping the #6655 pair because it's fix-cited) protects these identically-provenanced tests. Criterion 6 also fires: the defensible residual is only 'is named assistant' (~4 LoC), numerics (added by prompt-tightening PR #9920 to pin its own tightening), and 'uses the concise review finding format' (from #9914) — roughly -25 LoC, not -150, a 6x overstatement, and the finding already pre-conceded exactly this downgrade in its 'what we give up' section, so the surviving content is the fallback position, not the finding. The right amendment for the fix-anchored tests is adding citation comments like the #6655 pair has, not deletion.

  </details>

- **AgentLaunchContext: drop the model-not-recognized double-surface variant that re-tests the shared presentLaunchError marker path** (`tests-agent-core`)

  <details><summary>Why it was refuted</summary>

  REFUTED on the regression-pin rule and a dated ruling. (1) The test targeted for deletion IS a regression test for a shipped fix: git log -S shows it was added by commit 8fdcd13a7e, "fix(agent): stop double-surfacing unrecognized-model failures (#10115)" — the PR title is literally the behavior being un-pinned, and the code path (validateModelExists at AgentLaunchContext.ts:209-227 plus the hasErrorPresentedMarker gate in the launch catch at :693-704) still exists. The finding never mentions #10115. (2) A dated ruling decided the two callers are not one behavior: .agents/docs/implemented/architecture/2026-06-10-error-pipeline-and-ownership.md's T2-4 ledger row records the fix landing in TWO halves on different dates ("LANDED (standalone, 2026-08-13; agent-not-found 2026-08-15)") and names both throw sites individually ("getAgentPath and validateModelExists await that result and call attachErrorPresented only when the host confirmed delivery"). #10115's own commit history shows the "same helper, different payload literal" premise was tried and reverted mid-PR: marking getAgentPath's error was backed out because showAgentConfigBanner and requestShowInstruction have different per-host delivery semantics ("validateModelExists stays marked: requestShowInstruction is genuinely rendered on every host"). The model-not-recognized half shipped alone, first, as its own fix; the deleted test is its only producer-side evidence. (3) The coverage handoff fails the strict test: the surviving :148 test pins the shared presentLaunchError marker semantics through the getAgentPath/banner caller. Nothing surviving pins that validateModelExists routes through presentLaunchError at all. A regression that re-introduces the exact pre-#10115 bug shape in validateModelExists alone — a fire-and-forget interactions.emit('requestShowInstruction', ...) followed by a plain throw — passes every surviving test in the file while re-shipping the double-surface #10115 fixed. "Same helper" coverage is not "same behavior" coverage; the bug was in the caller's routing, and the fix's marker gate is caller-specific history (T2-4 landed per-caller). The delivered-instruction-suppresses-toast behavior therefore has no verified surviving owner.

  </details>

- **The pre-flight compaction threshold trigger is pinned twice for ModelHandlerOpenAIResponse, and the copy in the main suite stubs out the very compaction it claims to test** (`tests-agent-handlers`)

  <details><summary>Why it was refuted</summary>

  The deleted test is the only test in either suite that pins the documented single-owner invariant that the LIVE pre-flight count — not the stale cumulative from the previous response — decides threshold compaction on counting-capable models (modelHandlerOpenAIResponse.ts:655-662, enforced at 1943-1948). Its fixture encodes the discriminant: every response reports usage 100000 (under the 150k threshold) while only turn 2's live count is 180000 (over). Git history shows this was the authorial point: before #9586 reworded it, the comment read "the stale cumulative from turn 1 (100k) would never have triggered, but the live count must" — the finding never engages with this (gate 3). The named surviving owner, OpenAIResponseCompaction.vitest.ts:243, cannot discriminate: its turn-1 usage (800) AND live count (800) are both over the 750 threshold, so under the concrete regression of the threshold check switching from preFlightTokens to chainState cumulative (a plausible one-threshold-check consolidation), the dedicated test stays green with identical observables while the deleted test goes red. The surviving overflow it.each (1183-1235) also fails to catch it — its 300k count exceeds the window, so recovery flows through handleCreateResponseError regardless of the threshold trigger; the client-side compaction tests use a non-counting profile and exercise the cumulative fallback, not the ownership. One dropped behavior therefore has no named, verified owner, so the handoff is not the claimed strict superset. The deletion would only be sound after first hardening the dedicated test's fixture (prior-turn usage under threshold, live count over) — not as proposed.

  </details>

- **Three GoogleInteractionsBackground tests re-pin shared BackgroundPoller/BackgroundRunLifecycle deadline and transient-resume semantics that the shared-module suites already own** (`tests-agent-handlers`)

  <details><summary>Why it was refuted</summary>

  REFUTED. The three deleted tests are unmarked regression tests from two shipped bug-fix commits, and one of them is the sole pin of a Google-specific classifier branch that the named surviving owner does not cover.

  (1) The ':477-498 keeps the original id through a transient failure, in_progress, and completion' test is NOT a redundant parameterization of :337. I read the production classifier (src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts, classifyBackgroundRetrieveFailure at ~1887): it computes detectStatusCode(error) and branches — status 404/410 or stale-chain returns {action:'replace'} (abandon the pending id), everything else returns {action:'retain'}. The deleted test's error is `Object.assign(new Error('temporarily unavailable'), { status: 503 })` — a STATUS-BEARING transient error — while surviving :337 uses TypeError('fetch failed'), which has NO status. These reach 'retain' through different predicate evaluations. A grep of the whole test kernel shows line 483 (inside the deleted test) is the ONLY status-bearing transient error on the background retrieve path anywhere; the kept 'invalidates an existing chain … ends missing' case pins the 404→replace side. Delete :477-498 and nothing pins that a 5xx during background get retains the interaction: a regression widening the replace branch (e.g. any detected status, or ≥500) passes :337 and every shared-suite test and ships. The finding's handoff (3) names :337 as owner; that owner is verified INCOMPLETE.

  (2) Regression-pin provenance, verified via git: :477-498 and :500-523 were added by 6d1c63456c 'fix(google): resume background interactions across retries' (2026-08-02); the it.each at :525-562 was added by 3adfdc004e 'fix(google): enforce resume boundaries after retrieval' (#9572, 2026-08-02). All three are regression tests for shipped bug fixes. The classifier code path from 6d1c63456c still exists handler-locally (it was NOT absorbed into the shared BackgroundRunLifecycle in #9951 — it is injected as the Google-specific onResumeRetrieveError/onPollRetrieveError hooks the handler's own doc comment at :375-384 calls out as 'every Google-specific decision'). Rubric: regression pin + extant code path → refute.

  (3) An unlisted dropped behavior with no owner: the deleted :500-523 and :525-562 are the only tests anywhere asserting the best-effort server-side CANCEL fires on the resume-path deadline expiry (expectLedger's 4th arg, cancels=['int_expire']/['int_late'], hits BackgroundRunLifecycle.assertCanPoll → await onTimeoutDiscard). Surviving B9 (:1075) pins cancel only on the in-loop poller-timeout path; BackgroundRunLifecycle.vitest.ts contains zero cancel assertions (grep: 0 hits), and ModelHandlerOpenAIResponseBackground.vitest.ts also has zero. Google's createBackgroundTimeoutError message even promises 'Server-side cancellation was attempted'. The finding's coverage handoff never names an owner for this behavior because none exists.

  What IS correct in the finding: the deadline arithmetic itself is genuinely shared-owned (BackgroundRunLifecycle owns the 'pending-id/deadline state machine' per its header, rememberPending preserves an existing deadline; BackgroundPoller.vitest :106/:127/:152 and BackgroundRunLifecycle.vitest :156/:218 are themselves regression pins from the twin OpenAI fixes #9566 and 'close expired background lifecycle'), no spec mandate protects the deleted tests (the 2026-06-23 background spec enumerates only B1-B10), the abort variants are untouched, and the 2026-08-25 survey doc touches these suites only for the fake-timers/delay trap. A narrowed proposal — delete only the it.each at :525-562 (~38 LoC) after moving its cancel-ledger assertion into a kept test, keep :477-498 outright — could be refiled. As filed at -84 LoC it deletes a sole-owner classifier pin and the only resume-timeout-cancel pin.

  </details>

- **Codex background-eligibility and zero-rating facts are triple-pinned across ModelHandlerOpenAIResponseBackground, CodexExperimentalTransports, and CodexSubscriptionFallback** (`tests-agent-handlers`)

  <details><summary>Why it was refuted</summary>

  The CodexExperimentalTransports.vitest.ts:118-134 leg fails the ownership test. That test does three assertions, and the finding's named owner covers only two of them. ModelHandlerOpenAIResponseBackground.vitest.ts:170's assertBackgroundMode (lines 87-93) checks isBackgroundModeActive() and getStreamingConfig() — nothing else. The doomed test additionally asserts `storesResponsesServerSide === true` on the API-key fallback (line 132), and that is the ONLY place in the repo where this flag is asserted true: every other assertion pins it false (same file :81 and :96, OpenAIResponseCompaction.vitest.ts:108, ProviderCapabilities.vitest.ts:96). The flag is computed independently of the background decision (`getOpenAIResponseCapabilities()?.storesResponsesServerSide ?? true`, modelHandlerOpenAIResponse.ts:377-381), so the surviving background/streaming assertions cannot catch a regression in it. Its own doc comment says what it is for: 'Single source for the `store` request field and the encrypted-reasoning gate' — it drives the wire `store` field (lines 984, 1684), previous_response_id chaining vs encrypted-reasoning replay (the documented "Duplicate item found" hazard), client-side vs stateful compaction (#7213), and background poll-by-id (canPollById, line 2151). A wire request field is a durable boundary; deleting its only true-direction pin with no named owner is exactly the coverage loss this review exists to block. The test also verifies capability-profile disengagement through the real installPlatform config path, which the Background suite (getConfig spy, no platform) never exercises. A narrowed finding deleting only ModelHandlerOpenAIResponseBackground.vitest.ts:182-203 (~22 LoC) would survive — see corrections — but as proposed, refuted.

  </details>

- **SubagentListDisplay re-pins the workflow attempt-boundary fold that WorkflowDashboardModel already owns** (`tests-cli`)

  <details><summary>Why it was refuted</summary>

  Kill criterion 3 (what the code says it is for) plus a failed coverage handoff. The finding's premise — the band consumes attempt inputs only through the shared fold — is false at HEAD. The band's phase segment comes from currentWorkflowPhaseHeading (packages/cli/src/chat/tui/state/workflowPhase.ts:13-30), which carries its OWN attempt-filter predicate; workflowDashboardModel filters phases with a separate inline copy. Only currentWorkflowAttemptId (sentinel resolution) and latestWorkflowCallsById (task fold) are shared — the null/undefined sentinel CONSUMPTION for phase headings is duplicated across two consumers. The proposal's own stay-condition ('a second copy of the fold rather than a shared call ... the tests stay') is therefore already met today. Coverage handoff fails concretely: no test anywhere imports currentWorkflowPhaseHeading or ancestorWorkflowPhaseHeading; workflowRunStatusSummary is tested only in SubagentListDisplay.vitest.ts; and attemptId/workflowAttemptId/workflowAttemptBoundaryDeclared inputs appear in that suite only inside the four tests being deleted. Post-deletion, the predicate has zero coverage while also feeding StatusBar.tsx:313 and StaticConversationTranscript.tsx:147 via ancestorWorkflowPhaseHeading — a null-sentinel bug there passes every named surviving test. Additionally, the test-2 handoff is a scenario mismatch: WorkflowDashboardModel tests 280/318 use current attempts that redeclare a phase; neither pins the phase-less-current-task + prior-heading case, which guards the band's documented anchor rule (ConversationPane.tsx comment: a stray phase-less call must not invent a band).

  </details>

- **Coding-plan keyed-arm behaviors are pinned once per catalog row instead of once per skeleton (Kimi + GLM copies)** (`tests-cli`)

  <details><summary>Why it was refuted</summary>

  REFUTED on the strict coverage-handoff test: two of the five deleted tests are the ONLY pins of the GLM row's write wiring, and the named surviving owners verifiably do not cover it.

  1. The premise "per-row identity ... is separately owned by the catalog suites" is false for the write side. The runtime table (src/model/codingPlanSubscriptions.ts:71-97, RUNTIME_BY_ID) carries real per-plan function wiring TODAY, not just descriptor strings: glmCodingPlan.setEnabled/restoreEnabled = setGLMCodingPlan (→ writePlatformSetting(GlobalStateKey.GLM_CODING_PLAN), providerConfig.ts:132-133), while kimiCode uses writePlatformSetting(KIMI_CODE_PREFER) and a distinct restoreEnabled with an intent-preserving comment. The finding's own escape hatch ("If the GLM arm ever grows plan-specific logic ... the copies return") is already satisfied — the plan-specific logic exists now, so per rule 3 the claim must defeat that and does not.

  2. The named owners do not own the dropped behavior. I read both handoff suites in full: src/test-kernel/shared/CodingPlanSubscriptions.vitest.ts (68 lines) pins catalog freezing and descriptor lookups (usageRoute/apiProvider/usage-setting → id); src/test-kernel/model/CodingPlanSubscriptionsRuntime.vitest.ts (104 lines) pins read-side classification (activeCodingPlanForModel over seeded GLM_CODING_PLAN state, endpoint gating) and Kimi restoreEnabled. Neither ever calls or asserts GLM setEnabled/setGLMCodingPlan. After deleting ModelAccessSelection.vitest.ts:386 ('enables GLM Coding Plan routing...', expect(mocks.setGLMCodingPlan).toHaveBeenCalledWith(true)) and :419 ('turns off GLM Coding Plan...', ...toHaveBeenCalledWith(false)), a repo-wide grep shows NO remaining test anywhere asserts setGLMCodingPlan is invoked (TuiApprovalRetry mocks the higher setCliCodingPlanSubscription seam; ConfigForm.vitest.ts:382 and stateSettings.vitest.ts:471 pin only the GLM_CODING_PLAN label and settings-catalog membership). Regression that ships silently: rewire or no-op the glmCodingPlan row's setEnabled and /model-access 'enable GLM Coding Plan' stops persisting anything — read-side tests still pass because they seed state directly. That is a persisted-settings toggle (durable boundary) losing its only pin, with a wrongly named owner → refute.

  3. Factual mislabel in the handoff: TuiApprovalRetry tests at 963 ('restores the coding-plan preference when the fallback client cannot be prepared'), 993 (cancellation) and 1021 ('serializes coding-plan rollback...') all use kimiCodeSubscriptionRetry fixtures ('kimi-prepare-fails', 'kimi-cancel-prepare', 'plan-race-*'), not GLM — they are not "GLM rollback/serialization tests" and do not backstop GLM.

  4. Minor unowned drop: deleting :419 also removes the only assertion of the keyed arm's disable message template ('${preferenceLabel} disabled for ${modelFamily}.') — the surviving Kimi off tests (497, 586) assert writes only, never the message. Likewise the GLM guide-to-key deletion (:407) removes the only assertion of plan.credentialSetupUrl (open.bigmodel.cn) reaching the user.

  What WOULD survive as a narrower finding: the TuiApprovalRetry GLM auto-switch copy (938-962) is genuinely redundant — the generic commit arm is pinned by the Kimi test at 819-855, GLM exhaustion → 'glmCodingPlan' decision mapping is pinned by ApprovalAdapter.vitest.ts:916-933 (classifyCliRetryAction → 'disable-quota-route:glmCodingPlan'), and the GLM path through the coding-plan arm stays exercised by the surviving it.each modal test at 911-937. ModelAccessSelection:367 (report-preference copy) is also covered by the cross-provider independence test at 497 ('glm-code': 'Off · key configured' while Kimi is On pins GLM getEnabled identity). But the finding as filed deletes :386 and :419 with a false owner claim, so it is refuted; resubmit as the ~40-line subset (938-962 plus optionally 367-385) or keep one GLM write-wiring test.

  </details>

- **Two vitest suites pin the arg parsing of dev-only validation harness scripts that CI already exercises end-to-end** (`tests-cli`)

  <details><summary>Why it was refuted</summary>

  REFUTED on coverage handoff and mischaracterization. (1) The named surviving owner covers only a subset: ci.yml:341 exercises --snapshot-dir + plain scenario positionals (+ leading-`--` transparency incidentally), and ci.yml:459 runs validate:run with NO arguments — so unknown-option rejection (both scripts), --help/--list/--list-selected, --no-build/--skip-if-missing-deps ordering, the TEXRA_TUI_HARNESS fail-fast, and the frame-oracle insertion have no verified owner; per the charter, any unowned dropped behavior refutes. (2) The finding's framing "arg parsing of dev-only scripts" is wrong for the oracle-insertion test: it pins selectedScenariosWithFrameOracles (validate-tui.mjs:3607-3628), the scheduling semantics of the byte-equivalence oracle design tied to issue #7972 (script lines 116, 2489, 2638 "per the design doc"). Only the missing-oracle half fails loudly at runtime (line 4495); the at-most-once / no-dedup-of-explicit-repeats half regresses SILENTLY (exit 0, shifted snapshots) — exactly the silent-degradation class the repo bans, and CI selects no oracle-bearing scenario so it can never catch it. (3) Regression pins exist: RunValidatorArgs.vitest.ts was added by fix PR #5185 ("add no-build mode for run validation") as that fix's regression test, and TuiValidatorArgs by fix 26908c3cd2 ("add tui validator help"); both fixed code paths still exist, which the charter says refutes. (4) The script's own comment (validate-tui.mjs:3512-3514) says the unknown-option guard exists because citty is "intentionally lenient" and typos must "fail loudly, not silently fall through" — the finding never defeats that stated purpose before deleting its only automated check. (5) The "observed immediately at a developer terminal" fallback owner is documented-unreliable in this repo: the recorded validate-tui local baseline is that many scenarios fail locally on clean main, so a new local failure is plausibly dismissed as baseline noise, while these vitest suites run in CI on every PR and are the reliable guard. The finding's own hedge (keep TuiValidatorArgs, delete only RunValidatorArgs) concedes the weak half, but RunValidatorArgs is precisely the #5185 regression pin. A trimmed variant — deleting only the tests CI provably duplicates (e.g. separator transparency for the CI shape) — could be re-proposed, but that is a different, much smaller finding (~-40 LoC), not this one.

  </details>

- **StatusBar's key-hint priority ladder: ~24 exact-bindings width-point tests collapse into one table** (`tests-cli`)

  <details><summary>Why it was refuted</summary>

  Cost wrong (rule 6), and by the finding's own drop criterion. Recomputed against HEAD: (a) Of the 24 exact `bindings).toBe` assertions, only ~19 live in bindings-only tests portable to a single-string it.each row. At least 5 sit in tests that also assert left segments (lines 831-845, 941-992, 1299-1315, 1477-1494, 1637-1650) — exactly the "unique secondary assertions" the finding said would sink it — and the ~10 toContain/not.toContain tests cannot join a one-string table without tightening presence/absence pins into exact strings, which changes what is pinned (over-pinning a churning seam, against AGENTS.md testing discipline). (b) The portable subset totals ~250 lines, not 450. (c) Per-test savings are only the wrapper boilerplate (~4-5 lines each: `const display = buildStatusBarDisplay(statusInput({...}))` scaffolding and the expect call); the input-override objects and expected strings survive verbatim as row fields, and prettier expands the nested shortcuts objects in a cases array just as it does in the tests. 19 tests x ~4-5 lines minus ~5 lines of it.each harness = roughly -80 to -110, not -300. (d) The one concrete pruning claim is factually wrong: lines 362 and 369 do NOT pin the same rule — 362 (width 10, parentNavigationAvailable absent) pins 'no Esc parent binding without a parent'; 369 (width 9, parentNavigationAvailable: true) pins 'drop Esc parent when it cannot fit'. Their test names say exactly this ('omits Esc parent at the same bounded width without a parent' vs 'falls back to Ctrl-C when a tiny terminal cannot fit Esc parent'). The other widths (9,10,12,13,15,27,31,40,42,44,50,52,55,60,68,70,80) each sit at a distinct ladder rung, so the prune contribution is ~zero. The finding itself set the bar: 'the table stops paying for itself below roughly -150 net; drop the finding rather than force a two-assertion table.' Honest net is ~-100, below that line, and part of the shortfall comes from precisely the secondary-assertion condition it named. Not a duplicate (rounds123-index: 0 statusbar hits; round3-doc StatusBar mentions concern usage-map/contextState, different code), and no ruling forbids it — AGENTS.md explicitly endorses test.each collapse — so an opportunistic conversion during other StatusBar work is fine, but as a standalone -300 consolidation finding it is refuted.

  </details>

- **Delete ChildRunDelivery.vitest.ts: a mock round-trip suite over a 29-line adapter and a 37-line try/catch wrapper** (`tests-tools`)

  <details><summary>Why it was refuted</summary>

  One of the four dropped behaviors has no verified owner, and the finding's named owner for it is factually wrong. The coverage-handoff claims NativeSubagentProductionPath.vitest.ts:568-630 covers "deliverChildRunFollowUp ... admission-refusal mapping" and "asserts delivered-then-suppressed outcomes". Verified false: the two real-adapter calls at lines 594 and 613 never assert the function's return value, and the replayed delivery is suppressed as a duplicate — submitFollowUp returns {status:'sent'} (ToolUseFollowUp.ts:137), which the adapter maps to {kind:'delivered'}. The status:'failed' branch (childRunDelivery.ts:23-25, reason passthrough for 'finished'/'not_resumable') is never reached by any surviving test using the real adapter — a repo-wide grep shows NativeSubagentProductionPath is the ONLY suite that imports the real function; ChildRunLoop.vitest.ts, NativeSubagentStrategy.vitest.ts, and DelegationTools.vitest.ts all mock it, pinning only the consumer side of the seam. This is not mere call-shape churn: the consumer (childRunLoop.ts submitPendingDelivery, line 733) turns {kind:'failed', reason} into the mandated loud warn "Turn result not delivered: parent stream is unavailable (reason)". If the adapter regresses to report a failed submission as delivered, a lost child-result delivery becomes silent — the exact defect class CLAUDE.md's "Silent degradation is a defect" rule targets — and after this deletion no test would fail. Salvage is cheap and would survive re-review: delete the three tests whose owners verified (persist success, persist failure, delivered mapping) and keep only the 'carries the refusal reason' case (~-80 LoC), or better, add one real-admission-boundary case in NativeSubagentProductionPath that delivers to a finished parent stream and asserts {kind:'failed', reason:'finished'}, then delete the whole file.

  </details>

- **CodexResumeFallback: drop the detached run-loop rejection case — it re-pins the identical shared agentCliShared catch the Claude suite owns** (`tests-tools`)

  <details><summary>Why it was refuted</summary>

  Kill criterion 3 (what the code says it is for), and the finding's own escape hatch triggers it. The target file's header comment, CodexResumeFallback.vitest.ts:1-5, says explicitly: "The detached-rejection case is also the only place the fresh `startThread` launch branch is exercised." That comment was added by the very cut the finding cites as precedent — PR #11436 ("drop duplicated Codex resume tests"), confirmed via `git log -S "only place the fresh"` — meaning the round that deleted the four duplicated cases deliberately kept this one and recorded why, in the file itself. The finding's "What we give up" section concedes: "If round 2's verifier kept this case specifically for the fresh-launch wiring, that reasoning is not recorded in the index; an implementer who finds a comment or PR note to that effect should drop this finding." Both a comment AND a PR note to that effect exist. The finding never defeats the recorded rationale, it only wagers it doesn't exist. On the substance the rationale holds: the surviving concurrency case (:190) enters CodexTool through `resumeThread('stale-thread')`, never `startThread` — deleting :156-189 leaves the fresh-launch branch (no thread_id, `startThread` returning `id: undefined`) with zero coverage anywhere, and the Claude suite's twin (ClaudeAgentResumeFallback.vitest.ts:261) covers only the shared agentCliShared catch, not Codex's startThread wiring. The coverage-handoff claim that the concurrency case retains "CodexTool launch reaching runAgentCliSessionLoop" via "the same loop entry" is factually wrong about which entry branch is exercised.

  </details>

- **Delete MainViewMessageHandler.vitest.ts: 19 vi.mock, every collaborator stubbed, pins only webview-message→VS Code-command plumbing** (`tests-rest`)

  <details><summary>Why it was refuted</summary>

  REFUTED on three independent grounds. (1) A recent, deliberate coverage decision protects exactly this behavior set and the finding never engages it: the suite was purpose-built by #8839 (2026-07-18, five weeks before this finding) when MainViewInteractionController was inlined into MainViewMessageHandler — the commit trail is explicit ("test(main-view): cover interaction mappings", "test(main-view): cover remaining interaction branches"; 187 controller-suite lines deleted, 299 handler-suite lines written to replace them). The coverage survived one deletion refactor because an author chose to port it, and was then groomed (not deleted) again by closed #10986, which removed one stale mock from this very file. AGENTS.md's only test-deletion clause reads "When code or a historical format is retired, delete tests and fixtures that exist only for that retired behavior" — MainViewMessageHandler.ts is live production code, so the repo's own testing-discipline ruling does not sanction this deletion; it sanctions not ADDING tests at churning seams. (2) The coverage handoff is factually overstated. The claim "MainViewActions.vitest.ts and MainViewLaunchTarget.vitest.ts assert the exact posted MAIN_VIEW_COMMANDS payloads" is true only for the file-operation subset (PACK_SINGLE, CLEAN_MULTIPLE, LATEXDIFF*, MERGE, COMPARE) and inbound SET_* handling; neither suite touches SWITCH_VIEW, OPEN_AGENT_SETTINGS, OPEN_AGENT_DIRECTORY, OPEN_SET_PROVIDER_API_KEY, OPEN_PROVIDER_API_KEY_URL, OPEN_INSTALL_GUIDE, RECHECK_DEPENDENCIES, or the DISMISS_* messages — the eight behaviors the deleted suite actually pins. Grep of src/test-kernel for those command ids returns only this suite, desktop suites, and MainViewStartupController.vitest.ts. (3) Two dropped behaviors sit on durable boundaries with no surviving owner. First, the message vocabulary is a cross-host contract, not "two components that ship together": the shared frontend (commonSlice.ts, bannerSlice.ts, MainApp.ts) produces SWITCH_VIEW/RECHECK_DEPENDENCIES/etc. for TWO consumers, and the desktop consumer keeps its routing pins (ElectronMainViewIpc.vitest.ts:448 "routes SWITCH_VIEW to the launcher", DesktopIpcAdapters.vitest.ts:179,297) while this deletion would leave the extension consumer's half of the same contract wholly unpinned — asymmetric coverage on a vocabulary that exists precisely because two hosts must agree. Second, the dismissed-banner test pins WRITES to persisted state keys (GlobalStateKey.LOGIN_BANNER_DISMISSED / ORCHESTRATOR_BANNER_DISMISSED); the read side is pinned by MainViewStartupController.vitest.ts:62,102 (a suite the finding never names), so deleting the write pin breaks the only end-to-end guard on a persisted round trip — a key-swap bug typecheck cannot catch would silently resurface dismissed banners. Persisted formats keep their coverage.

  </details>

## 5. Acceptance criteria

- `npm run typecheck`, `npm run lint`, `npm run format`, affected suites, and `npm run check:dead-code-ratchet` clean per PR.
- Where a deleted export had a baseline row, `config/ratchets/knip-baseline.json` shrinks in the same PR. Never add a row.
- **Every deleted test must have its coverage handoff verified by running the named surviving suite**, not merely by reading it.
- The full suite must pass with the same number of _failures_ (zero), and the drop in test count must match the finding.
