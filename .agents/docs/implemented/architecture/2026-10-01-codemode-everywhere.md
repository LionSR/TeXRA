---
created: 2026-10-01
status: implemented
---

# Codemode: every tool call can go through one script tool

Paths below are under `packages/harness/src/` unless they name another
package.

## Summary

The `script` tool takes a JavaScript program that calls the run's tools as
`await tools.read_file({ path })`. Every nested call is an ordinary tool
call: it passes the core approval policy, it is written to the run history,
and its card nests under the script's card. When a run resumes, the script
runs again from the top. Calls that finished are handed back from the run
history in the order their settlements committed; a call that was still in
flight follows the same `replay: 'safe' | 'unsafe'` rule a direct call
follows.

The engine is QuickJS on a worker thread behind the `CodeSandbox` Effect
service. `agent()` is an ordinary tool, so a fan-out workflow is just a
script. It replaced `delegate_multi_agents`, its generator protocol and
checkpoint journal, its five `workflow.*` row kinds, and the
`delegate_agent` and `delegate_workflow` tools (#13616 to #13626).

The rollout has two stages: **"on"**, where `script` sits beside the direct
tools, and **"only"**, where it is all the model sees. Today is "on": an
agent gets `script` when its YAML names it (the bundled `assistant`,
`engineer` and `orchestrator` do). The switch to "only" waits for the
evaluation under "Still open".

## Separation of concerns

| Concern              | Owner                                                                                                   | Must not know about                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Sandbox              | `CodeSandbox`, `agent/codeSandbox/`                                                                     | tools, the run history, approvals; it runs JS under limits and exchanges JSON         |
| Script tool          | `script`, `tools/codemode/ScriptTool.ts`, in the `codemode` plugin                                      | any tool by name; it never writes a row, it hands each call to the per-call program   |
| Per-call program     | `agent/runtime/loop/toolUseDispatch.ts` (hooks, guard, approval, settle), reached through `ScriptCalls` | whether a model response or a script issued the call, beyond the `tool.intent` origin |
| Run history and fold | `RunCell.append` (`shared/session/runHistory.ts`), the `SessionEvents` publisher, `runStateFold`        | live state, realms, rendering                                                         |
| Registry and step    | `ToolRegistry` (`tools/toolTable.ts`), `ToolCatalog` (`tools/liveTools.ts`), `Step.open`                | prompt text                                                                           |
| Discovery            | `searchTools`, `describeTool` in `tools/codemode/discovery.ts`                                          | the live registry; it reads the step's pinned generation only                         |
| Child runs           | the `agent` tool, `tools/delegation/`                                                                   | whether it was called directly or from a script, except for the default of awaiting   |
| Messaging            | the follow-up inbox (`agent/followUp/`, `agent/runtime/FollowUps.ts`)                                   | scripts                                                                               |
| Prompt               | the system-text freeze (`offeredSystem` in the run state)                                               | live availability; it reads it once, at the freeze                                    |
| Renderers            | the three hosts over cards and rows                                                                     | anything not in a row; no data fixes at render time                                   |
| Domain tools         | plugins                                                                                                 | code mode; they reach scripts only as registry entries                                |

**Direction.** sandbox ← script tool ← per-call program ← run history. The
domain reaches all four only through the registry, and code mode never
switches on a tool's name.

## The script surface

`script` takes a plain JSON object:

```ts
{
  code: string;                      // body of an async function
  title?: string | null;             // card, approval and run heading
  run_in_background?: boolean | null;
  timeoutMs?: number | null;         // wall clock, 1 s to 24 h, default 60 min
}
```

There are no script files (Q8): inputs are literals in `code`. The code may
use `await` at top level, and `return` gives the result. The globals:

- `tools.<name>(args)` for every tool the script may call other than
  `script`, resolving to `{ output, summary }` (or the value a tool declares
  it resolves to);
- `searchTools(query, { limit })` and `describeTool(name)`;
- a tool that declares a script global (`agent` does) is also a function of
  its own: `agent(prompt, opts)` is `tools.agent({ ...opts, prompt })`;
- `phase(title)`, recorded on each following `script.call`;
- `console.log`, which writes transient text to the script's card
  (`hooks.onToolOutput` → `stream.chunk`); the last 80 lines, 500
  characters each, ride on the script's `tool.result`.

`agent`'s options are `agentName` (required), `model` (with an `@effort`
suffix), `schema` (a structured result), `mediaFiles`, `memories`,
`working_directory`, `id` (tells apart otherwise identical calls for reuse),
`label`, `timeoutMs` and `background`.

