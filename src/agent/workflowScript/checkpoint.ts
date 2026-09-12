/**
 * A workflow script's durable checkpoint: the `workflow-checkpoint` aggregate
 * its runs journal into (runtime on Effect, section 5, PR 4). One
 * `workflow.script` row per invocation carries the source the journal
 * replays against; one `workflow.journal` row per completed `agent()` call
 * carries its result, folded latest per key. A named checkpoint outlives one
 * tool call: a retry after a timeout or an interruption resumes the same
 * aggregate through `run.start.checkpointId`, never through the run's id.
 */
import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  JsonValueSchema,
  WorkflowScriptFilesSchema,
  type PersistedJsonValue,
  type RunId,
  type SessionEvent,
  type WorkflowScriptFiles,
} from '@shared/schemas';
import { truncatedHexId } from '@utils/core/idHash';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { ensureError } from '@utils/errors/errorMessage';

import { parseWorkflowScript } from './parseScript';
import { runWorkflowScript } from './runWorkflowScript';
import type {
  WorkflowJournalEntry,
  WorkflowScriptRunOptions,
  WorkflowScriptRunResult,
} from './types';

/**
 * Named checkpoint identity: `meta.name` plus the default agent under one
 * parent run owns one durable journal. A retry after a timeout or
 * interruption resumes that journal even when the model rewrites the script
 * (models rarely reproduce source byte-for-byte); safety lives in the journal
 * itself, whose entries replay only on a matching prompt/options hash key —
 * a changed call re-executes, while an unchanged call is free to move.
 * A script that must re-execute everything from scratch needs a new
 * meta.name.
 */
export function deriveWorkflowScriptCheckpointId(identity: {
  readonly name: string;
  readonly defaultAgent: string;
  readonly parentRunId: string;
}): string {
  // Key order is part of the persisted identity: keep it alphabetical, the
  // order the original stable-stringify derivation produced.
  return truncatedHexId(
    JSON.stringify({
      defaultAgent: identity.defaultAgent,
      name: identity.name,
      parentRunId: identity.parentRunId,
    }),
    32,
  );
}

const checkpointAggregate = (checkpointId: string) =>
  aggregateId('workflow-checkpoint', checkpointId);

/**
 * One in-process serial lane per checkpoint id. The aggregate claim fences
 * other processes, not fibers of this one: they share its owner id, so two
 * overlapping invocations of the same checkpoint would both take the claim,
 * both read the journal before either commits, and both re-execute the same
 * `agent()` calls. The lane makes read-prior, run, and journal one operation
 * per checkpoint, so the second invocation resumes the first's journal.
 */
const checkpointLanes = new Map<string, PerKeyLane>();

export interface WorkflowScriptCheckpoint {
  readonly script: string;
  readonly args: unknown;
  readonly files: WorkflowScriptFiles;
  readonly journal: WorkflowJournalEntry[];
}

export interface PersistedWorkflowScriptRunOptions<R = never> extends Omit<
  WorkflowScriptRunOptions<R>,
  'script' | 'journal' | 'onJournalEntry'
> {
  /** The session whose event table holds the checkpoint aggregate. */
  session: SessionHandle;
  /** Stable identity, normally derived from `meta.name` under the parent. */
  checkpointId: string;
  /** The run that invoked this workflow — the same id `checkpointId` is
   *  derived from. The checkpoint aggregate hangs under it, so removing that
   *  run collects the journal instead of leaving it unreachable. */
  parentRunId: RunId;
  /** Omit only when resuming the script already stored at checkpointId. */
  script?: string;
}

function encodeJsonValue(value: unknown): PersistedJsonValue {
  return value === undefined
    ? { kind: 'undefined' }
    : { kind: 'json', value: JsonValueSchema.parse(value) };
}

function decodeJsonValue(value: PersistedJsonValue): unknown {
  return value.kind === 'undefined' ? undefined : value.value;
}

/**
 * Fold one checkpoint's rows: the latest script row and the journal, latest
 * per key, in index order. No script row is absence; journal rows without one
 * are a malformed aggregate and fail rather than fold to an empty journal.
 */
function foldWorkflowScriptCheckpoint(
  checkpointId: string,
  rows: readonly SessionEvent[],
): WorkflowScriptCheckpoint | null {
  let script: Extract<SessionEvent, { type: 'workflow.script' }> | null = null;
  const journalByKey = new Map<string, WorkflowJournalEntry>();
  for (const row of rows) {
    if (row.type === 'workflow.script') {
      script = row;
    } else if (row.type === 'workflow.journal') {
      journalByKey.set(row.key, {
        index: row.index,
        key: row.key,
        result: decodeJsonValue(row.result),
      });
    }
  }
  if (script === null) {
    if (journalByKey.size > 0) {
      throw new Error(
        `Workflow checkpoint ${checkpointId} has journal rows without a script row.`,
      );
    }
    return null;
  }
  return {
    script: script.script,
    args: decodeJsonValue(script.args),
    files: script.files,
    journal: [...journalByKey.values()].toSorted((a, b) => a.index - b.index),
  };
}

/** Read one checkpoint. Absence is null; a malformed aggregate fails. */
export function readWorkflowScriptCheckpoint(
  session: SessionHandle,
  checkpointId: string,
): Effect.Effect<WorkflowScriptCheckpoint | null, Error> {
  return session.readAggregate(checkpointAggregate(checkpointId)).pipe(
    Effect.flatMap((rows) =>
      Effect.try({
        try: () => foldWorkflowScriptCheckpoint(checkpointId, rows),
        catch: ensureError,
      }),
    ),
  );
}

