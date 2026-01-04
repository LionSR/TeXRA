// Standard library imports
import * as path from 'path';

// Third-party imports
import deepmerge from 'deepmerge';
import * as yaml from 'yaml';

// Local imports - agent components
import {
  resolveAgent,
  getBaseName,
  type AgentSource,
  type ResolvedAgent,
} from '@agent/index';
import {
  AgentSetting,
  AgentPrompt,
  AgentPromptSchema,
  AgentDefinitionSchema,
  AgentType,
  parseAgentSetting,
} from '@agent/core/AgentDataclass';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import * as logger from '@logger/logUtils';

// Internal imports
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
  const settingsBlock = parseAgentSetting(data.settings);
  const promptsBlock = AgentPromptSchema.parse(data.prompts);
  const rootName = typeof data.name === 'string' ? data.name.trim() : '';

  if (!rootName) {
    throw new Error('name is empty');
  }

  return {
    name: rootName,
    settings: settingsBlock,
    prompts: promptsBlock,
  } satisfies AgentYamlValidationResult;
}

/** Loads and parses a YAML file from an absolute path. */
export async function loadYaml(absolutePath: string): Promise<object> {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error('loadYaml requires an absolute path');
  }

  const yamlContent = await AbsoluteFS.read(absolutePath);
  return yaml.parse(yamlContent);
}

/**
 * Loads agent settings and prompts with inheritance support.
 * Merges with parent configurations if specified in the inherits field.
 *
 * The {@link LoadAgentOptions.preferMultiple} flag only affects the initial
 * agent being resolved. Parent definitions always load their base variant so
 * that inherited prompts remain consistent with the author's expectations.
 */
export interface LoadAgentOptions {
  preferMultiple?: boolean;
}

export function ensureAgentTypeForSource<T extends { agentType?: AgentType }>(
  settings: T,
  source: AgentSource,
): T {
  if (source === 'builtInToolUse' && settings.agentType === undefined) {
    settings.agentType = AgentType.ToolUse;
  }
  return settings;
}

export async function loadAgentSettingAndPrompts(
  resolution: ResolvedAgent,
  options?: LoadAgentOptions,
): Promise<[AgentSetting, AgentPrompt]> {
  try {
    if (options?.preferMultiple && resolution.usedFallback) {
      logger.warn(
        CHANNEL,
        `Requested multiple outputs for agent "${getBaseName(resolution.resolvedName)}" but no _multiple definition was found. Falling back to base definition.`,
      );
    }

    const { entry } = resolution;

    // Handle remote agents
    if (entry.source === 'remote') {
      const { RemoteAgentLoader } =
        await import('@agent/remote/RemoteAgentLoader');
      const remoteConfig = await RemoteAgentLoader.loadRemoteAgent(
        resolution.resolvedName,
        { preferMultiple: options?.preferMultiple },
      );

      // Remote agents are already fully processed (tools resolved, validated)
      return [remoteConfig.settings, remoteConfig.prompts];
    }

    const rawConfig = await loadYaml(resolution.definitionPath);
    const config = AgentDefinitionSchema.parse(rawConfig);

    const parent = config.inherits;

    let settings: Partial<AgentSetting> = {};
    let prompts: Partial<AgentPrompt> = {};

    if (parent) {
      // Load parent settings and prompts recursively using the registry
      const parentResolution = resolveAgent(`${entry.source}:${parent}`);
      if (!parentResolution) {
        throw new Error(
          `Unable to locate parent agent "${parent}" in source "${entry.source}".`,
        );
      }
      const [parentSettings, parentPrompts] =
        await loadAgentSettingAndPrompts(parentResolution);

      // Merge with parent settings and prompts
      settings = deepmerge(parentSettings, config.settings, {
        arrayMerge: (_d, s) => s,
      });
      prompts = deepmerge(parentPrompts, config.prompts, {
        arrayMerge: (_d, s) => s,
      });
    } else {
      // No inheritance, just take own settings and prompts
      settings = deepmerge({}, config.settings, {
        arrayMerge: (_d, s) => s,
      });
      prompts = deepmerge({}, config.prompts, {
        arrayMerge: (_d, s) => s,
      });
    }

    ensureAgentTypeForSource(settings, entry.source);

    // Resolve tool names to definitions using shared utility
    if (Array.isArray(settings.tools)) {
      const { resolveToolDefinitions } = await import('@tools/registry');
      settings.tools = resolveToolDefinitions(
        settings.tools as (string | { name: string })[],
        (name) => logger.warn(CHANNEL, `Tool "${name}" not found in registry`),
      );
    }

    // Apply defaults and validate the final settings and prompts
    const validatedSettings = parseAgentSetting(settings);
    const validatedPrompts = AgentPromptSchema.parse(prompts);
    settings = validatedSettings;
    prompts = validatedPrompts;

    // The function returns the validated settings block and prompts.
    // The agent's name (declaredAgentName) is known in this scope but not part of AgentSetting.
    return [settings as AgentSetting, prompts as AgentPrompt];
  } catch (err) {
    // Log error context, then rethrow original to preserve error type (e.g., ZodError)
    // for proper handling by callers like executeCommand.ts
    logger.error(
      CHANNEL,
      `Error loading agent settings and prompts: ${toErrorMessage(err)}`,
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
    const { name, settings } = validateAgentYamlContent(rawData);

    return {
      name,
      settings,
    } satisfies ValidAgentDefinition;
  } catch (err) {
    logger.debug(
      CHANNEL,
      `isValidAgentYaml check failed for ${filePath}: ${toErrorMessage(err)}`,
    );
  }
  return null;
}
