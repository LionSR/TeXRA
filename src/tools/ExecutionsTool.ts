/**
 * Tool for viewing and managing run history, generated files, and
 * running processes. Supports viewing past runs, waiting for status
 * changes, reading output from background processes, and killing live
 * runs.
 */

// Node imports
// Third-party imports
import { Data, Deferred, Duration, Effect } from 'effect';

// Local imports
import {
  deriveResumability,
  getRunRecords,
  readRunChildren,
  listRunWorkspaceFiles,
  unwrapResultMeta,
  type ChildRecord,
  listRuns,
  resolveRunWorkspaceFilePath,
} from '@agent/storage';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { ToolCall } from '@agent/runtime/ToolCall';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import type { FileStat } from '@platform/interfaces';
import {
  AgentCategory,
  RunIdSchema,
  ToolError,
  type RunId,
  type TodoItem,
  type ToolResult,
  type WorkflowRunSnapshot,
} from '@shared/schemas';
import { BASH_BACKGROUND_LOG_CAP_CHARS } from '@shared/toolUse';
import {
  isInFlightPhase,
  isTerminalOutcomePhase,
} from '@shared/runs/runStatus';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { assertNoParentTraversal } from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation,
  readCompletedRunTodos,
} from '@transcript';
import { assertNever, unique } from '@utils/core';
import { readPlatformSetting } from '@utils/config/platformSettings';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { StorageFS } from '@utils/files/storageFS';
import { isDirectory } from '@utils/files/fsEntryType';
import { findExistingRunStoragePath } from '@utils/files/runStorageFs';
import { getPathSegments } from '@utils/core/pathCore';
import { formatBytes, splitContentLines } from '@utils/text/stringUtils';

// Local file imports
import {
  buildCompletedSummaryLines,
  buildRunningSummaryLines,
  buildSummaryTailLines,
  formatChildLine,
  formatListingLine,
  formatStatusInfo,
  formatTodoHeader,
  formatTodoSection,
  getRunStatusInfo,
  statusInfoFromLiveness,
  runDisplayCategory,
  shouldSuppressAutoDeliveredSubagentReport,
  type RunDisplayCategory,
  type RunSummaryOptions,
} from './executionFormatters';
import { defineTool } from './core/define';
import {
  formatFileView,
  paginateToolListing,
  formatPaginationHint,
} from './formatting';
import { serializeFilteredConfig } from './executions/configView';
import { formatConversation } from './executions/conversationFormat';
import { resolveRunLiveness } from './executions/runLiveness';
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
import {
  listenForFollowUp,
  shouldSkipWait,
} from './executions/waitCoordination';
import { workflowRunView } from './executions/workflowSummaryView';

/**
 * Bound on the durable reads one listing page or one children block fans
 * out at once: every row asks for its own metadata (and, when the row
 * recorded no outcome, its run lease and a checkpoint stat), so the
 * fan-out is bounded rather than page-wide.
 */
const DURABLE_READ_CONCURRENCY = 16;

/**
 * One of the still-Promise collaborators this tool reads — run
 * storage, the transcript store, the two filesystems — rejected. Nothing
 * here recovers from it: `execute` re-raises `cause`, so the tool runner
 * surfaces the same error instance the collaborator raised.
 */
class ExecutionsReadFailed extends Data.TaggedError('ExecutionsReadFailed')<{
  readonly cause: unknown;
}> {}

interface RunToolContext {
  readonly session: SessionHandle;
  readonly runId: RunId | undefined;
  readonly inRunScope: <A>(operation: () => A) => A;
}

/** The one wrap of this tool's Promise collaborators. */
const executionsRead = <A>(
  context: RunToolContext,
  read: () => Promise<A>,
): Effect.Effect<A, ExecutionsReadFailed> =>
  Effect.tryPromise({
    try: () => context.inRunScope(read),
    catch: (cause) => new ExecutionsReadFailed({ cause }),
  });

/**
 * Block until one of `runIds` changes status, the caller's run
 * receives a follow-up (the user breaking the wait), or `timeoutSeconds`
 * elapse — whichever comes first. `settled` is re-checked once the change
 * listeners are registered, closing the window between the caller's
 * pre-check and registration. The race settles on the first completion,
 * success or defect, so a throw inside the registry wait surfaces at once
 * instead of stalling until the deadline. Interrupting the winner-less
 * racers detaches the registry wait's listeners and disposes the follow-up
 * listener.
 */
