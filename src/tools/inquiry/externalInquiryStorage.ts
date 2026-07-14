import * as path from 'node:path';

import { Mutex } from 'async-mutex';
import { z } from 'zod';

import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { createChannelTrace } from '@agent/trace';
import { isFileNotFoundError } from '@common/errors';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  ExternalInquirySessionLinksSchema,
  ExternalInquiryThreadIdSchema,
  InquiryDraftSchema,
  type InquiryTranscriptTurn,
  StreamTabIdSchema,
  type ExternalInquiryThreadId,
  type ExternalInquiryThreadSummary,
  type InquiryDraft,
  type InquiryThreadStatus,
} from '@shared/schemas';
import { ToolError } from '@shared/schemas/toolResult';
import {
  isObject,
  toNewestFirstByTimestamp,
  unique,
  hexId12,
  normalizeFilePath,
} from '@utils/core';
import { GlobalStorageFS, StorageFS } from '@utils/files';
import { isDirectory, isFile } from '@utils/files/fsEntryType';

const THREADS_DIR = 'ei_threads';
const EXEC_DIR = 'ei';
const QUESTION_PREVIEW_CHARS = 200;
const logger = createChannelTrace('ExternalInquiryStorage');

// ============================================================================
// Schemas
// ============================================================================

/**
 * Fields every inquiry turn carries regardless of lifecycle state —
 * including dispatch metadata (`suggestSearch`/`attachFiles`) which is
 * persisted so the panel re-renders identically after reload, whether
 * or not the turn has since been answered.
 */
const InquiryTurnBaseShape = {
  turnIndex: z.int().positive(),
  timestamp: z.string().min(1),
  question: z.string(),
  context: z.string().nullish(),
  questionRelativePath: z.string().min(1),
  contextRelativePath: z.string().nullish(),
  suggestSearch: z.boolean().nullish(),
  attachFiles: z.array(z.string()).nullish(),
};

/** Awaiting a user answer. Only state that carries a panel draft. */
const OpenInquiryTurnSchema = z.object({
  ...InquiryTurnBaseShape,
  kind: z.literal('open'),
  draft: InquiryDraftSchema.nullish(),
});
export type OpenInquiryTurn = z.infer<typeof OpenInquiryTurnSchema>;

/** Answer recorded and available inline — the steady-state "done" shape. */
const AnsweredInquiryTurnSchema = z.object({
  ...InquiryTurnBaseShape,
  kind: z.literal('answered'),
  answer: z.string(),
  answeredAt: z.string().min(1),
  answerRelativePath: z.string().min(1),
  sessionLinks: ExternalInquirySessionLinksSchema.nullish(),
});
export type AnsweredInquiryTurn = z.infer<typeof AnsweredInquiryTurnSchema>;

/**
 * Legacy single-shot turn whose answer text still lives only on disk
 * (`answerRelativePath`) and hasn't been hydrated into `answer` yet.
 * `hydrateAnswersFromDisk` (invoked from `readExternalInquiryThread`)
 * always attempts to promote these to `answered` on read; this variant
 * only survives when the on-disk answer file is itself unreadable or
 * missing (see the catch in `hydrateAnswersFromDisk`).
 */
const AnsweredUnhydratedInquiryTurnSchema = z.object({
  ...InquiryTurnBaseShape,
  kind: z.literal('answeredUnhydrated'),
  answerRelativePath: z.string().min(1),
  answeredAt: z.string().nullish(),
  sessionLinks: ExternalInquirySessionLinksSchema.nullish(),
});
export type AnsweredUnhydratedInquiryTurn = z.infer<
  typeof AnsweredUnhydratedInquiryTurnSchema
>;

const CanonicalTurnRecordSchema = z.discriminatedUnion('kind', [
  OpenInquiryTurnSchema,
  AnsweredInquiryTurnSchema,
  AnsweredUnhydratedInquiryTurnSchema,
]);
export type ExternalInquiryTurnRecord = z.infer<
  typeof CanonicalTurnRecordSchema
