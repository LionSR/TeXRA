// Third-party imports
import PQueue from 'p-queue';
import { z } from 'zod';

// Local imports - storage
import type { ExecutionKVStore } from '@agent/storage/ExecutionKVStore';
import {
  JsonValueSchema,
  type WorkflowScriptFiles,
  WorkflowScriptFilesSchema,
} from '@shared/schemas';
import { KeyedMutex } from '@utils/core';

// Local imports - workflow script
import { workflowScriptCheckpointKvKey } from './checkpointKey';
import { parseWorkflowScript } from './parseScript';
import { runWorkflowScript } from './runWorkflowScript';
import {
  type WorkflowJournalEntry,
  type WorkflowScriptRunOptions,
  type WorkflowScriptRunResult,
} from './types';

const WORKFLOW_SCRIPT_CHECKPOINT_SCHEMA_VERSION = 3;

const PersistedJsonValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('undefined') }),
  z.strictObject({ kind: z.literal('json'), value: JsonValueSchema }),
]);

const PersistedWorkflowJournalEntrySchema = z.strictObject({
  index: z.int().nonnegative(),
  key: z.string().regex(/^[a-f0-9]{16}$/),
  result: PersistedJsonValueSchema,
});

const WorkflowScriptCheckpointSchema = z
  .strictObject({
    schemaVersion: z.literal(WORKFLOW_SCRIPT_CHECKPOINT_SCHEMA_VERSION),
    script: z.string().min(1),
    args: PersistedJsonValueSchema,
    files: WorkflowScriptFilesSchema,
    journal: z.array(PersistedWorkflowJournalEntrySchema),
  })
  .superRefine(({ journal }, context) => {
    const indices = new Set<number>();
    for (const entry of journal) {
      if (indices.has(entry.index)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate workflow journal index ${entry.index}`,
          path: ['journal'],
        });
      }
      indices.add(entry.index);
    }
  });

const CheckpointIdSchema = z.string().min(1).max(256);

type PersistedJsonValue = z.infer<typeof PersistedJsonValueSchema>;

type PersistedWorkflowJournalEntry = z.infer<
  typeof PersistedWorkflowJournalEntrySchema
>;

export interface WorkflowScriptCheckpoint {
  readonly script: string;
  readonly args: unknown;
  readonly files: WorkflowScriptFiles;
  readonly journal: WorkflowJournalEntry[];
}

export class WorkflowScriptPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkflowScriptPersistenceError';
  }
}

function parseCheckpointId(checkpointId: string): string {
  const parsed = CheckpointIdSchema.safeParse(checkpointId);
  if (parsed.success) return parsed.data;
  throw new WorkflowScriptPersistenceError(
    'Workflow checkpoint id must be a non-empty string of at most 256 characters.',
    { cause: parsed.error },
  );
}

export interface PersistedWorkflowScriptRunOptions extends Omit<
  WorkflowScriptRunOptions,
  'script' | 'journal' | 'onJournalEntry'
> {
  /** Execution-scoped KV store that owns this invocation's checkpoint. */
  store: ExecutionKVStore;
  /** Stable identity, normally the parent tool call id. */
  checkpointId: string;
  /** Omit only when resuming the script already stored at checkpointId. */
  script?: string;
}

// An execution is owned by one active runtime host. This lock prevents two
// callers in that host from racing the same checkpoint; execution KV is not a
// distributed coordination service between separate TeXRA processes.
const checkpointMutex = new KeyedMutex<string>();

function encodeJsonValue(value: unknown): PersistedJsonValue {
  return value === undefined
    ? { kind: 'undefined' }
    : { kind: 'json', value: JsonValueSchema.parse(value) };
}

function decodeJsonValue(value: PersistedJsonValue): unknown {
  return value.kind === 'undefined' ? undefined : value.value;
}

function encodeJournalEntry(
  entry: WorkflowJournalEntry,
): PersistedWorkflowJournalEntry {
  return {
    index: entry.index,
    key: entry.key,
    result: encodeJsonValue(entry.result),
  };
}

function decodeJournalEntry(
  entry: PersistedWorkflowJournalEntry,
): WorkflowJournalEntry {
  return {
    index: entry.index,
    key: entry.key,
    result: decodeJsonValue(entry.result),
  };
}

function orderedJournal(
  entries: Iterable<WorkflowJournalEntry>,
): WorkflowJournalEntry[] {
  return [...entries].toSorted((a, b) => a.index - b.index);
}

/** Read one checkpoint. Absence returns null; malformed data fails. */
export async function readWorkflowScriptCheckpoint(
  store: ExecutionKVStore,
  checkpointId: string,
): Promise<WorkflowScriptCheckpoint | null> {
  const id = parseCheckpointId(checkpointId);
  const raw = await store.read(workflowScriptCheckpointKvKey(id));
  if (raw === undefined) return null;

  const parsed = WorkflowScriptCheckpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowScriptPersistenceError(
      `Workflow checkpoint ${id} is malformed.`,
      { cause: parsed.error },
    );
  }
  const checkpoint = parsed.data;
  return {
    script: checkpoint.script,
    args: decodeJsonValue(checkpoint.args),
    files: checkpoint.files,
    journal: orderedJournal(checkpoint.journal.map(decodeJournalEntry)),
  };
}

/** Atomically replace the script, arguments, and journal for one invocation. */
export async function writeWorkflowScriptCheckpoint(
  store: ExecutionKVStore,
  checkpointId: string,
  checkpoint: WorkflowScriptCheckpoint,
): Promise<void> {
  const id = parseCheckpointId(checkpointId);
  let persisted: z.infer<typeof WorkflowScriptCheckpointSchema>;
  try {
    persisted = WorkflowScriptCheckpointSchema.parse({
      schemaVersion: WORKFLOW_SCRIPT_CHECKPOINT_SCHEMA_VERSION,
      script: checkpoint.script,
      args: encodeJsonValue(checkpoint.args),
      files: checkpoint.files,
      journal: orderedJournal(checkpoint.journal).map(encodeJournalEntry),
    });
  } catch (error) {
    throw new WorkflowScriptPersistenceError(
      `Workflow checkpoint ${id} cannot be persisted.`,
      { cause: error },
    );
  }
  await store.write(workflowScriptCheckpointKvKey(id), persisted);
}

/**
 * Run or resume a workflow script with a durable execution-scoped journal.
 * Completed agent calls are persisted before the script can consume them.
 */
export async function runPersistedWorkflowScript(
  options: PersistedWorkflowScriptRunOptions,
): Promise<WorkflowScriptRunResult> {
  const checkpointId = parseCheckpointId(options.checkpointId);
  const lockKey = `${options.store.getExecutionId()}:${checkpointId}`;
  return checkpointMutex.runExclusive(lockKey, () =>
    runPersistedWorkflowScriptLocked(options, checkpointId),
  );
}

async function runPersistedWorkflowScriptLocked(
  options: PersistedWorkflowScriptRunOptions,
  checkpointId: string,
): Promise<WorkflowScriptRunResult> {
  const {
    store,
    checkpointId: _checkpointId,
    script: requestedScript,
    args: requestedArgs,
    files: requestedFiles,
    ...runOptions
  } = options;
  const prior = await readWorkflowScriptCheckpoint(store, checkpointId);
  // A named checkpoint outlives one tool call, and callers legitimately
  // evolve the script between attempts (a model retrying after a timeout
  // rarely reproduces its source byte-for-byte). Adopt the requested script
  // and args, keep the journal: an entry replays only on a matching call
  // index and prompt/execution-options hash, so drifted calls re-execute
  // while presentation-only edits and unchanged calls stay free.
  const script = requestedScript ?? prior?.script;
  if (script === undefined) {
    throw new WorkflowScriptPersistenceError(
      `Workflow checkpoint ${checkpointId} does not exist; a script is required for the first run.`,
    );
  }
  parseWorkflowScript(script);

  let encodedRequestedArgs: PersistedJsonValue;
  try {
    encodedRequestedArgs = encodeJsonValue(requestedArgs);
  } catch (error) {
    throw new WorkflowScriptPersistenceError(
      `Workflow checkpoint ${checkpointId} arguments cannot be persisted.`,
      { cause: error },
    );
  }
  const args =
    Object.hasOwn(options, 'args') || prior === null
      ? decodeJsonValue(encodedRequestedArgs)
      : prior.args;
  const files =
    Object.hasOwn(options, 'files') || prior === null
      ? WorkflowScriptFilesSchema.parse(requestedFiles ?? {})
      : prior.files;

  const journalByIndex = new Map(
    (prior?.journal ?? []).map((entry) => [entry.index, entry]),
  );
  const persistCheckpoint = (): Promise<void> =>
    writeWorkflowScriptCheckpoint(store, checkpointId, {
      script,
      args,
      files,
      journal: orderedJournal(journalByIndex.values()),
    });

  let acceptingEntries = true;
  const writeQueue = new PQueue({ concurrency: 1 });
  const persistEntry = async (entry: WorkflowJournalEntry): Promise<void> => {
    if (!acceptingEntries) return;
    journalByIndex.set(entry.index, entry);
    await writeQueue.add(persistCheckpoint);
  };

  try {
    // Establish the checkpoint once before execution. Snapshot transitions are
    // persisted separately and never rewrite script or journal metadata.
    await persistCheckpoint();
    const result = await runWorkflowScript({
      ...runOptions,
      script,
      args,
      files,
      journal: prior?.journal,
      // `...runOptions` carries the caller's own `onSnapshot`: snapshots
      // belong to the detached execution that owns their writes, while this
      // checkpoint store may belong to its orchestrator.
      onJournalEntry: persistEntry,
    });
    acceptingEntries = false;
    for (const entry of result.journal) journalByIndex.set(entry.index, entry);
    await writeQueue.onIdle();
    await persistCheckpoint();
    return result;
  } catch (error) {
    acceptingEntries = false;
    // L2 cleanup: each journal write is awaited by the engine before it can
    // continue, so this rejection is the error already leaving the run.
    // `onIdle` never rejects, so draining here can't produce a duplicate
    // unhandled-rejection report.
    await writeQueue.onIdle();
    throw error;
  }
}
