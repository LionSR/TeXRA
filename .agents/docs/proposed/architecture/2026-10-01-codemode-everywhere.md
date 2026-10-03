---
created: 2026-10-01
status: accepted
---

# Codemode everywhere: every tool call goes through one script tool

Baseline: `main` at `35909133bd`. Line references point into that tree.

## Summary

The model gets one tool, `script`. Its argument is a JavaScript program that
calls TeXRA's tools as `await tools.read_file({ path })`. Every nested call is
an ordinary tool call: it passes the core approval policy, it is written to
the run history, and its card nests under the script's card. When a run
resumes, the script runs again from the top. Calls that finished are replayed
from the run history in the order they settled. A call that was still in flight
follows the `replay: 'safe' | 'unsafe'` rule that direct calls already follow.

The engine is the QuickJS sandbox the workflow-script tool already ships
(`src/agent/workflowScript/sandbox.ts`), moved onto a worker thread behind an
Effect service. `agent()` becomes an ordinary tool, so a workflow script is
just a script, and four things go: the `delegate_multi_agents` tool, its
`yield*` generator protocol, its content-keyed checkpoint journal, and its
five workflow row kinds.

Rollout has two stages: **"on"**, where `script` sits beside the direct
tools, and **"only"**, where it is all the model sees. The switch happens when
the nightly live journeys show "only" is no worse.

Two owner rulings set the order of work:

- **Parity before deletion.** `delegate_multi_agents` is deleted in the same
  change set as the script tool that covers everything it does, or after it.
  "Parity inventory" lists every capability and where it lands.
- **The freeze waits.** The 1.0 storage freeze and tag move after parity and
  the deletion, so the five `workflow.*` row kinds are never released.

Measured on the real tool definitions (method under "Prompt and cache"):

| Agent                            | Tools | Today (JSON schemas) | Script tool, all declarations inline |
| -------------------------------- | ----: | -------------------: | -----------------------------------: |
| Default `assistant`              |    41 |        13,885 tokens |                        ~2,400 tokens |
| Every built-in tool, all plugins |    52 |        18,182 tokens |                        ~2,850 tokens |

The larger win is the prompt cache. System text is frozen per run today
(`requestContext.ts:168-195`), but the tool list is not, so any change to it
breaks the cached prefix from the tools onward. Under "only", the wire carries
one tool whose text is frozen with the system text.

## Cut from this design

The owner asked (2026-10-01) that the design "cut anything that is
excessive". These items were in earlier revisions of this note. "Deleted"
means the idea is dropped; "pointer" means it belongs to another proposal and
is listed under "Other proposals touching the freeze"; "later" means it is
real but waits until after the flip, listed under "Later".

