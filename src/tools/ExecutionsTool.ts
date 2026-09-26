/**
 * Tool for viewing and managing run history, generated files, and
 * running processes. Supports viewing past runs, waiting for status
 * changes, reading output from background processes, and killing live
 * runs.
 *
 * Every fact about a run — what it is, what it is called, how far it got,
 * whose child it is, what it still has to do — is read off the session fold
 * (`SessionView`). The fold is the one reading of the durable rows, so this
 * surface never resolves liveness, parentage or a task list a second time.
 */

// Node imports
// Third-party imports
import {
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Stream,
  SubscriptionRef,
} from 'effect';

// Local imports
import {
  getRunRecords,
  listRunWorkspaceFiles,
  unwrapResultMeta,
  resolveRunWorkspaceFilePath,
} from '@agent/storage';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { ToolCall } from '@agent/runtime/ToolCall';
import { Runs } from '@agent/runtime/runRegistry';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import { StorageFs } from '@platform/rootedFs';
import {
  AgentCategory,
  RunIdSchema,
  ToolError,
  type RunId,
  type ToolResult,
} from '@shared/schemas';
import { BASH_BACKGROUND_LOG_CAP_CHARS } from '@shared/toolUse';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import type { SessionView } from '@shared/session/sessionView';
import { assertNoParentTraversal } from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import { requireToolRun } from '@tools/core/toolRun';
import {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation,
} from '@transcript';
import { assertNever, unique } from '@utils/core';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { findExistingRunStoragePathUnder } from '@utils/files/runStorageFs';
import { getPathSegments } from '@utils/core/pathCore';
import { formatBytes, splitContentLines } from '@utils/text/stringUtils';

// Local file imports
import {
  buildSummaryLines,
  buildSummaryTailLines,
  childRunViews,
  formatChildLine,
  formatListingLine,
  formatRunStatus,
  formatTodoHeader,
  formatTodoSection,
  runDisplayCategory,
  runTodos,
} from './executionFormatters';
import { defineTool } from './core/define';
import {
  formatFileView,
  paginateToolListing,
  formatPaginationHint,
} from './formatting';
import { serializeFilteredConfig } from './executions/configView';
import { formatConversation } from './executions/conversationFormat';
import { orchestratorKillDenial } from './executions/killPolicy';
import { EXECUTION_PATH_LIST } from './executions/pathCatalog';
import {
  OUTPUT_MAX_LINES,
  OUTPUT_TAIL_LINES,
  projectProcessOutput,
} from './executions/processOutput';
import { listRunGeneratedFiles } from './executions/runGeneratedFiles';
import {
  ExecutionsToolInputSchema,
  type ExecutionsToolInput,
} from './executions/toolInput';
import { turnAttributionNote } from './executions/turnAttribution';
import { shouldSkipWait } from './executions/waitCoordination';
import { workflowBoardView } from './executions/workflowSummaryView';

interface RunToolContext {
  readonly session: SessionHandle;
  readonly runId: RunId | undefined;
}

/**
 * Block until one of `runIds` changes status, the caller's run
 * receives a follow-up (the user breaking the wait), or `timeoutSeconds`
 * elapse — whichever comes first. A status change is read off the session's
 * view stream against the phases the wait started from, so a change landing
 * before the stream's first emission still wakes it; `settled` is re-checked
 * once the listeners are up, closing the window after the caller's
 * pre-check. The view stream ends with the session, which ends the wait
 * too. The race settles on the first completion, success or failure, so a
 * dead fold surfaces at once instead of stalling until the deadline.
 * Interrupting the winner-less racers closes the view subscription and
 * disposes the follow-up listener.
 */
const awaitStatusChange = Effect.fn('ExecutionsTool.awaitStatusChange')(
  function* (
    context: RunToolContext,
    timeoutSeconds: number,
    runIds: readonly RunId[],
    settled: () => boolean,
  ) {
    const phases = (view: SessionView): string =>
      runIds.map((id) => view.runs.get(id)?.status ?? '').join(',');
    const started = phases(SubscriptionRef.getUnsafe(context.session.view));
    const followUp = yield* Deferred.make<void>();
    // The session's follow-up queue is the one in-process channel a sent
    // follow-up fires (`notifyFollowUpSent`); no plane row carries it.
    const { runId } = context;
    if (runId) {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          context.session.followUps.onSent((sentRunId) => {
            if (sentRunId === runId) Deferred.doneUnsafe(followUp, Effect.void);
          }),
        ),
        (stop) => Effect.sync(stop),
      );
    }
    const statusChange = context.session.viewChanges.pipe(
      Stream.filter((view) => phases(view) !== started),
      Stream.runHead,
    );
    const alreadySettled = Effect.suspend(() =>
      settled() ? Effect.void : Effect.never,
    );
    yield* Effect.raceAllFirst([
      statusChange,
      alreadySettled,
      Deferred.await(followUp),
    ]).pipe(Effect.timeoutOption(Duration.seconds(timeoutSeconds)));
  },
  Effect.scoped,
);

