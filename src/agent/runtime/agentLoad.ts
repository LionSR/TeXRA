import * as path from 'path';

import deepmerge from 'deepmerge';
import * as yaml from 'yaml';

import {
  resolveAgent,
  type AgentSource,
  type ResolvedAgent,
} from '@agent/index';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentDefinitionSchema,
  AgentSettingSchema,
  type AgentSetting,
  type AgentPrompt,
} from '@agent/core/AgentDataclass';
import { RemoteAgentLoader } from '@agent/remote/RemoteAgentLoader';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { resolveToolDefinitions } from '@tools/registry';
import { AbsoluteFS } from '@utils/files';

const CHANNEL = 'agentLoad';
logger.initialize(CHANNEL);

export interface ValidAgentDefinition {
  name: string;
  settings: AgentSetting;
}

export interface AgentYamlValidationResult extends ValidAgentDefinition {
  prompts: AgentPrompt;
}

/**
 * Parses a YAML string or already-parsed object and validates that it
 * represents a full agent definition. Returns the validated name, settings,
 * and prompts so callers can reuse consistent schema checks across string and
 * file based workflows.
 */
export function validateAgentYamlContent(
  content: string | object,
): AgentYamlValidationResult {
  const raw = typeof content === 'string' ? yaml.parse(content) : content;
  const data = AgentDefinitionSchema.parse(raw);
  const settingsBlock = AgentSettingSchema.parse(data.settings);
  const promptsBlock = AgentPromptSchema.parse(data.prompts);
  const rootName = typeof data.name === 'string' ? data.name.trim() : '';

  if (!rootName) {
    throw new Error('name is empty');
  }

  return {
    name: rootName,
    settings: settingsBlock,
    prompts: promptsBlock,
  };
}

/** Loads and parses a YAML file from an absolute path. */
export async function loadYaml(absolutePath: string): Promise<object> {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error('loadYaml requires an absolute path');
  }

  const yamlContent = await AbsoluteFS.read(absolutePath);
  return yaml.parse(yamlContent);
}

export function ensureAgentCategoryForSource<
  T extends { agentCategory?: AgentCategory },
>(settings: T, source: AgentSource): T {
  if (source === 'builtInToolUse' && !settings.agentCategory) {
    return { ...settings, agentCategory: AgentCategory.ToolUse };
  }
  return settings;
}

export async function loadAgentSettingAndPrompts(
  resolution: ResolvedAgent,
): Promise<[AgentSetting, AgentPrompt]> {
  const { entry } = resolution;

  // Handle remote agents
  if (entry.source === 'remote') {
    const remoteConfig = await RemoteAgentLoader.loadRemoteAgent(
      resolution.resolvedName,
    );

    // Remote agents are already fully processed (tools resolved, validated)
    return [remoteConfig.settings, remoteConfig.prompts];
  }

  const rawConfig = await loadYaml(resolution.definitionPath);
  const config = AgentDefinitionSchema.parse(rawConfig);

  // Initialize with own settings/prompts (spread creates a mutable copy)
  let settings: Partial<AgentSetting> = { ...config.settings };
  let prompts: Partial<AgentPrompt> = { ...config.prompts };

  // Merge with parent if inheritance is specified
  if (config.inherits) {
    const parentResolution = resolveAgent(`${entry.source}:${config.inherits}`);
    if (!parentResolution) {
      throw new Error(
        `Unable to locate parent agent "${config.inherits}" in source "${entry.source}".`,
      );
    }
    const [parentSettings, parentPrompts] =
      await loadAgentSettingAndPrompts(parentResolution);

    // Parent provides defaults, child overrides
    settings = deepmerge(parentSettings, config.settings, {
      arrayMerge: (_d, s) => s,
    });
    prompts = deepmerge(parentPrompts, config.prompts, {
      arrayMerge: (_d, s) => s,
    });
  }

  settings = ensureAgentCategoryForSource(settings, entry.source);

  // Resolve tool names to definitions using shared utility
  if (Array.isArray(settings.tools)) {
    settings.tools = resolveToolDefinitions(
      settings.tools as (string | { name: string })[],
      (name) => logger.warn(CHANNEL, `Tool "${name}" not found in registry`),
    );
  }

  // Apply defaults and validate the final settings and prompts
  return [AgentSettingSchema.parse(settings), AgentPromptSchema.parse(prompts)];
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
    const { name, settings } = validateAgentYamlContent(rawData);
    return { name, settings };
  } catch (err) {
    logger.debug(
      CHANNEL,
      `isValidAgentYaml check failed for ${filePath}: ${toErrorMessage(err)}`,
    );
  }
  return null;
}
