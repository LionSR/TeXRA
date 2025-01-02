import * as nunjucks from 'nunjucks';
import { debug, error, initializeLogging } from '../logger/logUtils';
import { readFile } from './fileUtils';
import * as yaml from 'yaml';
import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig } from './commonUtils';

const CHANNEL = 'PromptUtils';
initializeLogging(CHANNEL);

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
    const env = nunjucks.configure({ autoescape: false });
    const renderedPrompt = env.renderString(prompt, variables);
    // debug(CHANNEL, `Rendered prompt: ${renderedPrompt}`);
    return renderedPrompt;
  } catch (err) {
    error(
      CHANNEL,
      `Error rendering prompt: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

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
    error(
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
    error(
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
    error(
      CHANNEL,
      `Error creating file list: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Load a YAML file and return its contents as a dictionary
 * Handles both absolute paths and paths relative to extension's global storage
 * @param filePath Path to the YAML file
 * @param context Extension context (required for relative paths)
 * @returns Promise<object> Parsed YAML content
 */
export async function loadYaml(
  filePath: string,
  context?: vscode.ExtensionContext,
): Promise<object> {
  try {
    let absolutePath: string;
    const rootPath = getConfig<string>('explorer.rootPath', 'agents');

    if (path.isAbsolute(filePath)) {
      // If filePath is absolute, use it directly
      absolutePath = filePath;
    } else {
      // For any non-absolute path, use global storage as base
      if (!context) {
        throw new Error('Extension context required for relative paths');
      }

      try {
        const globalStoragePath = context.globalStorageUri.fsPath;
        const fullPath = path.join(globalStoragePath, rootPath, filePath);

        // Ensure the directory exists
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.file(path.dirname(fullPath)),
        );
        debug(CHANNEL, `Using global storage path: ${fullPath}`);

        absolutePath = fullPath;
      } catch (err) {
        error(CHANNEL, `Error with global storage path: ${err}`);
        throw err;
      }
    }

    try {
      // Verify the path exists before trying to read it
      const fileUri = vscode.Uri.file(absolutePath);
      await vscode.workspace.fs.stat(fileUri);
      debug(CHANNEL, `Reading from: ${absolutePath}`);

      // Read and parse YAML
      const fileContent = await vscode.workspace.fs.readFile(fileUri);
      const yamlContent = Buffer.from(fileContent).toString('utf-8');
      const parsedYaml = yaml.parse(yamlContent);

      debug(CHANNEL, `Successfully loaded YAML from: ${filePath}`);
      return parsedYaml;
    } catch (err) {
      error(
        CHANNEL,
        `Path does not exist or is not accessible: ${absolutePath}`,
      );
      throw err;
    }
  } catch (err) {
    error(
      CHANNEL,
      `Error loading YAML file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Merge two dictionaries recursively
 * @param base Base dictionary
 * @param override Dictionary with overriding values
 * @returns Merged dictionary
 */
export function mergeDicts(
  base: { [key: string]: any },
  override: { [key: string]: any },
): { [key: string]: any } {
  try {
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        key in result
      ) {
        result[key] = mergeDicts(result[key], value);
      } else {
        result[key] = value;
      }
    }
    return result;
  } catch (err) {
    error(
      CHANNEL,
      `Error merging dictionaries: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
