---
created: 2026-10-01
status: proposed
---

# Codemode everywhere: every tool call goes through one script tool

Baseline: `main` at `35909133bd`. Line references point into that tree.

## Summary

The model gets one tool, `script`. Its argument is a JavaScript program that
calls TeXRA's tools as `await tools.read_file({ path })`. Every nested call is
an ordinary tool call: it passes the core approval policy, it is written to
the run ledger, and its card nests under the script's card. When a run resumes,
the script runs again from the top. Calls that finished are replayed from the
ledger in the order they settled. A call that was still in flight follows the
`replay: 'safe' | 'unsafe'` rule that direct calls already follow.

The engine is the QuickJS sandbox the workflow-script tool already ships
(`src/agent/workflowScript/sandbox.ts`), moved onto a worker thread behind an
Effect service. Routing every call through it lets four things go:

- the `delegate_multi_agents` tool;
- its `yield*` generator protocol;
- its separate content-keyed checkpoint journal;
- its five workflow row kinds.

`agent()` becomes an ordinary tool, so a workflow script is just a script.

Rollout has two stages:

1. **"on":** the script tool sits beside the direct tools.
2. **"only":** the script tool is all the model sees. The switch to "only"
   happens once the nightly live journeys show it is no worse.

The owner ruled on the open questions on 2026-10-01 (see "Owner rulings").
Two rulings shape the order of work:

- **Parity before deletion.** `delegate_multi_agents` is deleted in the same
  change set as the script tool that covers everything it does, or after it.
  There is no window in which the capability is missing. "Parity inventory"
  lists every capability and where it lands.
- **The freeze waits.** The 1.0 storage freeze and tag move after parity and
  the deletion, so the five `workflow.*` row kinds are never released.

Measured on the real tool definitions:

| Agent                            | Tools | Today (JSON schemas) | Script tool, all declarations inline |
| -------------------------------- | ----: | -------------------: | -----------------------------------: |
| Default `assistant`              |    41 |        13,885 tokens |                        ~2,400 tokens |
| `orchestrator`                   |    20 |        10,133 tokens |                                    — |
| Every built-in tool, all plugins |    52 |        18,182 tokens |                        ~2,850 tokens |

Today's figures are per request (method below). The script-tool figure for
`assistant` assumes typed declarations for all 41 tools.

The larger win is the prompt cache. System text is frozen per run today, but
the tool list is not, so any change to the tool list invalidates the cached
prefix from the tools onward. Under "only", the wire carries one tool whose
text is frozen with the system text. That makes the whole tools block a
constant for the run.

The owner also asked what else gets cleaner, and how agents coordinate:

- "What code mode retires" lists the older tools and machinery code mode
  makes redundant beyond `delegate_multi_agents`. Three items are real
  deletions: `delegate_agent` and `delegate_workflow` become `agent`, the
  per-step rewriting of delegation descriptions goes, and two stored-flag
  fields become one effect class. It also records the candidates the code
  refutes, among them a mount table putting `memory` and `executions` under
  the file tools.
- "How agents talk to each other" keeps the shipped messaging primitive and
  gives scripts a small set of calls over it.
- "Adapting the agents" lists what changes in the built-in agents, their
  prompts and the skill.

## What gets deleted

### In the parity change set (lane 9)

The workflow-script tool and its protocol go entirely, in the lane that
merges only once every row of "Parity inventory" is delivered. Where a file
below has a successor, the successor is named in the inventory, not here.
Line counts come from `wc -l` at the baseline.

**Engine, `src/agent/workflowScript/`**

- `interpreter.ts` (214): the `Branch`/`All`/`Attempt`/`Retry`/`Timeout`
  operations as Effect combinators (`interpreter.ts:131-187`). JavaScript's
  own `try/catch`, `Promise.all`, `Promise.allSettled` and loops replace
  them.
- The generator half of `sandbox.ts`: the `WorkflowOperation` wire schema,
  `PROTOCOL_PRELUDE`, `step`, and the generator table (`sandbox.ts:62-379`
  and `:432-557`). The realm setup, the limits, and `evaluate` stay
  (`:40-60`, `:381-430`, `:560-618`).
- `runWorkflowScript.ts` (860): the content-keyed journal, `journalKey`
  (`:51-67`), and the call cap and budgets (`:73-74`, `:171-217`).
- `checkpoint.ts` (482): the `workflow-checkpoint` aggregate, its
  per-checkpoint lane, and its cross-process claim (`checkpoint.ts:66-77`,
  `:336-340`).
- `parseScript.ts` (195): `export const meta` parsing and the `await`
  diagnostic (`parseScript.ts:82-84`).
- `types.ts` (461), `workflowRunState.ts` (448), and `README.md` (321).
  The README is stale in places anyway: it describes an "execution-KV
  version-4 record" that no longer exists, and it gives a cap of 200 calls
  where the code uses 1000 (`runWorkflowScript.ts:74`).

**Tool layer, `src/tools/delegation/`**

- `WorkflowScriptTool.ts` (671), `workflowScriptRun.ts` (284) and
  `workflowScriptStrategy.ts` (422).
- `workflowScriptAgentRunner.ts` (860). Its child launch and recovery move
  into the `agent` tool (see "Resume and replay"). Its plan, card and journal
  code is deleted.
- `src/tools/executions/workflowSummaryView.ts` (143).

**Runtime and session**

- `src/agent/runtime/workflowControlRegistry.ts` (51).
- The `workflow.control` request: `src/shared/session/runtimeRequest.ts:87-92`
  and `src/controllers/session/SessionRequests.ts:488-498`. It is replaced by
  `call.control` (inventory, "Skip and retry").
- The control hooks in `SessionHandle.ts` (`:96`, `:302`, `:354`).
- The interrupted-card write at close (`sessionLayer.ts:838`).
- The run-model branches in `sessionFold.ts` (`:676-677`, `:705-728`, `:799`,
  `:855`).
- The `workflow.call` and `workflow.plan` arms of `transcriptFold.ts`
  (`:186-223`).

**Shared schemas and copy**

- `src/shared/runs/workflowRunModel.ts` (576).
- `src/shared/schemas/workflowCallProgress.ts` (325),
  `workflowScriptDelivery.ts` (27) and `workflowScriptFiles.ts` (16).
- `src/ui/copy/workflowScriptProposal.ts` (30). Most of `src/ui/copy/workflowCall.ts` (197) goes too; the
  phase heading that `workflowPlainOutput.ts:13` uses moves to that caller.
- The workflow-script branches of the shared proposal schema
  (`src/shared/schemas/prompts.ts:89-101`).
- The `multiAgentWorkflow` run identity (`runIdentity.ts:27`, `:48`;
  `icons.ts:97`; `executionFormatters.ts:64`; `RunTab.ts:85`). A background
  script run takes the `script` identity in its place (inventory,
  "Background run").
- `WORKFLOW_TASK` (`log.ts:28`).

**Row kinds** (see "Storage and the freeze")

- `workflow.plan`, `workflow.call`, `workflow.script`, `workflow.journal`,
  `workflow.attempt` (`rowVersions.ts:67-68`, `:88-90`).
- The `workflow-checkpoint` aggregate kind (`sessionEvent.ts:111`).
- `run.start.checkpointId` (`sessionEvent.ts:273`).

**Plugin toggle and registry**

- The `workflow-script` plugin's `delegate_multi_agents` row
  (`pluginManifest.ts:239-252`; `registry.ts:90`, `:182`). The plugin itself
  stays and contributes `agent` instead (see "Fit with the plugin model").

**Renderers**

- Extension and desktop: `WorkflowRunBoard.ts` (722) and its styles (309);
  the script branch of `WorkflowRunContent.ts`; the workflow branches of
  `ProposalRequestPanel.ts` (`:36-39`, `:98-100`, `:146`, `:183-184`,
  `:214-272`); the desktop scene `design-harness/scenes/runBoard.ts` (48).
- CLI: `WorkflowPopup.tsx` (509) and `WorkflowPopupRows.tsx` (111); the
  workflow branches of `AgentProposal.tsx` (`:17-19`, `:102-128`,
  `:206-211`) and `approvalSummaries.ts` (`:14-16`, `:130-160`); most of
  `workflowPlainOutput.ts` (134).
- The board, the popup and the proposal branches are replaced, not dropped:
  lane 6 renders a script stage with the same rows, tabs and controls from
  generic cards (inventory, "Board").
- Kept: the CLI files that serve YAML round-mode workflow agents
  (`WorkflowRunDetails.tsx`, `commands/workflow.ts`,
  `runtime/workflowOutput.ts`).

**Docs and skills**

- `resources/plugins/workflow-script/skills/multi-agent-orchestration/`
  (250). Its fan-out patterns move into the script tool's skill.
- `docs/guide/multi-agent-workflows.md` (142), rewritten for scripts.
- The evidence prototype `.agents/docs/evidence/2026-09-25-workflow-generator-protocol/`
  (1,060).
- The `delegate_multi_agents` lines in `orchestrator.yaml`, `engineer.yaml`,
  `leanOrchestrator.yaml` and `tool_catalog.md`.

**Tests**

The dedicated suites go with their code, about 8,400 lines:

- `WorkflowScriptEngine` (2,785)
- `WorkflowScriptAgentRunner` (1,787)
- `WorkflowScriptProgressBridge` (998)
- `WorkflowScriptCost` (282)
- `WorkflowScriptTool` (1,079)
- `WorkflowScriptStrategy` (782)
- `WorkflowRunModel` (465)
- `WorkflowPopup` (187)

`WorkflowScriptSandboxBundle` (88) is kept and retargeted at the worker
entry.

Not deleted: the shared proposal flow (`proposalFlow.ts`), stages
(`stage.start`/`stage.end` are generic: `TraceEmitter.ts:106-118`), and
`attemptFold.ts` (used by `child.turn`).

### When "only" becomes the default

Less goes here than the lead proposal expected. The per-call executor
(`toolUseDispatch.ts:391-571`: hooks, guard, approval, settle) is not a
"direct path". Nested calls run through it too, so it stays.

What is specific to a model response is this:

- per-response partitioning by `parallelSafe` (`run/tools.ts:82-124`);
- duplicate detection (`partitionDuplicateCalls` in `toolCallParsing`,
  `deriveDuplicate`, and the `duplicateOf` and `partition` dispatch facts at
  `runLedgerEvent.ts:103-122`);
- the per-tool wire schemas (`toolDefinitionsFor`, `run/tools.ts:27-37`).

These can go only once no model runs in direct mode. As long as the per-model
fallback exists, they stay. Retiring the fallback is a later, separate
decision (Q3). "What code mode retires", items 5 to 8, gives their line
counts and what stays even then.

## What code mode retires

"What gets deleted" covers `delegate_multi_agents`. This section covers
everything else that code mode makes redundant, plus the candidates the code
refutes. Every item was checked on the baseline. Line counts come from
`wc -l`, or from the cited line range where only part of a file goes.
No entry in `config/ratchets/refuted-candidates.json` covers any of these
items. The nearest is `SCOPE-external-roots-standalone-service`, which
item 4 touches.

"Freeze" says whether the item changes a stored row shape and so must land
before the 1.0 freeze ("before"), or changes only code and tool text and can
land on either side ("either"). "After Q3" means the item can go only once
no model runs in direct mode, which is the later decision Q3 left open.

| #   | Item                                                                                               | Replaced by                                                                                                      | Lines deleted                                                                      | Lane  | Freeze                                       |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----- | -------------------------------------------- |
| 1   | `delegate_agent` and `delegate_workflow`                                                           | `agent`, with a `background` option                                                                              | `DelegationTools.ts` (237); net about −200 once the launch code moves into `agent` | 4, 12 | either; ship before 1.0 so 1.0 has one tool  |
| 2   | Per-step rewriting of delegation descriptions                                                      | text frozen with the system text; `describeTool('agent')` returns the live lists; `contextUpdate` names a change | about 250                                                                          | 13    | either; can land now, in direct mode too     |
| 3   | Action-switch tools rendered as one flattened object                                               | one typed function per branch, as a namespace                                                                    | none now; the two provider preprocess shims (46) after Q3                          | 7     | either                                       |
| 4   | Memory and executions views as their own path readers                                              | **Refuted.** No mount table; both stay their own tools, rendered as namespaces                                   | —                                                                                  | —     | —                                            |
| 5   | Duplicate-call detection                                                                           | the script's own code                                                                                            | about 110 after Q3                                                                 | —     | stored fields reach 1.0; see below           |
| 6   | Per-response partitioning and argument parsing                                                     | issue order inside the script                                                                                    | about 70 after Q3                                                                  | —     | stored field reaches 1.0; see below          |
| 7   | `.nullish()` on tool inputs                                                                        | nothing: it stays while any schema reaches a provider                                                            | none                                                                               | —     | —                                            |
| 8   | `flattenTopLevelUnion`, run-tool overlays, `injectTools`, `injectInstalled`, `tool_catalog.md`     | **Refuted.** Still needed (below)                                                                                | —                                                                                  | —     | —                                            |
| 9   | Tool families as namespaces (zotero, lean, arXiv and Crossref, web, setup)                         | a nicer surface only                                                                                             | none                                                                               | 7     | either                                       |
| 10  | `parallelSafe` and `replay`, two flags on every tool                                               | one effect class, `effect` (Q10)                                                                                 | small; one flag fewer on 21 declarations                                           | 13    | **before**: `DispatchFacts.replay` is stored |
| 11  | History-query phase 2: `query()` as a workflow operation, a journal discriminant and a format bump | a nested `executions.query` call, replayed from its `tool.result`                                                | never built                                                                        | —     | —                                            |
| 12  | Silent drop of a declared tool that no longer exists                                               | a run that names an unknown built-in tool refuses to start, naming the tool and the agent file                   | none; it adds a refusal                                                            | 12    | either                                       |
| 13  | `executions send` mints a random follow-up id, so a re-run send duplicates                         | the id is derived from the call's `callId`; admission's replay check makes the send idempotent                   | none                                                                               | 3     | either                                       |

### 1. Three delegation tools become one `agent`

- **Evidence.**
  - `delegate_agent` is `DelegationTools.ts:143-158` and `delegate_workflow`
    is `inputFields.ts:65-106`. Both open a proposal through
    `proposeAndExecute` (`DelegationTools.ts:106`, `:208`).
  - Both are detached by default. They return a run id, and the result
    arrives as a follow-up (`subagentRun.ts:157-255`). In a one-shot parent
    (`toolPolicy.stopAfterCycle`) they switch to in-band and return the
    result as the tool result (`subagentRun.ts:123-155`).
  - What differs is the agent category and a few category-only fields:
    - `delegate_workflow` has `inputFiles` (required), `contextFiles`,
      `mediaFiles`, `outputFiles` (a subset of the inputs),
      `extractFigures` and `extractTikz` (`inputFields.ts:78-104`).
    - `delegate_agent` has `working_directory`, gated on the worktree
      setting (`inputFields.ts:122-143`), and the hand-off wrapper that
      tells the child its final answer is delivered verbatim
      (`inputFields.ts:144-166`).
    - Both take `memories`.
  - The script `agent()` already routes by category: a structured call needs
    a tool-use agent, and file options need a workflow agent
    (`workflowScript/types.ts:195-213`; `requireWorkflowOrToolUseAgent`,
    `proposalFlow.ts:90-111`).
- **Replaced by.** One `agent` tool whose options are the union of the
  three. The category comes from the named agent, as it does today, and an
  option that does not fit the category is a validation error.
  - In a script, `agent` awaits the child (in-band), which is what
    `delegate_multi_agents` does.
  - Called directly (stage "on" and the per-model fallback), `agent` keeps
    today's default: it detaches and returns the run id, and the result
    arrives as a follow-up.
  - In a script, `background: true` gives the direct form: the call returns
    `{ runId }` at once and the report comes as a follow-up at the next turn
    boundary.
  - A one-shot parent still gets the in-band form automatically.
- **What stays.**
  - The proposal flow (`proposalFlow.ts`, 345) and child approval
    inheritance (`configureDelegatedChildApprovals`). They are already
    shared by the three tools.
  - `selectAvailableDelegationModel` and `requireVisibleAgent` with the
    delegation scope.
  - `subagentRun.ts`, `inBandSubagentRun.ts`, `detachedChildRun.ts` and
    `childRun.ts`.
- **Not folded in: `claude_code` and `codex`.** They are not registry
  agents, so `requireVisibleAgent` would refuse them. They continue vendor
  sessions by `session_id` and `thread_id`, take vendor permission and
  sandbox modes, have no in-band form, and ask through a bash-style guard
  instead of a proposal (`claudeAgent.ts:107-146`, `:555-571`;
  `codex.ts:111-126`, `:483-504`). Folding them into `agent` would need a
  special-case arm for each. They stay separate tools.
- **Risk.**
  - Seven call sites classify agents by the delegation tool names through
    `hasDelegationTool` (`shared/constants/delegationTools.ts:16-57`):
    `agentRegistry.ts:418` (`isOrchestrator`), `TeamPlan.ts:113` and `:297`,
    `SettingsAgentCatalogController.ts:75`, `agentToolResolution.ts:123`,
    `validationModel.ts` and `AgentLaunchContext.ts:270-271`.
  - If the name set is not updated in the same change, those sites stop
    recognizing orchestrators, silently. Lane 12 changes the set to
    `{agent}` in the same change.
  - The memory prompt section picks its orchestrator variant from the same
    check (`memoryPromptSection.ts:33`).
- **Lane.** 4 builds `agent` with the merged options, and 12 deletes the two
  tools and adapts the agents.
- **Freeze.** The proposal payload is keyed by `agentCategory`, not by tool
  name (`prompts.ts:97-116`), and a delegated child's identity is
  `{ kind: 'agent' }` (`runIdentity.ts:15-28`). Removing a tool name changes
  no stored shape. It can land after 1.0, but shipping 1.0 with one
  delegation tool keeps the frozen agents and docs simple.

### 2. Live description rewriting

