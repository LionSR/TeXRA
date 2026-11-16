# Data shapes the 2026-11-15 audit verified and did not land

Date: 2026-11-15
Status: proposed
Origin: the 2026-11-15 scheduled data-structure audit, read on `main` at
`1dd278b`. The audit's PR landed nine findings (one field per fact in the
tool result, the call card, the CLI model row, the team option, the coding
plan, the status badge and the Models-tab reasoning choice; one working
record per run in the session view; one skill source struct). The findings
below were verified against their producers and readers and held back, each
for the reason given. They are in the order worth taking.

## 1. `SessionView.policy` and `SessionView.queuedFollowUps` are columns of `RunView`

`packages/harness/src/shared/session/sessionView.ts` keeps both as maps keyed
by run id beside `runs`. Each is written only for a run the view holds and
deleted with it (`removeRun`,
`packages/harness/src/shared/session/sessionViewUpdate.ts`).
`ApprovalGrantSource` (`packages/harness/src/shared/approvalBypassKind.ts`)
mirrors the split as two maps with one key, so `withUnborn`, `grantSource` and
`approvalsUnder` (`packages/harness/src/agent/runtime/runApprovalQueue.ts`)
each copy two maps in step. `policy` holds grants, not a policy.

Proposed: `RunView.grants` and `RunView.queuedFollowUps`, and
`ApprovalGrantSource<Id> = { runs: ReadonlyMap<Id, { parentId; grants }> }`.

Held back: `applyEvent` writes a run's grants before the run's own change,
because the fields derived in that change read them through the view. With the
grants on the run, the run must be stored before its derived fields are
computed, which reorders the one function every session row passes through.
That deserves its own PR with the session-view suites as the check. About 15
reader sites across the harness, the CLI and the progress view.

## 2. `RunView.turnStartedAt` is the updater's working state

Its own comment calls it the updater's input to `runStartedAt`; no host reads
it. It belongs in the per-run working record this audit added (`RunWork`).

Held back: `applyStanding` and the `run.activate` case of `applyRunEvent` are
pure functions over the run that write it. Moving it makes them write the
working record. Take it with finding 1, which reworks the same functions.

## 3. LaTeX settings status: seven `*Path` fields beside `installed`

`LatexSettingsStatusSchema`
(`packages/texra/src/shared/settingsView/settingsViewMessages.ts`) keys
`installed` by dependency and the seven paths by tool. Which tool belongs to
which dependency is `LATEX_DEPENDENCIES[dep].needs`
(`packages/texra/src/shared/constants/latexToolchain.ts`), and the LaTeX tab
restates it as a `pathKeys` column
(`packages/extension/src/settingsView/frontend/tabs/LaTeXTab.ts`).

Proposed: `dependencies: Record<LatexDependency, { installed; paths }>`, built
by mapping over `LATEX_DEPENDENCIES`.

Held back: it changes what the card shows. The compiler card would list every
supported compiler found, not pdflatex and latexmk; `perl` is in `needs` but
deliberately shown with no path; and the image card shows `gm` or else
`magick`, one path for two tools. Those three rules need a decision first.

## 4. The CLI's `SessionMeta` stores a team's id and its name

`packages/cli/src/chat/tui/state/cliState.ts`: `teamName` is always
`readCliTeamName(cliTeamId)`, written beside it by three producers and
cleared with it. Either one `team: { id, name }` field, or the id alone with
the name read where it is shown (two readers). Small; held back only for
size.

## 5. `Surface.workbench` is stored untyped and decoded on every read

`packages/texra/src/shared/session/surface.ts` types it
`Record<string, unknown>`; every writer passes a `DesktopShellState`, and
`packages/desktop/src/renderer/projectWorkbench.ts` decodes it again on each
`getState()` behind an identity cache. Decode once where the value returns
from persistence and hold the decoded state.

## 6. `ToolRow` carries three versions of one call

`log`, `toolUse` (`NormalizedToolUse`) and `model` (`ToolRowModel`) all ship on
the row (`packages/harness/src/shared/transcript/transcriptRow.ts`), and the
model encodes "output withheld" as `showOutput`, `output?` and
`outputSuppression?`. This is the reader side of item 1 of
`2026-11-14-tool-card-result-and-delivery-shapes.md` and should be decided
with it: once the card carries a typed result, `toolUse` has no reader the
model cannot serve.

## 7. Smaller, each a few lines

- `RunRows.parent` repeats `start.parent`
  (`packages/harness/src/shared/session/runRowsShape.ts`); eleven readers.
- The route-failure fields are declared in `RouteUnavailable`
  (`packages/harness/src/common/errors/agentErrors.ts`) and again in the
  `ModelFailure` route branch
  (`packages/harness/src/shared/schemas/errors.ts`), joined by a
  field-by-field copy.

## Needs the owner's decision

- `TurnResult.finishEvidence` and `refusalEvidence`
  (`packages/llm/src/turn.ts`): each belongs to one protocol, a filter enforces
  it, and nothing reads their contents. They are stored in every
  `model.message` response, so deleting them is a row version bump.
- `AgentConfig`'s `agent`, `agentSource` and `persona`
  (`packages/harness/src/shared/schemas/agentConfig.ts`) are a union written
  as optional fields plus a filter, with the name stored twice. Stored on
  `run.config`; about 75 sites.
