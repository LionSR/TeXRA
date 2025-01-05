// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import * as yaml from 'yaml';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getConfig } from '../frontend-utils/commonUtils';

// Local imports - agent components
import {
  AgentSetting,
  AgentPrompt,
  validateAgentSetting,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_AGENT_PROMPTS,
} from './AgentDataclass';

const CHANNEL = 'Agent';
logger.initializeLogging(CHANNEL);

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
        // why do you have to create the directory?
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.file(path.dirname(fullPath)),
        );
        logger.debug(CHANNEL, `Using global storage path: ${fullPath}`);

        absolutePath = fullPath;
      } catch (err) {
        logger.error(CHANNEL, `Error with global storage path: ${err}`);
        throw err;
      }
    }

    try {
      // Verify the path exists before trying to read it
      const fileUri = vscode.Uri.file(absolutePath);
      await vscode.workspace.fs.stat(fileUri);
      logger.debug(CHANNEL, `Reading from: ${absolutePath}`);

      // Read and parse YAML
      const fileContent = await vscode.workspace.fs.readFile(fileUri);
      const yamlContent = Buffer.from(fileContent).toString('utf-8');
      const parsedYaml = yaml.parse(yamlContent);

      logger.debug(CHANNEL, `Successfully loaded YAML from: ${filePath}`);
      return parsedYaml;
    } catch (err) {
      logger.error(
        CHANNEL,
        `Path does not exist or is not accessible: ${absolutePath}`,
      );
      throw err;
    }
  } catch (err) {
    logger.error(
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
    logger.error(
      CHANNEL,
      `Error merging dictionaries: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Load agent settings and prompts from YAML file with inheritance support
 * @param agentPath Path to the agent directory
 * @param agentName Name of the agent
 * @param context Extension context (required for relative paths)
 * @returns Promise<[AgentSetting, AgentPrompt]> Tuple of settings and prompts
 */
export async function loadAgentSettingAndPrompts(
  agentPath: string,
  agentName: string,
  context?: vscode.ExtensionContext,
): Promise<[AgentSetting, AgentPrompt]> {
  try {
    const agentFile = path.join(agentPath, `${agentName}.yaml`);
    const config = (await loadYaml(agentFile, context)) as any;
    const parent = config?.inherits;

    let settings: AgentSetting;
    let prompts: AgentPrompt;

    if (parent) {
      // Load parent settings and prompts recursively
      const [parentSettings, parentPrompts] = await loadAgentSettingAndPrompts(
        agentPath,
        parent,
        context,
      );

      // Get current settings and prompts, defaulting to empty objects
      const agentSetting = (config?.settings || {}) as Partial<AgentSetting>;
      const agentPrompt = (config?.prompts || {}) as Partial<AgentPrompt>;

      // Merge with parent settings and prompts
      settings = mergeDicts(parentSettings, agentSetting) as AgentSetting;
      prompts = mergeDicts(parentPrompts, agentPrompt) as AgentPrompt;
    } else {
      // No inheritance, use settings and prompts directly with defaults
      settings = mergeDicts(
        DEFAULT_AGENT_SETTINGS,
        (config?.settings || {}) as Partial<AgentSetting>,
      ) as AgentSetting;
      prompts = mergeDicts(
        DEFAULT_AGENT_PROMPTS,
        (config?.prompts || {}) as Partial<AgentPrompt>,
      ) as AgentPrompt;
    }

    // Validate settings
    validateAgentSetting(settings);

    return [settings, prompts];
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error loading agent settings and prompts: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
