import * as path from 'node:path';

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
  type AgentSettingInput,
  type AgentPrompt,
} from '@agent/core/definition/AgentDataclass';
import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';
import { RemoteAgentLoader } from '@agent/remote/RemoteAgentLoader';
import * as logger from '@logger/logUtils';
import { agentKey } from '@shared/schemas/agent';
import { resolveToolDefinitions } from '@tools/registry';
import { AbsoluteFS } from '@utils/files';

const CHANNEL = 'agentLoad';
logger.initialize(CHANNEL);

export interface ValidAgentDefinition {
  name: string;
  settings: AgentSettingInput;
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
  const rootName = typeof data.name === 'string' ? data.name.trim() : '';

  if (!rootName) {
    throw new Error('name is empty');
  }

  return {
    name: rootName,
    settings: data.settings,
    prompts: data.prompts,
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

  // Initialize with own settings/prompts (spread creates a mutable copy).
  // Tools may still be raw name strings at this point — they are resolved below.
  let settings: AgentSettingInput = { ...config.settings };
  let prompts: AgentPrompt = { ...config.prompts };

  // Merge with parent if inheritance is specified
  if (config.inherits) {
    const parentResolution = resolveAgent(
      agentKey(entry.source, config.inherits),
    );
    if (!parentResolution) {
      throw new Error(
        `Unable to locate parent agent "${config.inherits}" in source "${entry.source}".`,
      );
    }
    const [parentSettings, parentPrompts] =
      await loadAgentSettingAndPrompts(parentResolution);

    // Parent provides defaults, child overrides.
    // parentSettings has resolved ToolDefinition objects while
    // config.settings may still have raw strings; the merge produces a
    // hybrid that we treat as input for the resolution step below.
    settings = mergeInheritedAgentObject(
      parentSettings as unknown as Record<string, unknown>,
      config.settings as unknown as Record<string, unknown>,
    ) as unknown as AgentSettingInput;
    prompts = mergeInheritedAgentObject(parentPrompts, config.prompts);
  }

  settings = ensureAgentCategoryForSource(settings, entry.source);

  // Resolve tool names to definitions using shared utility
  if (Array.isArray(settings.tools)) {
    const resolvedTools = resolveToolDefinitions(
      settings.tools as (string | { name: string })[],
      (name) => logger.warn(CHANNEL, `Tool "${name}" not found in registry`),
    );
    settings = { ...settings, tools: resolvedTools } as AgentSettingInput;
  }

  // Apply defaults and validate the final settings and prompts
  return [AgentSettingSchema.parse(settings), AgentPromptSchema.parse(prompts)];
}