| Item                                                                                                                                                        | Why                                                                                                                                                                                                                                    | Where it went |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Raw source with an `// @options:` line (old Q18), and an OpenAI custom-grammar tool                                                                         | Every non-OpenAI route escapes the code inside JSON anyway; a JSON object needs no comment-line parser, no line blanking and no refusal for the old shape. The grammar tool helps one dialect                                          | deleted       |
| Output budget with a spill file and `max_output_tokens`                                                                                                     | No one has hit it. The log keeps today's 80-line bound and the result goes through the existing per-result cap (`toolResultText.ts:20-21`, `:53-71`)                                                                                   | deleted       |
| Recovery errors: close-match `Proxy` on `tools`, the declaration attached on schema errors                                                                  | A missing member already throws a `TypeError`; a nested call that fails its schema gets the same worded validation error a direct call gets                                                                                            | deleted       |
| Namespace renderer and dispatch for the eight union-input tools; tool families as namespaces; `searchTools`'s `namespace` option; `describeTool(namespace)` | A `z.discriminatedUnion` input already renders as a typed TypeScript union of its branches through `toJSONSchema` with `io: 'input'` (`toolJsonSchema.ts:4-8`). The namespace layer deleted nothing                                    | deleted       |
| Mount table putting `/memories` and `/executions` under the file tools (old Q9)                                                                             | Refuted: memory writes would ask for approval and fire `Edit` hooks, the frontmatter and pin cap could be forged, and nine of executions' eleven paths are computed views (`MemoryTool.ts:255-271`, `:623-633`; `pathCatalog.ts:7-58`) | deleted       |
| One effect class replacing `replay` and `parallelSafe` (old Q10, freeze row D)                                                                              | Code mode runs on the two flags as they are; the change stands on its own                                                                                                                                                              | pointer       |
| View-edit kind (old Q15), fork as a `run.start.origin` arm (old Q16), #13354 origin and wake time                                                           | Other proposals' row shapes; nothing here depends on them                                                                                                                                                                              | pointer       |
| Run-lifetime kernel (old Q11)                                                                                                                               | No problem it solves today; per-script realms name no realm in any row, so the door stays open                                                                                                                                         | deleted       |
| Mid-script `receive()` (old Q13), a cost budget per agent tree (old Q14)                                                                                    | Both answered "no" / "not now"                                                                                                                                                                                                         | deleted       |
| Who may message whom (old Q12) and the parent-vs-peer journey pair                                                                                          | Messaging policy, not code mode; decision 8 of the session-messaging note stands                                                                                                                                                       | pointer       |
| `executions send` idempotent by `callId` (old item 13)                                                                                                      | An in-flight send at a crash asks the outcome-unknown question, as a direct send does today                                                                                                                                            | later         |
| Duplicate detection, response partitioning, `.nullish()` relaxation (old items 5 to 7)                                                                      | Only after the per-model fallback retires (Q3)                                                                                                                                                                                         | later         |
| Three-arm Q4 comparison (typed core list, pi's 3,000-token budget)                                                                                          | Q4 is ruled; the flip only needs `direct` against `only`                                                                                                                                                                               | later         |
| Harness-boundary lint (old lane 14) and the split seams list                                                                                                | Two new directories with no domain imports need no rule yet; the split doc owns the boundary                                                                                                                                           | pointer       |
| Durable approvals (old lane 1)                                                                                                                              | Its own PR, #13604; code mode works without it, as direct calls do                                                                                                                                                                     | pointer       |
| `call.control` and the session request for per-call skip and retry                                                                                          | Skip is a stop of the child run, which every host already offers; per-call restart is dropped (Q9)                                                                                                                                     | deleted       |
| `script.source`, drafts under `.texra/scripts/`, `path`, `args`, `files`                                                                                    | Only needed to rerun a saved file; dropped (Q8)                                                                                                                                                                                        | deleted       |
| Board cosmetics: tab tallies and badges, next-failed, filter, glyph strip, phase and row keys, live counters                                                | Not capabilities; the capabilities they sat on stay in the inventory                                                                                                                                                                   | deleted       |
| Peer comparison table, pi's `store()` and `models.*` divergence                                                                                             | Prior art, not design; two sentences remain under "Prior art"                                                                                                                                                                          | deleted       |
| Nightly matrix fixes                                                                                                                                        | Landed in #13599                                                                                                                                                                                                                       | deleted       |
| The five errors in the current guide                                                                                                                        | The guide is rewritten in lane 7                                                                                                                                                                                                       | deleted       |

## What gets deleted

### In the parity change set (lane 7)

Line counts come from `wc -l` at the baseline.

- **Engine, `src/agent/workflowScript/`.** `interpreter.ts` (214), whose
  `Branch`/`All`/`Attempt`/`Retry`/`Timeout` combinators
  (`interpreter.ts:131-187`) become `try/catch`, `Promise.all`,
  `Promise.allSettled` and loops. The generator half of `sandbox.ts`
  (`:62-379`, `:432-557`); the realm setup, limits and `evaluate` stay
  (`:40-60`, `:381-430`, `:560-618`). `runWorkflowScript.ts` (860),
  `checkpoint.ts` (482), `parseScript.ts` (195), `types.ts` (461),
  `workflowRunState.ts` (448) and `README.md` (321).
- **Tool layer.** `WorkflowScriptTool.ts` (671), `workflowScriptRun.ts`
  (284), `workflowScriptStrategy.ts` (422); `workflowScriptAgentRunner.ts`
  (860), whose child launch and recovery move into `agent`;
  `executions/workflowSummaryView.ts` (143).
- **Runtime and session.** `workflowControlRegistry.ts` (51); the
  `workflow.control` request (`runtimeRequest.ts:87-92`,
  `SessionRequests.ts:488-498`) and its hooks in `SessionHandle.ts` (`:96`,
  `:302`, `:354`); the interrupted-card write at close
  (`sessionLayer.ts:838`); the workflow branches of `sessionFold.ts`
  (`:676-677`, `:705-728`, `:799`, `:855`) and `transcriptFold.ts`
  (`:186-223`).
- **Shared schemas and copy.** `workflowRunModel.ts` (576),
  `workflowCallProgress.ts` (325), `workflowScriptDelivery.ts` (27),
  `workflowScriptFiles.ts` (16), `ui/copy/workflowScriptProposal.ts` (30) and
  most of `ui/copy/workflowCall.ts` (197); the workflow-script branches of
  `prompts.ts:89-101`; the `multiAgentWorkflow` run identity
  (`runIdentity.ts:27`, `:48`; `icons.ts:97`; `executionFormatters.ts:64`;
  `RunTab.ts:85`), replaced by `script`; `WORKFLOW_TASK` (`log.ts:28`).
- **Rows.** `workflow.plan`, `workflow.call`, `workflow.script`,
  `workflow.journal`, `workflow.attempt` (`rowVersions.ts:67-68`, `:88-90`);
  the `workflow-checkpoint` aggregate kind (`sessionEvent.ts:111`);
  `run.start.checkpointId` (`:273`).
- **Registry.** The `delegate_multi_agents` row of the `workflow-script`
  plugin (`pluginManifest.ts:239-252`; `registry.ts:90`, `:182`). The plugin
  stays and contributes `agent`.
- **Renderers.** `WorkflowRunBoard.ts` (722) and its styles (309), the script
  branch of `WorkflowRunContent.ts`, the workflow branches of
  `ProposalRequestPanel.ts`, `design-harness/scenes/runBoard.ts` (48);
  CLI `WorkflowPopup.tsx` (509), `WorkflowPopupRows.tsx` (111), the workflow
  branches of `AgentProposal.tsx` and `approvalSummaries.ts`, most of
  `workflowPlainOutput.ts` (134). Lane 6 replaces them with a generic script
  stage. The CLI files serving YAML round-mode workflow agents stay.
- **Docs.** The evidence prototype
  `.agents/docs/evidence/2026-09-25-workflow-generator-protocol/` (1,060).
  The skill and guide are rewritten, not deleted.
- **Tests,** about 8,400 lines: `WorkflowScriptEngine` (2,785),
  `WorkflowScriptAgentRunner` (1,787), `WorkflowScriptProgressBridge` (998),
  `WorkflowScriptTool` (1,079), `WorkflowScriptStrategy` (782),
  `WorkflowRunModel` (465), `WorkflowScriptCost` (282), `WorkflowPopup` (187).
  `WorkflowScriptSandboxBundle` (88) is retargeted at the worker entry.
- **Delegation tools (Q7).** `delegate_agent` and `delegate_workflow` go in
  the same change set (`DelegationTools.ts`, 237; net about −200 once their
  launch code lives in `agent`).
- **Never built.** Phase 2 of the history-query note (`query()` as a workflow
  operation, a journal discriminant and a format bump,
  `2026-09-26-executions-history-query.md` §6). A script calls
  `tools.executions({ action: 'query', … })` and replays its `tool.result`.

Not deleted: `proposalFlow.ts`, the generic `stage.start`/`stage.end`
(`TraceEmitter.ts:106-118`), and `attemptFold.ts` (used by `child.turn`).

### In the prompt lane (lane 5), in both modes

The per-step rewriting of delegation descriptions. `resolveStepTools`
probes model availability at every step and rewrites the delegation tools'
descriptions through three regular expressions
(`agentToolResolution.ts:110-144`, `:335-355`;
`delegationAvailability.ts:63-137`, `:170-197`, `:259-327`). A change, such
as adding an API key, changes the `shown` digest, writes a new
`tools.offered` row and breaks the cache (`catalogEntries.ts:62-73`;
`step.ts:345-400`). The text is instead rendered once at the freeze; a later
change reaches the model as one `contextUpdate` line
(`PromptBuilder.ts:97-113`), and `describeTool('agent')` returns the live
lists. A stale list cannot cause a wrong launch: `requireVisibleAgent` and
`selectAvailableDelegationModel` refuse at call time
(`proposalFlow.ts:73-87`; `delegationAvailability.ts:199-252`). About 250
lines go. Applying it in direct mode too avoids two rules for one text.

## Separation of concerns

Each concern has one owner. A piece that owns two concerns, or a concern with
two owners, is a defect this design either fixes or names.

| Concern              | Owner                                                                                      | Must not know about                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Sandbox              | `CodeSandbox` service, `src/agent/codeSandbox/` (#13601)                                   | tools, the run history, approvals; it runs JS under limits and exchanges JSON         |
| Script tool          | `script`, `src/tools/codemode/`, in the `codemode` plugin                                  | any tool by name; it never writes a row, it hands each call to the per-call program   |
| Per-call program     | `toolUseDispatch.ts:391-571` (hooks, guard, approval, settle)                              | whether a model response or a script issued the call, beyond the `tool.intent` origin |
| Run history and fold | `RunHistory` (`runHistory.ts:86`), `SessionEvents` (`sessionEvents.ts:77`), `runStateFold` | live state, realms, rendering                                                         |
| Registry and step    | `ToolRegistry` (`toolTable.ts:208`), `LiveTools` (`liveTools.ts:70`), `Step.open`          | prompt text                                                                           |
| Discovery            | `searchTools`, `describeTool` in `src/tools/codemode/`                                     | the live registry; it reads the step's pinned generation only                         |
| Child runs           | the `agent` tool, `src/tools/delegation/`                                                  | whether it was called directly or from a script, except for the default of awaiting   |
| Messaging            | the follow-up inbox (`FollowUps.ts`, `ToolUseFollowUpQueueManager.ts`)                     | scripts                                                                               |
| Prompt               | the system-text freeze (`requestContext.ts:168-195`, `offeredSystem`)                      | live availability; it reads it once, at the freeze                                    |
| Renderers            | the three hosts over cards and rows (`transcriptFold.ts`)                                  | anything not in a row; no data fixes at render time                                   |
| Domain tools         | plugins (`pluginManifest.ts`)                                                              | code mode; they reach scripts only as registry entries                                |

**Direction.** sandbox ← script tool ← per-call program ← run history. The domain
reaches all four only through the registry, and code mode never switches on a
tool's name.

**What breaks this today.**

- Step resolution owns "what is callable" and also rewrites prompt text
  (`agentToolResolution.ts:335-355`). Fixed in lane 5.
- The workflow engine is a second owner of durable facts (its checkpoint
  journal and claim, `checkpoint.ts:66-77`, `:336-340`, beside
  `RunCell.append`, `runProgram.ts:94-101`), of controls
  (`workflowControlRegistry.ts`) and of run progress (`workflowRunModel.ts`
  beside the cards). Fixed by the deletion in lane 7.
- Agents are classified as orchestrators by tool name at seven sites
  (`delegationTools.ts:16-57`). Code mode narrows the set to `{agent}` and
  leaves the pattern.
- The agent core imports LaTeX code (`SessionHandle.ts:48`,
  `responseTextProcessing.ts:3`, `runListing.ts:13`), and `agent` carries two
  LaTeX options by name (`extractFigures`, `extractTikz`,
  `inputFields.ts:90-101`), kept for parity as one group. Left for the split
  doc; code mode adds no such edge.
- `ModelInvoker` reads a setting itself (`readSettingFrom`,
  `ModelInvoker.ts:76`, `:935`) instead of taking it with its binding. Left
  for the split doc.

**Ports.** The harness depends on these Effect services. All exist except the
sandbox.

| Port          | Service                                                                              | Status                           |
| ------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| Storage       | `RunHistory`, `SessionEvents`, `StorageFs` (`rootedFs.ts:33`)                        | exists                           |
| Models        | `LanguageModel` (`languageModel.ts:89`), `ModelInvoker` (`ModelInvoker.ts:196`)      | exists                           |
| Settings      | `AppState` (`interfaces.ts:164`) through `readSettingFrom`                           | exists; a narrower port is later |
| Execution env | `WorkspaceFs` (`rootedFs.ts:27`), `FileSystem`, `ChildProcessSpawner` (`bash.ts:48`) | exists                           |
| Sandbox       | `CodeSandbox`                                                                        | new, lane 1                      |

## The script surface

One tool, `script`, takes a plain JSON object:

```ts
{
  code: string;                      // body of an async function
  title?: string | null;             // card, approval and run heading
  run_in_background?: boolean | null;
  timeoutMs?: number | null;         // wall clock, 1 s to 24 h, default 60 min
}
```

There are no script files (Q8): no `path`, `args`, `files` or drafts; inputs
are literals in `code`. The code may use `await` at top level, and
`return` gives the result. The globals:

```ts
declare const tools: {
  /** Reads a file from the workspace */
  read_file(args: { path: string; offset?: number | null; limit?: number | null }): Promise<ToolOutput>;
  /** Manages persistent memory notes */
  memory(args: { command: 'view'; path: string } | { command: 'pin'; path: string } | …): Promise<ToolOutput>;
  // … one entry per tool the agent declares
};
declare function searchTools(query: string, opts?: { limit?: number }): Promise<ToolSummary[]>;
declare function describeTool(name: string): Promise<string>;
declare function agent(prompt: string, opts: AgentOptions): Promise<AgentResult>;
declare function phase(title: string): void;
declare const console: { log(...values: unknown[]): void };

interface AgentOptions {
  agentName: string;       // required: the tool-level default agent is gone
  model?: string;          // model reference, `@effort` suffix allowed
  schema?: JsonSchema;     // structured call: tool-use agent, `.structured`
  inputFiles?: string[];   // workflow agents: editable files
  contextFiles?: string[];
  mediaFiles?: string[];
  outputFiles?: string[];  // a subset of inputFiles
  extractFigures?: boolean; extractTikz?: boolean; // workflow agents
  memories?: string[];
  working_directory?: string; // tool-use agents, worktree setting
  background?: boolean;    // return { runId }; report arrives as a follow-up
  id?: string;             // disambiguates otherwise identical calls for reuse
  label?: string;          // card title
  timeoutMs?: number;      // stops the child, rejects `TimedOut`
}
```

- **Result.** `ToolOutput` is `{ output, summary }` from an executed
  `ToolResult` (`toolResult.ts:121-134`). An error result
  (`toolResult.ts:136-146`) rejects with an `Error` named `ToolFailed`.
  Attachments and edit records stay on the host and attach to the script's
  own `tool.result`; the guest sees only JSON text (`sandbox.ts:20-27`).
- **Union tools.** A tool whose input is a `z.discriminatedUnion` is declared
  as one function whose argument is the union of its branches, rendered from
  `toJSONSchema` with `io: 'input'`, so defaults show as optional inputs.
  Branch descriptions become doc comments; cross-field `.refine`s stay prose
  and Zod still enforces them.
- **`agent()`** is `tools.agent`, global because every fan-out script uses
  it. In a script it awaits the child; `background: true` returns at once.
- **Progress.** The nested cards are the progress. `phase(title)` is recorded
  on each following `script.call`. `console.log` writes transient text to the
  script's card (`hooks.onToolOutput` → `stream.chunk`,
  `toolUseDispatch.ts:413-424`); the last 80 lines, 500 characters each, ride
  on the script's `tool.result`, as today (`workflowScriptStrategy.ts:55-56`).
- **Rules.** A script cannot call `script`. A nested result with `endTurn`
  ends the script and the turn. `submit_output` stays a direct tool in both
  modes (`src/tools/structuredOutput.ts`).

### Determinism under `await`

Numbering calls in issue order is not enough:
`a().then(() => tools.read_file(x))` issues its read in whatever order `a`
settles. The fix is Temporal's, and it costs nothing extra here:

1. The host delivers settlements to the realm one at a time, in run history commit
   order.
2. After each delivery it drains QuickJS's job queue
   (`runtime.executePendingJobs`) before reading newly issued calls.
3. A nested call's `tool.result` commits before its value reaches the realm.
4. On replay, the recorded results are delivered in the same order.

The `SessionEvents` publisher already makes commit order enqueue order, so
the run history is the settle log. The guards stay: `Date.now()`, argless
`new Date()`, `Math.random()` and `Intl` throw, code generation is off, and
the promise prototype is frozen (`determinismPrelude.ts:17-89`). The realm has
no timers.

The guest's `tools.x()` returns a realm-native promise whose resolver sits in
a realm-side table; the host calls one trusted `settle(op, json)` that the
prelude captures, and never holds a guest object. This brings back a smaller
form of the promise bridge the 2026-09-25 generator ruling removed
(`2026-09-25-workflow-script-generator-protocol.md`); the owner accepted the
reversal (Q1).

What the script gives up against `yield*` is the six narrowings ruled in Q6.

## Approvals, cards and the run history

**Approval.** A nested call runs the same per-call program as a direct call:
preToolUse hooks, `guardedToolCall` (`toolGuard.ts:35-125`), the tool body
(which opens its own request for `'inBody'`), and `settle`
(`toolUseDispatch.ts:308-338`). The approval vocabulary and its single
authority (`shared/approvalPolicy.ts`) do not change. The script tool itself
requires no approval.

**The script request (Q5, ruled).** The first `agent` call of a script opens
one request showing the title and source. Approving it grants every `agent`
call of that script, as `bash` takes a run-scoped grant
(`ToolTypes.ts:27-31`). It keeps the proposal flow's four outcomes
(`proposalFlow.ts:195-230`) and its presented choices: approve, approve all
agent work in this run, reject with a note, edit as new task. Other nested
calls ask on their own.

**Concurrency** follows the existing declarations (`ToolTypes.ts:54-68`):
`parallelSafe` calls share `Semaphore(MAX_PARALLEL_TOOL_CALLS)`, which is 4
(`toolUseDispatch.ts:92`); every other call takes a one-permit lane in issue
order; `agent` calls also take the session's child-run budget
(`runRegistry.ts:597-601`).

**The run history.** A direct call's arguments ride on the `model.message` row
(`ModelInvoker.ts:462-486`), and `tool.intent` names the response
(`runHistoryEvent.ts:283-291`). A nested call has no response, so:

- **`script.call`** (new): `{ scriptCallId, seq, callId, toolName, input,
replay, stageId, phase }`, committed by the per-call program when the guest
  issues the call. `callId` is `<scriptCallId>/<seq>`.
- **`tool.intent`** (changed): its origin becomes
  `{ kind: 'response', responseId } | { kind: 'script', scriptCallId }`.
- `tool.binding`, `tool.result`, `request.opened`, `request.decided`:
  unchanged.

The fold pairs only the script's own `tool.result` with the model's call, so
nested results stay out of the model's history. Offered-tool identity
(`offeredTools.ts:16-31`, `:82-89`) checks a nested call as it checks a
direct one.

**Cards.** Every card already carries a `stageId` (`runHistoryEvent.ts:121`),
and stages nest (`traceEvent.ts:33-40`). The script's card opens a stage of a
new kind, `script` (`taskGroup.ts:5`), and its nested calls carry that
`stageId`. All three hosts already render nested stages. Cards stay
loop-owned; no tool-side card, progress row or second append path is added.

## Resume and replay

Resume opens a fresh realm and runs the source, read from the script's
`model.message` arguments, from the top:

- **Settled.** A nested call with a `tool.result` is delivered from the
  run history in commit order and not run again.
- **In flight.** A call whose saved and current `replay` both say `safe`
  re-runs at `attempt + 1` (`run/tools.ts:139-165`); any other goes to
  `decideOutcomeUnknown` (`toolUseDispatch.ts:574-691`). If #13604 lands, a
  call bound to a pending request re-attaches to it.
- **Divergence.** If the replayed guest issues a `(toolName, input)` that
  does not match the recorded `script.call` at that `seq`, the script fails
  with `ScriptDiverged`. With the guards, only a changed catalog or a changed
  `describeTool` text can cause it. Discovery calls are recorded as nested
  calls without a card, so they replay too.

**`agent` keeps its own recovery.** An in-flight `agent` call is recovered
from the child's aggregate as today: `run.start` is the launch, a completed
`run.end` with a `run.result` manifest is durable completion
(`workflowScriptAgentRunner.ts:640-729`). That code moves into `agent`. The
child id derives from `(callId, tool.intent.attempt)`, replacing
`workflow.attempt`. The cases refused today "for operator attention" become
the outcome-unknown request instead of aborting the workflow.

**Cross-script reuse (Q2, ruled).** A model may fix a failed script and run
it again without re-billing finished children (`WorkflowScriptTool.ts:668`).
Run history replay covers one script's resume, not a new script call, so `agent`,
and no other tool, reuses a completed result:

- **Key.** A hash of the prompt, every run-affecting option, and a
  fingerprint of every referenced file's bytes, which is today's journal key
  (`runWorkflowScript.ts:51-67`, `inputFields.ts:413`). The fingerprint stays:
  without it an edited input file would return a stale result silently.
  `label` and `phase` stay out.
- **Scope.** The run that issued the `script` call and the background script
  runs it launched. Failed, cancelled and skipped calls are never reused.
- **Record.** The reused call gets its own `script.call` and `tool.result`,
  which names the call it reused (`reusedFrom`).
- **Storage.** The lookup reads those rows. No index until a session needs it.
- **Duplicates.** Two calls in one script with the same key fail the second
  unless they carry distinct `id`s (`runWorkflowScript.ts:462-468`).

## Prompt and cache

**Today.** Every request sends every offered tool's JSON schema
(`run/tools.ts:27-37`; `toolSchema.ts:144-158`) with `cacheKey: run.runId`
(`ModelInvoker.ts:283-298`). A tool-list change rewrites the `tools` array;
the model learns of it from a `contextUpdate` message
(`PromptBuilder.ts:97-113`).

**Under the script tool.** The description holds the surface text plus one
typed declaration per declared tool (Q4, ruled), rendered at the step that
freezes the system text and stored with it in `offeredSystem`
(`runStateFold.ts:557-575`). A later catalog change reaches the model as a
`contextUpdate` line; the new tool is callable at once and `describeTool`
documents it. A compaction re-renders the description with the system text.

**Discovery (owner ruling 6).** MCP tools (`mcpServer.ts:345-361`) and
plugin-injected tools (`agentToolResolution.ts:204-206`) are not declared
inline. `searchTools(query, { limit })` ranks the step's pinned catalog with
Okapi BM25 (`k1 = 1.2`, `b = 0.75`) over each tool's name, description,
property names and descriptions, and plugin or server id, as pi does
(`pi: packages/coding-agent/src/extensions/tool-search/tool.ts:82-155`).
`describeTool(name)` returns the full declaration. Both read the pinned
generation and are recorded, so replay returns the same answer.

The ranker is a pure function of about 60 lines with its tokenizer, not
SQLite FTS5. The corpus is one run's catalog, at most a few hundred entries,
held in memory for one pinned generation. FTS5 would add a connection and a
lifecycle and still need the camelCase splitting, since `unicode61` does not
split `inputFiles` (checked on Node 26.9.0). The owner's SQLite rule is about
stored data; nothing here is stored.

**Token method.** Each built-in tool's `definition` went through the
production `toolDefinitionsFor` in a scratch Vitest file (not committed),
counted with `o200k_base` over `{ name, description, parameters }`. Typed
declarations use the description's first sentence as a doc comment. The
surface text adds about 500 tokens, estimated. The full per-field
descriptions move behind `describeTool`; `executions`' description alone is
949 tokens.

## Engine and Effect structure

The engine stays QuickJS (`quickjs-emscripten-core` with
`@jitl/quickjs-wasmfile-release-sync` 0.32.0; `sandbox.ts:1-11`). `node:vm`
is not a security boundary, and `isolated-vm` is a native addon needing ABI
rebuilds in three hosts. The limits stay: a fresh runtime per script, 64 MB
heap, 1 MB stack, 30 s guest CPU, 4096 open calls (`sandbox.ts:40-49`,
`:396-430`), and the WASM bundled in all four bundles.

**Worker thread.** Guest code runs on the host thread today
(`sandbox.ts:44-46`); once every call goes through it, a guest loop could
freeze the extension host or the TUI for 30 seconds. The realm moves to one
`worker_threads` worker per session, with a fresh runtime per script. The
interrupt handler polls a `SharedArrayBuffer` flag the host sets. The second
esbuild entry per bundle follows `2026-09-26-session-database-off-host-thread.md`
§5.4; whichever lands first owns that table.

**`CodeSandbox`** is a `Context.Service` whose layer is scoped to the
session: `NodeWorker.layer` spawns the worker, and the RPC transport is
`RpcClient.layerProtocolWorker` / `RpcServer.layerProtocolWorkerRunner`.
Closing the scope closes, then terminates, the worker
(`NodeWorker.js:38`, `:53`). No `new AbortController(`, no hand-rolled
lifecycle, no host-side `Effect.run*`.

**One script call** is `CodeSandbox.run(source, catalog)` in the run fiber's
scope. The realm opens under `Effect.acquireRelease`. Each issued call is
forked into a `FiberSet` owned by the script's scope and runs the per-call
program on the run fiber's context; closing the scope interrupts open calls.
Settlements go through a `Queue`, and one consumer fiber delivers them in
commit order through the `settle` RPC, the only place realm state advances.
The wall deadline is `Effect.timeout`; it and any interrupt set the shared
flag before closing the scope.

**Errors** are tagged: `ScriptSyntaxError`, `ScriptFault`,
`ScriptCpuExhausted`, `ScriptDiverged`, `SandboxUnavailable`. The worker
boundary is the one foreign boundary: payloads cross as `Schema.String`
holding JSON that Zod decodes, and failures pass through `ensureError`.

**One run boundary.** The worker entry needs one bare `Effect.run*`
(`NodeRuntime.runMain`), named in the ESLint runtime-entry list
(`eslint.config.mjs:947-951`) and `BARE_EFFECT_RUN_SITES`
(`dependencyDirection.vitest.ts:103-160`) with the reason "no process runtime
exists in the worker". The current engine's non-Effect parts (the polled
deadline, `interpreter.ts:190-201`; the mutable board,
`workflowRunState.ts:121`) are deleted, not converted.