>;

/**
 * Raw, untagged shape turns were persisted in prior to this discriminated
 * union — every lifecycle field is nullable and there is no `kind`. Parsing
 * always goes through this shape first so historical manifest.json files
 * (which never wrote `kind`) keep loading; `toCanonicalTurn` below is the
 * single, centralized place that infers the lifecycle state from field
 * presence, replacing the ad hoc `turn.answer`/`turn.answerRelativePath`
 * probes that used to be scattered across this module's consumers.
 */
const RawTurnShape = {
  ...InquiryTurnBaseShape,
  answerRelativePath: z.string().nullish(),
  sessionLinks: ExternalInquirySessionLinksSchema.nullish(),
  answer: z.string().nullish(),
  answeredAt: z.string().nullish(),
  draft: InquiryDraftSchema.nullish(),
};

function toCanonicalTurn(
  raw: z.infer<typeof RawTurnRecordSchema>,
): ExternalInquiryTurnRecord {
  const base = {
    turnIndex: raw.turnIndex,
    timestamp: raw.timestamp,
    question: raw.question,
    context: raw.context ?? undefined,
    questionRelativePath: raw.questionRelativePath,
    contextRelativePath: raw.contextRelativePath ?? undefined,
    suggestSearch: raw.suggestSearch ?? undefined,
    attachFiles: raw.attachFiles ?? undefined,
  };

  if (raw.answer != null) {
    return {
      ...base,
      kind: 'answered',
      answer: raw.answer,
      answeredAt: raw.answeredAt || raw.timestamp,
      answerRelativePath:
        raw.answerRelativePath ||
        normalizeFilePath(path.join(turnDir(raw.turnIndex), 'answer.txt')),
      sessionLinks: raw.sessionLinks ?? undefined,
    };
  }

  if (raw.answerRelativePath) {
    return {
      ...base,
      kind: 'answeredUnhydrated',
      answerRelativePath: raw.answerRelativePath,
      answeredAt: raw.answeredAt || undefined,
      sessionLinks: raw.sessionLinks ?? undefined,
    };
  }

  return {
    ...base,
    kind: 'open',
    draft: raw.draft ?? undefined,
  };
}

const RawTurnRecordSchema = z.looseObject(RawTurnShape);
const ExternalInquiryTurnRecordSchema =
  RawTurnRecordSchema.transform(toCanonicalTurn);

const EXTERNAL_INQUIRY_MANIFEST_SCHEMA_VERSION = 1;

const ManifestBaseShape = {
  /** Stamped on every write; absent on manifests written before it existed. */
  schemaVersion: z
    .literal(EXTERNAL_INQUIRY_MANIFEST_SCHEMA_VERSION)
    .prefault(EXTERNAL_INQUIRY_MANIFEST_SCHEMA_VERSION),
  threadId: ExternalInquiryThreadIdSchema,
  parentStreamId: StreamTabIdSchema.nullable(),
  status: z.enum(['open', 'answered', 'dropped']),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  turns: z.array(ExternalInquiryTurnRecordSchema),
};

/**
 * New canonical manifest form: explicit `status` + `parentStreamId`.
 */
const CanonicalManifestSchema = z.looseObject(ManifestBaseShape);

/**
 * Legacy form: pre-async manifest with no `status` or `parentStreamId`.
 * Every turn was atomic Q+A (both `question` and `answer` recorded), so we
 * treat the whole thread as `answered` with no parent (continuation off).
 *
 * Legacy predates versioning, so this arm only accepts version-ABSENT data:
 * a manifest that carries any `schemaVersion` (even the current one, on a
 * shape the canonical arm rejected) is corrupt/unsupported, never legacy.
 */
const LegacyManifestSchema = z
  .looseObject({
    schemaVersion: z.undefined().optional(),
    threadId: ExternalInquiryThreadIdSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    turns: z.array(ExternalInquiryTurnRecordSchema),
  })
  .transform((raw): ExternalInquiryThreadManifest => ({
    schemaVersion: EXTERNAL_INQUIRY_MANIFEST_SCHEMA_VERSION,
    threadId: raw.threadId,
    parentStreamId: null,
    status: 'answered' as const,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    turns: raw.turns,
  }));

