import * as path from 'path';
import { randomBytes } from 'crypto';

import { z } from 'zod';

import { isDirectory, isFile } from '@common/files/fsEntryType';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  ExternalInquirySessionLinksSchema,
  ExternalInquiryThreadIdSchema,
  InquiryDraftSchema,
  StreamTabIdSchema,
  type ExternalInquiryThreadId,
  type ExternalInquiryThreadSummary,
  type InquiryDraft,
  type InquiryThreadStatus,
} from '@shared/schemas';
import { normalizeFilePath } from '@shared/utils/path';
import { ToolError } from '@tools/result';
import { GlobalStorageFS, StorageFS } from '@utils/files';

const THREADS_DIR = 'ei_threads';
const EXEC_DIR = 'ei';
const QUESTION_PREVIEW_CHARS = 200;

// ============================================================================
// Schemas
// ============================================================================

const TurnBaseShape = {
  turnIndex: z.int().positive(),
  timestamp: z.string().min(1),
  question: z.string(),
  context: z.string().nullish(),
  questionRelativePath: z.string().min(1),
  contextRelativePath: z.string().nullish(),
  /** Set for legacy single-shot turns. New open turns omit this. */
  answerRelativePath: z.string().nullish(),
  sessionLinks: ExternalInquirySessionLinksSchema.nullish(),
  /** Set when an answer has been recorded for this turn. */
  answer: z.string().nullish(),
  answeredAt: z.string().nullish(),
  /** Persisted dispatch metadata so the panel re-renders identically after reload. */
  suggestSearch: z.boolean().nullish(),
  attachFiles: z.array(z.string()).nullish(),
  /** Open-turn draft state, debounced by the panel. */
  draft: InquiryDraftSchema.nullish(),
};

const ExternalInquiryTurnRecordSchema = z.looseObject(TurnBaseShape);
export type ExternalInquiryTurnRecord = z.infer<
  typeof ExternalInquiryTurnRecordSchema
>;

const ManifestBaseShape = {
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
 */
const LegacyManifestSchema = z
  .looseObject({
    threadId: ExternalInquiryThreadIdSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    turns: z.array(ExternalInquiryTurnRecordSchema),
  })
  .transform(
    (raw): z.infer<typeof CanonicalManifestSchema> => ({
      threadId: raw.threadId,
      parentStreamId: null,
      status: 'answered' as const,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      turns: raw.turns,
    }),
  );

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
  turn: ExternalInquiryTurnRecord;
}

export interface PersistedAnsweredTurn {
  threadId: ExternalInquiryThreadId;
  manifest: ExternalInquiryThreadManifest;
  turn: ExternalInquiryTurnRecord;
  executionMirrorPaths?: ExternalInquiryExecutionMirrorPaths;
}

// ============================================================================
// Per-thread write lock
// ============================================================================

const threadLocks = new Map<string, Promise<void>>();

