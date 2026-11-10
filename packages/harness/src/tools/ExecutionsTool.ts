/**
 * Query and manage run history, generated files and live processes.
 *
 * Every fact about a run — what it is, what it is called, how far it got,
 * whose child it is, what it still has to do — is read off the session fold
 * (`SessionView`), and whether it is live here off `Runs`. The fold is the
 * one reading of the durable rows, so this surface never resolves
 * parentage or a task list a second time.
 */

// Third-party imports
import { Duration, Effect, FileSystem, Stream, SubscriptionRef } from 'effect';

// Local imports
import { isDeliveryOf } from '@agent/storage/runLifecycle';
import { getRunRecords } from '@agent/storage/runOwnership';
import {
  listRunWorkspaceFiles,
  resolveRunWorkspaceFilePath,
} from '@agent/storage/runWorkspaceFiles';
import { inRunSession, type RunToolCall } from '@agent/runtime/RunCall';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Runs } from '@agent/runtime/runRegistry';
import { scriptRunCalls } from '@agent/runtime/scriptRun';
import { HISTORY_VIEW_SUMMARY } from '@agent/runtime/historyQuery/views';
import { findExistingRunStoragePathUnder } from '@common/storage/storageLayout';
import { SessionRoots, StorageFs } from '@platform/rootedFs';
import {
  isRunId,
  qualifyAggregateId,
  ToolError,
  type RunId,
  type ToolResult,
} from '@shared/schemas';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import type { SessionView } from '@shared/session/sessionView';
import { assertNoParentTraversal } from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import { readCompletedRunConversation } from '@transcript/completedRunArchive';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { getPathSegments } from '@utils/core/pathCore';
import { splitContentLines } from '@utils/text/stringUtils';

// Local file imports
import {
  ALL_KINDS,
  buildSummaryLines,
  buildSummaryTailLines,
  childRunViews,
  formatChildLine,
  runDisplayCategory,
  type RunDisplayCategory,
} from './executionFormatters';
import { defineTool } from './core/definition';
import { formatFileView } from './formatting';
import { serializeFilteredConfig } from './executions/configView';
import { formatConversation } from './executions/conversationFormat';
import { orchestratorKillDenial } from './executions/killPolicy';
import { queryHistory } from './executions/queryAction';
import { showOutput } from './executions/processOutput';
import { listRunGeneratedFiles } from './executions/runGeneratedFiles';
import {
  ExecutionsToolInputSchema,
  type ExecutionsToolInput,
} from './executions/toolInput';
import { listExecutions } from './executions/executionListing';
import { missingRun, sendToRun } from './executions/send';
import { scriptCallsView } from './executions/scriptCallsView';

interface RunToolContext {
  readonly runId: RunId;
  /** The session's runs. */
  readonly runs: Runs['Service'];
}

/**
 * Block until one of `runIds` changes status, the caller's run is sent a
 * follow-up (a child's report, a peer's reply, the user breaking the wait),
 * or `timeoutSeconds` elapse — whichever comes first. Both are read off the
 * session's view stream against the view the wait started from: a status as
 * the phases, a follow-up as a `queuedFollowUps` id the caller did not hold.
 * The caller is inside this tool call, so nothing it is sent is taken before
 * the wait sees it, whoever sent it; a change landing before the stream's
 * first emission, or after `initial` (the view `runIds` were chosen on),
 * still wakes it; `settled` is re-checked once the stream is up. The view
 * stream ends with the session, which ends the wait too. The race settles on
 * the first completion, success or failure, so a dead fold surfaces at once
 * instead of stalling until the deadline.
 */
