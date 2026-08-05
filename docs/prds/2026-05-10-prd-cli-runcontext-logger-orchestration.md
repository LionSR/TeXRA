---
created: 2026-05-10
updated: 2026-05-11
---

# PRD: CLI, RunContext, and Logger v2 orchestration

**Status:** Draft
**Owner:** TBD
**Date:** 2026-05-10
**Companions:** [`2026-05-04-prd-cli-app.md`](./2026-05-04-prd-cli-app.md), [`2026-05-06-prd-runcontext-refactor.md`](./2026-05-06-prd-runcontext-refactor.md), [`2026-05-06-prd-logger-v2.md`](./2026-05-06-prd-logger-v2.md)

## 1. Summary

This PRD coordinates the implementation of the TeXRA CLI with the minimum RunContext and Logger v2 work needed to make the CLI a coherent third host. The repository currently has the right ingredients, but not yet in the shape assumed by the companion PRDs:

- The production kernel still lives in root `src/`; `packages/core` exists but is a stub.
- There is no `packages/cli` package yet.
- `executeAgent()` already constructs most of the useful run state through its private `AgentLaunchContext`.
- The existing `src/agent/runtime/RunContext.ts` is a small test-facing object and is not used by production runtime code.
- Logger, approval, runtime-host, and tool-call context still use ambient module state.

The implementation should therefore not begin with a large `packages/core` migration. The first move is to turn the context already assembled by `executeAgent()` into the real internal `RunContext`, then build the CLI against the current root aliases. The package split can follow after the runtime boundary is clean.

## 2. Goal

Ship a useful CLI v1.0 while improving the kernel boundary in the smallest safe steps:

1. `texra run <workflow-agent>` for headless workflow runs.
2. `texra chat` for a lazy-loaded interactive terminal tool-use session.
3. `texra agents list`, `texra models list`, `texra version`, and `texra --help`.
4. A minimal explicit `RunContext` around `executeAgent()`, sufficient for per-context approval coordinators.
5. A minimal Logger v2 path with structured records and host sinks, sufficient for CLI text and NDJSON output.

The result should make the CLI another host over the same agent runtime, not a parallel implementation.

## 3. Non-goals

- Do not implement `texra mcp serve` in v1.x.
- Do not move the whole root `src/` tree into `packages/core` as the first step.
- Do not implement OAuth, keyring storage, layered file config, sessions, hooks, GitHub Action support, or `texra resume` in v1.0.
- Do not rewrite agent flows, model handlers, or tools except where a small context parameter or host hook is required.
- Do not replace all ambient state in one PR. Retire it in dependency order.

## 3.1 Implementation audit, 2026-05-11

The current implementation is split across a base PR and five focused follow-ups:

| PR    | Scope                                                                       | Issue coverage | Current state                                                                        |
| ----- | --------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| #3839 | Scaffold CLI, RunContext, logger, and orchestration base                    | #3833-#3838    | Open, non-draft, mergeable, GitHub checks passing, no unresolved live review threads |
| #3843 | Packaged `texra run` validation                                             | #3834, #3840   | Open, non-draft, mergeable, GitHub checks passing                                    |
| #3844 | CLI `ask` approval prompts                                                  | #3835, #3841   | Open, non-draft, GitHub checks passing; stacked mergeability depends on #3843        |
| #3845 | Legacy host logs through structured logger sinks                            | #3833, #3842   | Open, non-draft, mergeable, GitHub checks passing, no unresolved live review threads |
| #3846 | Plain `texra chat` loop                                                     | #3836, #3848   | Open, non-draft, mergeable, GitHub checks passing                                    |
| #3847 | `ToolFileInteractionContext` async storage and split run/call context views | #3837, #3849   | Open, non-draft, mergeable, GitHub checks passing                                    |

The stack now provides a working scaffold, packaged `texra run` validation, CLI approval prompts, a structured-logger host-sink migration slice, a plain terminal chat loop, async-scoped tool-call context storage, and the `src/tools` split between run-owned and call-owned tool-context views. PR #3847 stores separate run/call views in the async context frame, guards their fields with exhaustive key maps, and migrates tool readers to run-owned, call-owned, or explicit mixed access paths. A search after the migration shows no remaining `getCurrentToolFileInteractionContext()` imports under `src/tools`. It does not claim to finish every future v1 item in this PRD. In particular, the richer `texra chat` renderer remains tracked by #3848, and the final architectural decision about whether `ToolRunContext` becomes part of `RunContext` remains tracked by #3837.

The parent issues #3833-#3837 remain open until maintainers merge the stack or decide that the linked follow-up issues own the remaining acceptance criteria.

## 4. Actual repository state

### 4.1 Package layout

Current workspace packages:

- `packages/extension`
- `packages/desktop`
- `packages/core`

`packages/core/src/index.ts` is a stub. The real kernel is still imported through root aliases such as `@agent/*`, `@model/*`, `@tools/*`, and `@platform/*`, all resolving into root `src/`.

The CLI should initially use the same alias system. A full kernel migration can be a later refactor after `RunContext` has made the boundary explicit.

### 4.2 Runtime entry point

The central file is `src/agent/runtime/executeAgent.ts`.

`executeAgent()` currently:

