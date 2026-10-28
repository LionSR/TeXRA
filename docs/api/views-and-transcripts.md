# Views, Transcripts & Renderers

[`@texra-ai/harness/schemas`](./harness/schemas) and [`@texra-ai/harness/transcript`](./harness/transcript) are browser-safe subpaths (zero Node.js built-ins or vendor SDK imports) that project committed session rows and live stream chunks into read-only [`SessionView`](./harness/schemas#sessionview) snapshots and [`TranscriptRow`](./harness/transcript#transcriptrow) items for the CLI TUI, VS Code webviews, desktop renderer, and static trace viewer.

## Observing `SessionView` and formatting `TranscriptRow`s

Every [`Run`](./harness/#run) exposes `run.view` (`Stream<SessionView>`), which subscribes to the run's transcript through completion. On a [`LocalSession`](./harness/#localsession), call `session.view.subscribe([{ id: qualifyAggregateId('run', runId), fromSeq: 0 }])` for scoped transcript materialization or `session.view.read([runId])` for a cold snapshot (see [`06-views-and-transcript.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/06-views-and-transcript.ts)):

```ts
import { Effect } from 'effect';
import {
  acceptsFollowUp,
  attentionOf,
  generateRunId,
  qualifyAggregateId,
  sessionActivity,
} from '@texra-ai/harness/schemas';
import {
  elideText,
  rowHeadline,
  type TranscriptRow,
} from '@texra-ai/harness/transcript';

function formatRow(row: TranscriptRow): string {
  const headline = rowHeadline(row) ?? row.kind;
  switch (row.kind) {
    case 'user':
    case 'assistant':
    case 'thinking': {
      const elided = elideText(row.text, { headLines: 2, tailLines: 1 });
      return `[${row.kind}] ${elided.head.join(' ')} (hidden=${elided.hiddenLines})`;
    }
    case 'tool': {
      const sections = row.model.sections.map((s) => s.kind).join(',');
      return `[tool:${row.toolUse.toolName}] status=${row.log.status} headline="${headline}" sections=[${sections}]`;
    }
    case 'error':
      return `[error] ${row.summary.oneLine}`;
    default:
      return `[${row.kind}] ${headline}`;
  }
}

// Inside an Effect program with `session`:
const runId = generateRunId();
yield *
  session.view.subscribe([
    { id: qualifyAggregateId('run', runId), fromSeq: 0 },
  ]);
const run = yield * session.start({ runId, agent: persona, instruction });
yield * run.result;
yield * session.settled;

const view = session.view.current();
const runView = view.runs.get(run.runId)!;
console.log(
  sessionActivity(view),
  attentionOf(view).requests.length,
  acceptsFollowUp(runView),
);
for (const row of runView.transcript.rows) {
  console.log(formatRow(row));
}
```

## Two reducers over one history

Committed rows feed two separate reducers:

| Reducer                  | Output                                         | Authority                                                                                                                                    | Failure policy                                                                                    |
| ------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Run state reducer**    | Internal `RunState`                            | **Execution and recovery.** Drives the agent loop's messages, offered tools, and in-flight call state.                                       | **Strict**: a malformed or incompatible row rejects the write batch or refuses resume on the run. |
| **Session view reducer** | [`SessionView`](./harness/schemas#sessionview) | **Display projection.** Populates `SessionView.runs`, `requests`, `policy`, token/cost `rollup`, and subscribed `RunView.transcript` slices. | **Tolerant**: an unreadable run is flagged `readOnly` without breaking the rest of `SessionView`. |

Runtime execution never reads `SessionView`. Every emitted `SessionView` is deeply read-only (`ReadonlyDeep`) and shares unchanged subtrees structurally across emissions.

### Pure view queries (`@texra-ai/harness/schemas`)

- **[`sessionActivity(view)`](./harness/schemas#sessionactivity)**: returns `'approval' | 'running' | 'idle'` for window titles and status indicators.
- **[`attentionOf(view, previous?)`](./harness/schemas#attentionof)**: returns answerable [`PendingRequest`](./harness/schemas#pendingrequest)s (`requests`) and newly arrived requests (`arrived`).
- **[`acceptsFollowUp(runView)`](./harness/schemas#acceptsfollowup)**: returns whether a composer should allow `followUp.send` on `runView` (true for active/waiting runs and stopped top-level interactive runs that can resume from history).
- **[`isLiveRun(runView)`](./harness/schemas#isliverun)** and **[`isWorkingRun(runView)`](./harness/schemas#isworkingrun)**: distinguish live runs from interrupted runs whose durable status was left in flight by a dead owner.
- **[`descendantRuns(view, rootRunId, { includeRoot })`](./harness/schemas#descendantruns)** and **[`rollupOf(children)`](./harness/schemas#rollupof)**: walk a parent run's child tree.

## Cross-process synchronization (`RemoteSessionView`)

In-process callers read `session.view.current()` and `session.view.changes`. Across an IPC boundary (VS Code webviews, Electron renderers), the host streams `session.view.watch(subscriptions, { cursor, debug })` (`Stream<readonly SessionViewInput[]>`) and the renderer feeds those batches into [`RemoteSessionView`](./harness/transcript#remotesessionview) via [`SessionInputs`](./harness/transcript#sessioninputs):

- **[`EventInputSchema`](./harness/transcript#eventinputschema)** and **[`CommitOrdinalSchema`](./harness/transcript#commitordinalschema)**: ordered batches of [`DisplaySessionEvent`](./harness/transcript#displaysessionevent)s in `commit` order.
- **[`TextChunkSchema`](./harness/transcript#textchunkschema)**: transient streaming deltas for active assistant, thinking, and tool rows.
- **[`LocalRuntimeStateSchema`](./harness/transcript#localruntimestateschema)** and **[`ExistenceReconciliationSchema`](./harness/transcript#existencereconciliationschema)**: liveness flags for runs held by the host process and pruning of deleted runs.
- **[`TranscriptSubscriptionSchema`](./harness/transcript#transcriptsubscriptionschema)**: the `{ id, fromSeq }` set controlling which runs have their `TranscriptView` materialized.

## `TranscriptRow` variants and `ToolRowModel`

A subscribed [`TranscriptView`](./harness/schemas#transcriptview) (`RunView.transcript`) holds `rows` (`readonly TranscriptRow[]`), `taskGroups` (`readonly TaskGroup[]`), and `settledRows` (the leading prefix of finalized rows that an append-only terminal scrollback can print permanently).

| `TranscriptRow['kind']`                       | Interface                                                                                               | Payload fields                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `'user'`                                      | [`UserRow`](./harness/transcript#userrow)                                                               | `text`, `summary` (`TranscriptText`), `attachments`, `media`, `forkAt`                                 |
| `'assistant'` · `'thinking'` · `'scratchpad'` | [`StreamingTextRow`](./harness/transcript#streamingtextrow)                                             | `text` (`TranscriptText`), `streaming` (`boolean`), `pendingEmbeddedFollowup`                          |
| `'tool'`                                      | [`ToolRow`](./harness/transcript#toolrow)                                                               | `toolUse` (`NormalizedToolUse`), `model` (`ToolRowModel`), `log` (`ToolUseLog`), `phase`, `attempt`    |
| `'compactionActivity'`                        | [`CompactionActivityRow`](./harness/transcript#compactionactivityrow)                                   | Correlated context-compaction status (`running`, `completed`, `failed`, `interrupted`) and token delta |
| `'contextManagement'`                         | [`ContextManagementRow`](./harness/transcript#contextmanagementrow)                                     | `data` (`ContextManagementData`) for context edits and forks                                           |
| `'webSearch'`                                 | [`WebSearchRow`](./harness/transcript#websearchrow)                                                     | `label`, `query`                                                                                       |
| `'fileList'`                                  | [`FileListRow`](./harness/transcript#filelistrow)                                                       | `files` (`readonly FileListEntry[]`), `summary`, `media` (`readonly LoadedMediaRef[]`)                 |
| `'error'`                                     | [`ErrorRow`](./harness/transcript#errorrow)                                                             | `summary` (`TranscriptText`), `details` (`readonly ErrorRowDetail[]`), `detailText`                    |
| `'log'` · `'progressStatus'`                  | [`LogRow`](./harness/transcript#logrow) · [`ProgressStatusRow`](./harness/transcript#progressstatusrow) | Diagnostic log lines and transient progress rows                                                       |

### Structured tool sections (`ToolRowModel`)

Each [`ToolRow`](./harness/transcript#toolrow) pre-computes a [`ToolRowModel`](./harness/transcript#toolrowmodel) whose `sections` (`readonly ToolSection[]`) let renderers paint tool cards without per-tool JSON parsing:

- **[`ToolStatusSection`](./harness/transcript#toolstatussection)** and **[`ToolBadgesSection`](./harness/transcript#toolbadgessection)**: status and metadata badges.
- **[`ToolDiffSection`](./harness/transcript#tooldiffsection)**: unified diffs and line counts for file edits ([`formatHunkLines`](./harness/schemas#formathunklines)).
- **[`ToolCodeSection`](./harness/transcript#toolcodesection)** and **[`ToolTextSection`](./harness/transcript#tooltextsection)**: syntax-tagged code (`script` bodies, shell commands) and stdout/stderr text.
- **[`ToolFileSection`](./harness/transcript#toolfilesection)**, **[`ToolFileListSection`](./harness/transcript#toolfilelistsection)**, and **[`ToolFileGroupsSection`](./harness/transcript#toolfilegroupssection)**: workspace and run-storage file links.

### Static trace export (`TraceDocument`)

`session.records(runId).readTrace()` exports a run into a self-contained [`TraceDocument`](./harness/schemas#tracedocument) (validated by [`TraceDocumentSchema`](./harness/schemas#tracedocumentschema) and inspected with [`readTraceFacts`](./harness/schemas#readtracefacts) in `@texra-ai/harness/schemas`) for offline viewing in `packages/trace-viewer`.