## Fit with the plugin model

**`tools` is the step's pinned snapshot.** A response's calls dispatch
against the step that offered them, and the pin is held until the next step
pins its own (`step.ts:14-17`, `:319-329`, `:425-458`). A script is one call,
so `tools`, `searchTools` and `describeTool` read that generation only. A
plugin switched off mid-script withdraws from the next generation, not the
pinned one (`liveTools.ts:17-22`); `contextUpdate` tells the model. On
resume, an in-flight nested call whose tool changed or left settles
`tool_unavailable` (`step.ts:416-424`), as a direct call does.

**Two built-in plugins contribute the tools.** `script` comes from a new
`codemode` plugin, revision `builtin` (`catalogEntries.ts:87`), hidden and not
toggleable. It copies `core`'s two flags, not its tool list, which includes
`lean_loogle` and `open_pdf` (`pluginManifest.ts:388-404`). A run sees it per
agent YAML during "on" and per model binding after the flip (Q3). `agent`
comes from the existing `workflow-script` plugin (`pluginManifest.ts:238-253`),
which stays toggleable and off on new installs, so fan-out keeps its two
consents: the YAML names `agent`, and the switch is on.

**One writer.** `script.call` and every nested call's rows are core run history
kinds, appended through the run's `RunCell` and committed by the one
`SessionEvents` publisher.

