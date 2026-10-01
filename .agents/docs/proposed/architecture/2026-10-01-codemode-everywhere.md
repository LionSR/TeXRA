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

Only the deletion of the workflow row kinds has to land before the 1.0
storage freeze. Everything else is additive, or is a version-2 row with a
one-line upcaster.

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

## What gets deleted

### When the script tool lands (stage "on")

The workflow-script tool and its protocol go entirely. Line counts come from
`wc -l` at the baseline.

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
- The `workflow.control` request: `runtimeRequest.ts:88` and
  `SessionRequests.ts:488-491`.
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
  `icons.ts:97`; `executionFormatters.ts:64`; `RunTab.ts:85`).
- `WORKFLOW_TASK` (`log.ts:28`).

**Row kinds** (see "Storage and the freeze")

- `workflow.plan`, `workflow.call`, `workflow.script`, `workflow.journal`,
  `workflow.attempt` (`rowVersions.ts:67-68`, `:88-90`).
- The `workflow-checkpoint` aggregate kind (`sessionEvent.ts:111`).
- `run.start.checkpointId` (`sessionEvent.ts:273`).

**Plugin toggle and registry**

- The `workflow-script` plugin entry (`pluginManifest.ts:239-252`) and its
  registry row (`registry.ts:90`, `:182`).

**Renderers**

- Extension and desktop: `WorkflowRunBoard.ts` (722) and its styles (309);
  the script branch of `WorkflowRunContent.ts`; the workflow branches of
  `ProposalRequestPanel.ts` (`:36-39`, `:98-100`, `:146`, `:183-184`,
  `:214-272`); the desktop scene `design-harness/scenes/runBoard.ts` (48).
- CLI: `WorkflowPopup.tsx` (509) and `WorkflowPopupRows.tsx` (111); the
  workflow branches of `AgentProposal.tsx` (`:17-19`, `:102-128`,
  `:206-211`) and `approvalSummaries.ts` (`:14-16`, `:130-160`); most of
  `workflowPlainOutput.ts` (134).
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
decision (Q3).

## The script surface

One tool, `script`, takes `{ code: string }`. The code is the body of an
async function: it may use `await` at the top level, and `return` gives the
result. Seven globals are available:

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
declare function searchTools(query: string): Promise<ToolSummary[]>;
declare function describeTool(name: string): Promise<string>;
declare function agent(
  prompt: string,
  opts?: AgentOptions,
): Promise<AgentResult>;
declare const args: unknown;
declare const files: WorkspaceFiles;
declare const console: { log(...values: unknown[]): void };
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
- **Gone.** `phase()`, `meta.tasks` and `meta.phases` are gone. Progress is
  the nested cards themselves, and `console.log` writes transient text to the
  script's card (`hooks.onToolOutput` → `stream.chunk`, the path bash already
  uses: `toolUseDispatch.ts:413-424`).
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

