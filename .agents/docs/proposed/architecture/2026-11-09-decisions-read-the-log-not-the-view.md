# Decisions read the log, not the session view

Status: proposed, 2026-11-09. Read at main `db09959`. Not a catalogue row:
none of the seven rounds or the lens audits searched for it, and the three
fixes that touched it landed with no row.

## The problem

A session holds two projections of a run's facts.

- **The store's**, written in the transaction that commits the rows:
  `SessionLog.facts(runId)` (the `run_record` projection, a `RunRows`:
  parent, position, end, stop, config, grants), `aggregateState`, and
  `view.read(runIds)`, the view rebuilt from the log as of the call.
- **The in-memory `SessionView`**, which an update fiber applies after the
  commit (`packages/harness/src/controllers/session/sessionViewService.ts`).
  `view.run(runId)` reads it. It trails the log inside one process, and a
  service window's own feed can be ahead of the service's view.

The view is right for rendering. Ten production sites decide with it, and
each reads an absent run as a default:

| Site                                                        | Reads                | A run the view does not hold yet                         |
| ----------------------------------------------------------- | -------------------- | -------------------------------------------------------- |
| `controllers/session/SessionRequests.ts` `requireRunAction` | `actions`            | the gate is skipped; a stale `actions` refuses or passes |
| `agent/runtime/runRegistry.ts` `attachedParent`             | `parentId`           | has no parent, so a stop's cascade does not reach it     |
| `agent/runtime/forkRun.ts` `runNoun`                        | `parentId`           | is called a task                                         |
| `agent/runtime/loop/hooks.ts` `inputBase`                   | `ancestors`          | the parent is reported as the session's root             |
| `agent/runtime/HostInteractions.ts` `presentTerminalResult` | `parentId`           | a child's failure is presented as a root's               |
| `agent/followUp/ToolUseFollowUp.ts` `wakeRun`               | presence             | the wake is dropped without a log line                   |
| `agent/followUp/ToolUseFollowUp.ts` `sendFollowUp`          | `takesFollowUps`     | the check is skipped                                     |
| `agent/storage/runOwnership.ts` (a task's cost at its end)  | `childIds`           | the children's usage is left out of the total            |
| `agent/storage/childRunOutput.ts`                           | `parentId`           | "not a direct child", for a child that is one            |
| `tools/executions/processOutput.ts` `showOutput`            | presence, `identity` | "Run not found", for a run just launched                 |

(Paths under `packages/harness/src/`.) Whether each can be reached today
depends on a barrier somewhere else: `SessionLog.settled` ("every job
enqueued before it has run, the view applied it") is awaited at seven
production sites and 48 times in the suites, and `registerRun` queues an
empty batch so a child's read runs after its parent's rows. That is the red
flag: the correctness of a read in one module is a wait in another, and
nothing in the reading module says so.

## Evidence that it is a class

Three fixes in one week, each at one site, each "read it from the log":

- #14812, twice: `request.preview` and then `request.decide` looked a
  request up in the view; a service window listed the request from its feed
  before the service's view had applied it, got "no preview", and never
  staged the proposal (3 of 6 local runs of the desktop e2e).
- #14820: whether a run takes messages was read from the view on a resume
  ("which a service window's view may lag").

The suites show the same thing from the other side:
`packages/harness/test/tools/ExecutionsToolOutput.vitest.ts` must await
`SessionLog.settled` before it calls `executions`, or the tool answers "Run
not found".

## Two designs

**A. The rule: a decision reads the store; the view renders.** Each of the
ten sites reads `SessionLog.facts` (or the `RunState` it already holds)
instead of `view.run`. `parent` and `takesFollowUps` are on `RunRows` today (its `run.start`),
and `actions` is already a pure function the view updater calls
(`runActions`, `packages/harness/src/shared/session/runActions.ts`); what
is missing is its input built from a store read. `childIds` needs a store
read by parent. Then `SessionViewAccessShape.run` leaves the
harness's decision paths, the barriers that exist only for these reads go,
and an absent run is one typed answer (`null` from `facts`), not ten
defaults. Cost: an Effect read where a synchronous one stood (the sites are
all in Effect code already), and one indexed query per decision.

**B. Make the view synchronous with the commit.** The publisher applies each
batch to the view before it answers the writer. No site changes. But it
puts the transcript projection, the largest function in the harness
(`shared/session/sessionViewUpdate.ts`, 1,120 lines), on the write path of
every row, and it does nothing for a window that is ahead of the service:
#14812 would still have happened.

A is the design. It removes the dependency instead of timing it, and it is
the rule the three fixes already applied one site at a time.

## Steps

1. One read that answers a run's decision facts from the store (parent,
   kind, `takesFollowUps`, `actions` through `runActions`, children), null
   for a run the store does not hold; no behavior change.
2. The ten sites, in three groups: the request gate and follow-ups; the
   parent and ancestry reads; the two tool reads and the cost total.
3. Delete the `settled` awaits that only served those reads (measure each:
   the terminal-result presenter and `Run.result` need theirs), and narrow
   `SessionViewAccessShape` so `run` is not offered to decision code.

## Progress

Done, the first group: `requireRunAction` reads the run from `view.read`
(the view rebuilt from the log as of the call, which `pendingOf` already
used), and `submitFollowUp` and `wakeRun` read `SessionLog.facts`. The
follow-up path no longer requires `SessionViewAccess`. No new read was
needed, so step 1 is not: `view.read` and `facts` cover these three.

Still open: the other seven sites (the parent and ancestry reads, the two
tool reads, the cost total), and step 3.

## Smaller items found on the same pass

- **`Session.records` is written four times.** Each of its eleven reads is a
  member of `RunRecords` (`packages/harness/src/effect/sessionReads.ts`), an
  `Rpc.make` in `packages/texra/src/controllers/server/protocol.ts`, a
  handler in `service.ts` and a client line in `serviceSession.ts`. The
  compiler holds the four together, so this is change amplification, not an
  unknown unknown. `readRejection` has no caller in the repository (the SDK
  README names it); `readRunEnd` has none outside the harness and its
  examples.
- **Fix churn, last 30 days** (`npm run report:fix-churn`): stop/resume/
  ownership 25, model/retry/route 22, desktop/windows 13, all over the
  threshold of ten. Since 2026-11-03 they are 4, 9 and 5: the rulings of
  `2026-11-03-one-fact-one-representation.md` are holding, and no area needs
  re-asking on these numbers.