/**
 * Entry-point schema: try canonical (new format) first, then legacy.
 */
const ExternalInquiryThreadManifestSchema = z.union([
  CanonicalManifestSchema,
  LegacyManifestSchema,
]);
export type ExternalInquiryThreadManifest = z.infer<
  typeof CanonicalManifestSchema
>;

// ============================================================================
// Mirror types
// ============================================================================

export interface ExternalInquiryExecutionMirrorPaths {
  executionId: ExecutionId;
  manifestPath: string;
  questionPath: string;
  contextPath?: string;
  answerPath: string;
}

export interface ExternalInquiryThreadMirrorPaths {
  executionId: ExecutionId;
  threadPath: string;
  manifestPath: string;
}

export interface PersistedOpenTurn {
  threadId: ExternalInquiryThreadId;
  manifest: ExternalInquiryThreadManifest;
  turn: OpenInquiryTurn;
}

export interface PersistedAnsweredTurn {
  threadId: ExternalInquiryThreadId;
  manifest: ExternalInquiryThreadManifest;
  turn: AnsweredInquiryTurn;
  executionMirrorPaths?: ExternalInquiryExecutionMirrorPaths;
}

// ============================================================================
// Per-thread write lock
// ============================================================================

const threadMutexes = new Map<string, Mutex>();

function getThreadMutex(threadId: string): Mutex {
  let mutex = threadMutexes.get(threadId);
  if (!mutex) {
    mutex = new Mutex();
    threadMutexes.set(threadId, mutex);
  }
  return mutex;
}

// Thread IDs are freshly minted per thread, so the Map would otherwise grow
// without bound. Evict after each critical section once no waiters remain.
async function withThreadLock<T>(
  threadId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const mutex = getThreadMutex(threadId);
  try {
    return await mutex.runExclusive(fn);
  } finally {
    if (!mutex.isLocked()) threadMutexes.delete(threadId);
  }
}

// ============================================================================
// Path helpers
// ============================================================================

function turnDir(turnIndex: number): string {
  return `t${turnIndex}`;
}

function threadDir(threadId: ExternalInquiryThreadId): string {
  return path.join(THREADS_DIR, threadId);
}

function threadManifestPath(threadId: ExternalInquiryThreadId): string {
  return path.join(threadDir(threadId), 'manifest.json');
}

function threadTurnDir(
  threadId: ExternalInquiryThreadId,
  turnIndex: number,
): string {
  return path.join(threadDir(threadId), turnDir(turnIndex));
}

/**
 * Hydrate inline `answer` from disk for any turn still tagged
 * `answeredUnhydrated`. Legacy single-shot manifests stored the answer
 * text only on disk; the canonical `answered` shape carries it inline so
 * renderers don't need a second read.
 */
async function hydrateAnswersFromDisk(
  threadId: ExternalInquiryThreadId,
  manifest: ExternalInquiryThreadManifest,
): Promise<{
  manifest: ExternalInquiryThreadManifest;
  didHydrate: boolean;
}> {
  let didHydrate = false;
  const turns = await Promise.all(
    manifest.turns.map(async (turn): Promise<ExternalInquiryTurnRecord> => {
      if (turn.kind !== 'answeredUnhydrated') return turn;
      try {
        const content = await GlobalStorageFS.read(
          path.join(threadDir(threadId), turn.answerRelativePath),
        );
        didHydrate = true;
        return {
          ...turn,
          kind: 'answered',
          answer: content,
          answeredAt: turn.answeredAt || manifest.updatedAt,
        };
      } catch {
        // Answer file unreadable/missing — leave the turn unhydrated (benign:
        // the manifest still loads, the answer is simply not inlined yet).
        return turn;
      }
    }),
  );
  return { manifest: { ...manifest, turns }, didHydrate };
}