- **Evidence.**
  - `resolveStepTools` runs at every step. When a delegation tool is
    offered, it probes model availability
    (`agentToolResolution.ts:110-144`) and rewrites each delegation tool's
    description (`:335-355`).
  - The rewrite is `annotateDelegationAvailability`
    (`delegationAvailability.ts:294-327`). It replaces or appends three
    blocks, each found by a regular expression:
    - "Available agents:" (`:90-137`)
    - "Available models:" (`:170-197`)
    - "Git worktree support:" (`:259-292`)
  - Only the three tools in `DELEGATION_TOOLS` get this treatment
    (`delegationTools.ts:16-34`).
  - With all built-ins visible, the tool-use agent block is about 930 tokens
    and the workflow block about 660 (chars/4). The workflow block appears
    twice when `delegate_multi_agents` is also offered.
- **Cost.**
  - The text is recomputed every step but changes only when the visible
    agents, model availability or credentials, or the worktree setting
    change.
  - When it does change, the identity digest stays the same, because
    descriptions are stripped (`catalogEntries.ts:62-73`). The `shown`
    digest changes, though, so the step writes a new `tools.offered` row and
    `context.blob` rows (`step.ts:27-29`, `:345-400`).
  - The request then carries a different `tools` array, so the cached
    prefix breaks from the tools onward.
  - Adding an API key mid-session is enough to trigger all of this.
- **Replaced by.**
  - The availability text is rendered once, with the system text, at the
    step that freezes it (see "Prompt and cache").
  - A later change reaches the model as one `contextUpdate` line, for
    example "Agents now available for delegation: …; models: …". That
    message is append-only.
  - `describeTool('agent')` returns the declaration together with the
    current lists, and it is recorded as a discovery call, so it replays
    exactly.
  - A stale list cannot cause a wrong launch: `requireVisibleAgent` and
    `selectAvailableDelegationModel` already refuse at call time, with a
    worded error (`proposalFlow.ts:73-87`; `delegationAvailability.ts:199-252`).
- **Deleted.**
  - The three regular expressions and their block formatters
    (`delegationAvailability.ts:63-137`, `:170-197`, `:259-327`, about
    185 lines).
  - The per-step probe and annotation in `agentToolResolution.ts`
    (`:110-144`, `:335-355`, about 55 lines).
  - About 250 lines in all. `readDelegationAnnotationState` moves to the
    freeze point and is not deleted.
- **Risk.** A model that never calls `describeTool` acts on the list it saw
  at the freeze plus the `contextUpdate` lines. That is the same information
  it has today, delivered without rewriting the prefix.
- **Lane and freeze.** Lane 13 does this. It needs no script tool, so it can
  land now, for direct mode too. No stored shape changes.

### 3. Action-switch tools become namespaces

Eight built-in tools take a discriminated union as input. All of them are
`z.discriminatedUnion`; no tool uses a plain `z.union` of objects.

| Tool                  | Key       | Branches                                                      | Evidence                                  |
| --------------------- | --------- | ------------------------------------------------------------- | ----------------------------------------- |
| `executions`          | `action`  | view, wait, kill, send, query                                 | `executions/toolInput.ts:149-177` (179)   |
| `memory`              | `command` | view, create, str_replace, insert, delete, rename, pin, unpin | `memory/MemoryTool.ts:72-136` (633)       |
| `plan`                | `command` | update, pause, complete                                       | `plan/PlanTool.ts:62-91` (428)            |
| `diagnostics`         | `command` | list, count, add                                              | `DiagnosticsTool.ts:42-84` (226)          |
| `crossref_search`     | `command` | search, doi                                                   | `citation/CrossrefSearchTool.ts:50-66`    |
| `inquiry`             | `command` | ask, read, list                                               | `inquiry/ExternalInquiryTool.ts:48-120`   |
| `inline_comment`      | `command` | add, reply, resolve, unresolve, list                          | `comment/InlineCommentTool.ts:93-152`     |
| `github_subscription` | `command` | subscribe, unsubscribe, list, find_current                    | `github/githubSubscriptionTool.ts:77-119` |

The four `lean_*` tools in `lean/LspTools.ts` carry a `command` or `type`
enum on a single object. They are not unions, and they stay plain
functions.

- **The rule.** A tool whose input schema is a top-level
  `z.discriminatedUnion` is declared in the script surface as a namespace,
  with one typed function per branch: `tools.memory.pin({ path })`,
  `tools.executions.wait({ path, ids })`. The function's name is the
  branch's literal, and its argument type is the branch minus the
  discriminator.
- **The call is the same call.** `tools.memory.pin({ path })` dispatches as
  `memory` with `{ command: 'pin', path }`. The `script.call` row, the
  tool's identity and the approval are unchanged. The namespace is
  rendering, plus one line of dispatch that puts the discriminator back.
- **What the renderer reads from the schema.**
  - The discriminator key and the branch objects (`.def.discriminator`,
    `.options`, each branch's `.shape`).
  - Each branch literal's `.describe()`. Executions, Crossref, diagnostics,
    inquiry, `inline_comment` and `github_subscription` keep each action's
    documentation there.
  - The input type, not the output type. Defaults and transforms
    (`nullishWithDefault`, the `wait` timeout clamp,
    `toolInput.ts:89-98`) must render as optional inputs. Zod's
    `toJSONSchema` with `io: 'input'` already does this
    (`toolJsonSchema.ts:4-8`).
  - The refinements stay prose. `memory.insert` and `inline_comment.add`
    each carry a cross-field `.refine` that no TypeScript type expresses.
    The function's doc comment states it, and Zod still enforces it.
  - A branch that is the default when the key is omitted is rendered as a
    plain function too. Only `executions` has one: `view`
    (`toolInput.ts:46-50`).
- **The `z.preprocess` wrapper does not block it.**
  - `z.preprocess` builds a pipe whose `in` is a transform and whose `out`
    is the union (`zod/v4/classic/schemas.js:1389-1395`). The renderer
    unwraps a pipe whose `in` is a transform, as `toJSONSchema` already does
    with `io: 'input'` (`json-schema-processors.js:488-495`).
  - The wrapper itself is a provider shim. It turns `action: null` into an
    omitted key (`toolInput.ts:157-177`). A script never sends `null` for an
    omitted key, but the wrapper does no harm and stays while any model
    calls directly.
- **What it deletes.** Nothing in the tool code while the fallback exists.
  After Q3, two provider shims can go:
  - the executions preprocess (`toolInput.ts:157-177`, 21 lines) and the
    `.optional().default('view')` constraint whose comment explains it
    (`:28-45`);
  - the `read_file` range preprocess (`ReadTool.ts:33-57`, 25 lines), which
    turns DeepSeek's `[start, end]` into `{ start, end }`.
- **Risk.** A namespace renders one declaration per branch where the
  flattened JSON schema rendered one object. Lane 7 measures the token
  difference for `executions` and `memory` before choosing it as the
  default. The fallback to a single function taking the union is the same
  declaration the flattener produces today.
- **The name stays `executions`.** A rename to `runs` was suggested. The
  model addresses runs by `/executions/{id}`, the on-disk run store is
  `executions/` (`storageLayout.ts:4`), and the accepted history-query note
  names its views over it. A rename buys a shorter word for the cost of
  every prompt and path that names it. Not proposed.

### 4. Memory and executions under the file tools: refuted

The suggestion was to have `read_file`, `edit_file`, `glob` and `grep`
route `/memories/…` (read-write) and `/executions/…` (read-only) to their
owners through a small mount table, then delete memory's view, create,
str_replace, insert, delete and rename, and the path-view action of
executions. The code says no on every count.

- **The file tools have no virtual paths.**
  - `resolveToolPath` (`pathResolution.ts:104-193`) knows nothing of
    `/memories` or `/executions`.
  - With path protection on, which is the default
    (`stateSettings.ts:72`, `:1175-1176`), `/memories/x` fails as outside
    the workspace (`pathResolution.ts:172-179`).
  - Memory lives under the session's storage root, `~/.texra/v1/…/memories`
    (`nodeStorage.ts:6-15`; `workspaceStorage.ts:53-85`;
    `storageLayout.ts:3`). It is reached only through `StorageFs`
    (`rootedFs.ts:32-35`).
- **Approvals would change.**
  - `edit_file` and `write_file` are `requiresApproval: 'inBody'`. Each
    write opens a diff review unless a policy or bypass allows it
    (`EditTool.ts:104`; `toolEditApproval.ts:226-300`).
  - `memory` declares no approval (`MemoryTool.ts:623-633`).
  - Routing memory writes through `edit_file` would make every memory write
    ask. A run that cannot show a prompt is not offered an approval tool
    at all (`agentToolResolution.ts:246-250`), so headless runs would lose
    memory writes.
- **Memory's own rules would be bypassed.**
  - Every write prepends attribution frontmatter: `modifiedBy`, `runId`,
    `pinned` (`MemoryTool.ts:255-271`; `memoryMeta.ts:27-38`). `view`
    strips it, but `read_file` would show it, and `edit_file` would let the
    model forge it, `pinned: true` included, which bypasses the cap of 10
    (`memoryFileSystem.ts:418-443`).
  - All memory commands run under one lane per storage root, because delete
    and rename act on whole directories (`onMemoryTreeLane`,
    `memoryFileSystem.ts:105-124`). They write atomically (`:127-138`).
    `edit_file` takes a per-file lane and writes in place
    (`approvedWrite.ts:78-131`).
- **Edit records and hooks would start firing.** `edit_file` returns
  `edits`, which feed the edited-files card and the run's `files` result
  (`toolUseDispatch.ts:506-513`; `toolUse.ts:681`). It is also the hook name
  `Edit` (`hookConfig.ts:241-248`). A user's `Edit|Write` hook would start
  firing on memory notes.
- **Read-before-edit uses different keys.** Memory keys the tracker by the
  display path `/memories/x` (`MemoryTool.ts:278-282`). The file tools key
  by the resolved file-system path (`fileEditFlow.ts:152-157`). A mount
  would have to define one canonical key for each mount.
- **Executions is mostly computed views.** Of its eleven path views, two are
  plain file reads: `/executions/{id}/files/{path}` and
  `/executions/{id}/workspace-files/{path}`. The rest are folds, run
  records, a transcript projection or live state
  (`ExecutionsTool.ts:356-799`; `executions/pathCatalog.ts:7-58`). The
  accepted history-query note moves these questions to SQL views, not to
  files (`2026-09-26-executions-history-query.md`, "Finding").
- **Two users do not justify a mount table.** The repo rule is that a
  factory needs multiple callers. Here each of the two callers would bring
  its own write semantics, approval rule, key space and listing format. The
  table would be a dispatcher that branches back to two owners, and both
  owners stay.
- **Agents depend on today's split.** `orchestrator.yaml` offers
  `executions` but none of the file tools, and `progressCheck.yaml` offers
  `memory` without `edit_file`; its prompt forbids editing memory.
  `latexDiff.yaml:18` tells the model that `/executions/*` is a virtual
  namespace only `executions` can resolve.

**Recommendation.** Keep `memory` and `executions` as their own tools.
Under item 3 they become namespaces (`tools.memory.pin`,
`tools.executions.wait`), which gives the model the typed functions the
mount table aimed at, with no change in behaviour. The one real overlap,
`/executions/{id}/workspace-files/{path}`, reads a workspace file that
`read_file` can usually reach, but not when the run edited it in a worktree
outside the roots (`ExecutionsTool.ts:743-799`). It stays.

### 5. Duplicate-call detection

- **Evidence.**
  - `partitionDuplicateCalls` (`core/tools/toolCallParsing.ts:35-71`,
    37 lines) and `deriveDuplicate` (`toolUseDispatch.ts:774-806`,
    33 lines).
  - The stored facts: `DispatchFacts.duplicateOf` and its cross-check
    (`runLedgerEvent.ts:103-122`, `:253-261`), the settlement
    `disposition: 'duplicate'` (`:341-361`), and the fold
    (`runStateFold.ts:113`, `:719`).
  - The comment gives the reason: models "routinely emit identical calls in
    one batch" (`toolCallParsing.ts:20-24`). In a script, two identical
    calls are the script's choice.
- **Replaced by.** Nothing; a script runs what it says.
- **Lines.** About 110, schema and fold included, after Q3.
- **Freeze.** The fields are stored on `model.message` and `tool.result`.
  The fallback keeps them past 1.0 (Q3), so they will be frozen. Retiring
  them later leaves `duplicateOf` and the `duplicate` disposition readable
  for old rows. A pure removal needs no upcaster, but the reader stays.

### 6. Per-response partitioning and argument parsing

- **Evidence.**
  - `dispatchFactsFor` (`run/tools.ts:82-124`, 43 lines), called from
    `ModelInvoker.ts:462`. It assigns contiguous parallel-safe partitions.
  - The consumer groups by partition (`toolUseDispatch.ts:811-832`).
  - `parseCallArguments` and `localCallsOf` (`run/tools.ts:46-75`) parse
    provider argument strings.
- **Replaced by.** Issue order inside the script, under the semaphores
  "Approvals, cards and the ledger" describes.
- **Lines.** About 70 after Q3.
- **Freeze.** `DispatchFacts.partition` is stored. Same note as item 5.

### 7. `.nullish()` stays

There are 145 `.nullish()` sites in 35 files under `src/tools`, and 34 uses
of `nullishWithDefault` (`core/inputSchema.ts:20-25`). Nested calls in a
script are JavaScript objects, so `.optional()` would do for them. But three
schemas still reach a provider as JSON: the script tool's own,
`submit_output`'s, and every tool's under the per-model fallback. Converting
the sites would delete nothing and churn every tool. After Q3, a new tool
may use `.optional()`; existing ones stay. CLAUDE.md's rule changes only
then.

### 8. Refuted: still needed

- **`flattenTopLevelUnion`** (`run/toolSchema.ts:41-126`, 86 lines). It
  merges a top-level union into one object, because function-calling APIs
  reject a top-level `oneOf`. `submit_output` is converted through it
  (`structuredOutput.ts:160`), and an agent's output schema may be a union.
  It also feeds the identity digests (`catalogEntries.ts:62-73`). It stays
  in both modes.
- **Run-tool overlays, `injectTools`, `injectInstalled`**
  (`agentToolResolution.ts:81-108`, `:191-206`, `:356-394`). They decide
  which tools the step offers, its dispatch registry and the child
  narrowing. A script's `tools` object is built from that same offered set,
  so they stay.
- **`tool_catalog.md`** (`resources/docs/agent-creation/tool_catalog.md`,
  195). This is the hand-written catalog the `creator` agent reads when it
  writes an agent's `tools:` list (`creator.yaml:50`, `:66`). It needs
  every tool, not the offered set that `searchTools` sees. It stays and is
  rewritten in lane 8 (see "Adapting the agents").

### 9. Tool families: rendering only

| Family          | Tools                                                                                                     | Shared code today                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Zotero          | `zotero_collections` (222), `zotero_search` (207), `zotero_add` (394), `zotero_export` (84)               | `bbtClient.ts` (387), `withZoteroPort` used by all four                   |
| Lean            | `lean_diagnostics`, `lean_file`, `lean_project`, `lean_inspect` (`LspTools.ts`, 495); `lean_loogle` (286) | `leanTypes.ts`, `leanLanguageServices.ts`, `leanServerRegistry.ts`        |
| arXiv, Crossref | `arxiv_search` (172), `arxiv_metadata` (91), `download_arxiv_source` (132), `crossref_search` (185)       | `arxivShared.ts` (74), `citation/constants.ts` (34), `rateLimitedApiCall` |
| Web             | `web_search` (189), `web_fetch` (337)                                                                     | timeouts only                                                             |
| Setup           | 10 tools (`setup/`)                                                                                       | `platform.ts` (178), `toolProbing.ts` (83)                                |

Each family already shares its client. The per-tool code that remains is
the `defineTool` literal, and no schema block is copied between tools; the
one repeated field, Zotero's `library`, means a different thing in each of
its three tools. Grouping a family under one namespace would therefore
delete nothing. What it would give is a shorter discovery surface:
`searchTools(q, { namespace: 'zotero' })` and `describeTool('zotero')` (see
"Prompt and cache"). The namespace is the plugin id, which every tool already
carries in `tools.offered`. Lane 7 offers the grouping in discovery. The
call names stay `tools.zotero_search(...)`, so no agent or prompt changes.

### 10. One effect class instead of `parallelSafe` and `replay`

This came from the harness-direction survey (coauthor-fc). It needs an
owner ruling (Q10).

- **Evidence.**
  - `parallelSafe` means "side-effect-free and approval-free"
    (`ToolTypes.ts:54-68`). `replay: 'safe' | 'unsafe'` means "may run again
    on resume without asking" (`:70-79`).
  - Both are stored on every `model.message` call
    (`DispatchFacts.parallelSafe`, `.replay`, `runLedgerEvent.ts:107-111`),
    and `replayable()` reads the saved and current `replay` together
    (`run/tools.ts:139-165`).
  - The two flags overlap in the code: every one of the 12 `parallelSafe`
    tools also declares `replay: 'safe'`. Nine more declare `replay: 'safe'`
    without `parallelSafe`:
    - `lean_diagnostics`, `lean_inspect`;
    - `extract_bib_entries`, `extract_figures`;
    - `verify_setup`, `probe_environment`, `list_api_keys`, `read_config`;
    - `zotero_export`.
- **Proposal.** One declaration, `effect: 'read' | 'write' | 'external'`:
  - `read` means replay-safe and inside the script's read scope.
  - `write` means a barrier: replay asks, and the call is in the scope of
    the script's approval request.
  - `external` means an effect outside TeXRA (a message, a launch, a
    network write): replay asks, and the call keeps its own approval.
- **What the code supports.** `effect` can replace `replay` outright. All 21
  replay-safe tools are reads, with one exception: `zotero_export` writes a
  `.bib` file, idempotently. Under `effect` it becomes `write` and asks on
  resume. That is a small, visible change.
  `parallelSafe` cannot be derived from `read` yet: the other eight are
  reads that run serially today, and their declarations do not say why.
  Folding `parallelSafe` in needs each of the eight checked first.
- **Per branch.** A union tool can need a different effect per branch: in
  `executions`, `view`, `wait` and `query` are reads, `send` is external
  (and idempotent once item 13 lands), and `kill` is external. The
  declaration may therefore be a function of the input, as `guard.writes`
  already is (`ToolTypes.ts:22`).
- **Recommendation.** Replace `replay` with `effect` before the freeze, so
  the stored field has its final shape. Keep `parallelSafe` until the eight
  serial reads are checked; if they can run concurrently, derive it as
  `effect === 'read' && !requiresApproval` and delete the flag, which then
  leaves one declaration where there were two. `requiresApproval` and
  `guard` stay: they say who asks and about what, which `effect` does not.
- **Lane and freeze.** Lane 13. It is **before** the freeze:
  `DispatchFacts.replay` becomes `effect`.

### 11. History-query phase 2 is never built

The accepted history-query note plans `query()` as a sixth workflow
operation. Its journal entry gains `kind: 'agent' | 'query'`, the cost total
skips query entries, and `SESSION_EVENT_FORMAT` is bumped
(`2026-09-26-executions-history-query.md` §6). Under code mode, a script
calls `tools.executions.query({ path: '/executions', sql, params })`. The
call is an ordinary nested call, and its `tool.result` is replayed from the
ledger, so a resumed script sees the rows the first attempt saw. That was
phase 2's whole reason for journaling. Phase 2 is dropped from that note's
open list, and the journal it would have changed goes in lane 9.

### 12. An agent that names a deleted tool fails loudly

- **Today.** A declared name with no registration is a warning, not an
  error (`agentToolResolution.ts:311-322`). The warning is logged when the
  offered set changes (`step.ts:359-370`), and the run continues without
  the tool. The model is never told.
- **Why it matters here.** Lanes 9 and 12 delete `delegate_multi_agents`,
  `delegate_agent` and `delegate_workflow`. A user's customized copy that
  names one of them would lose delegation with only a log line, which
  CLAUDE.md calls a defect.
- **Proposal.** A declared name that is neither in the tool table nor an
  MCP name refuses the run at start. The worded error names the tool and
  the agent's file. A tool whose plugin is switched off is still withheld
  quietly, as today, because that is the user's own switch.
- **No migration reader.** 1.0 is a clean state, so nothing rewrites a
  user's YAML. The refusal plus the existing "newer built-in" notice (see
  "Adapting the agents") is the migration.
