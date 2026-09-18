import * as fs from 'node:fs/promises';

import { createLog } from '@logger/logUtils';
import { filterNotNull } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getPromptFileName } from '@utils/prompt';
import { normalizeLineEndings } from '@utils/text/stringUtils';

import { workspaceAbsolutePath } from './workspaceFS';

const log = createLog('VarsUtils');

/**
 * The read prompt assembly makes: the file's bytes decoded as UTF-8 — a
 * leading BOM kept, which a `TextDecoder` would strip — with line endings
 * normalized, which is what the retired facade's read gave.
 *
 * `node:fs/promises` rather than the Effect `FileSystem`: prompt assembly runs
 * on the Promise tier inside the launch's `runInSession` frame, and that frame
 * is `AsyncLocalStorage`, which Effect's scheduler does not carry across a
 * fiber yield. The roots-carrier tail of `buildUserVars` still reads it, so
 * this chain stays where the frame holds. The paths reaching here are already
 * absolute: the caller resolves a relative entry against the root it holds as
 * data.
 */
export async function readPromptFile(target: string): Promise<string> {
  return normalizeLineEndings((await fs.readFile(target)).toString('utf-8'));
}

/** A file successfully read for the `${varName}_FILE`/`${varName}_CONTENT` variable pair. */
export interface FileVarValue {
  file: string;
  content: string;
}

/**
 * Reads a file for the `${varName}_FILE`/`${varName}_CONTENT` variable pair.
 * Returns `null` on read failure; the caller decides how to name and store
 * the pair, so this stays a plain read rather than a stringly-keyed write
 * into an arbitrary vars object.
 *
 * `workspaceRoot` is the root a relative `filePath` resolves against, held by
 * the caller as data rather than read from the calling fiber's ambient roots.
 * An already-absolute `filePath` passes through it untouched, so a caller that
 * has resolved its own path can hand in `undefined`.
 */
export async function setVarFromFile(
  filePath: string,
  varName: string,
  workspaceRoot: string | undefined,
): Promise<FileVarValue | null> {
  try {
    const content = await readPromptFile(
      workspaceAbsolutePath(workspaceRoot, filePath),
    );
    return { file: filePath, content };
  } catch (error) {
    // The variable is simply absent from the prompt after this, so a
    // mistyped path and a permission error must not read like a real absence.
    log.warn(
      `Failed to read ${varName} from file ${filePath}: ${toErrorMessage(error)}`,
      { data: error },
    );
    return null;
  }
}

/** The prompt XML built from a file list, plus what the read dropped. */
export interface XmlFormatFromFilesResult {
  readonly xml: string | null;
  readonly readableFiles: string[];
  /**
   * Files dropped from the prompt because they could not be read. Order is
   * unspecified — the reads settle concurrently — so do not build on it; each
   * entry names its own file.
   */
  readonly skipped: ReadonlyArray<{ file: string; reason: string }>;
}

/**
 * Get XML formatted string from multiple files
 *
 * Best-effort: a file that cannot be read (moved, renamed, or deleted since the
 * config was saved) is skipped rather than rejecting the whole batch. This
 * mirrors {@link setVarFromFile}, which already tolerates missing files, and
 * keeps prompt-var assembly from hard-failing an agent launch/resume when an
 * input no longer exists on disk. The skip is reported back in `skipped` so the
 * caller can surface it on the run's own channel — a module logger here would
 * drop the reason outside the run that lost the file.
 *
 * @param workspaceRoot Root a relative entry resolves against, held as data
 * @param files List of file paths
 * @returns XML formatted string of the readable files, or null if none are readable
 */
export async function getXmlFormatFromReadableFiles(
  workspaceRoot: string | undefined,
  files: string[],
): Promise<XmlFormatFromFilesResult> {
  if (files.length === 0) {
    return { xml: null, readableFiles: [], skipped: [] };
  }

  const skipped: { file: string; reason: string }[] = [];
  const xmlContents = await Promise.all(
    files.map(async (file) => {
      try {
        const content = await readPromptFile(
          workspaceAbsolutePath(workspaceRoot, file),
        );
        return {
          file,
          xml: `<document name="${getPromptFileName(workspaceRoot, file)}">\n${content}\n</document>`,
        };
      } catch (err) {
        skipped.push({ file, reason: String(err) });
        return null;
      }
    }),
  );
  const readable = xmlContents.filter(filterNotNull);
  return {
    xml: readable.length > 0 ? readable.map((doc) => doc.xml).join('\n') : null,
    readableFiles: readable.map((doc) => doc.file),
    skipped,
  };
}