interface SizedEntry {
  readonly path: string;
  readonly size: number;
  readonly isDirectory: boolean;
}

/**
 * Format entries as right-aligned "<size>  <path>" lines (`<dir>` for
 * directories). `/files` and `/workspace-files` render the same shape, and
 * both source listings already carry these fields, so each passes its entries
 * straight through.
 */
function formatSizedEntryLines(entries: readonly SizedEntry[]): string[] {
  return entries.map((entry) => {
    const sizeStr = entry.isDirectory ? '<dir>' : formatBytes(entry.size);
    return `${sizeStr.padStart(8)}  ${entry.path}`;
  });
}

/**
 * Every line of logic below is one Effect program. A storage or filesystem
 * read failure dies at its read site (`Effect.orDie`): nothing here recovers
 * from one, and the tool runner surfaces the collaborator's own error.
 */
const executeExecutionsTool = Effect.fn('ExecutionsTool.call')(function* (
  input: ExecutionsToolInput,
) {
  const run = yield* requireToolRun('executions', yield* ToolCall);
  const context: RunToolContext = {
    session: run.session,
    runId: run.runId,
  };
  return yield* runExecutions(context, input);
});

const runExecutions = Effect.fn('ExecutionsTool.run')(function* (
  context: RunToolContext,
  input: ExecutionsToolInput,
): Effect.fn.Return<
  ToolResult,
  Error,
  Runs | FileSystem.FileSystem | StorageFs
> {
  const segments = getPathSegments(input.path);
  const [namespace, id, resource, ...rest] = segments;

  if (namespace !== 'executions') {
    return yield* Effect.fail(
      new ToolError(`Path must start with /executions. Got: ${input.path}`),
    );
  }

  // /executions - list all runs
  if (!id) {
    if (input.action === 'kill') {
      return yield* Effect.fail(
        new ToolError(
          `action='${input.action}' requires a specific run: use /executions/{id}.`,
        ),
      );
    }
    if (input.action === 'wait') {
      yield* waitForRuns(context, input.timeout, input.ids);
    }
    return yield* listRuns(context, input.offset, input.limit);
  }

  const runId = yield* resolveRunId(context, id);

  // /executions/{id} - run summary or actions
  if (!resource) {
    switch (input.action) {
      case 'kill':
        return yield* handleKill(context, runId);
      case 'wait':
        yield* waitForRuns(context, input.timeout, [runId]);
        return yield* showSummary(context, runId, {
          suppressAutoDeliveredSubagentReport:
            !(yield* context.session.followUps.withdraw(context.runId, runId)),
        });
      case 'view':
        return yield* showSummary(context, runId, {
          suppressAutoDeliveredSubagentReport: false,
        });
      default:
        return assertNever(input, 'Unrecognized executions action');
    }
  }

  // Sub-resource paths (config, conversation, files, ...) only support
  // reading — wait/kill operate on /executions or /executions/{id}, never a
  // deeper resource.
  if (input.action !== 'view') {
    return yield* Effect.fail(
      new ToolError(
        `action='${input.action}' is only valid on /executions or /executions/{id}; use action='view' to read /executions/${id}/${resource}.`,
      ),
    );
  }

  const viewRange = input.view_range ?? undefined;

  switch (resource) {
    case 'config':
      return yield* showConfig(context, runId);
    case 'conversation': {
      if (viewRange) {
        return yield* Effect.fail(
          new ToolError(
            'Conversation pagination is message-based. Use offset and limit; view_range applies only to file and background-command output.',
          ),
        );
      }
      return yield* showConversation(context, runId, input.offset, input.limit);
    }
    case 'todos':
      return yield* showTodos(context, runId);
    case 'report':
      return yield* showReport(context, runId);
    case 'result':
      return yield* showResultMeta(context, runId);
    case 'children':
      return yield* showChildren(context, runId);
    case 'output':
      return yield* showOutput(context, runId, viewRange);
    case 'files':
      if (rest.length === 0) {
        return yield* listFiles(context, runId);
      }
      return yield* readFile(context, runId, rest.join('/'), viewRange);
    case 'workspace-files':
      if (rest.length === 0) {
        return yield* listWorkspaceFiles(context, runId);
      }
      return yield* readWorkspaceFile(
        context,
        runId,
        rest.join('/'),
        viewRange,
      );
  }

  return yield* Effect.fail(
    new ToolError(
      `Unknown path: ${input.path}.\nValid paths:\n${EXECUTION_PATH_LIST}`,
    ),
  );
});