- **Result.** A failed call rejects with an `Error` named `ToolFailed`.
  Attachments stay on the host and attach to the script's own `tool.result`;
  the guest sees only JSON.
- **Union tools.** A tool whose input is a `z.discriminatedUnion` is
  declared as one function whose argument is the union of its branches,
  rendered from its JSON Schema with `io: 'input'`, so defaults show as
  optional inputs (`tools/codemode/declarations.ts`).
- **Rules.** A script cannot call `script`. A nested result with `endTurn`
  ends the script and the turn.

### Determinism under `await`

Numbering calls in issue order is not enough:
`a().then(() => tools.read_file(x))` issues its read in whatever order `a`
settles. So:

1. The host delivers settlements to the realm one at a time, in run history
   commit order.
2. After each delivery the worker drains QuickJS's job queue
   (`runtime.executePendingJobs`) before reading newly issued calls.
3. A nested call's `tool.result` commits before its value reaches the realm.
4. On replay, the recorded results are delivered in the same order.

The `SessionEvents` publisher makes commit order enqueue order, so the run
history is the settle log. The worker's prelude makes `Date.now()`, argless
`new Date()`, `Math.random()` and `Intl` throw, turns code generation off
and freezes the promise prototype (`agent/codeSandbox/worker.ts`). The realm
has no timers and no module loader. The guest's `tools.x()` returns a
realm-native promise; the host settles it through one trusted function the
prelude captures and never holds a guest object (Q1). What a script gives up
against the old `yield*` protocol is the six narrowings of Q6.

## Approvals, cards and the run history

**Approval.** A nested call runs the same per-call program as a direct call:
PreToolUse hooks, the guard (`agent/runtime/loop/toolGuard.ts`), the tool
body, and settlement. The approval vocabulary and its single authority
(`shared/approvalPolicy.ts`) are the direct call's. The script tool itself
requires no approval.

**The script request (Q5).** The first `agent` call of a script opens one
request showing the script's title, source and the calls it has issued
(`AgentProposal.script`). Approving it grants every `agent` call of that
script. Other nested calls ask on their own.

**Concurrency.** A `parallelSafe` call takes the window of four parallel
calls, a tool that bounds its own calls runs beside the others, and any
other call is a barrier. `agent` calls also take the session's child-run
budget.

**The run history.** A direct call's arguments ride on the `model.message`
row and `tool.intent` names the response. A nested call has no response,
so:

- **`script.call`** (`shared/schemas/runHistoryEvent.ts`): `{ scriptCallId,
seq, callId, toolName, input, replay, logId, stageId, phase }`, committed
  with the call's first `tool.intent`. `callId` is `<scriptCallId>/<seq>`.
