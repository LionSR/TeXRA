import * as path from 'path';
import { randomBytes } from 'crypto';

import { z } from 'zod';

import { isDirectory, isFile } from '@common/files/fsEntryType';
import type { ExecutionId } from '@shared/schemas';
import {
  EXTERNAL_INQUIRY_ALLOWED_FILE_EXTENSIONS,
  EXTERNAL_INQUIRY_BLOCKED_MIME_TYPES,
  EXTERNAL_INQUIRY_MAX_UPLOAD_FILES,
  ExternalInquiryModeSchema,
  ExternalInquiryThreadIdSchema,
  type ExternalInquiryMode,
  type ExternalInquiryThreadId,
  type ExternalInquiryUploadedFile,
} from '@shared/schemas';
import { ToolError } from '@tools/result';
import { GlobalStorageFS, StorageFS } from '@utils/files';

const EXTERNAL_INQUIRY_THREADS_DIR = 'external_inquiry_threads';
const EXTERNAL_INQUIRY_EXECUTION_DIR = 'external_inquiry';
const EXTERNAL_INQUIRY_MANIFEST_FILE = 'manifest.json';

const ExternalInquiryStoredFileSchema = z.strictObject({
  fileName: z.string().min(1),
  storedFileName: z.string().min(1),
  mediaType: z.string(),
  sizeBytes: z.int().nonnegative(),
  relativePath: z.string().min(1),
});

const ExternalInquiryTurnRecordSchema = z.strictObject({
  turnIndex: z.int().positive(),
  mode: ExternalInquiryModeSchema,
  timestamp: z.string().min(1),
  question: z.string(),
  context: z.string().nullish(),
  questionRelativePath: z.string().min(1),
  contextRelativePath: z.string().nullish(),
  answerRelativePath: z.string().min(1),
  uploadedFiles: z.array(ExternalInquiryStoredFileSchema),
});

const ExternalInquiryThreadManifestSchema = z.strictObject({
  threadId: ExternalInquiryThreadIdSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  turns: z.array(ExternalInquiryTurnRecordSchema),
});

export type ExternalInquiryStoredFile = z.infer<
  typeof ExternalInquiryStoredFileSchema
>;
export type ExternalInquiryTurnRecord = z.infer<
  typeof ExternalInquiryTurnRecordSchema
>;
export type ExternalInquiryThreadManifest = z.infer<
  typeof ExternalInquiryThreadManifestSchema
>;

export interface ExternalInquiryExecutionMirrorPaths {
  executionId: ExecutionId;
  rootRelativePath: string;
  manifestPath: string;
  questionPath: string;
  contextPath?: string;
  answerPath: string;
  uploadPaths: string[];
}

export interface PersistedExternalInquiryTurn {
  threadId: ExternalInquiryThreadId;
  manifest: ExternalInquiryThreadManifest;
  turn: ExternalInquiryTurnRecord;
  executionMirrorPaths?: ExternalInquiryExecutionMirrorPaths;
}

function normalizeSlashes(value: string): string {
  return value.replaceAll('\\', '/');
}

