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

// v4: journal identity is the content key. Index is only the last matched
// invocation position, so stale v4 journals may legitimately repeat it.
const WORKFLOW_SCRIPT_CHECKPOINT_SCHEMA_VERSION = 4;

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
    const keys = new Set<string>();
    for (const entry of journal) {
      if (keys.has(entry.key)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate workflow journal key ${entry.key}`,
          path: ['journal'],
        });
      }
      keys.add(entry.key);
    }
  });

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
  const raw = await store.read(workflowScriptCheckpointKvKey(checkpointId));
  if (raw === undefined) return null;

  const parsed = WorkflowScriptCheckpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Workflow checkpoint ${checkpointId} is malformed.`, {
      cause: parsed.error,
    });
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
    throw new Error(
      `Workflow checkpoint ${checkpointId} cannot be persisted.`,
      { cause: error },
    );
  }
  await store.write(workflowScriptCheckpointKvKey(checkpointId), persisted);
}

/**
 * Run or resume a workflow script with a durable execution-scoped journal.
 * Completed agent calls are persisted before the script can consume them.
 */
export async function runPersistedWorkflowScript(
  options: PersistedWorkflowScriptRunOptions,
): Promise<WorkflowScriptRunResult> {
  const lockKey = `${options.store.getExecutionId()}:${options.checkpointId}`;
  return checkpointMutex.runExclusive(lockKey, () =>
    runPersistedWorkflowScriptLocked(options),
  );
}

async function runPersistedWorkflowScriptLocked(
  options: PersistedWorkflowScriptRunOptions,
): Promise<WorkflowScriptRunResult> {
  const {
    store,
    checkpointId,
    script: requestedScript,
    args: requestedArgs,
    files: requestedFiles,
    ...runOptions
  } = options;
  const prior = await readWorkflowScriptCheckpoint(store, checkpointId);
  // A named checkpoint outlives one tool call, and callers legitimately
  // evolve the script between attempts (a model retrying after a timeout
  // rarely reproduces its source byte-for-byte). Adopt the requested script
  // and args, keep the journal: an entry replays only on a matching
  // prompt/execution-options hash, so drifted calls re-execute while
  // presentation-only edits, unchanged calls, and calls that merely moved
  // stay free. Keep the key union while this invocation is running so a
  // crash can resume prior branches and newly completed work together. A
  // successful invocation replaces that recovery union with its own bounded
  // journal below.
  const script = requestedScript ?? prior?.script;
  if (script === undefined) {
    throw new Error(
      `Workflow checkpoint ${checkpointId} does not exist; a script is required for the first run.`,
    );
  }
  parseWorkflowScript(script);

  let encodedRequestedArgs: PersistedJsonValue;
  try {
    encodedRequestedArgs = encodeJsonValue(requestedArgs);
  } catch (error) {
    throw new Error(
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

  const journalByKey = new Map(
    (prior?.journal ?? []).map((entry) => [entry.key, entry]),
  );
  const persistCheckpoint = (): Promise<void> =>
    writeWorkflowScriptCheckpoint(store, checkpointId, {
      script,
      args,
      files,
      journal: orderedJournal(journalByKey.values()),
    });

  // Serializes concurrent entry writes. Every entry write is awaited inside
  // the engine's journal commit fence, which is sealed and drained before the
  // run settles, so no write can still be queued once runWorkflowScript
  // returns or throws.
  const writeQueue = new PQueue({ concurrency: 1 });
  const persistEntry = async (entry: WorkflowJournalEntry): Promise<void> => {
    journalByKey.set(entry.key, entry);
    await writeQueue.add(persistCheckpoint);
  };

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
  // Success makes this invocation authoritative. Replace the recovery union
  // atomically so superseded revisions cannot grow the durable cache forever.
  journalByKey.clear();
  for (const entry of result.journal) journalByKey.set(entry.key, entry);
  await persistCheckpoint();
  return result;
}