const awaitStatusChange = Effect.fn('ExecutionsTool.awaitStatusChange')(
  function* (
    context: RunToolContext,
    initial: SessionView,
    timeoutSeconds: number,
    runIds: readonly RunId[],
    settled: (view: SessionView) => boolean,
  ) {
    const phases = (view: SessionView): string =>
      runIds
        .map((id) => {
          const run = view.runs.get(id);
          return run === undefined ? '' : (run.outcome ?? run.position);
        })
        .join(',');
    const sent = (view: SessionView): readonly string[] =>
      (view.queuedFollowUps.get(context.runId) ?? []).map((f) => f.followUpId);
    const started = phases(initial);
    const held = new Set(sent(initial));
    const { changes, ref } = yield* SessionViewAccess;
    const change = changes.pipe(
      Stream.filter(
        (view) =>
          phases(view) !== started || sent(view).some((id) => !held.has(id)),
      ),
      Stream.runHead,
    );
    const alreadySettled = Effect.suspend(() =>
      settled(SubscriptionRef.getUnsafe(ref)) ? Effect.void : Effect.never,
    );
    yield* Effect.raceAllFirst([change, alreadySettled]).pipe(
      Effect.timeoutOption(Duration.seconds(timeoutSeconds)),
    );
  },
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
  return entries.map(({ isDirectory, size, path }) => {
    const bytes = `${size.toLocaleString('en-US')} bytes`;
    return `${(isDirectory ? '<dir>' : bytes).padStart(8)}  ${path}`;
  });
}
type ExecutionsAction = ExecutionsToolInput['action'];
interface RouteRequest<A extends ExecutionsAction> {
  readonly context: RunToolContext;
  readonly input: Extract<ExecutionsToolInput, { action: A }>;
  /** The `{id}` segment's run (`/executions` names none and reads none). */
  readonly runId: RunId;
  /** The `{path}` segment, `/`-joined. */
  readonly rest: string;
}
type RouteHandler<A extends ExecutionsAction> = (
  request: RouteRequest<A>,
) => Effect.Effect<
  ToolResult,
  Error,
  FileSystem.FileSystem | StorageFs | SessionServices
>;
type RouteActions = {
  readonly [A in ExecutionsAction]?: RouteHandler<A>;
};

/**
 * The one table of the paths the tool serves: the description and the
 * "Unknown path" error render from `path` and `summary`, a path accepts the
 * actions its row handles, and the "not valid here" error names the rows that
 * do. A `{…}` segment matches any one segment, a trailing `{path}` the rest.
 * `kinds` are the runs a run's summary lists a path for; a row without it
 * is listed for none.
 */
const EXECUTION_ROUTES: ReadonlyArray<{
  readonly path: string;
  readonly summary: string;
  readonly kinds?: readonly RunDisplayCategory[];
  readonly actions: RouteActions;
}> = [
  {
    path: '/executions',
    summary: 'List executions (paginated; use offset/limit for pages)',
    actions: {
      view: ({ context, input }) =>
        listExecutions(context.runId, input.offset, input.limit),
      wait: ({ context, input }) =>
        waitForRuns(context, input.timeout, input.ids).pipe(
          Effect.andThen(
            listExecutions(context.runId, input.offset, input.limit),
          ),
        ),
      query: ({ input }) => queryHistory(input.sql, input.params),
    },
  },
  {
    path: '/executions/{id}',
    summary: 'Execution summary (agent, model, timestamp, status, children)',
    actions: {
      view: ({ context, runId }) => showSummary(context, runId),
      wait: Effect.fn('wait')(function* ({ context, input, runId }) {
        yield* waitForRuns(context, input.timeout, [runId]);
        // The child's report still queued on the caller: this result
        // answers it, and its settlement consumes it with it.
        const { followUps } = yield* (yield* SessionLog).runRows(
          qualifyAggregateId('run', context.runId),
          'input',
        );
        const answered = followUps
          .map(({ followUpId }) => followUpId)
          .filter((followUpId) => isDeliveryOf(runId, followUpId));
        const summary = yield* showSummary(context, runId);
        return { ...summary, consumedFollowUps: answered };
      }),
      kill: ({ context, runId }) => handleKill(context, runId),
      send: ({ context, input, runId }) =>
        sendToRun(context.runId, runId, input.message),
    },
  },
  {
    path: '/executions/{id}/config',
    summary: 'Agent configuration JSON',
    kinds: ALL_KINDS,
    actions: { view: ({ context, runId }) => showConfig(context, runId) },
  },
  {
    path: '/executions/{id}/conversation',
    summary: 'Full message history (subagents)',
    kinds: ['agent', 'task', 'script'],
    actions: {
      view: ({ context, input, runId }) =>
        input.view_range
          ? Effect.fail(
              new ToolError(
                'Conversation pagination is message-based. Use offset and limit; view_range applies only to file and background-command output.',
              ),
            )
          : showConversation(context, runId, input.offset, input.limit),
    },
  },
  {
    path: '/executions/{id}/report',
    summary: 'Result report (persists after context compaction)',
    kinds: ALL_KINDS,
    actions: { view: ({ context, runId }) => showReport(context, runId) },
  },
  {
    path: '/executions/{id}/result',
    summary:
      'Final result envelope (JSON) for chaining; process result for background commands',
    kinds: ALL_KINDS,
    actions: { view: ({ context, runId }) => showResultMeta(context, runId) },
  },
  {
    path: '/executions/{id}/output',
    summary:
      'stdout/stderr of a background command, readable WHILE IT RUNS (report/result only exist once it finishes)',
    kinds: ['process'],
    actions: {
      view: ({ input, runId }) =>
        showOutput(runId, input.view_range ?? undefined),
    },
  },
  {
    path: '/executions/{id}/files',
    summary: 'Generated files (task runs only)',
    kinds: ['task'],
    actions: { view: ({ runId }) => listFiles(runId) },
  },
  {
    path: '/executions/{id}/files/{path}',
    summary: 'Read specific generated file (task runs only)',
    actions: {
      view: ({ context, input, runId, rest }) =>
        readFile(context, runId, rest, input.view_range ?? undefined),
    },
  },
  {
    path: '/executions/{id}/workspace-files',
    summary: 'Workspace files edited by tool-use runs',
    kinds: ['agent'],
    actions: {
      view: ({ context, runId }) => listWorkspaceFiles(context, runId),
    },
  },
  {
    path: '/executions/{id}/workspace-files/{path}',
    summary: 'Read a workspace file edited by a tool-use run',
    actions: {
      view: ({ context, input, runId, rest }) =>
        readWorkspaceFile(context, runId, rest, input.view_range ?? undefined),
    },
  },
];

