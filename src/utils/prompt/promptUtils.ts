import * as path from 'path';

import * as nunjucks from 'nunjucks';

import { getAgentFirstNameChunk } from '@housekeeping/utils';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS, TASK_RUNS_DIR, WorkspaceFS } from '@utils/files';

const CHANNEL = 'promptUtils';
logger.initialize(CHANNEL);

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
 * @param files List of file paths
 * @returns XML formatted string containing all file contents, or null if no files
 */
export async function getXmlFormatFromFiles(
  files: string[],
): Promise<string | null> {
  if (files.length === 0) {
    return null;
  }

  const xmlContents = await Promise.all(
    files.map(async (file) => {
      const content = await WorkspaceFS.read(file);
      return `<document name="${getPromptFileName(file)}">\n${content}\n</document>`;
    }),
  );
  return xmlContents.join('\n');
}

/**
 * Convert a list of files to a comma-separated string
 * @param files List of file paths
 * @returns Comma-separated string of file paths
 */
export function getListOfFiles(files: string[] | null | undefined): string {
  return (
    files
      ?.filter((f) => f.trim() !== '')
      .map((file) => getPromptFileName(file))
      .join(', ') ?? ''
  );
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
  const env = nunjucks.configure({ autoescape: false });
  return env.renderString(prompt, resolvedVariables as Record<string, unknown>);
}

/**
 * Write the model's input prompt to an XML file
 * @param systemPrompt The system prompt
 * @param userPrefix The user prefix
 * @param userRequest The user request
 * @param inputFile Path to the input file
 * @param agent Name of the agent
 * @param executionId Optional execution identifier used to scope storage writes
 * @returns Absolute path to the created XML file
 */
export async function writePromptToXml(
  systemPrompt: string,
  userPrefix: string,
  userRequest: string,
  inputFile: string,
  agent: string,
  executionId?: ExecutionId,
): Promise<string> {
  const { dir, name } = path.parse(inputFile);
  const agentName = getAgentFirstNameChunk(agent);
  const fullPrompt = `\n<system>${systemPrompt}</system>\n\n${userPrefix}\n${userRequest}\n`;

  if (executionId) {
    const runDir = path.join(TASK_RUNS_DIR, executionId);
    const relativeOutputFile = path.join(
      runDir,
      `${name}_${agentName}_input.xml`,
    );

    await StorageFS.ensureDir(TASK_RUNS_DIR);
    await StorageFS.ensureDir(runDir);

    const storagePath = StorageFS.fullPath(relativeOutputFile);
    logger.debug(CHANNEL, `Writing input prompt to ${storagePath}`);
    await StorageFS.write(relativeOutputFile, fullPrompt);

    return storagePath;
  }

  const outputFile = path.join(dir, `${name}_${agentName}_input.xml`);
  const workspacePath = WorkspaceFS.fullPath(outputFile);
  logger.debug(CHANNEL, `Writing input prompt to ${workspacePath}`);
  await WorkspaceFS.write(outputFile, fullPrompt);

  return workspacePath;
}