function resolveRunId(
  context: RunToolContext,
  id: string,
): Effect.Effect<RunId, ToolError> {
  if (id === 'current') {
    const runId = context.runId;
    if (!runId) {
      return Effect.fail(
        new ToolError(
          'No active run. Use a specific run ID instead of "current".',
        ),
      );
    }
    return Effect.succeed(runId);
  }
  const result = RunIdSchema.safeParse(id);
  if (!result.success) {
    return Effect.fail(
      new ToolError(`Invalid run ID format: ${id}. Expected hex string.`),
    );
  }
  return Effect.succeed(result.data);
}

/** Wait for runs to change status, with timeout. */
const waitForRuns = Effect.fn('ExecutionsTool.waitForRuns')(function* (
  context: RunToolContext,
  timeout: number,
  ids?: readonly RunId[] | null,
) {
  const runs = yield* Runs;
  const candidateIds = ids?.length ? unique(ids) : runs.activeIds();
  // Exclude runs that are already effectively done
  // (completed, inactive, or tool-use subagent WAITING with result delivered).
  const pendingIds = candidateIds.filter(
    (id) => !shouldSkipWait(context.session, id),
  );
  if (pendingIds.length === 0) return;

  yield* awaitStatusChange(context, timeout, pendingIds, () =>
    pendingIds.every((id) => shouldSkipWait(context.session, id)),
  );
});

const listRuns = Effect.fn('ExecutionsTool.listRuns')(function* (
  context: RunToolContext,
  offset: number,
  limit: number,
) {
  // One cold fold of the log's listing tier: every run's identity, model,
  // description, parentage and status, already decided. Nothing per row.
  const view = yield* context.session.readView([]);
  const entries = [...view.runs.values()].toSorted(
    (left, right) =>
      right.launchedAt - left.launchedAt || right.createdAt - left.createdAt,
  );

  if (entries.length === 0) {
    return executed('No run history found.');
  }

  const { page, start, end, total } = paginateToolListing(
    entries,
    offset,
    limit,
  );

  return executed(
    `Executions (showing ${start}–${end} of ${total}, most recent first):\n\n${page.map(formatListingLine).join('\n')}${formatPaginationHint(end, total)}`,
  );
});

/**
 * One line set for a live run and a finished one alike: the fold answers
 * for both, so there is no second summary shape to keep in step.
 *
 * The view is folded cold rather than read off the live projection, which
 * deliberately keeps only a bounded transcript for inactive runs: a
 * workflow's board would otherwise lose its terminal cards and its
 * board-level opened state. That board is why this is the one read on the
 * surface that names its run's aggregate; every other path here takes the
 * listing tier alone.
 */
