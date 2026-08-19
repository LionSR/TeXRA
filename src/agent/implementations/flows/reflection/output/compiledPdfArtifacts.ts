// Node imports
import * as path from 'node:path';

// Local imports
import { isFileNotFoundError } from '@common/errors';
import { platform } from '@platform/platform';
import {
  fileLocationDisplayPath,
  type ExecutionId,
  type FileLocation,
  type RunStorageFileLocation,
} from '@shared/schemas';
import { parseWorkflowOutputRoundDir } from '@shared/constants/workflowOutput';
import { createRunStorageLocation } from '@utils/files/fileLocation';
import { isFile } from '@utils/files/fsEntryType';
import { hasExtension } from '@utils/core/pathCore';

export interface CompiledPdfArtifact {
  pdf: RunStorageFileLocation;
  latestPdf: RunStorageFileLocation;
}

export interface PublishCompiledPdfOptions {
  runDirectory: string;
  executionId: ExecutionId;
  round: number;
  displayName: string;
  source: FileLocation;
  compiledPdfPath: string;
  pdfStemSuffix?: string;
  outputPdfName?: string;
}

function normalizePdfRelativePath(pdfPath: string): string {
  const parts = pdfPath
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..');
  const normalized = parts.length > 0 ? parts.join('/') : 'output.pdf';
  return hasExtension(normalized, '.pdf') ? normalized : `${normalized}.pdf`;
}

function stripRoundPrefix(relativePath: string, round: number): string {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  const separatorIndex = normalizedPath.indexOf('/');
  if (separatorIndex === -1) return normalizedPath;
  const firstSegment = normalizedPath.slice(0, separatorIndex);
  return parseWorkflowOutputRoundDir(firstSegment) === round
    ? normalizedPath.slice(separatorIndex + 1)
    : normalizedPath;
}

function toPdfRelativePath(options: PublishCompiledPdfOptions): string {
  if (options.outputPdfName) {
    return normalizePdfRelativePath(options.outputPdfName);
  }

  const comparablePath =
    options.source.kind === 'external'
      ? path.basename(options.displayName)
      : stripRoundPrefix(
          fileLocationDisplayPath(options.source),
          options.round,
        );
  const parsed = path.parse(comparablePath || options.displayName);
  const stem = parsed.name || path.basename(options.displayName, parsed.ext);
  const pdfStem = `${stem || 'output'}${options.pdfStemSuffix ?? ''}`;
  return normalizePdfRelativePath(path.join(parsed.dir, `${pdfStem}.pdf`));
}

async function copyArtifactFile(
  source: string,
  destination: string,
): Promise<void> {
  const fs = platform().fs;
  await fs.createDirectory(path.dirname(destination));
  await fs.delete(destination, { recursive: true }).catch((error) => {
    if (!isFileNotFoundError(error)) throw error;
  });
  await fs.copy(source, destination, { overwrite: true });
}

export async function publishCompiledPdfArtifact(
  options: PublishCompiledPdfOptions,
): Promise<CompiledPdfArtifact | null> {
  let stats;
  try {
    stats = await platform().fs.stat(options.compiledPdfPath);
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }
  if (!isFile(stats.type)) return null;

  const pdfRelativePath = toPdfRelativePath(options);
  const roundRelativePath = path.posix.join(
    'output',
    `r${options.round}`,
    pdfRelativePath,
  );
  const latestRelativePath = path.posix.join(
    'output',
    'latest',
    pdfRelativePath,
  );
  const roundAbsolutePath = path.join(options.runDirectory, roundRelativePath);
  const latestAbsolutePath = path.join(
    options.runDirectory,
    latestRelativePath,
  );

  await copyArtifactFile(options.compiledPdfPath, roundAbsolutePath);
  await copyArtifactFile(roundAbsolutePath, latestAbsolutePath);

  return {
    pdf: createRunStorageLocation(
      roundAbsolutePath,
      roundRelativePath,
      options.executionId,
    ),
    latestPdf: createRunStorageLocation(
      latestAbsolutePath,
      latestRelativePath,
      options.executionId,
    ),
  };
}