- wraps execution in `runWithAgentRuntimeHost(options?.runtimeHost, ...)`;
- calls `buildAgentLaunchContext(...)`;
- starts either `runToolUseFlow(...)` or `runReflectionFlow(...)`;
- handles lifecycle registration, progress events, stream status, usage, and final result construction.

The private `AgentLaunchContext` already contains most of the future run context:

- `runtimeHost`
- `streamId`
- `executionId`
- `logger`
- `config`
- `setting`
- `prompt`
- `modelHandler`
- `userVarChannels`
- `workingDirectory`
- `usageMonitor`
- `parentStage`
- `storageKey`

This object is the correct seed for the production `RunContext`.

### 4.3 Existing `RunContext`

`src/agent/runtime/RunContext.ts` currently exposes `createRunContext()` with:

- `runtimeHost`
- `logger`
- `approvals`

This object is not used by `executeAgent()`, flows, tools, approval gates, or logging. It should be replaced or evolved into the production `RunContext`, not preserved as a competing abstraction.

### 4.4 Ambient state that matters for CLI

The following ambient state is still active:

- `src/agent/runtime/AgentRuntimeHost.ts`: `defaultAgentRuntimeHost` and an `AsyncLocalStorage`.
- `src/agent/runtime/ProgressSink.ts`: `defaultProgressSink`.
- `src/agent/runtime/RunStorageService.ts`: module-level run storage service.
- `src/agent/runtime/{PlanApprovalCoordinator,AgentProposalCoordinator,RetryRequestCoordinator}.ts`: singleton coordinator exports.
- `src/logger/logUtils.ts`: channel map, output-channel factory, main output channel, and separate logger group `AsyncLocalStorage`.
- `src/tools/approval/bashApproval.ts`: module-level bash approval controller.
- `src/tools/approval/toolEditApproval.ts`: module-level edit approval handler and stream approval controller.
- `src/tools/inquiry/ExternalInquiryTool.ts`: module-level pending inquiry map.
- `src/agent/followUp/ToolFileInteractionContext.ts`: async-scoped tool-call context frame with compatibility access to the combined context and split run/call views.
- `src/agent/index/agentDirectoriesRegistry.ts`: module-level agent directory provider.

The CLI v1.0 does not need all of these retired, but it does need a clear ownership model.

## 5. Design principle

The first working abstraction is:

```text
executeAgent() builds the run context; flows and tools consume it.
```

Do not add a second context path beside `AgentLaunchContext`. Instead, make `AgentLaunchContext` the production context and then factor out host-facing services from it.

This minimizes change amplification because the runtime already passes this object into both workflow and tool-use flows.

## 6. Phase plan

Each phase includes a scheduled refactoring budget. These refactorings are not optional cleanup after the feature; they are part of the phase definition. The purpose is to prevent the CLI work from leaving a second host boundary, second logging path, or second approval model behind.

### Phase A: Context foundation

**Purpose:** make the current runtime context explicit without changing behavior.

Work:

- Replace the current test-only `RunContext` with a production type that starts from `AgentLaunchContext`.
- Add `withRunContext(ctx, fn)`, `useRunContext()`, and `tryUseRunContext()`.
- Wrap `executeAgent()`, `executeMergeAgent()`, and `resumeToolUseFromSnapshot()` in `withRunContext`.
- Keep `runWithAgentRuntimeHost()` as a compatibility shim that first checks the active run context.
- Keep existing call signatures stable.

Scheduled refactorings:

- Merge the current test-only `RunContext` shape into the production context instead of maintaining two context types.
- Move context construction comments from PRD language into code comments around `buildAgentLaunchContext()` so future readers see why this is the composition point.
- Rename narrow local variables where needed so `runtimeHost`, `progress`, `streamId`, and `executionId` have one clear meaning.

Acceptance:

- `executeAgent()` remains source-compatible for extension and desktop callers.
- `getAgentRuntimeHost()` can obtain the host from the active run context.
- The old default runtime-host fallback still exists, but production entry points no longer rely on it when a context exists.

### Phase B: Per-context plan, proposal, and retry coordinators

**Purpose:** make the interactive approval surfaces safe for CLI sessions.

Work:

- Add coordinator instances to the run context:
  - `plan`
  - `proposal`
  - `retry`
- Convert runtime and flow call sites from singleton imports to `useRunContext().coordinators`.
- Preserve exported singleton coordinators only as deprecated compatibility shims during the transition.
- Update extension and desktop message handlers to resolve against the active run when possible; where no active run is available, keep existing behavior until the final sweep.

Scheduled refactorings:

- Extract a single `RunCoordinators` construction helper so extension, desktop, CLI, and tests do not each assemble coordinators differently.
- Replace flow-level imports of singleton coordinators with a small helper at the runtime boundary, then inline the helper once all call sites accept context.
- Add one cleanup path for stream teardown so plan, proposal, retry, bash, edit, and external-inquiry gates do not each invent separate rejection logic.

Acceptance:

- Plan, proposal, and retry approvals can be resolved per run.
- No new production code imports the singleton coordinator exports.
- Existing extension and desktop behavior is unchanged for ordinary single-run use.

### Phase C: Minimal Logger v2 foundation

**Purpose:** give CLI rendering a structured log source without rewriting all logging call sites.

