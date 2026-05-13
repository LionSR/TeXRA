import * as path from 'path';
import { randomBytes } from 'crypto';

import { z } from 'zod';

import { isDirectory, isFile } from '@common/files/fsEntryType';
import type { ExecutionId } from '@shared/schemas';
import {
  ExternalInquirySessionLinksSchema,
  ExternalInquiryThreadIdSchema,
  type ExternalInquiryThreadId,
} from '@shared/schemas';
import { normalizeFilePath } from '@shared/utils/path';
import { ToolError } from '@tools/result';
import { GlobalStorageFS, StorageFS } from '@utils/files';

const THREADS_DIR = 'ei_threads';
const EXEC_DIR = 'ei';

const ExternalInquiryTurnRecordSchema = z.looseObject({
  turnIndex: z.int().positive(),
  timestamp: z.string().min(1),
  question: z.string(),
  context: z.string().nullish(),
  questionRelativePath: z.string().min(1),
  contextRelativePath: z.string().nullish(),
  answerRelativePath: z.string().min(1),
  sessionLinks: ExternalInquirySessionLinksSchema.nullish(),
});

const ExternalInquiryThreadManifestSchema = z.looseObject({
  threadId: ExternalInquiryThreadIdSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  turns: z.array(ExternalInquiryTurnRecordSchema),
});

export type ExternalInquiryTurnRecord = z.infer<
  typeof ExternalInquiryTurnRecordSchema
>;
export type ExternalInquiryThreadManifest = z.infer<
  typeof ExternalInquiryThreadManifestSchema
>;

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

export interface PersistedExternalInquiryTurn {
  threadId: ExternalInquiryThreadId;
  manifest: ExternalInquiryThreadManifest;
  turn: ExternalInquiryTurnRecord;
  executionMirrorPaths?: ExternalInquiryExecutionMirrorPaths;
}

// Per-thread write lock to prevent concurrent manifest corruption.
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
}): Promise<ExternalInquiryExecutionMirrorPaths> {
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

function normalizeSessionLinks(links?: string[]): string[] | undefined {
  if (!links?.length) return undefined;

  const normalized = [
    ...new Set(
      links.map((link) => link.trim()).filter((link) => link.length > 0),
    ),
  ];

  return normalized.length ? normalized : undefined;
}

export async function persistExternalInquiryTurn(params: {
  threadId?: ExternalInquiryThreadId;
  question: string;
  context?: string;
  answer: string;
  sessionLinks?: string[];
  executionId?: ExecutionId;
}): Promise<PersistedExternalInquiryTurn> {
  const threadId =
    params.threadId ??
    (`ei_${randomBytes(6).toString('hex')}` as ExternalInquiryThreadId);

  return withThreadLock(threadId, async () => {
    const existingManifest = await readThreadManifest(threadId);

    if (params.threadId && !existingManifest) {
      throw new ToolError(`External inquiry thread not found: ${threadId}`);
    }

    const timestamp = new Date().toISOString();
    const manifest: ExternalInquiryThreadManifest = existingManifest ?? {
      threadId,
      createdAt: timestamp,
      updatedAt: timestamp,
      turns: [],
    };
    const turnIndex = manifest.turns.length + 1;
    const turnPath = threadTurnDir(threadId, turnIndex);
    const trimmedContext = params.context?.trim() || undefined;
    const sessionLinks = normalizeSessionLinks(params.sessionLinks);

    await GlobalStorageFS.ensureDir(turnPath);

    const td = turnDir(turnIndex);
    const questionRelativePath = normalizeFilePath(
      path.join(td, 'question.txt'),
    );
    const answerRelativePath = normalizeFilePath(path.join(td, 'answer.txt'));
    const contextRelativePath = trimmedContext
      ? normalizeFilePath(path.join(td, 'context.txt'))
      : undefined;

    const writeOps: Promise<void>[] = [
      GlobalStorageFS.write(
        path.join(turnPath, 'question.txt'),
        params.question,
      ),
      GlobalStorageFS.write(path.join(turnPath, 'answer.txt'), params.answer),
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
      answerRelativePath,
      sessionLinks,
    };

    const nextManifest: ExternalInquiryThreadManifest = {
      ...manifest,
      updatedAt: timestamp,
      turns: [...manifest.turns, turn],
    };

    await writeThreadManifest(nextManifest);

    const executionMirrorPaths = params.executionId
      ? await mirrorThreadToExecution({
          executionId: params.executionId,
          threadId,
          turn,
        })
      : undefined;

    return {
      threadId,
      manifest: nextManifest,
      turn,
      executionMirrorPaths,
    };
  });
}

export async function readExternalInquiryThread(
  threadId: string,
): Promise<ExternalInquiryThreadManifest | null> {
  const parsed = ExternalInquiryThreadIdSchema.safeParse(threadId);
  if (!parsed.success) return null;
  return readThreadManifest(parsed.data);
}
