// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import * as yaml from 'yaml';
import deepmerge from 'deepmerge';

// Local imports - agent components
import {
  AgentSetting,
  AgentPrompt,
  AgentSettingSchema,
  DEFAULT_AGENT_PROMPTS,
} from '@agent/core/AgentDataclass';

// Local imports - utils
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';

const CHANNEL = 'agentLoad';
logger.initialize(CHANNEL);

/** Structure returned by isValidAgentYaml if validation passes */
export interface ValidAgentDefinition {
  name: string;
  settings: AgentSetting;
  // Prompts are implicitly validated by their presence, but not returned here
}

/** Loads and parses a YAML file from an absolute path. */
export async function loadYaml(absolutePath: string): Promise<object> {
  try {
    if (!path.isAbsolute(absolutePath)) {
      throw new Error('loadYaml requires an absolute path');
    }

    // Read and parse YAML
    const yamlContent = await AbsoluteFS.read(absolutePath);
    const parsedYaml = yaml.parse(yamlContent);

    console.log(`Successfully loaded YAML from: ${absolutePath}`);
    return parsedYaml;
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error loading YAML file ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
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
  agentNameFromFile: string,
): Promise<[AgentSetting, AgentPrompt]> {
  try {
    const agentFile = path.join(agentPath, `${agentNameFromFile}.yaml`);
    const config = (await loadYaml(agentFile)) as any;

    // Extract the agent's declared name from the root of the YAML, if present.
    // This is the authoritative name for this specific agent definition.
    // It's used for context or can be returned if needed, but not part of AgentSetting object.
    const declaredAgentName =
      typeof config?.name === 'string' && config.name.trim() !== ''
        ? config.name.trim()
        : agentNameFromFile; // Fallback to filename if no root name declared
    // logger.debug(CHANNEL, `Declared agent name for ${agentNameFromFile}: ${declaredAgentName}`); // Optional: for debugging

    const parent = config?.inherits;

    let settings: Partial<AgentSetting>; // Use Partial initially for merging
    let prompts: Partial<AgentPrompt>;

    if (parent) {
      // Load parent settings and prompts recursively
      // Note: The 'name' of the parent agent isn't directly used to override the current agent's settings block structure.
      const [parentSettings, parentPrompts] = await loadAgentSettingAndPrompts(
        agentPath,
        parent, // Parent's name (from its filename or root 'name') is used for recursive loading
      );

      // Get current agent's specific settings and prompts from its YAML
      const agentOwnSettings = (config?.settings ||
        {}) as Partial<AgentSetting>;
      const agentOwnPrompts = (config?.prompts || {}) as Partial<AgentPrompt>;

      // Merge with parent settings and prompts
      settings = deepmerge(parentSettings, agentOwnSettings, {
        arrayMerge: (_d, s) => s,
      });
      prompts = deepmerge(parentPrompts, agentOwnPrompts, {
        arrayMerge: (_d, s) => s,
      });
    } else {
      // No inheritance, merge with schema defaults by parsing empty object first
      const baseSettings = AgentSettingSchema.parse({});
      settings = deepmerge(
        baseSettings,
        (config?.settings || {}) as Partial<AgentSetting>,
        { arrayMerge: (_d, s) => s },
      );
      prompts = deepmerge(
        DEFAULT_AGENT_PROMPTS,
        (config?.prompts || {}) as Partial<AgentPrompt>,
        { arrayMerge: (_d, s) => s },
      );
    }

    // Validate the final, composed settings block
    const validatedSettings = AgentSettingSchema.parse(settings);
    settings = validatedSettings;

    // The function returns the validated settings block and prompts.
    // The agent's name (declaredAgentName) is known in this scope but not part of AgentSetting.
    return [settings as AgentSetting, prompts as AgentPrompt];
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error loading agent settings and prompts: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Check whether a YAML file represents a valid agent configuration.
 * Returns an object with the agent's root name and its settings if valid, otherwise null.
 */
export async function isValidAgentYaml(
  filePath: string,
): Promise<ValidAgentDefinition | null> {
  try {
    const data = (await loadYaml(filePath)) as any;
    const rootName = data?.name;
    const settingsBlock = data?.settings;
    const promptsBlock = data?.prompts;

    if (!promptsBlock) {
      logger.debug(
        CHANNEL,
        `isValidAgentYaml check failed for ${filePath}: Prompts block is missing.`,
      );
      return null;
    }

    if (typeof rootName !== 'string' || rootName.trim() === '') {
      logger.debug(
        CHANNEL,
        `isValidAgentYaml check failed for ${filePath}: Root 'name' is missing, not a string, or empty.`,
      );
      return null;
    }

    if (!settingsBlock) {
      logger.debug(
        CHANNEL,
        `isValidAgentYaml check failed for ${filePath}: Settings block is missing.`,
      );
      return null;
    }

    // Validate the settings block and use the parsed result (which may include transformations)
    const validatedSettings = AgentSettingSchema.parse(settingsBlock);

    // If all checks pass, return the structure with validated settings
    return { name: rootName.trim(), settings: validatedSettings };
  } catch (err) {
    // Handles errors from loadYaml or validateAgentSetting (e.g., invalid temp)
    logger.debug(
      CHANNEL,
      `isValidAgentYaml check failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}