Work:

- Introduce:
  - `LogLevel`
  - `LogFields`
  - `LogRecord`
  - `LogSink`
  - `Logger`
- Implement `Logger.swapSink(next)`.
- Add a legacy sink that preserves the current extension/desktop string output behavior.
- Keep `src/logger/logUtils.ts` as a compatibility shim for one release.
- Route `AgentLogger` group operations through `Logger.withGroup()` once a run context exists.

Scheduled refactorings:

- Keep rendering out of `AgentLogger`; it should produce semantic records and stages, not formatted strings.
- Separate `LogSink` from the platform `LogBackend` compatibility surface so new hosts do not inherit the old channel-first API.
- Move group state from `logUtils.ts` into the logger instance before adding CLI terminal rendering, otherwise the terminal sink will inherit the old ALS problem.

Acceptance:

- CLI can install a stderr text sink and an NDJSON sink.
- Extension can still create VS Code output channels.
- Desktop can still use console logging until an Electron sink is added.
- No logger schema is coupled to progress-event schema; only NDJSON transport may be shared.

### Phase D: CLI package skeleton and headless workflow mode

**Purpose:** ship the first visible CLI surface.

Work:

- Add `packages/cli`.
- Add `packages/cli/src/runtime/cliContext.ts` as the single process-data reader.
- Add a `texra` bin entry.
- Wire Node platform initialization using current defaults:
  - `consoleLog` or Logger v2 CLI sink
  - `nodeFilesystem`
  - `nodeStorage`
  - `createNodeWorkspace(() => cwd)`
  - memory state stores
  - `EnvSecrets`
- Add `texra run <workflow-agent>`.
- Add headless text output and `--output-format ndjson`.
- Add `texra agents list`, `texra models list`, `texra version`, and `texra --help`.

Scheduled refactorings:

- Keep `resolveCliContext()` as the only place that reads `process.argv`, `process.cwd()`, package metadata, resource paths, output format, and approval policy.
- Put CLI composition in one module, for example `packages/cli/src/runtime/initPlatform.ts`; command files should not install platform services directly.
- Keep command parsing separate from execution. A command handler should normalize flags and call a small runtime function, not assemble agent internals.
- Add a CLI-only import guard that fails the CLI build if `vscode` or `electron` enters the bundle.

Acceptance:

- `texra run polish --input paper.tex --output paper.polished.tex` reaches `executeAgent()`.
- `commands/` files receive a resolved `CliContext` and do not read package metadata, cwd, environment, or resource paths directly.
- The CLI writes user-readable progress to stderr in text mode.
- NDJSON mode writes machine-readable records to stdout.
- The CLI does not import `vscode` or `electron`.

### Phase E: CLI approval policy

**Purpose:** make tool-use and chat mode possible.

Work:

- Implement `approval-policy` values:
  - `never`
  - `ask`
  - `yolo`
- Register CLI handlers for:
  - edit approval
  - bash approval
  - plan approval
  - proposal approval
  - retry request
  - external inquiry
- For v1.0, it is acceptable for bash, edit, and external inquiry to use their existing module-level controllers, provided the CLI is documented as single-run-per-process.

Scheduled refactorings:

- Introduce one host-facing approval adapter in the CLI and keep policy decisions there; individual tool handlers should not parse CLI flags.
- Keep `packages/cli/src/runtime/approvalAdapter.ts` as the only CLI module that maps `never | ask | yolo` to bash, edit, plan, proposal, retry, and external-inquiry outcomes.
- Normalize approval results into one discriminated union before adapting them to bash, edit, plan, proposal, retry, or external-inquiry result types.
- Record every remaining global approval dependency in code comments with the issue number that will retire it.

Acceptance:

- `never` denies gated edit/bash actions and returns the denial to the model as feedback. (Originally specified as a dedicated approval-denied exit code; that code was retired in 2026-08 — see the exit-code contract below.)
- `yolo` approves edit/bash actions without prompting.
- `ask` prompts in TTY contexts.
- Non-TTY `ask` fails clearly instead of hanging.

### Phase F: `texra chat` interactive mode

**Purpose:** ship the standalone interactive CLI.

Work:

- Add a terminal UI application loaded only for `texra chat`.
- Implement:
  - stream pane
  - prompt input
  - approval card
  - basic slash commands: `/agent`, `/model`, `/yolo`, `/clear`, `/exit`
  - Ctrl-C cancellation
  - Ctrl-D exit
- Use the same approval policy and handlers as Phase E.

Scheduled refactorings:

- Keep terminal renderer components pure: they receive stream state and callbacks, but do not call `executeAgent()` directly.
- Share the text/NDJSON/terminal stream normalization layer so the renderers do not grow separate progress-event interpreters.
- Lazy-load the terminal renderer behind the `texra chat` command boundary and add a small architectural test or build check to preserve that boundary.
- Keep `packages/cli/src/chat/runChat.ts` as the only static chat entry imported dynamically by the root command; renderer components should live below that boundary.

Acceptance:

- `texra chat` starts an orchestrator session against the current workspace.
- Tool calls and assistant responses stream live.
- Edit/bash approvals appear inline.
- `texra chat --approval-policy yolo` can complete a multi-tool flow without prompts.
- The terminal renderer is not loaded for `texra run` or `texra --help`.

