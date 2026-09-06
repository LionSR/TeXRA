/**
 * Tool for viewing and managing execution history, generated files, and
 * running processes. Supports viewing past executions, waiting for status
 * changes, reading output from background processes, and killing running
 * executions.
 */

// Third-party imports
import { Data, Deferred, Duration, Effect } from 'effect';

// Local imports
import {
  deriveResumability,
  getExecutionStore,
  listExecutionWorkspaceFiles,
  unwrapResultMeta,
  type ChildRecord,
  listExecutions,
  resolveExecutionWorkspaceFilePath,
} from '@agent/storage';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import {
  getRunContextExecutionId,
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { createLog } from '@logger/logUtils';
import type { FileStat } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import { workspaceRoots } from '@platform/workspaceRoots';
import {
  ExecutionIdSchema,
  ToolError,
  type ExecutionId,
  type TodoItem,
  type ToolResult,
  type WorkflowExecutionSnapshot,
} from '@shared/schemas';
import { BASH_BACKGROUND_LOG_CAP_CHARS } from '@shared/toolUse';
import { isInFlightPhase } from '@shared/streams/streamStatus';
import { warnAbandonedSlotValue } from '@shared/config/settingsAccess';
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
  getExecutionStatusInfo,
  statusInfoFromLiveness,
  executionDisplayCategory,
  shouldSuppressAutoDeliveredSubagentReport,
  type ExecutionDisplayCategory,
  type ExecutionSummaryOptions,
} from './executionFormatters';
import { defineTool } from './core/define';
import {
  formatFileView,
  paginateToolListing,
  formatPaginationHint,
} from './formatting';
import { serializeFilteredConfig } from './executions/configView';
import { formatConversation } from './executions/conversationFormat';
import { resolveExecutionLiveness } from './executions/executionLiveness';
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
import { workflowExecutionView } from './executions/workflowSummaryView';

const log = createLog('ExecutionsTool');

/**
 * Bound on the durable reads one listing page or one children block fans
 * out at once: every row asks for its own metadata (and, when the row
 * recorded no outcome, its execution lease and a checkpoint stat), so the
 * fan-out is bounded rather than page-wide.
 */
const DURABLE_READ_CONCURRENCY = 16;

/**
 * One of the still-Promise collaborators this tool reads — execution
 * storage, the transcript store, the two filesystems — rejected. Nothing
 * here recovers from it: `execute` re-raises `cause`, so the tool runner
 * surfaces the same error instance the collaborator raised.
 */
class ExecutionsReadFailed extends Data.TaggedError('ExecutionsReadFailed')<{
  readonly cause: unknown;
}> {}

/** The one wrap of this tool's Promise collaborators. */
const executionsRead = <A>(
  read: () => Promise<A>,
): Effect.Effect<A, ExecutionsReadFailed> =>
  Effect.tryPromise({
    try: read,
    catch: (cause) => new ExecutionsReadFailed({ cause }),
  });

/**
 * Block until one of `executionIds` changes status, the caller's stream
 * receives a follow-up (the user breaking the wait), or `timeoutSeconds`
 * elapse — whichever comes first. `settled` is re-checked once the change
 * listeners are registered, closing the window between the caller's
 * pre-check and registration. The race settles on the first completion,
 * success or defect, so a throw inside the registry wait surfaces at once
 * instead of stalling until the deadline. Interrupting the winner-less
 * racers aborts the registry wait's signal and disposes the follow-up
 * listener.
 */