- **Lane and freeze.** Lane 12, either side of the freeze.

### 13. `send` becomes idempotent

`sendToRun` passes no `deliveryId`, so admission mints
`followUpId = randomUUID()` (`ToolUseFollowUpQueueManager.ts:422`;
`send.ts:75-88`). A send re-run after a crash (row committed, `tool.result`
not) would deliver a second copy. Today `executions` is `replay: 'unsafe'`,
so the call goes to the outcome-unknown question instead. In a script, a
message loop is a normal pattern, and asking after every crash is
needless. Deriving `deliveryId` from the call's `callId` (not the attempt,
so a re-run at `attempt + 1` reuses it) lets admission's
existing replay check drop the duplicate (`runRows.ts:338`). The send is
then idempotent and can be declared so (item 10). Lane 3.

## The script surface

One tool, `script`, takes:

```ts
{
  code?: string | null;          // exactly one of code and path
  path?: string | null;          // a saved script file
  title?: string | null;         // card, approval and run heading
  args?: JsonValue | null;       // the global `args`
  files?: WorkspaceFiles | null; // inputFiles, contextFiles, mediaFiles
  run_in_background?: boolean | null;
  timeoutMs?: number | null;     // wall clock, 1 s to 24 h
}
```

The code is the body of an async function: it may use `await` at the top
level, and `return` gives the result. Every field but `code` exists to carry a
capability of `delegate_multi_agents` (see "Parity inventory"). Eight globals
are available:

```ts
declare const tools: {
  /** Reads a file from the workspace */
  read_file(args: {
    path: string;
    offset?: number | null;
    limit?: number | null;
  }): Promise<ToolOutput>;
  /** Performs exact string replacements in workspace files using literal matching */
  edit_file(args: {
    path: string;
    old_str: string;
    new_str: string;
    replace_all?: boolean | null;
  }): Promise<ToolOutput>;
  // … one entry per tool the agent declares
};
declare function searchTools(
  query: string,
  opts?: { namespace?: string; limit?: number },
): Promise<ToolSummary[]>;
declare function describeTool(name: string): Promise<string>;
declare function agent(
  prompt: string,
  opts?: AgentOptions,
): Promise<AgentResult>;
declare function phase(title: string): void;
declare const args: unknown;
declare const files: WorkspaceFiles;
declare const console: { log(...values: unknown[]): void };

interface AgentOptions {
  agentName: string; // required: the old tool-level default agent is gone
  model?: string; // model reference, `@effort` suffix allowed
  schema?: JsonSchema; // structured call: tool-use agent, `.structured`
  inputFiles?: string[]; // workflow-agent call: editable files
  contextFiles?: string[];
  mediaFiles?: string[];
  id?: string; // disambiguates otherwise identical calls for reuse
  label?: string; // card title
  timeoutMs?: number; // stops the child at the deadline, rejects `TimedOut`
}
```

- **Result shape.** `ToolOutput` is `{ output, summary }` from an executed
  `ToolResult` (`toolResult.ts:121-134`). An error result
  (`toolResult.ts:136-146`) rejects with an `Error` named `ToolFailed`, so
  `try/catch` and `Promise.allSettled` work as they do in any JavaScript.
- **What stays on the host.** File attachments and edit records stay on the
  host and are attached to the script's own `tool.result`. A guest only ever
  sees JSON text, as today (`sandbox.ts:20-27`).
- **Turn-ending calls.** A nested result with `endTurn` ends the script and
  then the turn.
- **`agent()`.** `agent()` is the `agent` tool, called as `tools.agent`. It is
  the in-band subagent runner that workflow scripts use today, and it returns
  the same envelope (`README.md`, "`agent(prompt, opts?)`"). It is a
  top-level global only because it is the one call every fan-out script
  makes.
- **Progress.** Progress is the nested cards themselves. `phase(title)`
  names the group the following calls belong to; it is recorded on each
  `script.call` row, not as a stage of its own, so replay needs nothing
  extra. `console.log` writes transient text to the script's card
  (`hooks.onToolOutput` → `stream.chunk`, the path bash already uses:
  `toolUseDispatch.ts:413-424`), and the script's own `tool.result` carries
  the last 80 lines, as the run log does today.
- **Gone.** `export const meta`, `meta.tasks` and `meta.phases` are gone.
  Whether the declared plan needs a successor is Q6.
- **No recursion.** A script cannot call `script`.
- **Terminal tool.** `submit_output` (the structured-output terminal tool,
  `src/tools/structuredOutput.ts`) stays a direct tool in both modes. It ends
  the run as a protocol, not as work.

### Determinism under `await`

The lead asked whether determinism holds once ops are numbered in issue order
and `Promise.all` issues in a deterministic order. Numbering alone does not
make it hold.

Issue order is deterministic only if the guest sees the same sequence of
settlements:

- `Promise.all([a(), b()])` issues `a` and then `b` in the same synchronous
  job, so those two are numbered deterministically.
- But `a().then(() => tools.read_file(x))` and `b().then(() => tools.read_file(y))`
  issue their reads in whatever order `a` and `b` settle. Live, that order
  is completion order, which is not reproducible.

The fix is the one Temporal uses, and it costs nothing extra in TeXRA:

1. The host delivers settlements to the realm **one at a time, in ledger
   commit order**.
2. After each delivery it drains QuickJS's job queue
   (`runtime.executePendingJobs`, `quickjs-emscripten-core`
   `index.d.ts:310`) to quiescence. Only then does it read the newly issued
   ops.
