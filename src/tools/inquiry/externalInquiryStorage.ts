import * as path from 'node:path';

import { z } from 'zod';

import { createChannelTrace } from '@agent/trace';
import { isFileNotFoundError } from '@common/errors';
import { EXTERNAL_INQUIRY_THREADS_DIR } from '@common/storage/storageLayout';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  InquiryDraftSchema,
  InquirySessionLinksSchema,
  InquiryThreadIdSchema,
  StreamTabIdSchema,
  ToolError,
  type InquiryDraft,
  type InquiryThreadId,
  type InquiryThreadStatus,
  type InquiryThreadSummary,
  type InquiryTranscriptTurn,
} from '@shared/schemas';
import {
  isObject,
  KeyedMutex,
  toNewestFirstByTimestamp,
  unique,
  hexId12,
  normalizeFilePath,
} from '@utils/core';
import { GlobalStorageFS, StorageFS } from '@utils/files/storageFS';
import { isDirectory, isFile } from '@utils/files/fsEntryType';

const THREADS_DIR = EXTERNAL_INQUIRY_THREADS_DIR;
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
  /**
   * Fences a delayed answer to the continuation that dispatched this turn.
   * Omission reads manifests written before 2026-08-13; retire this optional
   * reader after 2026-11-13, when those open inquiries are outside the
   * repository's three-month compatibility window.
   */
  parentGenerationId: z.string().min(1).optional(),
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
type OpenInquiryTurn = z.infer<typeof OpenInquiryTurnSchema>;

/** Answer recorded and available inline — the steady-state "done" shape. */
const AnsweredInquiryTurnSchema = z.object({
  ...InquiryTurnBaseShape,
  kind: z.literal('answered'),
  answer: z.string(),
  answeredAt: z.string().min(1),
  answerRelativePath: z.string().min(1),
  sessionLinks: InquirySessionLinksSchema.nullish(),
});
type AnsweredInquiryTurn = z.infer<typeof AnsweredInquiryTurnSchema>;

const ExternalInquiryTurnRecordSchema = z.discriminatedUnion('kind', [
  OpenInquiryTurnSchema,
  AnsweredInquiryTurnSchema,
]);
type ExternalInquiryTurnRecord = z.infer<
  typeof ExternalInquiryTurnRecordSchema
>;

const EXTERNAL_INQUIRY_MANIFEST_SCHEMA_VERSION = 1;

const ManifestBaseShape = {
  schemaVersion: z.literal(EXTERNAL_INQUIRY_MANIFEST_SCHEMA_VERSION),
  threadId: InquiryThreadIdSchema,
  parentStreamId: StreamTabIdSchema.nullable(),
  status: z.enum(['open', 'answered', 'dropped']),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  turns: z.array(ExternalInquiryTurnRecordSchema),
};

/**
 * New canonical manifest form: explicit `status` + `parentStreamId`.
 */
const ExternalInquiryThreadManifestSchema = z.looseObject(ManifestBaseShape);
export type ExternalInquiryThreadManifest = z.infer<
  typeof ExternalInquiryThreadManifestSchema
>;

// ============================================================================
// Mirror types
// ============================================================================

interface ExternalInquiryExecutionMirrorPaths {
  executionId: ExecutionId;
  manifestPath: string;
  questionPath: string;
  contextPath?: string;
  answerPath: string;
}

interface ExternalInquiryThreadMirrorPaths {
  executionId: ExecutionId;
  threadPath: string;
  manifestPath: string;
}

interface PersistedOpenTurn {
  threadId: InquiryThreadId;
  manifest: ExternalInquiryThreadManifest;
  turn: OpenInquiryTurn;
}

interface PersistedAnsweredTurn {
  threadId: InquiryThreadId;
  manifest: ExternalInquiryThreadManifest;
  turn: AnsweredInquiryTurn;
  executionMirrorPaths?: ExternalInquiryExecutionMirrorPaths;
}

// ============================================================================
// Per-thread write lock
// ============================================================================

const threadMutex = new KeyedMutex<string>();

// ============================================================================
// Path helpers
// ============================================================================

function turnDir(turnIndex: number): string {
  return `t${turnIndex}`;
}

