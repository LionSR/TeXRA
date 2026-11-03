# Harness real-model acceptance, 2026-11-03

The real-model half of the 1.0 acceptance in
[the harness 1.0 PRD](../../proposed/architecture/2026-10-28-harness-1-release-prd.md):
"真实模型验收至少覆盖两条受支持的模型路线". The routes, by the owner's ruling of
2026-11-03, are Anthropic and DeepSeek. No budget is set, so only small manual
runs are allowed and nothing runs in CI.

**Status: not passed on either route.** The DeepSeek account behind
`DEEPSEEK_API_KEY` is out of credit (`/user/balance` reports
`is_available: false`, a balance of -0.24 CNY), so every request was refused
with HTTP 402 and no scenario reached the model. No Anthropic key is set in
this environment; that run waits for the owner. Money spent: none (every
request was refused before any token was billed).

## The runner

[`packages/harness/example/acceptance.ts`](../../../../packages/harness/example/acceptance.ts),
with the evidence writer
[`_evidence.ts`](../../../../packages/harness/example/_evidence.ts), run by `example:acceptance`
([how to run it](../../../../packages/harness/example/README.md#real-model-acceptance)).
It packs and installs `@texra-ai/llm`, `@texra-ai/harness` and the `acme-notes`
plugin package like the packed-example ladder, so it uses the public entries
only. Each scenario states a task in plain words; the model reads the tool
descriptions and writes the programs itself. The checks read outcomes, calls,
child runs, facts and artifacts, never exact text or request counts.

| Scenario       | Task                                                                                                                                                                                                | Checks                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codemode`     | From an agent file: outline `draft.tex` through a plugin's script module, two `self()` review rounds (the second chosen from the first), count finished children with `executions` SQL over `runs`  | run completed; a script finished; the plugin tool ran; two children completed; an `executions` query succeeded; every section title returned; the SQL count matches the view          |
| `plugin`       | The `acme-notes` agent: two notes through `builtIn:notes`                                                                                                                                           | run completed; a script imported the module; `note_add` ran; both notes are version-1 facts of the plugin; both returned                                                              |
| `crash-resume` | A second process runs a script that waits on a sign-off tool after its first `self()` round; it is killed with SIGKILL once that child's result is committed, and the first process resumes the run | killed by SIGKILL; a child result committed before the kill; the resumed run completed; committed children did not run again; two children completed; the interrupted script finished |

Before the paid runs, the runner was checked on the in-memory model with
turns that play a competent model (each scenario's script written by hand).
All three scenarios passed, and a model that does not do the task fails the
named checks. That check is not real-model evidence and is not kept here.

## Format

One directory per run, `<provider>-<model>-<HHMM>/`:

- `summary.md`: route, model, harness version and commit, a table of the
  scenarios (result, runs, scripts and failed scripts, tokens, the spend the
  runs report, seconds) and each check with what it saw.
- `run.json`: the same as data, with `skipped` when the provider's key is not
  set.
- Per scenario, `codemode/`, `plugin/`, `crash-resume/`:
  - `result.json`: the checks, the failure reason and the spend;
  - `config.json`: the run's stored config (agent, model, instruction);
  - `scripts/<n>.js`: every program the model wrote, in order;
  - `conversation.json`, `children.json`: the root run's conversation and
    each child's;
  - `runs.json`: every run of the session with its identity, model, outcome
    and usage;
  - `calls.json`: every tool call in the root's trace, with how it ended and
    its result (cut at 4000 characters);
  - `outputs/`: the script returns, the run end (with its error), the reply,
    and the plugin facts;
  - `store/`: a copy of the session database, kept local (`.gitignore`).

## Runs

| Run                                                                             | Result                                                                                       |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`deepseek-deepseek-flash-1103`](deepseek-deepseek-flash-1103/summary.md)       | All three fail at the first model request: HTTP 402 Insufficient Balance. No script written. |
| [`anthropic-claude-haiku-5-5-1103`](anthropic-claude-haiku-5-5-1103/summary.md) | Skipped: `ANTHROPIC_API_KEY` is not set. Nothing sent.                                       |

`deepseek/deepseek-flash` is the cheapest DeepSeek model in the llm-zoo 4.2.0
catalog ($0.15 / $0.60 per million input / output tokens);
`anthropic/claude-haiku-5-5` the cheapest current Claude model there.

## Findings

What the runs showed about the public surface, with the evidence:

1. **DeepSeek's out-of-credit reply is not classified.** The 402 body is
   `{"error":{"type":"insufficient_balance_error","code":"invalid_request_error","message":"Insufficient Balance ..."}}`.
   `creditDepleted` in `packages/llm/src/api/verdict.ts` knows OpenAI's
   `insufficient_quota` and Anthropic's low-credit message only, so the run end
   reads `error.kind: "unexpected"` with no `classification`
   (`deepseek-deepseek-flash-1103/codemode/outputs/run-end.json`) where an
   OpenAI or Anthropic account would read `upstream-credit`. An embedder cannot
   tell "top up the account" from an unknown failure without parsing the
   message. Small and clear: fixed in #14606.
2. **Every run, each `self()` child included, sends an unrequested label
   request, outside the run's usage.** `generateSessionDescription`
   (`packages/harness/src/agent/runtime/sessionDescription.ts`) runs a helper
   call on the run's own model for every run that has an instruction, with no
   setting to turn it off. On the in-memory check, `codemode` sent 3 label
   requests beside its 4 turn requests, and the reported usage (480 input
   tokens at 120 per request) counts only the 4. On a real route that is
   spend the run's `usage` and `runs.cost` do not show, and a `self()` loop
   doubles its request count. Larger than a small fix: whether an SDK session
   labels runs at all, on which model, and where that spend is reported is a
   design choice for the owner.
3. **The library writes to the embedder's stdout.** A run prints
   `[agentRegistry] Loaded 1 agents in 11ms`, `[executeAgent] Starting run`,
   `[childRunLoop] Turn completed in 0.1s`,
   `[SessionDescription] Failed to generate session description: ...` and
   `[agentTrace] Model request failed (no retry available) (provider response body)`
   (the last with a label for a payload it does not show), and the route
   binding (`packages/harness/src/agent/runtime/modelAccess/binding.ts`) logs
   `DeepSeek V4.1 Flash has no medium effort; using high (accepts low, high, max).`
   twice per run (the run asked for `medium`, which that model lacks).
   A program that writes its own output to stdout, a CLI
   printing JSON for one, gets these lines mixed in. Worth a decision on
   where an embedder's logs go by default.
4. **A plugin tool that waits needs `slow: true` to be seen waiting.** Without
   it a call's card opens and closes in the batch that records its result, so
   a tool that waits on a person never shows as started, in its own process or
   in another one watching the store. The runner's sign-off tool needed it to
   find its kill point. `slow` is documented in one line on `ToolDefinition`
   ("Its card opens before the call runs") and not in `defineTool`'s own
   description or the README; a plugin author with a waiting tool will not
   find it. Documentation, not a defect.

What a real model makes of the `script`, `self` and `executions` descriptions
(the point of this acceptance) is still unmeasured: no request reached a
model.