/**
 * Loud read (#6966 bullet 5): a missing manifest is the expected "no such
 * thread" case, but a corrupt/unparseable one is a real failure that must
 * not be silently conflated with it — every consumer here treats `null` as
 * "not found" and none of them writes the manifest back on that path, so a
 * warning (rather than a default that later gets persisted) is the correct
 * ceiling. Distinguishes `isFileNotFoundError` from read/parse failures per
 * the #7210 pattern.
 */
async function readThreadManifest(
  threadId: ExternalInquiryThreadId,
): Promise<ExternalInquiryThreadManifest | null> {
  let raw: unknown;
  try {
    raw = await GlobalStorageFS.readJson<unknown>(threadManifestPath(threadId));
  } catch (err) {
    if (!isFileNotFoundError(err)) {
      logger.warn(
        `Unreadable external-inquiry manifest for ${threadId}; treating as missing.`,
        { data: err },
      );
    }
    return null;
  }
  // Version discrimination happens BEFORE shape validation: a manifest that
  // carries a schemaVersion we don't know (e.g. written by a newer TeXRA) is
  // unsupported data, not a shape to reinterpret — without this gate it would
  // fail the canonical union arm and fall through to a bogus legacy parse.
  // Warn and treat as unreadable; the on-disk file is left untouched.
  if (
    isObject(raw) &&
    'schemaVersion' in raw &&
    raw.schemaVersion !== EXTERNAL_INQUIRY_MANIFEST_SCHEMA_VERSION
  ) {
    logger.warn(
      `Unsupported external-inquiry manifest schemaVersion ` +
        `${JSON.stringify(raw.schemaVersion)} for ${threadId}; ` +
        `treating as unreadable.`,
      { data: raw.schemaVersion },
    );
    return null;
  }
  const result = ExternalInquiryThreadManifestSchema.safeParse(raw);
  if (!result.success) {
    logger.warn(
      `Failed to parse external-inquiry manifest for ${threadId}; treating as missing.`,
      { data: result.error },
    );
    return null;
  }
  return result.data;
}

async function writeThreadManifest(
  manifest: ExternalInquiryThreadManifest,
): Promise<void> {
  await GlobalStorageFS.ensureDir(threadDir(manifest.threadId));
  await GlobalStorageFS.writeAtomic(
    threadManifestPath(manifest.threadId),
    JSON.stringify(manifest, null, 2),
  );
}

// ============================================================================
// Execution mirroring (unchanged)
// ============================================================================

async function copyGlobalDirectoryToExecution(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  await StorageFS.ensureDir(targetDir);
  const entries = await GlobalStorageFS.readDir(sourceDir);

  for (const [name, type] of entries) {
    const sourcePath = path.join(sourceDir, name);
    const targetPath = path.join(targetDir, name);

    if (isDirectory(type)) {
      await copyGlobalDirectoryToExecution(sourcePath, targetPath);
      continue;
    }

    if (isFile(type)) {
      const bytes = await GlobalStorageFS.readBytes(sourcePath);
      await StorageFS.write(targetPath, bytes);
    }
  }
}

export async function ensureExternalInquiryThreadMirror(params: {
  executionId: ExecutionId;
  threadId: ExternalInquiryThreadId;
}): Promise<ExternalInquiryThreadMirrorPaths> {
  const threadStoragePath = `${RUNS_STORAGE_DIR}/${params.executionId}/${EXEC_DIR}/${params.threadId}`;
  await copyGlobalDirectoryToExecution(
    threadDir(params.threadId),
    threadStoragePath,
  );

  const threadPath = `/${threadStoragePath}`;
  return {
    executionId: params.executionId,
    threadPath,
    manifestPath: `${threadPath}/manifest.json`,
  };
}

