/**
 * What a CLI command reads of a project's stored runs: the history listing,
 * one run's records, and what `texra history show` prints. Over the session
 * this process holds when no service holds the project, and over the
 * service's procedures when one does: the CLI opens no store of a project
 * the service drives, as the desktop and the extension open none.
 */
import { Effect, SubscriptionRef } from 'effect';

import {
  Rejected,
  type AgentRunListingEntry,
  type LocalSession,
  type RunDeletion,
  type RunResult,
  type SessionOpenError,
} from '@texra-ai/harness';
import type { AssembleTraceResult } from '@texra-ai/harness/host';
import {
  ensureError,
  RUN_SUBSTATE,
  type AgentConfig,
  type RunId,
  type RunView,
  type RunWorkspaceFile,
} from '@texra-ai/harness/schemas';
import type { ChatExportInput } from '@texra/agent/export/schemas';
import { loadChatExportInput } from '@texra/agent/export/loadChatExportInput';
import type {
  ServiceClient,
  ServiceLink,
} from '@texra/controllers/server/client';

/** The launch facts of a run as its project's view holds them. */
export interface CliRunFacts {
  readonly launchedAt: number;
  readonly parentId: RunId | null;
  readonly description: string | null;
  readonly statusKey: RunView['statusKey'];
  readonly durableOutcome: RunView['durableOutcome'];
  /** A stop rested the run (the fold's paused substate). */
  readonly paused: boolean;
  /** The model the run is on, as the view folds it. */
  readonly model: string | null;
}

/** What `texra history show` prints of a run beyond its setup and its
 *  conversation. */
export interface CliRunDetail {
  /** Null for a run the view no longer lists. */
  readonly run: CliRunFacts | null;
  readonly result: RunResult | null;
  readonly report: string | null;
  readonly workspaceFiles: readonly RunWorkspaceFile[];
  /** Its rows hold a point it continues from. */
  readonly resumable: boolean;
}

/** A run's setup and the input its transcript export reads, each null
 *  when the run has none. */
export interface CliRunExport {
  readonly config: AgentConfig | null;
  readonly exportInput: ChatExportInput | null;
}

export interface CliRunReads {
  /** The runs a person started in the project, newest first. */
  readonly listRuns: () => Effect.Effect<
    readonly AgentRunListingEntry[],
    Error
  >;
  /** Whether the run's `run.start` is still listed. */
  readonly exists: (runId: RunId) => Effect.Effect<boolean, Error>;
  /** The run's saved setup; null for one that saved none. */
  readonly config: (runId: RunId) => Effect.Effect<AgentConfig | null, Error>;
  readonly detail: (runId: RunId) => Effect.Effect<CliRunDetail, Error>;
  readonly exportInput: (runId: RunId) => Effect.Effect<CliRunExport, Error>;
  /** Its exported trace: its display rows and its record. */
  readonly trace: (runId: RunId) => Effect.Effect<AssembleTraceResult, Error>;
  /** The skills its latest step listed. */
  readonly skills: (runId: RunId) => Effect.Effect<readonly string[], Error>;
  /** Delete one run, or every stored run. */
  readonly deleteRuns: (
    target: RunId | 'all',
  ) => Effect.Effect<RunDeletion, Error>;
}

/** What a deletion of a run the service does not hold names: nothing. */
const NO_RUNS: readonly RunId[] = [];

/** The launch facts the detail carries, from the run's view row. */
function runFacts(run: RunView | undefined): CliRunFacts | null {
  return run === undefined
    ? null
    : {
        launchedAt: run.launchedAt,
        parentId: run.parentId,
        description: run.description,
        statusKey: run.statusKey,
        durableOutcome: run.durableOutcome,
        paused: run.substate === RUN_SUBSTATE.PAUSED,
        model: run.model,
      };
}