async function withThreadLock<T>(
  threadId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = threadLocks.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  threadLocks.set(threadId, next);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (threadLocks.get(threadId) === next) {
      threadLocks.delete(threadId);
    }
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
 * Hydrate inline `answer` from disk for any turn that has an
 * `answerRelativePath` but no inline `answer` field. Legacy single-shot
 * manifests stored the answer text only on disk; the new canonical
 * shape carries it inline so renderers don't need a second read.
 */
async function hydrateAnswersFromDisk(
  threadId: ExternalInquiryThreadId,
  manifest: ExternalInquiryThreadManifest,
): Promise<ExternalInquiryThreadManifest> {
  const turns = await Promise.all(
    manifest.turns.map(async (turn) => {
      if (turn.answer || !turn.answerRelativePath) return turn;
      try {
        const content = await GlobalStorageFS.read(
          path.join(threadDir(threadId), turn.answerRelativePath),
        );
        return { ...turn, answer: content };
      } catch {
        return turn;
      }
    }),
  );
  return { ...manifest, turns };
}

async function readThreadManifest(
  threadId: ExternalInquiryThreadId,
): Promise<ExternalInquiryThreadManifest | null> {
  try {
    const raw = await GlobalStorageFS.readJson<unknown>(
      threadManifestPath(threadId),
    );
    const result = ExternalInquiryThreadManifestSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function writeThreadManifest(
  manifest: ExternalInquiryThreadManifest,
): Promise<void> {
  await GlobalStorageFS.ensureDir(threadDir(manifest.threadId));
  await GlobalStorageFS.writeJson(
    threadManifestPath(manifest.threadId),
    manifest,
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
  await copyGlobalDirectoryToExecution(
    threadDir(params.threadId),
    path.join('executions', params.executionId, EXEC_DIR, params.threadId),
  );

  const threadPath = `/executions/${params.executionId}/${EXEC_DIR}/${params.threadId}`;
  return {
    executionId: params.executionId,
    threadPath,
    manifestPath: `${threadPath}/manifest.json`,
  };
}

async function mirrorThreadToExecution(params: {
  executionId: ExecutionId;
  threadId: ExternalInquiryThreadId;
  turn: ExternalInquiryTurnRecord;
}): Promise<ExternalInquiryExecutionMirrorPaths | undefined> {
  if (!params.turn.answerRelativePath) return undefined;
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

  const normalized = [
    ...new Set(
      links.map((link) => link.trim()).filter((link) => link.length > 0),
    ),
  ];

  return normalized.length ? normalized : undefined;
}

// ============================================================================
// Open / answer / drop helpers
// ============================================================================

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
    params.threadId ??
    (`ei_${randomBytes(6).toString('hex')}` as ExternalInquiryThreadId);

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

    const turn: ExternalInquiryTurnRecord = {
      turnIndex,
      timestamp,
      question: params.question,
      context: trimmedContext,
      questionRelativePath,
      contextRelativePath,
      // answerRelativePath, answer, answeredAt all omitted — open turn.
      suggestSearch: params.suggestSearch || undefined,
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
  return withThreadLock(params.threadId, async () => {
    const existing = await readThreadManifest(params.threadId);
    if (!existing) return null;
    if (existing.status !== 'open') return null;
    if (existing.turns.length === 0) return null;

    const lastTurn = existing.turns[existing.turns.length - 1];
    if (lastTurn.answer) return null;

    const timestamp = new Date().toISOString();
    const turnPath = threadTurnDir(params.threadId, lastTurn.turnIndex);
    const td = turnDir(lastTurn.turnIndex);
    const answerRelativePath = normalizeFilePath(path.join(td, 'answer.txt'));
    const sessionLinks = normalizeSessionLinks(params.sessionLinks);

    await GlobalStorageFS.write(
      path.join(turnPath, 'answer.txt'),
      params.answer,
    );

    const answeredTurn: ExternalInquiryTurnRecord = {
      ...lastTurn,
      answer: params.answer,
      answeredAt: timestamp,
      answerRelativePath,
      sessionLinks,
      draft: undefined,
    };

    const nextManifest: ExternalInquiryThreadManifest = {
      ...existing,
      status: 'answered',
      updatedAt: timestamp,
      turns: [...existing.turns.slice(0, -1), answeredTurn],
    };

    await writeThreadManifest(nextManifest);

    const executionMirrorPaths = params.executionId
      ? await mirrorThreadToExecution({
          executionId: params.executionId,
          threadId: params.threadId,
          turn: answeredTurn,
        })
      : undefined;

    return {
      threadId: params.threadId,
      manifest: nextManifest,
      turn: answeredTurn,
      executionMirrorPaths,
    };
  });
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
  await withThreadLock(params.threadId, async () => {
    const existing = await readThreadManifest(params.threadId);
    if (!existing || existing.status !== 'open' || existing.turns.length === 0)
      return;

    const lastTurn = existing.turns[existing.turns.length - 1];
    if (lastTurn.answer) return;

    const nextTurn: ExternalInquiryTurnRecord = {
      ...lastTurn,
      draft: params.draft ?? undefined,
    };

    const nextManifest: ExternalInquiryThreadManifest = {
      ...existing,
      turns: [...existing.turns.slice(0, -1), nextTurn],
    };

    await writeThreadManifest(nextManifest);
  });
}

// ============================================================================
// Public read API
// ============================================================================

/**
 * Read a thread manifest. When `hydrate` is true, fills in inline
 * `answer` text from `answerRelativePath` for legacy manifests so
 * callers don't see "(awaiting user answer)" for migrated threads.
 * Continuation injection uses the canonical inline `answer` field
 * already, so hydration is opt-in to keep the hot path cheap.
 */
export async function readExternalInquiryThread(
  threadId: string,
  options?: { hydrate?: boolean },
): Promise<ExternalInquiryThreadManifest | null> {
  const parsed = ExternalInquiryThreadIdSchema.safeParse(threadId);
  if (!parsed.success) return null;
  const manifest = await readThreadManifest(parsed.data);
  if (!manifest) return null;
  if (options?.hydrate) {
    return hydrateAnswersFromDisk(parsed.data, manifest);
  }
  return manifest;
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
  const out: ExternalInquiryThreadManifest[] = [];
  let entries: [string, number][] = [];
  try {
    entries = await GlobalStorageFS.readDir(THREADS_DIR);
  } catch {
    return out;
  }

  for (const [name, type] of entries) {
    if (!isDirectory(type)) continue;
    const parsed = ExternalInquiryThreadIdSchema.safeParse(name);
    if (!parsed.success) continue;
    const manifest = await readThreadManifest(parsed.data);
    if (manifest) out.push(manifest);
  }
  return out;
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

  filtered.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const trimmed =
    params.limit != null ? filtered.slice(0, params.limit) : filtered;
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