**Hooks** fire per nested call: `PreToolUse` before approval and body,
`PostToolUse` with settlement (`toolUseDispatch.ts:426-433`, `:553`). A deny
settles the call "Blocked by a PreToolUse hook" (`hooks.ts:392-457`), which
the script sees as `ToolFailed`. The `script` call gets both hooks too.

**Trust and MCP.** An untrusted plugin's tools never enter the generation
(`pluginTrust.ts:292-330`). MCP tools enter only when a run declares one
(`mcpConfig.ts:150-200`; `serverHolds.ts:86-142`), are callable as
`tools["mcp__server__tool"]` and found through `searchTools`, keep the bash
approval, and take the one-permit lane.

## `agent` replaces the delegation tools

`delegate_agent` (`DelegationTools.ts:143-158`) and `delegate_workflow`
(`inputFields.ts:65-106`) differ only in the agent category and a few
category-only options, and already share `proposeAndExecute`
(`DelegationTools.ts:106`, `:208`). One `agent` tool takes the union of their
options and `delegate_multi_agents`'s per-call ones; the named agent decides
the category, and an option that does not fit is a validation error
(`requireWorkflowOrToolUseAgent`, `proposalFlow.ts:90-111`).

- **Defaults.** In a script it awaits the child. Called directly (stage "on"
  and the fallback), it keeps today's detached default and returns a run id,
  with the result as a follow-up (`subagentRun.ts:157-255`). A one-shot
  parent gets the in-band form automatically (`subagentRun.ts:123-155`).
