// Standard library imports
// Standard library imports
import * as path from 'path';

// Third-party imports
import deepmerge from 'deepmerge';

// Third-party imports
import * as vscode from 'vscode';
import * as yaml from 'yaml';
import { z } from 'zod';

// Local imports - agent

// Local imports - agent components
import {
  AgentSetting,
  AgentPrompt,
  AgentSettingSchema,
  AgentPromptSchema,
  AgentDefinitionSchema,
} from '@agent/core/AgentDataclass';

// Local imports - utils
import * as logger from '@logger/logUtils';
import type { ToolDefinition } from '@model';
import { AbsoluteFS } from '@utils/files';

const CHANNEL = 'agentLoad';
logger.initialize(CHANNEL);

/** Zod schema for the validated portion of an agent definition */
export const ValidAgentDefinitionSchema = AgentDefinitionSchema.pick({
  name: true,
  settings: true,
});

export type ValidAgentDefinition = z.infer<typeof ValidAgentDefinitionSchema>;

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
    const moreInfo = 'More Info';
    vscode.window
      .showErrorMessage(
        `Error loading YAML file ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
        moreInfo,
      )
      .then((selection) => {
        if (selection === moreInfo) {
          void vscode.commands.executeCommand('texra.openDoc', 'custom-agents');
        }
      });
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
    const rawConfig = await loadYaml(agentFile);
    const config = AgentDefinitionSchema.parse(rawConfig);

    // Extract the agent's declared name from the root of the YAML, if present.
    // This is the authoritative name for this specific agent definition.
    // It's used for context or can be returned if needed, but not part of AgentSetting object.
    const declaredAgentName = config.name;
    // logger.debug(CHANNEL, `Declared agent name for ${agentNameFromFile}: ${declaredAgentName}`); // Optional: for debugging

    const parent = config.inherits;

    let settings: Partial<AgentSetting> = {};
    let prompts: Partial<AgentPrompt> = {};

    if (parent) {
      // Load parent settings and prompts recursively
      // Note: The 'name' of the parent agent isn't directly used to override the current agent's settings block structure.
      const [parentSettings, parentPrompts] = await loadAgentSettingAndPrompts(
        agentPath,
        parent, // Parent's name (from its filename or root 'name') is used for recursive loading
      );

      // Get current agent's specific settings and prompts from its YAML
      const agentOwnSettings = config.settings ?? {};
      const agentOwnPrompts = config.prompts ?? {};

      // Merge with parent settings and prompts
      settings = deepmerge(parentSettings, agentOwnSettings, {
        arrayMerge: (_d, s) => s,
      });
      prompts = deepmerge(parentPrompts, agentOwnPrompts, {
        arrayMerge: (_d, s) => s,
      });
    } else {
      // No inheritance, just take own settings and prompts
      settings = deepmerge({}, config.settings ?? {}, {
        arrayMerge: (_d, s) => s,
      });
      prompts = deepmerge({}, config.prompts ?? {}, {
        arrayMerge: (_d, s) => s,
      });
    }

    // Resolve tool names to definitions
    if (Array.isArray(settings.tools)) {
      const { DEFAULT_TOOL_REGISTRY } = await import('@tools/registry');
      settings.tools = (settings.tools as any[]).map((item) => {
        if (typeof item === 'string') {
          const tool = DEFAULT_TOOL_REGISTRY[item];
          if (!tool) {
            logger.warn(CHANNEL, `Tool "${item}" not found in registry`);
            return { name: item } as ToolDefinition;
          }
          return tool.definition;
        }
        if (!DEFAULT_TOOL_REGISTRY[item.name]) {
          logger.warn(CHANNEL, `Tool "${item.name}" not found in registry`);
        }
        return item as ToolDefinition;
      });
    }

    // Apply defaults and validate the final settings and prompts
    const validatedSettings = AgentSettingSchema.parse(settings);
    const validatedPrompts = AgentPromptSchema.parse(prompts);
    settings = validatedSettings;
    prompts = validatedPrompts;

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
    const rawData = await loadYaml(filePath);
    const data = AgentDefinitionSchema.parse(rawData);

    if (!data.settings || !data.prompts) {
      logger.debug(
        CHANNEL,
        `isValidAgentYaml check failed for ${filePath}: missing settings or prompts block`,
      );
      return null;
    }

    const settingsBlock = AgentSettingSchema.parse(data.settings);
    AgentPromptSchema.parse(data.prompts);
    const rootName = data.name;

    if (rootName === '') {
      logger.debug(
        CHANNEL,
        `isValidAgentYaml check failed for ${filePath}: name is empty`,
      );
      return null;
    }

    // return structure validated by ValidAgentDefinitionSchema
    return ValidAgentDefinitionSchema.parse({
      name: rootName,
      settings: settingsBlock,
    });
  } catch (err) {
    logger.debug(
      CHANNEL,
      `isValidAgentYaml check failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}