const awaitStatusChange = Effect.fn('ExecutionsTool.awaitStatusChange')(
  function* (
    context: RunToolContext,
    timeoutSeconds: number,
    runIds: readonly RunId[],
    settled: () => boolean,
  ) {
    const followUp = yield* Deferred.make<void>();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        listenForFollowUp(context.session, context.runId, () => {
          Deferred.doneUnsafe(followUp, Effect.void);
        }),
      ),
      (stop) => Effect.sync(stop),
    );
    const statusChange = context.session.runs.waitForAnyChange(runIds);
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

function getRunningTodos(
  session: SessionHandle,
  handle: RunHandle,
): readonly TodoItem[] {
  const run = session.runView(handle.runId);
  return run?.category === AgentCategory.ToolUse ? run.todos : [];
}

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

export class ExecutionsTool extends defineTool({
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
}) {
  /**
   * Every line of logic below is one Effect program. Fatal storage and
   * filesystem failures remain failures for the invocation boundary.
   */
  protected readonly execute = Effect.fn('ExecutionsTool.call')(function* (
    this: ExecutionsTool,
    input: ExecutionsToolInput,
  ) {
    const toolCall = yield* ToolCall;
    if (!toolCall.run)
      return yield* Effect.fail(
        new ToolError('This tool requires an active agent session.'),
      );
    const context: RunToolContext = {
      session: toolCall.run.session,
      runId: toolCall.run?.runId,
      inRunScope: toolCall.inScope,
    };
    return yield* this.run(context, input).pipe(
      Effect.catchTag('ExecutionsReadFailed', (error) =>
        Effect.die(error.cause),
      ),
    );
  });

  private readonly run = Effect.fn('ExecutionsTool.run')(function* (
    this: ExecutionsTool,
    context: RunToolContext,
    input: ExecutionsToolInput,
  ): Effect.fn.Return<ToolResult, Error | ExecutionsReadFailed> {
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
        yield* this.waitForAnyChange(context, input.timeout, input.ids);
      }
      return yield* this.listRuns(context, input.offset, input.limit);
    }

    const runId = yield* this.resolveRunId(context, id);

    // /executions/{id} - run summary or actions
    if (!resource) {
      switch (input.action) {
        case 'kill':
          return yield* this.handleKill(context, runId);
        case 'wait':
          yield* this.waitForAnyChange(context, input.timeout, [runId]);
          return yield* this.showSummary(context, runId, {
            suppressAutoDeliveredSubagentReport: true,
          });
        case 'view':
          return yield* this.showSummary(context, runId, {
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
        return yield* this.showConfig(context, runId);
      case 'conversation': {
        if (viewRange) {
          return yield* Effect.fail(
            new ToolError(
              'Conversation pagination is message-based. Use offset and limit; view_range applies only to file and background-command output.',
            ),
          );
        }
        return yield* this.showConversation(
          context,
          runId,
          input.offset,
          input.limit,
        );
      }
      case 'todos':
        return yield* this.showTodos(context, runId);
      case 'report':
        return yield* this.showReport(context, runId);
      case 'result':
        return yield* this.showResultMeta(context, runId);
      case 'children':
        return yield* this.showChildren(context, runId);
      case 'output':
        return yield* this.showOutput(context, runId, viewRange);
      case 'files':
        if (rest.length === 0) {
          return yield* this.listFiles(context, runId);
        }
        return yield* this.readFile(context, runId, rest.join('/'), viewRange);
      case 'workspace-files':
        if (rest.length === 0) {
          return yield* this.listWorkspaceFiles(context, runId);
        }
        return yield* this.readWorkspaceFile(
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

  private resolveRunId(
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
  private readonly waitForAnyChange = Effect.fn(
    'ExecutionsTool.waitForAnyChange',
  )(function* (
    context: RunToolContext,
    timeout: number,
    ids?: readonly RunId[] | null,
  ) {
    const candidateIds = ids?.length
      ? unique(ids)
      : context.session.runs.getActiveIds();
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

  private readonly listRuns = Effect.fn('ExecutionsTool.listRuns')(function* (
    context: RunToolContext,
    offset: number,
    limit: number,
  ) {
    const entries = yield* listRuns(context.session);

    if (entries.length === 0) {
      return executed('No run history found.');
    }

    const { page, start, end, total } = paginateToolListing(
      entries,
      offset,
      limit,
    );
    // One page, not one directory — see DURABLE_READ_CONCURRENCY.
    const lines = yield* Effect.forEach(
      page,
      (entry) => formatListingLine(entry, context.session),
      { concurrency: DURABLE_READ_CONCURRENCY },
    );

    return executed(
      `Executions (showing ${start}–${end} of ${total}, most recent first):\n\n${lines.join('\n')}${formatPaginationHint(end, total)}`,
    );
  });

  private readonly showSummary = Effect.fn('ExecutionsTool.showSummary')(
    function* (
      this: ExecutionsTool,
      context: RunToolContext,
      runId: RunId,
      options: RunSummaryOptions = {},
    ) {
      // Check in-memory handle first (free) — a live run has everything we need
      const session = context.session;
      const handle = session.runs.getHandle(runId);

      if (handle) {
        // Running run: agent/status and task state are session-owned;
        // fetch only the remaining durable details from run storage.
        const records = getRunRecords(context.session, runId);
        const todos = getRunningTodos(session, handle);
        const run = session.runView(runId);
        const [workflow, children, report] = yield* Effect.all(
          [
            records.readWorkflow(),
            readRunChildren(context.session, runId),
            records.readReport(),
          ],
          { concurrency: 3 },
        );

        const info = session.runs.getStatus(handle);
        // `handle.category` is the live wire's run mode, fabricated for a
        // non-agent run (a background bash reports toolUse). The stamped
        // identity is what the completed branch displays, so the running branch
        // reads it too and the same run cannot change category as it settles;
        // an agent run has no identity-derived category and keeps its mode.
        const category =
          runDisplayCategory(run?.identity, null) ?? handle.category;
        const lines = buildRunningSummaryLines(
          runId,
          handle,
          category,
          info,
          run,
        );

        yield* this.appendSummaryTail(
          context,
          lines,
          runId,
          category,
          children,
          todos,
          report,
          {
            workflow: workflow ?? undefined,
            suppressReport: shouldSuppressAutoDeliveredSubagentReport(
              options,
              handle,
              context.runId,
            ),
          },
        );

        return executed(lines.join('\n'));
      }

      // Completed run: the view's facts beside the private records.
      const records = getRunRecords(context.session, runId);
      const run = session.runView(runId);
      const [workflow, record, children, todos, report] = yield* Effect.all(
        [
          records.readWorkflow(),
          records.readRunRecord(),
          readRunChildren(context.session, runId),
          readCompletedRunTodos(runId, session).pipe(
            Effect.mapError((cause) => new ExecutionsReadFailed({ cause })),
          ),
          records.readReport(),
        ],
        { concurrency: 5 },
      );

      if (!run && !record) {
        const resumability = yield* deriveResumability(runId, context.session);
        if (resumability.kind !== 'checkpoint') {
          return yield* Effect.fail(new ToolError(`Run not found: ${runId}`));
        }
        return executed(
          `Run: ${runId}\nStatus: resumable\n(No metadata available - use /executions/${runId}/conversation to view messages)`,
        );
      }

      // Identity comes only from the stamped run row; without a row the
      // display falls back to the config.
      const identity = run?.identity;
      const category = runDisplayCategory(identity, record);
      const info = yield* getRunStatusInfo(
        runId,
        context.session,
        run && isTerminalOutcomePhase(run.status) ? run.status : null,
      );
      const lines = buildCompletedSummaryLines(
        runId,
        record,
        identity,
        category,
        info,
        run,
      );

      yield* this.appendSummaryTail(
        context,
        lines,
        runId,
        category,
        children,
        todos,
        report,
        { workflow: workflow ?? undefined },
      );

      return executed(lines.join('\n'));
    },
  );

  /**
   * Append the shared summary tail (children, todos, report, available paths)
   * common to both the running-handle and completed-run branches.
   */
  private readonly appendSummaryTail = Effect.fn(
    'ExecutionsTool.appendSummaryTail',
  )(function* (
    this: ExecutionsTool,
    context: RunToolContext,
    lines: string[],
    runId: RunId,
    category: RunDisplayCategory | undefined,
    children: ChildRecord[],
    todos: readonly TodoItem[],
    report: string | null,
    options: {
      readonly workflow?: WorkflowRunSnapshot;
      readonly suppressReport?: boolean;
    } = {},
  ) {
    if (options.workflow) {
      lines.push(
        '',
        'Workflow:',
        JSON.stringify(workflowRunView(options.workflow), null, 2),
      );
    }
    if (children.length > 0) {
      lines.push('', `Children (${children.length}):`);
      const formatted = yield* this.formatChildren(context, children);
      lines.push(...formatted.map((line) => `  ${line}`));
    }
    lines.push(
      ...buildSummaryTailLines(
        runId,
        category,
        children.length > 0,
        todos,
        report,
        options,
      ),
    );
  });

  /**
   * Fetch metas and format each child as a summary line, bounded like the
   * listing page (DURABLE_READ_CONCURRENCY).
   */
  private readonly formatChildren = Effect.fn('ExecutionsTool.formatChildren')(
    (context: RunToolContext, children: ChildRecord[]) =>
      Effect.forEach(
        children,
        (child) =>
          formatChildLine(
            child,
            context.session.runView(child.id),
            context.session,
          ),
        { concurrency: DURABLE_READ_CONCURRENCY },
      ),
  );

  private readonly handleKill = Effect.fn('ExecutionsTool.handleKill')(
    function* (context: RunToolContext, runId: RunId) {
      const callerRunId = context.runId;

      if (context.runId === runId) {
        return yield* Effect.fail(
          new ToolError(`Cannot kill your own run (${runId}).`),
        );
      }

      const target = context.session.runs.getHandle(runId);
      if (!target) {
        return yield* Effect.fail(
          new ToolError(`Run ${runId} not found or already completed.`),
        );
      }

      // Scope: can only kill your own children. Deny if no context.
      if (!target.isOwnedBy(callerRunId)) {
        return yield* Effect.fail(
          new ToolError(
            `Cannot kill run ${runId}: not a child of this session.`,
          ),
        );
      }

      // Only block kills when the toggle is disabled (the guard above has
      // already narrowed `target` to an owned RunHandle).
      if (
        !context.inRunScope(() =>
          readPlatformSetting<boolean>(GlobalStateKey.ALLOW_ORCHESTRATOR_KILL),
        )
      ) {
        return yield* Effect.fail(
          new ToolError(
            'Killing subagents is disabled. Enable it in Settings > Multi-Agent.',
          ),
        );
      }

      const success = yield* Effect.suspend(() => {
        const stop = context.session.runs.kill(runId, {
          detachActiveChildren: context.inRunScope(() =>
            detachSubagentsOnStop(),
          ),
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
    },
  );

  /**
   * Same source of truth as `showSummary()`'s completed-run todos branch: a
   * running run's task list is read from session snapshot state. Once
   * the run is finished this must route through
   * `readCompletedRunTodos()` so this endpoint never disagrees with the
   * summary about which tasks are still pending.
   */
  private readonly showTodos = Effect.fn('ExecutionsTool.showTodos')(function* (
    context: RunToolContext,
    runId: RunId,
  ) {
    const session = context.session;
    const handle = session.runs.getHandle(runId);
    const todos = handle
      ? getRunningTodos(session, handle)
      : yield* readCompletedRunTodos(runId, session).pipe(
          Effect.mapError((cause) => new ExecutionsReadFailed({ cause })),
        );

    if (todos.length === 0) {
      return executed(`No task list found for run ${runId}.`);
    }

    const lines = formatTodoSection(todos);
    const header = formatTodoHeader(runId, todos);

    return executed(`${header}\n\n${lines.join('\n')}`);
  });

  private readonly showReport = Effect.fn('ExecutionsTool.showReport')(
    function* (context: RunToolContext, runId: RunId) {
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
    },
  );

  /**
   * Machine-readable final result for chaining a completed run into a
   * later stage without parsing the prose report.
   */
  private readonly showResultMeta = Effect.fn('ExecutionsTool.showResultMeta')(
    function* (context: RunToolContext, runId: RunId) {
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
    },
  );

  private readonly showChildren = Effect.fn('ExecutionsTool.showChildren')(
    function* (this: ExecutionsTool, context: RunToolContext, runId: RunId) {
      const children = yield* readRunChildren(context.session, runId);
      if (children.length === 0) {
        return executed(`No child runs found for .`);
      }

      const lines = yield* this.formatChildren(context, children);
      return executed(
        `Children of ${runId} (${children.length}):\n\n${lines.join('\n')}`,
      );
    },
  );

  private readonly showConfig = Effect.fn('ExecutionsTool.showConfig')(
    function* (context: RunToolContext, runId: RunId) {
      const records = getRunRecords(context.session, runId);
      const record = yield* records.readRunRecord();

      if (!record) {
        return yield* Effect.fail(
          new ToolError(`Config not found for run: ${runId}.`),
        );
      }

      // Filter out fields irrelevant to this agent's category. Identity comes
      // only from the stamped run row.
      const category = runDisplayCategory(
        context.session.runView(runId)?.identity,
        record,
      );
      return executed(serializeFilteredConfig(record, category));
    },
  );

  private readonly showConversation = Effect.fn(
    'ExecutionsTool.showConversation',
  )(function* (
    context: RunToolContext,
    runId: RunId,
    offset: number,
    limit: number,
  ) {
    const records = getRunRecords(context.session, runId);
    const conversationResult = yield* readCompletedRunConversation(
      runId,
      context.session,
    ).pipe(Effect.mapError((cause) => new ExecutionsReadFailed({ cause })));
    const { conversation, source } = conversationResult;

    if (!conversation) {
      // Match the top-level run lookup: a flow-only record is found only
      // when the shared storage decision says it is resumable.
      const resumability = yield* deriveResumability(runId, context.session);
      const exists =
        (yield* records.exists()) ||
        resumability.kind === 'checkpoint' ||
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
  });

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
  private readonly showOutput = Effect.fn('ExecutionsTool.showOutput')(
    function* (
      context: RunToolContext,
      runId: RunId,
      viewRange?: [number, number],
    ) {
      // The handle only proves the run is live in this process; liveness
      // itself is resolved below, from facts that outlive this process.
      const handle = context.session.runs.getHandle(runId);
      const run = context.session.runView(runId);
      if (!run && !handle) {
        return yield* Effect.fail(new ToolError(`Run not found: ${runId}`));
      }
      if (run?.identity.kind !== 'process') {
        return executed(
          `/executions/${runId}/output is only available for background commands (bash with run_in_background). ` +
            `Use /executions/${runId}/conversation for an agent run's message history.`,
        );
      }

      const transcripts = context.session.transcripts;
      // The transcript log is keyed by the run id itself.
      if (!transcripts.has(runId)) {
        return executed(
          `No retained output for ${runId}: its transcript log is no longer available. ` +
            `Use /executions/${runId}/report for the result summary.`,
        );
      }
      const entries = yield* transcripts
        .readEntries(runId)
        .pipe(Effect.mapError((cause) => new ExecutionsReadFailed({ cause })));

      const { lines, chars } = projectProcessOutput(entries);
      // No snapshot: `meta` was read before the transcript, and a command that
      // finished during that read must not be judged against the row as it
      // looked beforehand. One read of one run can afford a fresh one.
      const liveness = yield* resolveRunLiveness(runId, context.session);
      const info = statusInfoFromLiveness(liveness);
      // The footer states the same reading as the header: "no handle in this
      // process" alone never justifies calling the command finished, and a
      // handle this process still tracks past its terminal phase never
      // justifies calling it still running.
      const retained = `this is the retained log; /executions/${runId}/report has the result summary`;
      const footer = ((): string => {
        switch (liveness.kind) {
          case 'live':
            return isInFlightPhase(liveness.info.status)
              ? `[still running: re-read for more output, or use action='wait' on /executions/${runId} to block until it finishes]`
              : `[${liveness.info.status}; ${retained}]`;
          case 'unsettled':
            return `[not running in this process (${liveness.reason}); ${retained}]`;
          case 'interrupted':
            return `[interrupted before finishing; ${retained}]`;
          case 'settled':
            // Nothing here can see a detached shell that outlived its owner, so
            // this says only what the durable facts establish.
            return liveness.outcome
              ? `[finished: ${retained}]`
              : `[no TeXRA process owns this run and no result was recorded; ${retained}]`;
        }
      })();
      const out: string[] = [
        `Output for ${runId} (process, ${formatStatusInfo(info)}): ${chars.toLocaleString()} retained transcript chars; command-output cap ${BASH_BACKGROUND_LOG_CAP_CHARS.toLocaleString()} chars, ${lines.length.toLocaleString()} lines.`,
      ];

      if (lines.length === 0) {
        out.push('', footer);
        return executed(out.join('\n'));
      }
      out.push(
        'Lines are in arrival order; `err:` marks one written to stderr.',
      );

      // Default to the tail, where a live build's news is; a view_range window
      // is clamped so a wide request still can't return an unbounded log.
      const first =
        viewRange?.[0] ?? Math.max(lines.length - OUTPUT_TAIL_LINES, 0) + 1;
      const requestedLast = Math.min(
        viewRange?.[1] ?? lines.length,
        lines.length,
      );
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
    },
  );

  private readonly listFiles = Effect.fn('ExecutionsTool.listFiles')(function* (
    context: RunToolContext,
    runId: RunId,
  ) {
    const files = yield* listRunGeneratedFiles(runId, context.session).pipe(
      Effect.mapError((cause) => new ExecutionsReadFailed({ cause })),
    );
    if (files.length === 0) {
      return executed('No files generated for this run.');
    }

    const lines = formatSizedEntryLines(files);

    return executed(
      `Files in /executions/${runId}/files:\n\n${lines.join('\n')}`,
    );
  });

  private readonly readFile = Effect.fn('ExecutionsTool.readFile')(function* (
    context: RunToolContext,
    runId: RunId,
    filePath: string,
    viewRange?: [number, number],
  ) {
    const displayPath = `/executions/${runId}/files/${filePath}`;
    assertNoParentTraversal(filePath);
    const fullPath = yield* executionsRead(context, () =>
      findExistingRunStoragePath(runId, filePath),
    );
    if (!fullPath) {
      return yield* Effect.fail(
        new ToolError(`File not found: ${displayPath}`),
      );
    }

    return yield* readFileContent(context, StorageFS, fullPath, {
      directoryErrorPath: displayPath,
      resultPath: displayPath,
      viewRange,
    });
  });

  private readonly listWorkspaceFiles = Effect.fn(
    'ExecutionsTool.listWorkspaceFiles',
  )(function* (context: RunToolContext, runId: RunId) {
    const records = getRunRecords(context.session, runId);
    const [record, paths] = yield* Effect.all(
      [records.readRunRecord(), records.readWorkspaceFiles()],
      { concurrency: 2 },
    );
    const entries = yield* executionsRead(context, () =>
      listRunWorkspaceFiles(record, paths),
    );

    if (entries.length === 0) {
      return executed(`No workspace files recorded for run ${runId}.`);
    }

    const lines = formatSizedEntryLines(entries);

    return executed(
      `Workspace files for /executions/${runId}/workspace-files:\n\n` +
        lines.join('\n'),
    );
  });

  private readonly readWorkspaceFile = Effect.fn(
    'ExecutionsTool.readWorkspaceFile',
  )(function* (
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
    // The listing renders recorded paths under a `workspace/` display prefix,
    // so a read in that display form retries against the stripped path.
    const direct = resolveRunWorkspaceFilePath(record, filePath);
    let resolved =
      direct && recordedPaths.has(direct.path) ? direct : undefined;
    const displayPrefix = 'workspace/';
    if (!resolved && filePath.startsWith(displayPrefix)) {
      const stripped = resolveRunWorkspaceFilePath(
        record,
        filePath.slice(displayPrefix.length),
      );
      resolved =
        stripped && recordedPaths.has(stripped.path) ? stripped : undefined;
    }
    if (!resolved) {
      return yield* Effect.fail(
        new ToolError(
          `Workspace file not found: /executions/${runId}/workspace-files/${filePath}`,
        ),
      );
    }

    return yield* readFileContent(context, AbsoluteFS, resolved.absolutePath, {
      directoryErrorPath: `/executions/${runId}/workspace-files/${filePath}`,
      resultPath: `/executions/${runId}/workspace-files/${resolved.path}`,
      viewRange,
    });
  });
}

/**
 * Shared stat → directory-guard → read → format tail for `readFile` and
 * `readWorkspaceFile`, which differ only in which FS backend resolved the
 * path. `directoryErrorPath` and `resultPath` can differ (a workspace-file
 * read reports the raw requested path on error but the canonical resolved
 * path on success).
 */
interface FileBackend {
  stat: (target: string) => Promise<FileStat>;
  read: (target: string) => Promise<string>;
}

const readFileContent = Effect.fn('ExecutionsTool.readFileContent')(function* (
  context: RunToolContext,
  fs: FileBackend,
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
  const stats = yield* executionsRead(context, () => fs.stat(fullPath));
  if (isDirectory(stats.type)) {
    return yield* Effect.fail(
      new ToolError(
        `Path is a directory: ${directoryErrorPath}. Use without trailing path to list.`,
      ),
    );
  }

  const content = yield* executionsRead(context, () => fs.read(fullPath));
  return formatFileView({
    path: resultPath,
    lines: splitContentLines(content),
    viewRange,
    maxLines: Infinity,
  });
});
