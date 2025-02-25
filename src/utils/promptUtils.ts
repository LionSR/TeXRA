// Standard library imports
import * as path from 'path';

// Third-party imports
import * as nunjucks from 'nunjucks';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { readFile, writeFile } from './workspaceFileUtils';
import { getAgentFirstNameChunk } from '../housekeeping/utils';

const CHANNEL = 'Utils';
logger.initialize(CHANNEL);

/**
 * Get XML formatted string from a single file
 * @param file Path to the file
 * @returns XML formatted string containing file content
 */
export async function getXmlFormatFromFile(file: string): Promise<string> {
  try {
    const content = await readFile(file);
    return `<document name="${file}">\n${content}\n</document>`;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error formatting file as XML: ${err instanceof Error ? err.message : String(err)}`,
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
  try {
    if (!files || files.length === 0) {
      return null;
    }

    const xmlPromises = files.map((file) => getXmlFormatFromFile(file));
    const xmlContents = await Promise.all(xmlPromises);
    return xmlContents.join('\n');
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error formatting files as XML: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Convert a list of files to a comma-separated string
 * @param files List of file paths
 * @returns Comma-separated string of file paths
 */
export function getListOfFiles(files: string[] | null | undefined): string {
  try {
    if (!files) {
      return '';
    }
    return files.filter((f) => f !== null).join(', ');
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error creating file list: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
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
      } else if (typeof value === 'object' && value !== null) {
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
    logger.error(
      CHANNEL,
      `Error rendering prompt: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Get the first K characters from a document
 * @param inputFile Path to the input file
 * @param k Number of characters to return
 * @returns First K characters from the document, stripped of whitespace, or null if file cannot be read
 */
export async function getFirstKCharsFromDocument(
  inputFile: string,
  k: number,
): Promise<string | null> {
  try {
    const content = await readFile(inputFile);
    return content ? content.slice(0, k).trim() : null;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error reading first ${k} chars from ${inputFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Write the model's input prompt to an XML file
 * @param systemPrompt The system prompt
 * @param userPrefix The user prefix
 * @param userRequest The user request
 * @param inputFile Path to the input file
 * @param agent Name of the agent
 * @returns Path to the created XML file
 */
export async function writePromptToXml(
  systemPrompt: string,
  userPrefix: string,
  userRequest: string,
  inputFile: string,
  agent: string,
): Promise<string> {
  try {
    const { dir, name } = path.parse(inputFile);
    const agentName = getAgentFirstNameChunk(agent);
    const outputFile = path.join(dir, `${name}_${agentName}_input.xml`);

    logger.debug(CHANNEL, `Writing input prompt to ${outputFile}`);

    const fullPrompt = `\n<system>${systemPrompt}</system>\n\n${userPrefix}\n${userRequest}\n`;
    await writeFile(outputFile, fullPrompt);

    return outputFile;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error writing prompt to XML: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