async function mirrorThreadToExecution(params: {
  executionId: ExecutionId;
  threadId: ExternalInquiryThreadId;
  turn: AnsweredInquiryTurn;
}): Promise<ExternalInquiryExecutionMirrorPaths | undefined> {
  const mirror = await ensureExternalInquiryThreadMirror({
    executionId: params.executionId,
    threadId: params.threadId,
  });
  const base = mirror.threadPath;
  const toPath = (rel: string) => `${base}/${normalizeFilePath(rel)}`;

  return {
    executionId: mirror.executionId,
    manifestPath: mirror.manifestPath,
    questionPath: toPath(params.turn.questionRelativePath),
    answerPath: toPath(params.turn.answerRelativePath),
    ...(params.turn.contextRelativePath
      ? { contextPath: toPath(params.turn.contextRelativePath) }
      : {}),
  };
}

function normalizeSessionLinks(links?: string[] | null): string[] | undefined {
  if (!links?.length) return undefined;

  const normalized = unique(
    links.map((link) => link.trim()).filter((link) => link.length > 0),
  );

  return normalized.length ? normalized : undefined;
}

// ============================================================================
// Open / answer / drop helpers
// ============================================================================

/**
 * Read a thread manifest under its lock, require the last turn to be open,
 * and replace it via `update`. Returns null without calling `update` if the
 * thread is missing, not open, has no turns, or its last turn isn't open —
 * the shared guard behind `recordAnswerForOpenTurn` and
 * `persistOpenTurnDraft`.
 *
 * `afterWrite`, if returned by `update`, runs after the manifest write but
 * still inside the thread lock — for side effects (e.g. mirroring the
 * thread directory to an execution) that must not interleave with a
 * concurrent mutation of the same thread.
 */
async function withOpenTurnUpdate<T>(
  threadId: ExternalInquiryThreadId,
  update: (
    existing: ExternalInquiryThreadManifest,
    lastTurn: OpenInquiryTurn,
    timestamp: string,
  ) =>
    | Promise<{
        manifest: ExternalInquiryThreadManifest;
        result: T;
        afterWrite?: () => Promise<void>;
      } | null>
    | {
        manifest: ExternalInquiryThreadManifest;
        result: T;
        afterWrite?: () => Promise<void>;
      }
    | null,
): Promise<{ manifest: ExternalInquiryThreadManifest; result: T } | null> {
  return withThreadLock(threadId, async () => {
    const existing = await readThreadManifest(threadId);
    if (!existing || existing.status !== 'open' || existing.turns.length === 0)
      return null;

    const lastTurn = existing.turns.at(-1)!;
    if (lastTurn.kind !== 'open') return null;

    const timestamp = new Date().toISOString();
    const outcome = await update(existing, lastTurn, timestamp);
    if (!outcome) return null;

    await writeThreadManifest(outcome.manifest);
    await outcome.afterWrite?.();
    return { manifest: outcome.manifest, result: outcome.result };
  });
}

/**
 * Append a new open question to a thread. Creates the thread when no
 * thread_id is passed (or the existing thread is unknown). Updates the
 * thread's `parentStreamId` to the caller — continuations always flow
 * back to the most-recent asker.
 *
 * Behavior depends on the current status of the addressed thread:
 *   - new thread        → create with status='open'
 *   - 'answered'        → append a new open turn (follow-up); status flips back to 'open'
 *   - 'open'            → reject (already has an unanswered question)
 *   - 'dropped'         → reject (terminal)
 */