- **Stays.** `proposalFlow.ts`, `configureDelegatedChildApprovals`,
  `selectAvailableDelegationModel`, `requireVisibleAgent`, `subagentRun.ts`,
  `inBandSubagentRun.ts`, `detachedChildRun.ts`, `childRun.ts`.
- **Not folded in.** `claude_code` and `codex` continue vendor sessions, take
  vendor permission modes and ask through a bash-style guard
  (`claudeAgent.ts:107-146`; `codex.ts:111-126`). They stay separate tools.
- **Same-change rename.** `hasDelegationTool`'s name set
  (`delegationTools.ts:16-57`) becomes `{ agent }` in the change that
  deletes the old names, or seven sites, among them `isOrchestrator`
  (`agentRegistry.ts:418`) and the memory prompt variant
  (`memoryPromptSection.ts:33`), stop recognizing orchestrators silently.
- **Freeze.** The proposal payload is keyed by `agentCategory`
  (`prompts.ts:97-116`) and a child's identity is `{ kind: 'agent' }`
  (`runIdentity.ts:15-28`), so removing tool names changes no stored shape.

**An agent that names a deleted tool fails loudly.** Today a declared name
with no registration is a log warning and the run continues without it
(`agentToolResolution.ts:311-322`; `step.ts:359-370`). A user's customized
copy naming `delegate_agent` would lose delegation silently. A declared name
that is neither in the tool table nor an MCP name now refuses the run at
start, naming the tool and the agent's file. A plugin switched off still
withholds its tools quietly, because that is the user's switch. With the
"newer built-in" notice (`newerBuiltInNotice.ts:26-27`;
`agentRegistry.ts:164-172`), that is the migration; 1.0 is a clean state, so
no reader rewrites YAML.

## Messaging: what code mode changes

The session-messaging note (`2026-09-25-session-messaging.md`) and the
history-query note stand unchanged. A script reaches them through existing
calls: `agent` (foreground or `background: true`) and
`tools.executions({ action: 'send' | 'wait' | 'view' | 'query' | 'kill', … })`.
Messages still land at the recipient's next turn boundary (decision 4), so a
script never reads its inbox; a result it awaits is an `agent()` value. Every
message stays a `followup.queued` row and every consumption a run-history row;
code mode adds no channel, subscriber or writer. The workflow envelopes
`<workflow-script-result>`, `<workflow-script-error>` and
`<workflow-summary>` (`deliveryTags.ts:13-27`) go in lane 7; a background
script delivers through the generic child-report envelope.

## Adapting the agents

Workflow agents have no `tools:` key and run rounds with no tools offered
(`loop/rounds.ts:2-3`); they are untouched. Six tool-use agents change their
lists (lane 7):

| Agent                                          | Drops                                                          | Gains                         |
| ---------------------------------------------- | -------------------------------------------------------------- | ----------------------------- |
| `assistant`                                    | `delegate_agent` :52, `delegate_workflow` :53                  | `agent`; `script` during "on" |
| `orchestrator`, `engineer`, `leanOrchestrator` | `delegate_agent`, `delegate_workflow`, `delegate_multi_agents` | `agent`, `script`             |
| `creator`, `setup`                             | `delegate_agent`, `delegate_workflow`                          | `agent`                       |

Under "only" no YAML changes: the list says which functions `tools` holds,
and the binding decides the wire form (Q3). Their prompts that name the old
tools, `tool_catalog.md`, `execution_and_testing.md`, the cross-referencing
tool descriptions (`DelegationTools.ts:120`, `:223`; `codex.ts:491-494`;
`claudeAgent.ts:563-564`; `agentCliShared.ts:305`) and the fixture
`golden_parent.yaml:8-10` change in the same lane. The
multi-agent-orchestration skill and `docs/guide/multi-agent-workflows.md` are
rewritten in `await` form, with parent-routed coordination as the default
pattern.

## Parity inventory

`delegate_multi_agents` is deleted only when every row is delivered (lane 7).
The `delegate_*` subsection gates their deletion (Q7). Paths are under
`src/` unless they name a package. `Tool` is
`tools/delegation/WorkflowScriptTool.ts`, `Runner` is
`workflowScriptAgentRunner.ts`, `Strategy` is `workflowScriptStrategy.ts`,
`Engine` is `agent/workflowScript/runWorkflowScript.ts`, `README` is
`agent/workflowScript/README.md`, `Board` is `WorkflowRunBoard.ts`, `Popup`
is `WorkflowPopup.tsx`.

Not in the current tool, so not parity: a pause control (a stop leaves a
"paused" notice, `Strategy:390-395`), a cost budget, a per-call isolation
option, and an effort option beyond the `@effort` suffix.

