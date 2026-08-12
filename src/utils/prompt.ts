import * as path from 'node:path';

import nunjucks from 'nunjucks';

import { createLog } from '@logger/logUtils';
import { filterNotNull } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';

const log = createLog('promptUtils');

export interface XmlFormatFromFilesResult {
  readonly xml: string | null;
  readonly readableFiles: string[];
}

/**
 * File name exposed to prompt XML and workflow output instructions.
 *
 * Keep workspace files workspace-relative so sibling documents with the same
 * basename remain distinct. For external absolute paths, expose only the
 * basename: model-produced document names must be portable run-storage names,
 * not host filesystem paths.
 */
export function getPromptFileName(file: string): string {
  if (!file) return file;

  try {
    const located = WorkspaceFS.locatePath(file);
    if (located.kind === 'workspace') {
      return located.relativePath;
    }
  } catch {
    // Some pure prompt-formatting tests call this before host initialization.
    // Without a workspace root, an absolute host path can only be an external
    // file, so the basename rule still applies.
  }

  return path.isAbsolute(file) ? path.basename(file) : file;
}

/**
 * Get XML formatted string from multiple files
 *
 * Best-effort: a file that cannot be read (moved, renamed, or deleted since the
 * config was saved) is skipped with a warning rather than rejecting the whole
 * batch. This mirrors {@link setVarFromFile}, which already tolerates missing
 * files, and keeps prompt-var assembly from hard-failing an agent launch/resume
 * when an input no longer exists on disk.
 *
 * @param files List of file paths
 * @returns XML formatted string of the readable files, or null if none are readable
 */
export async function getXmlFormatFromReadableFiles(
  files: string[],
): Promise<XmlFormatFromFilesResult> {
  if (files.length === 0) {
    return { xml: null, readableFiles: [] };
  }

  const xmlContents = await Promise.all(
    files.map(async (file) => {
      try {
        const content = await WorkspaceFS.read(file);
        return {
          file,
          xml: `<document name="${getPromptFileName(file)}">\n${content}\n</document>`,
        };
      } catch (err) {
        log.warn(
          `Skipping unreadable file in prompt context: ${file} (${String(err)})`,
        );
        return null;
      }
    }),
  );
  const readable = xmlContents.filter(filterNotNull);
  return {
    xml: readable.length > 0 ? readable.map((doc) => doc.xml).join('\n') : null,
    readableFiles: readable.map((doc) => doc.file),
  };
}

/**
 * Convert a list of files to a comma-separated string
 * @param files List of file paths
 * @returns Comma-separated string of file paths
 */
export function getListOfFiles(files: string[] | null | undefined): string {
  if (!files) return '';
  return files
    .filter((f) => f.trim() !== '')
    .map(getPromptFileName)
    .join(', ');
}

async function resolveValue(value: unknown): Promise<unknown> {
  // Pass through primitives and Promises unchanged.
  // Promises are excluded from object handling to avoid iterating their internal properties.
  if (typeof value !== 'object' || value === null || value instanceof Promise) {
    return value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(resolveValue));
  }

  // Recursively resolve all values in the object
  const entries = await Promise.all(
    Object.entries(value).map(async ([k, v]) => [k, await resolveValue(v)]),
  );
  return Object.fromEntries(entries);
}

// One environment for every prompt render, as in polishModel.ts: configuring
// nunjucks builds a filesystem loader, and renderString compiles its template
// per call regardless, so a per-call environment was pure setup cost.
const promptEnv = nunjucks.configure({ autoescape: false });

/**
 * Render a prompt string using nunjucks templating
 * @param prompt The prompt template string
 * @param variables Variables to use in template rendering
 * @returns Rendered prompt string
 */
export async function renderPrompt(
  prompt: string,
  variables: Record<string, unknown>,
): Promise<string> {
  const resolvedVariables = await resolveValue(variables);
  return promptEnv.renderString(
    prompt,
    resolvedVariables as Record<string, unknown>,
  );
}