export async function recordOpenQuestion(params: {
  threadId?: ExternalInquiryThreadId;
  parentStreamId: StreamTabId;
  question: string;
  context?: string;
  suggestSearch?: boolean;
  attachFiles?: string[];
}): Promise<PersistedOpenTurn> {
  const threadId =
    params.threadId ?? (`ei_${hexId12()}` as ExternalInquiryThreadId);

  return withThreadLock(threadId, async () => {
    const existing = await readThreadManifest(threadId);

    if (params.threadId && !existing) {
      throw new ToolError(`External inquiry thread not found: ${threadId}`);
    }

    if (existing) {
      if (existing.status === 'open') {
        throw new ToolError(
          'Thread already has an open question; wait for the continuation. ' +
            'Use inquiry { command: "read", thread_id } to inspect or list to recover thread IDs. ' +
            'Do not re-dispatch.',
        );
      }
      if (existing.status === 'dropped') {
        throw new ToolError(
          'Thread was dropped by user; start a new thread instead.',
        );
      }
    }

    const timestamp = new Date().toISOString();
    const baseManifest: ExternalInquiryThreadManifest = existing ?? {
      schemaVersion: EXTERNAL_INQUIRY_MANIFEST_SCHEMA_VERSION,
      threadId,
      parentStreamId: params.parentStreamId,
      status: 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
      turns: [],
    };

    const turnIndex = baseManifest.turns.length + 1;
    const turnPath = threadTurnDir(threadId, turnIndex);
    const trimmedContext = params.context?.trim() || undefined;

    await GlobalStorageFS.ensureDir(turnPath);

    const td = turnDir(turnIndex);
    const questionRelativePath = normalizeFilePath(
      path.join(td, 'question.txt'),
    );
    const contextRelativePath = trimmedContext
      ? normalizeFilePath(path.join(td, 'context.txt'))
      : undefined;

    const writeOps: Promise<void>[] = [
      GlobalStorageFS.write(
        path.join(turnPath, 'question.txt'),
        params.question,
      ),
    ];
    if (trimmedContext) {
      writeOps.push(
        GlobalStorageFS.write(
          path.join(turnPath, 'context.txt'),
          trimmedContext,
        ),
      );
    }
    await Promise.all(writeOps);

    const turn: OpenInquiryTurn = {
      turnIndex,
      timestamp,
      question: params.question,
      context: trimmedContext,
      questionRelativePath,
      contextRelativePath,
      kind: 'open',
      suggestSearch: params.suggestSearch ?? undefined,
      attachFiles: params.attachFiles?.length ? params.attachFiles : undefined,
    };

    const nextManifest: ExternalInquiryThreadManifest = {
      ...baseManifest,
      parentStreamId: params.parentStreamId,
      status: 'open',
      updatedAt: timestamp,
      turns: [...baseManifest.turns, turn],
    };

    await writeThreadManifest(nextManifest);

    return { threadId, manifest: nextManifest, turn };
  });
}

/**
 * Persist the user-supplied answer onto the thread's current open turn.
 * Flips status `open → answered`. Mirrors the answered turn into the
 * caller execution if one is provided.
 *
 * Returns `null` if the thread has no open turn (e.g. already answered,
 * or dropped).
 */
export async function recordAnswerForOpenTurn(params: {
  threadId: ExternalInquiryThreadId;
  answer: string;
  sessionLinks?: string[] | null;
  executionId?: ExecutionId;
}): Promise<PersistedAnsweredTurn | null> {
  let executionMirrorPaths: ExternalInquiryExecutionMirrorPaths | undefined;

  const outcome = await withOpenTurnUpdate(
    params.threadId,
    async (existing, lastTurn, timestamp) => {
      const turnPath = threadTurnDir(params.threadId, lastTurn.turnIndex);
      const td = turnDir(lastTurn.turnIndex);
      const answerRelativePath = normalizeFilePath(path.join(td, 'answer.txt'));
      const sessionLinks = normalizeSessionLinks(params.sessionLinks);

      await GlobalStorageFS.write(
        path.join(turnPath, 'answer.txt'),
        params.answer,
      );

      const answeredTurn: AnsweredInquiryTurn = {
        turnIndex: lastTurn.turnIndex,
        timestamp: lastTurn.timestamp,
        question: lastTurn.question,
        context: lastTurn.context,
        questionRelativePath: lastTurn.questionRelativePath,
        contextRelativePath: lastTurn.contextRelativePath,
        suggestSearch: lastTurn.suggestSearch,
        attachFiles: lastTurn.attachFiles,
        kind: 'answered',
        answer: params.answer,
        answeredAt: timestamp,
        answerRelativePath,
        sessionLinks,
      };

      const nextManifest: ExternalInquiryThreadManifest = {
        ...existing,
        status: 'answered',
        updatedAt: timestamp,
        turns: [...existing.turns.slice(0, -1), answeredTurn],
      };

      return {
        manifest: nextManifest,
        result: answeredTurn,
        // Mirroring copies the whole thread directory, so it must observe
        // the manifest just written above and must not interleave with a
        // concurrent mutation (e.g. a follow-up recordOpenQuestion) — both
        // require staying inside the thread lock.
        afterWrite: params.executionId
          ? async () => {
              executionMirrorPaths = await mirrorThreadToExecution({
                executionId: params.executionId!,
                threadId: params.threadId,
                turn: answeredTurn,
              });
            }
          : undefined,
      };
    },
  );

  if (!outcome) return null;

  return {
    threadId: params.threadId,
    manifest: outcome.manifest,
    turn: outcome.result,
    executionMirrorPaths,
  };
}