### Input and launch

| Capability                                                | Today                                       | New home                                            | Lane |
| --------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------- | ---- |
| Inline script source                                      | `Tool:100-106`                              | `script.code`                                       | 2    |
| Source saved as a draft; rerun a saved file by path       | `Tool:107-113`, `:166-201`, `:251-263`      | **Dropped** (Q8)                                    | 2    |
| JSON `args`; files bound by role as `files`               | `Tool:93-99`; `workflowScriptFiles.ts:8-14` | **Dropped** (Q8): literals in `code`                | 2    |
| Rerun reuses the checkpoint's args and files when omitted | `checkpoint.ts:377-389`                     | **Narrowed** (Q6)                                   | —    |
| `meta.name` as heading                                    | `types.ts:33-36`                            | `script.title`                                      | 2    |
| Tool-level default agent                                  | `Tool:87-92`                                | `agentName` required on `agent`                     | 3    |
| Visible agents inside `delegationAgentScope`              | `Tool:282-288`; `Runner:131-166`            | `requireVisibleAgent` with the scope                | 3    |
| Model availability checked before launch                  | `Tool:347-353`                              | `selectAvailableDelegationModel` per call           | 3    |
| Syntax errors with location; imports refused              | `parseScript.ts:64-107`                     | `ScriptSyntaxError`; the realm has no module loader | 2    |

### The `agent()` call

| Capability                                                        | Today                                  | New home                                             | Lane |
| ----------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- | ---- |
| Workflow-agent call with input, context, media files; envelope    | `types.ts:171-176`; `Strategy:299-318` | `agent`, same options and envelope                   | 3    |
| Structured call: `schema` with a tool-use agent, `.structured`    | `types.ts:128-149`, `:187-214`         | the same                                             | 3    |
| Per-call `agentName` and model with `@effort`                     | `types.ts:166-169`                     | the same                                             | 3    |
| Unavailable model aborts the workflow                             | `Runner:59-83`                         | **Narrowed**: rejects `ModelUnavailable` (Q6)        | 3    |
| `id`, `label`, `phase`                                            | `types.ts:157-165`                     | `id` in the reuse key; `label` card title; `phase()` | 2, 3 |
| A later call takes earlier outputs, checked against lineage       | `inputFields.ts:307-411`               | moves into `agent`                                   | 3    |
| Editing a referenced file invalidates the cached result           | `inputFields.ts:413`; `Engine:51-67`   | the file fingerprint in the reuse key                | 3    |
| Non-completed child, or workflow child with no outputs, rejects   | `Runner:837-850`                       | `ToolFailed` named `AgentFailed`                     | 3    |
| Children inherit bypasses; a bypassed proposal grants child edits | `Runner:812-824`; `Tool:509-514`       | child approvals from the script request's decision   | 3    |
| Children see at most the parent's tools, in its directory         | `Runner:812`, `:117-119`               | the same                                             | 3    |
| Children nest under the workflow run; kill cascades               | `Runner:85-96`                         | under the calling run or the background script run   | 3, 4 |
| Crash recovery from the child's aggregate                         | `Runner:640-729`                       | moves into `agent`; refusals become outcome-unknown  | 3    |
| Retry keeps a durable supersession mark                           | `Engine:662-697`                       | `tool.intent` at `attempt + 1`                       | 3    |

### Control flow and limits

| Capability                                          | Today                                            | New home                                           | Lane |
| --------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------- | ---- |
| `all()`, `forEach()`, `attempt()`                   | README :107-114                                  | `Promise.all`, `Promise.allSettled`, `try/catch`   | 2    |
| Fail-fast `all()` interrupts siblings               | README :107-110                                  | **Narrowed** (Q6): only an uncaught rejection does | 2    |
| `retry()` without re-billing completed calls        | README :115-120                                  | a loop; Q2 reuse                                   | 2, 3 |
| `timeout(op, ms)` throws `TimedOut`                 | README :121-122                                  | `agent`'s `timeoutMs`                              | 3    |
| `all(items, { concurrency })`                       | `Engine:170`                                     | **Narrowed** (Q6): session budget; batch for less  | 2    |
| Failures named `AgentFailed`, `TimedOut`, `Skipped` | README :123-128                                  | the same names                                     | 2, 3 |
| A script bug fails with up to three guest frames    | README :279-282                                  | `ScriptFault`, same frames                         | 2    |
| `log()` as an 80-line tail; `phase()` groups        | `Strategy:55-93`; `workflowScriptRun.ts:165-187` | `console.log`, same tail; `phase()`                | 2    |
| Declared plan shows pending work                    | `types.ts:38-43`                                 | **Gap** (Q6)                                       | —    |
| 30 s CPU, 64 MB heap, 1 MB stack; 4096 per `all()`  | `sandbox.ts:40-49`                               | kept, on the worker; 4096 open nested calls        | 1    |
| Wall clock 60 min, 1 s to 24 h                      | `types.ts:44-49`; `Engine:73`                    | `script.timeoutMs`                                 | 2    |
| 1000 live `agent()` calls per run; replays free     | `Engine:74`, `:603-605`                          | 1000 per script; reused results free               | 2    |
| Concurrency from the child-run budget               | `Strategy:290-294`                               | `agent` takes the budget                           | 3    |

### Approval

| Capability                                                      | Today                                                      | New home                                  | Lane |
| --------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------- | ---- |
| One proposal for the whole script, showing the script           | `Tool:372-401`; `ProposalRequestPanel.ts:212-275`          | the script request (Q5): title and source | 3, 6 |
| Approve; approve all in run; reject with note; edit as new task | `ProposalRequestPanel.ts:81-90`; `proposalFlow.ts:139-144` | the same four                             | 3, 6 |
| Policy deny, run bypass, unattended approval                    | `proposalFlow.ts:195-230`                                  | the same decision function                | 3    |
| Consent: YAML names the tool and the global switch is on        | `pluginManifest.ts:238-253`; `plugins.ts:69-74`            | the same for `agent`                      | 3    |

### Running, delivery and resume

| Capability                                                     | Today                                                 | New home                                                                                       | Lane |
| -------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---- |
| Detached run, result as a follow-up                            | `Tool:593-603`; `Strategy:400-420`                    | `run_in_background`: child run `{ kind: 'script', title }` through `startDetachedChildRunLoop` | 4    |
| One-shot runs wait and return the report                       | `Tool:574-591`                                        | the script runs in the foreground there                                                        | 4    |
| Second launch of the same `meta.name` refused while one runs   | `Tool:407-418`                                        | **Dropped** (Q6): each background script is its own run                                        | —    |
| `<workflow-summary>` line: tally, cost, duration, files, cause | `workflowScriptDelivery.ts:13-23`; `Strategy:239-255` | the same line, folded from the cards and the children's usage rows                             | 4    |
| Stop leaves a resumable notice for the parent                  | `Strategy:390-395`; `childRun.ts:113-119`             | the stop notice names the run to resume                                                        | 4    |
| Resume after crash, stop or timeout                            | `checkpoint.ts:299-482`                               | run history replay; `resumeRun` for a background script run                                    | 2, 4 |
| `/executions/{id}` with a bounded board                        | `workflowSummaryView.ts:22-24`, `:119-143`            | the run's view lists its script stage's cards, same bounds                                     | 4    |
| Kill the run                                                   | `ExecutionsTool.ts:420-450`; `Popup:363-365`          | unchanged: a background script is a child run                                                  | 4    |
| Cost per call and in total, discarded attempts included        | `workflowScriptRun.ts:89-119`                         | children's usage rows; the script card sums them                                               | 4, 6 |
| Outputs land in run storage; `accept_run_files`                | `AcceptRunFilesTool.ts:482-498`                       | unchanged                                                                                      | 3    |