function threadDir(threadId: InquiryThreadId): string {
  return path.join(THREADS_DIR, threadId);
}

function threadManifestPath(threadId: InquiryThreadId): string {
  return path.join(threadDir(threadId), 'manifest.json');
}

function threadTurnDir(threadId: InquiryThreadId, turnIndex: number): string {
  return path.join(threadDir(threadId), turnDir(turnIndex));
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
  threadId: InquiryThreadId,
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
  // unsupported data, not a shape to reinterpret.
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
// Execution mirroring
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
  threadId: InquiryThreadId;
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
  threadId: InquiryThreadId;
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

interface OpenTurnUpdate<T> {
  manifest: ExternalInquiryThreadManifest;
  result: T;
  afterWrite?: () => Promise<void>;
}

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
  threadId: InquiryThreadId,
  update: (
    existing: ExternalInquiryThreadManifest,
    lastTurn: OpenInquiryTurn,
    timestamp: string,
  ) => Promise<OpenTurnUpdate<T> | null> | OpenTurnUpdate<T> | null,
): Promise<{ manifest: ExternalInquiryThreadManifest; result: T } | null> {
  return threadMutex.runExclusive(threadId, async () => {
    const existing = await readThreadManifest(threadId);
    if (!existing || existing.status !== 'open' || existing.turns.length === 0)
      return null;

    // Safe: the length check above guarantees at least one turn.
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
  threadId?: InquiryThreadId;
  parentStreamId: StreamTabId;
  parentGenerationId?: string;
  question: string;
  context?: string;
  suggestSearch?: boolean;
  attachFiles?: string[];
}): Promise<PersistedOpenTurn> {
  const threadId = params.threadId ?? (`ei_${hexId12()}` as InquiryThreadId);

  return threadMutex.runExclusive(threadId, async () => {
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
      parentGenerationId: params.parentGenerationId,
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
  threadId: InquiryThreadId;
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

      // `draft` is open-turn-only state and must not survive the transition.
      const { draft: _draft, ...openFields } = lastTurn;
      const answeredTurn: AnsweredInquiryTurn = {
        ...openFields,
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
  threadId: InquiryThreadId;
}): Promise<ExternalInquiryThreadManifest | null> {
  return threadMutex.runExclusive(params.threadId, async () => {
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
  threadId: InquiryThreadId;
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
      turn.kind === 'answered' ? (turn.sessionLinks ?? undefined) : undefined,
  }));
}

// ============================================================================
// Public read API
// ============================================================================

/** Read a canonical thread manifest. */
export async function readExternalInquiryThread(
  threadId: string,
): Promise<ExternalInquiryThreadManifest | null> {
  const parsed = InquiryThreadIdSchema.safeParse(threadId);
  if (!parsed.success) return null;
  return threadMutex.runExclusive(parsed.data, () =>
    readThreadManifest(parsed.data),
  );
}

function manifestToSummary(
  manifest: ExternalInquiryThreadManifest,
): InquiryThreadSummary {
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
  // A missing threads directory means no threads. Operational storage
  // failures must remain observable instead of masquerading as empty history.
  const entries = await GlobalStorageFS.readDir(THREADS_DIR).catch(
    (error: unknown): [string, number][] => {
      if (isFileNotFoundError(error)) return [];
      throw error;
    },
  );

  const reads = entries.flatMap(([name, type]) => {
    if (!isDirectory(type)) return [];
    const parsed = InquiryThreadIdSchema.safeParse(name);
    return parsed.success ? [readThreadManifest(parsed.data)] : [];
  });
  const manifests = await Promise.all(reads);
  return manifests.filter(
    (manifest): manifest is ExternalInquiryThreadManifest => manifest != null,
  );
}

export async function getThreadSummary(
  threadId: InquiryThreadId,
): Promise<InquiryThreadSummary | null> {
  const manifest = await readThreadManifest(threadId);
  return manifest ? manifestToSummary(manifest) : null;
}

export async function listThreadsByStatus(params: {
  status: InquiryThreadStatus | 'any';
  scope: 'stream' | 'all';
  streamId?: StreamTabId;
  limit?: number;
  since?: string;
}): Promise<InquiryThreadSummary[]> {
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
