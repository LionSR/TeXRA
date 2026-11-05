/**
 * What a CLI command reads of a project's stored runs: the history listing,
 * one run's records, and what `texra history show` prints. Over the session
 * this process holds when no service holds the project, and over the
 * service's procedures when one does: the CLI opens no store of a project
 * the service drives, as the desktop and the extension open none.
 */
import { Effect, SubscriptionRef } from 'effect';

import type {
  AgentRunListingEntry,
  ExportNode,
  LocalSession,
  RunDeletion,
  RunResult,
  SessionOpenError,
} from '@texra-ai/harness';
import type { AssembleTraceResult } from '@texra-ai/harness/host';
import {
  ensureError,
  type AgentConfig,
  type RunId,
  type RunWorkspaceFile,
} from '@texra-ai/harness/schemas';
import type { ChatExportInput } from '@texra/agent/export/schemas';
import { loadChatExportInput } from '@texra/agent/export/loadChatExportInput';
import type {
  ServiceClient,
  ServiceLink,
} from '@texra/controllers/server/client';
import {
  runLaunchFacts,
  type RunLaunchFacts,
} from '@texra/controllers/server/taskList';

/** What `texra history show` prints of a run beyond its setup. */
export interface CliRunDetail {
  /** Its launch facts; null for a run the view no longer lists. */
  readonly run: RunLaunchFacts | null;
  readonly result: RunResult | null;
  readonly report: string | null;
  /** Its conversation as every conversation view renders it. */
  readonly conversation: readonly ExportNode[];
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

/** What a read of a run the store does not hold answers: fresh each time,
 *  as a caller may hold on to it. */
const noDetail = (): CliRunDetail => ({
  run: null,
  result: null,
  report: null,
  conversation: [],
  workspaceFiles: [],
  resumable: false,
});

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
              runLaunchFacts(view.runs.get(runId)),
            ),
            result: stored.readResult(),
            report: stored.readReport(),
            conversation: stored.readConversation(),
            workspaceFiles: stored.readWorkspaceFiles(),
            resumable: stored.readResumable(),
          },
          { concurrency: 6 },
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
 * call while the link holds no service fails with why (`ServiceLink.away`);
 * a run the service does not hold reads as absent, as the local store
 * answers it.
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
  return {
    listRuns: () => ask((client) => client['tasks.history']({ workspace })),
    exists: (runId) =>
      records(
        (client) =>
          Effect.as(client['task.config']({ workspace, runId }), true),
        false,
      ),
    config: (runId) =>
      records((client) => client['task.config']({ workspace, runId }), null),
    detail: (runId) =>
      records(
        (client) => client['task.detail']({ workspace, runId }),
        noDetail(),
      ),
    exportInput: (runId) =>
      records((client) => client['task.exportInput']({ workspace, runId }), {
        config: null,
        exportInput: null,
      }),
    trace: (runId) =>
      records((client) => client['task.exportTrace']({ workspace, runId }), {
        status: 'config_missing',
      }),
    skills: (runId) =>
      records((client) => client['task.skills']({ workspace, runId }), []),
    // The service's own deletion, with the ownership checks a bulk delete
    // keeps and a single one relaxes.
    deleteRuns: (target) =>
      ask((client) => client['tasks.delete']({ workspace, target })),
  };
}