- **`tool.intent`**'s origin is `{ kind: 'response', responseId } |
{ kind: 'script', scriptCallId }`.
- `tool.result`, `request.opened` and `request.decided` are unchanged.

The fold pairs only the script's own `tool.result` with the model's call, so
nested results stay out of the model's history. Offered-tool identity checks
a nested call as it checks a direct one.

**Cards.** The script's card opens a stage of kind `script`
(`shared/schemas/taskGroup.ts`), and its nested calls carry that `stageId`.
Cards stay loop-owned; there is no tool-side card, progress row or second
append path.

## Resume and replay

Resume opens a fresh realm and runs the source, read from the script's
`model.message` arguments, from the top:

- **Settled.** A nested call with a `tool.result` is handed back from the
  run history in commit order and not run again.
- **In flight.** A call whose recorded and current `replay` both say `safe`
  re-runs at the next attempt (`replayable`, `agent/runtime/run/tools.ts`).
  Any other call whose body may have run settles as outcome unknown, and the
  model decides what to do (verify, ask, or call again).
- **Divergence.** If the replayed guest issues a `(toolName, input)` that
  does not match the recorded `script.call` at that `seq`, the script fails
  with `ScriptDiverged` (`agent/runtime/RunCall.ts`). With the guards, only a
  changed catalog or a changed `describeTool` text can cause it. Discovery
  calls are recorded too, so they replay.

**`agent` keeps its own recovery** (`tools/delegation/agentChild.ts`). A
call's child is named by the call and its intent attempt
(`agentChildRunId`), so a resumed call finds what an earlier attempt
launched. `run.start` is the launch, and a settled turn with a `run.result`
manifest under its `run.end` is the durable answer. A child cut short is
resumed under its own id, not launched again; any other ended child's end
is the call's answer.

**Cross-script reuse (Q2).** A model may fix a failed script and run it
again without re-billing finished children. Only `agent` reuses a completed
result:

- **Key.** A hash of the prompt, every run-affecting option, and a
  fingerprint of every referenced file's bytes, so an edited input file is
  never answered from a stale result. `label` and `phase` stay out.
- **Scope.** The run that issued the `script` call and the background script
  runs it launched. Failed, cancelled and skipped calls are never reused.
- **Record.** The reused call gets its own `script.call` and `tool.result`,
  which names the call it reused (`reusedFrom`).
- **Duplicates.** Two calls in one script with the same key fail the second
  unless they carry distinct `id`s.

## Prompt and discovery

The `script` description holds the surface text plus one typed declaration
per tool the agent declares (Q4), rendered at the step that freezes the
system text and stored with it (`offeredSystem`). A later catalog change
reaches the model as a `contextUpdate` line; the new tool is callable at
once and `describeTool` documents it.

MCP tools and plugin-injected tools are not declared inline.
`searchTools(query, { limit })` ranks the step's pinned catalog with Okapi
BM25 over each tool's name, description, property names and descriptions,
and plugin or server id; `describeTool(name)` returns the full declaration.
The ranker is a pure function over one run's catalog held in memory, not
SQLite FTS5: nothing here is stored, and FTS5's `unicode61` tokenizer does
not split camelCase.

## Engine

QuickJS (`quickjs-emscripten-core` with
`@jitl/quickjs-wasmfile-release-sync`) and not `node:vm`, which is not a
security boundary, or `isolated-vm`, a native addon that needs ABI rebuilds
in three hosts. Each script gets a fresh runtime on its own `worker_threads`
worker, under the limits in `agent/codeSandbox/limits.ts`: 64 MB heap, 1 MB
stack, 30 s of guest CPU, 4096 open calls. The WASM module is compiled once
per session and shared with each worker. The worker source is a bundled
entry (`scripts/code-sandbox-worker.mjs`), so every host ships it.

`CodeSandbox` is a `Context.Service` whose layer is the `codemode` plugin's
session layer. One script call spawns its worker in the call's scope through
`effect/workers/Worker`; closing the scope sets a `SharedArrayBuffer`
interrupt flag the guest polls, then closes and terminates the worker. Each
issued call is forked into a `FiberSet` owned by that scope and runs the
per-call program on the run fiber's context. Settlements go through a
`Queue`, and one loop delivers them, the only place realm state advances.
The wall deadline is `Effect.timeoutOrElse`.

**Errors** are tagged: `ScriptSyntaxError`, `ScriptFault`,
`ScriptCpuExhausted`, `ScriptMemoryExhausted`, `ScriptTimedOut`,
`SandboxUnavailable`. The worker boundary is the one foreign boundary:
messages are Zod-decoded, and failures pass through `ensureError`. The
worker's `NodeRuntime.runMain` is a named runtime entry in
`eslint.config.mjs` and in `dependencyDirection.vitest.ts`'s bare-run list.

## Fit with the plugin model

**`tools` is the step's pinned snapshot.** A script is one call, so `tools`,
`searchTools` and `describeTool` read the generation of the step that
offered it. A plugin switched off mid-script withdraws from the next
generation, not the pinned one, and `contextUpdate` tells the model. On
resume, an in-flight nested call whose tool changed or left settles
`tool_unavailable`, as a direct call does.

**Two built-in plugins contribute the tools** (`tools/builtinPlugins.ts`).
`script` comes from `codemode`, which has no switch: a run gets it when its
agent names it. `agent` comes from `multi-agent`, which has a user switch,
on for a fresh install, so fan-out keeps two consents: the YAML names
`agent`, and the switch is on.

**One writer.** `script.call` and every nested call's rows are core run
history kinds, appended through the run's `RunCell` and committed by the
one `SessionEvents` publisher.

**Hooks** fire per nested call: `PreToolUse` before approval and body,
`PostToolUse` with settlement. A deny settles the call, which the script
sees as `ToolFailed`. The `script` call gets both hooks too.

**Trust and MCP.** An untrusted plugin's tools never enter the generation.
MCP tools enter only when a run declares one, are callable as
`tools["mcp__server__tool"]`, are found through `searchTools`, and keep the
bash approval.

## `agent`

`agent` (`tools/delegation/AgentTool.ts`) took the union of the old
delegation tools' options; the named agent decides what kind of child it
is.

- **Defaults.** In a script it awaits the child unless `background: true`.
  Called directly it detaches and returns a run id, with the result as a
  follow-up; a one-shot parent waits in band.
- **Not folded in.** `claude_code` and `codex` continue vendor sessions,
  take vendor permission modes and ask through a bash-style guard. They stay
  separate tools.
- **A deleted tool name fails loudly.** An agent that declares a tool this
  build does not have is refused at launch, naming the tools and the
  persona's file and saying what replaced the delegation tools
  (`agent/runtime/AgentLaunchContext.ts`). A plugin switched off still
  withholds its tools quietly, because that is the user's switch.

A script reaches run-to-run messaging through existing calls: `agent`
(foreground or `background: true`) and
`tools.executions({ action: 'send' | 'wait' | 'view' | 'query' | 'kill', … })`.
Messages land at the recipient's next turn boundary, so a script never reads
its inbox; a result it awaits is an `agent()` value. Code mode adds no
channel, subscriber or writer. A background script delivers through the
generic child-report envelope.

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
7. **Parity before deletion,** and **the freeze waits** for the deletion,
   so the `workflow.*` kinds were never released.
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
    (2026-10-02). They differed only by category, which the named agent
    decides.
11. **Q8. No script files** (2026-10-02): no `path`, drafts under
    `.texra/scripts/`, `args`, `files` or `script.source` row. The source is
    on the `model.message` row, and a rerun with a fix re-sends the code
    while Q2 reuse keeps finished children free.
12. **Q9. No per-call Restart** (2026-10-02). Skip stays, as a stop of the
    child run; a script retries in code, and a user who wants a call redone
    stops it and asks. No `call.control` or per-call session request.
13. **Q10. The flip bar is the pooled five-night window** (2026-10-02)
    under "Still open", replacing "three consecutive nightlies": three nights of
    four journeys is 12 tasks per arm, which cannot tell a 10-point
    difference from noise.

Rulings 9 to 13: "do as you recommend… they look fine" (2026-10-02).

## Still open

- **Evaluation and the "only" flip.** Not run. Run the live journeys
  (`packages/cli/scripts/validate-journeys.mjs`) under `direct` and `only` on
  gemini38f, deepseek41T and glm53flash, plus one fan-out journey that
  exercises `agent()`, and report pass rate, total tokens, cost, wall time
  and the cached share of input tokens per journey. The bar (Q10), per
  model: the lower bound of a 90% interval on `only − direct` pass rate is
  not below −5 points; mean cost per passing task is no higher than
  `direct`'s; median wall time is at most 1.2 times `direct`'s. Each journey
  runs three times per arm per nightly, pooled over the last five nightlies
  (60 tasks per arm per model) on one commit range and model version; a change to the
  prompt or the tool surface restarts the window. The ruling was written for
  nightlies; live journeys now run on demand only (#13614).
- **The per-model fallback flag (Q3).** A model that fails the bar keeps
  direct tools. The flag is meant to live on `BoundModel`
  (`agent/runtime/modelAccess/ModelAccess.ts`) beside the vendor
  capabilities; it is not built, since nothing has flipped.
- **After the fallback retires:** duplicate detection and response
  partitioning (`DispatchFacts.duplicateOf` and `partition`), the provider
  input preprocess shims, and `.optional()` for new tool inputs.
- **Later, unscheduled:** `executions send` idempotent by deriving its
  delivery id from `callId`; a typed core list or budgeted declarations, if
  the evaluation shows inlining every declaration costs more than it saves.

## Prior art

pi v1.0.0 runs QuickJS on a worker per call with BM25 tool search and no
replay; Codex (`codex-rs` `code-mode*`) runs V8 in a separate host process
with no durable record. Neither survives a restart with its finished calls
intact, which here follows from the run history, not from the sandbox.

## Verified

- Re-read on `main` at `485fbf2b6a` (2026-10-22): `tools/codemode/*`,
  `agent/codeSandbox/*`, `tools/delegation/{AgentTool,agentChild}.ts`,
  `tools/builtinPlugins.ts`, `script.call` and the `tool.intent` origin in
  `shared/schemas/runHistoryEvent.ts`, `RETIRED_ROW_KINDS` in
  `shared/schemas/rowVersions.ts`, `resumeCall` and `scriptCallsOf` in
  `agent/runtime/loop/toolUseDispatch.ts`, the loud refusal in
  `agent/runtime/AgentLaunchContext.ts`, and the `tools:` lists of the
  bundled agents in `packages/extension/resources/agents/`.
- Confirmed no "only" mode and no per-model fallback flag exist in
  `packages/harness`, `packages/llm` or `packages/texra`.
- Not run: any live model or journey.