/** A row's handler for `action`, read by a key the checker keeps paired. */
function handlerFor<A extends ExecutionsAction>(
  actions: RouteActions,
  action: A,
): RouteHandler<A> | undefined {
  return actions[action];
}

/** The paths a run of `category` serves, below its own, as its summary
 *  lists them. */
const pathsFor = (category: RunDisplayCategory): readonly string[] =>
  EXECUTION_ROUTES.flatMap(({ path, kinds }) =>
    kinds?.includes(category) ? [path.slice('/executions/{id}/'.length)] : [],
  );

const EXECUTION_PATH_LIST = EXECUTION_ROUTES.map(
  ({ path, summary }) => `- ${path} - ${summary}`,
).join('\n');

/**
 * Every line of logic below is one Effect program. A storage or filesystem
 * read failure stays in the error channel: nothing here recovers from one,
 * and the tool runner surfaces the collaborator's own error.
 */
const executeExecutionsTool = Effect.fn('ExecutionsTool.call')(function* (
  { run }: RunToolCall,
  input: ExecutionsToolInput,
) {
  const context = { runId: run.runId, runs: yield* Runs };
  const segments = getPathSegments(input.path);
  const route = EXECUTION_ROUTES.find(({ path }) => {
    const parts = path.split('/').slice(1);
    const greedy = parts.at(-1) === '{path}';
    return (
      (greedy
        ? segments.length >= parts.length
        : segments.length === parts.length) &&
      parts.every((part, i) => part.startsWith('{') || part === segments[i])
    );
  });
  if (!route) {
    return yield* Effect.fail(
      new ToolError(
        `Unknown path: ${input.path}.\nValid paths:\n${EXECUTION_PATH_LIST}`,
      ),
    );
  }
  const handle = handlerFor(route.actions, input.action);
  if (!handle) {
    const validOn = EXECUTION_ROUTES.filter(
      ({ actions }) => actions[input.action],
    );
    return yield* Effect.fail(
      new ToolError(
        `action='${input.action}' runs on ${validOn.map(({ path }) => path).join(' or ')}, not on ${route.path}.`,
      ),
    );
  }
  return yield* handle({
    context,
    input,
    runId: yield* resolveRunId(context, segments[1] ?? 'current'),
    rest: segments.slice(3).join('/'),
  });
});

function resolveRunId(
  context: RunToolContext,
  id: string,
): Effect.Effect<RunId, ToolError> {
  if (id === 'current') return Effect.succeed(context.runId);
  if (isRunId(id)) return Effect.succeed(id);
  return Effect.fail(
    new ToolError(`Invalid run ID format: ${id}. Expected hex string.`),
  );
}

/** Whether a wait on `runId` is over: no launch of it is in flight here
 *  (`RunsShape.get`), or it left the in-flight phases on `view`. A run
 *  launched here whose start has not been applied yet is running. */
const waitOver = (
  runs: Runs['Service'],
  view: SessionView,
  runId: RunId,
): boolean => {
  if (runs.get(runId) === undefined) return true;
  const run = view.runs.get(runId);
  return run !== undefined && run.outcome !== null;
};