### Phase G: Sweep and hardening

**Purpose:** reduce technical debt introduced by compatibility.

Work:

- Remove singleton coordinator imports from production runtime code.
- Reduce direct `getAgentRuntimeHost()` usage inside flows and tools.
- Decide whether `ToolFileInteractionContext` becomes:
  - an explicit tool-call context parameter, or
  - a child of `RunContext`.
- Add lint checks forbidding new ambient runtime setter pairs in kernel zones.

Scheduled refactorings:

- Preserve the split introduced in `ToolFileInteractionContext.ts`: `ToolRunContext` contains run-owned fields, while `ToolCallContext` contains one tool-call state snapshot.
- Migrate new readers to `getCurrentToolRunContext()` or `getCurrentToolCallContext()` instead of the full-stack getter whenever they only need one side of the boundary.
- Decide whether `ToolRunContext` becomes a child of `RunContext`; do not leave it as an undocumented stack.
- Remove compatibility singleton exports only after every production reader has moved to `RunContext`.
- Add a short architecture note documenting which state is per process, per run, per stream, and per tool call.

Acceptance:

- New runtime code uses `RunContext`.
- Remaining ambient state is either documented as compatibility or tracked in issues.
- Extension, desktop, and CLI continue to share the same behavior path.

## 7. Dependency graph

```text
Phase A: Context foundation
  -> Phase B: Per-context coordinators
  -> Phase E: Approval policy
  -> Phase F: texra chat

Phase C: Logger v2 foundation
  -> Phase D: texra run output
  -> Phase F: texra chat stream pane

Phase D: CLI package + texra run
  -> Phase E: Approval policy
  -> Phase F: texra chat

Phase G follows after the CLI is functional.
```

The fastest useful path is A, C, D, E, F. Phase B should land before F if multiple interactive sessions per process are in scope; otherwise it may be completed during hardening, but this should be treated as technical debt.

## 8. Issue breakdown

Recommended GitHub issues:

1. **Promote `AgentLaunchContext` into the production `RunContext`**
   - Scope: `executeAgent.ts`, `RunContext.ts`, `AgentRuntimeHost.ts`.
   - Outcome: `executeAgent()` enters `withRunContext`.

2. **Move plan/proposal/retry approvals onto `RunContext`**
   - Scope: three coordinator files, flow cleanup paths, extension and desktop resolution handlers.
   - Outcome: no new production imports of singleton coordinator exports.

3. **Add Logger v2 interfaces and compatibility shim**
   - Scope: platform log interface, `logUtils.ts`, `AgentLogger`.
   - Outcome: structured records can be routed to host sinks while legacy logging still works.

4. **Create `packages/cli` and ship `texra run`**
   - Scope: package skeleton, bin entry, platform init, workflow invocation, text and NDJSON output.
   - Outcome: workflow agents run from a terminal.

5. **Implement CLI approval policy and handlers**
   - Scope: approval policy parser, bash/edit/plan/proposal/retry/external-inquiry handlers.
   - Outcome: `never`, `ask`, and `yolo` work consistently.

6. **Implement `texra chat` with a lazy-loaded terminal renderer**
   - Scope: TUI app, stream pane, prompt input, approval card, slash commands, cancellation.
   - Outcome: tool-use agents work interactively in a terminal.

7. **Decide and refactor `ToolFileInteractionContext` ownership**
   - Scope: tool-use flow and tools that read the module-level context stack.
   - Outcome: tool-call context does not become the next concurrency bottleneck.

## 9. Risks

### Risk: scheduled refactorings are treated as polish

The CLI work can easily ship a working binary while leaving hidden host-specific branches and duplicate adapters behind. That would make later package splitting more expensive.

Mitigation: each implementation issue should carry an explicit scheduled-refactoring checklist, and a phase is not complete until that checklist is either done or converted into a follow-up issue with a concrete owner.

### Risk: two context abstractions

If `RunContext` is built beside `AgentLaunchContext`, the runtime will have two sources of truth. This creates hidden bugs in stream identity, logging, approval routing, and cancellation.

Mitigation: evolve `AgentLaunchContext` into `RunContext`.

### Risk: CLI imports VS Code-only code through aliases

The current root alias graph contains some VS Code imports under `src/auth` and `src/common`. A CLI bundle must be checked for accidental imports.

Mitigation: add a CLI build rule that treats `vscode` and `electron` imports as forbidden, not externalized.

### Risk: approval gates remain partly global

Bash, edit, and external inquiry still have module-level controllers. For v1.0 this is acceptable only if the CLI is one run per process.

Mitigation: document the limitation, then retire these gates after plan/proposal/retry are per-context.

### Risk: Logger v2 becomes too large

The full logger PRD includes sinks and future MCP work. The CLI v1.0 only needs text, NDJSON, and lazy-loaded terminal routing.

Mitigation: implement the interfaces and CLI sinks first; defer MCP and rich desktop sinks.

## 10. Validation plan

Do not run `npm test`; it attempts to download a VS Code test environment.

Recommended checks by phase:

