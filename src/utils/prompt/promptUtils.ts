// Standard library imports
import * as path from 'path';

// Third-party imports
import * as nunjucks from 'nunjucks';

// Local imports - agent
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - log
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { StorageFS, TASK_RUNS_DIR, WorkspaceFS } from '@utils/files';
import { getAgentFirstNameChunk } from '@housekeeping/utils';

const CHANNEL = 'promptUtils';
logger.initialize(CHANNEL);

/**
 * Get XML formatted string from a single file.
 * Internal helper used by getXmlFormatFromFiles.
 */
async function getXmlFormatFromFile(file: string): Promise<string> {
  try {
    const content = await WorkspaceFS.read(file);
    return `<document name="${file}">\n${content}\n</document>`;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error formatting file as XML: ${toErrorMessage(err)}`,
    );
    throw err;
  }
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

  const xmlPromises = files.map((file) => getXmlFormatFromFile(file));
  const xmlContents = await Promise.all(xmlPromises);
  return xmlContents.join('\n');
}

/**
 * Convert a list of files to a comma-separated string
 * @param files List of file paths
 * @returns Comma-separated string of file paths
 */
export function getListOfFiles(files: string[] | null | undefined): string {
  if (!files || files.length === 0) {
    return '';
  }
  return files.filter((f) => f.trim() !== '').join(', ');
}

/**
 * Render a prompt string using nunjucks templating
 * @param prompt The prompt template string
 * @param variables Variables to use in template rendering
 * @returns Rendered prompt string
 */
export async function renderPrompt(
  prompt: string,
  variables: { [key: string]: any },
): Promise<string> {
  try {
    // First resolve any Promise values in the variables
    const resolvedVariables: { [key: string]: any } = {};
    for (const [key, value] of Object.entries(variables)) {
      if (value instanceof Promise) {
        resolvedVariables[key] = await value;
      } else if (
        typeof value === 'object' &&
        value !== null &&
        value !== undefined
      ) {
        // Handle nested objects that might contain promises
        const resolved: { [key: string]: any } = {};
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          if (nestedValue instanceof Promise) {
            resolved[nestedKey] = await nestedValue;
          } else {
            resolved[nestedKey] = nestedValue;
          }
        }
        resolvedVariables[key] = resolved;
      } else {
        resolvedVariables[key] = value;
      }
    }

    const env = nunjucks.configure({ autoescape: false });
    const renderedPrompt = env.renderString(prompt, resolvedVariables);
    return renderedPrompt;
  } catch (err) {
    logger.error(CHANNEL, `Error rendering prompt: ${toErrorMessage(err)}`);
    throw err;
  }
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
  try {
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
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error writing prompt to XML: ${toErrorMessage(err)}`,
    );
    throw err;
  }
}