/** Wait for runs to end, with timeout. */
const waitForRuns = Effect.fn('ExecutionsTool.waitForRuns')(function* (
  context: RunToolContext,
  timeout: number,
  ids?: readonly RunId[] | null,
) {
  const { runs } = context;
  const candidates = ids?.length ? ids : runs.get().map((r) => r.runId);
  const initial = SubscriptionRef.getUnsafe((yield* SessionViewAccess).ref);
  const pendingIds = [...new Set(candidates)].filter(
    (id) => !waitOver(runs, initial, id),
  );
  if (pendingIds.length === 0) return;

  yield* awaitStatusChange(context, initial, timeout, pendingIds, (view) =>
    pendingIds.every((id) => waitOver(runs, view, id)),
  );
});

/**
 * One line set for a live run and a finished one alike: the fold answers
 * for both, so there is no second summary shape to keep in step.
 *
 * The view is folded cold rather than read off the live projection, which
 * deliberately keeps only a bounded transcript for inactive runs: a
 * script's board would otherwise lose its terminal cards and its
 * board-level opened state. That board is why this is the one read on the
 * surface that names its run's aggregate; every other path here takes the
 * listing tier alone.
 */
const showSummary = Effect.fn('ExecutionsTool.showSummary')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  const view = yield* (yield* SessionViewAccess).read([runId]);
  const run = view.runs.get(runId);

  // An open run is in the view; one launched here may not have opened yet.
  if (!run)
    return yield* Effect.fail(
      missingRun(context.runs, runId, `Run not found: ${runId}`),
    );

  // The report is a private record row, never part of the display fold.
  const report = yield* getRunRecords(runId).readReport();
  const lines = buildSummaryLines(run);

  // A background script's calls, from its rows, under the same bounds.
  if (run.identity.kind === 'script') {
    const { calls } = yield* scriptRunCalls(runId);
    lines.push(
      '',
      'Script:',
      JSON.stringify(scriptCallsView(calls, run.holder === 'here'), null, 2),
    );
  }

  const children = childRunViews(view, runId);
  if (children.length > 0) {
    lines.push('', `Children (${children.length}):`);
    lines.push(...children.map((child) => `  ${formatChildLine(child)}`));
  }

  lines.push(
    ...buildSummaryTailLines(runId, pathsFor(runDisplayCategory(run)), report),
  );

  return executed(lines.join('\n'));
});

const handleKill = Effect.fn('ExecutionsTool.handleKill')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  if (context.runId === runId) {
    return yield* Effect.fail(
      new ToolError(`Cannot kill your own run (${runId}).`),
    );
  }

  const { runs } = context;
  if (runs.get(runId) === undefined) {
    return yield* Effect.fail(
      new ToolError(`Run ${runId} not found or already completed.`),
    );
  }

  // Only your own children, by the attached parent the fold reads.
  const view = yield* (yield* SessionViewAccess).read([]);
  if (view.runs.get(runId)?.parentId !== context.runId) {
    return yield* Effect.fail(
      new ToolError(`Cannot kill run ${runId}: not a child of this session.`),
    );
  }

  // The permission gate: off, or a stored value that fails its schema, denies.
  const killDenial = yield* orchestratorKillDenial(yield* SessionRoots);
  if (killDenial !== undefined) {
    return yield* Effect.fail(new ToolError(killDenial));
  }

  // Its children follow the session's stop policy (`RunRegistry.stop`).
  const success = yield* runs.stop(runId, 'user').pipe(Effect.uninterruptible);
  if (success) return executed(`Run ${runId} terminated.`);
  return yield* Effect.fail(
    new ToolError(`Run ${runId} could not be terminated.`),
  );
});

const showReport = Effect.fn('ExecutionsTool.showReport')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  const report = yield* getRunRecords(runId).readReport();
  if (!report) {
    return executed(
      `No report found for run ${runId}. Reports are persisted when subagents or background processes complete.`,
    );
  }
  return executed(report);
});

/**
 * Machine-readable final result for chaining a completed run into a
 * later stage without parsing the prose report.
 */
const showResultMeta = Effect.fn('ExecutionsTool.showResultMeta')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  const result = yield* getRunRecords(runId).readResult();
  if (!result) {
    return executed(
      `No structured result recorded for ${runId} yet. It is written when the run completes.`,
    );
  }
  return executed(JSON.stringify(result, null, 2));
});

