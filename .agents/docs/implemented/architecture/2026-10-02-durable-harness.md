---
created: 2026-10-02
status: implemented
---

# The durable harness: one run history, one script tool, everything else a plugin

The owner wants a general, Effect-native, durable agent harness, with TeXRA as
one app on it. This note records the durability design that closed the gaps
pi-durable showed: who owns a child run, one row kind for every edit of the
model's view, fork, auto-continue on open, and a crash-point conformance suite.
Lanes H1 to H6 landed it (#13638, #13642, #13656, #13657, #13658, #13660,
#13663, #13867). The design is in
[codemode](./2026-10-01-codemode-everywhere.md) for the script tool and in
[the package split](./2026-10-02-harness-package-split.md) for the package
boundary. Paths are under `packages/harness/src/`.

The harness has five parts:

1. the durable run history and the run loop;
2. `script` as the one model-facing tool;
3. everything else contributed by plugins: tools, MCP servers, agents, skills,
   and domain capabilities such as LaTeX, papers and Lean;
4. a hot-pluggable tool catalog, which changes what a run is offered at step
   boundaries;
5. tool search over the pinned catalog (`searchTools`, `describeTool`), so a
   large catalog costs no prompt tokens.

## Owned children

An awaited child belongs to the call that awaits it.

- Its id derives from the parent run, the response, the call id and the intent
  attempt (`agentChildRunId`, `tools/delegation/agentChild.ts`), and
  `run.start.parent.callId` records the call (null for a detached child).
- On resume, the parent's open `agent` call reattaches: it reads back a child's
  settled turn, resumes a child cut short under its own id, and launches nothing
  new.
- No run ends while its open call owns a child that has not ended. A stop
  retires such a child first; any other end is refused (`endOwnedChildren`,
  `agent/storage/runLifecycle.ts`).
- Resuming an owned child resumes its parent (`Run.redirectedFrom`). A detached
  child keeps independent resume.

The live tree is not a fiber tree: every run forks on the session's context
through the one launch door, and the parent is data.

## View edits: one `context.edit` row

Every edit of the model's view other than an append is one row kind,
`context.edit` (`shared/schemas/runHistoryEvent.ts`), with
`cause: 'compaction' | 'reset' | 'handoff' | 'fork'`. It replaces the messages
in `range` (`[from, to)`) with `messages`. `trigger` is set only for a
compaction (`context-limit`, or `user` for `/compact`). `base` is the edit the
view stood at when this one was computed, and the fold refuses an edit whose
base is no longer the latest.

- **Compaction** (`agent/runtime/run/compaction.ts`). A threshold compaction
  runs in the background, in the run's scope, and lands at a step boundary only
  if no view edit committed since its `base`; a stale result is dropped and its
  usage still recorded. The blocking path stays for overflow.
- **Reset and handoff** (`run.reset`, with `handoff` text) clear the view at the
  run's next park; a handoff adds its text as a user follow-up.
- **Fork** (`run.fork`, `agent/runtime/forkRun.ts`) starts a new run whose
  `run.start.provenance` is `{ kind: 'fork', from, at }` and whose first row is
  a view edit seeded with the source's view at `at`. The cut must be a settled
  position; anything else is refused. Pending sets are not copied: follow-ups,
  requests and retry permits start empty, and usage starts at zero. Plugin facts
  are not copied; goal mode is paused, as on resume.

## Auto-continue on open, blocked until installed

A run whose process died is not written to; it reads as interrupted because its
owner claim is dead. A graceful close settles open runs as `CANCELLED`.

An interactive host window opens its session with `host.interruptedTasks`
(`effect/sessions.ts`) and then applies `texra.resumeOnOpen`: `ask` (the
default) lists the interrupted tasks, `auto` continues them. Headless runs and
the SDK do neither.

A resume whose agent is missing from the catalog, or comes from an installed
plugin that is off or not trusted, does not fail: the run stays interrupted with
a reason in the projection, and the session resumes it once the catalog has it
again (`agent/runtime/resumeBlocker.ts`). A tool plugin that is off is not a
blocker: the step withholds its tools and a call settles `tool_unavailable`.

## Interrupted calls

A call whose body may have run when the process died re-runs on resume only when
its tool and the call both say `replay: 'safe'`. Otherwise it settles as
"outcome unknown" and the model decides what to do next. The owner removed the
"Run again / Skip" question on 2026-10-06, so no person is asked, under any
approval policy.

## The SDK's extend half

A plugin is a `Plugin` value (`tools/plugins.ts`, `definePlugin`), passed to
`Sessions.layer({ platform, plugins })`. `harnessBuiltins`
(`@texra-ai/harness/plugins`) is the harness's own list; each TeXRA host passes
the built-ins plus TeXRA's app plugins. `Session.resume(runId)` returns the same
`Run` handle as `start`.

Not built: contributing a plugin live inside a `Scope` (`Plugins.contribute`),
and the run's file system and shell as one replaceable execution environment.
The
[general-package design](../../proposed/architecture/2026-10-21-harness-general-package-design.md)
plans the second as its Execution port.

## Conformance

The tests are the contract.

- **The crash-point suite** (`src/test-kernel/support/crashConformance.ts`, run
  by `crashConformanceBuiltins.vitest.ts` over the built-ins and
  `crashConformanceTexra.vitest.ts` over TeXRA's plugins). A scripted model
  drives one run with a parallel tool batch, an approval, a retry, an awaited
  child, a fork and a compaction. For each commit point N of a clean run, it
  runs again, interrupts the process after commit N, reopens and resumes, and
  asserts the durable invariants the harness README numbers (**I1** to **I9**):
  among them, recovery reaches the clean run's outcome, a tool call has one
  settlement, and a model invocation has at most one committed response.
- **The golden 1.0 store** (`goldenStore.vitest.ts`, written by a real CLI run,
  `packages/cli/scripts/generate-golden-store.mjs`): every row decodes, the
  folds equal their pinned values, a parked run resumes with the recorded
  request, and projections rebuilt from zero match the stored ones.
- The per-kind row-version test (`rowVersions.vitest.ts`) and
  `stepBoundaryRatchet` for hot-plug.

A `./testing` subpath export of the suites waits for a named external consumer,
the same rule as npm publication.

## Considered and dropped

- **An effect class (read/write/external) replacing `replay`.** pi's rule is the
  same binary rule TeXRA has. A class would derive `parallelSafe` and `replay`
  from one word, but it deletes neither stored field and adds a third
  vocabulary. Keep both flags (D1).
- **A same-path edit queue.** `edit_file`, `write_file` and `accept_run_files`
  already read, merge and write on a process-wide `withPerKeyLane` keyed by real
  path, with a three-way merge or conflict (`tools/approval/approvedWrite.ts`),
  which catches writers outside the lane. Nested script edits go through the
  same per-call program.
- **`defineDoc`.** `plugin.fact` is typed and versioned per plugin, with
  upcasters. A fork does not copy plugin facts. Third-party plugins have no
  durable state for 1.0.
- **The live tree as a `FiberSet` per parent.** Children fork on the session
  through the one launch door (rule R2 of the
  [core concepts](./2026-09-26-core-concepts.md)), so a child never inherits its
  parent's context. Ownership is enforced durably and by the live cascade.
- **`completing` holds.** A parent's result is the awaiting call's
  `tool.result`, which cannot commit before the child ends, so the
  owned-children refusal is all that is needed.
- **A second storage backend and a storage contract suite parameterised by
  backend.** TeXRA has one backend on purpose.
- **In-process hooks as Effect values.** Hooks stay the Claude Code protocol,
  recorded once ([hooks v1](./2026-09-28-code-plugins-hooks-v1.md)). Typed
  extension points (tools, continuations, prompt sections, layers, arms) cover
  in-process needs, and a second hook system would be a dual system.
- **A daemon for auto-continue.** The next process to open the session continues
  the run.

## Row decisions

| #   | Decision                               | Ruled                                                                                                                                                                                    |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Effect class replacing `replay`        | Keep `replay` + `parallelSafe`                                                                                                                                                           |
| D2  | View edits                             | One kind, `context.edit`, replacing `model.compaction`; `range` replaces `keepPrefix`, and `base` is the stale check. Reset, handoff, fork, and a later undo need no further kind        |
| D3  | `run.start.provenance`                 | A tagged union, `{ kind: 'fork', from: { id, uid }, at: seq } \| null`. Not `origin`: the row envelope's `origin` is the writing process. Resume is not a provenance; it is the same run |
| D4  | Ownership of an awaited child          | `run.start.parent.callId`, nullable, so the session view routes Resume without reading another aggregate's run history                                                                   |
| D5  | Blocked reason                         | In the projection, not a row: it is a fact about this build and its catalog, not about the run                                                                                           |
| D6  | `run.start.checkpointId`, `workflow.*` | Deleted with the workflow-script runner (codemode lane 7)                                                                                                                                |

## Owner rulings

Ruled by the owner on 2026-10-02 (PR #13612).

1. **First-party plugins as code: yes.** The 2026-09-30 `PluginModule` ruling is
   narrowed for first-party plugins. A `Plugin` value is passed to the harness,
   with TeXRA as the named consumer. Third-party plugins stay data, MCP and
   hooks, and no third-party code loads in process.
2. **Auto-continue defaults.** Off for headless `texra run` and the SDK; `ask`
   for the TUI, desktop and the extension, as one prompt listing the interrupted
   runs; `auto` available as a setting.
3. **One `context.edit` kind replaces `model.compaction` (D2): yes.** It covers
   compaction, reset, handoff and the fork seed, and leaves room for undo.
4. **Fork only at a settled position: yes.** A cut anywhere else is refused, so
   a fork never contains a result nobody produced.
5. **Package names.** Settled later: `@texra-ai/harness`, `@texra-ai/llm`, and
   the app `@texra-ai/texra` at `packages/texra`
   ([package split](./2026-10-02-harness-package-split.md), §8).
6. **Resuming an owned child goes through its parent (D4): yes.** A user cannot
resume an awaited child on its own; a detached child keeps independent resume.
</content>