/**
 * Run or resume a workflow script against its durable journal. Every
 * completed `agent()` call is a committed row before the script can consume
 * it: the engine awaits `onJournalEntry` inside its journal commit fence,
 * which is sealed and drained before the run settles. The whole invocation
 * takes its checkpoint's lane, so overlapping calls on one id run in order
 * rather than replaying the same journal twice.
 */
export function runPersistedWorkflowScript<R = never>(
  options: PersistedWorkflowScriptRunOptions<R>,
): Effect.Effect<WorkflowScriptRunResult, Error, R> {
  return Effect.gen(function* () {
    const {
      session,
      checkpointId,
      parentRunId,
      script: requestedScript,
      args: requestedArgs,
      files: requestedFiles,
      ...runOptions
    } = options;
    const target = checkpointAggregate(checkpointId);
    // Existence alone decides the claim step; nothing is derived from this
    // read. An aggregate that exists has its claim taken over, one that does
    // not is claimed by the script row the run body commits — and a process
    // that creates it in this gap owns it, so that commit is refused rather
    // than written behind its back.
    const exists =
      (yield* readWorkflowScriptCheckpoint(session, checkpointId)) !== null;

    // The process that first journals into a checkpoint claims its aggregate
    // (C5); a relaunch from another process takes the claim over after proving
    // that owner dead, and a live owner refuses it, so two processes never
    // journal one checkpoint at once (fibers of this one are held apart by the
    // lane this call runs on). The claim belongs to the invocation, not
    // to the process: it is released on success, failure and interruption, so a
    // finished workflow leaves the journal free for the next process to resume
    // instead of holding it until this one exits.
    return yield* Effect.acquireUseRelease(
      exists ? Effect.asVoid(session.acquireClaims(target)) : Effect.void,
      () =>
        Effect.gen(function* () {
          // The journal is read under the claim: a process that finished this
          // checkpoint and released it just now has committed every entry it
          // journaled before this read, so nothing it already did is replayed.
          const prior = yield* readWorkflowScriptCheckpoint(
            session,
            checkpointId,
          );
          // A named checkpoint outlives one tool call, and callers legitimately
          // evolve the script between attempts (a model retrying after a
          // timeout rarely reproduces its source byte-for-byte). Adopt the
          // requested script and args, keep the journal: an entry replays only
          // on a matching prompt/run-options hash, so drifted calls re-execute
          // while presentation-only edits, unchanged calls, and calls that
          // merely moved stay free. The aggregate keeps every key it has ever
          // journaled: a crash resumes prior branches and newly completed work
          // together.
          const script = requestedScript ?? prior?.script;
          if (script === undefined) {
            return yield* Effect.fail(
              new Error(
                `Workflow checkpoint ${checkpointId} does not exist; a script is required for the first run.`,
              ),
            );
          }
          yield* Effect.try({
            try: () => parseWorkflowScript(script),
            catch: ensureError,
          });
          const encodedRequestedArgs = yield* Effect.try({
            try: () => encodeJsonValue(requestedArgs),
            catch: (error) =>
              new Error(
                `Workflow checkpoint ${checkpointId} arguments cannot be persisted.`,
                { cause: error },
              ),
          });
          const args =
            Object.hasOwn(options, 'args') || prior === null
              ? decodeJsonValue(encodedRequestedArgs)
              : prior.args;
          const files =
            Object.hasOwn(options, 'files') || prior === null
              ? yield* Effect.try({
                  try: () =>
                    WorkflowScriptFilesSchema.parse(requestedFiles ?? {}),
                  catch: ensureError,
                })
              : prior.files;
          // The script row lands before the run, so the journal always has the
          // source it replays against, and it is the row that hangs the
          // aggregate under the invoking run (deletion cascades from there).
          yield* session
            .commit([
              {
                type: 'workflow.script',
                aggregateId: target,
                parentRunId,
                script,
                args: encodeJsonValue(args),
                files,
              },
            ])
            .pipe(
              Effect.mapError(
                (cause) =>
                  new Error(
                    `Workflow checkpoint ${checkpointId} cannot be persisted.`,
                    {
                      cause,
                    },
                  ),
              ),
            );
          // The engine's callbacks each carry their session explicitly (the agent
          // runner frames its own run context; snapshots and journal rows publish
          // through the handle), so no ambient session frame wraps this call.
          return yield* runWorkflowScript({
            ...runOptions,
            script,
            args,
            files,
            journal: prior?.journal,
            // `...runOptions` carries the caller's own `onSnapshot`: snapshots
            // belong to the detached run that owns their writes, while this
            // checkpoint belongs to its orchestrator.
            onJournalEntry: (entry) =>
              Effect.gen(function* () {
                // The session's ordered publisher, awaited to durability: a
                // refused or failed append rejects here and the engine fails the
                // run with a checkpoint fault rather than exposing the result to
                // the script.
                session.publish([
                  {
                    type: 'workflow.journal',
                    aggregateId: target,
                    key: entry.key,
                    index: entry.index,
                    result: encodeJsonValue(entry.result),
                  },
                ]);
                yield* Effect.tryPromise({
                  try: () => session.settlePublications(),
                  catch: ensureError,
                });
              }),
          });
        }),
      // A release that fails leaves the claim standing: the next process reads
      // it as a live owner and refuses, so the invocation fails with it. The
      // journal is already durable, so the caller loses no work by hearing
      // that the checkpoint is still owned.
      () =>
        session
          .releaseClaims(target)
          .pipe(
            Effect.mapError(
              (cause) =>
                new Error(
                  `Workflow checkpoint ${checkpointId} claim was not released.`,
                  { cause },
                ),
            ),
          ),
    );
  }).pipe(withPerKeyLane(checkpointLanes, options.checkpointId));
}