const showConfig = Effect.fn('ExecutionsTool.showConfig')(function* (
  context: RunToolContext,
  runId: RunId,
) {
  const records = getRunRecords(runId);
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
  const run = (yield* (yield* SessionViewAccess).read([])).runs.get(runId);
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
    const records = getRunRecords(runId);
    const { config } = yield* SessionRoots;
    const conversation = yield* readCompletedRunConversation(runId, config);

    if (conversation.length === 0) {
      // A checkpoint implies the `run.start` `exists` reads: it is seq 1 of
      // the run's aggregate.
      if (!(yield* records.exists())) {
        return yield* Effect.fail(new ToolError(`Run not found: ${runId}`));
      }
      return executed(
        formatConversation([], {
          totalMessages: 0,
          metadata: ['Returned message interval: [0, 0)', 'Next offset: none'],
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
        `Returned message interval: [${pageStart}, ${pageEnd})`,
        `Next offset: ${pageEnd < conversation.length ? pageEnd : 'none'}`,
      ],
    });

    return executed(output);
  },
);

const listFiles = Effect.fn('ExecutionsTool.listFiles')(function* (
  runId: RunId,
) {
  const { storage } = yield* SessionRoots;
  const files = yield* listRunGeneratedFiles(runId, storage);
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
  viewRange?: readonly [number, number],
) {
  const displayPath = `/executions/${runId}/files/${filePath}`;
  yield* assertNoParentTraversal(filePath);
  const fullPath = yield* findExistingRunStoragePathUnder(
    (yield* SessionRoots).storage,
    runId,
    filePath,
  );
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
    const records = getRunRecords(runId);
    const [record, paths] = yield* Effect.all(
      [records.readRunRecord(), records.readWorkspaceFiles()],
      { concurrency: 2 },
    );
    const entries = yield* listRunWorkspaceFiles(record, paths);

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
    viewRange?: readonly [number, number],
  ) {
    const records = getRunRecords(runId);
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
  scriptReturns:
    '{ columns: string[]; rows: (string | number | null)[][]; more: boolean } | ToolOutput',
  description: `View run history and manage live runs.

Paths:
${EXECUTION_PATH_LIST}

Use "current" as {id} to access the active run.
Use offset/limit to paginate the /executions listing or conversation messages (default: offset 0, limit 100).
Use view_range: [start, end] to paginate file and background-command output content.
Use action: "wait" on /executions or /executions/{id} to wait for a status change instead of polling.
Use action: "wait" with ids: ["id1", "id2", ...] on /executions to wait for any of the listed runs to change.
Use action: "kill" on /executions/{id} to terminate a live run.
Use action: "send" with message on /executions/{id} to message any other run in this project: your subagent (a follow-up it continues from), your orchestrator, a sibling, or any other run. It reads the message after its current turn; an idle or ended run wakes to read it. A run that takes none (a headless one-shot run, a background command, an agent-CLI turn) refuses it.
Use action: "query" with sql on /executions to ask any question of this project's run history in one read-only SQLite statement (bind values with ? and params). In a script, query returns { columns, rows, more }; other actions return { output, summary }. Queries return at most 200 rows and refuse a JSON page larger than 4 MiB; use LIMIT or substr() to narrow it. Children: SELECT * FROM runs WHERE parent_id = ?. Views:
${HISTORY_VIEW_SUMMARY}
Delegated subagent and document task results are delivered automatically as follow-up messages. No wait is needed for runs you launched. Use action: "wait" only when you cannot proceed without a status change.`,
  schema: ExecutionsToolInputSchema,
  execute: (input: ExecutionsToolInput) =>
    inRunSession((call) => executeExecutionsTool(call, input)),
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
    viewRange: readonly [number, number] | undefined;
  },
) {
  // A recorded file the user since deleted is an outcome the model reads, not
  // a defect.
  const unreadable = (cause: unknown) =>
    new ToolError(
      `Cannot read ${directoryErrorPath}: ${toErrorMessage(cause)}`,
    );
  const stats = yield* fs.stat(fullPath).pipe(Effect.mapError(unreadable));
  // A symlink to a directory counts, which is what the bitmask probe this
  // replaced answered for: the standard `stat` follows the link.
  if (stats.type === 'Directory') {
    return yield* Effect.fail(
      new ToolError(
        `Path is a directory: ${directoryErrorPath}. Use without trailing path to list.`,
      ),
    );
  }

  const content = yield* readNormalizedFile(fs, fullPath).pipe(
    Effect.mapError(unreadable),
  );
  return formatFileView({
    path: resultPath,
    lines: splitContentLines(content),
    viewRange,
    maxLines: Infinity,
  });
});