/**
 * Mark the thread as dropped by the user. Only valid from `open` —
 * stale or duplicate drop actions arriving after a submit must NOT
 * overwrite an `answered` status (which would emit a contradictory
 * dropped continuation and corrupt the audit trail).
 *
 * Returns the just-written manifest on success so callers can pass
 * it to the continuation injector without a re-read (symmetric with
 * `recordAnswerForOpenTurn`'s `PersistedAnsweredTurn.manifest`).
 * Returns `null` when the drop was a no-op (already answered/dropped
 * or not found).
 */
export async function markDropped(params: {
  threadId: ExternalInquiryThreadId;
}): Promise<ExternalInquiryThreadManifest | null> {
  return withThreadLock(params.threadId, async () => {
    const existing = await readThreadManifest(params.threadId);
    if (!existing) return null;
    if (existing.status !== 'open') return null;

    const timestamp = new Date().toISOString();
    const nextManifest: ExternalInquiryThreadManifest = {
      ...existing,
      status: 'dropped',
      updatedAt: timestamp,
    };

    await writeThreadManifest(nextManifest);
    return nextManifest;
  });
}

/**
 * Persist (or clear) the open-turn draft for the inquiry panel. No-op
 * if the thread has no open turn.
 */
export async function persistOpenTurnDraft(params: {
  threadId: ExternalInquiryThreadId;
  draft: InquiryDraft | null;
}): Promise<void> {
  await withOpenTurnUpdate(params.threadId, (existing, lastTurn) => {
    const nextTurn: OpenInquiryTurn = {
      ...lastTurn,
      draft: params.draft ?? undefined,
    };

    // Deliberately does not bump updatedAt: a draft autosave is not a state
    // transition (unlike open/answer/drop), and updatedAt drives listing
    // sort order, the `since` freshness filter, and the "Updated: ..." text
    // shown to the model — none of which should react to the user still
    // typing an unsent answer.
    const nextManifest: ExternalInquiryThreadManifest = {
      ...existing,
      turns: [...existing.turns.slice(0, -1), nextTurn],
    };

    return { manifest: nextManifest, result: undefined };
  });
}

export function getOpenTurnDraft(
  manifest: ExternalInquiryThreadManifest,
): InquiryDraft | undefined {
  if (manifest.status !== 'open') return undefined;
  const lastTurn = manifest.turns.at(-1);
  if (!lastTurn || lastTurn.kind !== 'open') return undefined;
  return lastTurn.draft ?? undefined;
}

export function manifestToTranscript(
  manifest: ExternalInquiryThreadManifest,
): InquiryTranscriptTurn[] {
  return manifest.turns.map((turn) => ({
    turnIndex: turn.turnIndex,
    timestamp: turn.timestamp,
    question: turn.question,
    context: turn.context ?? undefined,
    answer: turn.kind === 'answered' ? turn.answer : undefined,
    answeredAt: turn.kind === 'answered' ? turn.answeredAt : undefined,
    sessionLinks:
      turn.kind !== 'open' ? (turn.sessionLinks ?? undefined) : undefined,
  }));
}

