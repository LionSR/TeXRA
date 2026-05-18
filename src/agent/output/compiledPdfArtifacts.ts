// Standard library imports
import * as path from 'path';

// Local imports - shared schemas
import { platform } from '@platform/platform';
import { isFile } from '@common/files/fsEntryType';
import type { ExecutionId, FileLocation } from '@shared/schemas';

// Local imports - file utilities
import {
  createRunStorageLocation,
  getComparablePath,
  type RunStorageFileLocation,
} from '@utils/files';

export interface CompiledPdfArtifact {
  round: number;
  displayName: string;
  source: FileLocation;
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
  return normalized.toLowerCase().endsWith('.pdf')
    ? normalized
    : `${normalized}.pdf`;
}

function stripRoundPrefix(relativePath: string, round: number): string {
  const roundPrefix = `r${round}/`;
  return relativePath.startsWith(roundPrefix)
    ? relativePath.slice(roundPrefix.length)
    : relativePath;
}

function toPdfRelativePath(options: PublishCompiledPdfOptions): string {
  if (options.outputPdfName) {
    return normalizePdfRelativePath(options.outputPdfName);
  }

  const comparablePath =
    options.source.kind === 'external'
      ? path.basename(options.displayName)
      : stripRoundPrefix(getComparablePath(options.source), options.round);
  const parsed = path.parse(comparablePath || options.displayName);
  const stem = parsed.name || path.basename(options.displayName, parsed.ext);
  const directory = parsed.dir;
  const pdfStem = `${stem || 'output'}${options.pdfStemSuffix ?? ''}`;
  return normalizePdfRelativePath(path.join(directory, `${pdfStem}.pdf`));
}

async function ensureParentDir(filePath: string): Promise<void> {
  await platform().fs.createDirectory(path.dirname(filePath));
}

async function copyArtifactFile(
  source: string,
  destination: string,
): Promise<void> {
  await ensureParentDir(destination);
  await platform()
    .fs.delete(destination, { recursive: true })
    .catch(() => {});
  await platform().fs.copy(source, destination, { overwrite: true });
}

export async function publishCompiledPdfArtifact(
  options: PublishCompiledPdfOptions,
): Promise<CompiledPdfArtifact | null> {
  const stats = await platform()
    .fs.stat(options.compiledPdfPath)
    .catch(() => null);
  if (!stats || !isFile(stats.type)) return null;

  const pdfRelativePath = toPdfRelativePath(options);
  const roundRelativePath = path.join(
    'output',
    `r${options.round}`,
    pdfRelativePath,
  );
  const latestRelativePath = path.join('output', 'latest', pdfRelativePath);
  const roundAbsolutePath = path.join(options.runDirectory, roundRelativePath);
  const latestAbsolutePath = path.join(
    options.runDirectory,
    latestRelativePath,
  );

  await copyArtifactFile(options.compiledPdfPath, roundAbsolutePath);
  await copyArtifactFile(roundAbsolutePath, latestAbsolutePath);

  return {
    round: options.round,
    displayName: options.displayName,
    source: options.source,
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