/** The reads over the session this process holds, opened by the first. */
export function localRunReads(
  session: Effect.Effect<LocalSession, SessionOpenError>,
): CliRunReads {
  const records = <A, E>(
    runId: RunId,
    read: (stored: ReturnType<LocalSession['records']>) => Effect.Effect<A, E>,
  ) => Effect.flatMap(session, (opened) => read(opened.records(runId)));
  return {
    listRuns: () => Effect.flatMap(session, (opened) => opened.listRuns()),
    exists: (runId) => records(runId, (stored) => stored.exists()),
    config: (runId) => records(runId, (stored) => stored.readConfig()),
    detail: (runId) =>
      Effect.flatMap(session, (opened) => {
        const stored = opened.records(runId);
        return Effect.all(
          {
            run: Effect.map(opened.view.read([runId]), (view) =>
              runFacts(view.runs.get(runId)),
            ),
            result: stored.readResult(),
            report: stored.readReport(),
            workspaceFiles: stored.readWorkspaceFiles(),
            resumable: stored.readResumable(),
          },
          { concurrency: 5 },
        );
      }),
    exportInput: (runId) =>
      Effect.flatMap(session, (opened) =>
        Effect.map(
          loadChatExportInput(runId, opened),
          ({ config, exportInput }) => ({ config, exportInput }),
        ),
      ),
    trace: (runId) => records(runId, (stored) => stored.readTrace()),
    skills: (runId) => records(runId, (stored) => stored.readSkills()),
    deleteRuns: (target) =>
      Effect.flatMap(session, (opened) => opened.deleteRuns(target)),
  };
}

/**
 * The reads over the service that holds the project, through `link`. A
 * call while the link holds no service fails with why (`ServiceLink.away`).
 */
export function serviceRunReads(
  link: ServiceLink,
  workspace: string,
): CliRunReads {
  const offline = Effect.flatMap(SubscriptionRef.get(link.away), (reason) =>
    Effect.fail(new Error(`The TeXRA service did not answer: ${reason}`)),
  );
  const ask = <A, E>(
    use: (client: ServiceClient) => Effect.Effect<A, E>,
  ): Effect.Effect<A, Error> =>
    Effect.flatMap(SubscriptionRef.get(link.client), (client) =>
      client === null
        ? offline
        : use(client).pipe(Effect.mapError(ensureError)),
    );
  /** A read of one run's records: a run the service does not hold answers
   *  `absent` instead of failing. */
  const records = <A, E extends { readonly _tag: string }, B>(
    use: (client: ServiceClient) => Effect.Effect<A, E>,
    absent: B,
  ): Effect.Effect<A | B, Error> =>
    Effect.flatMap(SubscriptionRef.get(link.client), (client) =>
      client === null
        ? offline
        : use(client).pipe(
            Effect.catch((error) =>
              error._tag === 'TaskRecordsFailed' &&
              'reason' in error &&
              error.reason === 'unknownRun'
                ? Effect.succeed(absent)
                : Effect.fail(ensureError(error)),
            ),
          ),
    );
  const listRuns = () =>
    ask((client) => client['tasks.history']({ workspace }));
  return {
    listRuns,
    exists: (runId) =>
      records(
        (client) =>
          Effect.as(client['task.config']({ workspace, runId }), true),
        false,
      ),
    config: (runId) =>
      records((client) => client['task.config']({ workspace, runId }), null),
    detail: (runId) =>
      ask((client) => client['task.detail']({ workspace, runId })),
    exportInput: (runId) =>
      records((client) => client['task.exportInput']({ workspace, runId }), {
        config: null,
        exportInput: null,
      }),
    trace: (runId) =>
      ask((client) => client['task.exportTrace']({ workspace, runId })),
    skills: (runId) =>
      ask((client) => client['task.skills']({ workspace, runId })),
    // Each run's deletion is the session's own request, so a run the
    // service still runs is refused as it would be in a window; `all` is
    // every listed task, whose deletion takes its children with it.
    deleteRuns: (target) =>
      Effect.gen(function* () {
        const runIds =
          target === 'all'
            ? (yield* listRuns()).map((entry) => entry.id)
            : yield* records(
                (client) =>
                  Effect.as(
                    client['task.config']({ workspace, runId: target }),
                    [target],
                  ),
                NO_RUNS,
              );
        const deleted: RunId[] = [];
        const failed: RunDeletion['failed'][number][] = [];
        for (const runId of runIds) {
          const removal = yield* Effect.result(
            Effect.flatMap(SubscriptionRef.get(link.client), (client) =>
              client === null
                ? Effect.flatMap(SubscriptionRef.get(link.away), (reason) =>
                    Effect.fail(new Rejected({ reason })),
                  )
                : client['task.request']({
                    workspace,
                    request: { kind: 'run.delete', runId },
                  }).pipe(
                    Effect.mapError((error) =>
                      error._tag === 'RpcClientError'
                        ? new Rejected({
                            reason: `The TeXRA service did not answer: ${error.message}`,
                          })
                        : error,
                    ),
                  ),
            ),
          );
          if (removal._tag === 'Success') deleted.push(runId);
          else failed.push({ runId, error: removal.failure });
        }
        return { listed: runIds.length, deleted, active: [], failed };
      }),
  };
}