// ============================================================================
// Public read API
// ============================================================================

/**
 * Read a thread manifest and normalize legacy answer files at the boundary.
 * Legacy turns with only `answerRelativePath` are hydrated once and written
 * back so callers always see inline answers when answer text is available.
 */
export async function readExternalInquiryThread(
  threadId: string,
): Promise<ExternalInquiryThreadManifest | null> {
  const parsed = ExternalInquiryThreadIdSchema.safeParse(threadId);
  if (!parsed.success) return null;
  return withThreadLock(parsed.data, async () => {
    const manifest = await readThreadManifest(parsed.data);
    if (!manifest) return null;
    const hydrated = await hydrateAnswersFromDisk(parsed.data, manifest);
    if (hydrated.didHydrate) {
      try {
        await writeThreadManifest(hydrated.manifest);
      } catch (err) {
        logger.warn(
          `Failed to persist hydrated inquiry manifest for ${parsed.data}`,
          { data: err },
        );
      }
    }
    return hydrated.manifest;
  });
}

function manifestToSummary(
  manifest: ExternalInquiryThreadManifest,
): ExternalInquiryThreadSummary {
  const lastTurn = manifest.turns.at(-1);
  return {
    threadId: manifest.threadId,
    parentStreamId: manifest.parentStreamId,
    status: manifest.status,
    lastQuestionPreview: (lastTurn?.question ?? '').slice(
      0,
      QUESTION_PREVIEW_CHARS,
    ),
    lastActivityIso: manifest.updatedAt,
    turnCount: manifest.turns.length,
  };
}

async function listAllManifests(): Promise<ExternalInquiryThreadManifest[]> {
  // A missing/unreadable threads directory means no threads.
  const entries = await GlobalStorageFS.readDir(THREADS_DIR).catch(
    (): [string, number][] => [],
  );

  const reads = entries.flatMap(([name, type]) => {
    if (!isDirectory(type)) return [];
    const parsed = ExternalInquiryThreadIdSchema.safeParse(name);
    return parsed.success ? [readThreadManifest(parsed.data)] : [];
  });
  const manifests = await Promise.all(reads);
  return manifests.filter(
    (manifest): manifest is ExternalInquiryThreadManifest => manifest != null,
  );
}

export async function getThreadSummary(
  threadId: ExternalInquiryThreadId,
): Promise<ExternalInquiryThreadSummary | null> {
  const manifest = await readThreadManifest(threadId);
  return manifest ? manifestToSummary(manifest) : null;
}

export async function listThreadsByStatus(params: {
  status: InquiryThreadStatus | 'any';
  scope: 'stream' | 'all';
  streamId?: StreamTabId;
  limit?: number;
  since?: string;
}): Promise<ExternalInquiryThreadSummary[]> {
  const all = await listAllManifests();
  const cutoff = params.since ? Date.parse(params.since) : null;

  const filtered = all.filter((m) => {
    if (params.status !== 'any' && m.status !== params.status) return false;
    if (params.scope === 'stream') {
      if (!params.streamId) return false;
      if (m.parentStreamId !== params.streamId) return false;
    }
    if (cutoff != null && Date.parse(m.updatedAt) < cutoff) return false;
    return true;
  });

  const sorted = toNewestFirstByTimestamp(
    filtered,
    (manifest) => manifest.updatedAt,
  );

  const trimmed = params.limit != null ? sorted.slice(0, params.limit) : sorted;
  return trimmed.map(manifestToSummary);
}

export async function listOpenThreads(): Promise<
  ExternalInquiryThreadSummary[]
> {
  return listThreadsByStatus({ status: 'open', scope: 'all' });
}

export async function listOpenThreadsForStream(
  streamId: StreamTabId,
): Promise<ExternalInquiryThreadSummary[]> {
  return listThreadsByStatus({ status: 'open', scope: 'stream', streamId });
}