const awaitStatusChange = Effect.fn('ExecutionsTool.awaitStatusChange')(
  function* (
    timeoutSeconds: number,
    executionIds: string[],
    settled: () => boolean,
  ) {
    const followUp = yield* Deferred.make<void>();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        listenForFollowUp(() => {
          Deferred.doneUnsafe(followUp, Effect.void);
        }),
      ),
      (stop) => Effect.sync(stop),
    );
    const statusChange = Effect.promise((signal) =>
      currentSession().executions.waitForAnyChange(executionIds, signal),
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

function getRunningTodos(
  session: SessionHandle,
  handle: AgentExecutionHandle,
): readonly TodoItem[] {
  return session.snapshots.getWorkPlan(handle.childStreamId).todos;
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
  description: `View execution history and manage running executions.

Paths:
${EXECUTION_PATH_LIST}

Use "current" as {id} to access the active execution.
Use offset/limit to paginate the /executions listing or conversation messages (default: offset 0, limit 100).
Use view_range: [start, end] to paginate file and background-command output content.
Use action: "wait" on /executions or /executions/{id} to wait for a status change instead of polling.
Use action: "wait" with ids: ["id1", "id2", ...] on /executions to wait for any of the listed executions to change.
Use action: "kill" on /executions/{id} to terminate a running execution.
Delegated subagent and workflow results are delivered automatically as follow-up messages. No wait is needed for executions you launched. Use action: "wait" only when you cannot proceed without a status change.`,
  schema: ExecutionsToolInputSchema,
}) {
  /**
   * The one run edge of this tool (PRD run-edge category b): every line of
   * logic below is an Effect program, run once here on the process runtime.
   * A collaborator's rejection is re-raised as its own cause, so the tool
   * runner still sees the error storage or the filesystem raised; a
   * `ToolError` stays a typed failure and `runPromise` rejects with it.
   */
  protected execute(input: ExecutionsToolInput): Promise<ToolResult> {
    return effectRuntime().runPromise(
      this.run(input).pipe(
        Effect.catchTag('ExecutionsReadFailed', (error) =>
          Effect.die(error.cause),
        ),
      ),
    );
  }

  private readonly run = Effect.fn('ExecutionsTool.run')(function* (
    this: ExecutionsTool,
    input: ExecutionsToolInput,
  ) {
    const segments = getPathSegments(input.path);
    const [namespace, id, resource, ...rest] = segments;

    if (namespace !== 'executions') {
      return yield* Effect.fail(
        new ToolError(`Path must start with /executions. Got: ${input.path}`),
      );
    }

    // /executions - list all executions
    if (!id) {
      if (input.action === 'kill') {
        return yield* Effect.fail(
          new ToolError(
            `action='${input.action}' requires a specific execution: use /executions/{id}.`,
          ),
        );
      }
      if (input.action === 'wait') {
        yield* this.waitForAnyChange(input.timeout, input.ids);
      }
      return yield* this.listExecutions(input.offset, input.limit);
    }

    const executionId = yield* this.resolveExecutionId(id);

    // /executions/{id} - execution summary or actions
    if (!resource) {
      switch (input.action) {
        case 'kill':
          return yield* this.handleKill(executionId);
        case 'wait':
          yield* this.waitForChange(executionId, input.timeout);
          return yield* this.showSummary(executionId, {
            suppressAutoDeliveredSubagentReport: true,
          });
        case 'view':
          return yield* this.showSummary(executionId, {
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
        return yield* this.showConfig(executionId);
      case 'conversation': {
        if (viewRange) {
          return yield* Effect.fail(
            new ToolError(
              'Conversation pagination is message-based. Use offset and limit; view_range applies only to file and background-command output.',
            ),
          );
        }
        return yield* this.showConversation(
          executionId,
          input.offset,
          input.limit,
        );
      }
      case 'todos':
        return yield* this.showTodos(executionId);
      case 'report':
        return yield* this.showReport(executionId);
      case 'result':
        return yield* this.showResultMeta(executionId);
      case 'children':
        return yield* this.showChildren(executionId);
      case 'output':
        return yield* this.showOutput(executionId, viewRange);
      case 'files':
        if (rest.length === 0) {
          return yield* this.listFiles(executionId);
        }
        return yield* this.readFile(executionId, rest.join('/'), viewRange);
      case 'workspace-files':
        if (rest.length === 0) {
          return yield* this.listWorkspaceFiles(executionId);
        }
        return yield* this.readWorkspaceFile(
          executionId,
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

  private resolveExecutionId(
    id: string,
  ): Effect.Effect<ExecutionId, ToolError> {
    if (id === 'current') {
      const executionId = getRunContextExecutionId();
      if (!executionId) {
        return Effect.fail(
          new ToolError(
            'No active execution. Use a specific execution ID instead of "current".',
          ),
        );
      }
      return Effect.succeed(executionId);
    }
    const result = ExecutionIdSchema.safeParse(id);
    if (!result.success) {
      return Effect.fail(
        new ToolError(
          `Invalid execution ID format: ${id}. Expected hex string.`,
        ),
      );
    }
    return Effect.succeed(result.data);
  }

  /** Wait for executions to change status, with timeout. */
  private readonly waitForAnyChange = Effect.fn(
    'ExecutionsTool.waitForAnyChange',
  )(function* (timeout: number, ids?: readonly string[] | null) {
    const candidateIds = ids?.length
      ? unique(ids)
      : currentSession().executions.getActiveIds();
    // Exclude executions that are already effectively done
    // (completed, inactive, or tool-use subagent WAITING with result delivered).
    const pendingIds = candidateIds.filter((id) => !shouldSkipWait(id));
    if (pendingIds.length === 0) return;

    yield* awaitStatusChange(timeout, pendingIds, () =>
      pendingIds.every(shouldSkipWait),
    );
  });

  /** Wait for a specific execution to change status, with timeout. */
  private readonly waitForChange = Effect.fn('ExecutionsTool.waitForChange')(
    function* (executionId: ExecutionId, timeout: number) {
      if (shouldSkipWait(executionId)) return;
      yield* awaitStatusChange(timeout, [executionId], () =>
        shouldSkipWait(executionId),
      );
    },
  );

  private readonly listExecutions = Effect.fn('ExecutionsTool.listExecutions')(
    function* (offset: number, limit: number) {
      const entries = yield* executionsRead(() => listExecutions());

      if (entries.length === 0) {
        return executed('No execution history found.');
      }

      const { page, start, end, total } = paginateToolListing(
        entries,
        offset,
        limit,
      );
      // One page, not one directory — see DURABLE_READ_CONCURRENCY.
      const lines = yield* Effect.forEach(
        page,
        (entry) => Effect.promise(() => formatListingLine(entry)),
        { concurrency: DURABLE_READ_CONCURRENCY },
      );

      return executed(
        `Executions (showing ${start}–${end} of ${total}, most recent first):\n\n${lines.join('\n')}${formatPaginationHint(end, total)}`,
      );
    },
  );

  private readonly showSummary = Effect.fn('ExecutionsTool.showSummary')(
    function* (
      this: ExecutionsTool,
      executionId: ExecutionId,
      options: ExecutionSummaryOptions = {},
    ) {
      // Check in-memory handle first (free) — running executions have everything we need
      const session = currentSession();
      const handle = session.executions.getHandle(executionId);

      if (handle) {
        // Running execution: agent/status and task state are session-owned;
        // fetch only the remaining durable details from execution storage.
        const store = getExecutionStore(executionId);
        const todos = getRunningTodos(session, handle);
        const [meta, children, report] = yield* Effect.all(
          [
            executionsRead(() => store.readMeta()),
            executionsRead(() => store.readChildren()),
            executionsRead(() => store.readReport()),
          ],
          { concurrency: 3 },
        );

        const info = session.executions.getStatus(handle);
        // `handle.category` is the live wire's execution mode, fabricated for a
        // non-agent run (a background bash reports toolUse). The stamped
        // identity is what the completed branch displays, so the running branch
        // reads it too and the same run cannot change category as it settles;
        // an agent run has no identity-derived category and keeps its mode.
        const category =
          executionDisplayCategory(meta?.identity, null) ?? handle.category;
        const lines = buildRunningSummaryLines(
          executionId,
          handle,
          category,
          info,
          meta,
        );

        yield* this.appendSummaryTail(
          lines,
          executionId,
          category,
          children,
          todos,
          report,
          {
            workflow: meta?.workflow,
            suppressReport: shouldSuppressAutoDeliveredSubagentReport(
              options,
              handle,
            ),
          },
        );

        return executed(lines.join('\n'));
      }

      // Completed execution: full KV fetch
      const store = getExecutionStore(executionId);
      const [meta, record, children, todos, report] = yield* Effect.all(
        [
          executionsRead(() => store.readMeta()),
          executionsRead(() => store.readRunRecord()),
          executionsRead(() => store.readChildren()),
          executionsRead(() => readCompletedRunTodos(executionId)),
          executionsRead(() => store.readReport()),
        ],
        { concurrency: 5 },
      );

      if (!meta && !record) {
        const resumability = yield* executionsRead(() =>
          deriveResumability(executionId),
        );
        if (resumability.kind !== 'checkpoint') {
          return yield* Effect.fail(
            new ToolError(`Execution not found: ${executionId}`),
          );
        }
        return executed(
          `Execution: ${executionId}\nStatus: resumable\n(No metadata available - use /executions/${executionId}/conversation to view messages)`,
        );
      }

      // Identity comes only from the stamped execution row; pre-identity rows
      // lost their reader per #9590 Stage 7 and degrade to the config-derived
      // display category, loudly.
      const identity = meta?.identity;
      if (meta && !identity) {
        log.warn(
          `Execution ${executionId} is a pre-identity row; showing config-derived category only (reader retired per #9590 Stage 7)`,
        );
      }
      const category = executionDisplayCategory(identity, record);
      const info = yield* executionsRead(() =>
        getExecutionStatusInfo(executionId, meta),
      );
      const lines = buildCompletedSummaryLines(
        executionId,
        record,
        identity,
        category,
        info,
        meta,
      );

      yield* this.appendSummaryTail(
        lines,
        executionId,
        category,
        children,
        todos,
        report,
        { workflow: meta?.workflow },
      );

      return executed(lines.join('\n'));
    },
  );

  /**
   * Append the shared summary tail (children, todos, report, available paths)
   * common to both the running-handle and completed-execution branches.
   */
  private readonly appendSummaryTail = Effect.fn(
    'ExecutionsTool.appendSummaryTail',
  )(function* (
    this: ExecutionsTool,
    lines: string[],
    executionId: ExecutionId,
    category: ExecutionDisplayCategory | undefined,
    children: ChildRecord[],
    todos: readonly TodoItem[],
    report: string | null,
    options: {
      readonly workflow?: WorkflowExecutionSnapshot;
      readonly suppressReport?: boolean;
    } = {},
  ) {
    if (options.workflow) {
      lines.push(
        '',
        'Workflow:',
        JSON.stringify(workflowExecutionView(options.workflow), null, 2),
      );
    }
    if (children.length > 0) {
      lines.push('', `Children (${children.length}):`);
      const formatted = yield* this.formatChildren(children);
      lines.push(...formatted.map((line) => `  ${line}`));
    }
    lines.push(
      ...buildSummaryTailLines(
        executionId,
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
    (children: ChildRecord[]) =>
      Effect.forEach(
        children,
        (child) =>
          Effect.promise(async () =>
            formatChildLine(
              child,
              await getExecutionStore(child.id).readMeta(),
            ),
          ),
        { concurrency: DURABLE_READ_CONCURRENCY },
      ),
  );

  private readonly handleKill = Effect.fn('ExecutionsTool.handleKill')(
    function* (executionId: ExecutionId) {
      const ctx = tryUseRunContext();
      const callerStreamId = getRunContextStreamId(ctx);

      if (getRunContextExecutionId(ctx) === executionId) {
        return yield* Effect.fail(
          new ToolError(`Cannot kill your own execution (${executionId}).`),
        );
      }

      const target = currentSession().executions.getHandle(executionId);
      if (!target) {
        return yield* Effect.fail(
          new ToolError(
            `Execution ${executionId} not found or already completed.`,
          ),
        );
      }

      // Scope: can only kill your own children. Deny if no context.
      if (!target.isOwnedBy(callerStreamId)) {
        return yield* Effect.fail(
          new ToolError(
            `Cannot kill execution ${executionId}: not a child of this session.`,
          ),
        );
      }

      // Only block kills when the toggle is disabled (the guard above has
      // already narrowed `target` to an owned AgentExecutionHandle).
      warnAbandonedSlotValue(
        GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
        'workspaceState',
        workspaceRoots().workspaceState,
      );
      if (
        !readPlatformSetting<boolean>(GlobalStateKey.ALLOW_ORCHESTRATOR_KILL)
      ) {
        return yield* Effect.fail(
          new ToolError(
            'Killing subagents is disabled. Enable it in Settings > Multi-Agent.',
          ),
        );
      }

      const success = currentSession().executions.kill(executionId, {
        detachActiveChildren: detachSubagentsOnStop(),
      });
      if (success) {
        return executed(`Execution ${executionId} terminated.`);
      }
      return yield* Effect.fail(
        new ToolError(`Execution ${executionId} could not be terminated.`),
      );
    },
  );

  /**
   * Same source of truth as `showSummary()`'s completed-run todos branch: a
   * running execution's task list is read from session snapshot state. Once
   * the execution is finished this must route through
   * `readCompletedRunTodos()` so this endpoint never disagrees with the
   * summary about which tasks are still pending.
   */
  private readonly showTodos = Effect.fn('ExecutionsTool.showTodos')(function* (
    executionId: ExecutionId,
  ) {
    const session = currentSession();
    const handle = session.executions.getHandle(executionId);
    const todos = handle
      ? getRunningTodos(session, handle)
      : yield* executionsRead(() => readCompletedRunTodos(executionId));

    if (todos.length === 0) {
      return executed(`No task list found for execution ${executionId}.`);
    }

    const lines = formatTodoSection(todos);
    const header = formatTodoHeader(executionId, todos);

    return executed(`${header}\n\n${lines.join('\n')}`);
  });

  private readonly showReport = Effect.fn('ExecutionsTool.showReport')(
    function* (executionId: ExecutionId) {
      const store = getExecutionStore(executionId);
      const [report, note] = yield* Effect.all(
        [
          executionsRead(() => store.readReport()),
          executionsRead(() => turnAttributionNote(store)),
        ],
        { concurrency: 2 },
      );
      if (!report) {
        return executed(
          `No report found for execution ${executionId}. Reports are persisted when subagents or background processes complete.`,
        );
      }
      return executed(note ? `${note}\n\n${report}` : report);
    },
  );

  /**
   * Machine-readable final result for chaining a completed execution into a
   * later stage without parsing the prose report.
   */
  private readonly showResultMeta = Effect.fn('ExecutionsTool.showResultMeta')(
    function* (executionId: ExecutionId) {
      const store = getExecutionStore(executionId);
      const [resultMeta, note] = yield* Effect.all(
        [
          executionsRead(() => store.readResultMeta()),
          executionsRead(() => turnAttributionNote(store)),
        ],
        { concurrency: 2 },
      );
      if (!resultMeta) {
        return executed(
          `No structured result recorded for ${executionId} yet. It is written when the execution completes.`,
        );
      }
      // The note rides INSIDE the JSON: /result is the machine-readable
      // chaining endpoint, so prefixed prose would break JSON.parse
      // consumers precisely in the interrupted-turn case it describes.
      const payload = note
        ? { turnAttribution: note, ...unwrapResultMeta(resultMeta) }
        : unwrapResultMeta(resultMeta);
      return executed(JSON.stringify(payload, null, 2));
    },
  );

  private readonly showChildren = Effect.fn('ExecutionsTool.showChildren')(
    function* (this: ExecutionsTool, executionId: ExecutionId) {
      const children = yield* executionsRead(() =>
        getExecutionStore(executionId).readChildren(),
      );
      if (children.length === 0) {
        return executed(`No child executions found for ${executionId}.`);
      }

      const lines = yield* this.formatChildren(children);
      return executed(
        `Children of ${executionId} (${children.length}):\n\n${lines.join('\n')}`,
      );
    },
  );

  private readonly showConfig = Effect.fn('ExecutionsTool.showConfig')(
    function* (executionId: ExecutionId) {
      const store = getExecutionStore(executionId);
      const record = yield* executionsRead(() => store.readRunRecord());

      if (!record) {
        return yield* Effect.fail(
          new ToolError(`Config not found for execution: ${executionId}.`),
        );
      }

      // Filter out fields irrelevant to this agent's category. Identity comes
      // only from the stamped execution row; a pre-identity row (reader retired
      // per #9590 Stage 7) degrades to the config-derived category, loudly.
      const meta = yield* executionsRead(() => store.readMeta());
      const identity = meta?.identity;
      if (meta && !identity) {
        log.warn(
          `Execution ${executionId} is a pre-identity row; filtering config by its config-derived category only (reader retired per #9590 Stage 7)`,
        );
      }
      const category = executionDisplayCategory(identity, record);
      return executed(serializeFilteredConfig(record, category));
    },
  );

  private readonly showConversation = Effect.fn(
    'ExecutionsTool.showConversation',
  )(function* (executionId: ExecutionId, offset: number, limit: number) {
    const store = getExecutionStore(executionId);
    const conversationResult = yield* executionsRead(() =>
      readCompletedRunConversation(executionId),
    );
    const { conversation, source, streamId } = conversationResult;
    const streamDiagnostics = [`Stream: ${streamId ?? 'none'}`];

    if (!conversation) {
      // Match the top-level execution lookup: a flow-only record is found only
      // when the shared storage decision says it is resumable.
      const meta = yield* executionsRead(() => store.readMeta());
      const resumability = yield* executionsRead(() =>
        deriveResumability(executionId),
      );
      const exists =
        meta !== null ||
        resumability.kind === 'checkpoint' ||
        hasCompletedRunConversationEvidence(conversationResult);
      if (!exists) {
        return yield* Effect.fail(
          new ToolError(`Execution not found: ${executionId}`),
        );
      }
      return executed(
        formatConversation([], {
          totalMessages: 0,
          metadata: [
            'Source: none',
            ...streamDiagnostics,
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
        ...streamDiagnostics,
        `Returned message interval: [${pageStart}, ${pageEnd})`,
        `Next offset: ${pageEnd < conversation.length ? pageEnd : 'none'}`,
      ],
    });

    return executed(output);
  });

  /**
   * stdout/stderr of a background command, projected from the transcript log
   * its child stream already writes (`createChildStream` in `tools/bash.ts`).
   *
   * This is the only route readable *while the command runs*: `/report` and
   * `/result` are written at completion, and the completion follow-up carries
   * only a 20-line preview, so without this the middle of a long build log is
   * unreachable even after the run ends. Restricted to process executions —
   * an agent run's rows are a model transcript, which `/conversation` already
   * renders properly.
   */
  private readonly showOutput = Effect.fn('ExecutionsTool.showOutput')(
    function* (executionId: ExecutionId, viewRange?: [number, number]) {
      // The handle names the live child stream; liveness itself is resolved
      // below, from facts that outlive this process.
      const handle = currentSession().executions.getHandle(executionId);
      const meta = yield* executionsRead(() =>
        getExecutionStore(executionId).readMeta(),
      );
      if (!meta && !handle) {
        return yield* Effect.fail(
          new ToolError(`Execution not found: ${executionId}`),
        );
      }
      if (meta?.identity?.kind !== 'process') {
        return executed(
          `/executions/${executionId}/output is only available for background commands (bash with run_in_background). ` +
            `Use /executions/${executionId}/conversation for an agent run's message history.`,
        );
      }

      const transcripts = currentSession().transcripts;
      // The stream is the one stamped on execution metadata at registration.
      const streamId = handle?.childStreamId ?? meta?.streamId;
      if (!streamId || !transcripts.has(streamId)) {
        return executed(
          `No retained output for ${executionId}: its stream log is no longer available. ` +
            `Use /executions/${executionId}/report for the result summary.`,
        );
      }
      const entries = yield* executionsRead(() =>
        transcripts.readEntries(streamId),
      );

      const { lines, chars } = projectProcessOutput(entries);
      // No snapshot: `meta` was read before the transcript, and a command that
      // finished during that read must not be judged against the row as it
      // looked beforehand. One read of one execution can afford a fresh one.
      const liveness = yield* executionsRead(() =>
        resolveExecutionLiveness(executionId),
      );
      const info = statusInfoFromLiveness(liveness);
      // The footer states the same reading as the header: "no handle in this
      // process" alone never justifies calling the command finished, and a
      // handle this process still tracks past its stream's terminal phase never
      // justifies calling it still running.
      const retained = `this is the retained log; /executions/${executionId}/report has the result summary`;
      const footer = ((): string => {
        switch (liveness.kind) {
          case 'live':
            return isInFlightPhase(liveness.info.status)
              ? `[still running: re-read for more output, or use action='wait' on /executions/${executionId} to block until it finishes]`
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
              : `[no TeXRA process owns this execution and no result was recorded; ${retained}]`;
        }
      })();
      const out: string[] = [
        `Output for ${executionId} (process, ${formatStatusInfo(info)}): ${chars.toLocaleString()} retained transcript chars; command-output cap ${BASH_BACKGROUND_LOG_CAP_CHARS.toLocaleString()} chars, ${lines.length.toLocaleString()} lines.`,
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
        `Read lines ${first}-${last} of /executions/${executionId}/output`,
      );
    },
  );

  private readonly listFiles = Effect.fn('ExecutionsTool.listFiles')(function* (
    executionId: ExecutionId,
  ) {
    const files = yield* executionsRead(() =>
      listRunGeneratedFiles(executionId),
    );
    if (files.length === 0) {
      return executed('No files generated for this execution.');
    }

    const lines = formatSizedEntryLines(files);

    return executed(
      `Files in /executions/${executionId}/files:\n\n${lines.join('\n')}`,
    );
  });

  private readonly readFile = Effect.fn('ExecutionsTool.readFile')(function* (
    executionId: ExecutionId,
    filePath: string,
    viewRange?: [number, number],
  ) {
    const displayPath = `/executions/${executionId}/files/${filePath}`;
    assertNoParentTraversal(filePath);
    const fullPath = yield* executionsRead(() =>
      findExistingRunStoragePath(executionId, filePath),
    );
    if (!fullPath) {
      return yield* Effect.fail(
        new ToolError(`File not found: ${displayPath}`),
      );
    }

    return yield* readFileContent(StorageFS, fullPath, {
      directoryErrorPath: displayPath,
      resultPath: displayPath,
      viewRange,
    });
  });

  private readonly listWorkspaceFiles = Effect.fn(
    'ExecutionsTool.listWorkspaceFiles',
  )(function* (executionId: ExecutionId) {
    const store = getExecutionStore(executionId);
    const [record, paths] = yield* Effect.all(
      [
        executionsRead(() => store.readRunRecord()),
        executionsRead(() => store.readWorkspaceFiles()),
      ],
      { concurrency: 2 },
    );
    const entries = yield* executionsRead(() =>
      listExecutionWorkspaceFiles(record, paths),
    );

    if (entries.length === 0) {
      return executed(
        `No workspace files recorded for execution ${executionId}.`,
      );
    }

    const lines = formatSizedEntryLines(entries);

    return executed(
      `Workspace files for /executions/${executionId}/workspace-files:\n\n` +
        lines.join('\n'),
    );
  });

  private readonly readWorkspaceFile = Effect.fn(
    'ExecutionsTool.readWorkspaceFile',
  )(function* (
    executionId: ExecutionId,
    filePath: string,
    viewRange?: [number, number],
  ) {
    const store = getExecutionStore(executionId);
    const [record, paths] = yield* Effect.all(
      [
        executionsRead(() => store.readRunRecord()),
        executionsRead(() => store.readWorkspaceFiles()),
      ],
      { concurrency: 2 },
    );
    const recordedPaths = new Set(
      paths.flatMap((candidate) => {
        const resolvedCandidate = resolveExecutionWorkspaceFilePath(
          record,
          candidate,
        );
        return resolvedCandidate ? [resolvedCandidate.path] : [];
      }),
    );
    // The listing renders recorded paths under a `workspace/` display prefix,
    // so a read in that display form retries against the stripped path.
    const direct = resolveExecutionWorkspaceFilePath(record, filePath);
    let resolved =
      direct && recordedPaths.has(direct.path) ? direct : undefined;
    const displayPrefix = 'workspace/';
    if (!resolved && filePath.startsWith(displayPrefix)) {
      const stripped = resolveExecutionWorkspaceFilePath(
        record,
        filePath.slice(displayPrefix.length),
      );
      resolved =
        stripped && recordedPaths.has(stripped.path) ? stripped : undefined;
    }
    if (!resolved) {
      return yield* Effect.fail(
        new ToolError(
          `Workspace file not found: /executions/${executionId}/workspace-files/${filePath}`,
        ),
      );
    }

    return yield* readFileContent(AbsoluteFS, resolved.absolutePath, {
      directoryErrorPath: `/executions/${executionId}/workspace-files/${filePath}`,
      resultPath: `/executions/${executionId}/workspace-files/${resolved.path}`,
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
  const stats = yield* executionsRead(() => fs.stat(fullPath));
  if (isDirectory(stats.type)) {
    return yield* Effect.fail(
      new ToolError(
        `Path is a directory: ${directoryErrorPath}. Use without trailing path to list.`,
      ),
    );
  }

  const content = yield* executionsRead(() => fs.read(fullPath));
  return formatFileView({
    path: resultPath,
    lines: splitContentLines(content),
    viewRange,
    maxLines: Infinity,
  });
});