function getExtension(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

function formatTurnDirName(turnIndex: number): string {
  return `turn-${String(turnIndex).padStart(4, '0')}`;
}

function threadStorageDir(threadId: ExternalInquiryThreadId): string {
  return path.join(EXTERNAL_INQUIRY_THREADS_DIR, threadId);
}

function threadManifestPath(threadId: ExternalInquiryThreadId): string {
  return path.join(threadStorageDir(threadId), EXTERNAL_INQUIRY_MANIFEST_FILE);
}

function threadTurnDir(
  threadId: ExternalInquiryThreadId,
  turnIndex: number,
): string {
  return path.join(
    threadStorageDir(threadId),
    'turns',
    formatTurnDirName(turnIndex),
  );
}

function executionThreadMirrorDir(
  executionId: ExecutionId,
  threadId: ExternalInquiryThreadId,
): string {
  return path.join(
    'executions',
    executionId,
    EXTERNAL_INQUIRY_EXECUTION_DIR,
    threadId,
  );
}

function executionFilePath(
  executionId: ExecutionId,
  relativePath: string,
): string {
  return `/executions/${executionId}/files/${normalizeSlashes(relativePath)}`;
}

function sanitizeStoredFileName(fileName: string): string {
  const baseName = path.basename(fileName).replaceAll('\0', '');
  const sanitized = baseName
    .replaceAll(/[^A-Za-z0-9._-]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
  return sanitized || 'upload.txt';
}

function ensureUniqueStoredFileName(
  fileName: string,
  usedNames: Set<string>,
): string {
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;

  let candidate = fileName;
  let counter = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${stem}-${counter}${extension}`;
    counter += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function isBlockedUploadMimeType(mediaType: string): boolean {
  return (
    mediaType.startsWith('image/') ||
    mediaType.startsWith('audio/') ||
    mediaType.startsWith('video/') ||
    EXTERNAL_INQUIRY_BLOCKED_MIME_TYPES.has(mediaType)
  );
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;

  let suspiciousControlBytes = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    const isControl =
      byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13;
    if (isControl) suspiciousControlBytes += 1;
  }

  const text = Buffer.from(bytes).toString('utf8');
  if (text.includes('\uFFFD')) return false;

  return suspiciousControlBytes / bytes.length < 0.05;
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
  await GlobalStorageFS.ensureDir(threadStorageDir(manifest.threadId));
  await GlobalStorageFS.writeJson(
    threadManifestPath(manifest.threadId),
    manifest,
  );
}

async function copyGlobalFileToExecution(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  await StorageFS.ensureDir(path.dirname(targetPath));
  const bytes = await GlobalStorageFS.readBytes(sourcePath);
  await StorageFS.write(targetPath, bytes);
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

async function mirrorThreadToExecution(params: {
  executionId: ExecutionId;
  threadId: ExternalInquiryThreadId;
  turn: ExternalInquiryTurnRecord;
}): Promise<ExternalInquiryExecutionMirrorPaths> {
  const sourceRoot = threadStorageDir(params.threadId);
  const targetRoot = executionThreadMirrorDir(
    params.executionId,
    params.threadId,
  );

  // Copy only the updated manifest and the new turn directory (not the entire thread).
  const sourceTurnDir = path.join(
    sourceRoot,
    'turns',
    formatTurnDirName(params.turn.turnIndex),
  );
  const targetTurnDir = path.join(
    targetRoot,
    'turns',
    formatTurnDirName(params.turn.turnIndex),
  );

  await Promise.all([
    copyGlobalFileToExecution(
      threadManifestPath(params.threadId),
      path.join(targetRoot, EXTERNAL_INQUIRY_MANIFEST_FILE),
    ),
    copyGlobalDirectoryToExecution(sourceTurnDir, targetTurnDir),
  ]);

  const rootRelativePath = normalizeSlashes(
    path.join(EXTERNAL_INQUIRY_EXECUTION_DIR, params.threadId),
  );

  return {
    executionId: params.executionId,
    rootRelativePath,
    manifestPath: executionFilePath(
      params.executionId,
      path.join(rootRelativePath, EXTERNAL_INQUIRY_MANIFEST_FILE),
    ),
    questionPath: executionFilePath(
      params.executionId,
      path.join(rootRelativePath, params.turn.questionRelativePath),
    ),
    ...(params.turn.contextRelativePath
      ? {
          contextPath: executionFilePath(
            params.executionId,
            path.join(rootRelativePath, params.turn.contextRelativePath),
          ),
        }
      : {}),
    answerPath: executionFilePath(
      params.executionId,
      path.join(rootRelativePath, params.turn.answerRelativePath),
    ),
    uploadPaths: params.turn.uploadedFiles.map((file) =>
      executionFilePath(
        params.executionId,
        path.join(rootRelativePath, file.relativePath),
      ),
    ),
  };
}

function buildNewThreadManifest(
  threadId: ExternalInquiryThreadId,
  timestamp: string,
): ExternalInquiryThreadManifest {
  return {
    threadId,
    createdAt: timestamp,
    updatedAt: timestamp,
    turns: [],
  };
}

function createStoredThreadId(): ExternalInquiryThreadId {
  return `ei_${randomBytes(6).toString('hex')}` as ExternalInquiryThreadId;
}

function validateUploadCount(
  uploadedFiles: readonly ExternalInquiryUploadedFile[],
): void {
  if (uploadedFiles.length > EXTERNAL_INQUIRY_MAX_UPLOAD_FILES) {
    throw new ToolError(
      `External inquiry accepts at most ${EXTERNAL_INQUIRY_MAX_UPLOAD_FILES} uploaded files per turn.`,
    );
  }
}

async function persistUploadedFiles(params: {
  threadId: ExternalInquiryThreadId;
  turnIndex: number;
  uploadedFiles: readonly ExternalInquiryUploadedFile[];
}): Promise<ExternalInquiryStoredFile[]> {
  const uploadsDir = path.join(
    threadTurnDir(params.threadId, params.turnIndex),
    'uploads',
  );
  if (params.uploadedFiles.length > 0) {
    await GlobalStorageFS.ensureDir(uploadsDir);
  }

  const storedFiles: ExternalInquiryStoredFile[] = [];
  const usedNames = new Set<string>();

  for (const uploadedFile of params.uploadedFiles) {
    const bytes = Buffer.from(uploadedFile.base64, 'base64');
    if (bytes.length !== uploadedFile.sizeBytes) {
      throw new ToolError(
        `Uploaded file ${uploadedFile.fileName} has inconsistent size metadata.`,
      );
    }

    const extension = getExtension(uploadedFile.fileName);
    const mediaType = uploadedFile.mediaType.trim().toLowerCase();

    if (!EXTERNAL_INQUIRY_ALLOWED_FILE_EXTENSIONS.has(extension)) {
      throw new ToolError(
        `Uploaded file ${uploadedFile.fileName} is not an allowed text/code file.`,
      );
    }

    if (isBlockedUploadMimeType(mediaType)) {
      throw new ToolError(
        `Uploaded file ${uploadedFile.fileName} is not a supported text file.`,
      );
    }

    const looksText = looksLikeUtf8Text(bytes);
    if (!looksText) {
      throw new ToolError(
        `Uploaded file ${uploadedFile.fileName} appears to be binary.`,
      );
    }

    const storedFileName = ensureUniqueStoredFileName(
      sanitizeStoredFileName(uploadedFile.fileName),
      usedNames,
    );
    const relativePath = normalizeSlashes(
      path.join(
        'turns',
        formatTurnDirName(params.turnIndex),
        'uploads',
        storedFileName,
      ),
    );

    await GlobalStorageFS.write(path.join(uploadsDir, storedFileName), bytes);

    storedFiles.push({
      fileName: uploadedFile.fileName,
      storedFileName,
      mediaType,
      sizeBytes: bytes.length,
      relativePath,
    });
  }

  return storedFiles;
}

export async function persistExternalInquiryTurn(params: {
  mode: ExternalInquiryMode;
  threadId?: ExternalInquiryThreadId;
  question: string;
  context?: string;
  answer: string;
  uploadedFiles?: readonly ExternalInquiryUploadedFile[];
  executionId?: ExecutionId;
}): Promise<PersistedExternalInquiryTurn> {
  const uploadedFiles = params.uploadedFiles ?? [];
  validateUploadCount(uploadedFiles);

  const threadId = params.threadId ?? createStoredThreadId();
  const existingManifest = await readThreadManifest(threadId);

  if (params.threadId && !existingManifest) {
    throw new ToolError(`External inquiry thread not found: ${threadId}`);
  }

  const timestamp = new Date().toISOString();
  const manifest =
    existingManifest ?? buildNewThreadManifest(threadId, timestamp);
  const turnIndex = manifest.turns.length + 1;
  const turnDir = threadTurnDir(threadId, turnIndex);

  await GlobalStorageFS.ensureDir(turnDir);

  const questionRelativePath = normalizeSlashes(
    path.join('turns', formatTurnDirName(turnIndex), 'question.txt'),
  );
  const answerRelativePath = normalizeSlashes(
    path.join('turns', formatTurnDirName(turnIndex), 'answer.txt'),
  );
  const contextRelativePath = params.context?.trim()
    ? normalizeSlashes(
        path.join('turns', formatTurnDirName(turnIndex), 'context.txt'),
      )
    : undefined;

  const writeOps: Promise<void>[] = [
    GlobalStorageFS.write(path.join(turnDir, 'question.txt'), params.question),
    GlobalStorageFS.write(path.join(turnDir, 'answer.txt'), params.answer),
  ];
  if (contextRelativePath) {
    writeOps.push(
      GlobalStorageFS.write(
        path.join(turnDir, 'context.txt'),
        params.context!.trim(),
      ),
    );
  }
  await Promise.all(writeOps);

  const storedFiles = await persistUploadedFiles({
    threadId,
    turnIndex,
    uploadedFiles,
  });

  const turn: ExternalInquiryTurnRecord = {
    turnIndex,
    mode: params.mode,
    timestamp,
    question: params.question,
    context: params.context?.trim() || undefined,
    questionRelativePath,
    contextRelativePath,
    answerRelativePath,
    uploadedFiles: storedFiles,
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
}

export async function readExternalInquiryThread(
  threadId: string,
): Promise<ExternalInquiryThreadManifest | null> {
  const parsed = ExternalInquiryThreadIdSchema.safeParse(threadId);
  if (!parsed.success) return null;
  return readThreadManifest(parsed.data);
}

export { looksLikeUtf8Text };