- Type checking: `npm run typecheck`
- Fast extension build: `npm run compile:fast`
- Safe extension build before commit: `npm run compile:safe`
- Desktop build when platform imports change: `corepack pnpm run desktop:build`
- CLI package build once added: `corepack pnpm --filter @texra/cli build`
- CLI smoke checks:
  - `texra --help`
  - `texra agents list`
  - `texra models list`
  - `texra run polish --input paper.tex --output paper.polished.tex`
  - `texra chat --approval-policy never`
  - `texra chat --approval-policy yolo`

## 11. Success criteria

- The CLI package exists and does not import `vscode` or `electron`.
- `texra run` and `texra chat` both call the same `executeAgent()` used by extension and desktop.
- `executeAgent()` enters a production `RunContext`.
- Logger output can be rendered differently by extension, desktop, and CLI without changing agent code.
- Plan/proposal/retry approvals have a path to per-run resolution.
- MCP remains out of v1.x.
- The package split into `packages/core` is easier after this work, not required before it.

## Single source of truth and no pass-through layers

The CLI must have exactly one boundary that reads process input. `packages/cli/src/runtime/cliContext.ts` owns `process.argv`, `process.cwd()`, environment-derived defaults, package-version discovery, output-mode selection, approval-policy selection, and resource-root selection. Command modules receive a resolved `CliContext`; they may interpret command intent, but they must not read process state directly.

The architecture must also reject shallow relay modules. A module is acceptable only if it owns a real decision, invariant, or side effect. Examples: the approval adapter maps CLI policy to concrete tool decisions; the runtime host renders progress events; the log sinks implement output backpressure and serialization. A file that only renames, normalizes, or forwards another module's data should be removed and its call sites should use the source module directly.

The CLI package includes an architecture check at `packages/cli/scripts/check-host-imports.mjs`. It must fail on direct `vscode`/`electron` imports and on new process-input reads outside `cliContext.ts`. This guard is part of the maintainability requirement, not an optional lint.

## Abstraction budget across extension, desktop, and CLI

Every shared abstraction introduced by this program must pay for itself by removing duplication across at least two hosts or by making one invariant impossible to violate. Do not introduce host-neutral interfaces merely to make the architecture look symmetric. The extension, desktop app, and CLI are not identical surfaces: they should share the execution kernel, run context, agent directory bootstrap, logger records, and approval semantics, but each host should keep its own presentation and local side effects.

Use this host-boundary rule during implementation:

- Shared core owns agent execution semantics, run context, logger records, model selection, agent directory discovery, and approval request identities.
- Extension owns VS Code commands, webviews, notifications, and editor integration.
- Desktop owns Electron windows, IPC, filesystem bootstrap, and desktop presentation.
- CLI owns process input, terminal output, exit codes, non-interactive approval policy, and future interactive terminal chat.

A proposed abstraction should be rejected if it only forwards calls between these layers. Prefer direct use of the source of truth. If an adapter remains, its PR description must state the decision it owns and why that decision cannot live in the caller or shared core.

## PR evidence requirements

Each implementation PR in this loop must show its work for maintainability. The PR description must include:

- The single source of truth affected by the change.
- Any duplication removed, or an explanation that no duplication was introduced.
- Any abstraction added, with the invariant or host-boundary decision that justifies it.
- Host impact for extension, desktop, and CLI, including an explicit statement when a host is unaffected.
- Scheduled refactoring work created or completed, especially around CLI context, logger migration, run-context ownership, and approval routing.

This evidence is required because the main risk of this program is not feature incompleteness; it is change amplification. A PR that implements CLI behavior by copying extension logic, or by adding a relay module that hides the real source of truth, should be considered incomplete even if it appears to work.

## OpenTUI decision for `texra chat`

Use OpenTUI as the preferred renderer candidate for `texra chat`, but do not add it as a hard dependency until a PR proves the Node/npm distribution path. The current public documentation describes OpenTUI as Bun-first with Node support in progress, and the repository uses a native Zig core. That is promising for an interactive terminal agent, but risky for TeXRA's Node 20+ CLI, GitHub Action, and global npm installation path.

The implementation rule is therefore conditional:

- `texra run` must remain independent of OpenTUI.
- OpenTUI, if used, must be lazy-loaded only from the chat path.
- Core agent execution, run context, logging, and approval coordinators must not import renderer types.
- The PR that adopts OpenTUI must show installation and runtime evidence for Node 20+ on CI-relevant platforms.
- If this evidence is weak, keep the renderer boundary small and use a Node-stable fallback for the first chat loop.

This preserves the single-source-of-truth rule: the shared kernel owns semantics; the CLI chat renderer owns only terminal presentation and input behavior.

## Ralph loop handoff checklist

Use this checklist before opening or merging implementation PRs from this orchestration plan. The checklist is intentionally about ownership and evidence, not just feature presence.

### Issue #3833: Logger v2

Acceptance requires `LogRecord` to be the shared schema for logger output. Extension, desktop, CLI, and tests may define sinks, but not competing record shapes. Any legacy `logUtils` path left behind must be explicitly marked as a temporary migration shim with a deletion phase. PR evidence must show which sink owns each host effect and which logging path was removed or scheduled.

### Issue #3834: CLI `texra run`

