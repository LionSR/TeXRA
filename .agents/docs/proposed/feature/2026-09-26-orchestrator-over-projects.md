---
created: 2026-09-26
status: proposed
---

# One orchestrator over all projects

Baseline: `main` at `a65f817`.

## What it is

- **One agent,** `orchestrator`, whose workspace is its own folder, `~/.texra/orchestrator/`. It works with the researcher on strategy, sees every project, and dispatches agents into them.
- **Its session is an ordinary session over that folder.** Memory, file tools, path guards, approvals and resume all work as they do today, with no special session kind.
- **Two new tools,** `projects` and `schedule`. Everything else it uses already exists.
- **Harness-side, it does nothing unprompted.** Every wake-up, dispatch and message is a tool call the agent chose to make.

## Its folder

`~/.texra/orchestrator/` is its working directory. The agent decides how to organize it, for example `STRATEGY.md` or one note per project. The researcher can open and edit it like any project.

- **Memory:** the existing `memory` tool writes under this folder's workspace storage (`src/tools/memory/memoryFileSystem.ts`), so the orchestrator has its own memory automatically.
- **Confinement:** file tools are limited to this folder by `resolveToolPath` (`src/tools/pathResolution.ts`) while `restrictPathsToWorkingDirectory` is on (the default).
- **Other projects:** reached only through `projects`, never through file paths.
- **Isolation from projects:** project agents never see this folder. It is outside every project root, and no project prompt mentions it.

## Tools

The rewritten `packages/extension/resources/tool_use_agents/orchestrator.yaml` keeps these tools from today's `orchestrator.yaml`:
- `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`.
- `todo_write`, `plan`, `inquiry`, `executions`.
- `delegate_agent`, `delegate_workflow`, `delegate_multi_agents`.
- `github_subscription`.

It adds `memory`, `ask_user_question`, and the two new tools:

**`projects`** (new, `src/tools/projects/`), with a single `command` field like `memory`:

| Command | Does | Built on |
| --- | --- | --- |
| `list` | Registered projects with live runs, pending requests, spend | Desktop `DesktopProjectRegistry` (`packages/desktop/src/main/desktopProjects.ts`) and its global-DB records (`desktopProjectRecords.ts`); each project's session view |
| `read <p> <path>` | Read-only file, memory or run report from a project | `Sessions.open(roots)` (`packages/agent/src/effect/sessions.ts`), that session's storage |
| `dispatch <p> <agent> <task> [model]` | Start any agent in project `p`; the run is recorded, approved and resumable **in `p`'s session** | `Session.start(...)`; approval through the proposal-or-bypass flow (`src/tools/delegation/proposalFlow.ts:213`) that `delegate_agent` uses |
| `steer <run> <text>` / `stop <run>` | Queue a message into a dispatched run, or interrupt it | `submitFollowUp` (`src/agent/followUp/ToolUseFollowUp.ts`) / `Run.interrupt` |
| `watch <p\|run>` / `unwatch` | Changes in that project or run arrive as follow-ups | `RunSubscriptionRegistry` → `submitFollowUp`, as `github_subscription` does (`src/tools/github/RunSubscriptionRegistry.ts`) |
| `create <path> [from]` / `open <path>` | New or existing folder registered as a project | Registry `open(root)` |

**`schedule`** (new, `src/tools/schedule/`), with commands `at <time> <note>`, `in <duration> <note>`, `list` and `cancel <id>`. It is a timer source on the same `RunSubscriptionRegistry` → `submitFollowUp` path. When it fires, the note arrives as a follow-up. Like GitHub subscriptions, a schedule lives as long as its run and process.

**Autonomy** uses the run's existing proposal-bypass policy. With bypass off, every `dispatch` is a proposal the researcher approves, rejects or edits. With it on, `dispatch` launches immediately. `create` and `bash` always ask.

## Changes

1. **Registry port.** Add a `ProjectRegistry` port, served by the process runtime, that exposes `list`, `open` and `sessionFor(root)`.
   - Desktop serves it from `DesktopProjectRegistry`.
   - The CLI serves it from the same global-DB records, which today only desktop writes (`src/shared/session/database.ts`, `GlobalDatabase`).
2. **`projects` tool.** Register it in `src/tools/registry.ts` and `src/tools/pluginManifest.ts`.
3. **`schedule` tool.** Register it the same way.
4. **`orchestrator.yaml`.** Rewrite the system prompt to describe the job and the limits only: the researcher's strategy partner across projects, reaching projects through `projects`, working inside its own folder. It carries no routines.
5. **Entry points.**
   - Desktop: the orchestrator folder pinned first in the project rail.
   - CLI: `texra orchestrator`, which is `--cwd ~/.texra/orchestrator` with the agent preselected.
   - VS Code: opening the folder works as-is.
6. **Retire `setup` and `apply_team` into the orchestrator** (`packages/extension/resources/tool_use_agents/setup.yaml`, `src/tools/setup/ApplyTeamTool.ts`).

Done when:
- A run dispatched from the orchestrator appears, is approved and resumes in its own project.
- A `watch` or `schedule` wake-up arrives in the orchestrator as a follow-up.
- No project run can read `~/.texra/orchestrator/`.

## Later, separate proposals

- One `theorist` agent per project, replacing `prover`, `research`, `numerics`, `review`, `search` and `leanOrchestrator`.
- Follow-ups taken between tool calls, not only at the turn boundary (`src/agent/runtime/loop/toolUse.ts`).
- A `verify` tool: Lean `sorry`/axiom audit, CAS checks at random points, and novelty search with Semantic Scholar and OpenAlex.
- A `tournament` workflow script for `delegate_multi_agents`.
- A cost-reporting benchmark.

## Open questions

1. Should `schedule` survive a process restart? If so, persist pending schedules the way `inquiry` persists threads in the global DB.
2. Should `projects read` be limited to registered projects (proposed), or allow any folder under home?