That keeps the data-only boundary (README "Sandbox"). Even so, it reverses a
ruling made six days ago, which is why it is Q1.

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
- **`timeout()` and `retry()` become plain code.** A script writes them with
  `try/catch` and loops. A per-call timeout is the tool's own.

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
replay, logId, stageId }`, committed when the guest issues the call.
  `callId` is `<scriptCallId>/<seq>`.
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
`model.message` row. Resume opens a fresh realm and runs the source from the
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

(README, "Restart-safe checkpoints".) This recovery moves into the `agent`
tool. The child id is derived from `(callId, tool.intent.attempt)`, which
replaces `workflow.attempt`'s attempt mark.

**Cross-script reuse.** The current tool lets a model edit a failed script
and rerun it while "completed agent() calls replay for free"
(`WorkflowScriptTool.ts:668`). Ledger replay covers the resume of one
script. It does not cover a new script call. Q2 asks whether `agent` should
reuse a completed result from the same run whose arguments hash the same.
That lookup reads the run's own `script.call` and `tool.result` rows and needs
no new storage.

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

Instead:

- `searchTools(query)` ranks the run's offered catalog by name and
  description and returns `{ name, line }`.
- `describeTool(name)` returns the full declaration, with field
  descriptions.

There is no ranking library: a substring and token match over at most a few
hundred entries is enough until a catalog shows otherwise.

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
`executions`' description is 949 tokens and `delegate_workflow`'s is 280. Q4
asks whether to inline full declarations for a short core list and one-line
entries for the rest. That would come to 1,192 tokens for `assistant` with
the file tools typed. The nightly comparison decides.

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
   `tools.x(args)` in `script`". `delegate_multi_agents` is gone, and the
   orchestrator's fan-out guidance points at `script`.
2. **Measure.**
   - Run the live journeys (`packages/cli/scripts/validate-journeys.mjs`,
     four journeys graded on file invariants and a real `latexmk` build)
     under `direct` and `only`, on gemini38f, deepseek41T and glm53flash.
   - Report pass rate, total tokens and cost per journey.
   - Add one fan-out journey that exercises `agent()`.
   - Two fixes come first:
     - The nightly is broken as committed: `c6efe574f0` rekeyed the script's
       `MODEL_KEYS` (`validate-journeys.mjs:46-49`), but
       `.github/workflows/live-journeys.yml:40` still passes the old keys, so
       the script exits at `:261-266` before any journey runs.
     - gemini38f is not in the matrix.
3. **"only".** Flip the default when, for every model, `only` passes at
   least as many journeys as `direct` on three consecutive nightlies and its
   cost is no higher.
4. **Per-model fallback.** A model that fails the bar keeps direct tools.
   - The flag lives on the binding (`BoundModel`, `modelBinding.ts:87-98`),
     set in the vendor arms (`:285-380`) next to `supportsForcedToolChoice`.
     That needs no llm-zoo release.
   - A route without tool calling cannot run either mode, and is unchanged.

## Storage and the freeze

The freeze writes each row kind's JSON Schema to `config/storage/frozen/` at
the 1.0 tag. After that:

- a released kind is read forever through upcasters;
- an unknown kind blocks its aggregate.

(`2026-09-28-storage-v1-design.md` §3, :413-467; `rowVersions.ts:13-17`.)
`config/storage/frozen/` does not exist yet, so every kind is still
unreleased.

| Change                                                                                                                                                                                            | Kind                          | Before the freeze?                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| Delete `workflow.plan`, `workflow.call`, `workflow.script`, `workflow.journal`, `workflow.attempt`; aggregate kind `workflow-checkpoint`; `run.start.checkpointId`; run kind `multiAgentWorkflow` | removal                       | **Blocks.** Once released, they must be read forever, and an unknown kind blocks its aggregate. |
| `script.call`                                                                                                                                                                                     | new kind, V1                  | No: additive after the freeze                                                                   |
| `tool.intent.responseId` → origin union                                                                                                                                                           | changed shape                 | No: V2 with a one-line upcaster (`{responseId}` → `{origin:{responseId}}`); free before         |
| `StageKind` gains `script`                                                                                                                                                                        | widened enum on `stage.start` | No: V2 with an identity upcaster; free before                                                   |
| `tool.binding` covers any guarded request                                                                                                                                                         | meaning only                  | No shape change                                                                                 |

Only the deletion blocks the freeze. Shipping 1.0 without
`delegate_multi_agents` costs little: it is opt-in, and new installs start
with its switch off (README, "Production integration";
`pluginManifest.ts:239-252`). The three schema changes are cheaper before
the tag, so they ride along if lane 2 is ready by then. Otherwise each is one
V2 entry.

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

## Open questions for the owner

1. **Q1. `await` or `yield*`.** Accept `await tools.x()` and a job-queue
   drain in the realm, reversing the 2026-09-25 generator ruling for the one
   surface that now carries every call? _Recommended: yes._ Single calls are
   most of the traffic, every model writes `await` unprompted, and the
   commit-order delivery rule keeps replay exact.
2. **Q2. Cross-script reuse of `agent` results.** Should a completed
   `agent` call whose arguments hash the same be reused within the same run,
   read from the run's own rows? _Recommended: yes, for `agent` only._ It
   keeps the "edit and rerun without re-billing" behaviour that
   `delegate_multi_agents` users have, with no new storage. No other tool
   reuses results across scripts.
3. **Q3. Keep the per-model direct fallback indefinitely?** As long as it
   exists, response partitioning and duplicate detection stay.
   _Recommended: keep it until a model's nightly results stop needing it,
   then retire it in its own decision._
4. **Q4. Inline typed declarations for every declared tool, or a typed core
   plus one-liners?** _Recommended: decide by the nightly comparison; ship
   all typed (≈2,400 tokens for `assistant`)._
5. **Q5. Approval for `agent` fan-out.** Today one proposal approves a whole
   workflow script (`WorkflowScriptTool.ts:372-395`). Under the core policy,
   each `agent` call would ask on its own. _Recommended:_ the first `agent`
   call of a script opens one request that shows the script source, and
   approving it grants `agent` calls for that script, in the way `bash` takes
   a run-scoped command grant (`ToolTypes.ts:27-31`).

## Lanes

| Lane | Work                                                                                                                                                                      | Effort                               | Depends on                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| 0    | Delete `delegate_multi_agents`, its engine half, renderers, five row kinds, `multiAgentWorkflow`, the toggle and docs (list above)                                        | M (deletion, ~15k lines incl. tests) | Q1 not required; **must merge before the 1.0 tag**                     |
| 1    | Durable approvals: bind every guarded request with `tool.binding`; park at `waiting`; re-attach on resume. Direct calls benefit immediately                               | M                                    | none                                                                   |
| 2    | `CodeSandbox` service: worker entry in four bundles, Effect RPC over `NodeWorker`, `settle`/job-drain realm, shared interrupt flag, `BARE_EFFECT_RUN_SITES` entry         | L                                    | Q1; coordinate the worker-shipping table with the database-worker note |
| 3    | `script` tool: `script.call` row, `tool.intent` origin, `script` stage kind, nested dispatch through the existing per-call program, commit-order replay, `ScriptDiverged` | L                                    | 1, 2                                                                   |
| 4    | `agent` tool: move child launch and aggregate recovery out of `workflowScriptAgentRunner`; child id from `(callId, attempt)`; Q2 reuse; Q5 grant                          | M                                    | 3                                                                      |
| 5    | Prompt: declarations rendered and frozen with system text; `searchTools`/`describeTool` over the offered catalog incl. MCP; `contextUpdate` for catalog changes           | M                                    | 3                                                                      |
| 6    | Evaluation: fix the live-journeys matrix keys, add gemini38f and a fan-out journey, `direct` vs `only` per model; per-model flag on `BoundModel`                          | S                                    | 3, 5                                                                   |
| 7    | Flip the default to "only"                                                                                                                                                | S                                    | 6 meeting the bar                                                      |

Lanes 0 and 1 can start today and do not touch each other.

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
- Read the code to confirm `NodeWorker.layerPlatform`'s close-then-terminate
  finalizer (`@effect/platform-node` `NodeWorker.js:28-53`) and the RPC
  worker protocol layers.
- Measured the token figures above with the production `toolDefinitionsFor`
  over all 52 registered tools. The scratch test was deleted.
- Read the peer code: pi at `origin/main` (`packages/codemode`,
  `packages/coding-agent/src/extensions/codemode`), and Codex `codex-rs`
  crates `code-mode*` and `core/src/tools/code_mode`.
- Not run: any live model, the nightly journeys, or a prototype of the
  `settle` realm.