Acceptance requires `texra run` to enter the same `executeAgent` path as the extension and desktop. `packages/cli/src/runtime/cliContext.ts` remains the only process-data reader. The run command consumes `CliContext`, initializes the CLI platform, installs CLI approval handlers, loads shared agents, and passes a CLI runtime host into `executeAgent`. No workflow-agent logic is copied into the CLI package.

### Issue #3835: CLI approval policy

Acceptance requires one CLI approval adapter that maps resolved `CliContext.approvalPolicy` to concrete approval decisions. The adapter may own non-interactive denial, yolo approval, terminal prompting, timeouts, and exit behavior. It must not own request identity or lifecycle; those stay in shared coordinators. The PR must show how `never`, `ask`, and `yolo` behave for edit, bash, plan, proposal, retry, and external inquiry gates.

### Issue #3836: CLI `texra chat`

Acceptance requires chat to be a host presentation layer over the existing tool-use session lifecycle. It must lazy-load its terminal renderer. OpenTUI is preferred only after a PR proves Node 20+/npm distribution and CI installation; until then it remains a gated renderer choice, not a core dependency. Chat must reject headless mode rather than hanging in pipes or CI.

### Issue #3837: ToolFileInteractionContext ownership

Acceptance requires the run-owned and call-owned facts to stay separated. `RunContext` owns execution-runtime facts: stream identity, execution identity, logger, runtime host, approval coordinators, cancellation, working directory, and host capabilities. Tool call context owns per-call tracker/todo/plan/callback state. A new accessor or context field is acceptable only if it clarifies this ownership boundary.

### Cross-host balance

Every PR must state extension, desktop, and CLI impact separately. Shared code should move only when the same invariant belongs to all hosts. Host packages should own their local effects directly. The correct endpoint is not symmetry; it is one owner per fact.

## Chat follow-up requirement

`texra chat` must support user input and follow-up turns. It is insufficient to render progress from one precomputed prompt. The TUI must let the user continue the same tool-use session, submit additional messages, handle interruption, and see approvals in context. The CLI may own the terminal input component and local commands, but it must not duplicate session state or tool-call ownership from the shared runtime.

## CLI approval policy matrix

The CLI approval adapter is the single owner of policy-to-decision mapping. It must make the same decision for the same `CliContext.approvalPolicy` regardless of which command invoked the run. The shared coordinators remain the owners of request identity and settlement lifecycle.

| Gate             | `never`                                                         | `ask`                                                        | `yolo`                                                 |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| Edit approval    | Deny with approval-denied exit path                             | Render diff and prompt in TTY; deny in headless mode         | Approve                                                |
| Bash approval    | Deny with approval-denied exit path                             | Render command and prompt in TTY; deny in headless mode      | Approve                                                |
| Plan approval    | Deny unless the command explicitly marks plan approval optional | Render plan and prompt in TTY; deny in headless mode         | Approve                                                |
| Agent proposal   | Deny delegation/proposal                                        | Render proposal and prompt in TTY; deny in headless mode     | Approve                                                |
| Retry request    | Do not retry                                                    | Render retry reason and prompt in TTY; deny in headless mode | Retry once only when the shared retry coordinator asks |
| External inquiry | Fail with an explicit non-interactive-human-input error         | Prompt for text in TTY; fail in headless mode                | Fail unless the inquiry has a safe default             |

`ask` is only meaningful in interactive mode. In headless mode it must fail closed rather than blocking on stdin. Future terminal prompts must live in the CLI adapter or chat TUI boundary, not in shared core.

## CLI exit-code contract

`packages/cli/src/runtime/exitCodes.ts` is the single source of truth for CLI process exit codes. Command handlers may choose which semantic code applies, but they must not invent numeric codes locally.

| Code | Name                  | Meaning                                                                 |
| ---- | --------------------- | ----------------------------------------------------------------------- |
| 0    | `Success`             | Command or agent run completed successfully                             |
| 1    | `AgentError`          | Agent execution reported failure                                        |
| 2    | `Usage`               | Invalid arguments, unsupported mode, or unimplemented command surface   |
| 3    | `ModelOrNetworkError` | Model/provider/network failure once distinguishable at the CLI boundary |
| 124  | `Cancelled`           | Timed cancellation, matching common `timeout(1)` convention             |
| 130  | `Interrupted`         | User interrupt, matching common shell `SIGINT` convention               |

This table belongs to the CLI host because process exit status is host presentation. Core agent execution should return typed results and errors; the CLI maps those outcomes to process codes at the boundary.

Code 4 (`ApprovalDenied`) was retired in 2026-08. A denied gate is not a run
outcome: the gate hands the denial back to the model as tool feedback, the model
routes around it, and the turn continues. Giving denial its own exit code made
every caller that reads a nonzero exit as "produced no result" discard runs that
had in fact succeeded. Denials are now reported to the operator as a single
`[warn] [cli-approval]` line on stderr and never influence the exit code.

## Current implementation status ledger

This ledger records the state after the initial orchestration pass. It is not a substitute for validation; it is a map of what exists versus what remains.