const showSummary = Effect.fn('ExecutionsTool.showSummary')(function* (
  context: RunToolContext,
  runId: RunId,
  options: {
    readonly suppressAutoDeliveredSubagentReport?: boolean;
  } = {},
) {
  const session = context.session;
  const view = yield* session.readView([runId]);
  const run = view.runs.get(runId);

  // Every open run is in the view: its `run.start` is seq 1 of its aggregate
  // (the database refuses anything else there), so no checkpoint exists
  // without the row that lists the run, and a closed run reads no snapshot.
  if (!run) {
    return yield* Effect.fail(new ToolError(`Run not found: ${runId}`));
  }

  // The report is a private record row, never part of the display fold.
  const report = yield* getRunRecords(session, runId).readReport();
  const lines = buildSummaryLines(run);

  // Non-null exactly for a workflow-script run: the fold derives the
  // board every host paints, and this bounds it for a model's context.
  if (run.transcript.run !== null) {
    lines.push(
      '',
      'Workflow:',
      JSON.stringify(workflowBoardView(run.transcript.run), null, 2),
    );
  }

  const children = childRunViews(view, runId);
  if (children.length > 0) {
    lines.push('', `Children (${children.length}):`);
    lines.push(...children.map((child) => `  ${formatChildLine(child)}`));
  }

  // A report the caller already received as a follow-up is elided; a wait
  // withdraws one still queued and shows it here. Only a live handle proves
  // the child-run loop delivered it (a background bash run included).
  const suppressReport =
    options.suppressAutoDeliveredSubagentReport === true &&
    run.category === AgentCategory.ToolUse &&
    context.runId !== undefined &&
    run.parentId === context.runId &&
    (yield* Runs).getHandle(runId) !== undefined;

  lines.push(
    ...buildSummaryTailLines(
      runId,
      runDisplayCategory(run),
      children.length > 0,
      runTodos(run),
      report,
      { suppressReport },
    ),
  );

  return executed(lines.join('\n'));
});

const handleKill = Effect.fn('ExecutionsTool.handleKill')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  const callerRunId = context.runId;

  if (context.runId === runId) {
    return yield* Effect.fail(
      new ToolError(`Cannot kill your own run (${runId}).`),
    );
  }

  const runs = yield* Runs;
  const target = runs.getHandle(runId);
  if (!target) {
    return yield* Effect.fail(
      new ToolError(`Run ${runId} not found or already completed.`),
    );
  }

  // Scope: can only kill your own children. Deny if no context.
  if (!target.isOwnedBy(callerRunId)) {
    return yield* Effect.fail(
      new ToolError(`Cannot kill run ${runId}: not a child of this session.`),
    );
  }

  // The permission gate: off, or a stored value that fails its schema,
  // denies (the guard above has already narrowed `target` to an owned
  // RunHandle).
  const killDenial = yield* orchestratorKillDenial(context.session.roots);
  if (killDenial !== undefined) {
    return yield* Effect.fail(new ToolError(killDenial));
  }

  const detachActiveChildren = yield* detachSubagentsOnStop(
    context.session.roots,
  );
  const success = yield* Effect.suspend(() => {
    const stop = runs.stop(runId, {
      detachActiveChildren,
    });
    // Asked after the settlement: a detaching stop interrupts the run
    // only once its children have left it, so that is when it knows
    // whether a live target took the stop.
    return stop.settlement.pipe(
      Effect.andThen(Effect.sync(() => stop.accepted())),
    );
  }).pipe(Effect.uninterruptible);
  if (success) {
    return executed(`Run ${runId} terminated.`);
  }
  return yield* Effect.fail(
    new ToolError(`Run ${runId} could not be terminated.`),
  );
});

/**
 * The same fold `/executions/{id}` reads its task lines from, so this
 * endpoint can never disagree with the summary about which tasks are
 * still pending.
 */
const showTodos = Effect.fn('ExecutionsTool.showTodos')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  // A task list is a listing fact (`run.fact` keyed `todos`), so this names
  // no aggregate: reading a task list never folds a transcript.
  const run = (yield* context.session.readView([])).runs.get(runId);
  const todos = run === undefined ? [] : runTodos(run);

  if (todos.length === 0) {
    return executed(`No task list found for run ${runId}.`);
  }

  return executed(
    `${formatTodoHeader(runId, todos)}\n\n${formatTodoSection(todos).join('\n')}`,
  );
});

const showReport = Effect.fn('ExecutionsTool.showReport')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  const records = getRunRecords(context.session, runId);
  const [report, note] = yield* Effect.all(
    [records.readReport(), turnAttributionNote(runId, context.session)],
    { concurrency: 2 },
  );
  if (!report) {
    return executed(
      `No report found for run ${runId}. Reports are persisted when subagents or background processes complete.`,
    );
  }
  return executed(note ? `${note}\n\n${report}` : report);
});

/**
 * Machine-readable final result for chaining a completed run into a
 * later stage without parsing the prose report.
 */