### Board and controls

| Capability                                                                              | Today                            | New home                                                          | Lane |
| --------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- | ---- |
| Per-call status: queued, running, finished, reused, skipped, cancelled, failed, not run | `workflowCallProgress.ts:11-20`  | nested cards; "Reused" from `reusedFrom`                          | 6    |
| Per-call facts: agent, model, attempt, files, duration, cost                            | `ui/copy/workflowCall.ts:46-69`  | from the `agent` input and the child run                          | 6    |
| Calls grouped by phase                                                                  | `Board:399-431`                  | grouped by `script.call.phase`                                    | 6    |
| Pending decisions reachable from the board (Review)                                     | `Board:79-83`, `:598-616`        | the same over nested cards and children's requests                | 6    |
| A call opens its child run                                                              | `Board:527-537`                  | the card's child-run link                                         | 6    |
| Skip a running call                                                                     | `Board:454-478`; `Popup:354-361` | stop the child run (existing control); the call rejects `Skipped` | 3, 6 |
| Restart a running call                                                                  | same                             | **Dropped** (Q9)                                                  | —    |
| Resume and "Edit as new task" on an ended run                                           | `BaseRunContent.ts:71-101`       | generic run content of the background script run                  | 6    |
| Headless `texra run` progress lines                                                     | `workflowPlainOutput.ts:35-63`   | the same lines over the script stage                              | 6    |