| Area                   | Current state                                                                                                                                                               | Remaining work                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logger v2              | `src/logger/structuredLogger.ts` exists with structured records, sinks, grouping, and memory sink.                                                                          | Migrate existing `logUtils` / `AgentLogger` paths, add host sinks, retire compatibility shims by phase.                                            |
| RunContext             | `src/agent/runtime/RunContext.ts` provides `withRunContext`, `useRunContext`, and `tryUseRunContext`; `executeAgent` entry paths are being wrapped.                         | Validate all entry paths, continue singleton retirement, remove fallback runtime-host chains in later phases.                                      |
| Coordinators           | `runCoordinators.ts` maps request IDs and stream IDs to per-run coordinator instances while preserving legacy fallback.                                                     | Delete singleton coordinator exports when all readers are context-aware.                                                                           |
| CLI package            | `packages/cli` exists with bin entry, root command, context resolver, platform init, runtime host, logger sinks, approval adapter, architecture guard, and exit-code table. | Add real command parser or keep direct parser intentionally, implement packaging output, implement richer `run` options, validate package scripts. |
| CLI context            | `cliContext.ts` owns argv/cwd/mode/output-format/approval-policy/version/resources-path.                                                                                    | Add config-file/env layering when specified; keep all ambient process reads here.                                                                  |
| `texra run`            | Runs through shared `executeAgent`, installs CLI approval handlers, and uses CLI runtime host.                                                                              | Validate with real workflow agent, improve result/error mapping, add final-output contract tests.                                                  |
| CLI approval policy    | Adapter exists and policy matrix is specified.                                                                                                                              | Implement interactive `ask` prompts; map approval-denied outcomes to `CliExitCode.ApprovalDenied`; ensure all gates use the same matrix.           |
| `texra chat`           | Stub rejects headless mode and records interactive follow-up requirement.                                                                                                   | Implement follow-up TUI over shared tool-use session lifecycle; decide OpenTUI only after Node/npm proof.                                          |
| Tool context ownership | `ToolRunContext` and `ToolCallContext` split exists.                                                                                                                        | Sweep remaining call sites for ownerless context bags and pass-through accessors.                                                                  |
| PR evidence            | Root PR template requires source-of-truth, duplication, abstraction, host-impact, refactoring, and validation sections.                                                     | Use it consistently on every PR in the loop.                                                                                                       |

Do not mark the orchestration complete until the remaining work in this ledger has either landed or been deliberately moved to a follow-up issue with an owner and acceptance criterion.

### Ledger update: CLI package build contract

The CLI package now has separate `typecheck`, `check:architecture`, `bundle`, and `build` scripts. `build` composes the first three and writes the manifest-declared binary at `dist/bin/texra.js`. `esbuild` is declared in `@texra/cli` dev dependencies because the package-local build invokes it directly. This closes the earlier mismatch where `bin.texra` pointed at `dist` but no package script produced that file.

### Ledger update: PR #3839 review-clean scaffold state

PR #3839 is the audited scaffold PR. Use GitHub checks and review threads as the head-specific source of truth; the durable orchestration record should not hard-code a SHA that becomes stale after documentation-only follow-up commits. The latest audited green state was posted to tracking issue #3838 and implementation issues #3833-#3837 so the next loop starts from current evidence rather than rediscovering completed scaffold work.

This does not complete the orchestration. PR #3839 is ready for review as a scaffold PR, and issues #3833-#3838 remain open. Logger v2 host sinks, real `texra run` runtime validation, interactive approval prompts, `texra chat` follow-up TUI, and final `ToolFileInteractionContext` ownership cleanup still need implementation or owned follow-up issues with acceptance criteria.

Focused follow-up #3842 owns the next narrow Logger v2 PR. Its scope is host sinks and the legacy compatibility shim: keep `LogRecord` and grouped logging in `src/logger/structuredLogger.ts`, let extension, desktop, and CLI own their rendering effects, and define the temporary `logUtils` / `AgentLogger` migration path. It must not absorb the `texra run` packaged-runtime work from #3840, the CLI approval matrix from #3841, the chat TUI from #3836, or the tool-context ownership cleanup from #3837.

## Machine-readable manifest

A compact orchestration manifest lives at `docs/prds/2026-05-10-prd-cli-runcontext-logger-orchestration.manifest.json`. It maps each issue to its PRD, source of truth, and acceptance gates. Loop agents should use the manifest as an index, not as a replacement for the PRD text.

## CLI package publish-readiness gate

`packages/cli/package.json` may remain `private: true` while the CLI is a scaffold, but publication readiness is a tracked acceptance gate for issue #3834. Before publishing, the PR must either remove `private: true` or explain why packaging remains internal. The same PR must show that the manifest `bin` entry, package build script, and generated artifact agree.

## Agent TUI design lessons from OpenRouter `create-agent-tui`

The OpenRouter `create-agent-tui` skill is useful as a reference for the shape of the terminal shell, not as an agent-loop replacement. Its central separation is the right one for TeXRA: the agent SDK owns model calls, tool execution, multi-turn looping, stop conditions, streaming, usage, and shared tool context; the TUI owns configuration, session display, input, permissions prompts, renderers, and entry points.

For TeXRA this maps as follows:

| Reference concept        | TeXRA owner                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Agent loop               | Existing shared tool-use runtime                                                    |
| Model routing            | Existing model registry and run context                                             |
| Tool execution           | Existing TeXRA tools and tool-call context                                          |
| Session persistence      | Existing tool-use session lifecycle                                                 |
| Config layering          | `CliContext` plus future config provider                                            |
| Tool permissions         | CLI approval adapter and shared coordinators                                        |
| Structured event logging | Logger v2 `LogRecord` plus host sinks                                               |
| Terminal input styles    | CLI chat renderer only                                                              |
| Tool display styles      | CLI chat renderer only                                                              |
| Slash commands           | CLI chat command registry only when the command affects host policy or presentation |

