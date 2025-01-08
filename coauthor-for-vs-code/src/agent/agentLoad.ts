// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import * as yaml from 'yaml';

// Local imports - agent components
import {
  AgentSetting,
  AgentPrompt,
  validateAgentSetting,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_AGENT_PROMPTS,
} from './AgentDataclass';

/** Loads and parses a YAML file from an absolute path. */
export async function loadYaml(absolutePath: string): Promise<object> {
  try {
    if (!path.isAbsolute(absolutePath)) {
      throw new Error('loadYaml requires an absolute path');
    }

    // Read and parse YAML
    const fileUri = vscode.Uri.file(absolutePath);
    const fileContent = await vscode.workspace.fs.readFile(fileUri);
    // const fileContent = vscode.workspace.fs.readFileSync(fileUri);
    const yamlContent = Buffer.from(fileContent).toString('utf-8');
    const parsedYaml = yaml.parse(yamlContent);

    vscode.window.showInformationMessage(
      `Successfully loaded YAML from: ${absolutePath}`,
    );
    return parsedYaml;
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error loading YAML file ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/** Recursively merges two dictionaries with override values. */
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
    vscode.window.showErrorMessage(
      `Error merging dictionaries: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Loads agent settings and prompts with inheritance support.
 * Merges with parent configurations if specified in the inherits field.
 */
export async function loadAgentSettingAndPrompts(
  agentPath: string,
  agentName: string,
): Promise<[AgentSetting, AgentPrompt]> {
  try {
    const agentFile = path.join(agentPath, `${agentName}.yaml`);
    const config = (await loadYaml(agentFile)) as any;
    const parent = config?.inherits;

    let settings: AgentSetting;
    let prompts: AgentPrompt;

    if (parent) {
      // Load parent settings and prompts recursively
      const [parentSettings, parentPrompts] = await loadAgentSettingAndPrompts(
        agentPath,
        parent,
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
    vscode.window.showErrorMessage(
      `Error loading agent settings and prompts: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