Cosmetics not carried as parity rows: phase-tab tallies and badges,
next-failed, filter, the glyph strip, phase and row keys, and live counters
per child (the child's own live view already has them).

### Plugin and docs

| Capability                                         | Today                                         | New home                              | Lane |
| -------------------------------------------------- | --------------------------------------------- | ------------------------------------- | ---- |
| "Multi-Agent Workflow" switch, off on new installs | `pluginManifest.ts:238-253`                   | the same plugin, contributing `agent` | 3    |
| The plugin ships the skill, hidden by the switch   | `skillSources.ts:168-175`                     | the rewritten skill                   | 7    |
| User guide; fan-out patterns                       | `multi-agent-workflows.md`; `SKILL.md:26-126` | rewritten in `await` form             | 7    |

### `delegate_agent` and `delegate_workflow` (Q7)

`DT` is `DelegationTools.ts`, `IF` is `inputFields.ts`, `SR` is
`subagentRun.ts`, all under `tools/delegation/`.

| Capability                                                                                 | Today                                 | New home                                               | Lane |
| ------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------ | ---- |
| Launch a named agent with an instruction                                                   | `DT:143-158`; `IF:65-77`              | `agent(prompt, { agentName })`                         | 3    |
| Detached by default; one-shot parent in-band                                               | `SR:123-255`                          | direct `agent` default; `background: true` in a script | 3    |
| One proposal per call; agent or model changed at approval                                  | `proposalFlow.ts:186-231`, `:276-320` | a direct `agent` call keeps it                         | 3    |
| `inputFiles`, `contextFiles`, `mediaFiles`, `outputFiles`, `extractFigures`, `extractTikz` | `IF:78-104`                           | `agent` options, workflow agents only                  | 3    |
| `.bib` over 100 KB refused; files must exist                                               | `DT:75-85`; `IF:217-301`              | the same                                               | 3    |
| `memories`; `working_directory` under the worktree setting                                 | `DT:156-157`; `IF:105`, `:122-143`    | `agent` options                                        | 3    |
| Hand-off wrapper, "delivered verbatim"                                                     | `IF:144-166`                          | unchanged, tool-use agents                             | 3    |
| Model: explicit, else parent's, else first available                                       | `delegationAvailability.ts:199-252`   | unchanged                                              | 3    |
| A child cannot declare an MCP server its parent lacks                                      | `agentToolResolution.ts:162-181`      | unchanged                                              | 3    |
| Available agents and models in the description                                             | `agentToolResolution.ts:335-355`      | frozen at the freeze; `describeTool('agent')` live     | 5    |
| Orchestrators classified by a delegation tool                                              | `delegationTools.ts:16-57`            | name set `{ agent }`                                   | 7    |

`executions` and `memory` keep every capability; a script calls them as
typed union functions (lane 5).

## Storage and the freeze

The freeze writes each row kind's JSON Schema to `config/storage/frozen/` at
the 1.0 tag; after that a released kind is read forever through upcasters
(`2026-09-28-storage-v1-design.md` §3; `rowVersions.ts:13-17`). The directory
does not exist yet, so every kind is unreleased. Because the freeze waits for
lane 7, every change here lands in its version-1 shape with no upcaster:

| Change                                                                              | Kind                          |
| ----------------------------------------------------------------------------------- | ----------------------------- |
| Delete the five `workflow.*` kinds, `workflow-checkpoint`, `run.start.checkpointId` | removal, never released       |
| Run identity `multiAgentWorkflow` replaced by `script`                              | changed union, before release |
| `script.call`                                                                       | new kind                      |
| `tool.intent` origin, tagged with `kind`                                            | changed shape, before release |
| `StageKind` gains `script`                                                          | widened enum, before release  |

`DispatchFacts.partition` and `.duplicateOf` and the `duplicate` disposition
reach 1.0 because the fallback stays (Q3).

### Other proposals touching the freeze

Each is its own proposal and needs its own ruling before the tag. Code mode
depends on none of them.

- Effect class replacing `replay` (`DispatchFacts.replay`,
  `runHistoryEvent.ts:111`), and any grant derived from it. The script
  request's grant stays `agent`-only.
- One view-edit kind: ruled 2026-10-02 in
  [the durable harness note](./2026-10-02-durable-harness.md); `context.edit`
  replaced `model.compaction`. #13546 (snapshots and rewind) builds on it.
- Fork as a `run.start.provenance` arm (the envelope already has an
  `origin`): its `fork` arm landed with `context.edit`; PRD #13354's
  `{ sessionRoot, runId }` and wake time stay deferred.
- Durable approvals, #13604: no new shape; `tool.binding` widens in meaning.

## Rollout and evaluation

1. **"on".** `script` is offered beside the direct tools to agents whose YAML
   lists it; each direct tool's description gains "also `tools.x(args)` in
   `script`". `delegate_multi_agents` stays until lane 7.
2. **Measure.** Run the live journeys
   (`packages/cli/scripts/validate-journeys.mjs`; the matrix was fixed in
   #13599) under `direct` and `only` on gemini38f, deepseek41T and glm53flash,
   plus one fan-out journey that exercises `agent()`. Report pass rate, total
   tokens, cost, wall time and the cached share of input tokens per journey.
3. **"only"** per model, gated by our own nightly only (Q10):
   - **Pass rate.** The lower bound of a 90% interval on `only − direct` is
     not below −5 points.
   - **Cost.** Mean cost per passing task no higher than `direct`'s.
   - **Latency.** Median wall time at most 1.2 times `direct`'s.

   Each journey runs three times per arm per nightly, and the comparison
   pools the last five nightlies (60 tasks per arm per model) on one TeXRA
   commit range and model version; a change to the prompt or the tool surface
   restarts the window. External figures that suggest code mode does not
   always save money motivate measuring cost; they gate nothing.

4. **Per-model fallback (Q3, ruled).** A model that fails the bar keeps
   direct tools. The flag lives on `BoundModel` (`modelBinding.ts:87-98`),
   set in the vendor arms (`:285-380`) beside `supportsForcedToolChoice`.

## Owner rulings (2026-10-01, 2026-10-02)

"i want to be as future looking as possible. but also it should cover
everything that delegate_multi_agents can do."

1. **Q1. `await`, not `yield*`,** with the commit-order settle rule. This
   reverses the 2026-09-25 generator ruling.
2. **Q2. Reuse completed `agent` results,** for `agent` only.
3. **Q3. The per-model direct fallback stays** until the nightly data says
   otherwise; retiring it is a later decision.
4. **Q4. Every declared tool is inlined as a typed declaration.**
5. **Q5. One approval request per script,** granting its `agent` calls.
6. **`searchTools` ranks with BM25, and `describeTool` stays.**
7. **Parity before deletion,** and **the freeze waits** for lane 7.
8. **External numbers are motivation only,** and **code mode stays
   domain-free.**

9. **Q6. Accept the six narrowings** (2026-10-02). A rerun does not inherit
   the previous args and files; an unavailable model fails one call
   (catchable) instead of the workflow; a caught `Promise.all` rejection does
   not interrupt siblings; the per-`all()` `concurrency` bound is gone (the
   session budget stays); two background runs of one script are not refused;
   and the declared plan (`meta.tasks`) has no successor. Each follows from a
   script being plain JavaScript over ordinary calls, none loses a result or
   bills twice, and the script request shows the whole source before anything
   runs.
10. **Q7. `agent` replaces `delegate_agent` and `delegate_workflow`**
    (2026-10-02), deleted in lane 7 with `delegate_multi_agents`. They differ
    only by category, which the named agent decides.
11. **Q8. No script files** (2026-10-02): no `path`, drafts under
    `.texra/scripts/`, `args`, `files` or `script.source` row. The source is
    on the `model.message` row, and a rerun with a fix re-sends the code
    while Q2 reuse keeps finished children free.
12. **Q9. No per-call Restart** (2026-10-02). Skip stays, as a stop of the
    child run; a script retries in code, and a user who wants a call redone
    stops it and asks. No `call.control` or per-call session request.
13. **Q10. The flip bar is the pooled five-night window** (2026-10-02) under
    "Rollout and evaluation", replacing "three consecutive nightlies": three
    nights of four journeys is 12 tasks per arm, which cannot tell a 10-point
    difference from noise.

Rulings 9 to 13: "do as you recommend… they look fine" (2026-10-02).

## Open questions for the owner

None are open.

## Lanes

| Lane | Work                                                                                                                                                                                                                                 | Effort                    | Depends on                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | --------------------------------------- |
| 1    | `CodeSandbox`: worker entry in four bundles, Effect RPC over `NodeWorker`, settle and job drain, shared interrupt flag, the run-site entry, limits. Open as #13601                                                                   | L                         | none                                    |
| 2    | `script` tool in the `codemode` plugin: JSON input, `script.call`, tagged `tool.intent` origin, `script` stage, nested dispatch through the per-call program, commit-order replay, `ScriptDiverged`, log tail, call cap, `timeoutMs` | L                         | 1                                       |
| 3    | `agent` tool in `workflow-script`: the union of options, envelope, file hand-off and fingerprint, post-conditions, child approvals, recovery, child id, `timeoutMs`, `background`, Q2 reuse, Q5 request, `Skipped` on a user stop    | L                         | 2                                       |
| 4    | Background scripts: `run_in_background`, `script` run identity, delivery and summary line, stop notice, `resumeRun`, `/executions` view, one-shot foreground                                                                         | M                         | 2, 3                                    |
| 5    | Prompt and discovery: declarations frozen with the system text (unions as typed unions), availability text frozen and the per-step rewrite deleted, BM25 `searchTools` and `describeTool` over the pinned generation                 | M                         | the rewrite part none; the rest 2       |
| 6    | Renderers in three hosts: script stage (status, grouping, Review, child links, skip as stop), script request panels, headless lines                                                                                                  | L                         | 2, 3, 4                                 |
| 7    | **Parity gate and deletion.** Delete `delegate_multi_agents` and everything listed above, and the `delegate_*` pair (Q7); adapt the agents, prompts and docs; `{ agent }` name set; the loud refusal; rewrite the skill and guide    | M, ~15k lines incl. tests | 3, 4, 5, 6; then the 1.0 freeze and tag |
| 8    | Evaluation and flip: `direct` against `only` per model, the fan-out journey, three runs per arm, the pooled window, the `BoundModel` flag; flip the default once the bar is met                                                      | S                         | 2, 5                                    |

Lanes 1 and the rewrite half of 5 can start today. Nothing is deleted ahead
of its replacement: until lane 7, `delegate_multi_agents` and the new tools
ship side by side.

## Later

Real, but not designed here; each waits for the flip or for Q3's retirement.

- After the fallback retires: duplicate detection
  (`toolCallParsing.ts:35-71`, `toolUseDispatch.ts:774-806`; about 110
  lines), response partitioning (`run/tools.ts:46-124`; about 70), the two
  provider preprocess shims (`toolInput.ts:157-177`, `ReadTool.ts:33-57`),
  and `.optional()` for new tool inputs.
- `executions send` idempotent by deriving its `deliveryId` from `callId`
  (`ToolUseFollowUpQueueManager.ts:422`; `runRows.ts:338`).
- A typed core list or pi's budgeted declarations, if the nightly shows
  inlining everything costs more than it saves.
- A narrower settings port for `ModelInvoker`, with the harness split.

## Prior art

pi v1.0.0 (tag `a13d35a74`, read in `packages/codemode` and
`packages/coding-agent/src/extensions/{codemode,tool-search}`) runs QuickJS on
a worker per call with BM25 tool search and no replay; Codex (`codex-rs`
`code-mode*`) runs V8 in a separate host process with no durable record.
Neither survives a restart with its finished calls intact, which here follows
from the run history, not from the sandbox.

## Verified

- Read on `main` at `35909133bd`: `src/agent/workflowScript/*`;
  `src/tools/delegation/*`; `src/agent/runtime/{agentToolResolution,ModelInvoker,SessionHandle,runRegistry}.ts`;
  `src/agent/runtime/loop/{toolUseDispatch,step,hooks,rounds}.ts`;
  `src/agent/runtime/run/{tools,toolSchema,requestContext,toolResultText,modelBinding}.ts`;
  `src/shared/schemas/{runHistoryEvent,sessionEvent,traceEvent,toolResult,offeredTools,prompts,runIdentity}.ts`;
  `src/tools/{pluginManifest,plugins,liveRegistry,liveTools,catalogEntries,serverHolds,ExecutionsTool}.ts`;
  `src/tools/{memory,executions}/*`; `src/platform/{rootedFs,interfaces,languageModel}.ts`;
  the renderer files listed under "What gets deleted"; every built-in agent
  YAML; the multi-agent-orchestration skill and guide; `eslint.config.mjs`;
  `dependencyDirection.vitest.ts`; `config/ratchets/refuted-candidates.json`.
- Read the generator-protocol, storage-v1, database-worker,
  session-messaging, history-query and core-concepts notes.
- Re-checked on `origin/main` at `bfa714227b` for this revision: the
  `@latex` imports under `src/agent/`, `readSettingFrom` in `ModelInvoker`,
  the `Context.Service` ports, `annotateDelegationAvailability`'s one caller,
  that no host launches a workflow script by path, and that #13599 fixed the
  journey matrix.
- Confirmed `NodeWorker`'s close-then-terminate finalizer and the RPC worker
  layers in `@effect/platform-node`; that `node:sqlite` on Node 26.9.0 has
  FTS5 and `unicode61` does not split camelCase.
- Measured the token figures with the production `toolDefinitionsFor` over
  all 52 registered tools; the scratch test was deleted.
- Not run: any live model, the nightly journeys, or a prototype of the
  `settle` realm.
