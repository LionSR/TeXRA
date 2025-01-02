import * as nunjucks from 'nunjucks';
import { debug, error, initializeLogging } from '../logger/logUtils';
import * as yaml from 'yaml';
import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig } from '../frontend-utils/commonUtils';

const CHANNEL = 'Agent';
initializeLogging(CHANNEL);

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