3. A nested call's `tool.result` commits before its value reaches the realm,
   which is the rule the engine follows today (`README.md`, "Restart-safe
   checkpoints").
4. On replay, the host delivers the recorded results in the same commit
   order.

The `SessionEvents` publisher already guarantees that commit order is enqueue
order (CLAUDE.md, "One publisher"), so the ledger is the settle log. QuickJS
runs microtasks FIFO on one thread, so the same sequence of settlements gives
the same sequence of issued ops.

The guards stay as they are:

- `Date.now()`, argless `new Date()`, `Math.random()` and `Intl` throw
  (`determinismPrelude.ts:17-56`).
- Code generation is disabled (`:60-81`).
- `Promise.prototype.then/catch/finally` are frozen (`:83-89`).

The realm has no timers. There is no `setTimeout`, so nothing can settle
except a host delivery.

What changes is the realm's shape. Today the realm "holds no host promises
and so has no job queue to pump" (`sandbox.ts:392-394`). The generator
protocol was chosen on 2026-09-25 precisely to delete an earlier promise
bridge: the pump, its `Latch`, the pending-deferred set and
`settleHostPromise`
(`2026-09-25-workflow-script-generator-protocol.md` §1 and "As landed").
This design brings back a job-queue drain. It does so in a smaller form:

- The guest's `tools.x()` returns a realm-native promise whose resolver
  stays in a realm-side table keyed by op number.
- The host calls one trusted function, `settle(op, json)`, which the prelude
  captures exactly as it captures `step` today.
- The host never holds a guest object.

That keeps the data-only boundary (README "Sandbox"). It still reverses the
2026-09-25 generator ruling
(`.agents/docs/implemented/architecture/2026-09-25-workflow-script-generator-protocol.md`).
The owner accepted the reversal on 2026-10-01 (Q1), for a forward-looking
reason: `await tools.x()` is the form models write best, and it is the form
pi and Codex use. The generator note stays as the record of why the promise
bridge was removed once; this design brings back only the smaller form
above.

Model fluency was measured on 2026-09-25. Over 144 generations on gemini38f,
deepseek41T and glm53flash, the `async` description failed 8/48 on first
submission and 1/48 after one repair turn. The generator form B2 failed 6/48
and then 0/48 (`2026-09-25-workflow-script-generator-protocol.md` §8). For
fan-out scripts, then, `async` is not clearly better. For single tool calls,
which are most of what "only" carries, `await tools.x()` is the form every
model already writes.

What the script gives up compared with `yield*`:

- **Fail-fast `all()` no longer interrupts siblings.** `Promise.all` rejects
  on the first failure, but the other calls keep running until the script
  ends. Ending the script interrupts every call still open, and their cards
  settle cancelled.
- **`retry()` becomes plain code.** A script writes it with `try/catch` and a
  loop. With Q2 reuse, a retried branch does not re-bill the `agent` calls it
  already completed, which is what `retry()` gave.
- **`timeout()` becomes an option.** The realm has no timers, so a script
  cannot write a timeout. `agent` takes `timeoutMs` and rejects with
  `TimedOut`; other tools keep their own timeouts.
- **`all(items, { concurrency })` loses its per-call bound.** The session's
  child-run budget still bounds every `agent` call; a script that wants a
  smaller bound batches its items.

## Approvals, cards and the ledger

**Approval.** A nested call goes through the same per-call program as a
direct call:

1. preToolUse hooks;
2. `guardedToolCall` (`toolGuard.ts:35-125`), which asks for approval for
   `requiresApproval: true`;
3. the tool body, which opens its own request for `'inBody'`;
4. `settle`, which commits `tool.result` plus the card rows
   (`toolUseDispatch.ts:308-338`).

The approval vocabulary and its single authority (`shared/approvalPolicy.ts`,
`approvalPolicyAuthorityRatchet.vitest.ts`) do not change, and no evaluator
is added. The script tool itself requires no approval: it does nothing except
through its nested calls.

**The script request (Q5, ruled).** `agent` is the one exception to
per-call asking. The first `agent` call of a script opens one request that
shows the script's title, source, args and files. Approving it grants every
`agent` call of that script, the way `bash` takes a run-scoped command grant
(`ToolTypes.ts:27-31`). The request keeps the four outcomes the proposal flow
has today (`proposalFlow.ts:195-230`): denied by policy, auto-approved under
the run's proposal bypass, approved with inherited child approvals when no
prompt can be shown, or presented. Presented, it offers approve, approve all
agent work in this run, reject with a note, and edit as new task. The grant
is bound to the script's call with `tool.binding`, so it survives a restart
(lane 1). Nested calls other than `agent` still ask on their own.

**Concurrency.** Concurrency inside a script follows the declarations the
tools already make (`ToolTypes.ts:54-68`):

- Calls marked `parallelSafe` run under the cell's
  `Semaphore(MAX_PARALLEL_TOOL_CALLS)`. That limit is 4
  (`toolUseDispatch.ts:92`).
- Every other call takes a one-permit lane, in issue order. That preserves
  today's rule that a call with side effects is a barrier.
- `agent` calls also take the session's child-run budget
  (`runRegistry.ts:597-601`).

**The ledger.** A nested call needs one new fact: who issued it, with what
arguments. Today a call's arguments and dispatch facts ride on the
`model.message` response row (`ModelInvoker.ts:462-486`), and `tool.intent`
names the response (`runLedgerEvent.ts:283-291`). A nested call has no
response. It gets:

- **`script.call`** (new): `{ scriptCallId, seq, callId, toolName, input,
replay, logId, stageId, phase }`, committed when the guest issues the call.
  `callId` is `<scriptCallId>/<seq>`; `phase` is the title the last
  `phase()` set, or null.
- **`script.source`** (new): `{ scriptCallId, blob }`, committed before the
  first nested call when the script came from `path`. `blob` is the
  `context.blob` address of the source as read, so replay never re-reads an
  edited file. A `code` submission needs no row: its source is on the
  `model.message` row.
- **`tool.intent`** (changed): `responseId` becomes an origin,
  `{ responseId } | { scriptCallId }`.
- **`tool.binding`, `tool.result`, `request.opened`, `request.decided`:**
  shapes unchanged.

The fold keeps nested results out of the model's history: only the script's
own `tool.result` is paired with the model's call. Offered-tool identity
(`offeredTools.ts:16-31`, `:82-89`) checks a nested call exactly as it checks
a direct one. The `tools.offered` row still records the full catalog; only
the wire narrows.

**Cards.** Cards have no parent-card id today; nesting exists only for stages
(`stage.start.parentId`, `traceEvent.ts:33-40`; `transcriptFold.ts:86-162`).
Every card already carries a `stageId` (`runLedgerEvent.ts:121`;
`toolUseDispatch.ts:349`, `:369`, `:403-422`). So nesting needs no new card
field:

- the script's card opens a stage of a new kind, `script`, alongside `run`,
  `round`, `phase` and `session` (`taskGroup.ts:5`);
- its nested calls carry that `stageId`.

All three hosts already render nested stages.

The cards stay loop-owned, as before:

- a slow nested tool's `tool.start` commits with the row that admits its
  attempt;
- a fast one opens and closes in its settlement;
- `console.log` is transient.

No tool-side card, durable progress row or second append path is added.

## Resume and replay

**Approvals do not survive a restart today.** A pending approval waits inside
the fiber (`SessionHandle.ts:651-677`, `:693-772`), and `RunLedger.acquire`
cancels every unbound parking request (`RunLedger.ts:362-378`). The call then
goes through the outcome-unknown rule. There is no approval `run.position`:
the `at` values are `turn.ready`, `turn.begin`, `turn.end`, `response.ready`,
`results.ready`, `waiting` and `halted` (`runLedgerEvent.ts:68-76`).

Only two requests survive today:

- the outcome-unknown question, which is bound by `tool.binding`
  (`runLedgerEvent.ts:300-311`);
- the model-retry permit (`pendingRetry`).

So this part is new work. It uses the mechanism that already survives:

- When `guardedToolCall` or an `'inBody'` tool opens a request for a call,
  the run commits a `tool.binding { callId, attempt, requestId }` beside the
  `request.opened`, as `decideOutcomeUnknown` already does
  (`toolUseDispatch.ts:574-691`). The binding's meaning widens from "the
  approval that guards an outcome-unknown call" to "the request that guards
  this call attempt"; its shape does not change.
- `acquire` already leaves bound requests alone.
- The run parks at the existing `waiting` position. No new position is
  needed.

This applies to direct calls too, so in both modes a pending approval
survives a restart.

**Resuming a script.** The script's source is its call's arguments on the
`model.message` row, or the `script.source` blob for a `path` submission.
Resume opens a fresh realm and runs the source from the
top, then handles the nested calls by state:

- **Settled.** A nested call that has a `tool.result` is delivered from the
  ledger in commit order. It is not run again.
- **In flight, no binding.** It follows the direct-call rule:
  - a call whose saved and current `replay` both say `safe` re-runs at
    `attempt + 1` (`run/tools.ts:139-165`);
  - any other call goes to `decideOutcomeUnknown`.

  21 of the 52 built-in tools declare `safe`. MCP tools are `safe` when they
  carry `readOnlyHint` or `idempotentHint`.

- **Bound to a request.** The call re-attaches to that request. If the
  request was decided while the process was down, the decision applies.
- **Divergence.** If the replayed guest issues a call whose `(toolName,
input)` does not match the recorded `script.call` at that `seq`, the
  script fails with `ScriptDiverged`, naming the `seq`. The calls recorded
  after that point stay in the ledger as what happened. With the determinism
  guards, divergence needs a changed tool catalog or a changed
  `describeTool` text. Discovery calls are recorded as nested calls without a
  card, so they replay exactly too.

**`agent` keeps its own recovery.** An `agent` call that is in flight is not
outcome-unknown. Today `workflowScriptAgentRunner` recovers it from the
child's own aggregate, using these facts:

- `run.start` is the launch;
- a COMPLETED `run.end` with a `run.result` manifest means durable
  completion;
- an active turn, or a settled turn with no manifest, is refused for
  operator attention.

(README, "Restart-safe checkpoints"; `workflowScriptAgentRunner.ts:640-729`.)
This recovery moves into the `agent` tool. The child id is derived from
`(callId, tool.intent.attempt)`, which replaces `workflow.attempt`'s attempt
mark. The cases the runner refuses today "for operator attention" (an
accepted turn that never settled, a manifest without a settle, a child resumed
after it completed) become the outcome-unknown request: the call opens it,
binds it with `tool.binding`, and the user decides. Today they abort the
whole workflow instead.

**Cross-script reuse (Q2, ruled).** The current tool lets a model edit a
failed script and rerun it while "completed agent() calls replay for free"
(`WorkflowScriptTool.ts:668`). Ledger replay covers the resume of one
script; it does not cover a new script call. So `agent`, and no other tool,
reuses a completed result:

- **Key.** A hash of the prompt and every run-affecting option (`agentName`,
  `model`, `schema`, the three file lists, `id`), plus a fingerprint of the
  bytes of every referenced file. That is today's journal key
  (`runWorkflowScript.ts:51-67`, `inputFields.ts:413`), so editing an input
  file still invalidates the result. `label` and `phase` stay out of it.
- **Scope.** The run that issued the `script` call, together with the
  background script runs it launched (their `run.start` names it as parent).
  A completed `agent` result in that scope with the same key is returned
  without launching a child. Failed, cancelled and skipped calls are never
  reused.
- **Record.** The reused call still gets its own `script.call` and
  `tool.result`. The result names the call it reused (`reusedFrom`), which
  is what the board shows as "Reused".
- **Storage.** The lookup reads the runs' own `script.call` and
  `tool.result` rows. No index or table is added until a session shows it is
  needed.
- **Duplicates.** Two calls in one script with the same key would receive
  the same result. As today (`runWorkflowScript.ts:462-468`), the second one
  fails unless the calls carry distinct `id`s.

## Prompt and cache

**How tools reach the wire today.**

- Every request sends every offered tool's full JSON schema
  (`toolDefinitionsFor`, `run/tools.ts:27-37`; `convertToolSchema`,
  `toolSchema.ts:144-158`; sent at `toolUse.ts:472-505`).
- Requests carry `cacheKey: run.runId` (`ModelInvoker.ts:283-298`). Anthropic
  marks `cache_control` (`anthropicMessages.ts:381-441`); OpenAI uses
  `prompt_cache_key` (`openaiResponsesRequest.ts:173-191`).
- System text is frozen at the first step and after a compaction
  (`requestContext.ts:168-195`).
- **The tool list is not frozen.** It can change at any step (plugin
  toggles, MCP servers, live plugins), and a change rewrites the `tools`
  array, so the cached prefix breaks from the tools onward. The model learns
  about the change from an appended system message (`contextUpdate`,
  `src/agent/prompt/PromptBuilder.ts:97-113`), and a `tools.offered` row
  records it (`step.ts:345-353`).

**Under the script tool.**

- The script tool's description holds the surface text plus one typed
  declaration per tool the agent declares. It is rendered once, at the step
  that freezes the system text, and stored with it.
- A later change to the catalog does not touch the description. It reaches
  the model through the same `contextUpdate` message, which is append-only
  and keeps the cache. A new tool is callable at once and `describeTool`
  documents it.
- After a compaction the description is re-rendered with the system text,
  since that is already a new cached prefix.

This needs no new concept: the description joins the text that
`offeredSystem` already freezes (`runStateFold.ts:557-575`).

**Deferred discovery is new.** No tool search or deferred loading exists
today. Two kinds of tool are not declared inline:

- MCP tools (stdio from `~/.texra/mcp.json`; `tools/list` is paginated with
  no count cap, `mcpServer.ts:345-361`);
- plugin-injected tools (`agentToolResolution.ts:204-206`, unbounded).

Instead (owner ruling 6):

- `searchTools(query, { namespace?, limit? })` ranks the step's offered
  catalog with BM25 and returns `{ name, line }`, best first. `namespace`
  limits the search to one union tool, one plugin or one MCP server.
- `describeTool(name)` returns the full declaration, with field
  descriptions. Given a namespace name instead of a tool name (`memory`, a
  plugin id such as `zotero`, or an MCP server), it returns the
  namespace's description and one line per member. That covers what pi's
  separate `describeNamespace()` does
  (`pi: packages/coding-agent/src/extensions/codemode/execute.ts:494-515`)
  with one global fewer.
- Both read the step's pinned generation and are recorded as nested calls
  without a card, so replay returns the same answer.

**How pi ranks.** pi's ranker is Okapi BM25 with `k1 = 1.2` and `b = 0.75`.
Ties keep catalog order, and only positive scores are returned
(`pi: packages/coding-agent/src/extensions/tool-search/tool.ts:118-155`).
Its tokenizer lowercases, splits at camelCase boundaries and
non-alphanumerics, drops 21 stop words, and strips a naive plural (`:38-80`).
Each tool's document is built from (`:82-116`):

- the name, and the name with `_` read as spaces;
- the description;
- every schema property name and property description, recursively;
- the namespace's name, description and instructions.

TeXRA takes the same fields. Its namespaces are the union tools, the
plugins (every offered tool already carries its plugin id in
`tools.offered`, `offeredTools.ts:42-59`) and the MCP servers.

**SQLite FTS5 or a small ranker.** The owner's rule is to use what SQLite
and Effect already provide. SQLite does provide BM25, as FTS5's `bm25()`:
the `node:sqlite` build TeXRA runs has FTS5 compiled in, verified on
Node 26.9.0. The two options:

- **FTS5.** An in-memory table per pinned generation. It still needs:
  - a connection: the session database is the wrong place for a
    per-generation scratch table, and `node:sqlite` is synchronous, which
    is why the history query runs it in a child process
    (`historyQuery/childSource.ts:1-19`);
  - a schema, and a lifecycle tied to the generation's pin;
  - and the camelCase splitting done before insert anyway: FTS5's `unicode61` tokenizer splits `snake_case` but not
    `camelCase` (checked: `MemoryPin` does not match `pin`), and property
    names such as `inputFiles` are camelCase.
- **A small ranker.** A pure function over the generation's entries,
  about 40 lines for the ranker and about 20 for the tokenizer, as in pi.
  The corpus is one run's catalog: 52 built-in tools, plus the MCP and
  plugin tools a run declares, which is at most a few hundred entries.

**Recommendation: the small ranker.** The data is a short in-memory list
that lives exactly as long as the pinned generation. The rule about SQLite
is about stored data, and nothing here is stored. FTS5 would add a
connection and a lifecycle, and it would still need the tokenizer. If a
catalog ever grows past a few thousand entries, FTS5 is the upgrade, and
the function's signature does not change.

**Token cost.** Measured on `main` at the baseline:

- **Method.**
  - Each built-in tool's `definition` was run through the production
    `toolDefinitionsFor` (`run/tools.ts:27`) in a scratch Vitest file that
    imported `PLUGIN_TOOLS`. The file was not committed.
  - Counts use the `o200k_base` tokenizer over the JSON of
    `{ name, description, parameters }`.
  - Provider framing is excluded, and Anthropic's tokenizer differs by a few
    percent.
- **Today, JSON schemas.**
  - All 52 built-in tools: 18,182 tokens.
  - `assistant` (41 tools, the CLI default, `assistant.yaml:6-67`): 13,885.
  - `orchestrator` (20, `orchestrator.yaml:6-35`): 10,133, of which
    `delegate_multi_agents` alone is 1,956.
  - The six file tools: 1,290.
- **TypeScript declarations**, with the description's first sentence as a
  doc comment and parameters rendered as TS types:
  - 52 tools: 2,841 tokens;
  - `assistant`'s 41: 2,394;
  - the six file tools: 288.
- **One line per tool**, name plus first sentence, with no types:
  - 52 tools: 1,296 tokens;
  - `assistant`'s 41: 1,022.
- **The surface text** (globals, result shape, the rules above): about
  500 tokens, estimated. It will be measured when it is written.

So `assistant` drops from about 13,900 tokens to about 2,900 per request. That
figure assumes typed declarations for everything and moves the per-field
descriptions behind `describeTool`. Those descriptions carry real guidance:
`executions`' description is 949 tokens and `delegate_workflow`'s is 280.
The owner ruled (Q4) that every declared tool is inlined as a typed
declaration. The alternative, a typed core list with one-line entries for
the rest (1,192 tokens for `assistant` with the file tools typed), stays on
the table only if the nightly comparison shows it does better.

## Engine and isolation

The engine stays QuickJS (`quickjs-emscripten-core` with
`@jitl/quickjs-wasmfile-release-sync` 0.32.0; `sandbox.ts:1-11`,
`pnpm-workspace.yaml:15`, `:46`).

V8 is not an option:

- `node:vm` is not a security boundary.
- `isolated-vm` is a native addon. It would need ABI rebuilds for Electron,
  the VS Code extension host and Node across three hosts.

Codex gets V8 isolation by shipping a separate host binary
(`code-mode/src/remote_session/connection.rs:157-169`), which TeXRA has no
reason to build.

**Limits stay as they are:**

- a fresh runtime and context per script (`sandbox.ts:396-430`);
- a 64 MB heap and 1 MB stack (`:40-41`);
- a 30 s guest CPU budget summed across steps (`:44-49`);
- a fan-out cap of 4096 (`:42`);
- the WASM bytes bundled through esbuild's binary loader in all four bundles
  (`packages/extension/esbuild.config.mjs:28`,
  `packages/desktop/esbuild.main.mjs:62`,
  `packages/cli/scripts/build-bundle.mjs:45`,
  `packages/agent/scripts/bundle.mjs:84`).

**Why a worker thread.** Guest code runs on the host thread today
(`sandbox.ts:44-46`). For one opt-in tool that was acceptable. When every
call goes through it, it is not: a guest loop that burns its full CPU budget
would freeze the extension host or the TUI for 30 seconds.

The realm therefore moves onto a `worker_threads` worker, one per session,
with a fresh QuickJS runtime per script inside it, as today:

- **Preemption.** The interrupt handler runs on the worker. It polls a
  `SharedArrayBuffer` flag the host sets, which is how pi does it
  (`pi: packages/codemode/src/runtime/worker.ts:32-44`). A script can then be
  preempted without waiting for the worker's event loop.
- **Shipping.** No production code spawns a worker today. Shipping the entry
  point is the problem `2026-09-26-session-database-off-host-thread.md` §5.4
  already solved on paper: a second esbuild entry per bundle, resolved with
  `__dirname` for CJS and `import.meta.url` for ESM. Whichever of the two
  lands first owns that table.

## Effect structure

**The sandbox service.** `CodeSandbox` is a `Context.Service` (the repo's
idiom: `RunLedger` at `runLedger.ts:86`). Its layer is scoped to the session:

- `NodeWorker.layer` (`@effect/platform-node`, already a workspace
  dependency at 4.0.0-rc.117) spawns the worker.
- The RPC transport is `RpcClient.layerProtocolWorker` /
  `RpcServer.layerProtocolWorkerRunner` (`effect/unstable/rpc`,
  `RpcClient.d.ts:272`, `RpcServer.d.ts:340`).
- On scope close the platform asks the worker to close, then calls
  `worker.terminate()` after a 5 s timeout (`NodeWorker.js:38`, `:53`).
- Interrupting the session's scope therefore terminates the worker and every
  VM in it.
- There is no `new AbortController(`, no hand-rolled lifecycle, and no
  `Effect.run*` on the host side.

**One script call** is `CodeSandbox.run(source, catalog)`, an Effect inside
the run fiber's scope:

- **Opening the realm.** An RPC opens a fresh QuickJS runtime under
  `Effect.acquireRelease`. Its release disposes the runtime in the worker.
- **Issued calls.**
  - Each nested call the guest issues is forked into a `FiberSet` owned by the
    script's scope. Closing that scope interrupts every call still open,
    which is how unawaited calls end.
  - Each forked fiber runs the existing per-call program on the run fiber's
    context: hooks, `guardedToolCall`, the tool's own `Effect`, and `settle`
    through `SessionEvents`.
  - The concurrency bounds are `Semaphore.withPermits`, as in "Approvals".
- **Settled calls.**
  - Settlements go through a `Queue`.
  - One consumer fiber takes them in commit order and calls the `settle` RPC.
    The worker drains the job queue and replies with the newly issued ops and
    whether the script finished. This is the only place realm state
    advances.
- **Limits.**
  - The wall deadline is `Effect.timeout` on the script.
  - The CPU budget is enforced in the worker's interrupt handler, as today.
  - The host's `Effect.timeout` and an interrupt both set the shared flag
    before closing the scope.

**Errors.** Errors are tagged and typed in the channel: `ScriptSyntaxError`,
`ScriptFault` (the guest threw), `ScriptCpuExhausted`, `ScriptDiverged`,
`SandboxUnavailable` (the worker died). None is spelled `unknown`
(`unknownErrorChannelRatchet.vitest.ts`). The worker boundary and the JSON
the guest returns are the one foreign boundary: they are decoded once with
Zod and wrapped with `ensureError`.

**The wire.** RPC groups are declared with Effect `Schema`, and payloads
cross as `Schema.String` holding JSON that Zod decodes on each side. That is
the reconciliation recommended in the database-worker note (§5.2, Q2). It
also keeps the 2026-09-25 ruling that Zod owns payloads (generator-protocol
doc §9).

**The run boundary.** The worker's own entry needs exactly one bare
`Effect.run*` (`NodeRuntime.runMain` over the runner layer), because no
process runtime exists in the worker. The entry lives in host-agnostic code,
so the bundles can share it. It therefore has to be named in two places:

- the ESLint runtime-entry list (`eslint.config.mjs:947-951`, the `entries`
  beside `src/platform/processRuntime.ts`);
- `BARE_EFFECT_RUN_SITES`
  (`src/test-kernel/architecture/dependencyDirection.vitest.ts:103-160`).

Each entry carries the reason "worker entry: no process runtime exists in the
worker". No other new `Effect.run*` is needed.

**What the current engine does that is not Effect-native.** These parts are
converted, not wrapped:

- The wall deadline is polled with `performance.now()` inside the interrupt
  handler, beside an `Effect.delay` fork (`interpreter.ts:190-201`). It
  becomes `Effect.timeout` plus the shared flag.
- `workflowRunState.ts` is a mutable class (`#stages`, `:121`, `:240`).
  `workflowScriptStrategy.ts` keeps `startedAt = Date.now()`, a mutable
  board and a running cost (`:173-179`), and registers skip/retry controls
  through a callback registry (`:278`, `workflowControlRegistry.ts`). All of
  this is deleted rather than converted. Its job (progress, cost, controls)
  falls to the run's own cards, its usage rows and the existing stop path.
- The checkpoint's per-checkpoint in-process lane and its cross-process
  claim (`checkpoint.ts:77`, `:336-340`) are a second owner of what the run
  ledger already serializes (`RunCell.append` over a `SynchronizedRef`,
  `runProgram.ts:94-101`). They are deleted with the checkpoint.

## Rollout and evaluation

1. **"on".** The script tool is offered beside the direct tools to agents
   whose YAML lists it. Each direct tool's description gains one line, "also
   `tools.x(args)` in `script`". `delegate_multi_agents` stays until the
   parity lane deletes it; from then on the orchestrator's fan-out guidance
   points at `script`.
2. **Measure.**
   - Run the live journeys (`packages/cli/scripts/validate-journeys.mjs`,
     four journeys graded on file invariants and a real `latexmk` build)
     under `direct` and `only`, on gemini38f, deepseek41T and glm53flash.
   - Report pass rate, total tokens, cost and wall time per journey.
   - Add one fan-out journey that exercises `agent()`, in two forms:
     children report only to the parent, and children may message each
     other, at equal token budgets (Q12).
   - Two fixes come first:
     - The nightly is broken as committed: `c6efe574f0` rekeyed the script's
       `MODEL_KEYS` (`validate-journeys.mjs:46-49`), but
       `.github/workflows/live-journeys.yml:40` still passes the old keys, so
       the script exits at `:261-266` before any journey runs.
     - gemini38f is not in the matrix.
3. **"only".** The flip is gated by our own nightly evaluation on the
   current versions of TeXRA and of each model, and by nothing else. For
   each model, the bar has three parts:
   - **Pass rate.** `only` is not worse than `direct`. The bar is the lower
     bound of a 90% interval on the difference, which must not fall below
     −5 points.
   - **Cost.** The mean cost per passing task is no higher than `direct`'s.
   - **Latency.** The median wall time per task is at most 1.2 times
     `direct`'s.

   The report also gives the cached share of input tokens, because cache
   fit is where a token saving does or does not become a cost saving.

   **Sample size.** At 30 tasks per arm, a pass rate is uncertain by about
   ±9 points, so each arm needs well over 30. Four journeys a night cannot
   reach that in three nightlies (12 tasks per arm per model). The bar
   therefore pools nightlies:
   - each journey runs three times per arm per nightly on the cheap models,
     so 12 tasks per arm per model per night;
   - the comparison pools the last five nightlies, so 60 tasks per arm per
     model, on one TeXRA commit range and one model version;
   - a model or TeXRA change that alters the prompt or the tool surface
     restarts the window.

   This window replaces the earlier bar of three consecutive nightlies
   (Q17).

   **External figures motivate the eval; they gate nothing.** The survey
   behind this section (coauthor-fc, "Where Harnesses Are Going",
   2026-10-01) cites figures that suggest a code-mode surface does not
   automatically save money. One harness's code-mode preset is reported to
   pass 60% of its tasks, the same as its standard preset, at $4.58 per task
   against $3.46, and slower (FrontierHarness on Kimi K3). That is one
   snapshot of one implementation at n=30, on late-2025 models, and such
   figures change between versions. The mechanism is the durable reason to
   measure cost: a smaller tools block saves money only if the prompt
   cache still fits, and extra script turns can spend more than the
   schemas saved.

4. **Per-model fallback (Q3, ruled).** A model that fails the bar keeps
   direct tools, and the fallback stays until the nightly data says
   otherwise. Retiring it is a later, separate decision.
   - The flag lives on the binding (`BoundModel`, `modelBinding.ts:87-98`),
     set in the vendor arms (`:285-380`) next to `supportsForcedToolChoice`.
     That needs no llm-zoo release.
   - A route without tool calling cannot run either mode, and is unchanged.

## Fit with the plugin model

The 2026-09-27 ruling builds plugins on five primitives
(`2026-09-26-core-concepts.md`, "Central primitives", :119-228). Two are
built and carry this design: `Registry<K,V>` (`src/tools/liveRegistry.ts`)
and `Step.open` (`src/agent/runtime/loop/step.ts:186`). Trust is partly
built (`src/common/plugins/pluginTrust.ts`). `Plugin.load` and
`History.writer(pluginId)` were ruled not built on 2026-09-30
(core-concepts :162-179). The script tool needs neither.

**`tools.*` is the step's pinned snapshot.** `Step.open` pins every
registry the run uses as one snapshot. A response's calls dispatch against
the step that offered them (`stepFor` with `kind === 'dispatch'`,
`step.ts:425-458`), and the pin is held hand over hand until the next step
has pinned its own (`step.ts:14-17`, `:319-329`). A script is one call, so:

- `tools` is built from that snapshot's tool generation, and `searchTools`
  and `describeTool` read the same generation. Nothing else is consulted.
- A plugin change reaches a script only at a step boundary. A script that is
  running keeps calling against the generation it started with, with that
  generation's services (`toolUseDispatch.ts:398`, `:458`). This is
  invariant 7, "Nothing changes mid-call" (core-concepts :312-316), applied
  to the script as the call.
- **A plugin switched off while a script runs.** The script's nested calls
  to that plugin's tools still run: the generation is pinned, and switching
  off withdraws from the next generation, not the pinned one
  (`liveTools.ts:17-22`). The next step's `tools` lacks them, and the
  `contextUpdate` message tells the model. The old generation drains when
  the script's step releases it. A background script holds its own run's
  step for as long as it runs, so its pin lasts that long too.
- **On resume.** A settled nested call replays from the ledger and needs no
  tool. A nested call that was in flight is re-dispatched against the
  resumed step's snapshot. If its tool's identity changed or left, it
  settles `tool_unavailable` (`step.ts:416-424`), exactly as a direct call
  does, and the script sees a `ToolFailed` rejection.

**Built-in plugins contribute both tools.** Neither is special-cased in the
loop by name.

- `script` comes from a new built-in plugin, `codemode`, with revision
  `builtin` (`src/tools/catalogEntries.ts:87`). It is hidden and not
  toggleable, like `core` (`pluginManifest.ts:392-404`). Whether a run sees
  it is decided per agent during stage "on" (the YAML lists it) and per
  model binding after the flip (Q3). A user switch would be a third knob
  with no case the other two miss.
- `agent` comes from the existing `workflow-script` plugin
  ("Multi-Agent Workflow", `pluginManifest.ts:238-253`). Its row swaps
  `delegate_multi_agents` for `agent` in lane 4, and drops the old tool in
  lane 9. It stays toggleable and off on new installs, so automated fan-out
  keeps its two consents: the agent's YAML names `agent`, and the global
  switch is on. The switch still hides the plugin's skill
  (`skillSources.ts:168-175`).
- The loop knows the per-call program, not the script tool. It serves that
  program to tools through the step's context, and `script` is its one
  consumer.

**One writer.** `script.call`, `script.source` and every nested call's
rows are core ledger kinds, not plugin arms. Replay is a loop fact, so they
belong to the closed run-ledger schema. They are appended through the run's
`RunCell` and committed by the one `SessionEvents` publisher, the same path
the loop's own rows take. The script tool opens no second writer, and
`History.writer` stays unbuilt.

**Hooks fire per nested call.** `PreToolUse` runs before a nested call's
approval and body, and `PostToolUse` commits with its settlement
(`toolUseDispatch.ts:426-433`, `:553`), as for a direct call. A deny settles
that nested call with "Blocked by a PreToolUse hook" (`hooks.ts:392-457`),
which the script sees as a `ToolFailed` rejection. The `script` call itself
also gets the two hooks, with tool name `script` and its input. Each
invocation writes its `hook.outcome` row. On resume, a recorded `PreToolUse`
hook that is gone or changed denies the re-dispatched call
(`hooks.ts:94-123`).

**Trust gates plugin tools the same way.** A plugin that is not trusted is
held back (`pluginTrust.ts:292-330`), so its tools never enter the
generation and never appear in `tools`. A script cannot reach a tool the
step did not offer.

**MCP tools are registry entries with deferred discovery.** MCP servers
enter the registry through `serverHolds.holdServer`, which contributes their
tools under `mcp:<name>` or `plugin:<name>` (`serverHolds.ts:86-142`), and
only when a run declares an MCP tool (`mcpConfig.ts:150-200`). In a script
they are callable as `tools["mcp__server__tool"]` but not declared inline:
`searchTools` and `describeTool` find them. They keep the bash approval and
are not `parallelSafe`, so they take the one-permit lane.

**Identity.** The `tools.offered` row records each tool as
`{ name, digest, shown, plugin, revision }`, and `sameIdentity` compares
name, digest, plugin and revision (`offeredTools.ts:18-31`, `:84-89`). A
nested call resolves its `toolName` against that row for its step, so the
plugin id and revision are part of the call's identity without being copied
onto `script.call`. A call to a name the row lacks settles
`tool_unavailable`.

## How agents talk to each other

The owner asked for this to be "model-pilled". The model drives
coordination by calling a few plain primitives from code. The harness does
not encode orchestration patterns, and no pattern gets machinery of its
own.

This section builds on the session-messaging note
(`2026-09-25-session-messaging.md`, owner decisions of 2026-09-26). That
note's PRs 1 to 4 are on `main`. It also builds on the accepted history-query
note (`2026-09-26-executions-history-query.md`). Neither is redesigned here.
The section says what code mode changes, what of theirs it makes redundant,
and what it adds. Paths are under `src/`.

### What carries messages between runs today

| Channel                    | What happens                                                                                                                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `executions send`          | Any run messages any run in the same session, regardless of where either sits in the tree. The body is framed as `<run-message from agent>`. Refused for: self, an unknown id, a workflow run, a one-shot run, a run held by another process. A run the user stopped is not revived by a run's message. There is no approval.                                                                | `tools/executions/send.ts:26-102` (108); `toolInput.ts:118-126`; `ToolUseFollowUp.ts:326-350`; `ExecutionsTool.ts:801-821` |
| The follow-up inbox        | A message is a `followup.queued` row on the recipient's run aggregate, committed in one `exclusive` job before the send returns. Admission stamps the sender and its relation (parent, child, ancestor, descendant, sibling, peer) from the view. The recipient takes pending rows at its next turn boundary as one user message, and `followup.consumed` commits in the same `appendBatch`. | `ToolUseFollowUpQueueManager.ts:418-437`, `:540-603`; `followUp.ts:11-62`; `FollowUps.ts:166-196`, `:331-361`              |
| Instruction or information | Only the user's messages and the parent's feed the run's instruction. Every other sender informs.                                                                                                                                                                                                                                                                                            | `followUpMessages.ts:49-53`                                                                                                |
| Waking                     | A parked run wakes through `RunInput`. A persisted waiting run is resumed by a recoverable admission. A failed wake leaves the message queued and says so.                                                                                                                                                                                                                                   | `RunInput.ts:44-47`; `ToolUseFollowUp.ts:117-174`; `send.ts:97-102`                                                        |
| One-shot refusal (#13588)  | A run whose live loop ends after one turn (`RunControls.oneShot`, set from `stopAfterCycle`) reads no messages, so a send to it is refused instead of sitting unread under "sent".                                                                                                                                                                                                           | `RunHandle.ts:36-47`; `loop/toolUse.ts:194`; `send.ts:64-70`                                                               |
| Background child reports   | A detached child's settled turn is written as `run.report` and `run.result` on the child, then as a `followup.queued` on the parent with a deterministic `deliveryId`, framed `<subagent-result>` or `<subagent-error>`. Progress and pause notices travel the same way.                                                                                                                     | `agent/runtime/childRunLoop.ts:502-620`, `:807-829`; `childRun.ts:188-236`; `deliveryEnvelope.ts:63-102`                   |
| In-band results            | A one-shot parent cannot park, so its child runs in-band and the result is the tool result, re-read from the child's `run.end` and `run.result`.                                                                                                                                                                                                                                             | `tools/delegation/subagentRun.ts:123-155`; `inBandSubagentRun.ts:244-368`                                                  |
| `executions wait`          | It returns when a watched run changes phase, or when the caller gains a new pending follow-up (any sender). `wait` on one child withdraws that child's pending deliveries and shows its report instead.                                                                                                                                                                                      | `ExecutionsTool.ts:101-133`, `:230-236`, `:326-343`                                                                        |
| `executions kill`          | Only the direct parent may stop a run, and only when `ALLOW_ORCHESTRATOR_KILL` allows it.                                                                                                                                                                                                                                                                                                    | `ExecutionsTool.ts:418-468`; `RunHandle.ts:116-118`; `killPolicy.ts:26-43`                                                 |
| `executions query`         | Read-only SQL over the run-history views.                                                                                                                                                                                                                                                                                                                                                    | history-query note, phase 1 (#13344)                                                                                       |
| Parentage                  | `run.start.parent` defines the supervision tree; `run.detach` severs an edge; stopping a parent cascades unless it detaches.                                                                                                                                                                                                                                                                 | `sessionEvent.ts:239-243`, `:313`; `runRegistry.ts:692-747`                                                                |
| Approval inheritance       | A child inherits its parent's bypasses through an in-memory ancestry edge. The policy values are published as rows. A child's own prompts are requests on its own aggregate; nothing forwards them to the parent.                                                                                                                                                                            | `approval/index.ts:34-53`; `runApprovalQueue.ts:330`                                                                       |
| Other senders              | An external inquiry's answer returns to the asking run, and GitHub notices arrive as `notification` senders. Both go through the same admission.                                                                                                                                                                                                                                             | `inquiryActions.ts:195-229`; `RunSubscriptionRegistry.ts:152`                                                              |

Everything a run receives is a row. What is held only in memory is
coordination that can be rebuilt: the queue's slots and leases, the
`RunInput` latch, the wake fibers, `RunControls.oneShot` and the approval
ancestry map (`ToolUseFollowUpQueueManager.ts:53-70`; `RunInput.ts:14-57`;
`runApprovalQueue.ts:330`). None of it carries message content.

### The code-mode form

These are the primitives, as a script sees them. Most are existing tool
calls; one is added and one is a new option.

| Primitive                                  | What it does                                                                                  | Status                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------ |
| `agent(prompt, opts)`                      | Start a child and await its result. The result is the call's value.                           | Lane 4 (it is `tools.agent`)         |
| `agent(prompt, { background: true })`      | Start a child and return `{ runId }`. Its report arrives as a follow-up at a turn boundary.   | Lane 4; today's `delegate_*` default |
| `tools.executions.send({ path, message })` | Message a run by id. The id comes from `agent`, from the listing, or from `executions.query`. | Exists; item 13 makes it idempotent  |
| `tools.executions.wait({ path, ids })`     | Wait until a run changes phase or a message arrives for the caller.                           | Exists                               |
| `tools.executions.view` / `.query`         | Read a run's report, result, files, conversation or history.                                  | Exists                               |
| `tools.executions.kill({ path })`          | Stop one's own child.                                                                         | Exists                               |

Addressing stays by run id. A unique prefix of at least six characters is
accepted, the agent's name is shown beside the id, and there is no nickname
registry (session-messaging, "Addressing").

**No read-your-inbox primitive.** Owner decision 4 of the messaging note puts
messages at the turn boundary, with no mid-turn steering. A script runs
inside one turn, so it cannot read messages that arrive while it runs. It
does not need to:

- A result it is waiting for is the value of a foreground `agent()` call.
- A background child's report arrives at the next turn boundary, after the
  script has ended. The model reads it there and can write the next script
  with it in hand.
- `executions.wait` tells the script that something arrived, and
  `executions.view` reads a child's report from its rows without consuming
  the message.

A `receive()` that consumed pending follow-ups mid-script would reverse
decision 4. Q13 asks whether that is wanted; the recommendation is no.

### Replay

- **A send.** It is a nested call. Its `followup.queued` commits on the
  recipient before its `tool.result` commits on the sender. A settled send
  replays from its `tool.result` and is not sent again. A send in flight at
  a crash is the one gap: the row may have committed while the result did
  not. Today that call goes to the outcome-unknown question, because
  `executions` is `replay: 'unsafe'` and the follow-up id is random.
  Retirement item 13 derives the id from `callId`, so re-running is
  idempotent and the question is not needed.
- **A wait.** It reads live state, so a re-run on resume can return a
  different answer. That is safe: the realm only ever sees the recorded
  result of a settled call, and a wait in flight had not delivered anything
  yet. With the effect class (Q10), `wait`, `view` and `query` are reads.
- **Receiving.** Receiving is a turn-boundary consumption that the
  recipient's loop commits (`FollowUps.ts:331-361`). It is not a script
  settlement, so it needs no replay rule beyond the one it has.
- **What would break replay.** Any message that is not a row: a `PubSub`, a
  per-run mailbox, or a realm reading the live view. The messaging note
  already rejected the first two ("Rejected Effect facilities"). The third
  is why scripts read through tool calls, whose results are rows.

### No orchestration framework

Fan-out, debate, a referee panel, a pipeline, a supervisor loop and a
verifier-picked merge are scripts the model writes. The
multi-agent-orchestration skill documents them as patterns (lane 8). None is
a primitive or a tool option. For example, a verifier-picked merge runs N
`agent` calls, builds each candidate with `tools.bash` or a Lean check, and
returns the one that passes. That needs no new row: the winner is the
script's return value.

Two proposals from the harness-direction survey (coauthor-fc) were checked
against this rule:

- **One budget shared by an agent tree.** A pattern cannot enforce a budget,
  so this would be a primitive. Concurrency already has one,
  `childRunBudget` (`runRegistry.ts:597-601`); cost has none ("Parity
  inventory" notes there is no cost budget today). Q14.
- **Verifier-picked merge.** A pattern, as above. Not a primitive.

### Delivery rules stay explicit and loud

None of these change. A script sees each refusal as a `ToolFailed`
rejection with the worded reason.

- **One-shot target.** Refused, naming the reason (`send.ts:64-70`).
- **Finished or stopped target.** A run sender gets `finished`,
  `not_resumable` or `owned_elsewhere`. Only the user's own message
  continues a stopped run (`ToolUseFollowUp.ts:326-350`).
- **Target in another process.** `owned_elsewhere`, and nothing is written
  (`ToolUseFollowUpQueueManager.ts:458-472`).
- **Turn boundary.** A message is read at the recipient's next boundary,
  never mid-turn (decision 4).
- **Sender's plugin switched off mid-script.** `executions` is in the
  `memory-workflow` plugin. A script keeps the generation it started with,
  so its calls still work; the next step's `tools` lacks it, and
  `contextUpdate` says so ("Fit with the plugin model").
- **Recipient stops while a message is pending.** The row stays on the
  recipient. If the user resumes the run, it is consumed at the next
  boundary. If not, it is never consumed, and the listing shows it as
  unread.

### Who may address whom

- **Today.** Any run may message and wake any run in the project
  (session-messaging decision 8, "a graph over a tree"). Only the direct
  parent may kill (`ExecutionsTool.ts:439-443`).
- **New evidence.** The harness-direction survey (coauthor-fc,
  2026-10-01) cites a Google study of 180 agent configurations in which
  independent agents messaging freely amplified errors up to 17.2 times,
  against 4.4 times with an orchestrator. It also cites results that two
  different agents can match sixteen identical ones, and that at an equal
  token budget a single agent often wins on sequential work. These are
  single snapshots, from particular implementations, on late-2025 models,
  and they motivate our own eval rather than decide anything (see
  "Rollout and evaluation"). The mechanisms are the durable part: a central
  coordinator contains errors, each hand-off between agents loses
  information, and diversity of agents matters more than their number.
- **Recommendation (Q12).** Keep decision 8 for what the tool allows. The
  addressing rule is ruled and shipped, and narrowing it would need its own
  eval. Make parent-routed coordination the documented default in the
  skill, and let our own nightly decide whether peer messaging earns its
  place: add one fan-out journey in which children report only to the
  parent, and one in which they may message each other, at equal token
  budgets. If peers show no gain, narrowing `send` to the supervision tree
  is a one-line rule in `send.ts`.
- **Approval.** A message carries no approval scope, and every tool the
  recipient runs keeps its own policy (session-messaging, "Invariants
  honored"). A script's `send` calls need no consent of their own. The
  script request (Q5) grants `agent` calls only. Lane 13's effect class
  marks `send` as `external`, which keeps it out of any grant derived from
  reads.

### Fit with the plugin model

`executions` and `agent` are tools in the step's pinned registry, so a
script calls the generation it started with. Every message is a
`followup.queued` row written by the one `SessionEvents` publisher, and
every consumption is a run-ledger row written by the recipient's loop. Code
mode adds no channel, no subscribe surface and no writer.

### What this makes redundant, and what it adds

- **Cleanup.**
  - The history-query note's phase 2 (`query()` as a workflow operation,
    with its journal discriminant and format bump). It is never built; see
    retirement item 11.
  - The `delegate_*` launch tools, which `agent` replaces (item 1).
  - The workflow-script envelopes `<workflow-script-result>`,
    `<workflow-script-error>` and the `<workflow-summary>` element
    (`deliveryTags.ts:13-27`; `workflowScriptStrategy.ts:239-255`). They go
    in lane 9, and a background script delivers through the generic
    child-report envelope, with the summary line folded from its cards
    (inventory, "Running, delivery and resume").
- **Additions.**
  - `agent`'s `background` option (lane 4).
  - The idempotent send (item 13, lane 3).
  - Effect classes per branch on `executions` (Q10, lane 13).
  - Two journeys comparing parent-routed and peer coordination (lane 10).
- **Unchanged from the messaging note.** The inbox row, admission, the
  relation stamp, the wait predicate, the refusals, and the deferred
  cross-process relay. Its open idea of multicast addresses (`@children`,
  `@siblings`) is not needed: a script sends in a loop.

## Adapting the agents

Built-in YAMLs are under `packages/extension/resources/` (R/ below). The
paths below were read on the baseline.

### Tool lists

Fifteen tool-use agents name at least one tool this design changes. The
workflow agents (`R/agents/*.yaml` and `R/agents/write/*.yaml`) have no
`tools:` key. A round runs "with no tools offered" (`loop/rounds.ts:2-3`;
`step.ts:432-439`), and declared tools are dropped with a warning
(`AgentRun.ts:256-259`). Workflow agents are untouched, and they gain no
script access: they are document passes, not tool users.

| Agent                                                                           | Names today                                                                                | Becomes                                                      | Lane  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ----- |
| `assistant` (`tool_use_agents/assistant.yaml`)                                  | `delegate_agent` :52, `delegate_workflow` :53, `executions` :54, `memory` :10              | `agent`, `executions`, `memory`; plus `script` in stage "on" | 12, 3 |
| `orchestrator`                                                                  | `delegate_workflow` :7, `delegate_agent` :8, `executions` :9, `delegate_multi_agents` :17  | `agent`, `executions`, `script`                              | 12, 9 |
| `engineer`                                                                      | `delegate_agent` :8, `delegate_workflow` :9, `delegate_multi_agents` :12, `executions` :13 | `agent`, `executions`, `script`                              | 12, 9 |
| `leanOrchestrator` (`plugins/lean4/agents/`)                                    | `delegate_workflow` :8, `delegate_agent` :9, `delegate_multi_agents` :12, `executions` :13 | `agent`, `executions`, `script`                              | 12, 9 |
| `creator`                                                                       | `delegate_workflow` :13, `delegate_agent` :14                                              | `agent`                                                      | 12    |
| `setup`                                                                         | `delegate_agent` :27, `delegate_workflow` :28, `executions` :29                            | `agent`, `executions`                                        | 12    |
| `latexDiff`, `latexFixer`                                                       | `executions` :12, :13                                                                      | unchanged                                                    | —     |
| `progressCheck`                                                                 | `executions` :7, `memory` :12                                                              | unchanged                                                    | —     |
| `prover`, `simplifier`, `lean`, `leanBlueprint`, `leanSearch`, `leanSimplifier` | `memory`                                                                                   | unchanged                                                    | —     |

- **Under "only".** No YAML changes. The YAML list says which functions
  `tools` holds, and the binding decides whether the wire shows them
  directly or through `script` (Q3).
- **`memory` is injected anyway.** The `memory-workflow` plugin injects
  `memory` into every non-plugin tool-use run when memory is enabled
  (`pluginManifest.ts:94-104`; `AgentRun.ts:237-241`). The per-YAML
  `memory` entries are redundant, but they are harmless and stay.
- **The test fixture** `src/test-kernel/fixtures/storage/agents/golden_parent.yaml:8-10`
  changes with lane 12.

### Prompts that name old tools or patterns

All of these are rewritten in lane 12. The skill and guide are lane 8.

- `assistant.yaml:112-115`: "Use `delegate_agent` when …", `codex` and
  `claude_code` (kept), and `memory` (kept).
- `orchestrator.yaml`:
  - `:64-68` choose between `delegate_workflow` and `delegate_agent`; these
    become one rule ("name a workflow agent with files, or a tool-use agent").
  - `:80-84`, `:103-105` read results through `/executions/...` and
    `executions` wait (kept).
  - `:109` runs a progress check through `delegate_agent` (becomes `agent`).
  - The fan-out guidance in the `delegate_multi_agents` comment (`:11-16`)
    points at `script` from lane 9 on.
- `leanOrchestrator.yaml:49-51`, `:63-65`: the same pattern as the
  orchestrator.
- `engineer.yaml:35`, `:52`: "You delegate via `delegate_agent`".
- `creator.yaml:53`: test a new agent with `delegate_workflow` or
  `delegate_agent`.
- `setup.yaml:268`, `:273`.
- `R/docs/agent-creation/tool_catalog.md:61-64`, `:95-98`, `:169-171`, and
  `execution_and_testing.md:21`, `:38-57`.
- The tool descriptions that cross-reference these tools:
  `DelegationTools.ts:120`, `:223`; `codex.ts:491-494`;
  `claudeAgent.ts:563-564`; `agentCliShared.ts:305`.
- `memoryPromptSection.ts:33` picks the orchestrator variant through
  `hasDelegationTool`. It follows the name set in retirement item 1.

### Customized copies

- **What exists.** A customized copy records the digest of the built-in it
  started from as `basedOn` (`customAgentCopy.ts:52-64`).
  `changedBuiltInOf` compares it with the current built-in's digest
  (`agentRegistry.ts:164-172`). VS Code shows "A newer built-in version is
  available" (`newerBuiltInNotice.ts:26-27`), and the CLI prints the same
  with `texra agents reset` and `keep` (`packages/cli/src/runtime/agents.ts:297-299`).
- **What lane 12 changes.** Every built-in whose YAML changes gets a new
  digest, so every copy of it gets the notice. That covers copies of the
  six agents in the table above.
- **The gap.** A copy that names `delegate_agent` keeps that name. Today
  the name would be dropped with a warning in the log, and the agent would
  lose delegation without being told (retirement item 12).
- **Recommendation.** Retirement item 12 makes the run refuse to start,
  naming the tool and the file. Together with the notice, that is the
  migration path. 1.0 is a clean state, so no reader rewrites the YAML.
  A copy without `basedOn` gets no notice, but gets the same refusal.

### Skills

- `R/plugins/workflow-script/skills/multi-agent-orchestration/SKILL.md`
  (250) is the only skill that names these tools (`:3`, `:15`, `:17`).
  Lane 8 rewrites it in `await` form, with parent-routed coordination as
  the default pattern.
- The guides: `docs/guide/multi-agent-workflows.md:9-13`, `:34`, `:114`;
  `docs/guide/memory.md:29-43` (the commands stay, so this is unchanged
  until a script example is added). Lane 8.

## Parity inventory

`delegate_multi_agents` is deleted only when every row below is delivered
(lane 9). The last four subsections (`delegate_agent` and
`delegate_workflow`, `executions`, `memory`, messaging) gate lane 12
instead, or record that nothing changes. Each row was checked in the code at the baseline. "Today" gives the
evidence; paths are under `src/` unless they name a package. Abbreviations:
`Tool` is `tools/delegation/WorkflowScriptTool.ts`, `Runner` is
`tools/delegation/workflowScriptAgentRunner.ts`, `Strategy` is
`tools/delegation/workflowScriptStrategy.ts`, `Engine` is
`agent/workflowScript/runWorkflowScript.ts`, `README` is
`agent/workflowScript/README.md`, `Board` is
`packages/extension/src/progressView/frontend/components/WorkflowRunBoard.ts`,
and `Popup` is `packages/cli/src/chat/tui/panes/WorkflowPopup.tsx`.

Some things the request for this inventory listed do not exist today: there
is no pause control (a stop leaves a "paused" notice and nothing more,
`Strategy:390-395`), no cost budget, no per-call isolation option, and no
effort option beyond the model reference's `@effort` suffix.

### Input and launch

| Capability                                                                       | Today                                        | New home                                                                                 | Lane |
| -------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- | ---- |
| Inline script source                                                             | `Tool:100-106`                               | `script.code`                                                                            | 3    |
| Every source saved as a non-overwriting draft; the path is in every result       | `Tool:166-201`, `:213-228`; `Strategy:60-65` | `code` is saved under `.texra/scripts/`; every script result names the file              | 3    |
| Rerun a saved file by path                                                       | `Tool:107-113`, `:251-263`                   | `script.path`; the source read is pinned by `script.source`                              | 3    |
| JSON arguments as the global `args`                                              | `Tool:93-96`, `:116-122`                     | `script.args`                                                                            | 3    |
| Files bound by role as the global `files`                                        | `Tool:97-99`; `workflowScriptFiles.ts:8-14`  | `script.files`                                                                           | 3    |
| Files must exist; oversized `.bib` context refused                               | `Tool:314-329`                               | the same checks when `script` dispatches                                                 | 3    |
| Rerun reuses the prior checkpoint's args and files when omitted                  | `checkpoint.ts:377-389`; `Tool:299-311`      | **Narrowed.** Resume replays the call's own arguments; a new call passes them again (Q7) | —    |
| `meta.name` and `description` as heading and identity                            | `types.ts:33-36`; `Tool:294-298`             | `script.title` for display; identity is the call                                         | 3    |
| Tool-level default agent                                                         | `Tool:87-92`                                 | `agentName` is required on `agent`; a script keeps a constant                            | 4    |
| Agents must be visible workflow or tool-use agents inside `delegationAgentScope` | `Tool:282-288`; `Runner:131-166`             | `agent` resolves through `requireVisibleAgent` with the scope                            | 4    |
| Model availability checked before launch                                         | `Tool:347-353`                               | `agent` checks each call's model with `selectAvailableDelegationModel`                   | 4    |
| Syntax errors with location; imports refused                                     | `parseScript.ts:64-107`                      | `ScriptSyntaxError` with location; the realm has no module loader. The `await` hint goes | 3    |

### The `agent()` call

| Capability                                                                                | Today                                                 | New home                                                                             | Lane |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ | ---- |
| Workflow-agent call with input, context and media files; the file envelope                | `types.ts:171-176`; `Strategy:299-318`; README :92-98 | `agent` with the same options, returning the same envelope                           | 4    |
| Structured call: `schema` plus a tool-use `agentName`, read as `.structured`              | `types.ts:128-149`, `:187-214`                        | the same on `agent`                                                                  | 4    |
| Per-call `agentName`                                                                      | `types.ts:166-167`                                    | the same                                                                             | 4    |
| Per-call model, with reasoning effort through the `@effort` suffix                        | `types.ts:168-169`; `delegationAvailability.ts:237`   | the same                                                                             | 4    |
| An unavailable declared model aborts the whole workflow                                   | `Runner:59-83`                                        | **Narrowed.** `agent` rejects with `ModelUnavailable`, which a script can catch (Q7) | 4    |
| `id`, `label`, `phase` per call                                                           | `types.ts:157-165`                                    | `id` joins the reuse key; `label` is the card title; `phase()` sets the group        | 3, 4 |
| A later call takes an earlier call's outputs; the paths are checked against child lineage | `inputFields.ts:307-411`                              | moves into `agent`                                                                   | 4    |
| Editing a referenced file invalidates the cached result                                   | `inputFields.ts:413`; `Engine:51-67`                  | the file fingerprint is part of the reuse key                                        | 4    |
| A non-completed child, or a workflow child with no outputs, rejects `AgentFailed`         | `Runner:837-850`                                      | the same, as a `ToolFailed` named `AgentFailed`                                      | 4    |
| Children inherit the parent's bypasses; a bypassed proposal grants child edits            | `Runner:812-824`; `Tool:509-514`                      | `agent` configures child approvals from the script request's decision                | 4    |
| Children see at most the parent's offered tools                                           | `Runner:812`                                          | the same                                                                             | 4    |
| Children run in the parent's working directory                                            | `Runner:117-119`                                      | the same; no new isolation option                                                    | 4    |
| Children nest under the workflow run, so a kill cascades                                  | `Runner:85-96`                                        | under the calling run, or under the background script run                            | 4, 5 |
| Crash recovery from the child's own aggregate                                             | `Runner:640-729`                                      | moves into `agent`; refusals become the outcome-unknown request                      | 4    |
| Retry of an attempt keeps a durable supersession mark                                     | `Engine:662-697`; `workflow.attempt`                  | `tool.intent` at `attempt + 1`, committed before the interrupt                       | 4    |

### Control flow

| Capability                                                     | Today                           | New home                                                                                                                          | Lane |
| -------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `all()` and `forEach()` fan-out                                | README :107-111                 | `Promise.all` over `map`                                                                                                          | 3    |
| Fail-fast `all()` interrupts the siblings still running        | README :107-110                 | **Narrowed.** An uncaught rejection ends the script and interrupts every open call; a caught one leaves the siblings running (Q7) | 3    |
| `attempt()` for tolerant fan-out                               | README :112-114                 | `Promise.allSettled`, `try/catch`                                                                                                 | 3    |
| `retry()` without re-billing completed calls in the branch     | README :115-120                 | a loop; Q2 reuse keeps completed calls free                                                                                       | 3, 4 |
| `timeout(op, ms)` stops the child and throws `TimedOut`        | README :121-122                 | `agent`'s `timeoutMs`                                                                                                             | 4    |
| `all(items, { concurrency })`                                  | README :107; `Engine:170`       | **Narrowed.** The session budget bounds `agent`; a script batches for a smaller bound (Q7)                                        | 3    |
| Observable failures named `AgentFailed`, `TimedOut`, `Skipped` | README :123-128                 | the same names on the rejection                                                                                                   | 3, 4 |
| A script's own bug fails the run with up to three guest frames | README :279-282                 | `ScriptFault` with the same frames                                                                                                | 3    |
| `log()`, delivered to the model as an 80-line tail             | `Strategy:55-93`                | `console.log`; the tail rides on the script's result                                                                              | 3    |
| `phase()` groups calls                                         | `workflowScriptRun.ts:165-187`  | `phase()`, recorded on `script.call.phase`                                                                                        | 3    |
| Declared plan shows pending work before it runs                | `types.ts:38-43`; README :70-86 | **Gap**, Q6                                                                                                                       | —    |

### Limits

| Capability                                                | Today                                     | New home                                                | Lane |
| --------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------- | ---- |
| 30 s guest CPU; 64 MB heap; 1 MB stack                    | `sandbox.ts:40-49`                        | kept, enforced on the worker                            | 2    |
| 4096 items per `all()`                                    | `sandbox.ts:42`                           | at most 4096 nested calls open in one script            | 2    |
| Wall clock: 60 minutes, `meta.timeoutMs` from 1 s to 24 h | `types.ts:44-49`; `Engine:73`, `:176-177` | `script.timeoutMs`, same default and bounds             | 3    |
| 1000 live `agent()` calls per run; replays free           | `Engine:74`, `:603-605`                   | 1000 live `agent` calls per script; reused results free | 3    |
| Concurrency from the session's child-run budget           | `Strategy:290-294`                        | `agent` takes the budget (`runRegistry.ts:597-601`)     | 4    |

### Approval

| Capability                                                                                  | Today                                                                     | New home                                                              | Lane |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---- |
| One proposal for the whole script                                                           | `Tool:372-401`                                                            | the script request (Q5)                                               | 4    |
| Proposal shows name, agent, model, description, phases, cost warning, clickable script path | `ProposalRequestPanel.ts:98-101`, `:212-275`; `AgentProposal.tsx:100-131` | the script request shows title, source, args, files and the file path | 4, 6 |
| Approve; approve all agent work in this run; reject with a note; edit as new task           | `ProposalRequestPanel.ts:81-90`, `:133-139`; `proposalFlow.ts:139-144`    | the same four outcomes                                                | 4, 6 |
| Policy deny, run bypass, unattended approval                                                | `proposalFlow.ts:195-230`                                                 | the same decision function                                            | 4    |
| Consent: the agent's YAML names the tool and the global switch is on                        | `pluginManifest.ts:238-253`; `plugins.ts:69-74`                           | the same for `agent`                                                  | 4    |

### Running, delivery and resume

| Capability                                                                         | Today                                                                           | New home                                                                                                                 | Lane |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---- |
| Detached run: the call returns at once and the result arrives as a follow-up       | `Tool:593-603`; `Strategy:400-420`                                              | `run_in_background`: a detached child run with identity `{ kind: 'script', title }`, through `startDetachedChildRunLoop` | 5    |
| One-shot runs wait and return the report                                           | `Tool:574-591`                                                                  | in a one-shot run the script runs in the foreground, and its result says so                                              | 5    |
| A second launch of the same `meta.name` is refused while one runs                  | `Tool:407-418`                                                                  | **Dropped.** Each background script is its own run; completed calls are reused, in-flight ones are not (Q7)              | —    |
| Delivery: return value, run-log tail, script path                                  | `Strategy:400-420`                                                              | the script's `tool.result`, delivered as the follow-up when backgrounded                                                 | 3, 5 |
| `<workflow-summary>` line: tally, cost, duration, files with diffstat, path, cause | `workflowScriptDelivery.ts:13-23`; `Strategy:239-255`; `UserMessage.ts:189-235` | the same line, folded from the script's cards and its children's usage rows                                              | 5    |
| Stop leaves a "paused at X of Y calls" notice for the parent                       | `Strategy:390-395`; `childRun.ts:113-119`                                       | the stop notice names the run to resume                                                                                  | 5    |
| Resume after a crash, stop or timeout                                              | `Tool:668`; `checkpoint.ts:299-482`                                             | ledger replay: the run's own resume in the foreground, `resumeRun` on the script run in the background                   | 3, 5 |
| Edit and rerun without re-billing unchanged calls                                  | README :233-241                                                                 | Q2 reuse                                                                                                                 | 4    |
| `/executions/{id}` with a bounded board                                            | `ExecutionsTool.ts:378-386`; `workflowSummaryView.ts:22-24`, `:119-143`         | the script run's view lists its script stage's cards under the same bounds                                               | 5    |
| Kill the run (`executions` kill, `run.stop`, CLI `x`)                              | `ExecutionsTool.ts:420-450`; `Popup:363-365`                                    | unchanged: a background script is a child run                                                                            | 5    |
| Cost per call and in total, discarded attempts included                            | `workflowScriptRun.ts:89-119`                                                   | each child's usage rows; the script card sums its calls                                                                  | 5, 6 |
| Workflow outputs land in run storage and are accepted with `accept_run_files`      | `AcceptRunFilesTool.ts:482-498`                                                 | unchanged; a script may also call `tools.accept_run_files`, and each file still asks                                     | 4    |

### Board and controls

| Capability                                                                                | Today                                                   | New home                                                                                     | Lane |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---- |
| Rows with statuses queued, running, finished, reused, skipped, cancelled, failed, not run | `workflowCallProgress.ts:11-20`, `:242-262`             | nested cards; "Reused" from `reusedFrom`; "not run" for calls open when the script ended     | 6    |
| Row facts: kind, agent, model, attempt, files, duration, cost                             | `ui/copy/workflowCall.ts:46-69`                         | read from the `agent` input and the child run                                                | 6    |
| Phase tabs with tallies and badges                                                        | `Board:399-431`; `Popup:71-73`                          | grouped by `script.call.phase`                                                               | 6    |
| "Needs a decision", "Failed", "Running" sections; folded groups; Review button            | `Board:79-83`, `:127-146`, `:598-616`                   | the same over nested cards and the children's requests                                       | 6    |
| A row opens its child run                                                                 | `Board:527-537`                                         | the card's child-run link                                                                    | 6    |
| Skip and Restart on running rows; `s` and `r` in the CLI                                  | `Board:454-478`; `Popup:354-361`                        | `call.control { runId, callId, action }`: skip settles `Skipped`; retry starts `attempt + 1` | 4, 6 |
| Next failed, filter, glyph strip, phase and row keys                                      | `Board:658-683`; `Popup:98-110`, `:266-281`             | the same in the script stage view                                                            | 6    |
| Live elapsed time, tokens, tool count and spend per child                                 | `workflowRunModel.ts:93-97`, `:372-393`                 | the child run's live view, which every child already has                                     | 6    |
| Resume and "Edit as new task" on an ended run                                             | `BaseRunContent.ts:71-101`                              | the generic run content of the background script run                                         | 5, 6 |
| Headless `texra run` progress lines                                                       | `packages/cli/src/runtime/workflowPlainOutput.ts:35-63` | the same lines over the script stage                                                         | 6    |

### Plugin-facing

| Capability                                                                        | Today                                           | New home                                                                   | Lane |
| --------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- | ---- |
| The "Multi-Agent Workflow" switch, off on new installs, over the per-agent opt-in | `pluginManifest.ts:238-253`; `plugins.ts:69-74` | the same plugin and switch, contributing `agent`                           | 4    |
| The plugin ships the multi-agent-orchestration skill, hidden by the switch        | `plugins.ts:99-100`; `skillSources.ts:168-175`  | the same plugin ships the rewritten skill                                  | 8    |
| Built-in tool identity, revision `builtin`                                        | `catalogEntries.ts:87`                          | `agent` under `workflow-script`, `script` under `codemode`, both `builtin` | 3, 4 |

### Documentation

| Capability                                                                                                                                   | Today                                 | New home                          | Lane |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------- | ---- |
| User guide                                                                                                                                   | `docs/guide/multi-agent-workflows.md` | rewritten for scripts             | 8    |
| Fan-out patterns: per-item branches, adversarial verification, referee panel, loop until nothing new, completeness critic, staged escalation | `SKILL.md:26-61`, `:91-126`           | the same patterns in `await` form | 8    |

The guide is already wrong in five places, and the rewrite fixes them. It
puts skip and retry in the "subagent panel" with `k` to kill, where the code
has them in the workflow popup and kill on `x`. It calls the cached status
"Saved result", which the code labels "Reused". It says board rows show time
and cost, which the VS Code row does not. It implies the proposal card lists
the defaults, which only the CLI prints. And it never mentions the board's
Restart and Skip buttons. (`docs/guide/multi-agent-workflows.md:25-28`, `:106`.)

**Skip and retry.** `call.control` replaces `workflow.control`. It names the
nested call by `callId`, not by its child's run id, and the run that owns
the call handles it from the map of open nested calls it already keeps for
interruption. No session registry is needed. Skip interrupts the call and
settles it as an error named `Skipped`, with reason `user`. Retry commits
`tool.intent` at `attempt + 1` before interrupting the running attempt, so the
next attempt's child id is the free slot, and a crash between the two
resumes on the same fact. Skip applies to any nested call that is in flight.
Retry applies to `agent` calls and to tools that declare `replay: 'safe'`.

### `delegate_agent` and `delegate_workflow`

These rows gate lane 12, which deletes the two tools. They are not part of
lane 9's gate. `DT` is `tools/delegation/DelegationTools.ts`, `IF` is
`tools/delegation/inputFields.ts`, and `SR` is
`tools/delegation/subagentRun.ts`.

| Capability                                                                              | Today                                          | New home                                                                                                 | Lane |
| --------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---- |
| Launch a named tool-use or workflow agent with an instruction                           | `DT:143-158`; `IF:65-77`                       | `agent(prompt, { agentName })`; the category comes from the agent                                        | 4    |
| Detached by default: returns a run id, and the result arrives as a follow-up            | `SR:157-255`                                   | `background: true` in a script; the default when `agent` is called directly                              | 4    |
| A one-shot parent gets the result in-band                                               | `SR:123-155`                                   | the same automatic switch                                                                                | 4    |
| One proposal per call; the user may change the agent or model at approval, re-validated | `proposalFlow.ts:186-231`, `:276-320`          | a direct `agent` call keeps its own proposal; in a script, the script request (Q5)                       | 4    |
| Child approvals inherit the parent's bypasses                                           | `SR:109-119`; `proposalFlow.ts:210-220`        | unchanged                                                                                                | 4    |
| Workflow files: `inputFiles` (required), `contextFiles`, `mediaFiles`                   | `IF:78-89`                                     | the same options                                                                                         | 4    |
| `outputFiles` as a subset of the inputs                                                 | `IF:102-104`                                   | an `agent` option, workflow agents only                                                                  | 4    |
| `extractFigures`, `extractTikz`                                                         | `IF:90-101`                                    | `agent` options, workflow agents only                                                                    | 4    |
| Files must exist; a `.bib` over 100 KB is refused                                       | `DT:75-85`; `IF:217-301`                       | the same checks                                                                                          | 4    |
| `memories` attached to the child                                                        | `DT:156`; `IF:105`                             | an `agent` option                                                                                        | 4    |
| `working_directory`, gated on the worktree setting                                      | `DT:157`; `IF:122-143`, `:174-192`             | an `agent` option, tool-use agents only                                                                  | 4    |
| The hand-off wrapper: the root request and "your final response is delivered verbatim"  | `IF:144-166`                                   | unchanged, for tool-use agents                                                                           | 4    |
| Continue a tool-use child with a follow-up                                              | `DT:120`, `:223` (points at `executions send`) | `tools.executions.send`                                                                                  | —    |
| Model chosen: explicit, else the parent's, else the first available                     | `delegationAvailability.ts:199-252`            | unchanged                                                                                                | 4    |
| Agent visible in `delegationAgentScope`; scope passed to the child                      | `proposalFlow.ts:73-87`; `SR:101-105`          | unchanged                                                                                                | 4    |
| A child cannot declare an MCP server its parent was not offered                         | `agentToolResolution.ts:162-181`               | unchanged                                                                                                | 4    |
| Kill cascade through `parentRunId`                                                      | `SR:187-191`; `runRegistry.ts:304-330`         | unchanged                                                                                                | 4    |
| "Available agents" and "Available models" in the description                            | `agentToolResolution.ts:335-355`               | frozen with the system text; `describeTool('agent')` live; `contextUpdate` on change (retirement item 2) | 13   |
| Agents classified as orchestrators by naming a delegation tool                          | `delegationTools.ts:16-57`; seven call sites   | the name set becomes `{ agent }`                                                                         | 12   |

### `executions`

Every capability stays. The change is how a script calls it, as a namespace
(retirement item 3), plus two additions.

| Capability                                                                | Today                                              | New home                                                      | Lane |
| ------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------- | ---- |
| `view` of the eleven paths, paginated                                     | `ExecutionsTool.ts:171-307`; `pathCatalog.ts:7-58` | `tools.executions.view({ path, … })`                          | 7    |
| `view` is the default when `action` is omitted                            | `toolInput.ts:46-50`, `:157-177`                   | unchanged for direct calls; scripts name the function         | 7    |
| `wait` on one run or on a list, ending on a phase change or a new message | `ExecutionsTool.ts:101-133`, `:326-343`            | `tools.executions.wait`                                       | 7    |
| `kill`, direct parent only, under `ALLOW_ORCHESTRATOR_KILL`               | `ExecutionsTool.ts:418-468`                        | `tools.executions.kill`                                       | 7    |
| `send` to any run in the session, with its refusals                       | `send.ts:26-102`                                   | `tools.executions.send`; idempotent by `callId` (item 13)     | 3, 7 |
| `query`: read-only SQL over the history views                             | history-query note, phase 1                        | `tools.executions.query`; replaces phase 2 (item 11)          | 7    |
| `/executions/{id}` lists a workflow run's board                           | `workflowSummaryView.ts:22-24`, `:119-143`         | already in "Running, delivery and resume"                     | 5    |
| Replay: one `unsafe` declaration for all five actions                     | `ExecutionsTool.ts:801-821`                        | per-branch effect: `view`, `wait` and `query` are reads (Q10) | 13   |

### `memory`

Every capability stays, with the tool's own semantics (retirement item 4).

| Capability                                                                                        | Today                                          | New home                                     | Lane |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------- | ---- |
| `view`, `create`, `str_replace`, `insert`, `delete`, `rename`                                     | `MemoryTool.ts:72-136`, `:183-240`             | `tools.memory.view(...)` and the rest        | 7    |
| `pin`, `unpin`, with a cap of 10                                                                  | `MemoryTool.ts:552-593`; `constants.ts:9`      | `tools.memory.pin`, `.unpin`                 | 7    |
| Attribution frontmatter on every write; `view` strips it                                          | `MemoryTool.ts:255-271`; `memoryMeta.ts:27-38` | unchanged                                    | —    |
| View before modify, keyed by the display path                                                     | `MemoryTool.ts:274-283`                        | unchanged; it holds across calls in a script | —    |
| One lane per storage root; atomic writes                                                          | `memoryFileSystem.ts:105-138`                  | unchanged                                    | —    |
| No approval                                                                                       | `MemoryTool.ts:623-633`                        | unchanged                                    | —    |
| The prompt section, present when `memory` is offered, orchestrator variant by `hasDelegationTool` | `memoryPromptSection.ts:31-33`                 | unchanged; the name set changes with item 1  | 12   |

### Messaging

| Capability                                                                  | Today                                                         | New home                                               | Lane |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ | ---- |
| Any run messages any run in the session                                     | `send.ts:26-32`                                               | unchanged (Q12)                                        | —    |
| Refusals: self, unknown, workflow run, one-shot run, other process, stopped | `send.ts:39-70`; `ToolUseFollowUp.ts:326-350`                 | unchanged; a script sees `ToolFailed` with the reason  | —    |
| Messages read at the recipient's next turn boundary                         | `FollowUps.ts:166-196`                                        | unchanged; no mid-script read (Q13)                    | —    |
| Background child reports, progress and pause notices as follow-ups          | `childRunLoop.ts:502-620`, `:807-829`                         | unchanged; `agent({ background: true })` produces them | 4    |
| In-band result for a one-shot parent                                        | `inBandSubagentRun.ts:244-368`                                | unchanged; a foreground `agent()` uses the same runner | 4    |
| Inquiry answers and GitHub notices as follow-ups                            | `inquiryActions.ts:195-229`; `RunSubscriptionRegistry.ts:152` | unchanged                                              | —    |

## Storage and the freeze

The freeze writes each row kind's JSON Schema to `config/storage/frozen/` at
the 1.0 tag. After that:

- a released kind is read forever through upcasters;
- an unknown kind blocks its aggregate.

(`2026-09-28-storage-v1-design.md` §3, :413-467; `rowVersions.ts:13-17`.)
`config/storage/frozen/` does not exist yet, so every kind is still
unreleased.

The owner ruled that the freeze and the 1.0 tag come after parity and the
deletion (lane 9). Every change below therefore lands before the freeze, in
its version-1 shape, and none needs an upcaster:

| Change                                                                                                                                                             | Kind                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Delete `workflow.plan`, `workflow.call`, `workflow.script`, `workflow.journal`, `workflow.attempt`; aggregate kind `workflow-checkpoint`; `run.start.checkpointId` | removal, never released       |
| Run identity `multiAgentWorkflow` replaced by `script`                                                                                                             | changed union, before release |
| `script.call`, `script.source`                                                                                                                                     | new kinds                     |
| `tool.intent.responseId` becomes an origin union                                                                                                                   | changed shape, before release |
| `StageKind` gains `script`                                                                                                                                         | widened enum, before release  |
| `tool.binding` covers any guarded request                                                                                                                          | meaning only                  |

`call.control` is a session request (`runtimeRequest.ts`), not a stored row.
The order the lanes table gives is the order the freeze depends on: no
deletion runs ahead of its replacement, and the tag waits for lane 9.

### Pre-freeze row changes across proposals

Several proposals want a stored shape changed before the freeze. This table
collects them so the owner can sequence them. "Conflict" is with this
design's rows. Rows marked "owner ruling needed" come from the
harness-direction survey (coauthor-fc) and are proposals, not rulings; each
was checked against the code named in it.

| Owner proposal                                                        | Shape                                                                                                                                                                                                                                                                                                                                                                                                                      | Status                                                | Conflict with codemode                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codemode (this note)                                                  | The table above: `script.call`, `script.source`, the `tool.intent` origin, `StageKind` `script`, run identity `script`, and the deletion of the `workflow.*` kinds                                                                                                                                                                                                                                                         | Ruled (sequencing, 2026-10-01)                        | —                                                                                                                                                                                                                                                                                                                                                                                |
| Codemode, retirement item 10                                          | `DispatchFacts.replay` (`runLedgerEvent.ts:111`) becomes `effect: 'read' \| 'write' \| 'external'`                                                                                                                                                                                                                                                                                                                         | Owner ruling needed (Q10)                             | Its own. It should land with lane 3, so `script.call` stores `effect` too                                                                                                                                                                                                                                                                                                        |
| Codemode, retirement items 5 and 6                                    | `DispatchFacts.partition`, `.duplicateOf`; settlement `disposition: 'duplicate'`                                                                                                                                                                                                                                                                                                                                           | Stay at 1.0 (Q3)                                      | None. Retiring them after Q3 keeps their reader                                                                                                                                                                                                                                                                                                                                  |
| Refinement (coauthor-fc)                                              | Tag `tool.intent`'s origin union with `kind`: `{ kind: 'response', responseId } \| { kind: 'script', scriptCallId }`, like `run.start.origin` below                                                                                                                                                                                                                                                                        | Small call, taken: it costs nothing before the freeze | Changes this note's own row; lane 3                                                                                                                                                                                                                                                                                                                                              |
| Durable approvals, #13604 (lane 1)                                    | No new shape: `tool.binding` widens in meaning only                                                                                                                                                                                                                                                                                                                                                                        | Open PR                                               | None; it is lane 1                                                                                                                                                                                                                                                                                                                                                               |
| Always-on orchestrator, PRD #13354 (coauthor-46)                      | `run.start.origin { sessionRoot, runId }` for a run dispatched into another project's session; an optional wake time on a waiting run's `run.position`                                                                                                                                                                                                                                                                     | PRD open, not ruled                                   | None in rows. The PRD will target `agent({ project })` and a `project` field on `executions`. `agent()`'s options should not reserve `project` until that PRD is ruled: an unused option is a speculative knob, and adding one later is not a stored-shape change                                                                                                                |
| A. One view-edit kind (coauthor-fc)                                   | Widen `model.compaction` into `{ op: 'compact' \| 'fold' \| 'drop' \| 'pin' \| 'unpin' \| 'rewind', by: 'harness' \| 'model', targets: { fromSeq, toSeq } \| { callIds } \| null, keepPrefix, messages, cause, continuation, usage }`. `compact` is today's row; `rewind` is #13546's row plus its `files.changed` restore. The prompt stays a projection of these rows. Fallback: three kinds sharing one `targets` shape | Owner ruling needed (Q15)                             | Checked: `model.compaction` is "the only row that shortens history" (`runLedgerEvent.ts:275-287`), and it resets the frozen system text (`runStateFold.ts:557-575`). A model-driven fold must edit only the suffix and leave the frozen system text and the declarations alone, or every fold costs a cache rebuild. #13546 (per-step snapshots and rewind) is an open design PR |
| B. Fork as a `run.start.origin` arm (coauthor-fc)                     | `origin` becomes a tagged union: `… \| { kind: 'fork', parentRunId, atSeq }`. The child's prefix is the parent's rows up to `atSeq`, by reference. The merge needs no row: the child's value is the nested call's `tool.result`. The surface is `agent(prompt, { inherit: 'none' \| 'full' })`, default `'none'`, not a new global                                                                                         | Owner ruling needed (Q16)                             | The Q2 reuse key must include `(parentRunId, atSeq)` when `inherit` is `'full'`. Fork and rewind must refuse to strand a pending approval, which #13604's bound requests make checkable. It shares `run.start.origin` with #13354, so the two should be ruled together                                                                                                           |
| C. Run-lifetime kernel (coauthor-fc)                                  | No row change. If every script in a run shares one realm, cell N is rebuilt by replaying cells 1 to N−1 from their `script.call` and `tool.result` rows, which needs `seq` per script call (it has one) and one stage per cell                                                                                                                                                                                             | Owner ruling needed (Q11)                             | None in rows, provided no row names a realm. Lane 2's "fresh runtime per script" is a semantics choice, not a shape                                                                                                                                                                                                                                                              |
| D. Grants replaced by effect-derived scope (coauthor-46, coauthor-fc) | The script request's grant (Q5) covers calls by effect class instead of by tool name                                                                                                                                                                                                                                                                                                                                       | Owner ruling needed (with Q10)                        | Q5 grants `agent` calls only. A grant derived from `effect` would widen it to every `write` call in the script; see Q10                                                                                                                                                                                                                                                          |

Not rows: a budget shared by a whole agent tree would be a setting and a
runtime check (Q14), and a verifier-picked merge is script code.

## Peer comparison

|              | TeXRA (proposed)                                                                 | pi                                                                                                                  | Codex Code Mode                                                                                  |
| ------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Engine       | QuickJS WASM, worker thread, one per session                                     | QuickJS WASM (`quickjs-wasi`), worker per call (`host.ts:155`)                                                      | V8 in a separate host process (`connection.rs:157-169`)                                          |
| VM lifetime  | Fresh runtime per script                                                         | Fresh worker and VM per call (`host.ts:81-86`)                                                                      | Fresh isolate per cell; cells outlive turns (`code_mode/mod.rs:356`)                             |
| Limits       | 64 MB heap, 30 s CPU, wall deadline                                              | 256 MB heap, no timeout by default (`execute.ts:52-57`, `:385`)                                                     | Heap and limits plumbed but unapplied (`service.rs:42-63`); 10 s yield, no timeout               |
| Nested calls | Real tool calls: policy, ledger rows, nested cards                               | Same pipeline as direct; recorded only as bounded `nestedCalls` on the parent result (`nested-tool-calls.ts:26-31`) | Same `ToolCallRuntime`, approvals and Guardian; best-effort record (`executed_tool_calls.rs:60`) |
| Durability   | Replay from the ledger in commit order; approvals survive restart                | None; `store()` entries persist on success (`execute.ts:406-410`)                                                   | None; `store` is in memory (`session_runtime/mod.rs:46-49`)                                      |
| Discovery    | Typed declarations inline; MCP and plugin tools via `searchTools`/`describeTool` | 3,000-token inline budget, BM25 search (`tool.ts:154-156`, `execute.ts:459-479`)                                    | Inline list only in code-mode-only; deferred via `ALL_TOOLS` (`description.rs:295-360`)          |
| Default      | "on", then "only" after evaluation                                               | Off; auto-on when an MCP server opts in (`index.ts:41`)                                                             | Off, under development (`features/src/lib.rs:1089-1094`)                                         |

The one property TeXRA has that neither peer has is that a script survives a
restart with its finished calls intact. That follows from the run ledger, not
from the sandbox.

## Owner rulings (2026-10-01)

The owner's direction: "i want to be as future looking as possible. but also
it should cover everything that delegate_multi_agents can do."

1. **Q1. `await` or `yield*`: `await`.** `await tools.x()` with a job-queue
   drain in the realm. This reverses the 2026-09-25 generator ruling
   (`.agents/docs/implemented/architecture/2026-09-25-workflow-script-generator-protocol.md`)
   because it is the form models write best and the form pi and Codex use.
   The commit-order delivery rule keeps replay exact.
2. **Q2. Reuse of `agent` results: yes, for `agent` only.** A completed
   `agent` result whose key hashes the same is reused within a run (see
   "Resume and replay").
3. **Q3. The per-model direct fallback stays** until the nightly data says
   otherwise. Retiring it is a later, separate decision, and until then
   response partitioning and duplicate detection stay.
4. **Q4. Every declared tool is inlined as a typed declaration.** The
   nightly comparison may revise this.
5. **Q5. One approval request per script.** It shows the script's source
   and grants that script's `agent` calls, like a `bash` command grant.
6. **`searchTools` ranks with BM25, and `describeTool` stays.** The owner:
   "searchTools (BM25), describeTool are good ideas". "Prompt and cache"
   gives the fields indexed, as pi indexes them, and recommends a small
   ranker over FTS5. `describeTool` also accepts a namespace name, in place
   of a separate `describeNamespace`.

Two more rulings set the order of work:

- **Parity before deletion.** `delegate_multi_agents` is deleted only in
  the same change set as a script tool that covers everything it does, or
  after it. There is no window without the capability.
- **Freeze sequencing.** The 1.0 storage freeze and tag move after parity
  and the deletion, so the five `workflow.*` row kinds are never released.

## Open questions for the owner

1. **Q6. A successor to the declared plan?** `meta.tasks` lets a board show
   pending work before it runs (`types.ts:38-43`). Each plan entry is a
   label, not a call: nothing guarantees the script reaches it (README
   :76-86). A successor would be a `plan(labels)` global recorded on the
   script's first row, shown as "Not started" rows until calls claim them.
   _Recommended: no successor._ The script request already shows the whole
   source before anything runs, and the rows that matter are the issued
   calls.
2. **Q7. Accept the five narrowings?** The inventory marks five places where
   the new surface does less:
   - a rerun does not inherit the previous run's args and files;
   - an unavailable declared model fails the call, which a script can
     catch, instead of aborting the workflow;
   - a caught `Promise.all` rejection does not interrupt its siblings;
   - `all()`'s per-call `concurrency` bound is gone; the session budget
     still applies;
   - two background runs of the same script are not refused; only completed
     `agent` calls are shared between them.

   _Recommended: accept all five._ Each follows from a script being plain
   JavaScript over ordinary tool calls, and none loses a result or bills
   twice for completed work. Restoring any of them would bring back an
   engine-level concept the design deletes.

3. **Q8. Replace `delegate_agent` and `delegate_workflow` with `agent`?**
   One tool with the union of their options; detached when called directly,
   awaited in a script unless `background: true` (retirement item 1).
   `claude_code` and `codex` stay separate.
   _Recommended: yes, deleted in lane 12 before 1.0._ The two tools differ
   only by agent category, which the named agent already decides, and the
   proposal flow and child launch are already shared. One tool means one
   description and one set of availability lists, instead of up to three
   copies.
4. **Q9. Unify `memory` and `executions` with the file tools?** The owner
   asked whether they could be unified. A mount table under `read_file` and
   `edit_file` was costed and refuted (retirement item 4): memory writes
   would start asking for approval and firing `Edit` hooks, the
   frontmatter and pin cap could be bypassed, and nine of executions' eleven
   paths are computed views.
   _Recommended: no mount table._ Both become namespaces in scripts
   (`tools.memory.pin`, `tools.executions.wait`), which gives the typed,
   uniform surface without changing what either tool does.
5. **Q10. One effect class?** Replace `replay` with
   `effect: 'read' | 'write' | 'external'`, declared per branch where a
   union tool needs it, and derive `parallelSafe` from it once the eight
   serial reads are checked (retirement item 10). It changes the stored
   `DispatchFacts`, so it must land before the freeze. A related question
   is whether the script request's grant should then cover calls by effect
   (freeze table, row D).
   _Recommended: yes for `replay`, before the freeze; `parallelSafe`
   follows when the check allows; keep Q5's grant to `agent` calls._
   Widening the grant to every `write` would let one approval cover file
   edits the user has not seen, which today's per-edit review exists to
   prevent.
6. **Q11. One realm per run, or a fresh runtime per script?** The survey
   proposes a kernel that lives for the whole run (context as a variable,
   tools preloaded), rebuilt on resume by replaying earlier cells from
   their rows. Lane 2 ships a fresh runtime per script.
   _Recommended: ship per script now, and keep the protocol open._ That
   costs nothing today if no row names a realm and `script.call` stays keyed
   by `scriptCallId` and `seq`, which it is. A run-lifetime kernel replays
   every earlier cell on resume, so its resume cost grows with the run;
   decide it with a measurement, not before.
7. **Q12. Who may message whom?** Today any run may message any run in the
   project (session-messaging decision 8). The survey argues for routing
   through the parent ("How agents talk to each other").
   _Recommended: keep decision 8 in the tool, make parent-routed
   coordination the default pattern in the skill, and add a nightly pair
   of fan-out journeys (parent-routed against peer messaging, equal token
   budgets)._ If peers show no gain on our eval, narrowing `send` to the
   supervision tree is a one-line rule.
8. **Q13. A mid-script `receive()`?** It would consume pending messages
   inside a script, reversing decision 4 (messages land at the turn
   boundary).
   _Recommended: no._ Results a script awaits are `agent()` values, reports
   from background children arrive at the next boundary, and
   `executions.wait` plus `view` read a child's state without consuming
   anything.
9. **Q14. One budget for an agent tree?** Concurrency already has a session
   budget (`childRunBudget`); cost has none. A pattern cannot enforce a
   budget, so this would be a primitive: a setting and a runtime check.
   _Recommended: not now._ Add it when a run is seen to overspend; the
   proposal stays recorded here.
10. **Q15. One view-edit kind?** Widen `model.compaction` into one row for
    compact, fold, drop, pin, unpin and rewind, or keep three kinds with one
    `targets` shape (freeze table, row A).
    _Recommended: decide before the freeze, together with #13546._ One
    kind is the smaller frozen surface, since all six operations shorten or
    reshape the history the prompt is projected from. Model-driven folds
    must edit only the suffix and never re-render the frozen system text.
    This note adds no fold operation itself.
11. **Q16. A full-context fork?** `agent(prompt, { inherit: 'full' })` with
    `run.start.origin` gaining a `fork` arm (freeze table, row B).
    _Recommended: rule `origin`'s shape with #13354 before the freeze, as a
    tagged union from the start, and build the fork after lane 4._ A union
    widened later is additive, but turning a plain `origin` struct into a
    union after the freeze is a shape change. Fork and rewind refuse when
    they would strand a pending approval.
12. **Q17. The flip bar.** Replace "three consecutive nightlies" with the
    pooled window in "Rollout and evaluation" (60 tasks per arm per model,
    pass rate, cost and latency).
    _Recommended: yes._ Three nights of four journeys is 12 tasks per arm,
    which cannot tell a 10-point difference from noise.

## Lanes

The parity gate is lane 9. It merges only when every row of "Parity
inventory" is delivered, and the 1.0 freeze and tag follow it.

| Lane | Work                                                                                                                                                                                                                                                                                                                                                                                                                                  | Effort                               | Depends on                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| 1    | Durable approvals: bind every guarded request with `tool.binding`; park at `waiting`; re-attach on resume. Direct calls benefit at once. In flight as #13604                                                                                                                                                                                                                                                                          | M                                    | none                                                                                |
| 2    | `CodeSandbox` service: worker entry in four bundles, Effect RPC over `NodeWorker`, `settle`/job-drain realm, shared interrupt flag, `BARE_EFFECT_RUN_SITES` entry, the limits. No row names a realm (Q11)                                                                                                                                                                                                                             | L                                    | none (Q1 ruled); coordinate the worker-shipping table with the database-worker note |
| 3    | `script` tool under the `codemode` plugin: `script.call` (with `phase`) and `script.source`, `tool.intent` origin tagged with `kind`, `script` stage kind, nested dispatch through the per-call program, namespace dispatch for union tools, commit-order replay, `ScriptDiverged`; `code`/`path`/`title`/`args`/`files`/`timeoutMs`, drafts, call cap, run-log tail; `executions send` idempotent by `callId` (retirement item 13)   | L                                    | 1, 2                                                                                |
| 4    | `agent` tool under `workflow-script`: options and envelope, file hand-off and fingerprint, post-conditions, child approvals, recovery with refusals as outcome-unknown, child id from `(callId, attempt)`, `timeoutMs`, Q2 reuse, Q5 script request, `call.control` skip and retry; the `delegate_*` options (`outputFiles`, `extractFigures`, `extractTikz`, `memories`, `working_directory`, the hand-off wrapper) and `background` | L                                    | 3                                                                                   |
| 5    | Background scripts: `run_in_background`, `script` run identity, detached delivery and the summary line, stop notice, `resumeRun`, `/executions` view, one-shot foreground                                                                                                                                                                                                                                                             | M                                    | 3, 4                                                                                |
| 6    | Renderers in the three hosts: the script stage board (rows, phase tabs, sections, Review, Skip and Restart, next failed, CLI popup keys), headless lines, the script request panels                                                                                                                                                                                                                                                   | L                                    | 3, 4, 5                                                                             |
| 7    | Prompt: declarations rendered and frozen with the system text, union tools as namespaces (token cost measured first); BM25 `searchTools` and `describeTool` (namespaces included) over the pinned snapshot, MCP included; `contextUpdate` for catalog changes                                                                                                                                                                         | M                                    | 3                                                                                   |
| 8    | Docs and skill: rewrite the guide and the multi-agent-orchestration skill for scripts, parent-routed coordination as the default pattern; `tool_catalog.md` and `execution_and_testing.md`                                                                                                                                                                                                                                            | S                                    | 4, 5                                                                                |
| 9    | **Parity gate and deletion.** Delete `delegate_multi_agents`, its engine half, renderers, the five row kinds and `multiAgentWorkflow` (list above). **Requires every parity row delivered**                                                                                                                                                                                                                                           | M (deletion, ~15k lines incl. tests) | 3, 4, 5, 6, 8; then the 1.0 freeze and tag                                          |
| 10   | Evaluation: fix the live-journeys matrix keys, add gemini38f, the fan-out journey in its parent-routed and peer forms, three runs per journey per arm, the pooled five-night window; `direct` vs `only` per model on pass rate, cost and latency; per-model flag on `BoundModel`                                                                                                                                                      | S                                    | 3, 7                                                                                |
| 11   | Flip the default to "only"                                                                                                                                                                                                                                                                                                                                                                                                            | S                                    | 10 meeting the bar                                                                  |
| 12   | **Retire the delegation pair and adapt the agents.** Delete `delegate_agent` and `delegate_workflow` (requires the `delegate_agent` and `delegate_workflow` parity rows); `hasDelegationTool`'s name set becomes `{ agent }`; the six built-in YAMLs and their prompts, the creator docs, the tool descriptions that cross-reference them, the test fixture; a declared unknown built-in tool refuses the run (retirement item 12)    | M                                    | 4; before the 1.0 freeze                                                            |
| 13   | **Tool declarations.** Freeze the delegation availability text with the system text and delete the per-step rewrite (retirement item 2, can start now); `effect` replaces `replay`, per branch where needed, in `ITool` and `DispatchFacts` (Q10)                                                                                                                                                                                     | S                                    | none for the first part; the second before lane 3 lands and before the freeze       |

Lanes 1, 2 and the first half of 13 can start today and do not touch each
other. Nothing is
deleted ahead of its replacement: until lane 9, `delegate_multi_agents` and
the new tools ship side by side, and the `workflow-script` plugin contributes
both. Likewise `delegate_agent` and `delegate_workflow` stay until lane 12.

## Verified

- Read on `main` at `35909133bd`:
  - `src/agent/workflowScript/{sandbox,interpreter,determinismPrelude}.ts`
    and `README.md`;
  - `src/agent/core/tools/ToolTypes.ts`;
  - `src/agent/runtime/run/{tools,toolSchema,requestContext}.ts`;
  - `src/agent/runtime/loop/toolUseDispatch.ts` (dispatch, settle,
    partitions);
  - `src/shared/schemas/{runLedgerEvent,traceEvent,toolResult,toolDefinition}.ts`;
  - `src/tools/registry.ts`;
  - `orchestrator.yaml` and `assistant.yaml`;
  - `src/test-kernel/architecture/dependencyDirection.vitest.ts`;
  - the generator-protocol, storage-v1 and database-worker notes.
- For the parity inventory, read on the same baseline:
  - `src/tools/delegation/{WorkflowScriptTool,workflowScriptRun,workflowScriptStrategy,workflowScriptAgentRunner,inputFields,proposalFlow,delegationAvailability}.ts`;
  - `src/agent/workflowScript/{types,parseScript,runWorkflowScript,checkpoint}.ts`;
  - `src/agent/runtime/workflowControlRegistry.ts`,
    `src/shared/session/runtimeRequest.ts`,
    `src/controllers/session/SessionRequests.ts`;
  - `src/shared/runs/workflowRunModel.ts`,
    `src/shared/schemas/{workflowCallProgress,workflowScriptDelivery,workflowScriptFiles,runIdentity}.ts`,
    `src/tools/executions/workflowSummaryView.ts`, `src/tools/ExecutionsTool.ts`,
    `src/tools/AcceptRunFilesTool.ts`, `src/tools/bash.ts` (background
    delivery);
  - `WorkflowRunBoard.ts`, `WorkflowRunContent.ts`, `ProposalRequestPanel.ts`,
    `WorkflowPopup.tsx`, `WorkflowPopupRows.tsx`, `AgentProposal.tsx`,
    `approvalSummaries.ts`, `workflowPlainOutput.ts`;
  - the multi-agent-orchestration `SKILL.md` and
    `docs/guide/multi-agent-workflows.md`;
  - `src/tools/{pluginManifest,plugins,liveRegistry,liveTools,catalogEntries,serverHolds}.ts`,
    `src/agent/runtime/loop/{step,hooks}.ts`,
    `src/shared/schemas/offeredTools.ts`, `src/common/plugins/pluginTrust.ts`;
  - the core-concepts note, the plugin-architecture note and the hooks-v1
    note. The `critique.md` and `effect-mapping.md` beside core-concepts
    predate the 2026-09-30 ruling and were read as history only.
- Read the code to confirm `NodeWorker.layerPlatform`'s close-then-terminate
  finalizer (`@effect/platform-node` `NodeWorker.js:28-53`) and the RPC
  worker protocol layers.
- Measured the token figures above with the production `toolDefinitionsFor`
  over all 52 registered tools. The scratch test was deleted.
- Read the peer code: pi at `origin/main` (`packages/codemode`,
  `packages/coding-agent/src/extensions/codemode`), and Codex `codex-rs`
  crates `code-mode*` and `core/src/tools/code_mode`.
- For "What code mode retires", "How agents talk to each other" and
  "Adapting the agents", read on the same baseline:
  - `src/tools/delegation/{DelegationTools,inputFields,proposalFlow,subagentRun,inBandSubagentRun,detachedChildRun,childRun,delegationAvailability}.ts`,
    `src/agent/runtime/agentToolResolution.ts`, `src/tools/catalogEntries.ts`,
    `src/shared/constants/delegationTools.ts`, `src/tools/{claudeAgent,codex,agentCliShared}.ts`;
  - `src/tools/ExecutionsTool.ts`, `src/tools/executions/{toolInput,send,pathCatalog,killPolicy,waitCoordination}.ts`;
  - `src/tools/memory/*`, `src/tools/{ReadTool,EditTool,WriteTool,glob,grep,pathResolution,fileEditFlow,fileInteractions}.ts`,
    `src/tools/approval/{toolEditApproval,approvedWrite}.ts`,
    `src/platform/{rootedFs,defaults/nodeStorage,defaults/workspaceStorage}.ts`;
  - the eight union-input tools, `src/agent/runtime/run/{tools,toolSchema}.ts`,
    `src/agent/core/tools/{ToolTypes,toolCallParsing}.ts`,
    `src/tools/core/inputSchema.ts`, and the zod 4 `preprocess` and
    `toJSONSchema` pipe code in `node_modules/zod`;
  - `src/agent/followUp/*`, `src/agent/runtime/{FollowUps,childRunLoop,RunHandle}.ts`,
    `src/shared/schemas/{followUp,sessionEvent,runLedgerEvent,prompts,runIdentity}.ts`;
  - every built-in agent YAML, `tool_catalog.md`, `execution_and_testing.md`,
    the multi-agent-orchestration skill, `customAgentCopy.ts`,
    `agentRegistry.ts`, `newerBuiltInNotice.ts`;
  - `config/ratchets/refuted-candidates.json` (no entry covers these items);
  - the session-messaging and executions-history-query notes.
- Ran `node:sqlite` on Node 26.9.0 to confirm FTS5 is compiled in and that
  `unicode61` does not split camelCase. Read pi's BM25 ranker and discovery
  globals at `origin/main` (`6f1072cc0`).
- External figures in this note come from the harness-direction survey
  (coauthor-fc, "Where Harnesses Are Going", 2026-10-01,
  https://claude.ai/artifact/FNYhVNuUjQY6hxordqbbhx, owner-private). They
  were not re-checked and gate nothing.
- Not run: any live model, the nightly journeys, or a prototype of the
  `settle` realm.