const showResultMeta = Effect.fn('ExecutionsTool.showResultMeta')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  const records = getRunRecords(context.session, runId);
  const [resultMeta, runEnd, note] = yield* Effect.all(
    [
      records.readResultMeta(),
      records.readRunEnd(),
      turnAttributionNote(runId, context.session),
    ],
    { concurrency: 3 },
  );
  if (!resultMeta) {
    return executed(
      `No structured result recorded for ${runId} yet. It is written when the run completes.`,
    );
  }
  const result = unwrapResultMeta(resultMeta, runEnd);
  // The note rides INSIDE the JSON: /result is the machine-readable
  // chaining endpoint, so prefixed prose would break JSON.parse
  // consumers precisely in the interrupted-turn case it describes.
  const payload = note ? { turnAttribution: note, ...result } : result;
  return executed(JSON.stringify(payload, null, 2));
});

const showChildren = Effect.fn('ExecutionsTool.showChildren')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  // Parentage and a child's line are listing facts, so this names no
  // aggregate: no transcript is folded to list children.
  const view = yield* context.session.readView([]);
  const children = childRunViews(view, runId);
  if (children.length === 0) {
    return executed(`No child runs found for ${runId}.`);
  }

  return executed(
    `Children of ${runId} (${children.length}):\n\n${children.map(formatChildLine).join('\n')}`,
  );
});

const showConfig = Effect.fn('ExecutionsTool.showConfig')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  const records = getRunRecords(context.session, runId);
  const record = yield* records.readRunRecord();

  if (!record) {
    return yield* Effect.fail(
      new ToolError(`Config not found for run: ${runId}.`),
    );
  }

  // Filter out fields irrelevant to this run's display category, which
  // the fold decides from the stamped identity. Read from the fold's
  // listing tier rather than the live view, so a run no port holds is
  // filtered by the same rule as one that is.
  const run = (yield* context.session.readView([])).runs.get(runId);
  return executed(
    serializeFilteredConfig(
      record,
      run === undefined ? undefined : runDisplayCategory(run),
    ),
  );
});

const showConversation = Effect.fn('ExecutionsTool.showConversation')(
  function* (
    context: RunToolContext,
    runId: RunId,
    offset: number,
    limit: number,
  ) {
    const records = getRunRecords(context.session, runId);
    const conversationResult = yield* readCompletedRunConversation(
      runId,
      context.session,
    ).pipe(Effect.orDie);
    const { conversation, source } = conversationResult;

    if (!conversation) {
      // A checkpoint implies the `run.start` `exists` reads: it is seq 1 of
      // the run's aggregate.
      const exists =
        (yield* records.exists()) ||
        hasCompletedRunConversationEvidence(conversationResult);
      if (!exists) {
        return yield* Effect.fail(new ToolError(`Run not found: ${runId}`));
      }
      return executed(
        formatConversation([], {
          totalMessages: 0,
          metadata: [
            'Source: none',
            'Returned message interval: [0, 0)',
            'Next offset: none',
          ],
        }),
      );
    }

    const pageStart = Math.min(offset, conversation.length);
    const page = conversation.slice(pageStart, pageStart + limit);
    const pageEnd = pageStart + page.length;
    const output = formatConversation(page, {
      offset: pageStart,
      totalMessages: conversation.length,
      metadata: [
        `Source: ${source}`,
        `Returned message interval: [${pageStart}, ${pageEnd})`,
        `Next offset: ${pageEnd < conversation.length ? pageEnd : 'none'}`,
      ],
    });

    return executed(output);
  },
);

/**
 * stdout/stderr of a background command, projected from the transcript log
 * its child run already writes (`createChildRun` in `tools/bash.ts`).
 *
 * This is the only route readable *while the command runs*: `/report` and
 * `/result` are written at completion, and the completion follow-up carries
 * only a 20-line preview, so without this the middle of a long build log is
 * unreachable even after the run ends. Restricted to process runs —
 * an agent run's rows are a model transcript, which `/conversation` already
 * renders properly.
 */