The chat implementation should borrow the following product requirements:

- Multiple input styles are useful, including a plain readline-compatible fallback for conservative terminals.
- Tool display should support grouped, minimal, and hidden modes, because TeXRA users may alternate between research, debugging, and low-noise writing sessions.
- `@file` references and `!command` shortcuts are good future chat features, but they must feed the existing tool-use context rather than creating a second file or shell subsystem.
- Session persistence should be append-only or event-based so interrupted terminal sessions can resume cleanly.
- Cost, usage, active model, active agent, and session identity should be visible without becoming part of core execution semantics.

Do not copy the OpenRouter harness structure into TeXRA. TeXRA already has the inner loop, tool registry, approvals, logger, and session lifecycle. The useful lesson is the outer-shell contract: a real chat TUI needs input, follow-up turns, streaming display, tool display policy, session metadata, and permission prompts, all while preserving a single owner for every runtime fact.

## Recommended implementation order

The loop should proceed in dependency order, not issue-number order. This sequence minimizes churn and keeps each abstraction justified by a concrete owner.

1. Stabilize source-of-truth guards.
   Finish CLI architecture guard coverage, root script inclusion, PR template use, and manifest alignment. No feature work should bypass these guards.

2. Finish `texra run` as the first executable host path.
   Keep the parser simple unless there is a concrete need for a command framework. Validate that the CLI platform, agent directory bootstrap, approval adapter, runtime host, logger sink, and exit-code mapping all sit on the shared `executeAgent` path.

   Focused follow-up #3840 owns the next narrow validation PR for this step. It should build and execute the package-local `texra` binary, validate a real workflow-agent path through shared `executeAgent`, cover text/JSON/NDJSON result output, cover command-local global flags after the `run` subcommand, and cover empty value-bearing flag handling. It should not absorb chat, interactive approval prompts, Logger v2 host sinks, or ToolFileInteractionContext cleanup.

3. Complete approval policy before rich chat.
   Chat depends on approval prompts. Implement the matrix once in the CLI approval adapter; then let chat render or call that adapter rather than defining its own approval semantics.

   Focused follow-up #3841 owns the next narrow approval PR for this step. It should implement interactive `ask` prompts, make non-TTY/headless `ask` fail closed, validate bash/edit/plan/proposal/retry/external-inquiry behavior, and map denied or failed-closed approvals to `CliExitCode.ApprovalDenied` at the CLI boundary. It should not absorb `texra chat`, packaged `texra run` validation, Logger v2 host sinks, or ToolFileInteractionContext cleanup.

4. Continue RunContext and ToolFileInteractionContext ownership cleanup.
   Remove ambient singletons and ownerless context bags as readers move to context-owned facts. Do this before adding more interactive surfaces that would otherwise depend on legacy fallback state.

5. Migrate Logger v2 host sinks.
   Preserve `LogRecord` as the shared schema and keep host rendering in sinks. This gives CLI run and chat a common event stream without copying progress-view logic.

6. Implement `texra chat` TUI.
   Start with the smallest follow-up loop over the existing tool-use session lifecycle. Add OpenTUI only after its Node/npm distribution proof. Keep terminal renderer code lazy-loaded and host-local.

7. Publish-readiness and release gates.
   Remove or justify `private: true`, verify package binary output, document install behavior, and add release notes only after the executable host paths are validated.

Do not invert steps 2 and 6. A chat TUI built before `texra run`, approval policy, logger records, and run context ownership are stable will tend to copy semantics into the CLI host.

## Local TUI styling reference

The OpenRouter skills repository has been cloned locally at `references/openrouter-skills`; the relevant reference is `references/openrouter-skills/skills/create-agent-tui/`. Use it for `texra chat` styling and interaction ideas only. It is not a source of runtime code for TeXRA.

### Ledger update: manifest consistency check

A root script `check:cli-orchestration-manifest` runs `scripts/check-cli-orchestration-manifest.mjs`. This check verifies that the manifest points to tracking issue #3838, covers issues #3833-#3837, names existing PRDs, includes source-of-truth and acceptance gates for every issue, keeps `status: in_progress`, keeps `validationStatus: not_validated`, and records the one-owner invariant plus recommended implementation order. It is a consistency guard for the handoff artifact, not implementation validation.

### Ledger update: PR acceptance-gate evidence

The root PR template now includes an `Issue acceptance gates` section. Every PR in this loop should list the issue numbers it addresses and the exact acceptance gates satisfied from `2026-05-10-prd-cli-runcontext-logger-orchestration.manifest.json`. If a gate remains incomplete, the PR must say so rather than implying completion through a broad summary.

### Ledger update: reference-only enforcement

The manifest consistency check now verifies that `references/openrouter-skills/skills/create-agent-tui/` is recorded as a styling and interaction reference only, with copying of its generated harness or runtime architecture explicitly forbidden. The local clone is useful for design comparison, not for product imports or vendored runtime code.