const showOutput = Effect.fn('ExecutionsTool.showOutput')(function* (
  context: RunToolContext,
  runId: RunId,
  viewRange?: [number, number],
) {
  const run = context.session.runView(runId);
  if (run === undefined) {
    return yield* Effect.fail(new ToolError(`Run not found: ${runId}`));
  }
  if (run.identity.kind !== 'process') {
    return executed(
      `/executions/${runId}/output is only available for background commands (bash with run_in_background). ` +
        `Use /executions/${runId}/conversation for an agent run's message history.`,
    );
  }

  // The row above already proved the run is in the session's view; its
  // output is read from the run's own committed rows.
  const { lines, chars } = projectProcessOutput(
    yield* context.session.readRunEvents(runId).pipe(Effect.orDie),
  );
  // The row above was read before the transcript, and a command that
  // finished during that read must not be judged against it: the view is
  // in memory, so one read of one run can afford a fresh row. Only a
  // tombstone takes a run out of the view, and then the row this call
  // already holds is the last honest reading of it.
  const current = context.session.runView(runId) ?? run;
  // The footer states the same reading as the header, and both come from
  // the fold: "no handle in this process" alone never justifies calling a
  // command finished, and a run whose owner is gone reads as interrupted
  // rather than as one that recorded how it ended.
  const lead = isTerminalOutcomePhase(current.status)
    ? 'finished:'
    : (current.statusDetail ??
      `still running: re-read for more output, or use action='wait' on /executions/${runId} to block until it finishes;`);
  const footer = `[${lead} this is the retained log; /executions/${runId}/report has the result summary]`;
  const out: string[] = [
    `Output for ${runId} (process, ${formatRunStatus(current)}): ${chars.toLocaleString()} retained transcript chars; command-output cap ${BASH_BACKGROUND_LOG_CAP_CHARS.toLocaleString()} chars, ${lines.length.toLocaleString()} lines.`,
  ];

  if (lines.length === 0) {
    out.push('', footer);
    return executed(out.join('\n'));
  }
  out.push('Lines are in arrival order; `err:` marks one written to stderr.');

  // Default to the tail, where a live build's news is; a view_range window
  // is clamped so a wide request still can't return an unbounded log.
  const first =
    viewRange?.[0] ?? Math.max(lines.length - OUTPUT_TAIL_LINES, 0) + 1;
  const requestedLast = Math.min(viewRange?.[1] ?? lines.length, lines.length);
  const last = Math.min(requestedLast, first + OUTPUT_MAX_LINES - 1);

  if (first > last) {
    out.push(
      `No lines in the requested range; the log has ${lines.length} lines.`,
      '',
      footer,
    );
    return executed(out.join('\n'));
  }

  let hint = '';
  if (last < requestedLast) {
    hint = ` (capped at ${OUTPUT_MAX_LINES} lines per read; continue from view_range: [${last + 1}, …])`;
  } else if (!viewRange && first > 1) {
    hint = ` (the last ${OUTPUT_TAIL_LINES} by default; use view_range to page earlier ones)`;
  }
  out.push(
    `Showing lines ${first}-${last} of ${lines.length}${hint}.`,
    '',
    lines.slice(first - 1, last).join('\n'),
    '',
    footer,
  );

  return executed(
    out.join('\n'),
    `Read lines ${first}-${last} of /executions/${runId}/output`,
  );
});

const listFiles = Effect.fn('ExecutionsTool.listFiles')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  const files = yield* listRunGeneratedFiles(runId, context.session).pipe(
    Effect.orDie,
  );
  if (files.length === 0) {
    return executed('No files generated for this run.');
  }

  const lines = formatSizedEntryLines(files);

  return executed(
    `Files in /executions/${runId}/files:\n\n${lines.join('\n')}`,
  );
});

const readFile = Effect.fn('ExecutionsTool.readFile')(function* (
  context: RunToolContext,
  runId: RunId,
  filePath: string,
  viewRange?: [number, number],
) {
  const displayPath = `/executions/${runId}/files/${filePath}`;
  yield* assertNoParentTraversal(filePath);
  const fullPath = yield* findExistingRunStoragePathUnder(
    context.session.roots.storage,
    runId,
    filePath,
  ).pipe(Effect.orDie);
  if (!fullPath) {
    return yield* Effect.fail(new ToolError(`File not found: ${displayPath}`));
  }

  return yield* readFileContent(yield* StorageFs, fullPath, {
    directoryErrorPath: displayPath,
    resultPath: displayPath,
    viewRange,
  });
});

const listWorkspaceFiles = Effect.fn('ExecutionsTool.listWorkspaceFiles')(
  function* (context: RunToolContext, runId: RunId) {
    const records = getRunRecords(context.session, runId);
    const [record, paths] = yield* Effect.all(
      [records.readRunRecord(), records.readWorkspaceFiles()],
      { concurrency: 2 },
    );
    const entries = yield* listRunWorkspaceFiles(record, paths).pipe(
      Effect.orDie,
    );

    if (entries.length === 0) {
      return executed(`No workspace files recorded for run ${runId}.`);
    }

    const lines = formatSizedEntryLines(entries);

    return executed(
      `Workspace files for /executions/${runId}/workspace-files:\n\n` +
        lines.join('\n'),
    );
  },
);

const readWorkspaceFile = Effect.fn('ExecutionsTool.readWorkspaceFile')(
  function* (
    context: RunToolContext,
    runId: RunId,
    filePath: string,
    viewRange?: [number, number],
  ) {
    const records = getRunRecords(context.session, runId);
    const [record, paths] = yield* Effect.all(
      [records.readRunRecord(), records.readWorkspaceFiles()],
      { concurrency: 2 },
    );
    const recordedPaths = new Set(
      paths.flatMap((candidate) => {
        const resolvedCandidate = resolveRunWorkspaceFilePath(
          record,
          candidate,
        );
        return resolvedCandidate ? [resolvedCandidate.path] : [];
      }),
    );
    /** The recorded workspace file `candidate` names, when it names one. */
    const recordedFile = (candidate: string) => {
      const candidateFile = resolveRunWorkspaceFilePath(record, candidate);
      return candidateFile && recordedPaths.has(candidateFile.path)
        ? candidateFile
        : undefined;
    };
    // The listing renders recorded paths under a `workspace/` display prefix,
    // so a read in that display form retries against the stripped path.
    const displayPrefix = 'workspace/';
    const resolved =
      recordedFile(filePath) ??
      (filePath.startsWith(displayPrefix)
        ? recordedFile(filePath.slice(displayPrefix.length))
        : undefined);
    if (!resolved) {
      return yield* Effect.fail(
        new ToolError(
          `Workspace file not found: /executions/${runId}/workspace-files/${filePath}`,
        ),
      );
    }

    return yield* readFileContent(
      yield* FileSystem.FileSystem,
      resolved.absolutePath,
      {
        directoryErrorPath: `/executions/${runId}/workspace-files/${filePath}`,
        resultPath: `/executions/${runId}/workspace-files/${resolved.path}`,
        viewRange,
      },
    );
  },
);

export const ExecutionsTool = defineTool({
  name: 'executions',
  slow: true,
  description: `View run history and manage live runs.

Paths:
${EXECUTION_PATH_LIST}

Use "current" as {id} to access the active run.
Use offset/limit to paginate the /executions listing or conversation messages (default: offset 0, limit 100).
Use view_range: [start, end] to paginate file and background-command output content.
Use action: "wait" on /executions or /executions/{id} to wait for a status change instead of polling.
Use action: "wait" with ids: ["id1", "id2", ...] on /executions to wait for any of the listed runs to change.
Use action: "kill" on /executions/{id} to terminate a live run.
Delegated subagent and workflow results are delivered automatically as follow-up messages. No wait is needed for runs you launched. Use action: "wait" only when you cannot proceed without a status change.`,
  schema: ExecutionsToolInputSchema,
  execute: executeExecutionsTool,
});

/**
 * Shared stat → directory-guard → read → format tail for `readFile` and
 * `readWorkspaceFile`, which differ only in which filesystem resolves the
 * path: the session's rooted storage view for a run-storage path, the process
 * filesystem for an already-absolute workspace path (a workspace file may sit
 * in a worktree, outside every root). `directoryErrorPath` and `resultPath`
 * can differ (a workspace-file read reports the raw requested path on error
 * but the canonical resolved path on success).
 */
const readFileContent = Effect.fn('ExecutionsTool.readFileContent')(function* (
  fs: FileSystem.FileSystem,
  fullPath: string,
  {
    directoryErrorPath,
    resultPath,
    viewRange,
  }: {
    directoryErrorPath: string;
    resultPath: string;
    viewRange: [number, number] | undefined;
  },
) {
  const stats = yield* fs.stat(fullPath).pipe(Effect.orDie);
  // A symlink to a directory counts, which is what the bitmask probe this
  // replaced answered for: the standard `stat` follows the link.
  if (stats.type === 'Directory') {
    return yield* Effect.fail(
      new ToolError(
        `Path is a directory: ${directoryErrorPath}. Use without trailing path to list.`,
      ),
    );
  }

  const content = yield* readNormalizedFile(fs, fullPath).pipe(Effect.orDie);
  return formatFileView({
    path: resultPath,
    lines: splitContentLines(content),
    viewRange,
    maxLines: Infinity,
  });
});
